/* eslint-disable @typescript-eslint/no-explicit-any -- transcripts are untyped JSON */
/**
 * Scores a docs-benchmark run. Per run:
 *   - version: the pinned major of the task's library;
 *   - API checks (checks.ts): current API present, removed/deprecated API absent;
 *   - install + build (bench/agents/buildcheck.ts) and the runtime smoke test (smoke.ts);
 *   - agent cost, turns, and every docs tool call with its arguments.
 * "works" = installs, builds and passes the smoke test; "current" = works, right
 * major, and every API check passes. Writes runs/<stamp>/scores.json.
 *
 *   npx tsx bench/docs/score.ts <stamp|path> [--concurrency 2] [--only t1,t2] [--arms a,b]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { type BuildScore, npmBuild, pypiBuild } from '../agents/buildcheck.js';
import { type CheckResult, loadProject, npmMajor, pypiMajor, runChecks } from './checks.js';
import { runSmoke, type SmokeResult } from './smoke.js';
import { canonicalArm, canonicalScores, canonicalTool } from '../legacy.js';
import { type DocsTask, TASKS } from './tasks.js';

/** Report order for the built-in arms; extra arms (--mcp-arm) follow in name order. */
export const ARMS = ['no-docs', 'pinright'];

export interface DocsCall { tool: string; input: any; resultChars: number; result?: string }
export interface DocsRunScore {
  arm: string; task: string; rep: number;
  ok: boolean; costUsd?: number; turns?: number; durationMs?: number; model?: string;
  calls: DocsCall[];
  pinned: Record<string, number | undefined>;
  versionOk: boolean;
  checks: CheckResult[];
  build?: BuildScore;
  smoke?: SmokeResult;
  works: boolean;
  current: boolean;
}

export function readTranscript(dir: string) {
  const p = join(dir, 'transcript.jsonl');
  const lines: any[] = existsSync(p)
    ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const calls: DocsCall[] = [];
  const byId = new Map<string, DocsCall>();
  for (const l of lines) {
    for (const c of l.message?.content ?? []) {
      if (l.type === 'assistant' && c.type === 'tool_use' && String(c.name).startsWith('mcp__')) {
        const call: DocsCall = { tool: canonicalTool(String(c.name).replace(/^mcp__/, '')), input: c.input, resultChars: 0 };
        calls.push(call);
        byId.set(c.id, call);
      }
      if (l.type === 'user' && c.type === 'tool_result' && byId.has(c.tool_use_id)) {
        const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join('\n') : String(c.content ?? '');
        const call = byId.get(c.tool_use_id)!;
        call.resultChars = text.length;
        call.result = text;
      }
    }
  }
  const init = lines.find((l) => l.type === 'system' && l.subtype === 'init');
  const res = lines.find((l) => l.type === 'result');
  return { ok: res?.subtype === 'success', costUsd: res?.total_cost_usd, turns: res?.num_turns, durationMs: res?.duration_ms, calls, model: init?.model };
}

export function verdict(task: DocsTask, s: Pick<DocsRunScore, 'build' | 'smoke' | 'checks' | 'versionOk'>): { works: boolean; current: boolean } {
  const works = Boolean(s.build?.installed && s.build.built === true && (!task.smoke || s.smoke?.pass));
  return { works, current: works && s.versionOk && s.checks.every((c) => c.pass) };
}

