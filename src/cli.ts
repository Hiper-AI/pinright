#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON from registries, lockfiles and agent hooks, read defensively */
/**
 * safectx                      MCP server over stdio (what agents launch)
 * safectx hook claude|cursor   pre-install hook: reads the agent's hook JSON on stdin
 * safectx check <eco> <name>[@version]
 * safectx audit [path] [--json] [--fail-on low|moderate|high|critical|none] [--sarif <file>] [--config <file>]
 * safectx upgrade <eco> <name> <from> [to] [--query="..."]
 * safectx init [claude|cursor] [--no-hook] [--no-mcp] [--no-config] [--gh-cli]
 * safectx cache clear
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { AuditInputError, auditExitCode, auditJson, formatAuditRun, parseFailOn, runAudit, runToSarif, sarifRoot } from './auditRun.js';
import { PKG_VERSION } from './pkg.js';
import { parseEcosystem } from './ecosystems.js';
import { config } from './config.js';
import { securityNotice } from './format.js';
import { fenceCommands } from './sarif/summary.js';
import { ghCliLoggedIn, githubAuthAdvice, mcpEntryEnv, trackGitHub } from './github.js';
import { runClaudeHook, runCursorHook } from './hook/run.js';
import { splitNpmSpec } from './hook/intent.js';
import { buildMcpServer } from './mcp.js';
import { CONFIG_FILE, STARTER_CONFIG } from './teamConfig.js';
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

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(p: string, data: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), p) || p}`);
}

/** How the agent should launch us: the published package, or this checkout with --local. */
function launcher(local: boolean): { command: string; args: string[] } {
  if (!local) return { command: 'npx', args: ['-y', 'safectx'] };
  return { command: 'node', args: [fileURLToPath(import.meta.url)] };
}

/** safectx's MCP entry: the launcher, and the env the user had (with SAFECTX_GH_CLI per --gh-cli). Never a token. */
function mcpEntry(previous: any, l: { command: string; args: string[] }, ghCli: boolean) {
  const { env, warnings } = mcpEntryEnv(previous?.env, ghCli);
  for (const w of warnings) console.log(`warning: ${w}`);
  return { command: l.command, args: l.args, ...(env ? { env } : {}) };
}

function init(args: string[]): number {
  const code = initFiles(args);
  if (code === 0) {
    console.log(githubAuthAdvice({ envToken: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN), ghLoggedIn: ghCliLoggedIn(), optIn: args.includes('--gh-cli') }));
  }
  return code;
}

function initFiles(args: string[]): number {
  const agent = args.find((a) => !a.startsWith('--')) ?? 'claude';
  const local = args.includes('--local');
  const withHook = !args.includes('--no-hook');
  const withMcp = !args.includes('--no-mcp');
  const ghCli = args.includes('--gh-cli');
  const l = launcher(local);
  const shell = (extra: string[]) => [l.command, ...l.args, ...extra].map((s) => (/\s/.test(s) ? `"${s}"` : s)).join(' ');
  // The team policy starter, never over an existing one: that file belongs to the team.
  if ((agent === 'claude' || agent === 'cursor') && !args.includes('--no-config')) {
    const team = path.resolve(CONFIG_FILE);
    if (fs.existsSync(team)) console.log(`kept ${CONFIG_FILE} (already present)`);
    else {
      fs.writeFileSync(team, STARTER_CONFIG);
      console.log(`wrote ${CONFIG_FILE}`);
    }
  }
  if (agent === 'claude') {
    if (withMcp) {
      const p = path.resolve('.mcp.json');
      const j = readJson(p);
      j.mcpServers = { ...(j.mcpServers ?? {}), safectx: mcpEntry(j.mcpServers?.safectx, l, ghCli) };
      writeJson(p, j);
    }
    if (withHook) {
      const p = path.resolve('.claude', 'settings.json');
      const j = readJson(p);
      const entry = { matcher: 'Bash|Write|Edit|MultiEdit', hooks: [{ type: 'command', command: shell(['hook', 'claude']), timeout: 60 }] };
      const pre = (j.hooks?.PreToolUse ?? []).filter((h: any) => !JSON.stringify(h).includes('safectx'));
      j.hooks = { ...(j.hooks ?? {}), PreToolUse: [...pre, entry] };
      writeJson(p, j);
    }
    return 0;
  }
  if (agent === 'cursor') {
    if (withMcp) {
      const p = path.resolve('.cursor', 'mcp.json');
      const j = readJson(p);
      j.mcpServers = { ...(j.mcpServers ?? {}), safectx: mcpEntry(j.mcpServers?.safectx, l, ghCli) };
      writeJson(p, j);
    }
    if (withHook) {
      const p = path.resolve('.cursor', 'hooks.json');
      const j = readJson(p);
      const cmd = { command: shell(['hook', 'cursor']), timeout: 60 };
      const keep = (list: any[] | undefined) => (list ?? []).filter((h) => !JSON.stringify(h).includes('safectx'));
      j.version = j.version ?? 1;
      j.hooks = {
        ...(j.hooks ?? {}),
        beforeShellExecution: [...keep(j.hooks?.beforeShellExecution), cmd],
        preToolUse: [...keep(j.hooks?.preToolUse), cmd],
      };
      writeJson(p, j);
    }
    return 0;
  }
  console.error('usage: safectx init [claude|cursor] [--local] [--no-hook] [--no-mcp] [--no-config] [--gh-cli]');
  return 2;
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
      return args[0] === 'cursor' ? runCursorHook() : runClaudeHook();
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
      console.error('usage: safectx [serve | hook claude|cursor | check <eco> <name>[@ver | ver] | audit [path] | upgrade <eco> <name> <from> [to] | init [claude|cursor] | cache clear]');
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
