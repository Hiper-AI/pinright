/**
 * `safectx init [client] [--user | --project] [--print]`: the MCP entry and, where
 * the client has one, the pre-install hook, merged into the client's own files.
 *
 * - Only our entry changes; other servers, hooks, comments and formatting stay.
 * - A file that changes is backed up next to itself first (`<file>.<name>.bak`).
 * - Running it twice changes nothing the second time.
 * - `--print` shows each file as it would be written and touches nothing.
 * - No token is ever written: the env of an existing entry is kept, never added to.
 * - Without a client it sets up the clients this project already uses, and only
 *   lists the ones installed for the user: writing into apps nobody named is a surprise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PKG_NAME, SERVER_KEY } from '../pkg.js';
import { CONFIG_FILE, STARTER_CONFIG } from '../teamConfig.js';
import { mcpEntryEnv } from '../github.js';
import { ConfigError } from './edit.js';
import { CLIENTS, type Client, type Ctx, type EnvFor, type FileWrite, type Launch, type Scope, findClient } from './registry.js';

export interface InitOptions {
  client?: string;
  scope?: Scope;
  mcp: boolean;
  hook: boolean;
  config: boolean;
  print: boolean;
  launch: Launch;
  /** Adds SAFECTX_GH_CLI=1 to the entry (see mcpEntryEnv). */
  ghCli: boolean;
}

export interface InitResult {
  code: number;
  lines: string[];
  /** Files written (or that would be, with --print). */
  files: string[];
}

