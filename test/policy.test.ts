/**
 * Hook policy with the verdict mocked: what blocks, what asks, what passes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageReport } from '../src/advisories/resolve.js';

const reports = new Map<string, Partial<PackageReport> & { typo?: { lookalikeOf?: string; existsInRegistry?: boolean } }>();
const versions = new Map<string, string[]>();
const risks = new Map<string, { id: string; level: 'info' | 'warn' | 'high'; message: string }[]>(); // name -> signals

vi.mock('../src/verdict.js', () => ({
  checkPackage: vi.fn(async (eco: string, name: string, version?: string) => {
    const r = reports.get(`${name}@${version ?? ''}`) ?? reports.get(name) ?? { verdict: 'ok' };
    const { typo, ...rest } = r;
    const signals = risks.get(name);
    const risk = signals ? { version: version ?? '', signals, unknown: [], sources: [] } : undefined;
    return { report: { package: name, ecosystem: eco, checkedAt: '', sources: [], ...rest }, typo, risk };
  }),
}));
const graphs = new Map<string, Record<string, string>>(); // "name@version" -> { dep: version }
const requirements = new Map<string, Record<string, string>>(); // "name@version" -> { dep: requirement }
const vulnerable = new Set<string>(); // "name@version" with OSV advisories

vi.mock('../src/advisories/osv.js', () => ({
  queryBatch: vi.fn(async (items: { name: string; version: string }[]) => items.map((i) => (vulnerable.has(`${i.name}@${i.version}`) ? ['GHSA-t'] : []))),
}));
vi.mock('../src/advisories/depsdev.js', () => ({
  getDependencies: vi.fn(async (_eco: string, name: string, version: string) => {
    const g = graphs.get(`${name}@${version}`);
    if (!g) return undefined;
    const req = requirements.get(`${name}@${version}`) ?? {};
    const deps = Object.entries(g);
    return {
      nodes: [{ versionKey: { name, version } }, ...deps.map(([n, v]) => ({ versionKey: { name: n, version: v } }))],
      edges: deps.map(([n], k) => ({ fromNode: 0, toNode: k + 1, requirement: req[n] })),
    };
  }),
  getPackage: vi.fn(async (_eco: string, name: string) => {
    const vs = versions.get(name);
    return vs ? { versions: vs.map((v, i) => ({ versionKey: { version: v }, isDefault: i === vs.length - 1, publishedAt: '2026-01-01' })) } : undefined;
  }),
}));

const { decide, agentMessage, satisfiesRequirement, timeoutDecision } = await import('../src/hook/policy.js');
const { resolvePolicy } = await import('../src/teamConfig.js');
const adv = (id: string) => ({ id, aliases: [`CVE-${id}`], url: '', severity: 'HIGH' });

beforeEach(() => {
  reports.clear();
  versions.clear();
  risks.clear();
  delete process.env.SAFECTX_HOOK_RISK;
  graphs.clear();
  requirements.clear();
  vulnerable.clear();
  delete process.env.SAFECTX_ALLOW;
  delete process.env.SAFECTX_HOOK_COOLDOWN;
  delete process.env.SAFECTX_HOOK_ON_ERROR;
});

describe('decide', () => {
  it('denies malware of the requested version whatever the package-wide verdict says (security review F3)', async () => {
    versions.set('evil', ['1.0.0', '1.0.1']);
    for (const headline of ['vulnerable', 'unknown'] as const) {
      reports.set('evil@1.0.1', { verdict: headline, requested: { version: '1.0.1', verdict: 'malicious', advisories: [{ id: 'MAL-2026-7', aliases: [], url: '' }] } });
      const d = await decide([{ ecosystem: 'npm', name: 'evil', spec: '1.0.1', source: 'npm i' }]);
      expect(d.action).toBe('deny');
      expect(d.problems[0]).toContain('MALWARE (MAL-2026-7)');
    }
  });

  it('denies a vulnerable pin and points to the same release line first', async () => {
    versions.set('axios', ['1.7.9', '1.20.0', '2.0.0']);
    reports.set('axios@1.7.9', {
      verdict: 'vulnerable', line: '1.x', safeVersionSameLine: '1.20.0', safeVersion: '2.0.0',
      requested: { version: '1.7.9', verdict: 'vulnerable', advisories: [adv('1')] },
    });
    const d = await decide([{ ecosystem: 'npm', name: 'axios', spec: '1.7.9', source: 'npm i' }]);
    expect(d.action).toBe('deny');
    expect(d.problems[0]).toContain('npm install axios@1.20.0');
    expect(agentMessage(d)).toMatch(/^safectx blocked this dependency change/);
  });

  it('says when only a new major fixes it', async () => {
    versions.set('jsonwebtoken', ['8.5.1', '9.0.3']);
    reports.set('jsonwebtoken@8.5.1', {
      verdict: 'vulnerable', line: '8.x', crossLineRequired: true, safeVersion: '9.0.3',
      requested: { version: '8.5.1', verdict: 'vulnerable', advisories: [adv('2')] },
    });
    const d = await decide([{ ecosystem: 'npm', name: 'jsonwebtoken', spec: '8.5.1', source: 'x' }]);
    expect(d.problems[0]).toMatch(/new major, 9\.0\.3/);
    expect(d.problems[0]).toContain('safectx upgrade npm jsonwebtoken 8.5.1 9.0.3');
  });

  it('points to the nearest newer line with a fix before the newest major', async () => {
    versions.set('org.springframework:spring-core', ['5.3.20', '6.2.19', '7.0.10']);
    reports.set('org.springframework:spring-core@5.3.20', {
      verdict: 'vulnerable', line: '5.x', crossLineRequired: true, safeVersion: '7.0.10', safeVersionNearestLine: '6.2.19', nearestLine: '6.x',
      requested: { version: '5.3.20', verdict: 'vulnerable', advisories: [adv('5')] },
    });
    const d = await decide([{ ecosystem: 'maven', name: 'org.springframework:spring-core', spec: '5.3.20', source: 'pom.xml' }]);
    expect(d.action).toBe('deny');
    expect(d.problems[0]).toContain('nearest fix is on 6.x');
    expect(d.problems[0]).toContain('org.springframework:spring-core:6.2.19');
  });

  it('matches a short PyPI pin to the padded version deps.dev lists ("3.10" is 3.10.0)', async () => {
    versions.set('idna', ['3.10.0', '3.20.0']);
    reports.set('idna@3.10.0', {
      verdict: 'vulnerable', line: '3.x', safeVersionSameLine: '3.20.0',
      requested: { version: '3.10.0', verdict: 'vulnerable', advisories: [adv('4')] },
    });
    // Pinned requirements files reach the hook without "==" (the parser strips it).
    for (const spec of ['==3.10', '3.10']) {
      const d = await decide([{ ecosystem: 'pypi', name: 'idna', spec, source: 'requirements.txt' }]);
      expect(d.action).toBe('deny');
      expect(d.problems[0]).toContain('idna==3.20.0');
    }
  });

  it('asks a human when no clean version exists', async () => {
    versions.set('python-jose', ['3.3.0']);
    reports.set('python-jose@3.3.0', { verdict: 'vulnerable', requested: { version: '3.3.0', verdict: 'vulnerable', advisories: [adv('3')] } });
    const d = await decide([{ ecosystem: 'pypi', name: 'python-jose', spec: '==3.3.0', source: 'pip' }]);
    expect(d.action).toBe('ask');
  });

  it('denies typosquats, malware and packages that do not exist; SAFECTX_ALLOW lets private ones through', async () => {
    reports.set('reqeusts', { verdict: 'possible-typosquat', typo: { lookalikeOf: 'requests', existsInRegistry: false } });
    expect((await decide([{ ecosystem: 'pypi', name: 'reqeusts', source: 'pip' }])).action).toBe('deny');

    versions.set('evil', ['1.0.0']);
    reports.set('evil@1.0.0', { verdict: 'malicious', requested: { version: '1.0.0', verdict: 'malicious', advisories: [{ id: 'MAL-2026-1', aliases: [], url: '' }] } });
    expect((await decide([{ ecosystem: 'npm', name: 'evil', spec: '1.0.0', source: 'x' }])).problems[0]).toContain('MALWARE');

    reports.set('@acme/internal', { verdict: 'unknown-package' });
    expect((await decide([{ ecosystem: 'npm', name: '@acme/internal', source: 'x' }])).action).toBe('deny');
    process.env.SAFECTX_ALLOW = '@acme/*';
    expect((await decide([{ ecosystem: 'npm', name: '@acme/internal', source: 'x' }])).action).toBe('allow');
  });

  it('cooldown and unverifiable sources warn by default and can be enforced', async () => {
    versions.set('zod', ['4.6.5', '4.6.7']);
    reports.set('zod@4.6.7', { verdict: 'ok', safeVersion: '4.6.5', latestVersion: '4.6.7', requested: { version: '4.6.7', verdict: 'ok', advisories: [] } });
    let d = await decide([{ ecosystem: 'npm', name: 'zod', source: 'npm i zod' }]);
    expect(d.action).toBe('allow');
    expect(d.warnings[0]).toMatch(/cooldown/);
    process.env.SAFECTX_HOOK_COOLDOWN = 'enforce';
    d = await decide([{ ecosystem: 'npm', name: 'zod', source: 'npm i zod' }]);
    expect(d.action).toBe('deny');

    versions.set('x', ['1.0.0']);
    reports.set('x@1.0.0', { verdict: 'unknown', reason: 'deps.dev down' });
    expect((await decide([{ ecosystem: 'npm', name: 'x', spec: '1.0.0', source: 'x' }])).action).toBe('allow');
    process.env.SAFECTX_HOOK_ON_ERROR = 'deny';
    expect((await decide([{ ecosystem: 'npm', name: 'x', spec: '1.0.0', source: 'x' }])).action).toBe('deny');
  });

  it('resolves ranges to the version that would be installed', async () => {
    versions.set('lodash', ['4.17.20', '4.17.21', '5.0.0']);
    reports.set('lodash@4.17.21', { verdict: 'ok', requested: { version: '4.17.21', verdict: 'ok', advisories: [] } });
    const d = await decide([{ ecosystem: 'npm', name: 'lodash', spec: '^4.17.0', source: 'x' }]);
    expect(d.action).toBe('allow');
    expect(d.problems).toEqual([]);
  });

  it('a vulnerable pin that another pinned package pulls in: upgrade the parent, not the child', async () => {
    versions.set('fastapi', ['0.110.0', '0.115.0']);
    versions.set('starlette', ['0.36.3', '0.40.0', '1.0.0']);
    reports.set('fastapi@0.110.0', { verdict: 'ok', line: '0.110.x', safeVersion: '0.115.0', requested: { version: '0.110.0', verdict: 'ok', advisories: [] } });
    reports.set('starlette@0.36.3', {
      verdict: 'vulnerable', line: '0.36.x', crossLineRequired: true, safeVersion: '1.0.0',
      requested: { version: '0.36.3', verdict: 'vulnerable', advisories: [adv('9')] },
    });
    graphs.set('fastapi@0.110.0', { starlette: '0.36.3' });
    graphs.set('fastapi@0.115.0', { starlette: '0.40.0' });
    vulnerable.add('starlette@0.36.3');
    const d = await decide([
      { ecosystem: 'pypi', name: 'fastapi', spec: '==0.110.0', source: 'requirements.txt' },
      { ecosystem: 'pypi', name: 'starlette', spec: '==0.36.3', source: 'requirements.txt' },
    ]);
    expect(d.action).toBe('deny');
    expect(d.problems[0]).toContain('It comes in through fastapi: upgrade fastapi to 0.115.0');
    expect(d.problems[0]).toContain('pulls starlette 0.40.0');
    expect(d.problems[0]).not.toContain('1.0.0');
  });

  it('undeclared transitive advisories block only when a same-line upgrade of the parent clears them', async () => {
    versions.set('express', ['4.21.2', '4.22.1']);
    reports.set('express@4.21.2', { verdict: 'ok', line: '4.x', safeVersionSameLine: '4.22.1', safeVersion: '5.0.0', requested: { version: '4.21.2', verdict: 'ok', advisories: [] } });
    graphs.set('express@4.21.2', { 'path-to-regexp': '0.1.10', qs: '6.13.0' });
    graphs.set('express@4.22.1', { 'path-to-regexp': '0.1.12', qs: '6.14.0' });
    vulnerable.add('path-to-regexp@0.1.10');
    let d = await decide([{ ecosystem: 'npm', name: 'express', spec: '4.21.2', source: 'package.json' }]);
    expect(d.action).toBe('deny');
    expect(d.problems[0]).toContain('npm install express@4.22.1');

    vulnerable.add('path-to-regexp@0.1.12');
    d = await decide([{ ecosystem: 'npm', name: 'express', spec: '4.21.2', source: 'package.json' }]);
    expect(d.action).toBe('allow');
    expect(d.warnings[0]).toMatch(/no release of express fixes them yet/);
  });
});

describe('version compatibility inside one file', () => {
  it('satisfiesRequirement reads PEP 440, npm and cargo ranges', () => {
    expect(satisfiesRequirement('pypi', '0.4.0', '>=0.4.2')).toBe(false);
    expect(satisfiesRequirement('pypi', '0.4.2', '>=0.4.2; python_version >= "3.9"')).toBe(true);
    expect(satisfiesRequirement('npm', '1.2.3', '^1.0.0')).toBe(true);
    expect(satisfiesRequirement('npm', '2.0.0', '^1.0.0')).toBe(false);
    expect(satisfiesRequirement('cargo', '1.0.200', '1.0')).toBe(true);
    expect(satisfiesRequirement('npm', '1.0.0', 'workspace:*')).toBeUndefined();
  });

  it('blocks a pin the parent in the same file does not accept, even when that line did not change', async () => {
    versions.set('fastapi', ['0.162.0']);
    versions.set('typing-inspection', ['0.4.0', '0.4.2']);
    reports.set('fastapi@0.162.0', { verdict: 'ok', requested: { version: '0.162.0', verdict: 'ok', advisories: [] } });
    graphs.set('fastapi@0.162.0', { 'typing-inspection': '0.4.2' });
    requirements.set('fastapi@0.162.0', { 'typing-inspection': '>=0.4.2' });
    const d = await decide([
      { ecosystem: 'pypi', name: 'fastapi', spec: '==0.162.0', source: 'requirements.txt' },
      { ecosystem: 'pypi', name: 'typing-inspection', spec: '==0.4.0', source: 'requirements.txt', contextOnly: true },
    ]);
    expect(d.action).toBe('deny');
    expect(d.problems[0]).toContain('typing-inspection 0.4.0 does not satisfy fastapi 0.162.0\'s requirement ">=0.4.2"');
    expect(d.problems[0]).toContain('resolves it to 0.4.2');
  });

  it('composer: the same conflict check runs on composer.json, with Composer constraints', async () => {
    versions.set('guzzlehttp/guzzle', ['7.9.2']);
    versions.set('guzzlehttp/psr7', ['1.8.0', '2.7.0']);
    reports.set('guzzlehttp/guzzle@7.9.2', { verdict: 'ok', requested: { version: '7.9.2', verdict: 'ok', advisories: [] } });
    graphs.set('guzzlehttp/guzzle@7.9.2', { 'guzzlehttp/psr7': '2.7.0' });
    requirements.set('guzzlehttp/guzzle@7.9.2', { 'guzzlehttp/psr7': '^2.7.0' });
    const d = await decide([
      { ecosystem: 'composer', name: 'guzzlehttp/guzzle', spec: '7.9.2', source: 'composer.json' },
      { ecosystem: 'composer', name: 'guzzlehttp/psr7', spec: '1.8.0', source: 'composer.json' },
    ]);
    expect(d.action).toBe('deny');
    expect(d.problems.join('\n')).toContain('guzzlehttp/psr7 1.8.0 does not satisfy guzzlehttp/guzzle 7.9.2\'s requirement "^2.7.0"');
  });

  it('a vulnerable dependency of a pinned parent is repinned when its fix fits the parent\'s range', async () => {
    versions.set('requests', ['2.34.2']);
    versions.set('idna', ['3.10.0', '3.20.0']);
    reports.set('requests@2.34.2', { verdict: 'ok', requested: { version: '2.34.2', verdict: 'ok', advisories: [] } });
    // deps.dev resolved the graph when 3.10 was newest; the range still takes the fix.
    graphs.set('requests@2.34.2', { idna: '3.10.0' });
    requirements.set('requests@2.34.2', { idna: '<4,>=2.5' });
    reports.set('idna@3.10.0', {
      verdict: 'vulnerable', line: '3.x', safeVersionSameLine: '3.20.0',
      requested: { version: '3.10.0', verdict: 'vulnerable', advisories: [adv('5')] },
    });
    const d = await decide([
      { ecosystem: 'pypi', name: 'requests', spec: '2.34.2', source: 'requirements.txt' },
      { ecosystem: 'pypi', name: 'idna', spec: '3.10', source: 'requirements.txt' },
    ]);
    expect(d.action).toBe('deny');
    expect(d.problems.join('\n')).toContain('idna==3.20.0');
    expect(d.problems.join('\n')).not.toMatch(/no release of requests/);
  });
});

describe('no clean version anywhere', () => {
  it('lets a moderate advisory through with a note instead of stopping the work', async () => {
    versions.set('nuxt', ['4.6.2']);
    reports.set('nuxt@4.6.2', {
      verdict: 'vulnerable', safeVersion: undefined,
      requested: { version: '4.6.2', verdict: 'vulnerable', advisories: [{ id: 'GHSA-n', aliases: [], url: '', severity: 'MODERATE' }] },
    });
    const d = await decide([{ ecosystem: 'npm', name: 'nuxt', spec: '4.6.2', source: 'package.json' }]);
    expect(d.action).toBe('allow');
    expect(d.warnings[0]).toMatch(/No version without known advisories exists yet; allowed/);
    process.env.SAFECTX_HOOK_NO_FIX = 'deny';
    expect((await decide([{ ecosystem: 'npm', name: 'nuxt', spec: '4.6.2', source: 'package.json' }])).action).toBe('deny');
    delete process.env.SAFECTX_HOOK_NO_FIX;
  });
});

describe('no clean version, but a less exposed one', () => {
  it('points from a HIGH-ridden version to the least exposed one', async () => {
    versions.set('nuxt', ['4.0.3', '4.6.2']);
    reports.set('nuxt@4.0.3', {
      verdict: 'vulnerable', safeVersion: undefined, leastExposed: { version: '4.6.2', advisories: 1, maxSeverity: 'MODERATE' },
      requested: { version: '4.0.3', verdict: 'vulnerable', advisories: [{ id: 'GHSA-h', aliases: [], url: '', severity: 'HIGH' }] },
    });
    const d = await decide([{ ecosystem: 'npm', name: 'nuxt', spec: '4.0.3', source: 'package.json' }]);
    expect(d.action).toBe('deny');
    expect(d.problems[0]).toContain('the least exposed is 4.6.2 (1 advisory, worst MODERATE): npm install nuxt@4.6.2');
  });
});

describe('supply-chain risk signals', () => {
  const sig = (id: string, level: 'info' | 'warn' | 'high', message: string) => ({ id, level, message });

  it('denies running a brand-new package with install scripts through npx', async () => {
    versions.set('fresh-cli', ['1.0.0']);
    risks.set('fresh-cli', [sig('install-script-new-package', 'high', 'the package was first published 2 days ago and runs install scripts (postinstall: node x.js)')]);
    const d = await decide([{ ecosystem: 'npm', name: 'fresh-cli', source: 'npx fresh-cli', executes: true }]);
    expect(d.action).toBe('deny');
    expect(d.problems[0]).toContain('fresh-cli (npm, executed), version 1.0.0: the package was first published 2 days ago');
  });

  it('denies a release that adds install scripts from a new publisher', async () => {
    versions.set('popular-lib', ['2.0.0', '2.0.1']);
    risks.set('popular-lib', [sig('install-script-added-new-publisher', 'high', 'adds install scripts'), sig('publisher-change', 'warn', 'new publisher')]);
    const d = await decide([{ ecosystem: 'npm', name: 'popular-lib', spec: '2.0.1', source: 'npm i' }]);
    expect(d.action).toBe('deny');
  });

  it('only warns for other signals, and stays silent on info', async () => {
    versions.set('a', ['1.0.0']);
    versions.set('b', ['1.0.0']);
    risks.set('a', [sig('provenance-dropped', 'warn', '1.0.0 has no provenance attestation')]);
    risks.set('b', [sig('install-script', 'info', 'runs install scripts (postinstall: node install.js)')]);
    const d = await decide([
      { ecosystem: 'npm', name: 'a', source: 'npm i a b' },
      { ecosystem: 'npm', name: 'b', source: 'npm i a b' },
    ]);
    expect(d.action).toBe('allow');
    expect(d.warnings).toEqual(['a (npm), version 1.0.0: 1.0.0 has no provenance attestation.']);
  });

  it('SAFECTX_HOOK_RISK=warn turns the deny into a note', async () => {
    process.env.SAFECTX_HOOK_RISK = 'warn';
    versions.set('fresh-cli', ['1.0.0']);
    risks.set('fresh-cli', [sig('install-script-new-package', 'high', 'new and runs install scripts')]);
    const d = await decide([{ ecosystem: 'npm', name: 'fresh-cli', source: 'npx fresh-cli', executes: true }]);
    expect(d.action).toBe('allow');
    expect(d.warnings[0]).toContain('new and runs install scripts');
  });
});

describe('what the hook cannot check', () => {
  const remote = { ecosystem: 'npm' as const, name: 'x', source: 'npm i github:evil/x', unverifiable: { reason: 'github:evil/x comes from outside the registry.' } };

  it('asks by default; the policy can allow or deny; allow-listed names pass', async () => {
    expect((await decide([remote], resolvePolicy(undefined, {}))).action).toBe('ask');
    expect((await decide([remote], resolvePolicy({ unverifiable: 'deny' }, {}))).action).toBe('deny');
    const allowed = await decide([remote], resolvePolicy(undefined, { SAFECTX_HOOK_UNVERIFIABLE: 'allow' }));
    expect(allowed.action).toBe('allow');
    expect(allowed.warnings[0]).toContain('outside the registry');
    expect((await decide([remote], resolvePolicy({ allow: ['x'] }, {}))).action).toBe('allow');
  });

  it('notes only inform, and changes to the hook configuration always ask', async () => {
    const note = { ...remote, unverifiable: { reason: 'jsr:@x/y is a JSR package.', level: 'note' as const } };
    expect((await decide([note], resolvePolicy(undefined, {}))).action).toBe('allow');
    const guard = { ...remote, name: '.safectx.json', unverifiable: { reason: 'changes the policy.', level: 'guard' as const } };
    expect((await decide([guard], resolvePolicy({ unverifiable: 'allow', allow: ['*'] }, {}))).action).toBe('ask');
  });

  it('padding a change past the per-change limit asks instead of passing the rest unchecked', async () => {
    const many = Array.from({ length: 45 }, (_, k) => ({ ecosystem: 'npm' as const, name: `pkg${k}`, spec: '1.0.0', source: 'npm i ...' }));
    for (const i of many) versions.set(i.name, ['1.0.0']);
    const d = await decide(many);
    expect(d.action).toBe('ask');
    expect(d.problems.join('\n')).toMatch(/45 dependencies.*pkg40/);
  });

  it('an unreachable registry never lets a lookalike name through, even with onError allow', async () => {
    reports.set('expresss', { verdict: 'unknown', reason: 'deps.dev timed out' });
    versions.set('expresss', ['1.0.0']);
    expect((await decide([{ ecosystem: 'npm', name: 'expresss', source: 'npm i expresss' }])).action).toBe('ask');
    reports.set('left-pad', { verdict: 'unknown', reason: 'deps.dev timed out' });
    versions.set('left-pad', ['1.3.0']);
    expect((await decide([{ ecosystem: 'npm', name: 'left-pad', source: 'npm i left-pad' }])).action).toBe('allow');
  });

  it('on timeout, what is known offline still decides', () => {
    const p = resolvePolicy({ deny: ['request'] }, {});
    expect(timeoutDecision([{ ecosystem: 'npm', name: 'left-pad', source: 'x' }], p).action).toBe('allow');
    expect(timeoutDecision([{ ecosystem: 'npm', name: 'expresss', source: 'x' }], p).action).toBe('ask');
    expect(timeoutDecision([{ ecosystem: 'npm', name: 'request', source: 'x' }], p).action).toBe('deny');
    expect(timeoutDecision([remote], p).action).toBe('ask');
    expect(timeoutDecision([{ ecosystem: 'npm', name: 'left-pad', source: 'x' }], resolvePolicy({ onError: 'ask' }, {})).action).toBe('ask');
  });
});
