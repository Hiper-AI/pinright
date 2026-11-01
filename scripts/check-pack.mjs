/**
 * Fails when the tarball would ship more than it should, or a CLI that cannot start.
 * Run: npm pack --ignore-scripts --json > pack.json && node scripts/check-pack.mjs pack.json
 */
import fs from 'node:fs';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/check-pack.mjs <npm pack --json output>');
  process.exit(2);
}
const [pack] = JSON.parse(fs.readFileSync(file, 'utf8'));
const paths = pack.files.map((f) => f.path.replace(/\\/g, '/'));
const problems = [];

const allowed = (p) => ['package.json', 'README.md', 'LICENSE', 'SECURITY.md'].includes(p) || /^dist\/[\w/.-]+\.js$/.test(p);
for (const p of paths) if (!allowed(p)) problems.push(`unexpected file in the tarball: ${p}`);
for (const p of ['package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'dist/cli.js']) {
  if (!paths.includes(p)) problems.push(`missing from the tarball: ${p}`);
}

const cli = fs.readFileSync('dist/cli.js', 'utf8');
if (!cli.startsWith('#!/usr/bin/env node\n')) problems.push('dist/cli.js lost its shebang');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const s of ['preinstall', 'install', 'postinstall', 'prepare']) {
  if (pkg.scripts?.[s]) problems.push(`package.json has a "${s}" script, which runs on the user's machine`);
}

for (const p of paths.filter((x) => x.startsWith('dist/'))) {
  const text = fs.readFileSync(p, 'utf8');
  if (/sourceMappingURL/.test(text)) problems.push(`${p} references a source map`);
  if (/[A-Za-z]:\\\\Users\\\\|\/home\/runner\/|\/Users\/[^/]+\//.test(text)) problems.push(`${p} contains a local path`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`ok: ${paths.length} files, ${pack.size} bytes packed, ${pack.unpackedSize} unpacked`);
