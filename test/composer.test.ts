/**
 * Composer: constraints, composer.json/lock, Packagist metadata and the verdict
 * through Packagist + OSV, offline (HTTP replaced by fixtures keyed by URL).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SAFECTX_NO_CACHE = '1';
process.env.SAFECTX_COOLDOWN_DAYS = '3';

const fixtures = new Map<string, unknown>();
const calls: string[] = [];

vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return {
    ...actual,
    getJson: vi.fn(async (url: string, opts?: { body?: { version?: string; package?: { name: string } } }) => {
      calls.push(url);
      if (url.endsWith('/v1/query')) {
        // OSV: the vulns of that package whose "fixed" is above the version.
        const all = (fixtures.get(`osv:${opts?.body?.package?.name}`) ?? []) as { affected: { ranges: { events: { fixed?: string }[] }[] }[] }[];
        const { compareComposer } = await import('../src/composer/constraint.js');
        const v = opts?.body?.version as string;
        return { vulns: all.filter((x) => x.affected.some((a) => a.ranges.some((r) => r.events.some((e) => e.fixed && (compareComposer(v, e.fixed) ?? 0) < 0)))) };
      }
      const key = [...fixtures.keys()].find((k) => url.includes(k));
      if (!key) throw new actual.HttpError(404, url);
      return fixtures.get(key);
    }),
  };
});

const { satisfiesComposer, pickComposerVersion, fixedFromConstraint } = await import('../src/composer/constraint.js');
const { expandMinified, packagistAuditExtras } = await import('../src/composer/packagist.js');
const { assessPackage } = await import('../src/advisories/resolve.js');
const { parseFile } = await import('../src/tree/lockfiles.js');
const { fromCommand, fromFileWrite } = await import('../src/hook/intent.js');

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

beforeEach(() => {
  fixtures.clear();
  calls.length = 0;
});

describe('Composer constraints', () => {
  it.each([
    ['1.2.3', '^1.2', true],
    ['2.0.0', '^1.2', false],
    ['0.3.9', '^0.3', true],
    ['0.4.0', '^0.3', false],
    ['1.9.0', '~1.2', true],
    ['1.3.0', '~1.2.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.2.7', '1.2.*', true],
    ['1.3.0', '1.2.*', false],
    ['1.5.0', '>=1.0 <2.0', true],
    ['1.5.0', '>=1.0,<1.5', false],
    ['7.4.0', '>=8.0.0,<8.0.1|<7.15.2', true],
    ['7.15.2', '>=8.0.0,<8.0.1|<7.15.2', false],
    ['3.0.0', '^1.0 || ^3.0', true],
    ['2.0.5', '1.0 - 2.0', true],
    ['2.1.0', '1.0 - 2.0', false],
    ['2.0.5', '1.0.0 - 2.0.0', false],
    ['1.0.0', '!=1.0.0', false],
    ['1.2.0', '1.2', true],
    ['v5.4.0', '^5.4@stable', true],
    ['2.0.0-RC1', '<2.0', false],
    ['1.0.0', '*', true],
  ])('%s satisfies %s: %s', (v, c, ok) => {
    expect(satisfiesComposer(v, c)).toBe(ok);
  });

  it('branches and junk are unreadable, not false', () => {
    expect(satisfiesComposer('1.0.0', 'dev-main')).toBeUndefined();
    expect(satisfiesComposer('dev-main', '^1.0')).toBeUndefined();
  });

  it('picks the newest matching release and reads fixed versions from an affected range', () => {
    expect(pickComposerVersion('^7.4', ['6.5.8', '7.4.0', '7.9.2', '8.0.0'])).toBe('7.9.2');
    expect(pickComposerVersion('^9', ['1.0.0'])).toBeUndefined();
    expect(fixedFromConstraint('>=8.0.0,<8.0.1|<7.15.2')).toEqual(['8.0.1', '7.15.2']);
    expect(fixedFromConstraint('<=1.0')).toEqual([]);
  });
});

describe('composer files', () => {
  it('composer.json: require and require-dev, platform packages skipped', () => {
    const json = JSON.stringify({ require: { php: '>=8.1', 'ext-json': '*', 'Guzzlehttp/Guzzle': '^7.4' }, 'require-dev': { 'phpunit/phpunit': '^10' } });
    expect(parseFile('composer.json', json).declared).toEqual([
      { name: 'guzzlehttp/guzzle', spec: '^7.4' },
      { name: 'phpunit/phpunit', spec: '^10', dev: true },
    ]);
  });

  it('composer.lock: packages and packages-dev, direct from composer.json, v prefix and branches', () => {
    const lock = JSON.stringify({
      packages: [{ name: 'symfony/http-kernel', version: 'v5.4.0' }, { name: 'psr/log', version: '3.0.0' }, { name: 'acme/fork', version: 'dev-main' }],
      'packages-dev': [{ name: 'phpunit/phpunit', version: '10.5.0' }],
    });
    const t = parseFile('composer.lock', lock, { 'composer.json': JSON.stringify({ require: { 'symfony/http-kernel': '^5.4' }, 'require-dev': { 'phpunit/phpunit': '^10' } }) });
    expect(t).toMatchObject({ ecosystem: 'composer', kind: 'lockfile' });
    expect(t.packages).toEqual([
      { name: 'symfony/http-kernel', version: '5.4.0', dev: false, direct: true },
      { name: 'psr/log', version: '3.0.0', dev: false, direct: false },
      { name: 'phpunit/phpunit', version: '10.5.0', dev: true, direct: true },
    ]);
  });

  it('composer require and create-project intents; composer.json writes count only changes', () => {
    const pick = (cmd: string) => fromCommand(cmd, '/p', () => undefined).map((i) => `${i.ecosystem}:${i.name}${i.spec ? ` ${i.spec}` : ''}${i.executes ? ' (exec)' : ''}`);
    expect(pick('composer require guzzlehttp/guzzle:6.5.0 monolog/monolog "^3.0" php:^8.2 ext-intl')).toEqual(['composer:guzzlehttp/guzzle 6.5.0', 'composer:monolog/monolog ^3.0']);
    expect(pick('composer require --dev phpunit/phpunit=^10 && php composer.phar req psr/log')).toEqual(['composer:phpunit/phpunit ^10']);
    expect(pick('composer.phar require psr/log')).toEqual(['composer:psr/log']);
    expect(pick('composer global require laravel/installer')).toEqual(['composer:laravel/installer']);
    expect(pick('composer create-project laravel/laravel app 10.0.0')).toEqual(['composer:laravel/laravel 10.0.0 (exec)']);
    expect(pick('composer install && composer update')).toEqual([]);

    const before = JSON.stringify({ require: { 'psr/log': '^3.0', 'guzzlehttp/guzzle': '^7.0' } });
    const after = JSON.stringify({ require: { 'psr/log': '^3.0', 'guzzlehttp/guzzle': '^7.4' } });
    const intents = fromFileWrite('/p/composer.json', after, before);
    expect(intents.filter((i) => !i.contextOnly).map((i) => `${i.ecosystem}:${i.name} ${i.spec}`)).toEqual(['composer:guzzlehttp/guzzle ^7.4']);
    expect(fromFileWrite('/p/vendor/x/composer.json', after, undefined)).toEqual([]);
  });
});

describe('Packagist metadata', () => {
  it('expands Composer 2 minified entries', () => {
    expect(expandMinified([{ version: '2.0.0', license: ['MIT'], time: 't2' }, { version: '1.0.0', time: 't1' }, { version: '0.9.0', license: '__unset' }])).toEqual([
      { version: '2.0.0', license: ['MIT'], time: 't2' },
      { version: '1.0.0', license: ['MIT'], time: 't1' },
      { version: '0.9.0', time: 't1' },
    ]);
  });

  function seedGuzzle(abandoned?: string) {
    fixtures.set('repo.packagist.org/p2/guzzlehttp/guzzle.json', {
      minified: 'composer/2.0',
      packages: {
        'guzzlehttp/guzzle': [
          { version: '7.10.0', time: daysAgo(1), license: ['MIT'], ...(abandoned ? { abandoned } : {}) },
          { version: '7.9.2', time: daysAgo(50) },
          { version: '7.0.0-beta1', time: daysAgo(60) },
          { version: '6.5.8', time: daysAgo(400) },
          { version: '6.5.0', time: daysAgo(900) },
        ],
      },
    });
    const range = (fixed: string) => [{ ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed }] }] }];
    fixtures.set('osv:guzzlehttp/guzzle', [
      { id: 'GHSA-old', summary: 'old bug', aliases: ['CVE-2022-1'], database_specific: { severity: 'HIGH' }, affected: range('6.5.8') },
    ]);
    // Packagist knows one more (FriendsOfPHP only), affecting 6.x below 6.5.8 and repeated by a GitHub one.
    fixtures.set('packagist.org/api/security-advisories', {
      advisories: {
        'guzzlehttp/guzzle': [
          { advisoryId: 'PKSA-1', cve: 'CVE-2022-2', title: 'FoP only', affectedVersions: '>=6.0,<6.5.8', severity: 'medium' },
          { advisoryId: 'PKSA-2', remoteId: 'GHSA-old', cve: 'CVE-2022-1', affectedVersions: '<6.5.8', severity: 'high' },
          { advisoryId: 'PKSA-3', cve: 'CVE-2022-1', affectedVersions: '<6.5.8' },
        ],
      },
    });
  }

  it('assessPackage for composer: Packagist versions, OSV + Packagist advisories, same-line fix, cooldown', async () => {
    seedGuzzle();
    const r = await assessPackage('composer', 'guzzlehttp/guzzle', '6.5.0');
    expect(r.sources).toEqual(['packagist.org', 'osv.dev']);
    expect(r.verdict).toBe('vulnerable');
    expect(r.safeVersion).toBe('7.9.2'); // 7.10.0 is inside the cooldown, the beta is not stable
    expect(r.safeVersionSameLine).toBe('6.5.8');
    expect(r.requested?.advisories.map((a) => a.id).sort()).toEqual(['CVE-2022-2', 'GHSA-old']);
    expect(r.requested?.advisories.find((a) => a.id === 'CVE-2022-2')).toMatchObject({ title: 'FoP only', severity: 'MODERATE', fixedIn: ['6.5.8'] });
    expect(calls.some((u) => u.includes('deps.dev'))).toBe(false);
  });

  it('a clean version is ok only after both sources answered; an abandoned package is deprecated', async () => {
    seedGuzzle();
    expect((await assessPackage('composer', 'guzzlehttp/guzzle', '7.9.2')).verdict).toBe('ok');
    seedGuzzle('guzzlehttp/new');
    const r = await assessPackage('composer', 'guzzlehttp/guzzle', '7.9.2');
    expect(r.verdict).toBe('deprecated');
    expect(r.requested?.deprecatedReason).toContain('guzzlehttp/new');
  });

  it('unknown package and Packagist down', async () => {
    expect((await assessPackage('composer', 'nobody/nothing')).verdict).toBe('unknown-package');
    const { getJson } = await import('../src/http.js');
    vi.mocked(getJson).mockRejectedValueOnce(new Error('ECONNRESET'));
    const r = await assessPackage('composer', 'x/y');
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toMatch(/packagist\.org did not answer/);
  });

  it('tree audit extras: Packagist-only advisories, shaped like OSV, without repeating OSV ones', async () => {
    seedGuzzle();
    const out = await packagistAuditExtras([{ name: 'guzzlehttp/guzzle', version: '6.5.0' }, { name: 'guzzlehttp/guzzle', version: '7.9.2' }], [['GHSA-old'], []]);
    expect(out.ids).toEqual([['CVE-2022-2'], []]);
    expect(out.details.get('CVE-2022-2')?.affected?.[0].ranges?.[0].events).toEqual([{ fixed: '6.5.8' }]);
  });
});
