/**
 * `pinright init [client] [--user | --project] [--print]`: the MCP entry and, where
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
import { hookCommandIn } from '../launch.js';
import { CONFIG_FILE, STARTER_CONFIG } from '../teamStarter.js';
import { mcpEntryEnv } from '../github.js';
import { ConfigError } from './edit.js';
import { hasLegacyEntry, legacySibling, OLD_NAME } from './legacy.js';
import { CLIENTS, type Client, type Ctx, type EnvFor, type FileWrite, type Launch, type Scope, findClient } from './registry.js';

export interface InitOptions {
  client?: string;
  scope?: Scope;
  mcp: boolean;
  hook: boolean;
  config: boolean;
  print: boolean;
  launch: Launch;
  /**
   * The launcher per scope, with why it was chosen, when it differs between them: the portable
   * npx in project files a team commits, the global binary in the user's own files. Wins over launch.
   */
  launchFor?: (scope: Scope) => { launch: Launch; why: string };
  /** Adds PINRIGHT_GH_CLI=1 to the entry (see mcpEntryEnv). */
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
  const launch = o.launchFor?.(scope).launch ?? o.launch;
  if (o.mcp) {
    if (client.mcp && client.mcpScopes.includes(scope)) writes.push(...client.mcp(scope, ctx, launch, env));
    else if (client.mcpScopes.length) notes.push(`${client.title} has no ${scope}-level MCP file; use --${client.mcpScopes[0]}.`);
  }
  if (o.hook && client.hook) {
    if (client.hook.scopes.includes(scope)) {
      const command = [launch.command, ...launch.args, 'hook', client.hook.agent].map(shellWord).join(' ');
      const twin = otherScopeHook(client, scope, ctx);
      // Claude Code merges the hooks of user and project settings and runs both unless the commands are
      // identical: a second, different pinright hook checks every tool call twice and waits for the slower one.
      if (twin && twin.command !== command && scope === 'user') {
        notes.push(
          `Hook not written to the user file: this project already runs "${twin.command}" from ${show(twin.file, ctx)}, and ${client.title} ` +
            `would run both here (it merges only identical commands), checking each tool call twice. Keep the project's hook; ` +
            `for your other projects, run "${PKG_NAME} init ${client.id} --user" from a folder without a project hook.`,
        );
      } else {
        writes.push(client.hook.write(scope, ctx, command));
        if (twin && twin.command !== command) {
          notes.push(
            `Note: your user file ${show(twin.file, ctx)} already runs "${twin.command}". ${client.title} runs both hooks in this project ` +
              `(it merges only identical commands): each tool call is checked twice and waits for the slower one. Remove the pinright ` +
              `entry from one of the two files, or give both the same command.`,
          );
        }
      }
    } else notes.push(`${client.title} has no ${scope}-level hook file; use --${client.hook.scopes[0]}.`);
  }
  return writes;
}

