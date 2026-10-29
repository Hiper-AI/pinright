/**
 * Docs benchmark: the same coding agent writes code for libraries whose API
 * changed in their current major, with one docs source attached per arm:
 *   no-docs    : nothing; the agent writes from memory
 *   context7   : the official Context7 MCP server
 *   safectx    : this server with Context7 turned off (its own docs only)
 *   safectx+c7 : this server in its default mode (Context7 as a fallback when local docs are thin)
 * Uses the worktree's dist/cli.js: build first, and do not rebuild while runs are in flight.
 *
 *   npx tsx bench/docs/run.ts [--model sonnet] [--reps 2] [--concurrency 2] [--only id1,id2] [--arms a,b] [--stamp s] [--resume]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { planJobs, runJobs } from '../agents/harness.js';
import { DOCS_HINT, TASKS } from './tasks.js';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const model = opt('model', 'sonnet');
const reps = Number(opt('reps', '2'));
const concurrency = Number(opt('concurrency', '2'));
const only = opt('only', '').split(',').filter(Boolean);
const arms = opt('arms', 'no-docs,context7,safectx,safectx+c7').split(',');
const stamp = opt('stamp', `docs-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
const resume = args.includes('--resume');

const root = resolve(import.meta.dirname, '..', '..');
const runDir = join(root, 'bench', 'docs', 'runs', stamp);
const safectx = { safectx: { command: 'node', args: [join(root, 'dist', 'cli.js')] } };
const MCP: Record<string, object> = {
  'no-docs': { mcpServers: {} },
  context7: { mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } } },
  safectx: { mcpServers: safectx },
  'safectx+c7': { mcpServers: safectx },
};

const tasks = TASKS.filter((t) => !only.length || only.includes(t.id));
const jobs = planJobs(tasks, arms, reps, { runDir, resume, suffix: DOCS_HINT });
mkdirSync(runDir, { recursive: true });
if (!resume) writeFileSync(join(runDir, 'config.json'), JSON.stringify({ model, reps, arms, tasks: tasks.map((t) => t.id), startedAt: new Date().toISOString() }, null, 2));
await runJobs(jobs, {
  runDir,
  model,
  concurrency,
  mcp: MCP,
  env: (arm) => ({ SAFECTX_CONTEXT7: arm === 'safectx+c7' ? 'fallback' : 'off' }),
});
