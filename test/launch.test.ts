/**
 * Which command init writes for the agent: the global binary when a real global install of
 * pinright is on PATH (the hook then starts in about 0.2 s instead of about 1 s through npx),
 * npx otherwise. What counts as "real": its package.json names pinright and its bin.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseLauncher, findGlobalInstall } from '../src/launch.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pinright-launch-'));
const pkg = (dir: string, name = 'pinright', version = '1.0.0') => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, bin: { [name]: 'dist/cli.js' } }));
};

describe('findGlobalInstall', () => {
  it('Windows: an npm shim next to node_modules/pinright is a global install', () => {
    const prefix = tmp();
    fs.writeFileSync(path.join(prefix, 'pinright.cmd'), '@ECHO off\r\nnode "%dp0%\\node_modules\\pinright\\dist\\cli.js" %*\r\n');
    pkg(path.join(prefix, 'node_modules', 'pinright'));
    const g = findGlobalInstall({ PATH: `C:\\nowhere;${prefix}` }, 'win32');
    expect(g).toMatchObject({ bin: path.join(prefix, 'pinright.cmd'), version: '1.0.0' });
  });

  it('a project bin or npx\'s temporary cache does not count, nor a package that is not pinright', () => {
    const root = tmp();
    const local = path.join(root, 'proj', 'node_modules', '.bin');
    const npx = path.join(root, 'npm-cache', '_npx', 'abc', 'node_modules', '.bin');
    const other = path.join(root, 'other');
    for (const d of [local, npx, other]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'pinright.cmd'), '@ECHO off\r\n');
    }
    pkg(path.join(local, 'node_modules', 'pinright'));
    pkg(path.join(npx, 'node_modules', 'pinright'));
    pkg(path.join(other, 'node_modules', 'pinright'), 'not-pinright');
    expect(findGlobalInstall({ PATH: [local, npx, other].join(';') }, 'win32')).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('POSIX: the bin links into the package', () => {
    const prefix = tmp();
    const dir = path.join(prefix, 'lib', 'node_modules', 'pinright');
    pkg(dir);
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    fs.mkdirSync(path.join(prefix, 'bin'));
    fs.symlinkSync(path.join(dir, 'dist', 'cli.js'), path.join(prefix, 'bin', 'pinright'));
    expect(findGlobalInstall({ PATH: path.join(prefix, 'bin') }, process.platform)?.packageDir).toBe(fs.realpathSync(dir));
  });
});

describe('chooseLauncher', () => {
  const g = { bin: 'C:\\npm\\pinright.cmd', packageDir: 'C:\\npm\\node_modules\\pinright', version: '1.2.0' };
  const c = (o: Partial<Parameters<typeof chooseLauncher>[0]>) => chooseLauncher({ scope: 'project', version: '1.0.0', global: g, ...o });
  it("project files get npx even with a global install; the user's own files get the binary", () => {
    expect(c({})).toMatchObject({ command: 'npx', args: ['-y', 'pinright'], kind: 'npx' });
    expect(c({}).why).toMatch(/project files are shared through the repository.*"--bin" writes the global binary/);
    expect(c({ scope: 'user' })).toMatchObject({ command: 'pinright', args: [], kind: 'global' });
  });
  it('--bin puts the binary in project files and warns about teammates; --npx and --dev apply everywhere', () => {
    expect(c({ bin: true })).toMatchObject({ command: 'pinright', kind: 'global' });
    expect(c({ bin: true }).why).toMatch(/Teammates who use these files without "npm i -g pinright" get a hook that does not start/);
    expect(c({ scope: 'user', npx: true })).toMatchObject({ command: 'npx', kind: 'npx' });
    expect(c({ scope: 'user', dev: '/src/dist/cli.js' })).toMatchObject({ command: 'node', args: ['/src/dist/cli.js'], kind: 'node' });
  });
  it('a global install of another major, or none, leaves the user files on npx with the way to the binary', () => {
    expect(c({ scope: 'user', version: '2.0.0' })).toMatchObject({ kind: 'npx' });
    expect(c({ scope: 'user', version: '2.0.0' }).why).toMatch(/another major/);
    expect(c({ scope: 'user', global: undefined }).why).toMatch(/no global install on PATH; "npm i -g pinright" and init --user again/);
  });
});
