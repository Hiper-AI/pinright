/**
 * The verdict, offline: deps.dev and OSV are replaced by fixtures keyed by URL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SAFECTX_NO_CACHE = '1';
process.env.SAFECTX_COOLDOWN_DAYS = '3';

const calls: string[] = [];
const fixtures = new Map<string, unknown>();

vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return {
    ...actual,
    getJson: vi.fn(async (url: string) => {
      calls.push(url);
      const key = [...fixtures.keys()].find((k) => url.includes(k));
      if (!key) throw new actual.HttpError(404, url);
      const v = fixtures.get(key);
      if (v instanceof Error) throw v;
      return v;
    }),
  };
});

const { assessPackage, compareVersionsDesc, dedupeAdvisories, isPrerelease } = await import('../src/advisories/resolve.js');
const { HttpError } = await import('../src/http.js');

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function version(v: string, extra: Partial<{ publishedAt: string; isDefault: boolean; isDeprecated: boolean; deprecatedReason: string }> = {}) {
  return { versionKey: { system: 'NPM', name: 'lib', version: v }, publishedAt: daysAgo(100), isDefault: false, isDeprecated: false, ...extra };
}

function seedLib(opts: { advisories: Record<string, string[]>; versions: ReturnType<typeof version>[] }) {
  fixtures.set('/v3/systems/npm/packages/lib"', undefined); // placeholder to keep ordering simple
  fixtures.delete('/v3/systems/npm/packages/lib"');
  fixtures.set('/v3/systems/npm/packages/lib/versions/', null); // matched after specific versions below
  fixtures.delete('/v3/systems/npm/packages/lib/versions/');
  for (const v of opts.versions) {
    fixtures.set(`/v3/systems/npm/packages/lib/versions/${encodeURIComponent(v.versionKey.version)}`, {
      ...v,
      licenses: ['MIT'],
      advisoryKeys: (opts.advisories[v.versionKey.version] ?? []).map((id) => ({ id })),
    });
  }
  fixtures.set('/v3/systems/npm/packages/lib', { packageKey: { system: 'NPM', name: 'lib' }, versions: opts.versions });
}

beforeEach(() => {
  calls.length = 0;
  fixtures.clear();
  fixtures.set('/v1/query', { vulns: [] });
});

describe('assessPackage', () => {
  it('recommends the newest stable version with no advisory and flags the requested one', async () => {
    seedLib({
      versions: [version('1.0.0'), version('1.1.0'), version('1.2.0', { isDefault: true })],
      advisories: { '1.0.0': ['GHSA-aaaa'], '1.1.0': ['GHSA-aaaa'] },
    });
    fixtures.set('/v1/query', {
      vulns: [{ id: 'GHSA-aaaa', summary: 'Bad thing', aliases: ['CVE-2024-1'], database_specific: { severity: 'HIGH' },
        affected: [{ package: { name: 'lib', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.0' }] }] }] }],
    });
    const r = await assessPackage('npm', 'lib', '1.0.0');
    expect(r.verdict).toBe('vulnerable');
    expect(r.safeVersion).toBe('1.2.0');
    expect(r.latestVersion).toBe('1.2.0');
    expect(r.requested?.advisories[0]).toMatchObject({ id: 'GHSA-aaaa', aliases: ['CVE-2024-1'], fixedIn: ['1.2.0'], severity: 'HIGH' });
  });

  it('skips versions inside the cooldown window and pre-releases', async () => {
    seedLib({
      versions: [version('2.0.0'), version('2.1.0', { publishedAt: daysAgo(1), isDefault: true }), version('3.0.0-rc.1', { publishedAt: daysAgo(30) })],
      advisories: {},
    });
    const r = await assessPackage('npm', 'lib');
    expect(r.verdict).toBe('ok');
    expect(r.safeVersion).toBe('2.0.0');
    expect(r.latestVersion).toBe('2.1.0');
  });

  it('skips deprecated versions when looking for a safe one', async () => {
    seedLib({ versions: [version('1.0.0'), version('1.1.0', { isDeprecated: true, deprecatedReason: 'security', isDefault: true })], advisories: {} });
    const r = await assessPackage('npm', 'lib', '1.1.0');
    expect(r.safeVersion).toBe('1.0.0');
    expect(r.verdict).toBe('deprecated');
  });

  it('calls out malware above everything else', async () => {
    seedLib({ versions: [version('3.3.6'), version('4.0.1', { isDefault: true })], advisories: { '3.3.6': ['MAL-2018-1'] } });
    const r = await assessPackage('npm', 'lib', '3.3.6');
    expect(r.verdict).toBe('malicious');
    expect(r.safeVersion).toBe('4.0.1');
  });

  it('says unknown-package when deps.dev has never seen it', async () => {
    const r = await assessPackage('npm', 'lib');
    expect(r.verdict).toBe('unknown-package');
    expect(r.safeVersion).toBeUndefined();
  });

  it('says unknown, never ok, when deps.dev is down', async () => {
    fixtures.set('/v3/systems/npm/packages/lib', new HttpError(503, 'deps.dev'));
    const r = await assessPackage('npm', 'lib');
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toMatch(/deps.dev/);
  });

  it('says vulnerable when every recent stable version carries an advisory', async () => {
    seedLib({ versions: [version('1.0.0'), version('1.1.0', { isDefault: true })], advisories: { '1.0.0': ['GHSA-x'], '1.1.0': ['GHSA-x'] } });
    const r = await assessPackage('npm', 'lib');
    expect(r.verdict).toBe('vulnerable');
    expect(r.safeVersion).toBeUndefined();
  });

  it('bounds the number of versions it inspects', async () => {
    const versions = Array.from({ length: 40 }, (_, i) => version(`1.${i}.0`, { isDefault: i === 39 }));
    const advisories = Object.fromEntries(versions.map((v) => [v.versionKey.version, ['GHSA-x']]));
    seedLib({ versions, advisories });
    await assessPackage('npm', 'lib');
    const versionCalls = calls.filter((u) => u.includes('/versions/'));
    expect(versionCalls.length).toBeLessThanOrEqual(12);
  });
});

describe('isPrerelease', () => {
  it('treats rc, canary, dev builds, Go pseudo-versions and +incompatible tags as not releasable', () => {
    for (const v of ['3.0.0-rc.1', '15.4.0-canary.82', '1.0.0.dev6', '8.0.0-rc.28', 'v0.0.0-20190210073940-906799fef2f8', 'v3.3.10+incompatible', 'v3.3.5-retag.0.20180829034922-90822319eb61+incompatible']) {
      expect(isPrerelease(v), v).toBe(true);
    }
    for (const v of ['1.2.3', 'v1.25.12', '2.32.4', '16.4.3', '6.1']) expect(isPrerelease(v), v).toBe(false);
  });
});

describe('compareVersionsDesc', () => {
  it('orders by semver, newest first, and falls back to publish date', () => {
    const list = [version('1.10.0'), version('1.9.0'), version('2.0.0')];
    expect(list.sort(compareVersionsDesc).map((v) => v.versionKey.version)).toEqual(['2.0.0', '1.10.0', '1.9.0']);
  });
});

describe('dedupeAdvisories', () => {
  it('keeps one record per CVE, preferring GHSA with a title, worst first', () => {
    const out = dedupeAdvisories([
      { id: 'PYSEC-2026-1', aliases: ['CVE-2024-1'], title: undefined, fixedIn: ['2.0'], url: '' },
      { id: 'GHSA-abc', aliases: ['CVE-2024-1'], title: 'Leak', severity: 'MODERATE', url: '' },
      { id: 'GHSA-def', aliases: ['CVE-2024-2'], title: 'RCE', severity: 'CRITICAL', url: '' },
      { id: 'MAL-2026-9', aliases: [], title: 'malware', url: '' },
    ]);
    expect(out.map((a) => a.id)).toEqual(['MAL-2026-9', 'GHSA-def', 'GHSA-abc']);
    expect(out[2].fixedIn).toEqual(['2.0']);
  });
});
