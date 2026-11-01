/**
 * Replays a corpus built by collect.ts through the pre-install hook.
 *
 *   1. Parser level (offline): every command and manifest write goes through the hook's
 *      reader (intentsFromToolInput), in its repository checkout as cwd. Each entry is
 *      classified: nothing to check, lookups only, unverifiable (asks under the default
 *      policy), notes only, or a change to the hook's own configuration.
 *   2. Decision level (--decide N, network): entries are grouped by what the reader
 *      extracted, the N most frequent groups go through the real CLI
 *      (`node dist/cli.js hook claude`, with the Claude Code PreToolUse payload) and
 *      every entry of a group gets that group's decision.
 *
 * Run: npm run build && npx tsx bench/fp/replay.ts <corpus-dir> [--label before] [--decide 300] [--jobs 4]
 * Output: <corpus-dir>/replay-<label>.json, and a summary on stdout.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { intentsFromToolInput } from '../../src/hook/run.js';
import { type DepIntent } from '../../src/hook/spec.js';

const dir = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('usage: replay.ts <corpus-dir> [--label name] [--decide N] [--jobs N]');
  process.exit(2);
}
const opt = (name: string, def: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const label = opt('--label', 'run');
const decideN = Number(opt('--decide', '0'));
const jobs = Number(opt('--jobs', '4'));
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');

interface Entry {
  id: string;
  kind: 'command' | 'write';
  repo: string;
  source: string;
  path: string;
  cwd: string;
  command?: string;
  file?: string;
  caseDir?: string;
  templated?: boolean;
}

type Class = 'none' | 'lookup' | 'unverifiable' | 'note' | 'guard';

interface Parsed {
  id: string;
  cls: Class;
  intents: string[];
  reasons: string[];
  /** The simple command (or file) behind each unverifiable intent. */
  sources: string[];
  key: string;
  decision?: { action: 'allow' | 'ask' | 'deny'; reason: string; ms: number };
}

const show = (i: DepIntent) =>
  i.unverifiable ? `${i.unverifiable.level ?? 'ask'}:${i.ecosystem}:${i.name}` : `${i.ecosystem}:${i.name}${i.spec ? `@${i.spec}` : ''}${i.executes ? ' (exec)' : ''}${i.contextOnly ? ' (ctx)' : ''}`;

function classify(intents: DepIntent[]): Class {
  if (!intents.length) return 'none';
  if (intents.some((i) => i.unverifiable?.level === 'guard')) return 'guard';
  if (intents.some((i) => i.unverifiable && !i.unverifiable.level)) return 'unverifiable';
  if (intents.some((i) => !i.unverifiable && !i.contextOnly)) return 'lookup';
  return 'note';
}

function toolInput(e: Entry): { tool: string; input: Record<string, unknown>; cwd: string } {
  if (e.kind === 'write') {
    const caseDir = path.join(dir, e.caseDir as string);
    const file = path.join(caseDir, ...(e.file as string).split('/'));
    return { tool: 'Write', input: { file_path: file, content: fs.readFileSync(path.join(caseDir, '.fp-new'), 'utf8') }, cwd: caseDir };
  }
  const root = path.join(dir, 'repos', e.repo.replace('/', '__'));
  const cwd = path.resolve(root, e.cwd);
  return { tool: e.command && /^\s*(\$\w+\s*=|Get-|Set-|Write-Host|New-Item|Invoke-)/m.test(e.command) ? 'PowerShell' : 'Bash', input: { command: e.command }, cwd: fs.existsSync(cwd) ? cwd : root };
}

function runCli(tool: string, input: Record<string, unknown>, cwd: string): Promise<Parsed['decision']> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'hook', 'claude'], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      let action: 'allow' | 'ask' | 'deny' = 'allow';
      let reason = '';
      try {
        const j = out ? JSON.parse(out) : {};
        action = j.hookSpecificOutput?.permissionDecision ?? 'allow';
        reason = j.hookSpecificOutput?.permissionDecisionReason ?? j.hookSpecificOutput?.additionalContext ?? '';
      } catch {
        reason = `unparsable output: ${out.slice(0, 200)}`;
      }
      resolve({ action, reason, ms: Date.now() - t0 });
    });
    p.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd, session_id: 'fp-bench' }));
  });
}

