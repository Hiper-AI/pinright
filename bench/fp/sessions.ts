/**
 * Replays the tool calls of local Claude Code sessions through the pre-install hook.
 *
 *   extract <projects-dir> <corpus-dir>
 *     Reads every transcript (*.jsonl, subagents included) under <projects-dir>, keeps the
 *     Bash, PowerShell, Write, Edit, MultiEdit and NotebookEdit tool calls (one per tool_use id,
 *     so a resumed session does not count twice) and dedupes identical calls (same tool, input
 *     and cwd). A write to a file the hook reads (manifest, lockfile, registry settings, workflow,
 *     notebook, the hook's own config) is materialized in <corpus-dir>/cases/<id>/ with the file
 *     as it was before the call: the state the same transcript left it in, else the file on disk
 *     with the edit undone, else the newest git version that differs from what was written; for a
 *     worktree that is gone, the same path in the main checkout (or its git history) that the
 *     edit applies to.
 *     Writes to other files cannot change the decision (they only get import notes), so they are
 *     counted and a sample is kept for latency. A cwd that no longer exists becomes an empty dir.
 *   replay <corpus-dir> [--jobs 6] [--sample 400] [--label run]
 *     Reads every case with the hook's reader in-process; every case with something to check,
 *     plus a random sample of the rest, goes through the real CLI (`node dist/cli.js hook claude`,
 *     the Claude Code PreToolUse payload). Writes <corpus-dir>/replay-<label>.json.
 *   show <corpus-dir> [--label run]
 *     The asked and blocked cases, with credentials redacted, for adjudication.
 *
 * The corpus holds raw commands and file contents from the sessions: keep it outside the
 * repository (or in the gitignored bench/fp/sessions-corpus/) and never commit it.
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { actionUsesFromToolInput, intentsFromToolInput } from '../../src/hook/run.js';
import { isGuardedFile } from '../../src/hook/intent.js';
import { isWorkflowFile } from '../../src/actions/workflow.js';
import { type DepIntent } from '../../src/hook/spec.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');
const TOOLS = new Set(['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const opt = (name: string, def: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);

/* eslint-disable @typescript-eslint/no-explicit-any -- transcript JSON */

