/* eslint-disable @typescript-eslint/no-explicit-any -- reading back the JSON init wrote */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jsonc from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit, type InitOptions } from '../src/clients/init.js';
import { CLIENTS, type Ctx, findClient } from '../src/clients/registry.js';
import { setTomlTable, tomlEnv } from '../src/clients/edit.js';

let root: string;
let ctx: Ctx;

const opts = (o: Partial<InitOptions> = {}): InitOptions => ({
  mcp: true,
  hook: true,
  config: false,
  print: false,
  launch: { command: 'npx', args: ['-y', 'pinright'] },
  ghCli: false,
  ...o,
});
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');
const readJson = (...p: string[]): any => jsonc.parse(read(...p));
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
/** Every file under a directory, relative, sorted: what init touched. */
const tree = (dir: string): string[] =>
  fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[]).filter((d) => d.isFile()).map((d) => path.relative(dir, path.join(d.parentPath, d.name)).replace(/\\/g, '/')).sort() : [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pinright-init-'));
  fs.mkdirSync(path.join(root, 'proj'));
  fs.mkdirSync(path.join(root, 'home'));
  ctx = { cwd: path.join(root, 'proj'), home: path.join(root, 'home'), platform: 'linux', env: {} };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('init: where each client keeps its config', () => {
  // Project scope: the files a team commits. Paths are relative to the project.
  const project: Record<string, string[]> = {
    claude: ['.claude/settings.json', '.mcp.json'],
    cursor: ['.cursor/hooks.json', '.cursor/mcp.json'],
    vscode: ['.github/hooks/pinright.json', '.vscode/mcp.json'],
    zed: ['.zed/settings.json'],
    junie: ['.junie/mcp/mcp.json'],
    codex: ['.codex/config.toml', '.codex/hooks.json'],
    gemini: ['.gemini/settings.json'],
    roo: ['.roo/mcp.json'],
    continue: ['.continue/mcpServers/pinright.yaml'],
    amp: ['.amp/settings.json'],
    opencode: ['opencode.json'],
    kiro: ['.kiro/settings/mcp.json'],
  };
  for (const [id, files] of Object.entries(project)) {
    it(`${id}: project files`, () => {
      const r = runInit(ctx, opts({ client: id, scope: 'project' }));
      expect(r.code).toBe(0);
      expect(tree(ctx.cwd)).toEqual(files);
      expect(tree(ctx.home)).toEqual([]);
    });
  }

  // User scope on Linux (XDG), relative to home.
  const user: Record<string, string[]> = {
    claude: ['.claude.json', '.claude/settings.json'],
    'claude-desktop': ['.config/Claude/claude_desktop_config.json'],
    cursor: ['.cursor/hooks.json', '.cursor/mcp.json'],
    vscode: ['.config/Code/User/mcp.json', '.copilot/hooks/pinright.json'],
    windsurf: ['.codeium/windsurf/hooks.json', '.config/devin/mcp_config.json'],
    zed: ['.config/zed/settings.json'],
    junie: ['.junie/mcp/mcp.json'],
    codex: ['.codex/config.toml', '.codex/hooks.json'],
    gemini: ['.gemini/settings.json'],
    cline: ['.cline/data/settings/cline_mcp_settings.json'],
    amp: ['.config/amp/settings.json'],
    opencode: ['.config/opencode/opencode.json'],
    kiro: ['.kiro/settings/mcp.json'],
  };
  for (const [id, files] of Object.entries(user)) {
    it(`${id}: user files`, () => {
      const r = runInit(ctx, opts({ client: id, scope: 'user' }));
      expect(r.code).toBe(0);
      expect(tree(ctx.home)).toEqual(files);
      expect(tree(ctx.cwd)).toEqual([]);
    });
  }

  it('per-OS app directories: %APPDATA% on Windows, Application Support on macOS', () => {
    const win = { ...ctx, platform: 'win32' as const, env: { APPDATA: path.join(ctx.home, 'AppData', 'Roaming') } };
    for (const id of ['claude-desktop', 'vscode', 'windsurf', 'zed']) runInit(win, opts({ client: id, scope: 'user', hook: false }));
    expect(tree(ctx.home)).toEqual(['AppData/Roaming/Claude/claude_desktop_config.json', 'AppData/Roaming/Code/User/mcp.json', 'AppData/Roaming/Zed/settings.json', 'AppData/Roaming/devin/mcp_config.json']);
    fs.rmSync(path.join(ctx.home, 'AppData'), { recursive: true });
    const mac = { ...ctx, platform: 'darwin' as const };
    for (const id of ['claude-desktop', 'vscode']) runInit(mac, opts({ client: id, scope: 'user', hook: false }));
    expect(tree(ctx.home)).toEqual(['Library/Application Support/Claude/claude_desktop_config.json', 'Library/Application Support/Code/User/mcp.json']);
  });

  it('XDG_CONFIG_HOME moves the Linux files; COPILOT_HOME moves the Copilot hooks', () => {
    const xdg = { ...ctx, env: { XDG_CONFIG_HOME: path.join(ctx.home, 'xdg'), COPILOT_HOME: path.join(ctx.home, 'cop') } };
    runInit(xdg, opts({ client: 'vscode', scope: 'user' }));
    expect(tree(ctx.home)).toEqual(['cop/hooks/pinright.json', 'xdg/Code/User/mcp.json']);
  });

  it('Windsurf keeps writing the legacy file when only that one exists', () => {
    write(path.join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json'), '{"mcpServers":{}}');
    runInit(ctx, opts({ client: 'windsurf', hook: false }));
    expect(readJson(ctx.home, '.codeium', 'windsurf', 'mcp_config.json').mcpServers.pinright.command).toBe('npx');
    expect(fs.existsSync(path.join(ctx.home, '.config', 'devin'))).toBe(false);
  });

  it('opencode and Amp: an existing .jsonc is the file to edit', () => {
    write(path.join(ctx.cwd, 'opencode.jsonc'), '{\n  // keep\n}\n');
    runInit(ctx, opts({ client: 'opencode' }));
    expect(read(ctx.cwd, 'opencode.jsonc')).toContain('// keep');
    expect(fs.existsSync(path.join(ctx.cwd, 'opencode.json'))).toBe(false);
  });

  it('a client without a file at the scope says so and writes nothing there', () => {
    const r = runInit(ctx, opts({ client: 'claude-desktop', scope: 'project' }));
    expect(r.lines.join('\n')).toContain('Claude Desktop has no project-level MCP file; use --user.');
    expect(tree(ctx.cwd)).toEqual([]);
  });

  it('JetBrains AI Assistant has no file: init prints what to paste', () => {
    const r = runInit(ctx, opts({ client: 'jetbrains' }));
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toContain('Model Context Protocol (MCP)');
    expect(JSON.parse(r.lines[r.lines.length - 1]).mcpServers.pinright.args).toEqual(['-y', 'pinright']);
    expect(tree(root)).toEqual([]);
  });

  it('unknown client: exit 2 with the list', () => {
    const r = runInit(ctx, opts({ client: 'notepad' }));
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toContain('clients: claude, claude-desktop, cursor');
  });

  it('aliases', () => {
    expect(findClient('copilot')?.id).toBe('vscode');
    expect(findClient('Claude-Code')?.id).toBe('claude');
    expect(findClient('gemini-cli')?.id).toBe('gemini');
  });
});

describe('init: the entries', () => {
  it('each client gets its own entry shape', () => {
    for (const id of ['claude', 'vscode', 'zed', 'opencode', 'amp', 'codex', 'continue']) runInit(ctx, opts({ client: id, scope: 'project', hook: false }));
    expect(readJson(ctx.cwd, '.mcp.json').mcpServers.pinright).toEqual({ command: 'npx', args: ['-y', 'pinright'] });
    expect(readJson(ctx.cwd, '.vscode', 'mcp.json').servers.pinright).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'pinright'] });
    expect(readJson(ctx.cwd, '.zed', 'settings.json').context_servers.pinright).toEqual({ command: 'npx', args: ['-y', 'pinright'] });
    expect(readJson(ctx.cwd, 'opencode.json').mcp.pinright).toEqual({ type: 'local', command: ['npx', '-y', 'pinright'], enabled: true });
    expect(readJson(ctx.cwd, '.amp', 'settings.json')['amp.mcpServers'].pinright).toEqual({ command: 'npx', args: ['-y', 'pinright'] });
    expect(read(ctx.cwd, '.codex', 'config.toml')).toBe('[mcp_servers.pinright]\ncommand = "npx"\nargs = ["-y", "pinright"]\n');
    expect(read(ctx.cwd, '.continue', 'mcpServers', 'pinright.yaml')).toContain('    command: "npx"\n    args: ["-y", "pinright"]\n');
  });

  it('the hooks: each agent its events, and the command names the agent', () => {
    for (const id of ['claude', 'cursor', 'vscode', 'codex', 'gemini']) runInit(ctx, opts({ client: id, mcp: false }));
    runInit(ctx, opts({ client: 'windsurf', scope: 'project', mcp: false }));
    expect(readJson(ctx.cwd, '.claude', 'settings.json').hooks.PreToolUse).toEqual([
      { matcher: 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'npx -y pinright hook claude', timeout: 60 }] },
    ]);
    const cursor = readJson(ctx.cwd, '.cursor', 'hooks.json');
    expect(cursor.version).toBe(1);
    expect(cursor.hooks.beforeShellExecution).toEqual([{ command: 'npx -y pinright hook cursor', timeout: 60 }]);
    expect(cursor.hooks.preToolUse).toEqual(cursor.hooks.beforeShellExecution);
    expect(readJson(ctx.cwd, '.github', 'hooks', 'pinright.json')).toEqual({ version: 1, hooks: { PreToolUse: [{ type: 'command', command: 'npx -y pinright hook copilot', timeoutSec: 60 }] } });
    expect(readJson(ctx.cwd, '.codex', 'hooks.json').hooks.PreToolUse[0]).toMatchObject({ matcher: 'Bash|apply_patch', hooks: [{ command: 'npx -y pinright hook codex', timeout: 60 }] });
    expect(readJson(ctx.cwd, '.gemini', 'settings.json').hooks.BeforeTool[0]).toMatchObject({
      matcher: 'run_shell_command|write_file|replace',
      hooks: [{ name: 'pinright', type: 'command', command: 'npx -y pinright hook gemini', timeout: 60000 }],
    });
    const ws = readJson(ctx.cwd, '.devin', 'hooks.json').hooks;
    expect(ws.pre_run_command).toEqual([{ command: 'npx -y pinright hook windsurf', show_output: false }]);
    expect(ws.pre_write_code).toEqual(ws.pre_run_command);
  });

  it('a launcher path with spaces is quoted in hook commands', () => {
    runInit(ctx, opts({ client: 'claude', mcp: false, launch: { command: 'node', args: ['C:\\My Tools\\pinright\\dist\\cli.js'] } }));
    expect(readJson(ctx.cwd, '.claude', 'settings.json').hooks.PreToolUse[0].hooks[0].command).toBe('node "C:\\My Tools\\pinright\\dist\\cli.js" hook claude');
  });

  it('no token is ever written; --gh-cli adds PINRIGHT_GH_CLI and an existing token stays, with a warning', () => {
    runInit(ctx, opts({ client: 'cursor', hook: false, ghCli: true }));
    expect(readJson(ctx.cwd, '.cursor', 'mcp.json').mcpServers.pinright.env).toEqual({ PINRIGHT_GH_CLI: '1' });
    write(path.join(ctx.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { pinright: { command: 'old', env: { GITHUB_TOKEN: 'x', PINRIGHT_GH_CLI: '1' } } } }));
    const r = runInit(ctx, opts({ client: 'claude', hook: false }));
    expect(readJson(ctx.cwd, '.mcp.json').mcpServers.pinright).toEqual({ command: 'npx', args: ['-y', 'pinright'], env: { GITHUB_TOKEN: 'x' } });
    expect(r.lines.join('\n')).toContain('warning: GITHUB_TOKEN is set in this MCP entry');
    for (const id of CLIENTS.map((c) => c.id)) runInit(ctx, opts({ client: id, scope: 'user', ghCli: true }));
    for (const f of tree(ctx.home)) expect(read(ctx.home, f)).not.toMatch(/TOKEN|token"/);
  });
});

