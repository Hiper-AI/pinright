/**
 * Runs each task with a real coding agent (Claude Code, headless) under these arms:
 *   no-docs   : no MCP server, no web; the agent pins versions from memory
 *   docs-only : this server with its security layer off (ablation: version-accurate docs alone)
 *   pinright   : this server
 *   hook-only : no MCP server, only the pinright pre-install hook
 *   pinright+hook : both
 * Built-in tools are limited to Write and Read in every arm by default, so the only
 * difference is the MCP server. Any other MCP server can be added as an arm with
 * --mcp-arm name=mcp.json (a Claude Code MCP config). Transcripts land in bench/agents/runs/<stamp>/.
 *
 * --set picks the task set (sets.ts): v6 (default, the tasks we wrote) or real-issues
 * (taken from public GitHub issues). The set is recorded in config.json for score.ts and report.ts.
 *
 *   npx tsx bench/agents/run.ts [--model sonnet] [--reps 2] [--concurrency 4] [--only id1,id2] [--arms a,b] [--set v6|real-issues]
 *
 * Shell arm: `--tools Write,Read,Bash --sandbox docker` runs every job in a fresh container from
 * bench/agents/sandbox/Dockerfile (`--image`, default pinright-bench-sandbox:local), with pinright
 * built into the image, and asks for a real install instead of "do not run any command". Bash is
 * refused without the sandbox: installs run third-party install scripts.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { extraArms, planJobs, runJobs, type Sandbox, toolsArg } from './harness.js';
import { DEFAULT_SET, setOfRun, taskSet } from './sets.js';
import { DOCS_HINT, shellTask } from './tasks.js';

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
const tools = toolsArg(args);
const shell = tools.includes('Bash');
const sandboxKind = opt('sandbox', '');
if (sandboxKind && sandboxKind !== 'docker') throw new Error('--sandbox supports only "docker"');
if (shell && !sandboxKind) throw new Error('--tools with Bash needs --sandbox docker: the agent would run installs on this machine');

const root = resolve(import.meta.dirname, '..', '..');
const runDir = join(root, 'bench', 'agents', 'runs', stamp);
const priorSet = existsSync(join(runDir, 'config.json')) ? setOfRun(runDir) : undefined;
const set = opt('set', (resume && priorSet) || DEFAULT_SET);
if (resume && priorSet && priorSet !== set) throw new Error(`--set ${set} does not match the set of run ${stamp} (${priorSet})`);
const TASKS = taskSet(set);

let sandbox: Sandbox | undefined;
if (sandboxKind) {
  sandbox = { image: opt('image', 'pinright-bench-sandbox:local'), credentials: opt('credentials', join(homedir(), '.claude', '.credentials.json')) };
  if (!existsSync(sandbox.credentials)) throw new Error(`no Claude credentials at ${sandbox.credentials} (log in with claude, or pass --credentials)`);
}

// In the sandbox, pinright is the copy built into the image.
const cli = sandbox ? '/opt/pinright/dist/cli.js' : join(root, 'dist', 'cli.js');
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
// In the sandbox the hook runs through a wrapper that logs each decision to the job's hook-events.jsonl.
const hookCommand = sandbox ? 'node /opt/pinright/bench/agents/sandbox/hook-log.mjs' : `node "${cli.replace(/\\/g, '/')}" hook claude`;
const hookSettings = {
  hooks: {
    PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit', hooks: [{ type: 'command', command: hookCommand, timeout: 60 }] }],
  },
};

const tasks = TASKS.filter((t) => !only.length || only.includes(t.id)).map((t) => (shell ? shellTask(t) : t));
const jobs = planJobs(tasks, armsOpt, reps, { runDir, resume, suffix: DOCS_HINT });

mkdirSync(runDir, { recursive: true });
if (!resume) {
  writeFileSync(join(runDir, 'config.json'), JSON.stringify({
    model, set, reps, arms: armsOpt, tasks: only.length ? only : TASKS.map((t) => t.id), tools,
    sandbox: sandbox ? { kind: sandboxKind, image: sandbox.image } : undefined,
    startedAt: new Date().toISOString(),
  }, null, 2));
}
await runJobs(jobs, {
  runDir,
  model,
  concurrency,
  mcp: MCP,
  env: () => ({}),
  settings: (arm) => (HOOKED.has(arm) ? hookSettings : undefined),
  tools,
  sandbox,
});
