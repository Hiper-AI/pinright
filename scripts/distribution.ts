/**
 * Distribution artifacts generated from package.json and the client registry, so
 * that a rename or a new client changes one place:
 *   - server.json            the MCP Registry entry (not published from here)
 *   - README.md              the per-client config blocks and the install links
 *   - the .mcpb manifest     built by scripts/build-mcpb.ts
 * Run: npx tsx scripts/distribution.ts           rewrite server.json and the README blocks
 *      npx tsx scripts/distribution.ts --check   exit 1 if either is out of date
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENTS, type Client, type Ctx, type Scope } from '../src/clients/registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Pkg {
  name: string;
  version: string;
  description: string;
  mcpName: string;
  license: string;
  author: string;
  homepage: string;
  keywords: string[];
  repository: { url: string };
  bugs: { url: string };
  engines: { node: string };
}

export function readPkg(root = ROOT): Pkg {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

/** https://github.com/<org>/<repo> from package.json's git+https://...git. */
export function repoUrl(pkg: Pkg): string {
  return pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
}

const launch = (pkg: Pkg) => ({ command: 'npx', args: ['-y', pkg.name] });
/** The server key in client configs: the unscoped name (src/pkg.ts SERVER_KEY). */
export const serverKey = (pkg: Pkg) => pkg.name.replace(/^@[^/]+\//, '');

/** One line for directories and the registry, at most 100 characters (the registry's limit). */
export const SHORT_DESCRIPTION = 'Version-accurate library docs for coding agents, with a supply-chain check of each dependency.';

// ------------------------------------------------------------ MCP Registry ---

export const SERVER_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

const ENV_VARS = [
  {
    name: 'GITHUB_TOKEN',
    description: 'Optional. Raises the GitHub API limit from 60 to 5,000 requests an hour (monorepo docs, upgrade guides). Read-only use.',
    isRequired: false,
    isSecret: true,
  },
  {
    name: 'PINRIGHT_GH_CLI',
    description: 'Optional. 1 uses the GitHub CLI login (gh auth token) when GITHUB_TOKEN is not set.',
    isRequired: false,
    isSecret: false,
    choices: ['1'],
  },
];

export function serverJson(pkg: Pkg): Record<string, unknown> {
  return {
    $schema: SERVER_SCHEMA,
    name: pkg.mcpName,
    title: pkg.name,
    description: SHORT_DESCRIPTION,
    repository: { url: repoUrl(pkg), source: 'github' },
    websiteUrl: pkg.homepage,
    version: pkg.version,
    packages: [
      {
        registryType: 'npm',
        registryBaseUrl: 'https://registry.npmjs.org',
        identifier: pkg.name,
        version: pkg.version,
        runtimeHint: 'npx',
        transport: { type: 'stdio' },
        environmentVariables: ENV_VARS,
      },
    ],
  };
}

// --------------------------------------------------------------------- MCPB ---

export const MCPB_SCHEMA = 'https://raw.githubusercontent.com/modelcontextprotocol/mcpb/main/schemas/mcpb-manifest-v0.3.schema.json';

/** The Claude Desktop extension manifest (MCPB 0.3). The bundle ships dist/ and the production node_modules. */
export function mcpbManifest(pkg: Pkg, tools: { name: string; description: string }[]): Record<string, unknown> {
  const repo = repoUrl(pkg);
  return {
    manifest_version: '0.3',
    name: serverKey(pkg),
    display_name: pkg.name,
    version: pkg.version,
    description: SHORT_DESCRIPTION,
    long_description: pkg.description,
    author: { name: pkg.author, url: 'https://github.com/Hiper-AI' },
    repository: { type: 'git', url: `${repo}.git` },
    homepage: pkg.homepage,
    documentation: `${repo}#readme`,
    support: pkg.bugs.url,
    license: pkg.license,
    keywords: pkg.keywords.filter((k) => !['claude-code', 'cursor'].includes(k)),
    // SECURITY.md lists each public service a request goes to and what it receives.
    privacy_policies: [`${repo}/blob/main/SECURITY.md`],
    server: {
      type: 'node',
      entry_point: 'dist/cli.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/dist/cli.js'],
        // An unset optional setting may arrive as the literal placeholder; the server ignores that (src/github.ts).
        env: { GITHUB_TOKEN: '${user_config.github_token}' },
      },
    },
    user_config: {
      github_token: {
        type: 'string',
        title: 'GitHub token (optional)',
        description: 'A fine-grained token with read-only access to public repositories. Raises the GitHub API limit from 60 to 5,000 requests an hour. Stored in the OS keychain.',
        sensitive: true,
        required: false,
      },
    },
    tools,
    tools_generated: false,
    compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: pkg.engines.node } },
  };
}

