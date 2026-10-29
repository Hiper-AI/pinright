/**
 * Hook policy with the verdict mocked: what blocks, what asks, what passes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageReport } from '../src/advisories/resolve.js';

const reports = new Map<string, Partial<PackageReport> & { typo?: { lookalikeOf?: string; existsInRegistry?: boolean } }>();
const versions = new Map<string, string[]>();

vi.mock('../src/verdict.js', () => ({
  checkPackage: vi.fn(async (eco: string, name: string, version?: string) => {
    const r = reports.get(`${name}@${version ?? ''}`) ?? reports.get(name) ?? { verdict: 'ok' };
    const { typo, ...rest } = r;
    return { report: { package: name, ecosystem: eco, checkedAt: '', sources: [], ...rest }, typo };
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

const { decide, agentMessage, satisfiesRequirement } = await import('../src/hook/policy.js');
const adv = (id: string) => ({ id, aliases: [`CVE-${id}`], url: '', severity: 'HIGH' });

beforeEach(() => {
  reports.clear();
  versions.clear();
  graphs.clear();
  requirements.clear();
  vulnerable.clear();
  delete process.env.SAFECTX_ALLOW;
  delete process.env.SAFECTX_HOOK_COOLDOWN;
  delete process.env.SAFECTX_HOOK_ON_ERROR;
});

describe('decide', () => {
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
