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
const { checkPackages, formatBatch } = await import('../src/batch.js');

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

describe('check-packages: the packages in one call set ranges on each other', () => {
  /** The rows as checkPackages returns them, from the mocked verdicts. */
  const batch = (items: { name: string; version?: string }[], eco = 'pypi') => checkPackages(items.map((i) => ({ ...i, ecosystem: eco })));

  it('stirrup, moviepy and pillow together: pillow 13.0.0 is not recommended, and the details say why', async () => {
    stirrup();
    versions.set('moviepy', ['2.1.2', '2.2.1']);
    reports.set('moviepy@2.2.1', { verdict: 'ok', requested: { version: '2.2.1', verdict: 'ok', advisories: [] } });
    graphs.set('moviepy@2.2.1', { nodes: [node('moviepy', '2.2.1'), node('pillow', '11.3.0')], edges: [{ fromNode: 0, toNode: 1, requirement: '<12.0,>=9.2.0' }] });
    const res = await batch([{ name: 'stirrup', version: '0.2.1' }, { name: 'moviepy', version: '2.2.1' }, { name: 'pillow', version: '11.3.0' }]);
    const out = formatBatch(res);
    expect(out).toContain("| pypi pillow | 11.3.0 | VULNERABLE (2, HIGH) | - | 13.0.0 is outside moviepy 2.2.1's pillow<12.0,>=9.2.0 and no clean release fits it; see details |");
    expect(out).toContain('NOTE (packages in this call): pillow 13.0.0 fixes the advisories of pillow 11.3.0, but moviepy 2.2.1 requires pillow<12.0,>=9.2.0.');
    expect(out).toContain('No pillow release in that range is free of them');
    expect(out).toContain('No moviepy release accepts pillow 13.0.0 yet (newest: 2.2.1)');
    expect(out).toContain('A pillow pin outside that range would make the install fail.');
    // The notice under the NOTE does not recommend the upgrade the NOTE says would not install.
    expect(out).not.toContain('pillow==13.0.0');
    expect(out).not.toMatch(/Upgrade: pip install "pillow|upgrade-guide from 11\.3\.0 to 13\.0\.0/);
    // The other rows are untouched.
    expect(out).toContain('| pypi stirrup | 0.2.1 | ok | 0.2.1 |');
  });

  it('a clean release inside the range becomes the version to use', async () => {
    stirrup();
    versions.set('pillow', ['10.4.0', '11.0.0', '11.3.0', '11.3.1', '12.0.0', '13.0.0']);
    const out = formatBatch(await batch([{ name: 'stirrup', version: '0.2.1' }, { name: 'pillow', version: '11.3.0' }]));
    expect(out).toContain("| pypi pillow | 11.3.0 | VULNERABLE (2, HIGH) | 11.3.1 | 13.0.0 is outside moviepy 2.2.1's pillow<12.0,>=9.2.0 (via stirrup 0.2.1); 11.3.1 is the newest clean release in range |");
    expect(out).toContain('The newest pillow release in that range with no known advisories is 11.3.1: pip install "pillow==11.3.1"');
    // The notice's own Upgrade line points at the release in range, not at 13.0.0.
    expect(out).toContain('Recommended within the ranges of the other packages: 11.3.1. Upgrade: pip install "pillow==11.3.1"');
    expect(out).not.toContain('pillow==13.0.0');
  });

  it('without a conflict the notice keeps its own Upgrade line', async () => {
    stirrup('<14.0,>=9.2.0');
    const out = formatBatch(await batch([{ name: 'stirrup', version: '0.2.1' }, { name: 'pillow', version: '11.3.0' }]));
    expect(out).toContain('Upgrade: pip install "pillow==13.0.0"');
  });

  it('a pin asked for outside a range in the call gets a note; the version stays', async () => {
    stirrup();
    reports.set('pillow@13.0.0', { verdict: 'ok', requested: { version: '13.0.0', verdict: 'ok', advisories: [] } });
    const out = formatBatch(await batch([{ name: 'stirrup', version: '0.2.1' }, { name: 'pillow', version: '13.0.0' }]));
    expect(out).toContain("| pypi pillow | 13.0.0 | ok | 13.0.0 | outside moviepy 2.2.1's pillow<12.0,>=9.2.0 (via stirrup 0.2.1): the install will likely fail |");
    expect(out).toContain("NOTE (packages in this call): pillow 13.0.0 is outside moviepy 2.2.1's requirement pillow<12.0,>=9.2.0, and stirrup 0.2.1 pulls moviepy 2.2.1.");
  });

  it('pillow alone, or with a range that accepts the fix: the table it always was', async () => {
    stirrup();
    const alone = formatBatch(await batch([{ name: 'pillow', version: '11.3.0' }]));
    expect(alone).toContain('| pypi pillow | 11.3.0 | VULNERABLE (2, HIGH) | 13.0.0 | fix needs a new major: breaking changes |');
    expect(alone).not.toContain('NOTE (packages');
    stirrup('<14.0,>=9.2.0');
    const fits = formatBatch(await batch([{ name: 'stirrup', version: '0.2.1' }, { name: 'pillow', version: '11.3.0' }]));
    expect(fits).toContain('| pypi pillow | 11.3.0 | VULNERABLE (2, HIGH) | 13.0.0 | fix needs a new major: breaking changes |');
    expect(fits).not.toContain('NOTE (packages');
  });

  it('npm: a peer range in the call excludes a fix on a new major; a same-line fix reads no peer range', async () => {
    versions.set('react', ['18.2.0', '18.3.1', '19.1.0']);
    versions.set('react-dom', ['18.3.1', '19.1.0']);
    peers.set('react-dom@18.3.1', { react: '^18.3.1' });
    peers.set('react-dom@19.1.0', { react: '^19.1.0' });
    vulnerable.set('react@18.2.0', ['GHSA-r1', 'GHSA-r2']);
    vulnerable.set('react@18.3.1', ['GHSA-r2']);
    reports.set('react-dom@18.3.1', { verdict: 'ok', requested: { version: '18.3.1', verdict: 'ok', advisories: [] } });
    reports.set('react@18.2.0', {
      verdict: 'vulnerable', line: '18.x', crossLineRequired: true, safeVersion: '19.1.0',
      requested: { version: '18.2.0', verdict: 'vulnerable', advisories: [adv('r1'), adv('r2')] },
    });
    const out = formatBatch(await batch([{ name: 'react-dom', version: '18.3.1' }, { name: 'react', version: '18.2.0' }], 'npm'));
    expect(out).toContain("| npm react | 18.2.0 | VULNERABLE (2, HIGH) | - | 19.1.0 is outside react-dom 18.3.1's peer range react ^18.3.1 and no clean release fits it; see details |");
    expect(out).toContain('react 19.1.0 fixes the advisories of react 18.2.0, but react-dom 18.3.1 requires react ^18.3.1 as a peer dependency.');
    expect(out).toContain('npm stops the install with a peer dependency conflict.');
    expect(out).not.toContain('npm install react@19.1.0');

    calls.peers = 0;
    reports.set('react@18.2.0', {
      verdict: 'vulnerable', line: '18.x', safeVersionSameLine: '18.3.1', safeVersion: '19.1.0',
      requested: { version: '18.2.0', verdict: 'vulnerable', advisories: [adv('r1')] },
    });
    const same = formatBatch(await batch([{ name: 'react-dom', version: '18.3.1' }, { name: 'react', version: '18.2.0' }], 'npm'));
    expect(same).toContain('| npm react | 18.2.0 | VULNERABLE (1, HIGH) | 18.3.1 | fix on the same release line |');
    expect(calls.peers).toBe(0);
  });

  it('a lookup that fails leaves the table as it was', async () => {
    stirrup();
    const { getDependencies } = await import('../src/advisories/depsdev.js');
    vi.mocked(getDependencies).mockRejectedValueOnce(new Error('HTTP 503')).mockRejectedValueOnce(new Error('HTTP 503'));
    const out = formatBatch(await batch([{ name: 'stirrup', version: '0.2.1' }, { name: 'pillow', version: '11.3.0' }]));
    expect(out).toContain('| pypi pillow | 11.3.0 | VULNERABLE (2, HIGH) | 13.0.0 | fix needs a new major: breaking changes |');
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

  it('a direct pin whose fix is out of range: no upgrade to 13.0.0 in the fixes, nor in the hook', async () => {
    stirrup();
    const text = formatTreeAudit(await auditTree(parseFile('requirements.txt', 'stirrup>=0.2\npillow==11.3.0\n')));
    expect(text).toContain('Note: pillow 13.0.0 fixes the advisories of pillow 11.3.0, but moviepy 2.2.1 (via stirrup 0.2.1) requires pillow<12.0,>=9.2.0.');
    expect(text).not.toMatch(/pillow==13\.0\.0|pillow>=13\.0\.0/);
    const d = await decide([
      { ecosystem: 'pypi', name: 'stirrup', spec: '==0.2.1', source: 'requirements.txt' },
      { ecosystem: 'pypi', name: 'pillow', spec: '==11.3.0', source: 'requirements.txt' },
    ]);
    expect([...d.problems, ...d.warnings].join('\n')).not.toMatch(/pillow==13\.0\.0|Upgrade:/);
  });

  it('no conflict: the override stays', async () => {
    stirrup('<14.0,>=9.2.0');
    const a = await auditTree(parseFile('requirements.txt', 'stirrup>=0.2\n'));
    expect(a.remediation.find((r) => r.target === 'pillow')).toMatchObject({ kind: 'override', to: '13.0.0' });
  });
});
