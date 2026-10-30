/**
 * The same-line fix whose own tree is still vulnerable (benchmark v5: next@15.5.28
 * is clean, but next 15 pins a postcss with advisories that only next 16 clears).
 * The recommendation stays on the line; the notice, the batch and the hook say
 * what staying there keeps. deps.dev and OSV are replaced by a fake fetch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SAFECTX_NO_CACHE = '1';
process.env.SAFECTX_COOLDOWN_DAYS = '3';

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const VERSIONS = ['15.5.27', '15.5.28', '16.4.3'];
/** Direct dependencies of each nextfix version, as deps.dev resolves them. */
let graphs: Record<string, [string, string][]>;
/** OSV ids per "name@version". */
let vulns: Record<string, string[]>;
let graphCalls: string[];

function graph(version: string) {
  const deps = graphs[version] ?? [];
  return {
    nodes: [
      { versionKey: { system: 'NPM', name: 'nextfix', version }, relation: 'SELF' },
      ...deps.map(([name, v]) => ({ versionKey: { system: 'NPM', name, version: v }, relation: 'DIRECT' })),
    ],
    edges: deps.map((_, k) => ({ fromNode: 0, toNode: k + 1, requirement: '*' })),
  };
}

const osvVuln = (id: string, name: string, fixed: string) => ({
  id,
  summary: `${id} in ${name}`,
  affected: [{ package: { name, ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed }] }] }],
});

vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.host === 'api.deps.dev') {
    const p = decodeURIComponent(url.pathname);
    if (p.endsWith('/packages/nextfix')) {
      return json({
        packageKey: { system: 'NPM', name: 'nextfix' },
        versions: VERSIONS.map((v, k) => ({ versionKey: { system: 'NPM', name: 'nextfix', version: v }, publishedAt: ago(200 - k * 10), isDefault: v === '16.4.3' })),
      });
    }
    const deps = p.match(/\/packages\/nextfix\/versions\/([^/]+):dependencies$/);
    if (deps) {
      graphCalls.push(deps[1]);
      return json(graph(deps[1]));
    }
    const ver = p.match(/\/packages\/nextfix\/versions\/([^/:]+)$/);
    if (ver) return json({ versionKey: { system: 'NPM', name: 'nextfix', version: ver[1] }, publishedAt: ago(100), licenses: ['MIT'], advisoryKeys: (vulns[`nextfix@${ver[1]}`] ?? []).map((id) => ({ id })) });
    return new Response(null, { status: 404 });
  }
  if (url.host === 'api.osv.dev') {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (url.pathname.endsWith('/querybatch')) {
      return json({ results: body.queries.map((q: { package: { name: string }; version: string }) => ({ vulns: (vulns[`${q.package.name}@${q.version}`] ?? []).map((id) => ({ id })) })) });
    }
    if (url.pathname.endsWith('/query')) {
      const ids = vulns[`${body.package.name}@${body.version}`] ?? [];
      return json(ids.length ? { vulns: ids.map((id) => osvVuln(id, body.package.name, '99.0.0')) } : {});
    }
    const id = url.pathname.match(/\/vulns\/(.+)$/)?.[1];
    if (id) return json(osvVuln(decodeURIComponent(id), 'postcssx', '8.4.31'));
  }
  return new Response(null, { status: 404 });
});

const { checkPackage } = await import('../src/verdict.js');
const { securityNotice } = await import('../src/format.js');
const { checkPackages, formatBatch } = await import('../src/batch.js');
const { decide } = await import('../src/hook/policy.js');

beforeEach(() => {
  graphs = { '15.5.27': [['postcssx', '8.4.31']], '15.5.28': [['postcssx', '8.4.31']], '16.4.3': [['postcssx', '8.5.6']] };
  vulns = { 'nextfix@15.5.27': ['GHSA-next-0001'], 'postcssx@8.4.31': ['GHSA-7fh5-64p2-3v2j'] };
  graphCalls = [];
});

const NOTE =
  'nextfix 15.5.28 has no advisories itself, but pulls postcssx@8.4.31 (GHSA-7fh5-64p2-3v2j); nextfix 16.4.3 pulls a fixed one. ' +
  'Staying on 15.x keeps that alert; upgrade-guide from 15.5.28 to 16.4.3 explains the changes.';

describe('a same-line fix whose own tree is still vulnerable', () => {
  it('check-package keeps 15.5.28 as the recommendation and adds what staying on 15.x keeps', async () => {
    const v = await checkPackage('npm', 'nextfix', '15.5.27');
    expect(v.report.safeVersionSameLine).toBe('15.5.28');
    expect(v.report.safeVersion).toBe('16.4.3');
    expect(v.report.sameLineTree).toMatchObject({ version: '15.5.28', line: '15.x', cleaner: '16.4.3', pulls: [{ name: 'postcssx', version: '8.4.31' }] });
    const notice = securityNotice(v.report, v.typo, v.risk);
    expect(notice).toMatch(/Recommended within 15\.x: 15\.5\.28/);
    expect(notice).toContain(`NOTE: ${NOTE}`);
  });

  it('a pin to the clean same-line version itself gets the same note', async () => {
    const v = await checkPackage('npm', 'nextfix', '15.5.28');
    expect(v.report.verdict).toBe('ok');
    expect(securityNotice(v.report, v.typo, v.risk).split('\n')).toContain(`NOTE: ${NOTE}`);
  });

  it('nothing is said when the newer line pulls a vulnerable tree too, or when the same line already pulls a clean one', async () => {
    graphs['16.4.3'] = [['postcssx', '8.4.31']];
    expect((await checkPackage('npm', 'nextfix', '15.5.27')).report.sameLineTree).toBeUndefined();
    graphs['16.4.3'] = [['postcssx', '8.5.6']];
    graphs['15.5.28'] = [['postcssx', '8.5.6']];
    expect((await checkPackage('npm', 'nextfix', '15.5.27')).report.sameLineTree).toBeUndefined();
  });

  it('no graph lookups when the same-line fix is already the newest safe version', async () => {
    vulns['nextfix@16.4.3'] = [];
    await checkPackage('npm', 'nextfix', '16.4.3');
    expect(graphCalls).toEqual([]);
  });

  it('check-packages notes it in the row and shows the details', async () => {
    const rows = await checkPackages([{ name: 'nextfix', version: '15.5.28' }], 'npm');
    const table = formatBatch(rows);
    expect(table).toMatch(/\| npm nextfix \| 15\.5\.28 \| ok \| 15\.5\.28 \| .*its tree still pulls postcssx@8\.4\.31 \(GHSA-7fh5-64p2-3v2j\); 16\.4\.3 \(16\.x\) pulls fixed versions/);
    expect(table).toContain(`NOTE: ${NOTE}`);
  });

  it('the hook: a vulnerable pin is denied toward 15.5.28 with the note; the clean 15.5.28 pin passes with it', async () => {
    const d = await decide([{ ecosystem: 'npm', name: 'nextfix', spec: '15.5.27', source: 'npm i nextfix@15.5.27' }]);
    expect(d.action).toBe('deny');
    expect(d.problems.join('\n')).toMatch(/Use 15\.x release 15\.5\.28/);
    expect(d.warnings).toContain(NOTE);
    const ok = await decide([{ ecosystem: 'npm', name: 'nextfix', spec: '15.5.28', source: 'npm i nextfix@15.5.28' }]);
    expect(ok.action).toBe('allow');
    expect(ok.warnings).toContain(NOTE);
  });
});