/** A path for humans: relative inside the project, ~ inside home. */
function show(file: string, ctx: Ctx): string {
  const rel = path.relative(ctx.cwd, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  const h = path.relative(ctx.home, file);
  if (h && !h.startsWith('..') && !path.isAbsolute(h)) return path.join('~', h);
  return file;
}

const shellWord = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** The writes for one client at one scope, with a note for each half it cannot do there. */
function plan(client: Client, scope: Scope, ctx: Ctx, o: InitOptions, env: EnvFor, notes: string[]): FileWrite[] {
  const writes: FileWrite[] = [];
  if (o.mcp) {
    if (client.mcp && client.mcpScopes.includes(scope)) writes.push(...client.mcp(scope, ctx, o.launch, env));
    else if (client.mcpScopes.length) notes.push(`${client.title} has no ${scope}-level MCP file; use --${client.mcpScopes[0]}.`);
  }
  if (o.hook && client.hook) {
    if (client.hook.scopes.includes(scope)) {
      const command = [o.launch.command, ...o.launch.args, 'hook', client.hook.agent].map(shellWord).join(' ');
      writes.push(client.hook.write(scope, ctx, command));
    } else notes.push(`${client.title} has no ${scope}-level hook file; use --${client.hook.scopes[0]}.`);
  }
  return writes;
}

/** Runs the writes of one file in order (Gemini CLI keeps the server and the hook in the same file). */
function apply(writes: FileWrite[], ctx: Ctx, o: InitOptions, out: InitResult): void {
  const byFile = new Map<string, FileWrite[]>();
  for (const w of writes) byFile.set(w.file, [...(byFile.get(w.file) ?? []), w]);
  for (const [file, ws] of byFile) {
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    let after = before;
    for (const w of ws) after = w.update(after);
    const what = [...new Set(ws.map((w) => w.what))].join(' + ');
    if (after === before) {
      out.lines.push(`unchanged ${show(file, ctx)} (${what} already set)`);
      continue;
    }
    out.files.push(file);
    if (o.print) {
      out.lines.push(`--- ${show(file, ctx)} (${what}, would ${before === undefined ? 'create' : 'update'})`, (after ?? '').trimEnd(), '');
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (before !== undefined) {
      const bak = `${file}.${SERVER_KEY}.bak`;
      fs.writeFileSync(bak, before);
      out.lines.push(`backup ${show(bak, ctx)}`);
    }
    fs.writeFileSync(file, after ?? '');
    out.lines.push(`wrote ${show(file, ctx)} (${what})`);
  }
}

function teamConfig(ctx: Ctx, o: InitOptions, out: InitResult): void {
  // The team policy starter, never over an existing one: that file belongs to the team.
  const file = path.join(ctx.cwd, CONFIG_FILE);
  if (fs.existsSync(file)) {
    out.lines.push(`kept ${CONFIG_FILE} (already present)`);
    return;
  }
  out.files.push(file);
  if (o.print) out.lines.push(`--- ${CONFIG_FILE} (team policy starter, would create)`, STARTER_CONFIG.trimEnd(), '');
  else {
    fs.writeFileSync(file, STARTER_CONFIG);
    out.lines.push(`wrote ${CONFIG_FILE}`);
  }
}

function setUp(client: Client, scope: Scope, ctx: Ctx, o: InitOptions, env: EnvFor, out: InitResult): void {
  if (!client.mcpScopes.length && client.manual) {
    out.lines.push(`${client.title}:`, ...client.manual(o.launch));
    return;
  }
  const notes: string[] = [];
  const writes = plan(client, scope, ctx, o, env, notes);
  out.lines.push(`${client.title}:`);
  apply(writes, ctx, o, out);
  out.lines.push(...notes);
  if (writes.length) out.lines.push(...(client.after?.(scope) ?? []));
}

export const INIT_USAGE = `usage: ${PKG_NAME} init [client] [--project | --user] [--print] [--no-hook] [--no-mcp] [--no-config] [--gh-cli]\nclients: ${CLIENTS.map((c) => c.id).join(', ')}`;

export function runInit(ctx: Ctx, o: InitOptions): InitResult {
  if (!o.print) {
    // A dry run first: a file that does not parse stops everything before anything is written.
    const dry = runInit(ctx, { ...o, print: true });
    if (dry.code !== 0) return dry;
  }
  const out: InitResult = { code: 0, lines: [], files: [] };
  const warnings = new Set<string>();
  const env: EnvFor = (previous) => {
    const r = mcpEntryEnv(previous, o.ghCli);
    for (const w of r.warnings) warnings.add(w);
    return r.env;
  };
  try {
    let targets: Client[];
    if (o.client) {
      const c = findClient(o.client);
      if (!c) return { code: 2, lines: [`unknown client "${o.client}"`, INIT_USAGE], files: [] };
      targets = [c];
    } else {
      // No client named: the ones this project already uses, at project scope.
      targets = CLIENTS.filter((c) => c.mcpScopes.includes('project') && c.inProject(ctx));
      if (!targets.length) {
        out.lines.push(`No client config found in this project; setting up Claude Code. Name a client to pick another: ${CLIENTS.map((c) => c.id).join(', ')}.`);
        targets = [findClient('claude')!];
      } else out.lines.push(`Found in this project: ${targets.map((c) => c.title).join(', ')}.`);
    }
    const scopeOf = (c: Client): Scope => o.scope ?? (o.client ? (c.mcpScopes[0] ?? 'project') : 'project');
    if (o.config && targets.some((c) => scopeOf(c) === 'project' && c.mcpScopes.length)) teamConfig(ctx, o, out);
    for (const c of targets) setUp(c, scopeOf(c), ctx, o, env, out);
    for (const w of warnings) out.lines.push(`warning: ${w}`);
    if (!o.client) {
      const others = CLIENTS.filter((c) => !targets.includes(c) && c.installed(ctx));
      if (others.length) {
        out.lines.push('', 'Also installed for this user (not changed):');
        for (const c of others) out.lines.push(`  ${c.title}: npx -y ${PKG_NAME} init ${c.id}${c.mcpScopes[0] === 'user' ? '' : ' --user'}`);
      }
    }
    if (o.print) out.lines.push('(--print: nothing was written)');
    return out;
  } catch (err) {
    if (err instanceof ConfigError) return { code: 1, lines: [...out.lines, `error: ${err.message}`], files: out.files };
    throw err;
  }
}