// ------------------------------------------------------------ install links ---

/** Cursor's web install link (GitHub does not link cursor:// URLs): name, and the server entry base64-encoded. */
export function cursorLink(pkg: Pkg): string {
  const config = Buffer.from(JSON.stringify(launch(pkg))).toString('base64');
  return `https://cursor.com/en/install-mcp?name=${encodeURIComponent(serverKey(pkg))}&config=${encodeURIComponent(config)}`;
}

/** VS Code's vscode:mcp/install?{json}, through the vscode.dev redirect so it is a link GitHub renders. */
export function vscodeLink(pkg: Pkg, insiders = false): string {
  const deeplink = `${insiders ? 'vscode-insiders' : 'vscode'}:mcp/install?${encodeURIComponent(JSON.stringify({ name: serverKey(pkg), type: 'stdio', ...launch(pkg) }))}`;
  return `https://insiders.vscode.dev/redirect?url=${encodeURIComponent(deeplink)}`;
}

// ------------------------------------------------------------ README blocks ---

/** Fixed contexts so the README is the same on every OS: `~` for home, `%APPDATA%` on Windows. */
const OS_CTX: Record<'linux' | 'darwin' | 'win32', Ctx> = {
  linux: { cwd: '.', home: '~', platform: 'linux', env: {} },
  darwin: { cwd: '.', home: '~', platform: 'darwin', env: {} },
  win32: { cwd: '.', home: '%USERPROFILE%', platform: 'win32', env: { APPDATA: '%APPDATA%' } },
};
const slash = (p: string, os: keyof typeof OS_CTX) => (os === 'win32' ? p.replace(/\//g, '\\') : p.replace(/\\/g, '/'));
const NO_ENV = () => undefined;

function mcpFile(c: Client, scope: Scope, os: keyof typeof OS_CTX, pkg: Pkg): string | undefined {
  if (!c.mcp || !c.mcpScopes.includes(scope)) return undefined;
  return slash(c.mcp(scope, OS_CTX[os], launch(pkg), NO_ENV)[0].file, os);
}

function hookFile(c: Client, scope: Scope, os: keyof typeof OS_CTX): string | undefined {
  if (!c.hook || !c.hook.scopes.includes(scope)) return undefined;
  return slash(c.hook.write(scope, OS_CTX[os], '').file, os);
}

/** The user-level path, once when it is the same on every OS, else per OS. */
function userPath(get: (os: keyof typeof OS_CTX) => string | undefined): string | undefined {
  const all = (['linux', 'darwin', 'win32'] as const).map((os) => [os, get(os)] as const);
  if (!all[0][1]) return undefined;
  const win = all[2][1]!;
  if (all[0][1] === all[1][1]) {
    if (win.replace(/\\/g, '/').replace('%USERPROFILE%', '~') === all[0][1]) return `\`${all[0][1]}\``;
    return `\`${all[0][1]}\` (Linux, macOS), \`${win}\` (Windows)`;
  }
  return `\`${all[0][1]}\` (Linux), \`${all[1][1]}\` (macOS), \`${win}\` (Windows)`;
}

const fence = (file: string) => (file.endsWith('.toml') ? 'toml' : file.endsWith('.yaml') ? 'yaml' : file.endsWith('.jsonc') ? 'jsonc' : 'json');

/** A JSON snippet as people write it: two-space indent, short arrays on one line. */
function compactJson(text: string): string {
  return JSON.stringify(JSON.parse(text), null, 2).replace(/\[\n\s*([^[\]{}]*?)\n\s*\]/g, (_m, inner: string) => `[${inner.split(/,\n\s*/).join(', ')}]`);
}

export function clientsBlock(pkg: Pkg): string {
  const out: string[] = [];
  for (const c of CLIENTS) {
    out.push(`#### ${c.title}`, '');
    if (c.manual) {
      const lines = c.manual(launch(pkg));
      out.push(lines.slice(0, -1).join(' '), '', '```json', compactJson(lines[lines.length - 1]), '```', '');
      continue;
    }
    const where: string[] = [];
    const project = mcpFile(c, 'project', 'linux', pkg);
    const user = userPath((os) => mcpFile(c, 'user', os, pkg));
    if (project) where.push(`project \`${project}\``);
    if (user) where.push(`user ${user}`);
    out.push(`Server: ${where.join('; ')}.`);
    if (c.hook) {
      const hp = hookFile(c, 'project', 'linux');
      const hu = userPath((os) => hookFile(c, 'user', os));
      out.push(`Hook (\`${pkg.name} hook ${c.hook.agent}\`): ${[hp && `project \`${hp}\``, hu && `user ${hu}`].filter(Boolean).join('; ')}.`);
    }
    const scope = c.mcpScopes[0];
    const w = c.mcp!(scope, OS_CTX.linux, launch(pkg), NO_ENV)[0];
    out.push('', '```bash', `npx -y ${pkg.name} init ${c.id}${scope === 'user' && c.mcpScopes.includes('project') ? ' --user' : ''}`, '```', '');
    const text = w.update(undefined);
    out.push(`\`\`\`${fence(w.file)}`, (/\.jsonc?$/.test(w.file) ? compactJson(text) : text).trimEnd(), '```', '');
  }
  return out.join('\n').trimEnd();
}

export function linksBlock(pkg: Pkg): string {
  return [
    `[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](${cursorLink(pkg)})`,
    `[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_${serverKey(pkg)}-0098FF?style=flat-square)](${vscodeLink(pkg)})`,
    `[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_${serverKey(pkg)}-24bfa5?style=flat-square)](${vscodeLink(pkg, true)})`,
  ].join('\n');
}

/** Replaces the text between `<!-- generated:<id> -->` and `<!-- /generated:<id> -->`. */
export function replaceBlock(text: string, id: string, body: string): string {
  const start = `<!-- generated:${id} (scripts/distribution.ts; do not edit by hand) -->`;
  const end = `<!-- /generated:${id} -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i < 0 || j < i) throw new Error(`README.md has no ${id} block`);
  return `${text.slice(0, i + start.length)}\n${body}\n${text.slice(j)}`;
}

export function readmeWithBlocks(readme: string, pkg: Pkg): string {
  return replaceBlock(replaceBlock(readme, 'install-links', linksBlock(pkg)), 'clients', clientsBlock(pkg));
}

// ----------------------------------------------------------------- main ---

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = readPkg();
  const check = process.argv.includes('--check');
  const targets: [string, string][] = [
    [path.join(ROOT, 'server.json'), `${JSON.stringify(serverJson(pkg), null, 2)}\n`],
    [path.join(ROOT, 'README.md'), readmeWithBlocks(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), pkg)],
  ];
  let stale = 0;
  for (const [file, text] of targets) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    if (current === text) continue;
    stale++;
    if (check) console.error(`${path.relative(ROOT, file)} is out of date: run npx tsx scripts/distribution.ts`);
    else {
      fs.writeFileSync(file, text);
      console.log(`wrote ${path.relative(ROOT, file)}`);
    }
  }
  process.exit(check && stale ? 1 : 0);
}
