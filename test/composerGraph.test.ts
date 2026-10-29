/**
 * Composer dependency graphs from Packagist metadata, offline. The guzzle family
 * comes from real p2 files recorded on 2026-10-29 (trimmed to a few versions,
 * still minified); the edge cases use small hand-written packages.
 */
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SAFECTX_NO_CACHE = '1';

const recorded = JSON.parse(fs.readFileSync(new URL('./fixtures/packagist-guzzle.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const extra = new Map<string, unknown>();
const calls: string[] = [];

vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return {
    ...actual,
    getJson: vi.fn(async (url: string) => {
      calls.push(url);
      const m = url.match(/\/p2\/(.+)\.json$/);
      const body = m ? (extra.get(m[1]) ?? recorded[m[1]]) : undefined;
      if (!body) throw new actual.HttpError(404, url);
      return body;
    }),
  };
});

const { packagistDependencies, pickRequirement } = await import('../src/composer/graph.js');
const { getDependencies } = await import('../src/advisories/depsdev.js');
const { resolveManifest } = await import('../src/tree/resolveManifest.js');
const { satisfiesRequirement } = await import('../src/hook/policy.js');
const { parseFile } = await import('../src/tree/lockfiles.js');

const pkg = (name: string, entries: Record<string, unknown>[]) => extra.set(name, { packages: { [name]: entries.map((e) => ({ name, ...e })) } });
const byName = (g: { nodes: { versionKey: { name: string; version: string } }[] }) => Object.fromEntries(g.nodes.slice(1).map((n) => [n.versionKey.name, n.versionKey.version]));

beforeEach(() => {
  extra.clear();
  calls.length = 0;
});

describe('packagistDependencies', () => {
  it('resolves guzzle 7.9.2 like deps.dev would: newest match per requirement, platform and virtual packages skipped', async () => {
    const g = await packagistDependencies('guzzlehttp/guzzle', '7.9.2');
    expect(g?.nodes[0]).toMatchObject({ versionKey: { name: 'guzzlehttp/guzzle', version: '7.9.2' }, relation: 'SELF' });
    expect(byName(g!)).toEqual({
      'guzzlehttp/promises': '2.0.4',
      'guzzlehttp/psr7': '2.7.0',
      'psr/http-client': '1.0.3',
      'symfony/deprecation-contracts': '3.5.0',
      'psr/http-factory': '1.1.0',
      'psr/http-message': '2.0',
      'ralouphie/getallheaders': '3.0.3',
    });
    const direct = g!.edges.filter((e) => e.fromNode === 0).map((e) => [g!.nodes[e.toNode].versionKey.name, e.requirement]);
    expect(direct).toContainEqual(['guzzlehttp/psr7', '^2.7.0']);
    expect(direct).toContainEqual(['guzzlehttp/promises', '^1.5.3 || ^2.0.3']);
    expect(g!.nodes.find((n) => n.versionKey.name === 'psr/http-message')?.relation).toBe('INDIRECT');
    // php and ext-json are platform packages: never fetched.
    expect(calls.some((u) => /\/p2\/(php|ext-json)\.json/.test(u))).toBe(false);
    // Each package's metadata is fetched once per graph.
    expect(new Set(calls).size).toBe(calls.length);
  });

  it('an older major resolves to the older lines its constraints allow', async () => {
    const g = await packagistDependencies('guzzlehttp/guzzle', '6.5.8');
    const deps = byName(g!);
    expect(deps['guzzlehttp/psr7']).toBe('1.9.1');
    expect(deps['guzzlehttp/promises']).toBe('1.5.3');
    expect(deps['psr/http-message']).toBe('1.1');
    expect(deps['symfony/polyfill-intl-idn']).toBe('1.31.0');
  });

  it('is what getDependencies returns for composer', async () => {
    const g = await getDependencies('composer', 'guzzlehttp/guzzle', '7.9.2');
    expect(byName(g!)['guzzlehttp/psr7']).toBe('2.7.0');
    expect(await getDependencies('composer', 'guzzlehttp/guzzle', '9.9.9')).toBeUndefined();
  });

  it('self.version, replaced names, unknown packages and stability flags', async () => {
    pkg('acme/app', [{ version: '1.2.0', require: { 'acme/core': 'self.version', 'acme/legacy': '^1.0', 'nobody/missing': '^1.0', 'acme/edge': '^2.0@beta', 'acme/plain': '^2.0' } }]);
    pkg('acme/core', [{ version: '1.3.0' }, { version: '1.2.0', replace: { 'acme/legacy': 'self.version' } }]);
    pkg('acme/legacy', [{ version: '1.0.0' }]);
    pkg('acme/edge', [{ version: '2.0.0-beta2' }, { version: '1.0.0' }]);
    pkg('acme/plain', [{ version: '2.1.0-RC1' }, { version: '2.0.0' }]);
    const deps = byName((await packagistDependencies('acme/app', '1.2.0'))!);
    expect(deps['acme/core']).toBe('1.2.0'); // self.version is the parent's version, not the newest
    expect(deps['acme/legacy']).toBeUndefined(); // acme/core replaces it
    expect(deps['nobody/missing']).toBeUndefined();
    expect(deps['acme/edge']).toBe('2.0.0-beta2'); // @beta lets a beta in
    expect(deps['acme/plain']).toBe('2.0.0'); // without a flag, only stable releases
  });

  it('pickRequirement: newest stable, unstable only when asked', () => {
    const rel = ['3.0.0-RC1', '2.5.0', '2.4.0'].map((version) => ({ version }));
    expect(pickRequirement('^2.0', rel)).toBe('2.5.0');
    expect(pickRequirement('^3.0', rel)).toBeUndefined();
    expect(pickRequirement('^3.0@RC', rel)).toBe('3.0.0-RC1');
    expect(pickRequirement('self.version', rel, '2.4.0')).toBe('2.4.0');
  });
});

describe('composer.json without a lock', () => {
  it('check-manifest resolves the transitive tree with paths', async () => {
    const tree = parseFile('composer.json', JSON.stringify({ require: { php: '^8.2', 'guzzlehttp/guzzle': '^7.8' } }));
    const notes: string[] = [];
    const packages = await resolveManifest(tree, notes);
    expect(notes).toEqual([]);
    expect(packages.find((p) => p.name === 'guzzlehttp/guzzle')).toMatchObject({ version: '7.9.2', direct: true });
    expect(packages.find((p) => p.name === 'psr/http-message')).toMatchObject({ version: '2.0', direct: false, path: ['guzzlehttp/guzzle', 'guzzlehttp/psr7', 'psr/http-message'] });
  });
});

describe('satisfiesRequirement for composer', () => {
  it('reads Composer constraints, so a pin outside the parent range is a conflict', () => {
    expect(satisfiesRequirement('composer', '1.8.0', '^2.7.0')).toBe(false);
    expect(satisfiesRequirement('composer', '2.0.4', '^1.5.3 || ^2.0.3')).toBe(true);
    expect(satisfiesRequirement('composer', '1.2.0', 'self.version')).toBe(true);
    expect(satisfiesRequirement('composer', '1.0.0', 'dev-main')).toBeUndefined();
  });
});
