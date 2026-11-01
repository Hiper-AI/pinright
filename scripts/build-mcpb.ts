/**
 * Builds the Claude Desktop extension (.mcpb) locally, into build/mcpb/ (gitignored).
 * Nothing is published or uploaded.
 *
 *   1. stage: the files `npm pack` would ship, plus the production node_modules
 *      installed from package-lock.json with install scripts off;
 *   2. manifest.json from package.json (scripts/distribution.ts) and the tool
 *      list the built server reports over stdio;
 *   3. validation against the MCPB 0.3 schema, then the official CLI
 *      (`@anthropic-ai/mcpb`, pinned, run through npx) validates and packs.
 *
 * Run: npm run build && npx tsx scripts/build-mcpb.ts [--no-cli]
 * --no-cli stops after the schema check and leaves the staged directory (no .mcpb).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mcpbManifest, readPkg } from './distribution.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'mcpb');
const STAGE = path.join(OUT, 'stage');
const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';
const SCHEMA = path.join(ROOT, 'test', 'fixtures', 'mcpb-manifest-v0.3.schema.json');

/** Runs a command; on Windows through the shell (npm and npx are .cmd files), with paths quoted. */
function run(cmd: string, args: string[], cwd = ROOT): string {
  const win = process.platform === 'win32';
  const q = (a: string) => (win && /[\s&()]/.test(a) ? `"${a}"` : a);
  const r = spawnSync(win ? [cmd, ...args].map(q).join(' ') : cmd, win ? [] : args, { cwd, shell: win, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    process.stderr.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
    throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
  }
  return r.stdout;
}

async function listTools(entry: string): Promise<{ name: string; description: string }[]> {
  const client = new Client({ name: 'build-mcpb', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'ignore' }));
  try {
    const { tools } = await client.listTools();
    // The first sentence: the manifest list is a summary for the install dialog.
    return tools.map((t) => ({ name: t.name, description: (t.description ?? t.title ?? '').split(/(?<=\.)\s/)[0].slice(0, 300) }));
  } finally {
    await client.close();
  }
}

const pkg = readPkg(ROOT);
if (!fs.existsSync(path.join(ROOT, 'dist', 'cli.js'))) throw new Error('dist/cli.js is missing: run npm run build first');

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// 1. What npm would ship, copied from the working tree (dist/ must be fresh), and the production dependencies.
const [packed] = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']));
for (const f of packed.files as { path: string }[]) {
  const to = path.join(STAGE, f.path);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f.path), to);
}
fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(STAGE, 'package-lock.json'));
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], STAGE);
fs.rmSync(path.join(STAGE, 'package-lock.json'));

// 2. The manifest, with the tools the built server actually registers.
const tools = await listTools(path.join(STAGE, 'dist', 'cli.js'));
const manifest = mcpbManifest(pkg, tools);
fs.writeFileSync(path.join(STAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`staged ${path.relative(ROOT, STAGE)} with ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

// 3. Schema first (offline), then the official CLI.
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validate = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA, 'utf8')));
if (!validate(manifest)) throw new Error(`manifest.json does not match the MCPB 0.3 schema: ${ajv.errorsText(validate.errors)}`);
console.log('manifest.json matches the MCPB 0.3 schema');

if (!process.argv.includes('--no-cli')) {
  console.log(run('npx', ['-y', MCPB_CLI, 'validate', path.join(STAGE, 'manifest.json')]).trim());
  const file = path.join(OUT, `${pkg.name}-${pkg.version}.mcpb`);
  fs.rmSync(file, { force: true });
  console.log(run('npx', ['-y', MCPB_CLI, 'pack', STAGE, file]).trim());
  console.log(`built ${path.relative(ROOT, file)} (${fs.statSync(file).size} bytes); not published`);
}
