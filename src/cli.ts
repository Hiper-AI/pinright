#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON from registries, lockfiles and agent hooks, read defensively */
/**
 * safectx                      MCP server over stdio (what agents launch)
 * safectx hook claude|cursor   pre-install hook: reads the agent's hook JSON on stdin
 * safectx check <eco> <name>[@version]
 * safectx audit [path] [--json] [--fail-on=low|moderate|high|critical]
 * safectx upgrade <eco> <name> <from> [to] [--query="..."]
 * safectx init [claude|cursor] [--no-hook] [--no-mcp] [--no-config]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { actionsAuditFails, auditActions, formatActionsAudit } from './actions/check.js';
import { parseUses, workflowFiles } from './actions/workflow.js';
import { parseEcosystem } from './ecosystems.js';
import { securityNotice } from './format.js';
import { runClaudeHook, runCursorHook } from './hook/run.js';
import { splitNpmSpec } from './hook/intent.js';
import { buildMcpServer, manifestsIn, readSiblings } from './mcp.js';
import { auditTree, formatTreeAudit, type TreeAudit } from './tree/audit.js';
import { CONFIG_FILE, STARTER_CONFIG } from './teamConfig.js';
import { parseFile } from './tree/lockfiles.js';
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
    console.error('usage: safectx check <npm|pypi|cargo|go|maven|nuget|rubygems|composer> <name>[@version]');
    return 2;
  }
  const [name, version] =
    eco === 'pypi' && args[1].includes('==') ? args[1].split('==')
    : eco === 'composer' && /^[^@:]+\/[^@:]+:/.test(args[1]) ? args[1].split(':')
    : splitNpmSpec(args[1]);
  const v = await checkPackage(eco, name, version);
  console.log(securityNotice(v.report, v.typo, v.risk));
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
  console.log(r.text);
  return r.to ? 0 : 1;
}

const SEV = ['low', 'moderate', 'high', 'critical'];

async function audit(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const failOn = args.find((a) => a.startsWith('--fail-on='))?.split('=')[1] ?? 'low';
  const target = path.resolve(args.find((a) => !a.startsWith('--')) ?? '.');
  const wf = workflowFiles(target);
  const files = fs.statSync(target).isDirectory() ? manifestsIn(target) : wf.length ? [] : [target];
  if (!files.length && !wf.length) {
    console.error(`No supported lockfile, manifest or workflow in ${target}`);
    return 2;
  }
  const audits: TreeAudit[] = [];
  for (const f of files) audits.push(await auditTree(parseFile(f, fs.readFileSync(f, 'utf8'), readSiblings(f))));
  const actions = wf.length ? await auditActions(wf.map((f) => ({ file: f, uses: parseUses(fs.readFileSync(f, 'utf8'), f) }))) : undefined;
  if (json) console.log(JSON.stringify(actions ? [...audits, { actions }] : audits, null, 2));
  else console.log([...audits.map((a) => formatTreeAudit(a, 50)), ...(actions ? [formatActionsAudit(actions, 50)] : [])].join('\n\n'));
  const floor = Math.max(0, SEV.indexOf(failOn));
  const bad = audits.some(
    (a) => a.malicious > 0 || SEV.slice(floor).some((s) => a.bySeverity[s as keyof TreeAudit['bySeverity']] > 0) || (floor === 0 && a.bySeverity.unknown > 0),
  );
  return bad || (actions && actionsAuditFails(actions, floor, SEV)) ? 1 : 0;
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

function init(args: string[]): number {
  const agent = args.find((a) => !a.startsWith('--')) ?? 'claude';
  const local = args.includes('--local');
  const withHook = !args.includes('--no-hook');
  const withMcp = !args.includes('--no-mcp');
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
      j.mcpServers = { ...(j.mcpServers ?? {}), safectx: { command: l.command, args: l.args } };
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
      j.mcpServers = { ...(j.mcpServers ?? {}), safectx: { command: l.command, args: l.args } };
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
  console.error('usage: safectx init [claude|cursor] [--local] [--no-hook] [--no-mcp] [--no-config]');
  return 2;
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
      return check(args);
    case 'audit':
      return audit(args);
    case 'upgrade':
      return upgrade(args);
    case 'init':
      return init(args);
    case '--version':
    case '-v':
      console.log(readJson(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')).version);
      return 0;
    default:
      console.error('usage: safectx [serve | hook claude|cursor | check <eco> <name>[@ver] | audit [path] | upgrade <eco> <name> <from> [to] | init [claude|cursor]]');
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
