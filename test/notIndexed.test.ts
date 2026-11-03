/**
 * deps.dev indexes new releases hours late. jsonpointer 3.8 (PyPI, uploaded 2026-11-02 21:52 UTC) was
 * still a 404 there eight hours later, and the hook denied it as "never published" and pointed at 3.6.0.
 * A deps.dev 404 is now confirmed against the registry before the version is called nonexistent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.PINRIGHT_NO_CACHE = '1';
process.env.PINRIGHT_COOLDOWN_DAYS = '3';

/** The end of a URL -> its JSON (or an Error to throw); anything else is a 404. */
const fixtures = new Map<string, unknown>();
const calls: string[] = [];
vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return {
    ...actual,
    getJson: vi.fn(async (url: string) => {
      calls.push(url);
      const key = [...fixtures.keys()].find((k) => url.endsWith(k));
      if (!key) throw new actual.HttpError(404, url);
      const v = fixtures.get(key);
      if (v instanceof Error) throw v;
      return v;
    }),
  };
});

const { assessPackage } = await import('../src/advisories/resolve.js');
const { checkPackage } = await import('../src/verdict.js');
const { decide, agentMessage } = await import('../src/hook/policy.js');
const { resolvePolicy } = await import('../src/teamConfig.js');
const { securityNotice } = await import('../src/format.js');
const { formatBatch } = await import('../src/batch.js');
const { HttpError } = await import('../src/http.js');
const { auditTree, formatTreeAudit } = await import('../src/tree/audit.js');
const { parseFile } = await import('../src/tree/lockfiles.js');
const { toFindings } = await import('../src/tree/supply.js');
const { buildSarif } = await import('../src/sarif/build.js');
const { annotations } = await import('../src/sarif/summary.js');

const DD = '/v3/systems/pypi/packages/jsonpointer';
const PYPI_38 = '/pypi/jsonpointer/3.8/json';
const old = '2025-06-01T00:00:00Z';
const ver = (v: string, isDefault = false) => ({ versionKey: { system: 'PYPI', name: 'jsonpointer', version: v }, publishedAt: old, isDefault, isDeprecated: false });

beforeEach(() => {
  fixtures.clear();
  calls.length = 0;
  fixtures.set(DD, { packageKey: { system: 'PYPI', name: 'jsonpointer' }, versions: [ver('3.0.0'), ver('3.6.0', true)] });
  fixtures.set(`${DD}/versions/3.6.0`, { ...ver('3.6.0', true), licenses: ['BSD-3-Clause'], advisoryKeys: [] });
  fixtures.set(`${DD}/versions/3.0.0`, { ...ver('3.0.0'), licenses: ['BSD-3-Clause'], advisoryKeys: [] });
  fixtures.set('/v1/query', { vulns: [] });
  fixtures.set('/v1/querybatch', { results: [] });
  // deps.dev has no /versions/3.8: the default 404.
});

const intent = { ecosystem: 'pypi' as const, name: 'jsonpointer', spec: '==3.8', source: 'requirements.txt' };

