/**
 * Whole-tree audit with OSV and deps.dev replaced by fixtures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SAFECTX_NO_CACHE = '1';

const vulnsByPkg = new Map<string, string[]>(); // "name@version" -> ids
const vulnDetails = new Map<string, unknown>();
const graphs = new Map<string, unknown>(); // "name@version" -> deps.dev graph

vi.mock('../src/advisories/osv.js', async () => {
  const actual = await vi.importActual<typeof import('../src/advisories/osv.js')>('../src/advisories/osv.js');
  return {
    ...actual,
    queryBatch: vi.fn(async (items: { name: string; version: string }[]) => items.map((i) => vulnsByPkg.get(`${i.name}@${i.version}`) ?? [])),
    getVuln: vi.fn(async (id: string) => vulnDetails.get(id)),
  };
});
vi.mock('../src/advisories/depsdev.js', () => ({
  getDependencies: vi.fn(async (_e: string, name: string, version: string) => graphs.get(`${name}@${version}`)),
  getPackage: vi.fn(async () => undefined),
}));
vi.mock('../src/advisories/resolve.js', async () => {
  const actual = await vi.importActual<typeof import('../src/advisories/resolve.js')>('../src/advisories/resolve.js');
  return {
    ...actual,
    assessPackage: vi.fn(async (_e: string, name: string, version: string) =>
      name === 'parent'
        ? { safeVersionSameLine: '1.5.0', safeVersion: '2.0.0', line: '1.x' }
        : name === 'direct'
          ? { safeVersionSameLine: '3.1.0', line: '3.x' }
          : { line: version },
    ),
  };
});

const { auditTree, formatTreeAudit } = await import('../src/tree/audit.js');
const { parseFile } = await import('../src/tree/lockfiles.js');

function vuln(id: string, pkg: string, fixed: string, severity = 'HIGH') {
  vulnDetails.set(id, { id, summary: `bug ${id}`, aliases: [`CVE-${id}`], database_specific: { severity }, affected: [{ package: { name: pkg, ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed }] }] }] });
}

const lock = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { parent: '1.0.0', direct: '3.0.0', other: '1.0.0' } },
    'node_modules/parent': { version: '1.0.0', dependencies: { child: '^1' } },
    'node_modules/child': { version: '1.0.0' },
    'node_modules/direct': { version: '3.0.0' },
    'node_modules/other': { version: '1.0.0', dependencies: { deep: '*' } },
    'node_modules/deep': { version: '0.1.0' },
  },
});

beforeEach(() => {
  vulnsByPkg.clear();
  vulnDetails.clear();
  graphs.clear();
});

describe('auditTree', () => {
  it('finds direct and transitive advisories, counts alerts like Dependabot and proposes the right fix', async () => {
    vulnsByPkg.set('direct@3.0.0', ['GHSA-d']);
    vulnsByPkg.set('child@1.0.0', ['GHSA-c1', 'GHSA-c2']);
    vulnsByPkg.set('deep@0.1.0', ['GHSA-x']);
    vuln('GHSA-d', 'direct', '3.0.1', 'CRITICAL');
    vuln('GHSA-c1', 'child', '1.2.0');
    vuln('GHSA-c2', 'child', '1.3.0', 'MODERATE');
    vuln('GHSA-x', 'deep', '0.2.0', 'LOW');
    // parent@1.5.0 pulls a clean child; "other" has no safe upgrade data, so deep gets an override.
    graphs.set('parent@1.5.0', { nodes: [{ versionKey: { name: 'parent', version: '1.5.0' }, relation: 'SELF' }, { versionKey: { name: 'child', version: '1.3.0' }, relation: 'DIRECT' }], edges: [{ fromNode: 0, toNode: 1 }] });

    const a = await auditTree(parseFile('package-lock.json', lock));
    expect(a.packages).toBe(5);
    expect(a.vulnerablePackages).toBe(3);
    expect(a.alerts).toBe(4);
    expect(a.bySeverity).toMatchObject({ critical: 1, high: 1, moderate: 1, low: 1 });
    expect(a.findings[0]).toMatchObject({ name: 'direct', severity: 'CRITICAL', direct: true, fixedVersion: '3.0.1' });
    expect(a.findings.find((f) => f.name === 'child')).toMatchObject({ path: ['parent', 'child'], fixedVersion: '1.3.0' });

    const byTarget = Object.fromEntries(a.remediation.map((r) => [r.target, r]));
    expect(byTarget.direct).toMatchObject({ kind: 'upgrade-direct', to: '3.1.0', crossesMajor: false });
    expect(byTarget.parent).toMatchObject({ kind: 'upgrade-parent', to: '1.5.0', clears: ['child@1.0.0'], crossesMajor: false });
    expect(byTarget.deep).toMatchObject({ kind: 'override', to: '0.2.0' });
    expect(byTarget.deep.command).toContain('"overrides"');

    const text = formatTreeAudit(a);
    expect(text).toMatch(/^SECURITY NOTICE: 3 of 5 packages/);
    expect(text).toContain('via parent > child');
  });

  it('a clean tree says so', async () => {
    const a = await auditTree(parseFile('package-lock.json', lock));
    expect(a.alerts).toBe(0);
    expect(formatTreeAudit(a)).toMatch(/^Tree check: 5 packages .* no known advisories/);
  });

  it('no single fix when one advisory has no fixed version', async () => {
    vulnsByPkg.set('deep@0.1.0', ['GHSA-a', 'GHSA-b']);
    vuln('GHSA-a', 'deep', '0.2.0');
    vulnDetails.set('GHSA-b', { id: 'GHSA-b', aliases: [], affected: [] });
    const a = await auditTree(parseFile('package-lock.json', lock));
    expect(a.findings[0].fixedVersion).toBeUndefined();
    expect(formatTreeAudit(a)).toContain('no fix released');
  });
});
