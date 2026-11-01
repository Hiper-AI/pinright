/**
 * Docs benchmark: the same coding agent writes code for libraries whose API
 * changed in their current major, with one docs source attached per arm:
 *   no-docs : nothing; the agent writes from memory
 *   pinright : this server
 * Any other MCP docs server can be added as an arm with --mcp-arm name=mcp.json
 * (a Claude Code MCP config); none is shipped here.
 * Uses the worktree's dist/cli.js: build first, and do not rebuild while runs are in flight.
 *
 *   npx tsx bench/docs/run.ts [--model sonnet] [--reps 2] [--concurrency 2] [--only id1,id2]
 *     [--arms a,b] [--mcp-arm name=mcp.json] [--stamp s] [--resume]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extraArms, planJobs, runJobs } from '../agents/harness.js';
import { DOCS_HINT, TASKS } from './tasks.js';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const root = resolve(import.meta.dirname, '..', '..');
const MCP: Record<string, object> = {
  'no-docs': { mcpServers: {} },
  pinright: { mcpServers: { pinright: { command: 'node', args: [join(root, 'dist', 'cli.js')] } } },
  // Ablation, only with --arms docs-only: the same server with its security layer off (PINRIGHT_ABLATION=docs-only, see src/mcp.ts).
  'docs-only': { mcpServers: { pinright: { command: 'node', args: [join(root, 'dist', 'cli.js')], env: { PINRIGHT_ABLATION: 'docs-only' } } } },
  ...extraArms(args),
};

const model = opt('model', 'sonnet');
const reps = Number(opt('reps', '2'));
const concurrency = Number(opt('concurrency', '2'));
const only = opt('only', '').split(',').filter(Boolean);
const arms = opt('arms', Object.keys(MCP).filter((a) => a !== 'docs-only').join(',')).split(',');
for (const a of arms) if (!MCP[a]) throw new Error(`unknown arm ${a}; pass --mcp-arm ${a}=mcp.json`);
const stamp = opt('stamp', `docs-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
const resume = args.includes('--resume');
const runDir = join(root, 'bench', 'docs', 'runs', stamp);

const tasks = TASKS.filter((t) => !only.length || only.includes(t.id));
const jobs = planJobs(tasks, arms, reps, { runDir, resume, suffix: DOCS_HINT });
mkdirSync(runDir, { recursive: true });
if (!resume) writeFileSync(join(runDir, 'config.json'), JSON.stringify({ model, reps, arms, tasks: tasks.map((t) => t.id), startedAt: new Date().toISOString() }, null, 2));
await runJobs(jobs, {
  runDir,
  model,
  concurrency,
  mcp: MCP,
  env: () => ({}),
});
