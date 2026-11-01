/**
 * The verdict, offline: deps.dev and OSV are replaced by fixtures keyed by URL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.PINRIGHT_NO_CACHE = '1';
process.env.PINRIGHT_COOLDOWN_DAYS = '3';

const calls: string[] = [];
const fixtures = new Map<string, unknown>();

vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return {
    ...actual,
    getJson: vi.fn(async (url: string, opts?: { body?: { version?: string } }) => {
      calls.push(url);
      const key = [...fixtures.keys()].find((k) => url.includes(k));
      if (!key) throw new actual.HttpError(404, url);
      const v = fixtures.get(key);
      if (v instanceof Error) throw v;
      // Like OSV: a version query only returns the vulns whose ranges contain that version.
      const version = opts?.body?.version;
      if (version && v && typeof v === 'object' && 'vulns' in v) {
        const semver = (await import('semver')).default;
        const vulns = (v as { vulns: { affected?: { ranges?: { events: { fixed?: string }[] }[] }[] }[] }).vulns.filter((x) => {
          const fixed = x.affected?.flatMap((a) => a.ranges ?? []).flatMap((r) => r.events).find((e) => e.fixed)?.fixed;
          return !fixed || semver.lt(version, fixed);
        });
        return { vulns };
      }
      return v;
    }),
  };
});

const { assessPackage, compareVersionsDesc, dedupeAdvisories, isPrerelease, recommendedUpgrade } = await import('../src/advisories/resolve.js');
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

  it('every release deprecated: deprecated with the reason, not "no version is free of advisories"', async () => {
    // Found in QA: check npm left-pad said "no recent stable version is free of known advisories" (it has none).
    const dep = { isDeprecated: true, deprecatedReason: 'use String.prototype.padStart()' };
    seedLib({ versions: [version('1.2.0', dep), version('1.3.0', { ...dep, isDefault: true })], advisories: {} });
    const r = await assessPackage('npm', 'lib');
    expect(r.verdict).toBe('deprecated');
    expect(r.deprecatedReason).toBe('use String.prototype.padStart()');
    const { securityNotice } = await import('../src/format.js');
    expect(securityNotice(r)).toMatch(/^NOTICE: lib \(npm\) \(every release\) is deprecated by its maintainers: use String\.prototype\.padStart\(\)/);
    // A pinned version with advisories still leads with them (request@2.88.2).
    seedLib({ versions: [version('1.2.0', dep), version('1.3.0', { ...dep, isDefault: true })], advisories: { '1.3.0': ['GHSA-req'] } });
    expect((await assessPackage('npm', 'lib', '1.3.0')).verdict).toBe('vulnerable');
    const unpinned = await assessPackage('npm', 'lib');
    expect(unpinned.verdict).toBe('vulnerable');
    expect(securityNotice(unpinned)).toContain('free of known advisories. Every release is deprecated by its maintainers: use String.prototype.padStart()');
  });

  it('calls out malware above everything else', async () => {
    seedLib({ versions: [version('3.3.6'), version('4.0.1', { isDefault: true })], advisories: { '3.3.6': ['MAL-2018-1'] } });
    const r = await assessPackage('npm', 'lib', '3.3.6');
    expect(r.verdict).toBe('malicious');
    expect(r.safeVersion).toBe('4.0.1');
  });

  it('calls out malware when every version is malicious, not just "vulnerable" (security review F3)', async () => {
    seedLib({ versions: [version('1.0.0'), version('1.0.1', { isDefault: true })], advisories: { '1.0.0': ['MAL-2026-7'], '1.0.1': ['MAL-2026-7'] } });
    const r = await assessPackage('npm', 'lib', '1.0.1');
    expect(r.requested?.verdict).toBe('malicious');
    expect(r.verdict).toBe('malicious');
  });

  it('calls out malware even when a source failed while scanning for a safe version', async () => {
    seedLib({ versions: [version('1.0.0'), version('1.0.1', { isDefault: true })], advisories: { '1.0.0': ['MAL-2026-7'] } });
    // The scan for a safe version starts at 1.0.1 and fails there; the requested 1.0.0 still reads fine.
    fixtures.set('/v3/systems/npm/packages/lib/versions/1.0.1', new HttpError(503, 'deps.dev'));
    const r = await assessPackage('npm', 'lib', '1.0.0');
    expect(r.verdict).toBe('malicious');
  });

  it('a version that was never published is reported even when no version is clean', async () => {
    // Before seedLib: the fixture lookup takes the first key the URL contains.
    fixtures.set('/v3/systems/npm/packages/lib/versions/9.9.9', new HttpError(404, 'deps.dev'));
    seedLib({ versions: [version('1.0.0', { isDefault: true })], advisories: { '1.0.0': ['GHSA-x'] } });
    const r = await assessPackage('npm', 'lib', '9.9.9');
    expect(r.verdict).toBe('unknown-package');
  });

  it('go: a pinned module version is looked up with its "v", not reported as never published', async () => {
    const mod = 'github.com/acme/web';
    const goVersion = (v: string, isDefault = false) => ({ versionKey: { system: 'GO', name: mod, version: v }, publishedAt: daysAgo(100), isDefault, isDeprecated: false });
    const path = `/v3/systems/go/packages/${encodeURIComponent(mod)}`;
    fixtures.set(`${path}/versions/v1.6.0`, { ...goVersion('v1.6.0'), licenses: ['MIT'], advisoryKeys: [{ id: 'GHSA-gogo' }] });
    fixtures.set(`${path}/versions/v1.12.0`, { ...goVersion('v1.12.0', true), licenses: ['MIT'], advisoryKeys: [] });
    fixtures.set(path, { packageKey: { system: 'GO', name: mod }, versions: [goVersion('v1.6.0'), goVersion('v1.12.0', true)] });
    // Every caller strips the "v" (the hook, check-package, the CLI); deps.dev answers 404 without it.
    const old = await assessPackage('go', mod, '1.6.0');
    expect(old.requested?.verdict).toBe('vulnerable');
    expect(old.safeVersion).toBe('v1.12.0');
    const fixed = await assessPackage('go', mod, 'v1.12.0');
    expect(fixed.requested?.verdict).toBe('ok');
    expect(calls.some((u) => u.endsWith('/versions/1.6.0'))).toBe(false);
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

describe('same release line', () => {
  it('recommends the newest clean version on the line the project uses, and the overall one apart', async () => {
    seedLib({
      versions: [version('3.9.0'), version('3.10.0'), version('3.11.0'), version('4.0.0'), version('4.1.0', { isDefault: true })],
      advisories: { '3.9.0': ['GHSA-a'], '3.11.0': ['GHSA-b'] },
    });
    const r = await assessPackage('npm', 'lib', '3.9.0');
    expect(r.line).toBe('3.x');
    expect(r.safeVersionSameLine).toBe('3.10.0');
    expect(r.safeVersion).toBe('4.1.0');
    expect(r.crossLineRequired).toBe(false);
  });

  it('flags when only a new major is clean; 0.x minors are their own line', async () => {
    seedLib({ versions: [version('0.27.0'), version('0.28.0'), version('1.0.0', { isDefault: true })], advisories: { '0.27.0': ['GHSA-a'], '0.28.0': ['GHSA-a'] } });
    const r = await assessPackage('npm', 'lib', '0.27.0');
    expect(r.line).toBe('0.27.x');
    expect(r.safeVersionSameLine).toBeUndefined();
    expect(r.crossLineRequired).toBe(true);
    expect(r.safeVersion).toBe('1.0.0');
    expect(r.safeVersionNearestLine).toBeUndefined();
  });
});

describe('nearest newer line', () => {
  function seed(eco: 'npm' | 'pypi' | 'maven', name: string, list: string[], dirty: string[], newest: string) {
    const versions = list.map((v) => ({ ...version(v, { isDefault: v === newest }), versionKey: { system: eco.toUpperCase(), name, version: v } }));
    for (const v of versions) {
      fixtures.set(`/v3/systems/${eco}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(v.versionKey.version)}`, {
        ...v,
        licenses: ['MIT'],
        advisoryKeys: dirty.includes(v.versionKey.version) ? [{ id: 'GHSA-x' }] : [],
      });
    }
    fixtures.set(`/v3/systems/${eco}/packages/${encodeURIComponent(name)}`, { packageKey: { system: eco.toUpperCase(), name }, versions });
  }

  it('maven: a fix on an older maintained major beats the newest major (spring-core 5.3 -> 6.2, not 7.0)', async () => {
    seed('maven', 'org.springframework:spring-core', ['5.3.20', '5.3.39', '6.1.14', '6.2.18', '6.2.19', '7.0.9', '7.0.10'], ['5.3.20', '5.3.39', '6.1.14', '6.2.18'], '7.0.10');
    const r = await assessPackage('maven', 'org.springframework:spring-core', '5.3.20');
    expect(r.line).toBe('5.x');
    expect(r.crossLineRequired).toBe(true);
    expect(r.safeVersion).toBe('7.0.10');
    expect(r.safeVersionNearestLine).toBe('6.2.19');
    expect(r.nearestLine).toBe('6.x');
  });

  it('npm: skips intermediate lines with no clean release and stops at the first one that has it', async () => {
    seed('npm', 'lib', ['13.5.6', '14.2.0', '15.5.0', '15.5.1', '16.0.0'], ['13.5.6', '14.2.0', '15.5.1'], '16.0.0');
    const r = await assessPackage('npm', 'lib', '13.5.6');
    expect(r.safeVersionNearestLine).toBe('15.5.0');
    expect(r.nearestLine).toBe('15.x');
  });

  it('pypi: no nearest line when the only clean release is on the newest one', async () => {
    seed('pypi', 'django', ['3.2.25', '4.2.20', '5.2.1'], ['3.2.25', '4.2.20'], '5.2.1');
    const r = await assessPackage('pypi', 'django', '3.2.25');
    expect(r.safeVersion).toBe('5.2.1');
    expect(r.safeVersionNearestLine).toBeUndefined();
  });

  it('pypi: a clean 4.2 LTS is preferred over 5.x for a 3.2 project', async () => {
    seed('pypi', 'django', ['3.2.25', '4.2.20', '4.2.21', '5.2.1'], ['3.2.25', '4.2.20'], '5.2.1');
    const r = await assessPackage('pypi', 'django', '3.2.25');
    expect(r.safeVersionNearestLine).toBe('4.2.21');
    expect(recommendedUpgrade(r)).toBe('4.2.21');
  });

  it('keeps the same-line fix first when there is one', async () => {
    seed('npm', 'lib', ['1.0.0', '1.0.1', '2.0.0', '3.0.0'], ['1.0.0'], '3.0.0');
    const r = await assessPackage('npm', 'lib', '1.0.0');
    expect(r.safeVersionSameLine).toBe('1.0.1');
    expect(r.safeVersionNearestLine).toBeUndefined();
    expect(recommendedUpgrade(r)).toBe('1.0.1');
  });
});

describe('least exposed version', () => {
  it('when nothing is clean, picks the version whose worst advisory is mildest', async () => {
    seedLib({ versions: [version('1.0.0'), version('1.1.0'), version('1.2.0', { isDefault: true })], advisories: { '1.0.0': ['GHSA-a'], '1.1.0': ['GHSA-b'], '1.2.0': ['GHSA-a'] } });
    fixtures.set('/v1/query', {
      vulns: [
        { id: 'GHSA-a', database_specific: { severity: 'HIGH' }, affected: [{ ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }] },
      ],
    });
    // Every version matches GHSA-a in this mock, so the newest wins the tie on severity and count.
    const r = await assessPackage('npm', 'lib');
    expect(r.safeVersion).toBeUndefined();
    expect(r.leastExposed).toEqual({ version: '1.2.0', advisories: 1, maxSeverity: 'HIGH' });
  });
});

describe('brand-new packages', () => {
  it('every release inside the cooldown: no advisory means not vulnerable, just nothing recommended yet', async () => {
    seedLib({ versions: [version('0.1.0', { publishedAt: daysAgo(1) }), version('0.1.1', { publishedAt: daysAgo(0), isDefault: true })], advisories: {} });
    const r = await assessPackage('npm', 'lib');
    expect(r.verdict).toBe('ok');
    expect(r.cooldownOnly).toBe(true);
    expect(r.safeVersion).toBeUndefined();
    expect(r.reason).toMatch(/younger than the 3-day cooldown/);
  });
});
