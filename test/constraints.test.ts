/**
 * A recommended fix against the ranges the rest of the project sets on that package. The fixture is the
 * benchmark case (bench/RESULTS-real-issues.md, stirrup-gdpval): stirrup 0.2.1 pulls moviepy 2.2.1, which
 * requires pillow<12.0, and pillow 11.3.0's advisories are fixed only in 13.0.0. The hook used to say
 * "consider an override", and agents pinned pillow==13.0.0, which does not resolve.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageReport } from '../src/advisories/resolve.js';

process.env.PINRIGHT_NO_CACHE = '1';

const reports = new Map<string, Partial<PackageReport>>();
const versions = new Map<string, string[]>(); // name -> versions, oldest first; the last is the default
type Graph = { nodes: { versionKey: { name: string; version: string } }[]; edges: { fromNode: number; toNode: number; requirement?: string }[] };
const graphs = new Map<string, Graph>(); // "name@version"
const peers = new Map<string, Record<string, string>>(); // "name@version" -> peer ranges
const vulnerable = new Map<string, string[]>(); // "name@version" -> OSV ids
const fixedIn = new Map<string, string>(); // OSV id -> fixed version
const calls = { peers: 0 };

vi.mock('../src/verdict.js', () => ({
  checkPackage: vi.fn(async (eco: string, name: string, version?: string) => {
    const r = reports.get(`${name}@${version ?? ''}`) ?? reports.get(name) ?? { verdict: 'ok' };
    return { report: { package: name, ecosystem: eco, checkedAt: '', sources: [], ...r } };
  }),
}));
vi.mock('../src/advisories/osv.js', async () => {
  const actual = await vi.importActual<typeof import('../src/advisories/osv.js')>('../src/advisories/osv.js');
  const vulnOf = (id: string, name: string) => ({
    id,
    aliases: [],
    database_specific: { severity: 'HIGH' },
    affected: [{ package: { name, ecosystem: 'PyPI' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: fixedIn.get(id) }] }] }],
  });
  return {
    ...actual,
    queryBatch: vi.fn(async (items: { name: string; version: string }[]) => items.map((i) => vulnerable.get(`${i.name}@${i.version}`) ?? [])),
    queryVersion: vi.fn(async (_eco: string, name: string, version: string) => (vulnerable.get(`${name}@${version}`) ?? []).map((id) => vulnOf(id, name))),
    getVuln: vi.fn(async (id: string) => vulnOf(id, 'pillow')),
  };
});
vi.mock('../src/advisories/depsdev.js', () => ({
  getDependencies: vi.fn(async (_eco: string, name: string, version: string) => graphs.get(`${name}@${version}`)),
  getPackage: vi.fn(async (_eco: string, name: string) => {
    const vs = versions.get(name);
    return vs ? { versions: vs.map((v, i) => ({ versionKey: { name, version: v }, isDefault: i === vs.length - 1, publishedAt: '2026-01-01T00:00:00Z' })) } : undefined;
  }),
  getPeerRequirements: vi.fn(async (_eco: string, name: string, version: string) => {
    calls.peers++;
    const p = peers.get(`${name}@${version}`);
    return p ? new Map(Object.entries(p)) : new Map();
  }),
}));
vi.mock('../src/advisories/resolve.js', async () => {
  const actual = await vi.importActual<typeof import('../src/advisories/resolve.js')>('../src/advisories/resolve.js');
  return {
    ...actual,
    assessPackage: vi.fn(async (_eco: string, name: string, version: string) => reports.get(`${name}@${version}`) ?? { line: version }),
  };
});

const { decide } = await import('../src/hook/policy.js');
const { auditTree, formatTreeAudit } = await import('../src/tree/audit.js');
const { parseFile } = await import('../src/tree/lockfiles.js');
const { graphConstraints, satisfiesRequirement } = await import('../src/tree/constraints.js');

const node = (name: string, version: string) => ({ versionKey: { name, version } });
const adv = (id: string) => ({ id, aliases: [`CVE-${id}`], url: '', severity: 'HIGH' });

/** stirrup 0.2.1 -> moviepy 2.2.1 -> pillow, with moviepy's cap; stirrup's own range on pillow is open. */
function stirrup(moviepyCap = '<12.0,>=9.2.0') {
  versions.set('stirrup', ['0.2.1']);
  versions.set('moviepy', ['2.1.2', '2.2.1']);
  versions.set('pillow', ['10.4.0', '11.0.0', '11.3.0', '12.0.0', '13.0.0']);
  graphs.set('stirrup@0.2.1', {
    nodes: [node('stirrup', '0.2.1'), node('moviepy', '2.2.1'), node('pillow', '11.3.0'), node('imageio', '2.38.1')],
    edges: [
      { fromNode: 0, toNode: 1, requirement: '>=2.0.0' },
      { fromNode: 0, toNode: 2, requirement: '>=10.4.0' },
      { fromNode: 0, toNode: 3, requirement: '>=2.0' },
      { fromNode: 1, toNode: 2, requirement: moviepyCap },
      { fromNode: 3, toNode: 2, requirement: '>=8.3.2' },
    ],
  });
  reports.set('stirrup@0.2.1', { verdict: 'ok', line: '0.2.x', safeVersion: '0.2.1', requested: { version: '0.2.1', verdict: 'ok', advisories: [] } });
  for (const v of ['10.4.0', '11.0.0']) vulnerable.set(`pillow@${v}`, ['GHSA-a', 'GHSA-b', 'GHSA-old']);
  vulnerable.set('pillow@11.3.0', ['GHSA-a', 'GHSA-b']);
  vulnerable.set('pillow@12.0.0', ['GHSA-b']);
  fixedIn.set('GHSA-a', '12.0.0');
  fixedIn.set('GHSA-b', '13.0.0');
  fixedIn.set('GHSA-old', '11.3.0');
  reports.set('pillow@11.3.0', {
    verdict: 'vulnerable', line: '11.x', crossLineRequired: true, safeVersion: '13.0.0',
    requested: { version: '11.3.0', verdict: 'vulnerable', advisories: [adv('a'), adv('b')] },
  });
}