describe('deps.dev 404, the registry has the version', () => {
  beforeEach(() => fixtures.set(PYPI_38, { info: { version: '3.8' }, urls: [{ upload_time_iso_8601: '2026-11-02T21:52:11.123456Z' }] }));

  it('is not reported missing: the verdict is unknown and names the registry', async () => {
    const r = await assessPackage('pypi', 'jsonpointer', '3.8');
    expect(calls.some((u) => u === 'https://pypi.org/pypi/jsonpointer/3.8/json')).toBe(true);
    expect(r.verdict).toBe('unknown');
    expect(r.requested).toMatchObject({ version: '3.8', verdict: 'unknown', notIndexed: 'pypi.org', publishedAt: '2026-11-02T21:52:11.123456Z' });
    expect(r.reason).toBe(
      'version 3.8 of jsonpointer is published on pypi.org (published 2026-11-02 21:52 UTC), but deps.dev has no data for it yet ' +
        '(it indexes new releases with a delay of hours); osv.dev lists no advisories for it, and its licenses, deprecation status and risk signals could not be checked',
    );
  });

  it('the hook allows it with a note under the default onError, and asks under onError: ask', async () => {
    const d = await decide([intent], resolvePolicy(undefined, {}));
    expect(d.action).toBe('allow');
    expect(d.warnings.join('\n')).toMatch(/published on pypi\.org .*deps\.dev has no data for it yet/);
    expect(agentMessage(d)).not.toMatch(/never published|3\.6\.0/);
    const asked = await decide([intent], resolvePolicy({ onError: 'ask' }, {}));
    expect(asked.action).toBe('ask');
    expect(asked.problems.join('\n')).not.toMatch(/never published/);
  });

  it('the MCP notice and the batch table say the same', async () => {
    const v = await checkPackage('pypi', 'jsonpointer', '3.8');
    const notice = securityNotice(v.report, v.typo, v.risk);
    expect(notice).toMatch(/^NOTICE: no security verdict for jsonpointer \(pypi\): version 3\.8 of jsonpointer is published on pypi\.org/m);
    expect(notice).not.toMatch(/not in the registry|Do not use it|Recommended within|Upgrade:|License:/);
    expect(notice).toMatch(/full deps\.dev data and no known advisories: 3\.6\.0\. Switching to it is not a fix, since nothing known is wrong with 3\.8/);
    const table = formatBatch([{ ecosystem: 'pypi', name: 'jsonpointer', version: '3.8', verdict: v }]);
    expect(table).toMatch(/UNVERIFIED .*published on pypi\.org; deps\.dev has no data for it yet; osv\.dev lists no advisories/);
  });

  it('OSV still flags malware in a version deps.dev has not indexed', async () => {
    fixtures.set('/v1/query', { vulns: [{ id: 'MAL-2026-1', summary: 'Malicious code in jsonpointer' }] });
    const r = await assessPackage('pypi', 'jsonpointer', '3.8');
    expect(r.verdict).toBe('malicious');
    expect((await decide([intent], resolvePolicy(undefined, {}))).action).toBe('deny');
  });
});

describe('deps.dev 404 and the registry 404', () => {
  it('is still "never published"', async () => {
    const r = await assessPackage('pypi', 'jsonpointer', '3.8');
    expect(calls).toContain('https://pypi.org/pypi/jsonpointer/3.8/json');
    expect(r.verdict).toBe('unknown-package');
    expect(r.requested?.notIndexed).toBeUndefined();
    const d = await decide([intent], resolvePolicy(undefined, {}));
    expect(d.action).toBe('deny');
    expect(d.problems.join('\n')).toMatch(/version 3\.8 was never published/);
  });
});

describe('deps.dev 404 and the registry unreachable', () => {
  it('keeps the current answer (deps.dev decides)', async () => {
    fixtures.set(PYPI_38, new HttpError(503, 'pypi.org'));
    const r = await assessPackage('pypi', 'jsonpointer', '3.8');
    expect(r.verdict).toBe('unknown-package');
    const d = await decide([intent], resolvePolicy(undefined, {}));
    expect(d.action).toBe('deny');
    expect(d.problems.join('\n')).toMatch(/never published/);
  });

  it('an ecosystem without a registry client keeps deps.dev\'s answer, without asking anyone else', async () => {
    const path = '/v3/systems/maven/packages/org.acme%3Alib';
    const mv = { versionKey: { system: 'MAVEN', name: 'org.acme:lib', version: '1.0.0' }, publishedAt: old, isDefault: true };
    fixtures.set(path, { packageKey: { system: 'MAVEN', name: 'org.acme:lib' }, versions: [mv] });
    fixtures.set(`${path}/versions/1.0.0`, { ...mv, licenses: ['MIT'], advisoryKeys: [] });
    const r = await assessPackage('maven', 'org.acme:lib', '9.9.9');
    expect(r.verdict).toBe('unknown-package');
    expect(calls.every((u) => /deps\.dev|osv\.dev/.test(u))).toBe(true);
  });
});

