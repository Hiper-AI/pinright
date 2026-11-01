import { describe, expect, it } from 'vitest';
import { detectKind, parseFile } from '../src/tree/lockfiles.js';

describe('npm package-lock.json', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { a: '^1.0.0' }, devDependencies: { d: '1.0.0' } },
      'node_modules/a': { version: '1.0.0', dependencies: { b: '^2.0.0' } },
      'node_modules/a/node_modules/b': { version: '2.0.0', dependencies: { c: '*' } },
      'node_modules/b': { version: '3.0.0' },
      'node_modules/c': { version: '1.2.3' },
      'node_modules/d': { version: '1.0.0', dev: true },
      'node_modules/@s/e': { version: '0.1.0' },
      'packages/local': { version: '0.0.0' },
      'node_modules/local': { link: true },
    },
  });

  it('lists every installed package with the shortest chain from a direct dependency', () => {
    const t = parseFile('package-lock.json', lock);
    const by = (n: string, v: string) => t.packages.find((p) => p.name === n && p.version === v);
    expect(t.kind).toBe('lockfile');
    expect(by('a', '1.0.0')).toMatchObject({ direct: true, path: ['a'] });
    // Node resolution: a's own nested b@2 wins over the hoisted b@3.
    expect(by('b', '2.0.0')).toMatchObject({ direct: false, path: ['a', 'b'] });
    expect(by('c', '1.2.3')?.path).toEqual(['a', 'b', 'c']);
    expect(by('d', '1.0.0')).toMatchObject({ direct: true, dev: true });
    expect(by('@s/e', '0.1.0')).toBeDefined();
    expect(t.packages.some((p) => p.name === 'local')).toBe(false);
  });

  it('reads lockfileVersion 1 nested trees', () => {
    const t = parseFile('package-lock.json', JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } } } }));
    expect(t.packages).toEqual([
      { name: 'a', version: '1.0.0', direct: true, dev: false, path: ['a'] },
      { name: 'b', version: '2.0.0', direct: false, dev: false, path: ['a', 'b'] },
    ]);
  });
});