beforeEach(() => {
  reports.clear();
  versions.clear();
  graphs.clear();
  peers.clear();
  vulnerable.clear();
  fixedIn.clear();
  calls.peers = 0;
  delete process.env.PINRIGHT_HOOK_ON_ERROR;
});

describe('graph ranges', () => {
  it('collects the root\'s own range and the ranges deeper in its tree, with the chain', () => {
    stirrup();
    const cons = graphConstraints('pypi', graphs.get('stirrup@0.2.1'), 'Pillow');
    expect(cons).toHaveLength(3);
    expect(cons).toContainEqual({ by: 'moviepy', byVersion: '2.2.1', requirement: '<12.0,>=9.2.0', via: 'stirrup', viaVersion: '0.2.1', viaRequirement: '>=2.0.0' });
    expect(cons.filter((c) => satisfiesRequirement('pypi', '13.0.0', c.requirement) === false).map((c) => c.by)).toEqual(['moviepy']);
    // npm nests a second copy for an ordinary dependency: graph ranges do not bind there.
    expect(graphConstraints('npm', graphs.get('stirrup@0.2.1'), 'pillow')).toEqual([]);
  });
});

describe('hook: a fix another dependency forbids', () => {
  it('pillow pinned next to stirrup: names moviepy\'s cap instead of recommending pillow 13.0.0', async () => {
    stirrup();
    const d = await decide([
      { ecosystem: 'pypi', name: 'stirrup', spec: '==0.2.1', source: 'requirements.txt' },
      { ecosystem: 'pypi', name: 'pillow', spec: '==11.3.0', source: 'requirements.txt' },
    ]);
    const text = d.problems.join('\n');
    expect(d.action).toBe('ask');
    expect(text).toContain('pillow 13.0.0 fixes these advisories, but moviepy 2.2.1 (via stirrup 0.2.1) requires pillow<12.0,>=9.2.0.');
    expect(text).toContain('No pillow release in that range is free of them.');
    expect(text).toContain('No moviepy release accepts pillow 13.0.0 yet (newest: 2.2.1)');
    expect(text).toContain('A pillow pin outside that range would make the install fail.');
    expect(text).not.toContain('pillow==13.0.0');
  });

  it('stirrup alone: the transitive note explains why an override to 13.0.0 would not install', async () => {
    stirrup();
    const d = await decide([{ ecosystem: 'pypi', name: 'stirrup', spec: '==0.2.1', source: 'requirements.txt' }]);
    expect(d.action).toBe('allow');
    const w = d.warnings.join('\n');
    expect(w).toContain('no release of stirrup fixes them yet.');
    expect(w).toContain('pillow 13.0.0 fixes the advisories of pillow 11.3.0, but moviepy 2.2.1 (via stirrup 0.2.1) requires pillow<12.0,>=9.2.0.');
    expect(w).toContain('or accepting the advisories, are the options.');
    expect(w).not.toContain('consider an override');
  });

  it('pillow==13.0.0 written next to stirrup: a note that the install will likely fail', async () => {
    stirrup();
    reports.set('pillow@13.0.0', { verdict: 'ok', requested: { version: '13.0.0', verdict: 'ok', advisories: [] } });
    const d = await decide([
      { ecosystem: 'pypi', name: 'stirrup', spec: '==0.2.1', source: 'requirements.txt' },
      { ecosystem: 'pypi', name: 'pillow', spec: '==13.0.0', source: 'requirements.txt' },
    ]);
    expect(d.action).toBe('allow');
    expect(d.warnings.join('\n')).toContain("pillow 13.0.0 is outside moviepy 2.2.1's requirement pillow<12.0,>=9.2.0, and stirrup 0.2.1 pulls moviepy 2.2.1.");
  });

  it('a newer release of the package that sets the range lifts it: says which one', async () => {
    stirrup();
    versions.set('moviepy', ['2.1.2', '2.2.1', '2.3.0']);
    graphs.set('moviepy@2.3.0', { nodes: [node('moviepy', '2.3.0'), node('pillow', '13.0.0')], edges: [{ fromNode: 0, toNode: 1, requirement: '<14.0,>=9.2.0' }] });
    const d = await decide([
      { ecosystem: 'pypi', name: 'stirrup', spec: '==0.2.1', source: 'requirements.txt' },
      { ecosystem: 'pypi', name: 'pillow', spec: '==11.3.0', source: 'requirements.txt' },
    ]);
    expect(d.problems.join('\n')).toContain('moviepy 2.3.0 accepts pillow 13.0.0 and fits stirrup 0.2.1: upgrading moviepy to it, or accepting the advisories, are the options.');
  });

  it('a clean release inside the range: recommends it and blocks toward it', async () => {
    stirrup();
    versions.set('pillow', ['10.4.0', '11.0.0', '11.3.0', '11.3.1', '12.0.0', '13.0.0']);
    const d = await decide([
      { ecosystem: 'pypi', name: 'stirrup', spec: '==0.2.1', source: 'requirements.txt' },
      { ecosystem: 'pypi', name: 'pillow', spec: '==11.3.0', source: 'requirements.txt' },
    ]);
    expect(d.action).toBe('deny');
    expect(d.problems.join('\n')).toContain('The newest pillow release in that range with no known advisories is 11.3.1: pip install "pillow==11.3.1"');
  });

  it('no conflict: when the range accepts the fix, the message is the one it always was', async () => {
    stirrup('<14.0,>=9.2.0');
    const d = await decide([
      { ecosystem: 'pypi', name: 'stirrup', spec: '==0.2.1', source: 'requirements.txt' },
      { ecosystem: 'pypi', name: 'pillow', spec: '==11.3.0', source: 'requirements.txt' },
    ]);
    expect(d.action).toBe('deny');
    expect(d.problems[0]).toContain('the fix needs a new major, 13.0.0: pip install "pillow==13.0.0"');
    expect(d.problems.join('\n')).not.toMatch(/requires pillow|in that range/);
    expect(d.warnings.join('\n')).not.toContain('outside');
  });
});

