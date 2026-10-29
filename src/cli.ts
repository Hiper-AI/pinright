#!/usr/bin/env node
/**
 * safectx                      MCP server over stdio (what agents launch)
 * safectx hook <agent>         pre-install hook: reads the agent's hook JSON on stdin
 *                              (claude, cursor, codex, gemini, copilot, windsurf)
 * safectx check <eco> <name>[@version]
 * safectx audit [path] [--json] [--fail-on low|moderate|high|critical|none] [--sarif <file>] [--config <file>]
 * safectx upgrade <eco> <name> <from> [to] [--query="..."]
 * safectx init [client] [--project|--user] [--print] [--no-hook] [--no-mcp] [--no-config] [--gh-cli]
 * safectx cache clear
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { AuditInputError, auditExitCode, auditJson, formatAuditRun, parseFailOn, runAudit, runToSarif, sarifRoot } from './auditRun.js';
import { npxLauncher, PKG_VERSION } from './pkg.js';
import { parseEcosystem } from './ecosystems.js';
import { config } from './config.js';
import { securityNotice } from './format.js';
import { fenceCommands } from './sarif/summary.js';
import { ghCliLoggedIn, githubAuthAdvice, trackGitHub } from './github.js';
import { HOOK_AGENTS, isHookAgent, runHook } from './hook/run.js';
import { INIT_USAGE, runInit } from './clients/init.js';
import { splitNpmSpec } from './hook/intent.js';
import { buildMcpServer } from './mcp.js';
import { upgradeGuide } from './upgrade/index.js';
import { checkPackage } from './verdict.js';

async function serve(): Promise<number> {
  const server = buildMcpServer();
  await server.connect(new StdioServerTransport());
  console.error('[safectx] ready on stdio');
  return new Promise(() => {}); // stdio keeps the process alive
}

async function check(args: string[]): Promise<number> {
  const eco = parseEcosystem(args[0]);
  if (!eco || !args[1]) {
    console.error('usage: safectx check <npm|pypi|cargo|go|maven|nuget|rubygems|composer> <name>[@version | version]');
    return 2;
  }
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
  const pos = args.filter((a) => !a.startsWith('--'));
  const eco = parseEcosystem(pos[0]);
  if (!eco || !pos[1] || !pos[2]) {
    console.error('usage: safectx upgrade <npm|pypi|...> <name> <from> [to] [--query="..."] [--tokens=N]');
    return 2;
  }
  const query = args.find((a) => a.startsWith('--query='))?.slice(8);
  const tokens = Number(args.find((a) => a.startsWith('--tokens='))?.slice(9));
  const r = await upgradeGuide({ ecosystem: eco, name: pos[1], from: pos[2], to: pos[3], query, budgetChars: tokens > 0 ? tokens * 4 : undefined });
  console.log(fenceCommands(r.text));
  return r.to ? 0 : 1;
}

/** `--name value` or `--name=value`; the positionals are what is left. */
function parseFlags(args: string[], valued: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq > 0 ? eq : undefined);
    if (eq > 0) flags[name] = a.slice(eq + 1);
    else if (valued.includes(name) && i + 1 < args.length && !args[i + 1].startsWith('--')) flags[name] = args[++i];
    else flags[name] = true;
  }
  return { flags, positional };
}

const AUDIT_USAGE =
  'usage: safectx audit [path] [--fail-on low|moderate|high|critical|none] [--json] [--sarif <file>] [--sarif-root <dir>] [--config <.safectx.json>] [--no-supply-chain]';

async function audit(args: string[]): Promise<number> {
  const { flags, positional } = parseFlags(args, ['fail-on', 'sarif', 'sarif-root', 'config']);
  const failOn = parseFailOn(typeof flags['fail-on'] === 'string' ? flags['fail-on'] : undefined);
  if (!failOn || flags.sarif === true || flags.config === true || flags['fail-on'] === true) {
    console.error(AUDIT_USAGE);
    return 2;
  }
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
    console.error(`[safectx] SARIF written to ${flags.sarif} (${log.runs[0].results.length} results)`);
  }
  return auditExitCode(run, failOn);
}

/** How the agent should launch us: the published package, or this checkout with --dev. */
function launcher(dev: boolean): { command: string; args: string[] } {
  if (!dev) return npxLauncher();
  return { command: 'node', args: [fileURLToPath(import.meta.url)] };
}

function init(args: string[]): number {
  const { flags, positional } = parseFlags(args, []);
  if (positional.length > 1 || (flags.user && (flags.project || flags.local))) {
    console.error(INIT_USAGE);
    return 2;
  }
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
      launch: launcher(Boolean(flags.dev)),
      ghCli: Boolean(flags['gh-cli']),
    },
  );
  for (const line of r.lines) (r.code === 2 ? console.error : console.log)(line);
  if (r.code === 0 && !flags.print) {
    console.log(githubAuthAdvice({ envToken: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN), ghLoggedIn: ghCliLoggedIn(), optIn: Boolean(flags['gh-cli']) }));
  }
  return r.code;
}

/** `cache clear` empties the disk cache. */
function cache(args: string[]): number {
  if (args[0] !== 'clear' || args[1]) {
    console.error('usage: safectx cache clear');
    return 2;
  }
  fs.rmSync(config.cacheDir, { recursive: true, force: true });
  console.log(`cleared ${config.cacheDir}`);
  return 0;
}

/** What GitHub's rate limit left out, on stderr so `--json` output stays parseable. */
async function noticed(run: () => Promise<number>): Promise<number> {
  const { value, notice } = await trackGitHub(run);
  if (notice) console.error(`\n${notice}`);
  return value;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'serve':
    case 'mcp':
      return serve();
    case 'hook':
      // No agent named: Claude Code, as before the other agents existed.
      if (args[0] !== undefined && !isHookAgent(args[0])) {
        // Exit 2 blocks every tool call in most agents; 1 lets the agent go on, as a crash does.
        console.error(`usage: safectx hook <${HOOK_AGENTS.join('|')}>`);
        return 1;
      }
      return runHook(args[0] ?? 'claude');
    case 'check':
      return noticed(() => check(args));
    case 'audit':
      return noticed(() => audit(args));
    case 'upgrade':
      return noticed(() => upgrade(args));
    case 'init':
      return init(args);
    case 'cache':
      return cache(args);
    case '--version':
    case '-v':
      console.log(PKG_VERSION);
      return 0;
    default:
      console.error('usage: safectx [serve | hook <agent> | check <eco> <name>[@ver | ver] | audit [path] | upgrade <eco> <name> <from> [to] | init [client] | cache clear]');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[safectx] fatal:', (err as Error).message);
    // A crashing hook must not wedge the agent; Claude Code and Cursor treat exit 1 as "proceed".
    process.exit(1);
  },
);