async function pool<T>(items: T[], n: number, fn: (t: T, k: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const k = next++;
      await fn(items[k], k);
    }
  }));
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(2)}%` : '-');

async function main() {
  const entries: Entry[] = fs.readFileSync(path.join(dir, 'corpus.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const parsed: Parsed[] = entries.map((e) => {
    const { tool, input, cwd } = toolInput(e);
    const intents = intentsFromToolInput(tool, input, cwd);
    const reasons = [...new Set(intents.filter((i) => i.unverifiable).map((i) => i.unverifiable?.reason as string))];
    const sources = [...new Set(intents.filter((i) => i.unverifiable).map((i) => `${i.unverifiable?.level ?? 'ask'}: ${i.source}`))];
    const shown = intents.map(show);
    return { id: e.id, cls: classify(intents), intents: shown, reasons, sources, key: [...new Set(shown.filter((s) => !s.includes(' (ctx)')))].sort().join(' | ') };
  });
  const byId = new Map(entries.map((e) => [e.id, e]));

  // Summary per source, and over distinct commands.
  const sources = [...new Set(entries.map((e) => e.source))];
  const line = (name: string, list: Parsed[]) => {
    const n = list.length;
    const c = (k: Class) => list.filter((p) => p.cls === k).length;
    return `| ${name} | ${n} | ${pct(c('none'), n)} | ${pct(c('lookup'), n)} | ${pct(c('unverifiable'), n)} | ${pct(c('note'), n)} | ${pct(c('guard'), n)} |`;
  };
  const rows = ['| Source | Entries | No intents | Lookups | Unverifiable (ask) | Notes only | Guard |', '|---|---|---|---|---|---|---|'];
  for (const s of sources) rows.push(line(s, parsed.filter((p) => byId.get(p.id)?.source === s)));
  rows.push(line('all', parsed));
  rows.push(line('all, without ${{ }} templating', parsed.filter((p) => !byId.get(p.id)?.templated)));
  const seenCmd = new Set<string>();
  const distinct = parsed.filter((p) => {
    const e = byId.get(p.id) as Entry;
    const k = e.kind === 'write' ? e.id : (e.command as string);
    if (seenCmd.has(k)) return false;
    seenCmd.add(k);
    return true;
  });
  rows.push(line('distinct commands + writes', distinct));
  console.log(rows.join('\n'));

  if (decideN > 0) {
    // One decision per distinct intent set, most frequent first.
    const groups = new Map<string, Parsed[]>();
    for (const p of parsed) if (p.cls !== 'none') groups.set(p.key, [...(groups.get(p.key) ?? []), p]);
    const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, decideN);
    let done = 0;
    await pool(order, jobs, async ([, members]) => {
      const e = byId.get(members[0].id) as Entry;
      const { tool, input, cwd } = toolInput(e);
      const d = await runCli(tool, input, cwd);
      for (const m of members) m.decision = d;
      if (++done % 25 === 0) console.error(`decided ${done}/${order.length}`);
    });
    const decided = parsed.filter((p) => p.decision);
    const count = (a: string) => decided.filter((p) => p.decision?.action === a).length;
    console.log(`\nDecisions: ${order.length} groups covering ${decided.length} of ${parsed.filter((p) => p.cls !== 'none').length} entries with intents.`);
    console.log(`allow ${count('allow')}, ask ${count('ask')}, deny ${count('deny')}; over all ${parsed.length} entries: blocked or asked ${pct(count('ask') + count('deny'), parsed.length)}`);
  }

  const outFile = path.join(dir, `replay-${label}.json`);
  fs.writeFileSync(outFile, JSON.stringify(parsed.map((p) => ({ ...p, ...byId.get(p.id) })), null, 1));
  console.error(`wrote ${outFile}`);
}

void main();
