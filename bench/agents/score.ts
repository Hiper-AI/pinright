/* eslint-disable @typescript-eslint/no-explicit-any -- npm audit / pip-audit JSON is untyped */
/**
 * Scores an agent-benchmark run: reads the manifest each agent wrote and measures
 *   - direct deps: does the pinned version exist, how many advisories it carries
 *     (deps.dev = GitHub Advisory DB + OSV, the data Dependabot alerts on), severity,
 *     deprecation, age;
 *   - the whole tree, the way Dependabot sees it: npm audit over a lockfile
 *     resolved without installing, pip-audit over `uv pip compile` output.
 *     These two tools share neither code nor data path with pinright; pinright's own
 *     check-manifest runs on the same files to measure agreement;
 *   - does it install and build (see buildcheck.ts);
 *   - agent cost: USD, turns, wall time, MCP calls, hook blocks.
 * Writes runs/<stamp>/scores.json.
 *
 *   npx tsx bench/agents/score.ts <stamp> [--concurrency 4] [--no-build]
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getAdvisory, getPackage, getVersion } from '../../src/advisories/depsdev.js';
import { auditTree } from '../../src/tree/audit.js';
import { parseFile } from '../../src/tree/lockfiles.js';
import { type BuildScore, npmBuild, pypiBuild, run } from './buildcheck.js';
import { armDir as findArmDir, canonicalScores, HOOK_BLOCKED } from '../legacy.js';
import { TASKS } from './tasks.js';

const args = process.argv.slice(2);
const stamp = args[0];
if (!stamp) throw new Error('usage: score.ts <stamp>');
const concurrency = Number(args[args.indexOf('--concurrency') + 1] || 4) || 4;
const doBuild = !args.includes('--no-build');
// --only task1,task2 --arms a,b: re-score just those runs and merge them into the existing scores.json.
const onlyTasks = (args[args.indexOf('--only') + 1] ?? '').split(',').filter((s) => args.includes('--only') && s);
const onlyArms = (args[args.indexOf('--arms') + 1] ?? '').split(',').filter((s) => args.includes('--arms') && s);
const root = resolve(import.meta.dirname, '..', '..');
const runDir = join(root, 'bench', 'agents', 'runs', stamp);
export const ARMS = ['no-docs', 'docs-only', 'pinright', 'hook-only', 'pinright+hook', 'latest'];
const DAY = 86_400_000;

interface Dep { name: string; spec: string; version: string; exact: boolean }
export interface DepScore extends Dep {
  exists: 'yes' | 'no-version' | 'no-package';
  advisories: string[];
  maxCvss?: number;
  deprecated: boolean;
  ageDays?: number;
  latest?: string;
  isLatest?: boolean;
}
export interface TreeScore {
  resolved: boolean;
  error?: string;
  packages?: number;
  alerts?: number;
  critical?: number;
  high?: number;
  vulnerablePackages?: number;
  /** pinright check-manifest on the same lockfile / resolved requirements. */
  pinright?: { alerts: number; vulnerablePackages: number; vulnerableNames: string[] };
  auditNames?: string[];
}
export interface RunScore {
  arm: string; task: string; rep: number; ecosystem: 'npm' | 'pypi';
  ok: boolean; costUsd?: number; turns?: number; durationMs?: number; mcpCalls: Record<string, number>;
  hookBlocks: number;
  model?: string; deps: DepScore[]; tree?: TreeScore; build?: BuildScore;
}

function readManifest(work: string, eco: 'npm' | 'pypi'): Dep[] | undefined {
  if (eco === 'npm') {
    const p = join(work, 'package.json');
    if (!existsSync(p)) return undefined;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const all = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) } as Record<string, string>;
    return Object.entries(all).map(([name, spec]) => {
      const version = String(spec).replace(/^[\^~=v]+/, '').trim();
      return { name, spec: String(spec), version, exact: /^\d/.test(String(spec)) };
    });
  }
  const p = join(work, 'requirements.txt');
  if (!existsSync(p)) return undefined;
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => l && !l.startsWith('-'))
    .map((l) => {
      const m = l.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(==|>=|~=|<=|>|<)?\s*([^;,\s]*)/);
      const name = (m?.[1] ?? l).toLowerCase().replace(/[_.]+/g, '-');
      return { name, spec: l, version: m?.[3] ?? '', exact: m?.[2] === '==' };
    });
}

