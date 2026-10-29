/**
 * Runs each task with a real coding agent (Claude Code, headless) under these arms:
 *   no-docs   : no MCP server, no web; the agent pins versions from memory
 *   safectx   : this server
 *   hook-only : no MCP server, only the safectx pre-install hook
 *   safectx+hook : both
 * Built-in tools are limited to Write and Read in every arm, so the only
 * difference is the MCP server. Any other MCP server can be added as an arm with
 * --mcp-arm name=mcp.json (a Claude Code MCP config). Transcripts land in bench/agents/runs/<stamp>/.
 *
 *   npx tsx bench/agents/run.ts [--model sonnet] [--reps 2] [--concurrency 4] [--only id1,id2] [--arms a,b]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extraArms, planJobs, runJobs } from './harness.js';
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
const armsOpt = opt('arms', 'no-docs,safectx,hook-only,safectx+hook').split(',');
const stamp = opt('stamp', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
const resume = args.includes('--resume');

const root = resolve(import.meta.dirname, '..', '..');
const runDir = join(root, 'bench', 'agents', 'runs', stamp);

const cli = join(root, 'dist', 'cli.js');
const safectxServer = { safectx: { command: 'node', args: [cli] } };
const MCP: Record<string, object> = {
  'no-docs': { mcpServers: {} },
  safectx: { mcpServers: safectxServer },
  'hook-only': { mcpServers: {} },
  'safectx+hook': { mcpServers: safectxServer },
  ...extraArms(args),
};
/** Arms that also get the pre-install hook, through a settings file passed with --settings. */
const HOOKED = new Set(['hook-only', 'safectx+hook']);
const hookSettings = {
  hooks: {
    PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `node "${cli.replace(/\\/g, '/')}" hook claude`, timeout: 60 }] }],
  },
};

const tasks = TASKS.filter((t) => !only.length || only.includes(t.id));
const jobs = planJobs(tasks, armsOpt, reps, { runDir, resume, suffix: DOCS_HINT });

mkdirSync(runDir, { recursive: true });
if (!resume) writeFileSync(join(runDir, 'config.json'), JSON.stringify({ model, reps, arms: armsOpt, tasks: only.length ? only : TASKS.map((t) => t.id), startedAt: new Date().toISOString() }, null, 2));
await runJobs(jobs, {
  runDir,
  model,
  concurrency,
  mcp: MCP,
  // safectx arms run with Context7 off: this run measures safectx's own docs.
  env: () => ({ SAFECTX_CONTEXT7: 'off' }),
  settings: (arm) => (HOOKED.has(arm) ? hookSettings : undefined),
});