describe('a package deps.dev has never seen but the registry publishes', () => {
  it('is unknown with the registry named, and the hook asks a human instead of saying "no such package"', async () => {
    fixtures.set('/pypi/zqvplorbatch/json', { info: { name: 'zqvplorbatch' } });
    const v = await checkPackage('pypi', 'zqvplorbatch');
    expect(v.report.verdict).toBe('unknown');
    expect(v.report.notIndexed).toBe('pypi.org');
    expect(v.report.reason).toMatch(/^zqvplorbatch is published on pypi\.org, but deps\.dev has no data for it yet/);
    const d = await decide([{ ecosystem: 'pypi', name: 'zqvplorbatch', spec: '==0.1.0', source: 'requirements.txt' }], resolvePolicy(undefined, {}));
    expect(d.action).toBe('ask');
    expect(d.problems.join('\n')).not.toMatch(/no such package/);
    expect((await decide([{ ecosystem: 'pypi', name: 'zqvplorbatch', source: 'pip install' }], resolvePolicy({ onError: 'deny' }, {}))).action).toBe('deny');
  });

  it('the registry does not know it either: still "no such package"', async () => {
    const d = await decide([{ ecosystem: 'pypi', name: 'zqvplorbatch', source: 'pip install' }], resolvePolicy(undefined, {}));
    expect(d.action).toBe('deny');
    expect(d.problems.join('\n')).toMatch(/no such package/);
  });
});

describe('check-packages: a fresh version with advisories', () => {
  it('the row says deps.dev has no data for it, next to the advisories osv.dev lists', async () => {
    fixtures.set(PYPI_38, { urls: [{ upload_time_iso_8601: '2026-11-02T21:52:11Z' }] });
    fixtures.set('/v1/query', { vulns: [{ id: 'GHSA-j1', summary: 'Pointer escape', database_specific: { severity: 'HIGH' } }] });
    const v = await checkPackage('pypi', 'jsonpointer', '3.8');
    expect(v.report.verdict).toBe('vulnerable');
    const table = formatBatch([{ ecosystem: 'pypi', name: 'jsonpointer', version: '3.8', verdict: v }]);
    expect(table).toMatch(/\| pypi jsonpointer \| 3\.8 \| VULNERABLE \(1, HIGH\) \|.*published on pypi\.org; deps\.dev has no data for it yet \|/);
  });
});

