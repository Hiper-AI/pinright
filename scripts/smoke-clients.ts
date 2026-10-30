/**
 * The packed tarball, installed the way a user gets it, started by each client's
 * config exactly as `init` writes it, over a real MCP handshake.
 *
 *   1. npm pack (dist/ must be built), install the tarball into a temp project
 *      with --ignore-scripts, and a temp HOME so no real client config is read or touched;
 *   2. `pinright init <client>` from the installed package, for each client below;
 *   3. read back the server entry and spawn it (`npx -y pinright` resolves the local
 *      install), initialize, list the tools; run the hook command it wrote with a
 *      harmless tool call and check the agent would be let through.
 *
 * Run: npm run build && npx tsx scripts/smoke-clients.ts [claude cursor vscode ...]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jsonc from 'jsonc-parser';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
const win = process.platform === 'win32';

function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: string }) {
  const q = (a: string) => (win && /[\s&()|<>]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return spawnSync(win ? [cmd, ...args].map(q).join(' ') : cmd, win ? [] : args, { ...opts, shell: win, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function must(r: ReturnType<typeof run>, what: string): string {
  if (r.status !== 0) throw new Error(`${what} exited with ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

/** Where `init` puts the server entry and the hook, per client (project scope). */
const CLIENTS: Record<string, { mcp: [string, string[]]; hook?: { file: string; command: (doc: any) => string; input: object; allows: (out: string, code: number | null) => boolean } }> = {
  claude: {
    mcp: ['.mcp.json', ['mcpServers', pkg.name]],
    hook: {
      file: '.claude/settings.json',
      command: (d) => d.hooks.PreToolUse.at(-1).hooks[0].command,
      input: { tool_name: 'Bash', tool_input: { command: 'ls' } },
      allows: (out, code) => code === 0 && !out.includes('"deny"'),
    },
  },
  cursor: {
    mcp: ['.cursor/mcp.json', ['mcpServers', pkg.name]],
    hook: {
      file: '.cursor/hooks.json',
      command: (d) => d.hooks.beforeShellExecution.at(-1).command,
      input: { command: 'ls' },
      allows: (out, code) => code === 0 && JSON.parse(out).permission === 'allow',
    },
  },
  vscode: {
    mcp: ['.vscode/mcp.json', ['servers', pkg.name]],
    hook: {
      file: `.github/hooks/${pkg.name}.json`,
      command: (d) => d.hooks.PreToolUse.at(-1).command,
      input: { tool_name: 'runInTerminal', tool_input: { command: 'ls' } },
      allows: (out, code) => code === 0 && JSON.stringify(JSON.parse(out)) === '{}',
    },
  },
  codex: { mcp: ['.codex/config.toml', []] },
  gemini: { mcp: ['.gemini/settings.json', ['mcpServers', pkg.name]] },
};

async function handshake(entry: { command: string; args: string[]; env?: Record<string, string> }, cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, cwd, env: { ...(env as Record<string, string>), ...(entry.env ?? {}) }, stderr: 'ignore' });
  const client = new Client({ name: 'smoke-clients', version: '0.0.0' });
  await client.connect(transport);
  try {
    const info = client.getServerVersion();
    if (info?.name !== pkg.name || info.version !== pkg.version) throw new Error(`server says ${JSON.stringify(info)}`);
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

/** Codex's TOML entry: command and args are all the smoke test needs. */
function tomlEntry(text: string): { command: string; args: string[] } {
  const table = text.split(`[mcp_servers.${pkg.name}]`)[1] ?? '';
  return { command: JSON.parse(/^command = (.+)$/m.exec(table)![1]), args: JSON.parse(/^args = (.+)$/m.exec(table)![1]) };
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CLIENTS);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${pkg.name}-smoke-`));
const home = path.join(tmp, 'home');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(home);
fs.mkdirSync(proj);
// A private HOME and npm cache dir for the install would also hide the user's npm config; keep the cache, move HOME.
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(home, '.config') };
delete env.GITHUB_TOKEN;
delete env.GH_TOKEN;

try {
  const [packed] = JSON.parse(must(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tmp], { cwd: ROOT }), 'npm pack'));
  const tgz = path.join(tmp, packed.filename);
  console.log(`packed ${packed.filename}: ${packed.entryCount} files, ${packed.size} bytes`);
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'smoke', version: '1.0.0', private: true }));
  must(run('npm', ['install', tgz, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: proj, env: { ...process.env } }), 'npm install');
  const cli = path.join(proj, 'node_modules', pkg.name, 'dist', 'cli.js');

  let failed = 0;
  for (const id of wanted) {
    const c = CLIENTS[id];
    try {
      must(run(process.execPath, [cli, 'init', id, '--no-config'], { cwd: proj, env }), `init ${id}`);
      const [file, keyPath] = c.mcp;
      const text = fs.readFileSync(path.join(proj, file), 'utf8');
      let entry = keyPath.length ? keyPath.reduce((o: any, k) => o?.[k], jsonc.parse(text)) : tomlEntry(text);
      if (!entry) throw new Error(`no ${pkg.name} entry in ${file}`);
      // opencode-style command arrays are not in this list; every entry here is command + args.
      entry = { command: entry.command, args: entry.args, env: entry.env };
      const tools = await handshake(entry, proj, env);
      let hookNote = '';
      if (c.hook) {
        const command = c.hook.command(jsonc.parse(fs.readFileSync(path.join(proj, c.hook.file), 'utf8')));
        const r = spawnSync(command, { cwd: proj, env, shell: true, input: JSON.stringify({ cwd: proj, ...c.hook.input }), encoding: 'utf8' });
        if (!c.hook.allows(r.stdout, r.status)) throw new Error(`hook "${command}" did not let "ls" through: exit ${r.status}, ${r.stdout} ${r.stderr}`);
        hookNote = `; hook "${command}" allows "ls"`;
      }
      console.log(`ok ${id}: ${file} -> ${entry.command} ${entry.args.join(' ')} -> ${tools.length} tools (${tools.join(', ')})${hookNote}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${id}: ${(err as Error).message}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
