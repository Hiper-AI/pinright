/* eslint-disable @typescript-eslint/no-explicit-any -- client config files are untyped JSON */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jsonc from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit, type InitOptions } from '../src/clients/init.js';
import { hasLegacyEntry, isLegacyHook } from '../src/clients/legacy.js';
import type { Ctx } from '../src/clients/registry.js';
import { clientWiring } from '../src/doctor.js';

// Entries the old `init` wrote under the project's working name, safectx.
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
const file = (...p: string[]) => path.join(ctx.cwd, ...p);
const read = (f: string) => fs.readFileSync(f, 'utf8');
const write = (f: string, text: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const checkoutHook = 'node "C:\\Hiper AI\\safectx\\dist\\cli.js" hook claude';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pinright-legacy-'));
  fs.mkdirSync(path.join(root, 'proj'));
  fs.mkdirSync(path.join(root, 'home'));
  ctx = { cwd: path.join(root, 'proj'), home: path.join(root, 'home'), platform: 'linux', env: {} };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('entries written under the old name', () => {
  it('recognizes the old hook, from npx or from a checkout, and nothing else', () => {
    expect(isLegacyHook({ hooks: [{ command: 'npx -y safectx hook claude' }] })).toBe(true);
    expect(isLegacyHook({ command: checkoutHook })).toBe(true);
    expect(isLegacyHook({ command: 'node /src/other/dist/cli.js hook claude' })).toBe(false);
    // A worktree of the old checkout is not the old folder; the entry init writes from there is current.
    expect(isLegacyHook({ command: 'node "C:\\Hiper AI\\_worktrees\\safectx-integracion\\dist\\cli.js" hook claude' })).toBe(false);
    expect(isLegacyHook({ command: 'npx -y pinright hook claude' })).toBe(false);
    expect(hasLegacyEntry(JSON.stringify({ hooks: { PreToolUse: [{ command: checkoutHook }] } }))).toBe(true);
    expect(hasLegacyEntry('[mcp_servers.safectx]\ncommand = "npx"\n')).toBe(true);
    expect(hasLegacyEntry('{ "mcpServers": { "pinright": {} } }')).toBe(false);
  });

  it('init replaces the old MCP entry and hooks in place, keeps the rest, and says so', () => {
    write(file('.mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' }, safectx: { command: 'npx', args: ['-y', 'safectx'], env: { SAFECTX_COOLDOWN_DAYS: '5' } } } }, null, 2));
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint.sh' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'npx -y safectx hook claude' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: checkoutHook }] },
        ],
      },
    };
    write(file('.claude', 'settings.json'), JSON.stringify(settings, null, 2));
    expect(clientWiring(ctx.cwd, ctx.home)[0].legacy).toEqual(['.mcp.json', path.join('.claude', 'settings.json')]);

    const r = runInit(ctx, opts({ client: 'claude' }));
    expect(r.code).toBe(0);
    const mcp = JSON.parse(read(file('.mcp.json'))).mcpServers;
    expect(mcp).toEqual({ github: { command: 'gh-mcp' }, pinright: { command: 'npx', args: ['-y', 'pinright'], env: { PINRIGHT_COOLDOWN_DAYS: '5' } } });
    const hooks = jsonc.parse(read(file('.claude', 'settings.json'))).hooks.PreToolUse.map((h: any) => h.hooks[0].command);
    expect(hooks).toEqual(['lint.sh', 'npx -y pinright hook claude']);
    expect(r.lines).toContain('replaced the entries written under the old name safectx in .mcp.json');
    expect(r.lines).toContain(`replaced the entries written under the old name safectx in ${path.join('.claude', 'settings.json')}`);
    expect(clientWiring(ctx.cwd, ctx.home)[0].legacy).toBeUndefined();

    const again = runInit(ctx, opts({ client: 'claude' }));
    expect(again.files).toEqual([]);
  });

  it('init moves the old Copilot hook file aside instead of leaving two hooks', () => {
    const old = file('.github', 'hooks', 'safectx.json');
    write(old, JSON.stringify({ version: 1, hooks: { PreToolUse: [{ type: 'command', command: 'npx -y safectx hook copilot' }] } }));
    expect(clientWiring(ctx.cwd, ctx.home).find((w) => w.client.startsWith('VS Code'))?.legacy).toEqual([path.join('.github', 'hooks', 'safectx.json')]);

    const dry = runInit(ctx, opts({ client: 'vscode', mcp: false, print: true }));
    expect(dry.lines.join('\n')).toContain('written under the old name safectx, would move to');
    expect(fs.existsSync(old)).toBe(true);

    const r = runInit(ctx, opts({ client: 'vscode', mcp: false }));
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(`${old}.pinright.bak`)).toBe(true);
    expect(read(file('.github', 'hooks', 'pinright.json'))).toContain('npx -y pinright hook copilot');
    expect(r.lines.join('\n')).toContain(`replaced ${path.join('.github', 'hooks', 'safectx.json')}`);
  });

  it('init replaces the old Codex table and renames its variables', () => {
    const toml = 'model = "gpt-5"\n\n[mcp_servers.safectx]\ncommand = "npx"\nargs = ["-y", "safectx"]\n\n[mcp_servers.safectx.env]\nSAFECTX_COOLDOWN_DAYS = "5"\n\n[mcp_servers.github]\ncommand = "gh"\n';
    write(path.join(ctx.home, '.codex', 'config.toml'), toml);
    runInit(ctx, opts({ client: 'codex', scope: 'user', hook: false }));
    expect(read(path.join(ctx.home, '.codex', 'config.toml'))).toBe(
      'model = "gpt-5"\n\n[mcp_servers.github]\ncommand = "gh"\n\n[mcp_servers.pinright]\ncommand = "npx"\nargs = ["-y", "pinright"]\n\n[mcp_servers.pinright.env]\nPINRIGHT_COOLDOWN_DAYS = "5"\n',
    );
  });
});
