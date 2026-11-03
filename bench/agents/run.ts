/**
 * Runs each task with a real coding agent (Claude Code, headless) under these arms:
 *   no-docs   : no MCP server, no web; the agent pins versions from memory
 *   docs-only : this server with its security layer off (ablation: version-accurate docs alone)
 *   pinright   : this server
 *   hook-only : no MCP server, only the pinright pre-install hook
 *   pinright+hook : both
 * Built-in tools are limited to Write and Read in every arm, so the only
 * difference is the MCP server. Any other MCP server can be added as an arm with
 * --mcp-arm name=mcp.json (a Claude Code MCP config). Transcripts land in bench/agents/runs/<stamp>/.
 *
 * --set picks the task set (sets.ts): v6 (default, the tasks we wrote) or real-issues
 * (taken from public GitHub issues). The set is recorded in config.json for score.ts and report.ts.
 *
 *   npx tsx bench/agents/run.ts [--model sonnet] [--reps 2] [--concurrency 4] [--only id1,id2] [--arms a,b] [--set v6|real-issues]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extraArms, planJobs, runJobs } from './harness.js';
import { DEFAULT_SET, setOfRun, taskSet } from './sets.js';
import { DOCS_HINT } from './tasks.js';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const model = opt('model', 'sonnet');
const reps = Number(opt('reps', '2'));
const concurrency = Number(opt('concurrency', '4'));
const only = opt('only', '').split(',').filter(Boolean);
const armsOpt = opt('arms', 'no-docs,pinright,hook-only,pinright+hook').split(',');
const stamp = opt('stamp', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
const resume = args.includes('--resume');

const root = resolve(import.meta.dirname, '..', '..');
const runDir = join(root, 'bench', 'agents', 'runs', stamp);
const priorSet = existsSync(join(runDir, 'config.json')) ? setOfRun(runDir) : undefined;
const set = opt('set', (resume && priorSet) || DEFAULT_SET);
if (resume && priorSet && priorSet !== set) throw new Error(`--set ${set} does not match the set of run ${stamp} (${priorSet})`);
const TASKS = taskSet(set);

const cli = join(root, 'dist', 'cli.js');
const pinrightServer = { pinright: { command: 'node', args: [cli] } };
/** Ablation: the same server with its security layer off (PINRIGHT_ABLATION=docs-only, see src/mcp.ts). */
const docsOnlyServer = { pinright: { command: 'node', args: [cli], env: { PINRIGHT_ABLATION: 'docs-only' } } };
const MCP: Record<string, object> = {
  'no-docs': { mcpServers: {} },
  'docs-only': { mcpServers: docsOnlyServer },
  pinright: { mcpServers: pinrightServer },
  'hook-only': { mcpServers: {} },
  'pinright+hook': { mcpServers: pinrightServer },
  ...extraArms(args),
};
/** Arms that also get the pre-install hook, through a settings file passed with --settings. */
const HOOKED = new Set(['hook-only', 'pinright+hook']);
const hookSettings = {
  hooks: {
    PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `node "${cli.replace(/\\/g, '/')}" hook claude`, timeout: 60 }] }],
  },
};

const tasks = TASKS.filter((t) => !only.length || only.includes(t.id));
const jobs = planJobs(tasks, armsOpt, reps, { runDir, resume, suffix: DOCS_HINT });

mkdirSync(runDir, { recursive: true });
if (!resume) writeFileSync(join(runDir, 'config.json'), JSON.stringify({ model, set, reps, arms: armsOpt, tasks: only.length ? only : TASKS.map((t) => t.id), startedAt: new Date().toISOString() }, null, 2));
await runJobs(jobs, {
  runDir,
  model,
  concurrency,
  mcp: MCP,
  env: () => ({}),
  settings: (arm) => (HOOKED.has(arm) ? hookSettings : undefined),
});