/** Our hook for this client in the other scope's file (user for project, project for user), if there is one. */
function otherScopeHook(client: Client, scope: Scope, ctx: Ctx): { file: string; command: string } | undefined {
  const other: Scope = scope === 'user' ? 'project' : 'user';
  if (!client.hook?.scopes.includes(other)) return undefined;
  let file: string;
  let text: string;
  try {
    file = client.hook.write(other, ctx, '').file;
    // Run from the home folder, the project file and the user file are the same file.
    if (path.resolve(file) === path.resolve(client.hook.write(scope, ctx, '').file) || !fs.statSync(file).isFile()) return undefined;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  if (!text.includes(PKG_NAME)) return undefined;
  const command = hookCommandIn(text, client.hook.agent);
  return command ? { file, command } : undefined;
}

/** The old name's own file next to ours (legacy.ts): moved to a backup, so the client does not load both. */
function replaceLegacyFile(file: string, ctx: Ctx, o: InitOptions, out: InitResult): void {
  const old = legacySibling(file, SERVER_KEY);
  if (!old || !fs.existsSync(old)) return;
  const bak = `${old}.${SERVER_KEY}.bak`;
  if (o.print) out.lines.push(`--- ${show(old, ctx)} (written under the old name ${OLD_NAME}, would move to ${show(bak, ctx)})`);
  else {
    fs.renameSync(old, bak);
    out.lines.push(`replaced ${show(old, ctx)} (written under the old name ${OLD_NAME}; moved to ${show(bak, ctx)})`);
  }
  out.files.push(old);
}

const inside = (dir: string, p: string) => {
  const rel = path.relative(dir, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** The path with links resolved, also when it (or its folders) do not exist yet. */
function realTarget(p: string): string {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

/**
 * A project file is the repository's to shape: a cloned repo can ship `.claude` as a link to
 * another folder, or `.mcp.json` as a link to a file of the user's. Writing through it would put
 * our edit (or the repo's own content, as a backup) somewhere outside the project. User-scope
 * files may be links (dotfile managers); they are the user's own.
 */
function checkProjectPath(file: string, ctx: Ctx): void {
  // Run from the home directory, every user file is "inside": those are the user's own.
  if (!inside(ctx.cwd, file) || path.resolve(ctx.cwd) === path.resolve(ctx.home)) return;
  const real = realTarget(file);
  if (!inside(realTarget(ctx.cwd), real)) throw new ConfigError(`${show(file, ctx)} links outside the project (to ${real}); nothing was written. Remove the link or run init in a project you trust`);
}

/**
 * The backup next to a file, never written through a link or onto a file another name shares:
 * a repo that ships `.claude/settings.json.pinright.bak` as a link to ~/.bashrc would otherwise
 * get its settings.json (comments and all) written there.
 */
function writeBackup(bak: string, content: string): void {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(bak);
  } catch {
    st = undefined;
  }
  if (st?.isDirectory()) throw new ConfigError(`${bak} is a directory; move it away, nothing was written`);
  if (st) fs.rmSync(bak, { force: true }); // the link or old backup itself, never what it points to
  fs.writeFileSync(bak, content, { flag: 'wx' });
}

/** Runs the writes of one file in order (Gemini CLI keeps the server and the hook in the same file). */
function apply(writes: FileWrite[], ctx: Ctx, o: InitOptions, out: InitResult): void {
  const byFile = new Map<string, FileWrite[]>();
  for (const w of writes) byFile.set(w.file, [...(byFile.get(w.file) ?? []), w]);
  for (const [file, ws] of byFile) {
    checkProjectPath(file, ctx);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    let after = before;
    for (const w of ws) after = w.update(after);
    const what = [...new Set(ws.map((w) => w.what))].join(' + ');
    replaceLegacyFile(file, ctx, o, out);
    if (before !== undefined && hasLegacyEntry(before) && !hasLegacyEntry(after ?? '')) {
      out.lines.push(`${o.print ? 'would replace' : 'replaced'} the entries written under the old name ${OLD_NAME} in ${show(file, ctx)}`);
    }
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
      writeBackup(bak, before);
      out.lines.push(`backup ${show(bak, ctx)}`);
    }
    fs.writeFileSync(file, after ?? '');
    out.lines.push(`wrote ${show(file, ctx)} (${what})`);
  }
}

function teamConfig(ctx: Ctx, o: InitOptions, out: InitResult): void {
  // The team policy starter, never over an existing one: that file belongs to the team.
  const file = path.join(ctx.cwd, CONFIG_FILE);
  // lstat: a dangling link counts as present, so the starter is never written through it.
  let present = true;
  try {
    fs.lstatSync(file);
  } catch {
    present = false;
  }
  if (present) {
    out.lines.push(`kept ${CONFIG_FILE} (already present)`);
    return;
  }
  out.files.push(file);
  if (o.print) out.lines.push(`--- ${CONFIG_FILE} (team policy starter, would create)`, STARTER_CONFIG.trimEnd(), '');
  else {
    fs.writeFileSync(file, STARTER_CONFIG, { flag: 'wx' });
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
  // Without --user, a client that only has user files (Windsurf) still changes them: say so before the paths.
  out.lines.push(
    scope === 'user' && !o.scope
      ? `${client.title}: user scope, since ${client.title} has no project MCP file. These files apply to every project; no .pinright.json is written here.`
      : `${client.title}:`,
  );
  apply(writes, ctx, o, out);
  if (writes.length && o.launchFor) {
    const { launch, why } = o.launchFor(scope);
    out.lines.push(`launcher: ${[launch.command, ...launch.args].join(' ')} (${why})`);
  }
  out.lines.push(...notes);
  if (writes.length) out.lines.push(...(client.after?.(scope) ?? []));
}

export const INIT_USAGE = `usage: ${PKG_NAME} init [client] [--project | --user] [--print] [--no-hook] [--no-mcp] [--no-config] [--gh-cli] [--bin | --npx]\nclients: ${CLIENTS.map((c) => c.id).join(', ')}`;

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
        // The same way this init was started: "pinright init" when the agent launches the global binary.
        const runner = (o.launchFor?.('user').launch ?? o.launch).command === PKG_NAME ? PKG_NAME : `npx -y ${PKG_NAME}`;
        for (const c of others) out.lines.push(`  ${c.title}: ${runner} init ${c.id}${c.mcpScopes[0] === 'user' ? '' : ' --user'}`);
      }
    }
    if (o.print) out.lines.push('(--print: nothing was written)');
    return out;
  } catch (err) {
    if (err instanceof ConfigError) return { code: 1, lines: [...out.lines, `error: ${err.message}`], files: out.files };
    throw err;
  }
}