interface Case {
  id: string;
  tool: string;
  kind: 'command' | 'write' | 'other-write';
  /** The tool input as replayed (file paths point into cases/<id> for writes). */
  input?: Record<string, any>;
  cwd: string;
  cwdMissing?: boolean;
  /** How the file before a write was found: transcript, disk, disk-undone, git, none (new file), unknown. */
  before?: string;
  /** Tool calls (unique tool_use ids) behind this case, and in how many transcripts. */
  calls: number;
  transcripts: number;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const normPath = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
const hookReads = (f: string) => isGuardedFile(f) || isWorkflowFile(f) || /\.ipynb$/i.test(f);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function readFile(p: string): string | undefined {
  try {
    return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

type Edit = { old_string?: string; new_string?: string; replace_all?: boolean };
const editsOf = (tool: string, input: Record<string, any>): Edit[] => (tool === 'MultiEdit' ? (Array.isArray(input.edits) ? input.edits : []) : [input]);

function apply(s: string, edits: Edit[]): string {
  for (const e of edits) {
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') continue;
    const next = e.new_string;
    s = e.replace_all ? s.split(e.old_string).join(next) : s.replace(e.old_string, () => next);
  }
  return s;
}

/** The file before the edits, from the file after them: each new_string back to its old_string, last edit first. */
function undo(s: string, edits: Edit[]): string | undefined {
  for (const e of [...edits].reverse()) {
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') continue;
    if (e.new_string && !s.includes(e.new_string)) return undefined;
    const old = e.old_string;
    s = e.replace_all || !e.new_string ? s.split(e.new_string).join(old) : s.replace(e.new_string, () => old);
  }
  return s;
}

/** The newest committed version of `file` that differs from `content`. */
function gitBefore(file: string, content: string): string | undefined {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) return undefined;
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const rel = path.relative(top, file).replace(/\\/g, '/');
    const commits = execFileSync('git', ['-C', top, 'log', '--format=%H', '-n', '30', '--', rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    for (const c of commits) {
      for (const ref of [c, `${c}^`]) {
        try {
          const v = execFileSync('git', ['-C', top, 'show', `${ref}:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
          if (v.replace(/\r\n/g, '\n') !== content.replace(/\r\n/g, '\n')) return v;
        } catch {
          // Not in that commit (added by it).
        }
      }
    }
  } catch {
    // Not a git checkout.
  }
  return undefined;
}

/** Committed versions of `file`, newest first (up to `n` commits that touched it). */
function gitVersions(file: string, n = 40): string[] {
  const out: string[] = [];
  try {
    let top = path.dirname(file);
    while (!fs.existsSync(top) && path.dirname(top) !== top) top = path.dirname(top);
    top = execFileSync('git', ['-C', top, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const rel = path.relative(top, file).replace(/\\/g, '/');
    const commits = execFileSync('git', ['-C', top, 'log', '--all', '--format=%H', '-n', String(n), '--', rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    for (const c of commits) {
      try {
        out.push(execFileSync('git', ['-C', top, 'show', `${c}:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }));
      } catch {
        // Deleted in that commit.
      }
    }
  } catch {
    // Not a git checkout.
  }
  return out;
}

/**
 * The same file in the main checkout, for a worktree that is gone: `<ws>/_worktrees/<name>/<rest>`
 * maps to `<ws>/<repo>/<rest>` for every repository next to `_worktrees`, and
 * `<repo>/.improve-worktrees/<name>/<rest>` or `<repo>/.claude/worktrees/<name>/<rest>` to `<repo>/<rest>`.
 */
function mainCheckout(file: string): string[] {
  const seg = path.resolve(file).split(/[\\/]/);
  const at = seg.findIndex((s, i) => s === '_worktrees' || s === '.improve-worktrees' || (s === 'worktrees' && seg[i - 1] === '.claude'));
  if (at < 0 || at + 2 >= seg.length) return [];
  const rest = seg.slice(at + 2);
  if (seg[at] !== '_worktrees') return [path.join(seg.slice(0, seg[at] === 'worktrees' ? at - 1 : at).join(path.sep), ...rest)];
  const ws = seg.slice(0, at).join(path.sep);
  let repos: string[] = [];
  try {
    repos = fs.readdirSync(ws).filter((d) => fs.existsSync(path.join(ws, d, '.git')));
  } catch {
    return [];
  }
  return repos.map((r) => path.join(ws, r, ...rest));
}

const norm = (s: string) => s.replace(/\r\n/g, '\n');

/** For a call whose worktree is gone: the version in the main checkout (or its history) the call applies to. */
function fromMainCheckout(tool: string, input: Record<string, any>, edits: Edit[], abs: string): { before?: string; how: string } | undefined {
  for (const cand of mainCheckout(abs)) {
    const versions = [readFile(cand), ...gitVersions(cand)].filter((v): v is string => v !== undefined).map(norm);
    if (!versions.length) continue;
    if (tool === 'Write') {
      const v = versions.find((x) => x !== norm(String(input.content ?? '')));
      return { before: v, how: v !== undefined ? 'main-checkout' : 'none' };
    }
    const v = versions.find((x) => edits.every((e) => typeof e.old_string === 'string' && x.includes(norm(e.old_string))));
    if (v !== undefined) return { before: v, how: 'main-checkout' };
  }
  return undefined;
}

/** Where a written file goes inside its case dir: its path below the session cwd, else its last three segments. */
function caseRel(file: string, cwd: string): string {
  const rel = path.relative(cwd, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return path.resolve(file).split(/[\\/]/).slice(-3).join(path.sep);
}

async function extract(projects: string, dir: string) {
  fs.rmSync(path.join(dir, 'cases'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'cases'), { recursive: true });
  const empty = path.join(dir, 'empty-cwd');
  fs.mkdirSync(empty, { recursive: true });
  const files = walk(projects);
  const seenIds = new Set<string>();
  const cases = new Map<string, Case & { inTranscripts: Set<number> }>();
  const stats = {
    transcripts: files.length,
    subagentTranscripts: files.filter((f) => /[\\/]subagents[\\/]/.test(f)).length,
    transcriptsWithCalls: 0,
    toolCalls: {} as Record<string, number>,
    duplicateToolUseIds: 0,
    otherWritesSampled: 0,
    firstTimestamp: '',
    lastTimestamp: '',
  };
  const otherSample: { key: string; tool: string; input: Record<string, any>; cwd: string }[] = [];
  let otherSeen = 0;
  const SAMPLE = 400;

  for (const [fi, file] of files.entries()) {
    if (fi % 500 === 0) console.error(`transcript ${fi}/${files.length}`);
    /** The content this transcript left each hook-read file in. */
    const state = new Map<string, string>();
    let had = false;
    const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"tool_use"')) continue;
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const blocks = j?.message?.content;
      if (j?.type !== 'assistant' || !Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (b?.type !== 'tool_use' || !TOOLS.has(b.name) || !b.input || typeof b.input !== 'object') continue;
        if (seenIds.has(b.id)) {
          stats.duplicateToolUseIds++;
          continue;
        }
        seenIds.add(b.id);
        had = true;
        stats.toolCalls[b.name] = (stats.toolCalls[b.name] ?? 0) + 1;
        const ts = String(j.timestamp ?? '');
        if (ts && (!stats.firstTimestamp || ts < stats.firstTimestamp)) stats.firstTimestamp = ts;
        if (ts > stats.lastTimestamp) stats.lastTimestamp = ts;
        const origCwd = typeof j.cwd === 'string' && j.cwd ? j.cwd : empty;
        const cwdMissing = !fs.existsSync(origCwd);
        const cwd = cwdMissing ? empty : origCwd;
        const input = b.input as Record<string, any>;
        const add = (key: string, make: () => Omit<Case, 'calls' | 'transcripts'>) => {
          let c = cases.get(key);
          if (!c) {
            c = { ...make(), calls: 0, transcripts: 0, inTranscripts: new Set() };
            cases.set(key, c);
          }
          c.calls++;
          c.inTranscripts.add(fi);
        };

        if (b.name === 'Bash' || b.name === 'PowerShell') {
          if (typeof input.command !== 'string') continue;
          const key = `${b.name}\0${cwd}\0${input.command}`;
          add(key, () => ({ id: sha(key), tool: b.name, kind: 'command', input: { command: input.command }, cwd, cwdMissing }));
          continue;
        }
        if (b.name === 'NotebookEdit') {
          const key = `${b.name}\0${cwd}\0${JSON.stringify(input)}`;
          add(key, () => ({ id: sha(key), tool: b.name, kind: 'command', input, cwd, cwdMissing }));
          continue;
        }
        const raw = input.file_path;
        if (typeof raw !== 'string') continue;
        const abs = path.resolve(origCwd === empty ? '/' : origCwd, raw);
        const np = normPath(abs);
        if (!hookReads(abs)) {
          const key = `${b.name}\0${np}\0${sha(JSON.stringify(input))}`;
          if (!cases.has(key)) {
            // Reservoir sample of the writes the hook does not read, for latency.
            otherSeen++;
            const k = otherSample.length < SAMPLE ? otherSample.length : Math.floor(Math.random() * otherSeen);
            if (k < SAMPLE) otherSample[k] = { key, tool: b.name, input, cwd };
          }
          add(key, () => ({ id: sha(key), tool: b.name, kind: 'other-write', cwd }));
          continue;
        }
        // A file the hook reads: find it as it was before this call.
        const edits = b.name === 'Write' ? [] : editsOf(b.name, input);
        let before: string | undefined;
        let how: string;
        if (state.has(np)) {
          before = state.get(np);
          how = 'transcript';
        } else {
          const disk = readFile(abs);
          if (b.name === 'Write') {
            if (disk !== undefined && disk.replace(/\r\n/g, '\n') !== String(input.content ?? '').replace(/\r\n/g, '\n')) {
              before = disk;
              how = 'disk';
            } else {
              before = gitBefore(abs, String(input.content ?? ''));
              how = before !== undefined ? 'git' : disk === undefined ? 'none' : 'unknown';
            }
          } else if (disk === undefined) {
            how = 'unknown';
          } else if (edits.every((e) => typeof e.old_string === 'string' && disk.includes(e.old_string))) {
            before = disk;
            how = 'disk';
          } else {
            before = undo(disk, edits);
            how = before !== undefined ? 'disk-undone' : 'unknown';
          }
          if ((how === 'unknown' || how === 'none') && !fs.existsSync(path.dirname(abs))) {
            const m = fromMainCheckout(b.name, input, edits, abs);
            if (m) ({ before, how } = m);
          }
        }
        const after = b.name === 'Write' ? String(input.content ?? '') : before !== undefined ? apply(before, edits) : undefined;
        if (after !== undefined) state.set(np, after);
        else state.delete(np);
        const key = `${b.name}\0${np}\0${sha(before ?? '\0none')}\0${sha(JSON.stringify(input))}`;
        if (cases.has(key)) {
          add(key, () => cases.get(key) as Case);
          continue;
        }
        const id = sha(key);
        const caseDir = path.join(dir, 'cases', id);
        const rel = caseRel(abs, origCwd);
        const target = path.join(caseDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (before !== undefined) fs.writeFileSync(target, before);
        add(key, () => ({ id, tool: b.name, kind: 'write', input: { ...input, file_path: target }, cwd: caseDir, before: how }));
      }
    }
    if (had) stats.transcriptsWithCalls++;
  }

  const lines: string[] = [];
  for (const c of cases.values()) {
    const { inTranscripts, ...rest } = c;
    lines.push(JSON.stringify({ ...rest, transcripts: inTranscripts.size }));
  }
  fs.writeFileSync(path.join(dir, 'corpus.jsonl'), `${lines.join('\n')}\n`);
  const sample = otherSample.filter(Boolean).map((s) => ({ id: sha(s.key), tool: s.tool, input: s.input, cwd: s.cwd }));
  stats.otherWritesSampled = sample.length;
  fs.writeFileSync(path.join(dir, 'other-writes-sample.jsonl'), `${sample.map((s) => JSON.stringify(s)).join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ ...stats, cases: cases.size }, null, 1));
  console.log(JSON.stringify({ ...stats, cases: cases.size }, null, 1));
}

type Action = 'allow' | 'ask' | 'deny';
interface Result {
  id: string;
  tool: string;
  kind: Case['kind'];
  calls: number;
  cls: 'none' | 'check';
  intents: string[];
  decision?: { action: Action; reason: string; ms: number };
}

const show = (i: DepIntent) =>
  i.unverifiable ? `${i.unverifiable.level ?? 'ask'}:${i.ecosystem}:${i.name}` : `${i.ecosystem}:${i.name}${i.spec ? `@${i.spec}` : ''}${i.executes ? ' (exec)' : ''}${i.contextOnly ? ' (ctx)' : ''}`;

function runCli(tool: string, input: Record<string, unknown>, cwd: string): Promise<{ action: Action; reason: string; ms: number }> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'hook', 'claude'], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      const ms = Math.round(performance.now() - t0);
      let action: Action = 'allow';
      let reason = '';
      try {
        const j = out ? JSON.parse(out) : {};
        action = j.hookSpecificOutput?.permissionDecision ?? 'allow';
        reason = j.hookSpecificOutput?.permissionDecisionReason ?? j.hookSpecificOutput?.additionalContext ?? '';
      } catch {
        reason = `unparsable output (${out.length} bytes)`;
      }
      resolve({ action, reason, ms });
    });
    p.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd, session_id: 'fp-sessions' }));
  });
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(2)}%` : '-');
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};

const readCorpus = (dir: string): Case[] => fs.readFileSync(path.join(dir, 'corpus.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function replay(dir: string) {
  const label = opt('--label', 'run');
  const jobs = Number(opt('--jobs', '6'));
  const sampleN = Number(opt('--sample', '400'));
  const cases = readCorpus(dir);
  const results: Result[] = [];
  for (const [k, c] of cases.entries()) {
    if (k % 5000 === 0) console.error(`read ${k}/${cases.length}`);
    if (c.kind === 'other-write' || !c.input) {
      results.push({ id: c.id, tool: c.tool, kind: c.kind, calls: c.calls, cls: 'none', intents: [] });
      continue;
    }
    const intents = intentsFromToolInput(c.tool, c.input, c.cwd);
    const uses = actionUsesFromToolInput(c.input, c.cwd);
    const shown = [...intents.map(show), ...uses.map((u) => `action:${u.owner}/${u.repo}@${u.ref}`)];
    results.push({ id: c.id, tool: c.tool, kind: c.kind, calls: c.calls, cls: shown.length ? 'check' : 'none', intents: shown });
  }
  const byId = new Map(cases.map((c) => [c.id, c]));
  const toCheck = results.filter((r) => r.cls === 'check');
  // Latency on the common case too: a random sample of commands and writes with nothing to check.
  const quiet = results.filter((r) => r.cls === 'none' && r.kind === 'command').sort(() => Math.random() - 0.5).slice(0, sampleN);
  const others: { id: string; tool: string; input: Record<string, any>; cwd: string }[] = fs
    .readFileSync(path.join(dir, 'other-writes-sample.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(0, sampleN);
  const otherMs: number[] = [];
  const otherActions: Record<string, number> = {};
  let done = 0;
  const total = toCheck.length + quiet.length + others.length;
  const tick = () => ++done % 100 === 0 && console.error(`cli ${done}/${total}`);
  await pool([...toCheck, ...quiet], jobs, async (r) => {
    const c = byId.get(r.id) as Case;
    r.decision = await runCli(c.tool, c.input as Record<string, unknown>, c.cwd);
    tick();
  });
  await pool(others, jobs, async (o) => {
    const d = await runCli(o.tool, o.input, fs.existsSync(o.cwd) ? o.cwd : path.join(dir, 'empty-cwd'));
    otherMs.push(d.ms);
    otherActions[d.action] = (otherActions[d.action] ?? 0) + 1;
    tick();
  });

  const count = (list: Result[], a: Action, w: (r: Result) => number) => list.filter((r) => (r.decision?.action ?? 'allow') === a).reduce((s, r) => s + w(r), 0);
  const one = () => 1;
  const calls = (r: Result) => r.calls;
  const summary = {
    cases: results.length,
    calls: results.reduce((s, r) => s + r.calls, 0),
    withSomethingToCheck: toCheck.length,
    cases_ask: count(results, 'ask', one),
    cases_deny: count(results, 'deny', one),
    calls_ask: count(results, 'ask', calls),
    calls_deny: count(results, 'deny', calls),
    quietSampleNotAllowed: quiet.filter((r) => r.decision?.action !== 'allow').length,
    otherWritesSample: otherActions,
    latency: {
      check: { n: toCheck.length, p50: quantile(toCheck.map((r) => r.decision?.ms ?? 0), 0.5), p95: quantile(toCheck.map((r) => r.decision?.ms ?? 0), 0.95) },
      quietCommands: { n: quiet.length, p50: quantile(quiet.map((r) => r.decision?.ms ?? 0), 0.5), p95: quantile(quiet.map((r) => r.decision?.ms ?? 0), 0.95) },
      otherWrites: { n: otherMs.length, p50: quantile(otherMs, 0.5), p95: quantile(otherMs, 0.95) },
    },
    byKind: Object.fromEntries((['command', 'write', 'other-write'] as const).map((k) => {
      const l = results.filter((r) => r.kind === k);
      return [k, { cases: l.length, calls: l.reduce((s, r) => s + r.calls, 0), ask: count(l, 'ask', one), deny: count(l, 'deny', one) }];
    })),
    cwdMissingCases: cases.filter((c) => c.cwdMissing).length,
    writesBefore: cases.filter((c) => c.kind === 'write').reduce((m, c) => ({ ...m, [c.before as string]: (m[c.before as string] ?? 0) + 1 }), {} as Record<string, number>),
  };
  console.log(JSON.stringify(summary, null, 1));
  console.log(`blocked or asked: ${pct(summary.cases_ask + summary.cases_deny, summary.cases)} of cases, ${pct(summary.calls_ask + summary.calls_deny, summary.calls)} of calls`);
  fs.writeFileSync(path.join(dir, `replay-${label}.json`), JSON.stringify({ summary, results: results.filter((r) => r.decision) }, null, 1));
}

/** Long tokens, key=value secrets and URL credentials, for anything printed. */
export function redact(s: string): string {
  return s
    .replace(/(gh[pousr]_|github_pat_|sk-|xox[abp]-|AKIA|AIza|glpat-|npm_)[A-Za-z0-9_-]{8,}/g, '$1<redacted>')
    .replace(/((?:token|secret|password|passwd|pwd|api[_-]?key|auth|bearer)[^\s=:]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1<redacted>')
    .replace(/(Bearer\s+)\S+/gi, '$1<redacted>')
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1<redacted>@')
    .replace(/\b[A-Za-z0-9+/_-]{40,}\b/g, '<long>');
}

function showFlagged(dir: string) {
  const label = opt('--label', 'run');
  const { results } = JSON.parse(fs.readFileSync(path.join(dir, `replay-${label}.json`), 'utf8')) as { results: Result[] };
  const byId = new Map(readCorpus(dir).map((c) => [c.id, c]));
  for (const r of results.filter((x) => x.decision && x.decision.action !== 'allow')) {
    const c = byId.get(r.id) as Case;
    const what = c.kind === 'command' ? String(c.input?.command ?? JSON.stringify(c.input)) : `${c.tool} ${path.relative(c.cwd, String(c.input?.file_path))} (before: ${c.before})`;
    console.log(`--- ${r.id} ${r.decision?.action} calls=${r.calls} cwdMissing=${Boolean(c.cwdMissing)}`);
    console.log(`  intents: ${redact(r.intents.join(' | ')).slice(0, 400)}`);
    console.log(`  what: ${redact(what).slice(0, 600)}`);
    console.log(`  reason: ${redact(r.decision?.reason ?? '').replace(/\s+/g, ' ').slice(0, 500)}`);
  }
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'extract' && a && b) await extract(path.resolve(a), path.resolve(b));
else if (cmd === 'replay' && a) await replay(path.resolve(a));
else if (cmd === 'show' && a) showFlagged(path.resolve(a));
else {
  console.error('usage: sessions.ts extract <projects-dir> <corpus-dir> | replay <corpus-dir> [--jobs N] [--sample N] [--label x] | show <corpus-dir> [--label x]');
  process.exit(2);
}
