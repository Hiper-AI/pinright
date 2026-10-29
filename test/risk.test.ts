/**
 * Risk signals: the pure rules, the fact extraction from registry documents,
 * the gathering with every upstream mocked, the hook rule and the rendering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/http.js';

const http = new Map<string, unknown>(); // url -> body, or an Error to throw
const ddPackages = new Map<string, { versionKey: { version: string }; publishedAt?: string }[]>();
const ddVersions = new Map<string, unknown>();
const ddProjects = new Map<string, unknown>();

vi.mock('../src/cache.js', () => ({ cached: (_k: string, _t: number, load: () => Promise<unknown>) => load() }));
vi.mock('../src/http.js', async (orig) => ({
  ...(await orig<typeof import('../src/http.js')>()),
  getJson: vi.fn(async (url: string) => {
    const body = http.get(url);
    if (body instanceof Error) throw body;
    if (body === undefined) throw new HttpError(404, url);
    return body;
  }),
}));
vi.mock('../src/advisories/depsdev.js', () => ({
  getPackage: vi.fn(async (_eco: string, name: string) => {
    const versions = ddPackages.get(name);
    return versions ? { versions } : undefined;
  }),
  getVersion: vi.fn(async (_eco: string, name: string, version: string) => ddVersions.get(`${name}@${version}`)),
  getProject: vi.fn(async (id: string) => ddProjects.get(id)),
}));

const { riskSignals, riskThresholds } = await import('../src/risk/signals.js');
const { installScriptsOf, versionFactsFromDoc, scorecardFacts } = await import('../src/risk/sources.js');
const { assessRisk, previousVersions, riskLines, riskOutcome } = await import('../src/risk/index.js');

const NOW = Date.parse('2026-10-29T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const ids = (s: { id: string }[]) => s.map((x) => x.id);

beforeEach(() => {
  http.clear();
  ddPackages.clear();
  ddVersions.clear();
  ddProjects.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('riskSignals', () => {
  const old = { firstPublishedAt: daysAgo(2000) };

  it('stays quiet for an established package with nothing unusual', () => {
    const prev = [{ version: '1.0.0', installScripts: [], provenance: true, publisher: 'ci' }];
    const s = riskSignals({ ...old, current: { version: '1.1.0', publishedAt: daysAgo(40), installScripts: [], provenance: true, publisher: 'ci' }, previous: prev, weeklyDownloads: 1e6 }, NOW);
    expect(s).toEqual([]);
  });

  it('notes long-standing install scripts as info', () => {
    const prev = [{ version: '0.27.0', installScripts: ['postinstall: node install.js'], publisher: 'evanw' }];
    const s = riskSignals({ ...old, current: { version: '0.28.0', publishedAt: daysAgo(40), installScripts: ['postinstall: node install.js'], publisher: 'evanw' }, previous: prev }, NOW);
    expect(s).toEqual([{ id: 'install-script', level: 'info', message: 'runs install scripts (postinstall: node install.js)' }]);
  });

  it('flags a brand-new package with install scripts as high', () => {
    const s = riskSignals({ firstPublishedAt: daysAgo(3), current: { version: '1.0.0', publishedAt: daysAgo(3), installScripts: ['postinstall: node x.js'] }, previous: [], weeklyDownloads: 12 }, NOW);
    expect(ids(s)).toEqual(['install-script-new-package', 'young-low-downloads']);
    expect(s[0].level).toBe('high');
    expect(s[0].message).toContain('3 days ago');
  });

  it('flags install scripts added by a new publisher as high', () => {
    const prev = [
      { version: '2.0.1', installScripts: [], publisher: 'alice', maintainers: ['alice'] },
      { version: '2.0.0', installScripts: [], publisher: 'alice', maintainers: ['alice'] },
    ];
    const s = riskSignals({ ...old, current: { version: '2.0.2', publishedAt: daysAgo(1), installScripts: ['preinstall: node setup.js'], publisher: 'mallory', provenance: false }, previous: prev }, NOW);
    expect(ids(s)).toEqual(['install-script-added-new-publisher', 'publisher-change']);
    expect(s[1].level).toBe('warn');
    expect(s[1].message).toContain('not a listed maintainer');
  });

  it('warns when install scripts appear without a publisher change', () => {
    const prev = [{ version: '2.0.0', installScripts: [], publisher: 'alice' }];
    const s = riskSignals({ ...old, current: { version: '2.1.0', publishedAt: daysAgo(1), installScripts: ['install: node-gyp rebuild (binding.gyp)'], publisher: 'alice' }, previous: prev }, NOW);
    expect(s.map((x) => [x.id, x.level])).toEqual([['install-script-added', 'warn']]);
  });

  it('does not call scripts "added" when earlier versions could not be read', () => {
    const s = riskSignals({ ...old, current: { version: '2.1.0', publishedAt: daysAgo(1), installScripts: ['postinstall: x'] }, previous: [] }, NOW);
    expect(ids(s)).toEqual(['install-script']);
  });

  it('treats a publisher change as info when that account was already a maintainer or the release has provenance', () => {
    const prev = [{ version: '1.0.0', publisher: 'alice', maintainers: ['alice', 'bob'] }];
    const bob = riskSignals({ ...old, current: { version: '1.0.1', publishedAt: daysAgo(2), publisher: 'bob' }, previous: prev }, NOW);
    expect(bob.map((x) => [x.id, x.level])).toEqual([['publisher-change', 'info']]);
    const ci = riskSignals({ ...old, current: { version: '1.0.1', publishedAt: daysAgo(2), publisher: 'GitHub Actions', provenance: true }, previous: prev }, NOW);
    expect(ci.map((x) => [x.id, x.level])).toEqual([['publisher-change', 'info']]);
  });

  it('ignores a publisher change on an old release', () => {
    const prev = [{ version: '1.0.0', publisher: 'alice' }];
    expect(riskSignals({ ...old, current: { version: '1.0.1', publishedAt: daysAgo(400), publisher: 'bob' }, previous: prev }, NOW)).toEqual([]);
  });

  it('flags provenance dropped, high together with a new publisher', () => {
    const prev = [{ version: '5.0.0', provenance: true, publisher: 'ci' }];
    const same = riskSignals({ ...old, current: { version: '5.0.1', publishedAt: daysAgo(1), provenance: false, publisher: 'ci' }, previous: prev }, NOW);
    expect(same.map((x) => [x.id, x.level])).toEqual([['provenance-dropped', 'warn']]);
    const stolen = riskSignals({ ...old, current: { version: '5.0.1', publishedAt: daysAgo(1), provenance: false, publisher: 'someone' }, previous: prev }, NOW);
    expect(stolen.map((x) => [x.id, x.level])).toEqual([['provenance-dropped', 'high'], ['publisher-change', 'warn']]);
  });

  it('says nothing about provenance when it is unknown or never existed', () => {
    const prev = [{ version: '5.0.0', provenance: false }];
    expect(riskSignals({ ...old, current: { version: '5.0.1', provenance: false }, previous: prev }, NOW)).toEqual([]);
    expect(riskSignals({ ...old, current: { version: '5.0.1' }, previous: [{ version: '5.0.0', provenance: true }] }, NOW)).toEqual([]);
  });

  it('separates a young unknown package from a young popular one', () => {
    const young = { firstPublishedAt: daysAgo(10), current: { version: '0.1.0' }, previous: [] };
    expect(riskSignals({ ...young, weeklyDownloads: 5 }, NOW).map((x) => [x.id, x.level])).toEqual([['young-low-downloads', 'warn']]);
    expect(riskSignals({ ...young, weeklyDownloads: 50_000 }, NOW).map((x) => [x.id, x.level])).toEqual([['young-package', 'info']]);
    expect(riskSignals({ ...young }, NOW).map((x) => [x.id, x.level])).toEqual([['young-package', 'info']]);
  });

  it('notes a low Scorecard, never above info', () => {
    const scorecard = { repo: 'github.com/a/b', score: 2.5, failing: ['Maintained 0'], dangerousWorkflow: false, verifiedRepo: false };
    const s = riskSignals({ ...old, current: { version: '1.0.0' }, previous: [], scorecard }, NOW);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: 'scorecard-low', level: 'info' });
    expect(s[0].message).toContain('2.5/10');
    expect(s[0].message).toContain('repo as claimed by the package');
    const good = riskSignals({ ...old, current: { version: '1.0.0' }, previous: [], scorecard: { ...scorecard, score: 7, dangerousWorkflow: true } }, NOW);
    expect(ids(good)).toEqual(['scorecard-dangerous-workflow']);
  });

  it('reads thresholds from the environment', () => {
    vi.stubEnv('SAFECTX_RISK_NEW_PACKAGE_DAYS', '2');
    vi.stubEnv('SAFECTX_RISK_LOW_DOWNLOADS', '1');
    const t = riskThresholds();
    expect(t.newPackageDays).toBe(2);
    const s = riskSignals({ firstPublishedAt: daysAgo(3), current: { version: '1.0.0', installScripts: ['postinstall: x'] }, previous: [], weeklyDownloads: 5 }, NOW, t);
    expect(ids(s)).toEqual(['install-script', 'young-package']);
  });
});

describe('registry facts', () => {
  it('extracts install scripts, provenance, publisher and maintainers', () => {
    const doc = {
      scripts: { test: 'vitest', postinstall: 'node install.js', preinstall: 'node pre.js' },
      dist: { attestations: { url: 'u', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } },
      _npmUser: { name: 'evanw', email: 'x' },
      maintainers: [{ name: 'evanw' }, 'other <o@x>'],
    };
    expect(versionFactsFromDoc('1.0.0', doc)).toEqual({
      version: '1.0.0',
      installScripts: ['preinstall: node pre.js', 'postinstall: node install.js'],
      provenance: true,
      publisher: 'evanw',
      maintainers: ['evanw', 'other'],
    });
  });

  it('knows the implicit node-gyp install and ignores non-install scripts', () => {
    expect(installScriptsOf({ gypfile: true })).toEqual(['install: node-gyp rebuild (binding.gyp)']);
    expect(installScriptsOf({ scripts: { prepare: 'tsc', build: 'tsc' } })).toEqual([]);
    expect(versionFactsFromDoc('1.0.0', {}).provenance).toBe(false);
  });

  it('keeps notable failing Scorecard checks and skips inconclusive ones', () => {
    const sc = scorecardFacts('github.com/a/b', true, {
      overallScore: 3.1,
      date: '2026-08-24T00:00:00Z',
      checks: [
        { name: 'Code-Review', score: 0 },
        { name: 'Maintained', score: -1 },
        { name: 'Pinned-Dependencies', score: 0 },
        { name: 'Dangerous-Workflow', score: 0 },
        { name: 'License', score: 10 },
      ],
    });
    expect(sc).toEqual({ repo: 'github.com/a/b', score: 3.1, date: '2026-08-24T00:00:00Z', failing: ['Code-Review 0', 'Dangerous-Workflow 0'],dangerousWorkflow: true, verifiedRepo: true });
    expect(scorecardFacts('r', false, { checks: [] })).toBeUndefined();
  });
});

describe('previousVersions', () => {
  it('compares a stable release with earlier stable ones, newest first', () => {
    const vs = [
      { versionKey: { system: 'NPM', name: 'x', version: '1.0.0' }, publishedAt: '2026-01-01T00:00:00Z' },
      { versionKey: { system: 'NPM', name: 'x', version: '1.1.0' }, publishedAt: '2026-02-01T00:00:00Z' },
      { versionKey: { system: 'NPM', name: 'x', version: '2.0.0-canary.1' }, publishedAt: '2026-02-15T00:00:00Z' },
      { versionKey: { system: 'NPM', name: 'x', version: '1.2.0' }, publishedAt: '2026-03-01T00:00:00Z' },
      { versionKey: { system: 'NPM', name: 'x', version: '1.3.0' }, publishedAt: '2026-04-01T00:00:00Z' },
    ];
    expect(previousVersions(vs, '1.2.0', 5).map((v) => v.versionKey.version)).toEqual(['1.1.0', '1.0.0']);
    expect(previousVersions(vs, '1.3.0', 1).map((v) => v.versionKey.version)).toEqual(['1.2.0']);
    expect(previousVersions(vs, '9.9.9', 5)).toEqual([]);
  });
});

describe('assessRisk', () => {
  const reg = 'https://registry.npmjs.org';
  function npmPackage(name: string, versions: [string, number][]) {
    ddPackages.set(name, versions.map(([version, ago]) => ({ versionKey: { version }, publishedAt: daysAgo(ago) })));
  }

  it('gathers registry, downloads and Scorecard facts for npm', async () => {
    npmPackage('evil-pkg', [['1.0.0', 300], ['1.0.1', 200], ['1.0.2', 1]]);
    http.set(`${reg}/evil-pkg/1.0.2`, { scripts: { postinstall: 'node steal.js' }, _npmUser: { name: 'mallory' }, maintainers: [{ name: 'alice' }] });
    http.set(`${reg}/evil-pkg/1.0.1`, { scripts: {}, _npmUser: { name: 'alice' }, maintainers: [{ name: 'alice' }], dist: { attestations: { provenance: {} } } });
    http.set(`${reg}/evil-pkg/1.0.0`, { _npmUser: { name: 'alice' }, maintainers: [{ name: 'alice' }] });
    http.set('https://api.npmjs.org/downloads/point/last-week/evil-pkg', { downloads: 40_000 });
    ddVersions.set('evil-pkg@1.0.2', { relatedProjects: [{ projectKey: { id: 'github.com/a/evil' }, relationType: 'SOURCE_REPO', relationProvenance: 'UNVERIFIED_METADATA' }] });
    ddProjects.set('github.com/a/evil', { scorecard: { overallScore: 6, checks: [] } });

    const r = await assessRisk('npm', 'evil-pkg', '1.0.2', NOW);
    expect(r.unknown).toEqual([]);
    expect(r.publisher).toBe('mallory');
    expect(r.provenance).toBe(false);
    expect(r.weeklyDownloads).toBe(40_000);
    expect(r.scorecard?.score).toBe(6);
    expect(ids(r.signals)).toEqual(['install-script-added-new-publisher', 'provenance-dropped', 'publisher-change']);
    expect(r.sources).toEqual(['OpenSSF Scorecard via deps.dev', 'api.npmjs.org', 'registry.npmjs.org']);
  });

  it('says what it could not check instead of returning a clean report', async () => {
    npmPackage('flaky', [['1.0.0', 300]]);
    http.set(`${reg}/flaky/1.0.0`, new Error('socket hang up'));
    http.set('https://api.npmjs.org/downloads/point/last-week/flaky', new HttpError(503, 'x'));
    const r = await assessRisk('npm', 'flaky', '1.0.0', NOW);
    expect(r.signals).toEqual([]);
    expect(r.unknown).toEqual(expect.arrayContaining([
      'install scripts, provenance and publisher (npm registry did not answer)',
      'weekly downloads',
    ]));
    expect(riskLines(r).join('\n')).toMatch(/^Not verified: .*npm registry did not answer/);
  });

  it('uses deps.dev provenance and pypistats for PyPI, without inventing a missing provenance', async () => {
    ddPackages.set('newlib', [{ versionKey: { version: '0.1.0' }, publishedAt: daysAgo(5) }]);
    http.set('https://pypistats.org/api/packages/newlib/recent', { data: { last_week: 7 } });
    ddVersions.set('newlib@0.1.0', { attestations: [] });
    const r = await assessRisk('pypi', 'newlib', '0.1.0', NOW);
    expect(r.provenance).toBeUndefined();
    expect(r.signals.map((s) => [s.id, s.level])).toEqual([['young-low-downloads', 'warn']]);
  });
});

describe('riskOutcome', () => {
  const report = (id: string, level: 'info' | 'warn' | 'high') => ({ version: '1.0.0', signals: [{ id, level, message: `msg ${id}` }], unknown: [], sources: [] });

  it('denies a brand-new package with install scripts and the added-scripts-new-publisher case', () => {
    expect(riskOutcome('x (npm)', report('install-script-new-package', 'high'))?.action).toBe('deny');
    const o = riskOutcome('x (npm)', report('install-script-added-new-publisher', 'high'));
    expect(o?.action).toBe('deny');
    expect(o?.problem).toContain('x (npm), version 1.0.0: msg install-script-added-new-publisher.');
  });

  it('warns on other serious signals and ignores info', () => {
    expect(riskOutcome('x', report('provenance-dropped', 'high'))).toMatchObject({ action: 'allow', warning: 'x, version 1.0.0: msg provenance-dropped.' });
    expect(riskOutcome('x', report('install-script', 'info'))).toBeUndefined();
    expect(riskOutcome('x', undefined)).toBeUndefined();
  });

  it('obeys SAFECTX_HOOK_RISK', () => {
    vi.stubEnv('SAFECTX_HOOK_RISK', 'warn');
    expect(riskOutcome('x', report('install-script-new-package', 'high'))?.action).toBe('allow');
    vi.stubEnv('SAFECTX_HOOK_RISK', 'off');
    expect(riskOutcome('x', report('install-script-new-package', 'high'))).toBeUndefined();
  });
});