export async function scoreRun(task: DocsTask, work: string, doBuild = true): Promise<Omit<DocsRunScore, 'arm' | 'task' | 'rep' | 'ok' | 'calls'>> {
  const project = loadProject(work);
  const pinned = Object.fromEntries(task.majors.map((m) => [m.name, task.ecosystem === 'npm' ? npmMajor(project, m.name) : pypiMajor(project, m.name)]));
  const versionOk = task.majors.every((m) => pinned[m.name] === m.major);
  const checks = runChecks(project, task.checks);
  let smoke: SmokeResult | undefined;
  const after = task.smoke ? async (dir: string, b: BuildScore) => { smoke = await runSmoke(task.smoke!, dir, b); } : undefined;
  const hasManifest = existsSync(join(work, task.ecosystem === 'npm' ? 'package.json' : 'requirements.txt'));
  const build = !doBuild ? undefined : hasManifest
    ? await (task.ecosystem === 'npm' ? npmBuild(work, after) : pypiBuild(work, after)).catch((e: Error): BuildScore => ({ installed: false, step: 'harness', error: e.message }))
    : { installed: false, step: 'manifest', error: 'no manifest' };
  if (task.smoke && build && !smoke) smoke = { ran: false, pass: false, tests: [], error: 'not installed' };
  const v = verdict(task, { build, smoke, checks, versionOk });
  return { pinned, versionOk, checks, build, smoke, ...v };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  const args = process.argv.slice(2);
  const stamp = args[0];
  if (!stamp) throw new Error('usage: score.ts <stamp>');
  const opt = (n: string) => (args.includes(`--${n}`) ? (args[args.indexOf(`--${n}`) + 1] ?? '').split(',').filter(Boolean) : []);
  const concurrency = Number(opt('concurrency')[0] ?? 2) || 2;
  const onlyTasks = opt('only');
  const onlyArms = opt('arms');
  const root = resolve(import.meta.dirname, '..', '..');
  const runDir = isAbsolute(stamp) ? stamp : join(root, 'bench', 'docs', 'runs', stamp);

  const jobs: { arm: string; task: DocsTask; rep: number; dir: string }[] = [];
  const present = readdirSync(runDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const dirName of present) {
    const arm = canonicalArm(dirName);
    const armDir = join(runDir, dirName);
    if (onlyArms.length && !onlyArms.includes(arm)) continue;
    for (const name of readdirSync(armDir).sort()) {
      const m = name.match(/^(.*)-r(\d+)$/);
      const task = m && TASKS.find((t) => t.id === m[1]);
      if (!m || !task || (onlyTasks.length && !onlyTasks.includes(task.id))) continue;
      jobs.push({ arm, task, rep: Number(m[2]), dir: join(armDir, name) });
    }
  }

  const scores: DocsRunScore[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const i = next++;
      const { arm, task, rep, dir } = jobs[i];
      const t = readTranscript(dir);
      const s = await scoreRun(task, join(dir, 'work'));
      scores[i] = { arm, task: task.id, rep, ...t, ...s };
      const failed = s.checks.filter((c) => !c.pass).map((c) => `${c.kind[0]}:${c.id}`);
      const smokeTxt = s.smoke ? (s.smoke.pass ? 'ok' : `FAIL ${s.smoke.error ?? s.smoke.tests.filter((x) => !x.pass).map((x) => x.name).join(',')}`) : '-';
      const buildTxt = s.build?.built === false || !s.build?.installed ? `FAIL ${s.build?.step}: ${s.build?.error ?? ''}`.slice(0, 120) : 'ok';
      console.log(`${arm.padEnd(11)} ${task.id}-r${rep} v=${JSON.stringify(s.pinned)} build=${buildTxt} smoke=${smokeTxt} checks=${failed.join(' ') || 'all'} => works=${s.works} current=${s.current}`);
    }
  }));
  const file = join(runDir, 'scores.json');
  const partial = onlyTasks.length || onlyArms.length;
  const prev: DocsRunScore[] = partial && existsSync(file) ? canonicalScores(JSON.parse(readFileSync(file, 'utf8'))) : [];
  const key = (s: DocsRunScore) => `${s.arm}|${s.task}|${s.rep}`;
  const fresh = new Set(scores.filter(Boolean).map(key));
  writeFileSync(file, JSON.stringify([...prev.filter((s) => !fresh.has(key(s))), ...scores.filter(Boolean)], null, 2));
  console.log(`scored ${scores.length} runs -> ${file}`);
}
