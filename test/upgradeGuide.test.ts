/**
 * upgradeGuide end to end, offline: deps.dev, OSV, the npm registry, jsDelivr and
 * GitHub are replaced by fixtures keyed by URL (the longest matching key wins).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.PINRIGHT_NO_CACHE = '1';
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

const fixtures = new Map<string, unknown>();
const calls: string[] = [];

function lookup(url: string): unknown {
  const key = [...fixtures.keys()].filter((k) => url.includes(k)).sort((a, b) => b.length - a.length)[0];
  return key === undefined ? undefined : fixtures.get(key);
}

vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  const get = (url: string, opts?: { body?: { version?: string } }) => {
    calls.push(url);
    const v = url.includes('/v1/query') ? (fixtures.get(`osv:${opts?.body?.version}`) ?? { vulns: [] }) : lookup(url);
    if (v === undefined) throw new actual.HttpError(404, url);
    if (v instanceof Error) throw v;
    return v;
  };
  return {
    ...actual,
    getJson: vi.fn(async (url: string, opts?: { body?: { version?: string } }) => get(url, opts)),
    getText: vi.fn(async (url: string) => {
      const v = get(url);
      return typeof v === 'string' ? v : JSON.stringify(v);
    }),
  };
});

const { upgradeGuide } = await import('../src/upgrade/index.js');

const DAY = 86_400_000;
const ago = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const ver = (v: string, days: number, extra: Record<string, unknown> = {}) => ({ versionKey: { system: 'NPM', name: 'lib', version: v }, publishedAt: ago(days), ...extra });

const CHANGELOG = `# Changelog

## 2.1.0
### Features
- Add \`newThing\`

## 2.0.0
### Breaking Changes
- Removed \`oldFn\`; use \`newFn\` instead
- Node 18 is no longer supported
- Middleware moved to a separate package \`@lib/middleware\`

### Deprecations
- \`legacyOption\` is deprecated

## 1.2.0
- Fix a crash
`;

const GUIDE = `# Migrating to v2

## Rename \`oldFn\` to \`newFn\`

Call \`newFn\` everywhere. ${'More words about the rename. '.repeat(20)}

## Config defaults changed

The \`strict\` option now defaults to true.
`;

function seed() {
  const versions = [ver('1.0.0', 900), ver('1.2.0', 400), ver('2.0.0', 200), ver('2.1.0', 100, { isDefault: true })];
  fixtures.set('/v3/systems/npm/packages/lib', { packageKey: { system: 'NPM', name: 'lib' }, versions });
  for (const v of versions) {
    const vulnerable = v.versionKey.version.startsWith('1.');
    fixtures.set(`/v3/systems/npm/packages/lib/versions/${v.versionKey.version}`, { ...v, licenses: ['MIT'], advisoryKeys: vulnerable ? [{ id: 'GHSA-aaaa' }] : [] });
  }
  const vuln = { vulns: [{ id: 'GHSA-aaaa', summary: 'Prototype pollution', aliases: ['CVE-2026-1'], database_specific: { severity: 'HIGH' },
    affected: [{ package: { name: 'lib', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.0.0' }] }] }] }] };
  fixtures.set('osv:1.0.0', vuln);
  fixtures.set('osv:1.2.0', vuln);
  fixtures.set('registry.npmjs.org/lib/2.1.0', { repository: { url: 'git+https://github.com/acme/lib.git' }, homepage: 'https://github.com/acme/lib', types: 'index.d.ts' });
  fixtures.set('data.jsdelivr.com/v1/packages/npm/lib@2.1.0', { files: [
    { name: '/package.json', size: 100 }, { name: '/CHANGELOG.md', size: CHANGELOG.length }, { name: '/index.d.ts', size: 200 }, { name: '/docs/migrating-to-v2.md', size: GUIDE.length },
  ] });
  fixtures.set('data.jsdelivr.com/v1/packages/npm/lib@1.2.0', { files: [{ name: '/package.json', size: 100 }, { name: '/index.d.ts', size: 200 }] });
  fixtures.set('cdn.jsdelivr.net/npm/lib@2.1.0/package.json', { name: 'lib', types: 'index.d.ts' });
  fixtures.set('cdn.jsdelivr.net/npm/lib@1.2.0/package.json', { name: 'lib', types: 'index.d.ts' });
  fixtures.set('cdn.jsdelivr.net/npm/lib@1.2.0/index.d.ts', 'export declare function oldFn(a: string): void;\nexport declare function parse(s: string): number;\n');
  fixtures.set('cdn.jsdelivr.net/npm/lib@2.1.0/index.d.ts', 'export declare function newFn(a: string): void;\nexport declare function parse(s: string, strict?: boolean): number;\n');
  fixtures.set('cdn.jsdelivr.net/npm/lib@2.1.0/CHANGELOG.md', CHANGELOG);
  fixtures.set('cdn.jsdelivr.net/npm/lib@2.1.0/docs/migrating-to-v2.md', GUIDE);
  fixtures.set('api.github.com/repos/acme/lib/releases', []);
}

beforeEach(() => {
  fixtures.clear();
  calls.length = 0;
  seed();
});

describe('upgradeGuide', () => {
  it('defaults "to" to the recommended version and reports breaking changes, the API diff, the guide and fixed advisories', async () => {
    const r = await upgradeGuide({ ecosystem: 'npm', name: 'lib', from: '1.2.0' });
    expect(r.to).toBe('2.1.0');
    expect(r.crossesMajor).toBe(true);
    const t = r.text;
    expect(t).toMatch(/^Upgrade guide: lib \(npm\) 1\.2\.0 -> 2\.1\.0 \(recommended/);
    expect(t).toContain('expect breaking changes');
    expect(t).toMatch(/Fixed by moving to 2\.1\.0:\n {2}- GHSA-aaaa \(CVE-2026-1\) \[HIGH\]: Prototype pollution/);
    expect(t).toContain('- BREAKING: Removed `oldFn`; use `newFn` instead');
    expect(t).toContain('- NEW PACKAGE: Middleware moved to a separate package `@lib/middleware`');
    expect(t).toContain('2.0.0, CHANGELOG.md (lib@2.1.0) https://cdn.jsdelivr.net/npm/lib@2.1.0/CHANGELOG.md');
    expect(t).toMatch(/- BREAKING: removed: oldFn \(function\)/);
    expect(t).toMatch(/changed function parse:\n {2}before: function parse\(s:string\):number/);
    expect(t).toContain('### Migrating to v2 > Rename `oldFn` to `newFn`');
    expect(t).toContain('- DEPRECATED: `legacyOption` is deprecated');
    expect(t).not.toContain('newThing');
    expect(t).not.toContain('Fix a crash');
  });

  it('ranks entries about the query and keeps the answer within the budget', async () => {
    const small = await upgradeGuide({ ecosystem: 'npm', name: 'lib', from: '1.2.0', to: '2.x', budgetChars: 600 });
    const big = await upgradeGuide({ ecosystem: 'npm', name: 'lib', from: '1.2.0', to: '2.x', budgetChars: 20_000 });
    expect(small.to).toBe('2.1.0');
    expect(small.text.length).toBeLessThan(big.text.length);
    // Header, security, footer and the untrusted-data fences (about 100 characters each) are fixed; the sections share the budget.
    expect(small.text.length).toBeLessThan(600 + 1400);
    expect(small.text).toContain('- BREAKING: Removed `oldFn`');
    const q = await upgradeGuide({ ecosystem: 'npm', name: 'lib', from: '1.2.0', to: '2.1.0', query: 'newThing' });
    expect(q.text).toContain('## Other changes matching "newThing"');
  });

  it('never calls a version safe it could not check', async () => {
    fixtures.set('/v3/systems/npm/packages/lib/versions/2.1.0', new Error('deps.dev down'));
    const r = await upgradeGuide({ ecosystem: 'npm', name: 'lib', from: '1.2.0', to: '2.1.0' });
    expect(r.text).toContain('could not check 2.1.0');
    expect(r.text).not.toMatch(/2\.1\.0 has none/);
  });

  it('refuses a target that is not newer, and an unknown version', async () => {
    expect((await upgradeGuide({ ecosystem: 'npm', name: 'lib', from: '2.1.0', to: '1.2.0' })).text).toMatch(/not newer/);
    expect((await upgradeGuide({ ecosystem: 'npm', name: 'lib', from: '9.9.9' })).text).toMatch(/no published version matching "9\.9\.9"/);
  });

  it('degrades without GitHub: the rest of the guide still comes back', async () => {
    fixtures.set('api.github.com', new Error('network down'));
    const r = await upgradeGuide({ ecosystem: 'npm', name: 'lib', from: '1.2.0', to: '2.1.0' });
    expect(r.text).toContain('- BREAKING: Removed `oldFn`');
    expect(r.text).toContain('0 GitHub releases');
  });
});
