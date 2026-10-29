/**
 * Scores an agent-benchmark run: reads the manifest each agent wrote and measures
 *   - direct deps: does the pinned version exist, how many advisories it carries
 *     (deps.dev = GitHub Advisory DB + OSV, the data Dependabot alerts on), severity,
 *     deprecation, age;
 *   - the whole tree, the way Dependabot sees it: npm audit over a lockfile
 *     resolved without installing, pip-audit over `uv pip compile` output.
 *     These two tools share neither code nor data path with safectx.
 *   - agent cost: USD, turns, wall time, MCP calls.
 * Writes runs/<stamp>/scores.json.
 *
 *   npx tsx bench/agents/score.ts <stamp>
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getAdvisory, getPackage, getVersion } from '../../src/advisories/depsdev.js';
import { TASKS } from './tasks.js';

const stamp = process.argv[2];
if (!stamp) throw new Error('usage: score.ts <stamp>');
const root = resolve(import.meta.dirname, '..', '..');
const runDir = join(root, 'bench', 'agents', 'runs', stamp);
const ARMS = ['no-docs', 'context7', 'safectx', 'latest'];
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
export interface TreeScore { resolved: boolean; error?: string; packages?: number; alerts?: number; critical?: number; high?: number; vulnerablePackages?: number }
export interface RunScore {
  arm: string; task: string; rep: number; ecosystem: 'npm' | 'pypi';
  ok: boolean; costUsd?: number; turns?: number; durationMs?: number; mcpCalls: Record<string, number>;
  model?: string; deps: DepScore[]; tree?: TreeScore;
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

function sh(cmd: string, cwd: string, timeoutMs = 300_000) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function npmErrorCode(text: string): string | undefined {
  return text.match(/npm error code (\S+)/)?.[1];
}

function npmTree(work: string): TreeScore {
  const tmp = mkdtempSync(join(tmpdir(), 'sctx-npm-'));
  try {
    cpSync(join(work, 'package.json'), join(tmp, 'package.json'));
    let r = sh('npm install --package-lock-only --ignore-scripts --no-audit --no-fund', tmp);
    let note: string | undefined;
    if (r.code !== 0) {
      const first = npmErrorCode(r.err) ?? 'install failed';
      // A peer-dependency conflict still leaves a tree we can audit; a missing version does not.
      r = sh('npm install --package-lock-only --ignore-scripts --no-audit --no-fund --legacy-peer-deps', tmp);
      if (r.code !== 0) return { resolved: false, error: npmErrorCode(r.err) ?? first };
      note = `${first} (resolved with --legacy-peer-deps)`;
    }
    const a = sh('npm audit --json', tmp);
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
    return {
      resolved: true,
      error: note,
      packages: j.metadata?.dependencies?.total,
      alerts: pairs.size,
      critical,
      high,
      vulnerablePackages: Object.keys(j.vulnerabilities ?? {}).length,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function pypiTree(work: string): TreeScore {
  const tmp = mkdtempSync(join(tmpdir(), 'sctx-py-'));
  try {
    cpSync(join(work, 'requirements.txt'), join(tmp, 'requirements.in'));
    const c = sh('uv pip compile requirements.in -o resolved.txt --python-version 3.12 --no-header --quiet', tmp);
    if (c.code !== 0) {
      const line = c.err.split('\n').find((l) => /No solution|not found|Because|error/i.test(l)) ?? 'compile failed';
      return { resolved: false, error: line.trim().slice(0, 160) };
    }
    const a = sh('uvx pip-audit -r resolved.txt --no-deps --disable-pip --format json --progress-spinner off', tmp, 600_000);
    const j = JSON.parse(a.out || '{}');
    const deps: any[] = j.dependencies ?? [];
    let alerts = 0;
    let vulnerable = 0;
    for (const d of deps) {
      const seen = new Set<string>();
      for (const v of d.vulns ?? []) {
        const ids: string[] = [v.id, ...(v.aliases ?? [])];
        if (ids.some((i) => seen.has(i))) continue;
        ids.forEach((i) => seen.add(i));
        alerts++;
      }
      if ((d.vulns ?? []).length) vulnerable++;
    }
    return { resolved: true, packages: deps.length, alerts, vulnerablePackages: vulnerable };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function readTranscript(dir: string) {
  const p = join(dir, 'transcript.jsonl');
  const lines: any[] = existsSync(p)
    ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const mcpCalls: Record<string, number> = {};
  for (const l of lines) {
    if (l.type !== 'assistant') continue;
    for (const c of l.message?.content ?? []) {
      if (c.type === 'tool_use' && String(c.name).startsWith('mcp__')) {
        const n = String(c.name).split('__').pop() as string;
        mcpCalls[n] = (mcpCalls[n] ?? 0) + 1;
      }
    }
  }
  const init = lines.find((l) => l.type === 'system' && l.subtype === 'init');
  const res = lines.find((l) => l.type === 'result');
  return { ok: res?.subtype === 'success', costUsd: res?.total_cost_usd, turns: res?.num_turns, durationMs: res?.duration_ms, mcpCalls, model: init?.model };
}

const scores: RunScore[] = [];
for (const arm of ARMS) {
  const armDir = join(runDir, arm);
  if (!existsSync(armDir)) continue;
  for (const name of readdirSync(armDir).sort()) {
    const m = name.match(/^(.*)-r(\d+)$/);
    if (!m) continue;
    const task = TASKS.find((t) => t.id === m[1]);
    if (!task) continue;
    const dir = join(armDir, name);
    const work = join(dir, 'work');
    const t = readTranscript(dir);
    const manifest = readManifest(work, task.ecosystem);
    const deps: DepScore[] = [];
    for (const d of manifest ?? []) deps.push(await scoreDep(task.ecosystem, d));
    const tree = manifest ? (task.ecosystem === 'npm' ? npmTree(work) : pypiTree(work)) : undefined;
    scores.push({ arm, task: task.id, rep: Number(m[2]), ecosystem: task.ecosystem, ...t, deps, tree });
    const vulnDirect = deps.filter((d) => d.advisories.length).length;
    const treeTxt = tree?.resolved ? String(tree.alerts) : `X ${tree?.error ?? 'no manifest'}`;
    console.log(`${arm.padEnd(9)} ${name.padEnd(26)} deps=${deps.length} vulnDirect=${vulnDirect} tree=${treeTxt}`);
  }
}
writeFileSync(join(runDir, 'scores.json'), JSON.stringify(scores, null, 2));
console.log(`scored ${scores.length} runs -> ${join(runDir, 'scores.json')}`);