async function scoreDep(eco: 'npm' | 'pypi', d: Dep): Promise<DepScore> {
  const pkg = await getPackage(eco, d.name).catch(() => undefined);
  if (!pkg) return { ...d, exists: 'no-package', advisories: [], deprecated: false };
  const def = pkg.versions.find((v) => v.isDefault);
  if (d.version === 'latest' || d.version === '') d = { ...d, version: def?.versionKey.version ?? '' };
  const v = d.version ? await getVersion(eco, d.name, d.version).catch(() => undefined) : undefined;
  if (!v) return { ...d, exists: 'no-version', advisories: [], deprecated: false, latest: def?.versionKey.version };
  const ids = (v.advisoryKeys ?? []).map((a) => a.id);
  let maxCvss: number | undefined;
  for (const id of ids) {
    const a = await getAdvisory(id).catch(() => undefined);
    if (a?.cvss3Score != null) maxCvss = Math.max(maxCvss ?? 0, a.cvss3Score);
  }
  return {
    ...d,
    exists: 'yes',
    advisories: ids,
    maxCvss,
    deprecated: Boolean(v.isDeprecated),
    ageDays: v.publishedAt ? Math.round((Date.now() - Date.parse(v.publishedAt)) / DAY) : undefined,
    latest: def?.versionKey.version,
    isLatest: def?.versionKey.version === d.version,
  };
}

function npmErrorCode(text: string): string | undefined {
  return text.match(/npm error code (\S+)/)?.[1];
}

async function ours(file: string): Promise<TreeScore['pinright']> {
  const a = await auditTree(parseFile(file, readFileSync(file, 'utf8')));
  return { alerts: a.alerts, vulnerablePackages: a.vulnerablePackages, vulnerableNames: [...new Set(a.findings.map((f) => f.name))] };
}