describe('other lockfiles', () => {
  it('pnpm-lock.yaml v9 with importers', () => {
    const y = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      next:',
      '        specifier: 15.1.0',
      '        version: 15.1.0(react@19.0.0)',
      'packages:',
      '  next@15.1.0:',
      '    resolution: {integrity: sha512-x}',
      "  '@swc/helpers@0.5.15':",
      '    resolution: {integrity: sha512-y}',
    ].join('\n');
    const t = parseFile('pnpm-lock.yaml', y);
    expect(t.packages).toEqual([
      { name: 'next', version: '15.1.0', direct: true },
      { name: '@swc/helpers', version: '0.5.15', direct: false },
    ]);
  });

  it('yarn.lock v1 and berry', () => {
    const v1 = '# yarn lockfile v1\n\n"@babel/core@^7.0.0", "@babel/core@^7.1.0":\n  version "7.26.0"\n  resolved "x"\n\nlodash@^4.17.0:\n  version "4.17.21"\n';
    expect(parseFile('yarn.lock', v1, { 'package.json': '{"dependencies":{"lodash":"^4"}}' }).packages).toEqual([
      { name: '@babel/core', version: '7.26.0', direct: false },
      { name: 'lodash', version: '4.17.21', direct: true },
    ]);
    const berry = '__metadata:\n  version: 8\n\n"axios@npm:^1.7.0":\n  version: 1.7.9\n  resolution: "axios@npm:1.7.9"\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n';
    expect(parseFile('yarn.lock', berry).packages).toEqual([{ name: 'axios', version: '1.7.9' }]);
  });

  it('requirements.txt compiled by uv/pip-compile: direct vs transitive from "# via"', () => {
    const txt = [
      'anyio==4.6.0',
      '    # via',
      '    #   httpx',
      '    #   starlette',
      'fastapi==0.110.0',
      '    # via -r requirements.in',
      'pypdf==5.9.0  # via -r requirements.in',
      'starlette==0.36.3',
      '    # via fastapi',
    ].join('\n');
    const t = parseFile('requirements.txt', txt);
    expect(t.kind).toBe('lockfile');
    expect(t.packages).toEqual([
      { name: 'anyio', version: '4.6.0', path: ['httpx', 'anyio'] },
      { name: 'fastapi', version: '0.110.0', direct: true },
      { name: 'pypdf', version: '5.9.0', direct: true },
      { name: 'starlette', version: '0.36.3', path: ['fastapi', 'starlette'] },
    ]);
  });

  it('hand-written requirements: all pinned means all direct; ranges make it a manifest', () => {
    expect(parseFile('requirements.txt', 'Flask==3.0.0\nrequests[socks]==2.31.0\n').packages.every((p) => p.direct)).toBe(true);
    const m = parseFile('requirements-dev.txt', 'flask>=3\nPyYAML\n');
    expect(m.kind).toBe('manifest');
    expect(m.declared).toEqual([{ name: 'flask', spec: '>=3' }, { name: 'pyyaml', spec: '' }]);
  });

  it('poetry.lock / uv.lock / Cargo.lock [[package]] blocks', () => {
    const lock = '[[package]]\nname = "PyYAML"\nversion = "6.0.1"\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\n';
    expect(parseFile('uv.lock', lock, { 'pyproject.toml': '[project]\ndependencies = ["pyyaml>=6"]\n' }).packages).toEqual([{ name: 'pyyaml', version: '6.0.1', direct: true }]);
    expect(parseFile('Cargo.lock', '[[package]]\nname = "serde"\nversion = "1.0.200"\n').ecosystem).toBe('cargo');
  });

  it('go.mod with direct and indirect requires', () => {
    const t = parseFile('go.mod', 'module x\n\nrequire github.com/gin-gonic/gin v1.9.0\n\nrequire (\n\tgolang.org/x/net v0.20.0 // indirect\n)\n');
    expect(t.packages).toEqual([
      { name: 'github.com/gin-gonic/gin', version: 'v1.9.0', direct: true },
      { name: 'golang.org/x/net', version: 'v0.20.0', direct: false },
    ]);
  });

  it('Gemfile.lock and NuGet packages.lock.json', () => {
    const gem = 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.2.8)\n    rails (7.1.0)\n      rack (>= 2.2.4)\n\nDEPENDENCIES\n  rails (~> 7.1)\n';
    expect(parseFile('Gemfile.lock', gem).packages).toEqual([
      { name: 'rack', version: '2.2.8', direct: false },
      { name: 'rails', version: '7.1.0', direct: true },
    ]);
    const nuget = JSON.stringify({ version: 1, dependencies: { 'net8.0': { 'Newtonsoft.Json': { type: 'Direct', resolved: '12.0.1' }, X: { type: 'Transitive', resolved: '1.0.0' } } } });
    expect(parseFile('packages.lock.json', nuget).packages).toEqual([
      { name: 'Newtonsoft.Json', version: '12.0.1', direct: true },
      { name: 'X', version: '1.0.0', direct: false },
    ]);
  });

  it('manifests: package.json, pyproject.toml, Cargo.toml', () => {
    expect(parseFile('package.json', '{"dependencies":{"a":"^1"},"devDependencies":{"b":"2"}}').declared).toEqual([
      { name: 'a', spec: '^1' },
      { name: 'b', spec: '2', dev: true },
    ]);
    expect(parseFile('pyproject.toml', '[project]\ndependencies = [\n  "Django>=5,<6",\n  "httpx[http2]==0.27.0",\n]\n').declared).toEqual([
      { name: 'django', spec: '>=5,<6' },
      { name: 'httpx', spec: '==0.27.0' },
    ]);
    expect(parseFile('Cargo.toml', '[dependencies]\nserde = { version = "1.0", features = ["derive"] }\ntokio = "1"\nlocal = { path = "../x" }\n').declared).toEqual([
      { name: 'serde', spec: '1.0', dev: false },
      { name: 'tokio', spec: '1', dev: false },
    ]);
  });

  it('refuses files it does not know', () => {
    expect(detectKind('/x/secrets.env')).toBeUndefined();
    expect(() => parseFile('notes.md', '')).toThrow(/Unsupported/);
  });
});
