#!/usr/bin/env node
/**
 * pinright                      MCP server over stdio (what agents launch)
 * pinright hook <agent>         pre-install hook: reads the agent's hook JSON on stdin
 *                              (claude, cursor, codex, gemini, copilot, windsurf)
 * pinright check <eco> <name>[@version]
 * pinright audit [path] [--json] [--fail-on low|moderate|high|critical|none] [--sarif <file>] [--config <file>]
 * pinright upgrade <eco> <name> <from> [to] [--query="..."]
 * pinright init [client] [--project|--user] [--print] [--no-hook] [--no-mcp] [--no-config] [--gh-cli]
 * pinright doctor [--json] [--offline]
 * pinright cache clear|prune|path
 *
 * Only what every command needs is imported up front. The hook runs before
 * each agent command, so the checks, the MCP server, the audit and the client
 * registry are loaded by the command that uses them (see "Latency" in docs/hook.md).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PKG_VERSION } from './pkg.js';
import { parseEcosystem } from './ecosystems.js';
import { config } from './config.js';
import { fenceCommands } from './sarif/summary.js';
import { ghCliLoggedIn, githubAuthAdvice, trackGitHub } from './github.js';
import { splitNpmSpec } from './hook/intent.js';

async function serve(): Promise<number> {
  const [{ StdioServerTransport }, { buildMcpServer }, { pruneCacheIfDue }] = await Promise.all([
    import('@modelcontextprotocol/server/stdio'),
    import('./mcp.js'),
    import('./cache.js'),
  ]);
  const server = buildMcpServer();
  await server.connect(new StdioServerTransport());
  console.error('[pinright] ready on stdio');
  // Housekeeping off the request path: the server lives for the whole session.
  setTimeout(() => pruneCacheIfDue(), 10_000).unref();
  return new Promise(() => {}); // stdio keeps the process alive
}

/** Usage error: what is wrong, the command's usage line on stderr, exit 2. */
async function usage(cmd: string, problem?: string | { name: string; known: string[] }): Promise<number> {
  const { COMMANDS, unknownFlag } = await import('./cliHelp.js');
  const what = typeof problem === 'object' ? unknownFlag(problem.name, problem.known) : problem;
  console.error(`${what ? `pinright ${cmd}: ${what}\n` : ''}usage: ${COMMANDS[cmd].usage}\nRun "pinright ${cmd} --help" for details.`);
  return 2;
}

async function check(args: string[]): Promise<number> {
  // check takes no flags: "--json" read as a version made "version --json of lodash is not in the registry".
  const flag = args.find((a) => a.startsWith('--'));
  if (flag) return usage('check', { name: flag.replace(/^--/, '').replace(/=.*/, ''), known: [] });
  const eco = parseEcosystem(args[0]);
  if (!args[0] || !args[1]) return usage('check', args[0] && !eco ? `unknown ecosystem "${args[0]}"` : undefined);
  if (!eco) return usage('check', `unknown ecosystem "${args[0]}"`);
  const [{ checkPackage }, { securityNotice }] = await Promise.all([import('./verdict.js'), import('./format.js')]);
  const [name, inline] =
    eco === 'pypi' && args[1].includes('==') ? args[1].split('==')
    : eco === 'composer' && /^[^@:]+\/[^@:]+:/.test(args[1]) ? args[1].split(':')
    : splitNpmSpec(args[1]);
  // "check pypi idna 3.10" is as common as "idna@3.10"; ignoring the version would report on the latest.
  const version = inline ?? args[2];
  const v = await checkPackage(eco, name, version);
  console.log(fenceCommands(securityNotice(v.report, v.typo, v.risk)));
  return v.report.verdict === 'ok' ? 0 : 1;
}

async function upgrade(args: string[]): Promise<number> {
  const { flags, positional: pos, unknown } = parseFlags(args, ['query', 'tokens'], []);
  if (unknown) return usage('upgrade', unknown);
  const eco = parseEcosystem(pos[0]);
  if (pos[0] && !eco) return usage('upgrade', `unknown ecosystem "${pos[0]}"`);
  if (!eco || !pos[1] || !pos[2]) return usage('upgrade');
  const query = typeof flags.query === 'string' ? flags.query : undefined;
  const tokens = Number(flags.tokens);
  const { upgradeGuide } = await import('./upgrade/index.js');
  const r = await upgradeGuide({ ecosystem: eco, name: pos[1], from: pos[2], to: pos[3], query, budgetChars: tokens > 0 ? tokens * 4 : undefined });
  console.log(fenceCommands(r.text));
  return r.to ? 0 : 1;
}

/**
 * `--name value` or `--name=value`; the positionals are what is left. With a
 * list of switches, the first flag that is neither is returned as `unknown`,
 * so a typo like --jsno is an error instead of being ignored.
 */
