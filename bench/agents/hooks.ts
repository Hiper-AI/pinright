/* eslint-disable @typescript-eslint/no-explicit-any -- transcripts and hook logs are read untyped */
/**
 * Hook events of a sandboxed shell-arm run (run.ts --sandbox docker): every pre-install hook call
 * the wrapper logged to <run>/<arm>/<task>-r<rep>/hook-events.jsonl, joined with the transcript to
 * see what the agent did next. Prints Markdown: per arm, how many installs the agents ran, how often
 * the hook answered, what it denied or asked, and whether the agent recovered; then each block.
 *
 *   npx tsx bench/agents/hooks.ts <stamp> [<stamp> ...] [--out bench/RESULTS-shell.md]
 *
 * --out writes the tables between <!-- hooks:start --> and <!-- hooks:end --> in that file.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { label, modelName } from './metrics.js';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outArg = outIdx >= 0 ? argv[outIdx + 1] : undefined;
const stamps = argv.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
if (!stamps.length) throw new Error('usage: hooks.ts <stamp> [<stamp> ...] [--out file]');
const root = resolve(import.meta.dirname, '..', '..');

/** A command that installs packages (what the hook exists for). */
export const INSTALL = /\b(?:npm|pnpm|yarn)\s+(?:i|install|add|ci)\b|\bpip3?\s+install\b|\bpython3?\s+-m\s+pip\s+install\b|\buv\s+(?:pip\s+install|add|sync)\b/;

interface HookEvent { at: string; tool?: string; target?: string; decision: string; context: boolean; reason?: string }
interface Step { tool: string; target: string; isError: boolean; result: string }
export interface RunHooks {
  model: string; arm: string; run: string;
  events: HookEvent[];
  steps: Step[];
  ok: boolean;
}

function readJsonl(p: string): any[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** The agent's built-in tool calls in order, with whether each one errored and the start of its result. */
function steps(lines: any[]): Step[] {
  const byId = new Map<string, Step>();
  const out: Step[] = [];
  for (const l of lines) {
    if (l.type === 'assistant') {
      for (const c of l.message?.content ?? []) {
        if (c.type !== 'tool_use' || String(c.name).startsWith('mcp__')) continue;
        const s: Step = { tool: c.name, target: String(c.input?.command ?? c.input?.file_path ?? ''), isError: false, result: '' };
        byId.set(c.id, s);
        out.push(s);
      }
    }
    if (l.type === 'user') {
      for (const c of l.message?.content ?? []) {
        const s = c.type === 'tool_result' ? byId.get(c.tool_use_id) : undefined;
        if (!s) continue;
        s.isError = Boolean(c.is_error);
        s.result = (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 400);
      }
    }
  }
  return out;
}

export function loadRun(stamp: string): RunHooks[] {
  const runDir = join(root, 'bench', 'agents', 'runs', stamp);
  const config = JSON.parse(readFileSync(join(runDir, 'config.json'), 'utf8'));
  const out: RunHooks[] = [];
  for (const arm of (config.arms ?? []) as string[]) {
    const armDir = join(runDir, arm);
    if (!existsSync(armDir)) continue;
    for (const run of readdirSync(armDir).sort()) {
      const dir = join(armDir, run);
      const lines = readJsonl(join(dir, 'transcript.jsonl'));
      const res = lines.find((l) => l.type === 'result');
      out.push({ model: config.model, arm, run, events: readJsonl(join(dir, 'hook-events.jsonl')), steps: steps(lines), ok: res?.subtype === 'success' });
    }
  }
  return out;
}

const blocked = (e: HookEvent) => e.decision === 'deny' || e.decision === 'ask';
const isManifest = (t: string) => /(?:^|\/)(?:package\.json|requirements[^/]*\.txt|pyproject\.toml)$/.test(t);

/**
 * Did the agent get past its last block? Recovered = after it, the hook allowed a write of the
 * manifest or an install command, and an install command afterwards ran without error.
 */
export function recovered(r: RunHooks): boolean | undefined {
  const last = r.events.map((e, i) => (blocked(e) ? i : -1)).filter((i) => i >= 0).pop();
  if (last === undefined) return undefined;
  const after = r.events.slice(last + 1);
  if (!after.some((e) => e.decision === 'allow' && ((e.tool === 'Bash' && INSTALL.test(e.target ?? '')) || isManifest(e.target ?? '')))) return false;
  // The step list follows the same order; the installs that ran after the block.
  const blockedTarget = r.events[last].target ?? '';
  const k = r.steps.map((s) => s.target).lastIndexOf(blockedTarget);
  return r.steps.slice(k + 1).some((s) => s.tool === 'Bash' && INSTALL.test(s.target) && !s.isError);
}

const firstProblem = (reason?: string) =>
  (reason ?? '').split('\n').map((l) => l.trim()).find((l) => l && !/^pinright:?$/i.test(l))?.replace(/\|/g, '/').slice(0, 180) ?? '';
const short = (s: string, n = 70) => {
  const one = s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
  return one.length > n ? `${one.slice(0, n - 3)}...` : one;
};

const L: string[] = [];
const all = stamps.flatMap(loadRun);
const models = [...new Set(all.map((r) => r.model))];
const arms = [...new Set(all.map((r) => r.arm))];

L.push('### Installs and hook answers per arm', '');
L.push('| Model | Arm | Runs | Runs with an install | Install commands | Hook calls (Bash / Write+Edit) | Deny | Ask | Allow with a note | Runs with a deny or ask | Recovered after the block |');
L.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const m of models) {
  for (const a of arms) {
    const rs = all.filter((r) => r.model === m && r.arm === a);
    if (!rs.length) continue;
    const ev = rs.flatMap((r) => r.events);
    const installs = rs.map((r) => r.steps.filter((s) => s.tool === 'Bash' && INSTALL.test(s.target)).length);
    const hooked = rs.some((r) => r.events.length) || a.includes('hook');
    const withBlock = rs.filter((r) => r.events.some(blocked));
    const rec = withBlock.filter((r) => recovered(r)).length;
    const n = (x: number) => (hooked ? String(x) : 'n/a');
    L.push(`| ${modelName(m)} | ${label(a)} | ${rs.length} | ${installs.filter((x) => x > 0).length} | ${installs.reduce((x, y) => x + y, 0)} | ${hooked ? `${ev.length} (${ev.filter((e) => e.tool === 'Bash').length} / ${ev.filter((e) => e.tool !== 'Bash').length})` : 'n/a'} | ${n(ev.filter((e) => e.decision === 'deny').length)} | ${n(ev.filter((e) => e.decision === 'ask').length)} | ${n(ev.filter((e) => e.decision === 'allow' && e.context).length)} | ${n(withBlock.length)} | ${hooked ? `${rec} / ${withBlock.length}` : 'n/a'} |`);
  }
}
L.push('');