describe('check-manifest: deps.dev has not indexed a declared dependency yet', () => {
  /** A manifest (one line is a range), so the tree is resolved through deps.dev. */
  const manifest = 'jsonpointer==3.8\nzqvplorbatch>=0.1\n';

  it('a fresh pin is audited by osv.dev and noted unverified; a fresh package is noted, not "not found"', async () => {
    fixtures.set(PYPI_38, { urls: [{ upload_time_iso_8601: '2026-11-02T21:52:11Z' }] });
    fixtures.set('/pypi/zqvplorbatch/json', { info: { name: 'zqvplorbatch' } });
    fixtures.set('/v1/querybatch', { results: [{}] });
    const packages: import('../src/tree/lockfiles.js').TreePackage[] = [];
    const a = await auditTree(parseFile('requirements.txt', manifest), { packagesOut: packages });
    expect(packages).toMatchObject([{ name: 'jsonpointer', version: '3.8', direct: true, notIndexed: { registry: 'pypi.org', package: false } }]);
    const text = formatTreeAudit(a);
    expect(text).toContain(
      'Note: jsonpointer 3.8: unverified. It is published on pypi.org, but deps.dev has no data for this version yet (it indexes new releases with a delay of hours); ' +
        'osv.dev lists no advisories for it, its dependencies were not resolved, and its licenses, deprecation status and risk signals could not be checked.',
    );
    expect(text).toContain(
      'Note: zqvplorbatch: unverified. It is published on pypi.org, but deps.dev has no data for it yet (it indexes new packages with a delay of hours), ' +
        'so the version ">=0.1" installs could not be told and it was not audited.',
    );
    expect(text).not.toMatch(/not found in the pypi registry|no published version satisfies/);
  });

  it('osv.dev advisories on the fresh pin are findings, and the note counts them', async () => {
    fixtures.set(PYPI_38, { urls: [] });
    fixtures.set('/v1/querybatch', { results: [{ vulns: [{ id: 'GHSA-j1' }] }] });
    fixtures.set('/v1/vulns/GHSA-j1', { id: 'GHSA-j1', summary: 'Pointer escape', database_specific: { severity: 'HIGH' } });
    const a = await auditTree(parseFile('requirements.txt', manifest));
    expect(a.findings).toMatchObject([{ name: 'jsonpointer', version: '3.8', severity: 'HIGH' }]);
    expect(formatTreeAudit(a)).toContain('osv.dev lists 1 advisory for it, its dependencies were not resolved');
  });

  it('only an exact pin names a version to ask the registry about', async () => {
    const { exactVersion } = await import('../src/tree/resolveManifest.js');
    expect(['==3.8', '===3.8', '>=3.8', '~=3.8'].map((s) => exactVersion('pypi', s))).toEqual(['3.8', '3.8', undefined, undefined]);
    expect(['1.2.3', '=1.2.3', 'v1.2.3', '^1.2.3', '1.2', '1.2.3-rc.1'].map((s) => exactVersion('npm', s))).toEqual(['1.2.3', '1.2.3', '1.2.3', undefined, undefined, '1.2.3-rc.1']);
    // Cargo's bare "1.2.3" means "^1.2.3".
    expect(['=1.2.3', '1.2.3'].map((s) => exactVersion('cargo', s))).toEqual(['1.2.3', undefined]);
    expect(exactVersion('maven', '1.2.3')).toBeUndefined();
  });

  it('the registry does not publish them either: the notes it always gave', async () => {
    const a = await auditTree(parseFile('requirements.txt', manifest));
    expect(a.packages).toBe(0);
    const text = formatTreeAudit(a);
    expect(text).toContain('Note: jsonpointer: no published version satisfies "==3.8".');
    expect(text).toContain('Note: zqvplorbatch: not found in the pypi registry (deps.dev).');
    expect(text).not.toContain('unverified');
  });

  it('audit (CLI and Action): a supply finding per entry, rendered in SARIF and as an annotation, never blocking', async () => {
    fixtures.set(PYPI_38, { urls: [] });
    fixtures.set('/pypi/zqvplorbatch/json', { info: { name: 'zqvplorbatch' } });
    const version = toFindings({ name: 'jsonpointer', version: '3.8', direct: true }, await checkPackage('pypi', 'jsonpointer', '3.8'));
    expect(version).toMatchObject([{ kind: 'not-indexed', blocking: false, level: 'note' }]);
    expect(version[0].message).toBe(
      'jsonpointer@3.8: unverified. It is published on pypi.org, but deps.dev has no data for this version yet (it indexes new releases with a delay of hours); ' +
        'osv.dev lists no advisories for it, and its licenses, deprecation status and risk signals could not be checked.',
    );
    const pkg = toFindings({ name: 'zqvplorbatch', version: '0.1.0', direct: true }, await checkPackage('pypi', 'zqvplorbatch', '0.1.0'));
    expect(pkg).toMatchObject([{ kind: 'not-indexed', blocking: false, level: 'warning' }]);
    expect(pkg[0].message).toMatch(/^zqvplorbatch@0\.1\.0: unverified\. zqvplorbatch is published on pypi\.org, but deps\.dev has no data for it yet/);
    const file = 'requirements.txt';
    fixtures.set('/v1/querybatch', { results: [{}] });
    const log = buildSarif({
      root: '.',
      toolVersion: '0.0.0',
      trees: [{ audit: { ...(await auditTree(parseFile(file, 'jsonpointer==3.6.0\n'))), file }, supply: [...version, ...pkg] }],
      read: () => 'jsonpointer==3.8\nzqvplorbatch==0.1.0\n',
    });
    const results = log.runs[0].results as { ruleId: string; level: string }[];
    expect(results.map((r) => [r.ruleId, r.level])).toEqual(expect.arrayContaining([['pinright/not-indexed', 'note'], ['pinright/not-indexed', 'warning']]));
    const ann = annotations(log).join('\n');
    expect(ann).toMatch(/::warning .*::zqvplorbatch@0\.1\.0: unverified/);
    expect(ann).toMatch(/::notice .*::jsonpointer@3\.8: unverified/);
  });
});