function parseFlags(
  args: string[],
  valued: string[],
  switches?: string[],
): { flags: Record<string, string | true>; positional: string[]; unknown?: { name: string; known: string[] } } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  let unknown: { name: string; known: string[] } | undefined;
  const known = switches ? [...valued, ...switches] : undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq > 0 ? eq : undefined);
    if (known && !known.includes(name)) unknown ??= { name, known };
    if (eq > 0) flags[name] = a.slice(eq + 1);
    else if (valued.includes(name) && i + 1 < args.length && !args[i + 1].startsWith('--')) flags[name] = args[++i];
    else flags[name] = true;
  }
  return { flags, positional, unknown };
}

async function audit(args: string[]): Promise<number> {
  const { flags, positional, unknown } = parseFlags(args, ['fail-on', 'sarif', 'sarif-root', 'config'], ['json', 'no-supply-chain']);
  if (unknown) return usage('audit', unknown);
  const { AuditInputError, auditExitCode, auditJson, formatAuditRun, parseFailOn, runAudit, runToSarif, sarifRoot } = await import('./auditRun.js');
  const failOn = parseFailOn(typeof flags['fail-on'] === 'string' ? flags['fail-on'] : undefined);
  if (!failOn) return usage('audit', `--fail-on takes low, moderate, high, critical or none, not "${flags['fail-on']}"`);
  for (const f of ['sarif', 'config', 'fail-on', 'sarif-root']) if (flags[f] === true) return usage('audit', `--${f} needs a value`);
  const target = path.resolve(positional[0] ?? '.');
  let run;
  try {
    run = await runAudit({ target, config: flags.config as string | undefined, supplyChain: !flags['no-supply-chain'] });
  } catch (err) {
    if (err instanceof AuditInputError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  if (flags.json) console.log(JSON.stringify(auditJson(run), null, 2));
  else console.log(fenceCommands(formatAuditRun(run, 50)));
  if (typeof flags.sarif === 'string') {
    const log = runToSarif(run, { root: sarifRoot(target, flags['sarif-root'] as string | undefined), toolVersion: PKG_VERSION });
    fs.mkdirSync(path.dirname(path.resolve(flags.sarif)), { recursive: true });
    fs.writeFileSync(flags.sarif, `${JSON.stringify(log, null, 2)}\n`);
    console.error(`[pinright] SARIF written to ${flags.sarif} (${log.runs[0].results.length} results)`);
  }
  return auditExitCode(run, failOn);
}


async function init(args: string[]): Promise<number> {
  const [{ INIT_USAGE, runInit }, { chooseLauncher, findGlobalInstall }] = await Promise.all([import('./clients/init.js'), import('./launch.js')]);
  const { flags, positional } = parseFlags(args, []);
  if (positional.length > 1 || (flags.user && (flags.project || flags.local))) {
    console.error(INIT_USAGE);
    return 2;
  }
  // Project files go to the team, so they get npx unless --bin; the user's own files get the global binary when there is one.
  if (flags.bin && flags.npx) return usage('init', '--bin and --npx contradict each other');
  const global = flags.dev || flags.npx ? undefined : findGlobalInstall();
  if (flags.bin && !global) {
    console.error(`pinright init: --bin needs a global install of pinright on PATH (npm i -g pinright); none was found.`);
    return 2;
  }
  const choice = (scope: 'project' | 'user') =>
    chooseLauncher({ scope, dev: flags.dev ? fileURLToPath(import.meta.url) : undefined, npx: Boolean(flags.npx), bin: Boolean(flags.bin), version: PKG_VERSION, global });
  const r = runInit(
    { cwd: process.cwd(), home: os.homedir(), platform: process.platform, env: process.env },
    {
      client: positional[0],
      // --local is the project scope too (the files live in this checkout of the project).
      scope: flags.user ? 'user' : flags.project || flags.local ? 'project' : undefined,
      mcp: !flags['no-mcp'],
      hook: !flags['no-hook'],
      config: !flags['no-config'],
      print: Boolean(flags.print),
      launch: { command: choice('project').command, args: choice('project').args },
      launchFor: (scope) => {
        const c = choice(scope);
        return { launch: { command: c.command, args: c.args }, why: c.why };
      },
      ghCli: Boolean(flags['gh-cli']),
    },
  );
  for (const line of r.lines) (r.code === 2 ? console.error : console.log)(line);
  if (r.code === 0 && !flags.print) {
    console.log(githubAuthAdvice({ envToken: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN), ghLoggedIn: ghCliLoggedIn(), optIn: Boolean(flags['gh-cli']) }));
  }
  return r.code;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** `cache clear` empties the disk cache; `prune` drops expired entries and caps its size; `path` prints where it is. */
async function cache(args: string[]): Promise<number> {
  if (args.length !== 1) return usage('cache');
  switch (args[0]) {
    case 'clear': {
      // Entry files only, not the folder: PINRIGHT_CACHE_DIR may point at one that holds other things.
      const { clearCache } = await import('./cache.js');
      console.log(`cleared ${clearCache()} entries from ${config.cacheDir}`);
      return 0;
    }
    case 'prune': {
      const { pruneCache } = await import('./cache.js');
      const r = pruneCache();
      console.log(`removed ${r.removed} entries (${mb(r.freedBytes)}); ${r.remaining.files} left (${mb(r.remaining.bytes)}, cap ${mb(config.cacheMaxBytes)}) in ${config.cacheDir}`);
      return 0;
    }
    case 'path':
      console.log(config.cacheDir);
      return 0;
    default:
      return usage('cache', `unknown subcommand "${args[0]}"`);
  }
}

async function doctor(args: string[]): Promise<number> {
  const { flags, unknown } = parseFlags(args, [], ['json', 'offline']);
  if (unknown) return usage('doctor', unknown);
  const [{ runDoctor, formatDoctor }, { colorEnabled }] = await Promise.all([import('./doctor.js'), import('./cliHelp.js')]);
  const report = await runDoctor({ offline: Boolean(flags.offline) });
  console.log(flags.json ? JSON.stringify(report, null, 2) : formatDoctor(report, colorEnabled()));
  return report.ok ? 0 : 1;
}

/** After a batch command: drop expired cache entries once a day. Never in the hook, which must exit at once. */
async function housekeeping(code: number): Promise<number> {
  try {
    (await import('./cache.js')).pruneCacheIfDue();
  } catch {
    // the cache fails soft everywhere
  }
  return code;
}

/** What GitHub's rate limit or a failing upstream left out, on stderr so `--json` output stays parseable. */
async function noticed(run: () => Promise<number>): Promise<number> {
  const { trackUpstreams } = await import('./http.js');
  const { value: tracked, notice: upstreams } = await trackUpstreams(() => trackGitHub(run));
  for (const n of [tracked.notice, upstreams]) if (n) console.error(`\n${n}`);
  return tracked.value;
}

const wantsHelp = (args: string[]) => args.includes('--help') || args.includes('-h');

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  // The hook first and with nothing else loaded: it runs before every agent command.
  // Never a usage error here: Claude Code reads exit 2 from a hook as "block".
  if (cmd === 'hook' && !(args.length === 1 && wantsHelp(args))) {
    const { HOOK_AGENTS, isHookAgent, runHook } = await import('./hook/run.js');
    // No agent named: Claude Code, as before the other agents existed.
    if (args[0] !== undefined && !isHookAgent(args[0])) {
      // Exit 2 blocks every tool call in most agents; 1 lets the agent go on, as a crash does.
      console.error(`usage: pinright hook <${HOOK_AGENTS.join('|')}>`);
      return 1;
    }
    return runHook(args[0] ?? 'claude');
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(PKG_VERSION);
    return 0;
  }
  // A person at a terminal typing "pinright" wants help, not a server waiting on stdin; agents pipe stdin.
  if (cmd === undefined && process.stdin.isTTY) {
    const { mainHelp, colorEnabled } = await import('./cliHelp.js');
    console.log(mainHelp(PKG_VERSION, colorEnabled()));
    console.log('(Agents start the MCP server with "pinright" over a pipe, or "pinright serve".)');
    return 0;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    const { canonical, commandHelp, mainHelp, colorEnabled, unknownCommand } = await import('./cliHelp.js');
    if (!args[0]) {
      console.log(mainHelp(PKG_VERSION, colorEnabled()));
      return 0;
    }
    const c = canonical(args[0]);
    if (!c) {
      console.error(unknownCommand(args[0]));
      return 2;
    }
    console.log(commandHelp(c));
    return 0;
  }
  if (cmd !== undefined && wantsHelp(args)) {
    const { canonical, commandHelp } = await import('./cliHelp.js');
    const c = canonical(cmd);
    if (c) {
      console.log(commandHelp(c));
      return 0;
    }
  }
  switch (cmd) {
    case undefined:
    case 'serve':
    case 'mcp':
      return serve();
    case 'check':
      return housekeeping(await noticed(() => check(args)));
    case 'audit':
      return housekeeping(await noticed(() => audit(args)));
    case 'upgrade':
      return housekeeping(await noticed(() => upgrade(args)));
    case 'init':
      return init(args);
    case 'doctor':
      return doctor(args);
    case 'cache':
      return cache(args);
    default: {
      const { unknownCommand } = await import('./cliHelp.js');
      console.error(unknownCommand(cmd));
      return 2;
    }
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[pinright] fatal:', (err as Error).message);
    // A crashing hook must not wedge the agent; Claude Code and Cursor treat exit 1 as "proceed".
    process.exit(1);
  },
);