describe('init: merging into existing files', () => {
  it('keeps other servers, other hooks, comments and indentation', () => {
    const settings = '{\n\t// my hooks\n\t"hooks": {\n\t\t"PreToolUse": [\n\t\t\t{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "lint.sh" }] }\n\t\t]\n\t},\n\t"model": "opus"\n}\n';
    write(path.join(ctx.cwd, '.claude', 'settings.json'), settings);
    write(path.join(ctx.cwd, '.mcp.json'), '{\n    "mcpServers": {\n        "github": { "command": "gh-mcp" }\n    }\n}\n');
    runInit(ctx, opts({ client: 'claude' }));
    const s = read(ctx.cwd, '.claude', 'settings.json');
    expect(s).toContain('// my hooks');
    expect(s).toContain('\t"model": "opus"');
    const parsed = jsonc.parse(s);
    expect(parsed.hooks.PreToolUse.map((h: any) => h.hooks[0].command)).toEqual(['lint.sh', 'npx -y pinright hook claude']);
    const mcp = read(ctx.cwd, '.mcp.json');
    expect(mcp).toContain('\n        "pinright": {');
    expect(JSON.parse(mcp).mcpServers.github).toEqual({ command: 'gh-mcp' });
  });

  it('runs twice without a change and without a backup the second time', () => {
    runInit(ctx, opts({ client: 'gemini' }));
    const first = read(ctx.cwd, '.gemini', 'settings.json');
    const r = runInit(ctx, opts({ client: 'gemini' }));
    expect(read(ctx.cwd, '.gemini', 'settings.json')).toBe(first);
    expect(r.lines.join('\n')).toContain('unchanged .gemini');
    expect(r.files).toEqual([]);
    expect(tree(ctx.cwd)).toEqual(['.gemini/settings.json']);
  });

  it('replaces our old entry instead of adding a second one, and backs up the file it changes', () => {
    const old = JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'other' }, { command: 'npx -y pinright hook cursor', timeout: 5 }] } }, null, 2);
    write(path.join(ctx.cwd, '.cursor', 'hooks.json'), old);
    const r = runInit(ctx, opts({ client: 'cursor', mcp: false }));
    expect(readJson(ctx.cwd, '.cursor', 'hooks.json').hooks.preToolUse).toEqual([{ command: 'other' }, { command: 'npx -y pinright hook cursor', timeout: 60 }]);
    expect(read(ctx.cwd, '.cursor', 'hooks.json.pinright.bak')).toBe(old);
    expect(r.lines).toContain(`backup ${path.join('.cursor', 'hooks.json.pinright.bak')}`);
  });

  it('a file that does not parse stops init before it writes anything', () => {
    write(path.join(ctx.cwd, '.claude', 'settings.json'), '{ "hooks": ');
    const r = runInit(ctx, opts({ client: 'claude' }));
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toMatch(/settings\.json does not parse .*nothing was written/);
    expect(tree(ctx.cwd)).toEqual(['.claude/settings.json']);
    expect(read(ctx.cwd, '.claude', 'settings.json')).toBe('{ "hooks": ');
  });

  it('--print shows the result and writes nothing', () => {
    write(path.join(ctx.cwd, '.vscode', 'mcp.json'), '{ "servers": {} }');
    const r = runInit(ctx, opts({ client: 'vscode', print: true, config: true }));
    expect(r.code).toBe(0);
    const out = r.lines.join('\n');
    expect(out).toContain(`--- ${path.join('.vscode', 'mcp.json')} (MCP server, would update)`);
    expect(out).toContain('"type": "stdio"');
    expect(out).toContain(`--- ${path.join('.github', 'hooks', 'pinright.json')} (hook, would create)`);
    expect(out).toContain('--- .pinright.json (team policy starter, would create)');
    expect(out).toContain('(--print: nothing was written)');
    expect(tree(ctx.cwd)).toEqual(['.vscode/mcp.json']);
  });

  it('Codex TOML: other tables and comments stay, our table is replaced in place, env is kept', () => {
    const toml = '# my codex\nmodel = "gpt-5"\n\n[mcp_servers.pinright]\ncommand = "old"\n\n[mcp_servers.pinright.env]\nPINRIGHT_COOLDOWN_DAYS = "5"\n\n[mcp_servers.github]\ncommand = "gh"  # keep\n';
    write(path.join(ctx.home, '.codex', 'config.toml'), toml);
    runInit(ctx, opts({ client: 'codex', scope: 'user', hook: false, ghCli: true }));
    expect(read(ctx.home, '.codex', 'config.toml')).toBe(
      '# my codex\nmodel = "gpt-5"\n\n[mcp_servers.pinright]\ncommand = "npx"\nargs = ["-y", "pinright"]\n\n[mcp_servers.pinright.env]\nPINRIGHT_COOLDOWN_DAYS = "5"\nPINRIGHT_GH_CLI = "1"\n\n[mcp_servers.github]\ncommand = "gh"  # keep\n',
    );
  });
});

