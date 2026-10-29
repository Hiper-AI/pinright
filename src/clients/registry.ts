/* eslint-disable @typescript-eslint/no-explicit-any -- client config files are untyped JSON, read defensively */
/**
 * Where each agent client keeps its MCP servers and its pre-tool hooks, and the
 * shape of our entry in each. Every path and shape here comes from the client's
 * own docs (URL in `docs`); a client whose user-level file is not documented
 * only gets the project file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PKG_NAME, SERVER_KEY } from '../pkg.js';
import type { HookAgent } from '../hook/run.js';
import { getAt, parseJsonc, setJsonc, setTomlTable, tomlEnv } from './edit.js';

export type Scope = 'project' | 'user';

/** Where init looks: the project directory, the home directory, the OS and its environment. */
export interface Ctx {
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

export interface Launch {
  command: string;
  args: string[];
}

/** One file to write: given its current text (undefined when missing), the new text. */
export interface FileWrite {
  file: string;
  what: string;
  update(current: string | undefined): string;
}

/** What an MCP entry is built from: the launcher and the env of the entry it replaces (see mcpEntryEnv). */
export type EnvFor = (previous: Record<string, string> | undefined) => Record<string, string> | undefined;

export interface Client {
  id: string;
  title: string;
  /** Official docs for the MCP config and, when wired, the hook. */
  docs: string[];
  /** Scopes with an MCP config file, the default first. Empty: configured in the app's UI only. */
  mcpScopes: Scope[];
  mcp?(scope: Scope, ctx: Ctx, launch: Launch, env: EnvFor): FileWrite[];
  hook?: { agent: HookAgent; scopes: Scope[]; write(scope: Scope, ctx: Ctx, command: string): FileWrite };
  /** The client is installed for this user (its user-level directory exists). */
  installed(ctx: Ctx): boolean;
  /** This project already has the client's directory or config. */
  inProject(ctx: Ctx): boolean;
  /** Printed after a write: what the user still has to do in the client. */
  after?: (scope: Scope) => string[];
  /** For clients without a file: how to add the server by hand. */
  manual?: (launch: Launch) => string[];
}

// ------------------------------------------------------------------ paths ---

const exists = (p: string) => fs.existsSync(p);

/** %APPDATA% on Windows, ~/Library/Application Support on macOS, $XDG_CONFIG_HOME or ~/.config elsewhere. */
export function appConfigDir(ctx: Ctx): string {
  if (ctx.platform === 'win32') return ctx.env.APPDATA || path.join(ctx.home, 'AppData', 'Roaming');
  if (ctx.platform === 'darwin') return path.join(ctx.home, 'Library', 'Application Support');
  return xdgConfig(ctx);
}

export function xdgConfig(ctx: Ctx): string {
  return ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, '.config');
}

/** VS Code's user directory (settings.json, mcp.json, globalStorage). */
export function vscodeUserDir(ctx: Ctx): string {
  return path.join(appConfigDir(ctx), 'Code', 'User');
}

/** Picks the existing `.jsonc` sibling over `.json` when the user has one. */
function jsonOrJsonc(file: string): string {
  const alt = file.replace(/\.json$/, '.jsonc');
  return !exists(file) && exists(alt) ? alt : file;
}

// ----------------------------------------------------------------- entries ---

/** `<keyPath>.<server>` = entry in a JSON/JSONC file; `shape` builds the entry from the previous one. */
function jsonServer(file: string, keyPath: string[], what: string, shape: (prev: any) => unknown): FileWrite {
  return {
    file,
    what,
    update(current) {
      const doc = parseJsonc(current ?? '', file);
      const at = [...keyPath, SERVER_KEY];
      return setJsonc(current, file, at, shape(getAt(doc, at)));
    },
  };
}

const stdio = (launch: Launch, env: EnvFor) => (prev: any) => {
  const e = env(prev?.env);
  return { command: launch.command, args: launch.args, ...(e ? { env: e } : {}) };
};

const mcpServers = (file: string, launch: Launch, env: EnvFor, keyPath = ['mcpServers']) =>
  jsonServer(file, keyPath, 'MCP server', stdio(launch, env));

/** Our hook entries carry the package name in their command; anything else in the list is someone else's. */
const notOurs = (list: unknown) => (Array.isArray(list) ? list : []).filter((h) => !JSON.stringify(h).includes(PKG_NAME));