L.push('### Every deny and ask', '');
L.push('What the hook stopped, the first line of its message to the agent, and what the agent did next (its next built-in tool call).', '');
L.push('| Model | Arm | Run | Tool | Command or file | Decision | Hook message (first line) | Next step | Recovered |');
L.push('|---|---|---|---|---|---|---|---|---|');
let blocks = 0;
for (const r of all) {
  r.events.forEach((e, i) => {
    if (!blocked(e)) return;
    blocks++;
    const k = r.steps.findIndex((s, j) => s.target === (e.target ?? '') && r.steps.slice(0, j).filter((x) => x.target === s.target).length === r.events.slice(0, i).filter((x) => x.target === e.target).length);
    const next = k >= 0 ? r.steps[k + 1] : undefined;
    const rec = recovered(r);
    L.push(`| ${modelName(r.model)} | ${label(r.arm)} | ${r.run} | ${e.tool ?? '?'} | \`${short(e.target ?? '', 60).replace(/`/g, "'")}\` | ${e.decision} | ${firstProblem(e.reason)} | ${next ? `${next.tool} \`${short(next.target, 50).replace(/`/g, "'")}\`` : 'none (run ended)'} | ${rec === undefined ? '' : rec ? 'yes' : 'no'} |`);
  });
}
if (!blocks) L.push('| (none) | | | | | | | | |');
L.push('');

const text = L.join('\n');
if (outArg) {
  const START = '<!-- hooks:start -->';
  const END = '<!-- hooks:end -->';
  const file = resolve(outArg);
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const i = prev.indexOf(START);
  const j = prev.indexOf(END);
  writeFileSync(file, i >= 0 && j > i ? `${prev.slice(0, i + START.length)}\n${text}\n${prev.slice(j)}` : `${prev}\n${START}\n${text}\n${END}\n`);
  console.log(`wrote ${file}`);
} else {
  console.log(text);
}