describe('hook: npm peer ranges', () => {
  function react(peerOfDom: string) {
    versions.set('react', ['18.2.0', '18.3.1', '19.1.0']);
    versions.set('react-dom', ['18.3.1', '19.1.0']);
    peers.set('react-dom@18.3.1', { react: peerOfDom });
    peers.set('react-dom@19.1.0', { react: '^19.1.0' });
    vulnerable.set('react@18.2.0', ['GHSA-r1', 'GHSA-r2']);
    vulnerable.set('react@18.3.1', ['GHSA-r2']);
    reports.set('react-dom@18.3.1', { verdict: 'ok', requested: { version: '18.3.1', verdict: 'ok', advisories: [] } });
    reports.set('react@18.2.0', {
      verdict: 'vulnerable', line: '18.x', crossLineRequired: true, safeVersion: '19.1.0',
      requested: { version: '18.2.0', verdict: 'vulnerable', advisories: [adv('r1'), adv('r2')] },
    });
  }

  it('a fix on a new major that a declared package\'s peer range excludes: names it and the least exposed release in range', async () => {
    react('^18.3.1');
    const d = await decide([
      { ecosystem: 'npm', name: 'react-dom', spec: '18.3.1', source: 'package.json' },
      { ecosystem: 'npm', name: 'react', spec: '18.2.0', source: 'package.json' },
    ]);
    const text = d.problems.join('\n');
    expect(d.action).toBe('deny');
    expect(text).toContain('react 19.1.0 fixes these advisories, but react-dom 18.3.1 requires react ^18.3.1 as a peer dependency.');
    expect(text).toContain('the least exposed is 18.3.1 (1 advisory): npm install react@18.3.1.');
    expect(text).toContain('react-dom 19.1.0 accepts react 19.1.0: upgrading react-dom to it, or accepting the advisories, are the options.');
    expect(text).toContain('npm stops the install with a peer dependency conflict.');
  });

  it('a peer range that accepts the fix changes nothing', async () => {
    react('^18.0.0 || ^19.0.0');
    const d = await decide([
      { ecosystem: 'npm', name: 'react-dom', spec: '18.3.1', source: 'package.json' },
      { ecosystem: 'npm', name: 'react', spec: '18.2.0', source: 'package.json' },
    ]);
    expect(d.action).toBe('deny');
    expect(d.problems[0]).toContain('the fix needs a new major, 19.1.0: npm install react@19.1.0');
    expect(d.problems[0]).not.toContain('peer');
  });

  it('a same-line fix does not read peer ranges at all', async () => {
    react('^18.3.1');
    reports.set('react@18.2.0', {
      verdict: 'vulnerable', line: '18.x', safeVersionSameLine: '18.3.1', safeVersion: '19.1.0',
      requested: { version: '18.2.0', verdict: 'vulnerable', advisories: [adv('r1')] },
    });
    const d = await decide([
      { ecosystem: 'npm', name: 'react-dom', spec: '18.3.1', source: 'package.json' },
      { ecosystem: 'npm', name: 'react', spec: '18.2.0', source: 'package.json' },
    ]);
    expect(d.problems[0]).toContain('npm install react@18.3.1');
    expect(calls.peers).toBe(0);
  });
});

describe('check-manifest: the override of a transitive package', () => {
  it('notes the range instead of "pin pillow to 13.0.0 or newer"', async () => {
    stirrup();
    const a = await auditTree(parseFile('requirements.txt', 'stirrup>=0.2\n'));
    expect(a.remediation.find((r) => r.target === 'pillow')).toBeUndefined();
    const text = formatTreeAudit(a);
    expect(text).toContain('Note: pillow 13.0.0 fixes the advisories of pillow 11.3.0, but moviepy 2.2.1 (via stirrup 0.2.1) requires pillow<12.0,>=9.2.0.');
    expect(text).not.toContain('pillow>=13.0.0');
  });

  it('no conflict: the override stays', async () => {
    stirrup('<14.0,>=9.2.0');
    const a = await auditTree(parseFile('requirements.txt', 'stirrup>=0.2\n'));
    expect(a.remediation.find((r) => r.target === 'pillow')).toMatchObject({ kind: 'override', to: '13.0.0' });
  });
});