async function npmTree(work: string): Promise<TreeScore> {
  const tmp = mkdtempSync(join(tmpdir(), 'sctx-npm-'));
  try {
    cpSync(join(work, 'package.json'), join(tmp, 'package.json'));
    let r = await run('npm install --package-lock-only --ignore-scripts --no-audit --no-fund', tmp);
    let note: string | undefined;
    if (r.code !== 0) {
      const first = npmErrorCode(r.err) ?? 'install failed';
      // A peer-dependency conflict still leaves a tree we can audit; a missing version does not.
      r = await run('npm install --package-lock-only --ignore-scripts --no-audit --no-fund --legacy-peer-deps', tmp);
      if (r.code !== 0) return { resolved: false, error: npmErrorCode(r.err) ?? first };
      note = `${first} (resolved with --legacy-peer-deps)`;
    }
    const a = await run('npm audit --json', tmp);
    const j = JSON.parse(a.out || '{}');
    const pairs = new Set<string>();
    let critical = 0;
    let high = 0;
    for (const [name, v] of Object.entries<any>(j.vulnerabilities ?? {})) {
      for (const via of v.via ?? []) {
        if (typeof via !== 'object') continue;
        const key = `${name}:${via.source ?? via.url}`;
        if (pairs.has(key)) continue;
        pairs.add(key);
        if (via.severity === 'critical') critical++;
        if (via.severity === 'high') high++;
      }
    }
    // npm audit lists a package as vulnerable when only its dependency is; keep the ones with their own advisory.
    const own = Object.entries<any>(j.vulnerabilities ?? {}).filter(([, v]) => (v.via ?? []).some((x: unknown) => typeof x === 'object')).map(([n]) => n);
    return {
      resolved: true,
      error: note,
      packages: j.metadata?.dependencies?.total,
      alerts: pairs.size,
      critical,
      high,
      vulnerablePackages: own.length,
      auditNames: own,
      pinright: await ours(join(tmp, 'package-lock.json')).catch(() => undefined),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function pypiTree(work: string): Promise<TreeScore> {
  const tmp = mkdtempSync(join(tmpdir(), 'sctx-py-'));
  try {
    cpSync(join(work, 'requirements.txt'), join(tmp, 'requirements.in'));
    const c = await run('uv pip compile requirements.in -o requirements.txt --python-version 3.12 --quiet', tmp);
    if (c.code !== 0) {
      const line = c.err.split('\n').find((l) => /No solution|not found|Because|error/i.test(l)) ?? 'compile failed';
      return { resolved: false, error: line.trim().slice(0, 160) };
    }
    const a = await run('uvx pip-audit -r requirements.txt --no-deps --disable-pip --format json --progress-spinner off', tmp, 600_000);
    const j = JSON.parse(a.out || '{}');
    const deps: any[] = j.dependencies ?? [];
    let alerts = 0;
    const names: string[] = [];
    for (const d of deps) {
      const seen = new Set<string>();
      for (const v of d.vulns ?? []) {
        const ids: string[] = [v.id, ...(v.aliases ?? [])];
        if (ids.some((i) => seen.has(i))) continue;
        ids.forEach((i) => seen.add(i));
        alerts++;
      }
      if ((d.vulns ?? []).length) names.push(String(d.name).toLowerCase().replace(/[-_.]+/g, '-'));
    }
    return {
      resolved: true,
      packages: deps.length,
      alerts,
      vulnerablePackages: names.length,
      auditNames: names,
      pinright: await ours(join(tmp, 'requirements.txt')).catch(() => undefined),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

function readTranscript(dir: string) {
  const p = join(dir, 'transcript.jsonl');
  const lines: any[] = existsSync(p)
    ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const mcpCalls: Record<string, number> = {};
  let hookBlocks = 0;
  for (const l of lines) {
    if (l.type === 'assistant') {
      for (const c of l.message?.content ?? []) {
        if (c.type === 'tool_use' && String(c.name).startsWith('mcp__')) {
          const n = String(c.name).split('__').pop() as string;
          mcpCalls[n] = (mcpCalls[n] ?? 0) + 1;
        }
      }
    }
    if (l.type === 'user') {
      for (const c of l.message?.content ?? []) if (c.type === 'tool_result' && HOOK_BLOCKED.test(JSON.stringify(c.content))) hookBlocks++;
    }
  }
  const init = lines.find((l) => l.type === 'system' && l.subtype === 'init');
  const res = lines.find((l) => l.type === 'result');
  return { ok: res?.subtype === 'success', costUsd: res?.total_cost_usd, turns: res?.num_turns, durationMs: res?.duration_ms, mcpCalls, hookBlocks, model: init?.model };
}

interface Job { arm: string; name: string; task: (typeof TASKS)[number]; rep: number; dir: string }
const jobs: Job[] = [];
for (const arm of ARMS) {
  const armDir = findArmDir(runDir, arm);
  if (!existsSync(armDir)) continue;
  for (const name of readdirSync(armDir).sort()) {
    const m = name.match(/^(.*)-r(\d+)$/);
    const task = m && TASKS.find((t) => t.id === m[1]);
    if (!m || !task) continue;
    if (onlyTasks.length && !onlyTasks.includes(task.id)) continue;
    if (onlyArms.length && !onlyArms.includes(arm)) continue;
    jobs.push({ arm, name, task, rep: Number(m[2]), dir: join(armDir, name) });
  }
}

const scores: RunScore[] = new Array(jobs.length);
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const i = next++;
      const { arm, name, task, rep, dir } = jobs[i];
      const work = join(dir, 'work');
      const t = readTranscript(dir);
      const manifest = readManifest(work, task.ecosystem);
      const deps: DepScore[] = [];
      for (const d of manifest ?? []) deps.push(await scoreDep(task.ecosystem, d));
      const tree = manifest ? await (task.ecosystem === 'npm' ? npmTree(work) : pypiTree(work)) : undefined;
      const build = manifest && doBuild && arm !== 'latest' ? await (task.ecosystem === 'npm' ? npmBuild(work) : pypiBuild(work)).catch((e: Error): BuildScore => ({ installed: false, step: 'harness', error: e.message })) : undefined;
      scores[i] = { arm, task: task.id, rep, ecosystem: task.ecosystem, ...t, deps, tree, build };
      const treeTxt = tree?.resolved ? `${tree.alerts} (pinright ${tree.pinright?.alerts ?? '?'})` : `X ${tree?.error ?? 'no manifest'}`;
      const buildTxt = build ? (build.built ? 'ok' : build.installed ? `FAIL ${build.step}${build.inconclusive ? ' (native)' : ''}: ${build.error ?? ''}` : `NOINSTALL ${build.error ?? ''}`) : '-';
      console.log(`${arm.padEnd(13)} ${name.padEnd(26)} deps=${deps.length} vulnDirect=${deps.filter((d) => d.advisories.length).length} tree=${treeTxt} build=${buildTxt.slice(0, 160)}`);
    }
  }),
);
const partial = onlyTasks.length || onlyArms.length;
const prev: RunScore[] = partial && existsSync(join(runDir, 'scores.json')) ? canonicalScores(JSON.parse(readFileSync(join(runDir, 'scores.json'), 'utf8'))) : [];
const key = (s: RunScore) => `${s.arm}|${s.task}|${s.rep}`;
const fresh = new Set(scores.filter(Boolean).map(key));
writeFileSync(join(runDir, 'scores.json'), JSON.stringify([...prev.filter((s) => !fresh.has(key(s))), ...scores.filter(Boolean)], null, 2));
console.log(`scored ${scores.length} runs -> ${join(runDir, 'scores.json')}`);
