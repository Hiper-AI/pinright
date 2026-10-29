/**
 * Runs each task with a real coding agent (Claude Code, headless) under three arms:
 *   no-docs   : no MCP server, no web; the agent pins versions from memory
 *   context7  : the official Context7 MCP server
 *   safectx   : this server (Context7 off)
 *   hook-only : no MCP server, only the safectx pre-install hook
 *   safectx+hook : both
 * Built-in tools are limited to Write and Read in every arm, so the only
 * difference is the MCP server. Transcripts land in bench/agents/runs/<stamp>/.
 *
 *   npx tsx bench/agents/run.ts [--model sonnet] [--reps 2] [--concurrency 4] [--only id1,id2] [--arms a,b]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { DOCS_HINT, TASKS } from './tasks.js';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const model = opt('model', 'sonnet');
const reps = Number(opt('reps', '2'));
const concurrency = Number(opt('concurrency', '4'));
const only = opt('only', '').split(',').filter(Boolean);
const armsOpt = opt('arms', 'no-docs,context7,safectx,hook-only,safectx+hook').split(',');
const stamp = opt('stamp', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));

const root = resolve(import.meta.dirname, '..', '..');
const runDir = join(root, 'bench', 'agents', 'runs', stamp);

const cli = join(root, 'dist', 'cli.js');
const safectxServer = { safectx: { command: 'node', args: [cli] } };
const MCP: Record<string, object> = {
  'no-docs': { mcpServers: {} },
  context7: { mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } } },
  safectx: { mcpServers: safectxServer },
  'hook-only': { mcpServers: {} },
  'safectx+hook': { mcpServers: safectxServer },
};
/** Arms that also get the pre-install hook, through a settings file passed with --settings. */
const HOOKED = new Set(['hook-only', 'safectx+hook']);
const hookSettings = {
  hooks: {
    PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `node "${cli.replace(/\\/g, '/')}" hook claude`, timeout: 60 }] }],
  },
};

interface Job { arm: string; taskId: string; rep: number; prompt: string }
const jobs: Job[] = [];
for (let rep = 1; rep <= reps; rep++) {
  for (const t of TASKS) {
    if (only.length && !only.includes(t.id)) continue;
    for (const arm of armsOpt) jobs.push({ arm, taskId: t.id, rep, prompt: `${t.prompt}\n\n${DOCS_HINT}` });
  }
}

function runOne(job: Job): Promise<number> {
  const dir = join(runDir, job.arm, `${job.taskId}-r${job.rep}`);
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  const mcpPath = join(dir, 'mcp.json');
  writeFileSync(mcpPath, JSON.stringify(MCP[job.arm], null, 2));
  const allowed = ['Write', 'Read', 'mcp__context7', 'mcp__safectx'];
  const cliArgs = [
    '-p', job.prompt,
    '--model', model,
    '--output-format', 'stream-json', '--verbose',
    '--tools', 'Write,Read',
    '--allowedTools', ...allowed,
    '--permission-mode', 'acceptEdits',
    '--strict-mcp-config', '--mcp-config', mcpPath,
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--max-turns', '40',
  ];
  if (HOOKED.has(job.arm)) {
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(hookSettings, null, 2));
    cliArgs.push('--settings', settingsPath);
  }
  const out = createWriteStream(join(dir, 'transcript.jsonl'));
  const err = createWriteStream(join(dir, 'stderr.log'));
  const started = Date.now();
  return new Promise((res) => {
    // safectx arms run with Context7 off: this run measures safectx's own docs.
    const env = { ...process.env, SAFECTX_NO_CACHE: '', SAFECTX_CONTEXT7: 'off' };
    const child = spawn('claude', cliArgs, { cwd: work, env, windowsHide: true });
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    const timer = setTimeout(() => child.kill(), 15 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...job, prompt: undefined, model, exitCode: code, wallMs: Date.now() - started }, null, 2));
      console.log(`${job.arm.padEnd(9)} ${job.taskId}-r${job.rep} exit=${code} ${Math.round((Date.now() - started) / 1000)}s`);
      res(code ?? -1);
    });
  });
}

mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, 'config.json'), JSON.stringify({ model, reps, arms: armsOpt, tasks: only.length ? only : TASKS.map((t) => t.id), startedAt: new Date().toISOString() }, null, 2));
console.log(`${jobs.length} runs -> ${runDir}`);
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < jobs.length) await runOne(jobs[next++]);
}));
console.log('done');
