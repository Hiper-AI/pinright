#!/usr/bin/env node
// The checks of ci.yml and action-selftest.yml, run on this machine, one after the other. Use it
// before pushing while GitHub-hosted runners are not available, and before tagging a release.
//
//   npm run ci:local            # all steps on the installed node_modules
//   npm run ci:local -- --fresh # starts with npm ci --ignore-scripts, like CI
//
// CI also runs the tests on Node 20, 22 and 24; this runs them on the Node you have. It stops at
// the first failing step and exits with its code.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const fresh = process.argv.includes('--fresh');
const isWin = process.platform === 'win32';

function run(label, cmd, args, opts = {}) {
  const started = Date.now();
  process.stdout.write(`\n== ${label}\n`);
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? root, stdio: opts.capture ? 'pipe' : 'inherit', shell: isWin, encoding: 'utf8' });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status !== 0) {
    if (opts.capture) process.stdout.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    console.error(`\nci:local: "${label}" failed (exit ${r.status ?? r.signal}) after ${secs} s`);
    process.exit(r.status || 1);
  }
  console.log(`ok (${secs} s)`);
  return r;
}

console.log(`ci:local on Node ${process.version}`);
if (fresh) run('install (npm ci --ignore-scripts)', 'npm', ['ci', '--ignore-scripts']);

// ci.yml, job "test"
run('typecheck', 'npm', ['run', 'typecheck']);
run('lint', 'npm', ['run', 'lint']);
run('unit tests', 'npm', ['test']);
run('build', 'npm', ['run', 'build']);
run('client smoke test', 'npm', ['run', 'smoke:clients']);

// ci.yml, job "self-audit"
run('audit the lockfile', 'node', ['dist/cli.js', 'audit', 'package-lock.json', '--fail-on=high']);
run('audit the workflows', 'node', ['dist/cli.js', 'audit', '.github/workflows', '--fail-on=high']);
run('registry signatures and provenance', 'npm', ['audit', 'signatures']);

// ci.yml, job "package contents"
const pack = run('pack', 'npm', ['pack', '--ignore-scripts', '--json'], { capture: true });
const packJson = join(root, 'pack.json');
writeFileSync(packJson, pack.stdout);
try {
  run('check the file list', 'node', ['scripts/check-pack.mjs', 'pack.json']);
  const name = JSON.parse(pack.stdout)[0].filename;
  const tarball = join(root, name);
  const dir = mkdtempSync(join(tmpdir(), 'pinright-pack-'));
  try {
    // Installed by file name from inside the folder: a path with spaces does not survive the Windows shell.
    copyFileSync(tarball, join(dir, name));
    writeFileSync(join(dir, 'package.json'), '{"name":"pack-check","version":"0.0.0","private":true}\n');
    run('install the tarball in an empty project', 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `./${name}`], { cwd: dir });
    run('run the installed CLI', 'npx', ['--no-install', 'pinright', '--version'], { cwd: dir });
    run('check a package with the installed CLI', 'npx', ['--no-install', 'pinright', 'check', 'npm', 'express'], { cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tarball, { force: true });
  }
} finally {
  rmSync(packJson, { force: true });
}

// action-selftest.yml, job "bundle-is-fresh"
const before = readFileSync(join(root, 'action-dist', 'index.mjs'), 'utf8');
run('bundle the action', 'npm', ['run', 'bundle:action']);
if (readFileSync(join(root, 'action-dist', 'index.mjs'), 'utf8') !== before) {
  console.error('\nci:local: action-dist/index.mjs was stale and has been rebuilt. Review and commit it.');
  process.exit(1);
}
console.log('action-dist matches the source');

// The site (pinright.dev): build plus its copy rules (check-dist).
run('site build and copy rules', 'npm', ['--prefix', 'site', 'run', 'build']);

console.log('\nci:local: every step passed');