/** Replaces our entry in each `hooks.<event>` list of a JSON file, keeping the other hooks. */
function hookLists(file: string, events: Record<string, unknown>, extra: Record<string, unknown> = {}): FileWrite {
  return {
    file,
    what: 'hook',
    update(current) {
      const doc = parseJsonc(current ?? '', file);
      let text = current;
      for (const [k, v] of Object.entries(extra)) if (doc[k] === undefined) text = setJsonc(text, file, [k], v);
      for (const [event, entry] of Object.entries(events)) {
        text = setJsonc(text, file, ['hooks', event], [...notOurs(getAt(doc, ['hooks', event])), entry]);
      }
      return text ?? '';
    },
  };
}

// ---------------------------------------------------------------- clients ---

const at = (ctx: Ctx, ...p: string[]) => path.join(ctx.cwd, ...p);
const home = (ctx: Ctx, ...p: string[]) => path.join(ctx.home, ...p);
const json = (launch: Launch) => JSON.stringify({ mcpServers: { [SERVER_KEY]: { command: launch.command, args: launch.args } } }, null, 2);

export const CLIENTS: Client[] = [
  {
    id: 'claude',
    title: 'Claude Code',
    docs: ['https://code.claude.com/docs/en/mcp', 'https://code.claude.com/docs/en/hooks'],
    mcpScopes: ['project', 'user'],
    mcp: (scope, ctx, launch, env) => [mcpServers(scope === 'project' ? at(ctx, '.mcp.json') : home(ctx, '.claude.json'), launch, env)],
    hook: {
      agent: 'claude',
      scopes: ['project', 'user'],
      write: (scope, ctx, command) =>
        hookLists(scope === 'project' ? at(ctx, '.claude', 'settings.json') : home(ctx, '.claude', 'settings.json'), {
          PreToolUse: { matcher: 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command, timeout: 60 }] },
        }),
    },
    installed: (ctx) => exists(home(ctx, '.claude')) || exists(home(ctx, '.claude.json')),
    inProject: (ctx) => exists(at(ctx, '.mcp.json')) || exists(at(ctx, '.claude')),
    after: (scope) => (scope === 'project' ? ['Claude Code asks once to approve the servers in .mcp.json.'] : []),
  },
  {
    id: 'claude-desktop',
    title: 'Claude Desktop',
    docs: ['https://modelcontextprotocol.io/docs/develop/connect-local-servers'],
    mcpScopes: ['user'],
    mcp: (_scope, ctx, launch, env) => [mcpServers(path.join(appConfigDir(ctx), 'Claude', 'claude_desktop_config.json'), launch, env)],
    installed: (ctx) => exists(path.join(appConfigDir(ctx), 'Claude')),
    inProject: () => false,
    after: () => ['Quit Claude Desktop completely and open it again to load the server. Claude Desktop has no hooks; the .mcpb extension is the other way to install it.'],
  },
  {
    id: 'cursor',
    title: 'Cursor',
    docs: ['https://cursor.com/docs/context/mcp', 'https://cursor.com/docs/agent/hooks'],
    mcpScopes: ['project', 'user'],
    mcp: (scope, ctx, launch, env) => [mcpServers(scope === 'project' ? at(ctx, '.cursor', 'mcp.json') : home(ctx, '.cursor', 'mcp.json'), launch, env)],
    hook: {
      agent: 'cursor',
      scopes: ['project', 'user'],
      write: (scope, ctx, command) => {
        const cmd = { command, timeout: 60 };
        return hookLists(scope === 'project' ? at(ctx, '.cursor', 'hooks.json') : home(ctx, '.cursor', 'hooks.json'), { beforeShellExecution: cmd, preToolUse: cmd }, { version: 1 });
      },
    },
    installed: (ctx) => exists(home(ctx, '.cursor')),
    inProject: (ctx) => exists(at(ctx, '.cursor')),
  },
  {
    id: 'vscode',
    title: 'VS Code (GitHub Copilot)',
    docs: [
      'https://code.visualstudio.com/docs/agents/reference/mcp-configuration',
      'https://code.visualstudio.com/docs/agent-customization/hooks',
      'https://code.visualstudio.com/docs/agents/reference/hooks-reference',
    ],
    mcpScopes: ['project', 'user'],
    mcp: (scope, ctx, launch, env) => [
      jsonServer(scope === 'project' ? at(ctx, '.vscode', 'mcp.json') : path.join(vscodeUserDir(ctx), 'mcp.json'), ['servers'], 'MCP server', (prev) => {
        const e = env(prev?.env);
        return { type: 'stdio', command: launch.command, args: launch.args, ...(e ? { env: e } : {}) };
      }),
    ],
    hook: {
      agent: 'copilot',
      scopes: ['project', 'user'],
      write: (scope, ctx, command) =>
        hookLists(
          scope === 'project' ? at(ctx, '.github', 'hooks', `${SERVER_KEY}.json`) : path.join(ctx.env.COPILOT_HOME || home(ctx, '.copilot'), 'hooks', `${SERVER_KEY}.json`),
          { PreToolUse: { type: 'command', command, timeoutSec: 60 } },
          { version: 1 },
        ),
    },
    installed: (ctx) => exists(vscodeUserDir(ctx)),
    inProject: (ctx) => exists(at(ctx, '.vscode')),
    after: () => ['Hooks are a preview in VS Code: the Copilot agent reads .github/hooks; for local agent sessions turn on chat.useHooks.'],
  },
  {
    id: 'windsurf',
    title: 'Windsurf (Devin Desktop)',
    docs: ['https://docs.devin.ai/desktop/cascade/mcp', 'https://docs.devin.ai/desktop/cascade/hooks'],
    mcpScopes: ['user'],
    mcp: (_scope, ctx, launch, env) => {
      const current = ctx.platform === 'win32' ? path.join(appConfigDir(ctx), 'devin', 'mcp_config.json') : path.join(xdgConfig(ctx), 'devin', 'mcp_config.json');
      const legacy = home(ctx, '.codeium', 'windsurf', 'mcp_config.json');
      // Windsurf builds from before the Devin Desktop rename still read the old file.
      return [mcpServers(!exists(current) && exists(legacy) ? legacy : current, launch, env)];
    },
    hook: {
      agent: 'windsurf',
      scopes: ['project', 'user'],
      write: (scope, ctx, command) => {
        const cmd = { command, show_output: false };
        return hookLists(scope === 'project' ? at(ctx, '.devin', 'hooks.json') : home(ctx, '.codeium', 'windsurf', 'hooks.json'), { pre_run_command: cmd, pre_write_code: cmd });
      },
    },
    installed: (ctx) => exists(home(ctx, '.codeium', 'windsurf')) || exists(path.join(ctx.platform === 'win32' ? appConfigDir(ctx) : xdgConfig(ctx), 'devin')),
    inProject: (ctx) => exists(at(ctx, '.devin')) || exists(at(ctx, '.windsurf')),
    after: () => ['Refresh the MCP servers in Cascade (or restart the editor) to load the server.'],
  },
  {
    id: 'zed',
    title: 'Zed',
    docs: ['https://zed.dev/docs/ai/mcp'],
    mcpScopes: ['project', 'user'],
    mcp: (scope, ctx, launch, env) => {
      const user = ctx.platform === 'win32' ? path.join(appConfigDir(ctx), 'Zed', 'settings.json') : path.join(xdgConfig(ctx), 'zed', 'settings.json');
      return [jsonServer(scope === 'project' ? at(ctx, '.zed', 'settings.json') : user, ['context_servers'], 'context server', stdio(launch, env))];
    },
    installed: (ctx) => exists(ctx.platform === 'win32' ? path.join(appConfigDir(ctx), 'Zed') : path.join(xdgConfig(ctx), 'zed')),
    inProject: (ctx) => exists(at(ctx, '.zed')),
  },
  {
    id: 'junie',
    title: 'JetBrains Junie',
    docs: ['https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html'],
    mcpScopes: ['project', 'user'],
    mcp: (scope, ctx, launch, env) => [mcpServers(scope === 'project' ? at(ctx, '.junie', 'mcp', 'mcp.json') : home(ctx, '.junie', 'mcp', 'mcp.json'), launch, env)],
    installed: (ctx) => exists(home(ctx, '.junie')),
    inProject: (ctx) => exists(at(ctx, '.junie')),
  },
  {
    id: 'jetbrains',
    title: 'JetBrains AI Assistant',
    docs: ['https://www.jetbrains.com/help/ai-assistant/mcp.html'],
    mcpScopes: [],
    installed: () => false,
    inProject: () => false,
    manual: (launch) => ['AI Assistant keeps its MCP servers in the IDE settings, not in a file safectx can edit.', 'Settings | Tools | AI Assistant | Model Context Protocol (MCP) > Add > STDIO, and paste:', json(launch)],
  },
  {
    id: 'codex',
    title: 'OpenAI Codex',
    docs: ['https://learn.chatgpt.com/docs/extend/mcp?surface=cli', 'https://learn.chatgpt.com/docs/hooks'],
    mcpScopes: ['project', 'user'],
    mcp: (scope, ctx, launch, env) => {
      const file = scope === 'project' ? at(ctx, '.codex', 'config.toml') : home(ctx, '.codex', 'config.toml');
      const name = ['mcp_servers', SERVER_KEY];
      return [
        {
          file,
          what: 'MCP server',
          update: (current) => {
            const e = env(tomlEnv(current, name));
            return setTomlTable(current, name, { command: launch.command, args: launch.args, ...(e ? { env: e } : {}) });
          },
        },
      ];
    },
    hook: {
      agent: 'codex',
      scopes: ['project', 'user'],
      write: (scope, ctx, command) =>
        hookLists(scope === 'project' ? at(ctx, '.codex', 'hooks.json') : home(ctx, '.codex', 'hooks.json'), {
          PreToolUse: { matcher: 'Bash|apply_patch', hooks: [{ type: 'command', command, timeout: 60, statusMessage: `${SERVER_KEY}: checking dependencies` }] },
        }),
    },
    installed: (ctx) => exists(home(ctx, '.codex')),
    inProject: (ctx) => exists(at(ctx, '.codex')),
    after: (scope) => [
      ...(scope === 'project' ? ['Codex reads .codex/ only in a trusted project.'] : []),
      'Codex runs a new hook only after you review and trust it: open /hooks in Codex.',
    ],
  },
  {
    id: 'gemini',
    title: 'Gemini CLI',
    docs: ['https://geminicli.com/docs/tools/mcp-server/', 'https://geminicli.com/docs/hooks/', 'https://geminicli.com/docs/hooks/reference/'],
    mcpScopes: ['project', 'user'],
    mcp: (scope, ctx, launch, env) => [mcpServers(scope === 'project' ? at(ctx, '.gemini', 'settings.json') : home(ctx, '.gemini', 'settings.json'), launch, env)],
    hook: {
      agent: 'gemini',
      scopes: ['project', 'user'],
      write: (scope, ctx, command) =>
        hookLists(scope === 'project' ? at(ctx, '.gemini', 'settings.json') : home(ctx, '.gemini', 'settings.json'), {
          BeforeTool: { matcher: 'run_shell_command|write_file|replace', hooks: [{ name: SERVER_KEY, type: 'command', command, timeout: 60_000 }] },
        }),
    },
    installed: (ctx) => exists(home(ctx, '.gemini')),
    inProject: (ctx) => exists(at(ctx, '.gemini')),
    after: (scope) => (scope === 'project' ? ['Gemini CLI asks before it runs a project hook it has not seen.'] : []),
  },
  {
    id: 'cline',
    title: 'Cline',
    docs: ['https://docs.cline.bot/mcp/configuring-mcp-servers'],
    mcpScopes: ['user'],
    mcp: (_scope, ctx, launch, env) => {
      // The VS Code extension and the CLI keep separate files; write the ones that exist (the CLI's when neither does).
      const ext = path.join(vscodeUserDir(ctx), 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
      const cli = ctx.env.CLINE_MCP_SETTINGS_PATH || home(ctx, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
      const files = [ext, cli].filter(exists);
      return (files.length ? files : [cli]).map((f) => mcpServers(f, launch, env));
    },
    installed: (ctx) => exists(home(ctx, '.cline')) || exists(path.join(vscodeUserDir(ctx), 'globalStorage', 'saoudrizwan.claude-dev')),
    inProject: () => false,
  },
  {
    id: 'roo',
    title: 'Roo Code',
    docs: ['https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo'],
    mcpScopes: ['project'],
    mcp: (_scope, ctx, launch, env) => [mcpServers(at(ctx, '.roo', 'mcp.json'), launch, env)],
    installed: (ctx) => exists(path.join(vscodeUserDir(ctx), 'globalStorage', 'rooveterinaryinc.roo-cline')),
    inProject: (ctx) => exists(at(ctx, '.roo')),
  },
  {
    id: 'continue',
    title: 'Continue',
    docs: ['https://docs.continue.dev/customize/deep-dives/mcp'],
    mcpScopes: ['project'],
    mcp: (_scope, ctx, launch) => [
      {
        file: at(ctx, '.continue', 'mcpServers', `${SERVER_KEY}.yaml`),
        what: 'MCP server',
        // Our own file: Continue merges every block in .continue/mcpServers/.
        update: () =>
          [
            `name: ${SERVER_KEY}`,
            'version: 0.0.1',
            'schema: v1',
            'mcpServers:',
            `  - name: ${SERVER_KEY}`,
            '    type: stdio',
            `    command: ${JSON.stringify(launch.command)}`,
            `    args: [${launch.args.map((a) => JSON.stringify(a)).join(', ')}]`,
            '',
          ].join('\n'),
      },
    ],
    installed: (ctx) => exists(home(ctx, '.continue')),
    inProject: (ctx) => exists(at(ctx, '.continue')),
  },
  {
    id: 'amp',
    title: 'Amp',
    docs: ['https://ampcode.com/docs/customize/mcp', 'https://ampcode.com/docs/cli/settings'],
    mcpScopes: ['project', 'user'],
    mcp: (scope, ctx, launch, env) => [
      mcpServers(jsonOrJsonc(scope === 'project' ? at(ctx, '.amp', 'settings.json') : path.join(ctx.home, '.config', 'amp', 'settings.json')), launch, env, ['amp.mcpServers']),
    ],
    installed: (ctx) => exists(path.join(ctx.home, '.config', 'amp')),
    inProject: (ctx) => exists(at(ctx, '.amp')),
    after: (scope) => (scope === 'project' ? [`Amp runs workspace servers after approval: amp mcp approve ${SERVER_KEY}`] : []),
  },
  {
    id: 'opencode',
    title: 'opencode',
    docs: ['https://opencode.ai/docs/mcp-servers/', 'https://opencode.ai/docs/config/'],
    mcpScopes: ['project', 'user'],
    mcp: (scope, ctx, launch, env) => [
      jsonServer(jsonOrJsonc(scope === 'project' ? at(ctx, 'opencode.json') : path.join(xdgConfig(ctx), 'opencode', 'opencode.json')), ['mcp'], 'MCP server', (prev) => {
        const e = env(prev?.environment);
        return { type: 'local', command: [launch.command, ...launch.args], enabled: true, ...(e ? { environment: e } : {}) };
      }),
    ],
    installed: (ctx) => exists(path.join(xdgConfig(ctx), 'opencode')),
    inProject: (ctx) => exists(at(ctx, 'opencode.json')) || exists(at(ctx, 'opencode.jsonc')) || exists(at(ctx, '.opencode')),
  },
  {
    id: 'kiro',
    title: 'Kiro',
    docs: ['https://kiro.dev/docs/mcp/configuration/'],
    mcpScopes: ['project', 'user'],
    mcp: (scope, ctx, launch, env) => [mcpServers(scope === 'project' ? at(ctx, '.kiro', 'settings', 'mcp.json') : home(ctx, '.kiro', 'settings', 'mcp.json'), launch, env)],
    installed: (ctx) => exists(home(ctx, '.kiro')),
    inProject: (ctx) => exists(at(ctx, '.kiro')),
  },
];

const ALIASES: Record<string, string> = {
  'claude-code': 'claude',
  'claude-desktop': 'claude-desktop',
  desktop: 'claude-desktop',
  code: 'vscode',
  'vs-code': 'vscode',
  copilot: 'vscode',
  devin: 'windsurf',
  'gemini-cli': 'gemini',
  'roo-code': 'roo',
  'jetbrains-ai': 'jetbrains',
  'ai-assistant': 'jetbrains',
};

export function findClient(name: string): Client | undefined {
  const id = ALIASES[name.toLowerCase()] ?? name.toLowerCase();
  return CLIENTS.find((c) => c.id === id);
}