describe('init: TOML helpers', () => {
  it('appends to a file without the table and keeps CRLF', () => {
    expect(setTomlTable('a = 1\r\n', ['mcp_servers', 'x'], { command: 'c' })).toBe('a = 1\r\n\r\n[mcp_servers.x]\r\ncommand = "c"\r\n');
  });
  it('refuses an inline table it would duplicate', () => {
    expect(() => setTomlTable('[mcp_servers]\npinright = { command = "x" }\n', ['mcp_servers', 'pinright'], { command: 'c' })).toThrow(/inline/);
  });
  it('reads the env of a table', () => {
    expect(tomlEnv('[mcp_servers.s.env]\nA = "1"\n"B" = "x\\"y"\n[other]\nC = "2"\n', ['mcp_servers', 's'])).toEqual({ A: '1', B: 'x"y' });
  });
});

describe('init with no client', () => {
  it('sets up the clients this project uses, and only lists the ones installed for the user', () => {
    fs.mkdirSync(path.join(ctx.cwd, '.cursor'));
    fs.mkdirSync(path.join(ctx.cwd, '.vscode'));
    fs.mkdirSync(path.join(ctx.home, '.codex'));
    fs.mkdirSync(path.join(ctx.home, '.config', 'Claude'), { recursive: true });
    const r = runInit(ctx, opts({ config: true }));
    expect(r.code).toBe(0);
    expect(tree(ctx.cwd)).toEqual(['.cursor/hooks.json', '.cursor/mcp.json', '.github/hooks/pinright.json', '.pinright.json', '.vscode/mcp.json']);
    expect(tree(ctx.home)).toEqual([]);
    const out = r.lines.join('\n');
    expect(out).toContain('Found in this project: Cursor, VS Code (GitHub Copilot).');
    expect(out).toContain('Also installed for this user (not changed):');
    expect(out).toContain('Claude Desktop: npx -y pinright init claude-desktop');
    expect(out).toContain('OpenAI Codex: npx -y pinright init codex --user');
  });

  it('falls back to Claude Code in a project with no client config, as before', () => {
    const r = runInit(ctx, opts({ config: true }));
    expect(r.lines[0]).toContain('No client config found in this project; setting up Claude Code.');
    expect(tree(ctx.cwd)).toEqual(['.claude/settings.json', '.mcp.json', '.pinright.json']);
  });

  it('never overwrites the team policy', () => {
    write(path.join(ctx.cwd, '.pinright.json'), '{"allow":["x"]}');
    const r = runInit(ctx, opts({ client: 'claude', config: true }));
    expect(r.lines).toContain('kept .pinright.json (already present)');
    expect(read(ctx.cwd, '.pinright.json')).toBe('{"allow":["x"]}');
  });
});
