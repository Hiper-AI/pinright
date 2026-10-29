/**
 * GitHub Actions: parsing `uses:`, OSV range evaluation and the hook/audit
 * decisions, with OSV and the GitHub API replaced by fixtures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SAFECTX_NO_CACHE = '1';

const SHA = (c: string) => c.repeat(40);
const refs = new Map<string, string>(); // "owner/repo@ref" -> commit sha
const tagRefs = new Map<string, { ref: string; object: { sha: string; type: string } }[]>(); // "owner/repo" -> matching refs
const latest = new Map<string, string>();
const osv = new Map<string, unknown[]>();
let osvDown = false;

vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return {
    ...actual,
    getText: vi.fn(async (url: string) => {
      const m = url.match(/repos\/([^/]+)\/([^/]+)\/commits\/(.+)$/);
      const sha = m && refs.get(`${m[1]}/${m[2]}@${decodeURIComponent(m[3])}`);
      if (!sha) throw new actual.HttpError(422, url);
      return sha;
    }),
    getJson: vi.fn(async (url: string, opts?: { body?: { package?: { name: string } } }) => {
      if (url.endsWith('/v1/query')) {
        if (osvDown) throw new actual.HttpError(503, url);
        return { vulns: osv.get(opts?.body?.package?.name ?? '') ?? [] };
      }
      let m = url.match(/repos\/([^/]+)\/([^/]+)\/git\/matching-refs\/tags\/(.+)$/);
      if (m) return (tagRefs.get(`${m[1]}/${m[2]}`) ?? []).filter((r) => r.ref.startsWith(`refs/tags/${decodeURIComponent(m![3])}`));
      m = url.match(/repos\/([^/]+)\/([^/]+)\/releases\/latest$/);
      if (m && latest.has(`${m[1]}/${m[2]}`)) return { tag_name: latest.get(`${m[1]}/${m[2]}`) };
      m = url.match(/repos\/([^/]+)\/([^/]+)\/tags/);
      if (m) return [...refs.entries()].filter(([k]) => k.startsWith(`${m![1]}/${m![2]}@`)).map(([k, sha]) => ({ name: k.split('@')[1], commit: { sha } }));
      throw new actual.HttpError(404, url);
    }),
  };
});

const { parseUses, changedUses, isWorkflowFile } = await import('../src/actions/workflow.js');
const { actionsAuditFails, affects, checkAction, decideActions, auditActions, formatActionsAudit } = await import('../src/actions/check.js');
const { actionUsesFromToolInput } = await import('../src/hook/run.js');

const tjVuln = {
  id: 'GHSA-mrrh-fwg8-r2c3',
  summary: 'tj-actions changed-files through 45.0.7 allows remote attackers to discover secrets',
  aliases: ['CVE-2025-30066'],
  database_specific: { severity: 'HIGH' },
  affected: [{ package: { name: 'tj-actions/changed-files', ecosystem: 'GitHub Actions' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '46.0.1' }] }] }],
};

beforeEach(() => {
  refs.clear();
  tagRefs.clear();
  latest.clear();
  osv.clear();
  osvDown = false;
  delete process.env.SAFECTX_ACTIONS_PIN;
  delete process.env.SAFECTX_ALLOW;
  delete process.env.SAFECTX_HOOK_ON_ERROR;
  // actions/checkout: v4 and v4.2.2 on the same commit.
  refs.set('actions/checkout@v4', SHA('a'));
  refs.set('actions/checkout@v4.2.2', SHA('a'));
  tagRefs.set('actions/checkout', [
    { ref: 'refs/tags/v4', object: { sha: SHA('a'), type: 'commit' } },
    { ref: 'refs/tags/v4.1.0', object: { sha: SHA('9'), type: 'commit' } },
    { ref: 'refs/tags/v4.2.2', object: { sha: SHA('a'), type: 'commit' } },
    { ref: 'refs/tags/v40.0.0', object: { sha: SHA('a'), type: 'commit' } },
  ]);
  // tj-actions/changed-files: v35 -> v35.9.2, fixed in 46.0.1, latest v47.0.0.
  refs.set('tj-actions/changed-files@v35', SHA('b'));
  refs.set('tj-actions/changed-files@v47.0.0', SHA('c'));
  tagRefs.set('tj-actions/changed-files', [
    { ref: 'refs/tags/v35', object: { sha: SHA('b'), type: 'commit' } },
    { ref: 'refs/tags/v35.9.2', object: { sha: SHA('b'), type: 'commit' } },
  ]);
  latest.set('tj-actions/changed-files', 'v47.0.0');
  osv.set('tj-actions/changed-files', [tjVuln]);
});

const wf = `jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - name: changed
        uses: "tj-actions/changed-files@v35" # pinned later
      - uses: ./local
      - uses: docker://alpine:3
      - uses: github/codeql-action/init@${SHA('d')} # v3.25.0
  reuse:
    uses: org/repo/.github/workflows/ci.yml@main
`;

describe('workflow parsing', () => {
  it('reads owner/repo[/path]@ref, skips local and docker actions', () => {
    expect(parseUses(wf).map((u) => `${u.owner}/${u.repo}${u.path ? `/${u.path}` : ''}@${u.ref}${u.comment ? ` #${u.comment}` : ''} L${u.line}`)).toEqual([
      'actions/checkout@v4 L4',
      'tj-actions/changed-files@v35 L6',
      `github/codeql-action/init@${SHA('d')} #v3.25.0 L9`,
      'org/repo/.github/workflows/ci.yml@main L11',
    ]);
    expect(isWorkflowFile('/r/.github/workflows/ci.yaml')).toBe(true);
    expect(isWorkflowFile('/r/actions/setup/action.yml')).toBe(true);
    expect(isWorkflowFile('/r/docker-compose.yml')).toBe(false);
  });

  it('only new or re-pointed uses lines count', () => {
    const before = wf;
    const after = wf.replace('tj-actions/changed-files@v35', 'tj-actions/changed-files@v46').replace('actions/checkout@v4', 'actions/checkout@v4');
    expect(changedUses(after, before).map((u) => u.ref)).toEqual(['v46']);
    expect(changedUses(before, before)).toEqual([]);
    expect(changedUses(before, undefined)).toHaveLength(4);
    const input = { file_path: '/nowhere/.github/workflows/ci.yml', content: 'steps:\n  - uses: actions/setup-node@v4\n' };
    expect(actionUsesFromToolInput(input, '/p').map((u) => u.repo)).toEqual(['setup-node']);
    expect(actionUsesFromToolInput({ file_path: '/nowhere/ci.yml', content: input.content }, '/p')).toEqual([]);
  });
});

describe('advisory ranges', () => {
  it('evaluates ECOSYSTEM ranges locally (OSV does not for this ecosystem)', () => {
    expect(affects(tjVuln, 'tj-actions/changed-files', 'v35.9.2')).toBe(true);
    expect(affects(tjVuln, 'tj-actions/changed-files', '46.0.1')).toBe(false);
    expect(affects(tjVuln, 'other/action', '1.0.0')).toBe(false);
    const lastAffected = { ...tjVuln, affected: [{ ...tjVuln.affected[0], ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '2.0.0' }, { last_affected: '2.3.0' }] }] }] };
    expect(affects(lastAffected, 'tj-actions/changed-files', '2.3.0')).toBe(true);
    expect(affects(lastAffected, 'tj-actions/changed-files', '2.3.1')).toBe(false);
    expect(affects(lastAffected, 'tj-actions/changed-files', '1.9.0')).toBe(false);
  });

  it('bounds an open range by last_known_affected_version_range (GHSA-vqf5-2xx6-9wfm, codeql-action)', () => {
    const codeql = {
      id: 'GHSA-vqf5-2xx6-9wfm',
      affected: [
        { package: { name: 'github/codeql-action', ecosystem: 'GitHub Actions' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '3.26.11' }, { fixed: '3.28.3' }] }] },
        {
          package: { name: 'github/codeql-action', ecosystem: 'GitHub Actions' },
          ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '2.26.11' }] }],
          database_specific: { last_known_affected_version_range: '< 3.0.0' },
        },
      ],
    };
    expect(affects(codeql, 'github/codeql-action', 'v2.28.0')).toBe(true);
    expect(affects(codeql, 'github/codeql-action', 'v3.27.0')).toBe(true);
    expect(affects(codeql, 'github/codeql-action', 'v3.28.3')).toBe(false);
    expect(affects(codeql, 'github/codeql-action', 'v4.39.1')).toBe(false);
    const inclusive = { ...codeql, affected: [{ ...codeql.affected[1], ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }] }], database_specific: { last_known_affected_version_range: '<= 2.4.1' } }] };
    expect(affects(inclusive, 'github/codeql-action', '2.4.1')).toBe(true);
    expect(affects(inclusive, 'github/codeql-action', '2.4.2')).toBe(false);
  });
});

describe('checkAction and the hook', () => {
  const use = (s: string) => parseUses(`- uses: ${s}`, 'ci.yml')[0];

  it('a compromised action is denied with the fixed release pinned to its commit', async () => {
    const r = await checkAction(use('tj-actions/changed-files@v35'));
    expect(r).toMatchObject({ version: 'v35.9.2', fixedIn: '46.0.1', upgradeTo: `tj-actions/changed-files@${SHA('c')} # v47.0.0` });
    const d = await decideActions([use('tj-actions/changed-files@v35')]);
    expect(d.action).toBe('deny');
    expect(d.problems[0]).toContain('GHSA-mrrh-fwg8-r2c3');
    expect(d.problems[0]).toContain(`uses: tj-actions/changed-files@${SHA('c')} # v47.0.0`);
  });

  it('a clean tag warns with the SHA of the most specific tag; enforce denies; a SHA passes', async () => {
    let d = await decideActions([use('actions/checkout@v4')]);
    expect(d.action).toBe('allow');
    expect(d.warnings[0]).toContain(`uses: actions/checkout@${SHA('a')} # v4.2.2`);
    process.env.SAFECTX_ACTIONS_PIN = 'enforce';
    d = await decideActions([use('actions/checkout@v4')]);
    expect(d.action).toBe('deny');
    d = await decideActions([use(`actions/checkout@${SHA('a')} # v4.2.2`)]);
    expect(d).toMatchObject({ action: 'allow', warnings: [], problems: [] });
  });

  it('a SHA whose comment lies is not trusted; an unknown ref is denied', async () => {
    const r = await checkAction(use(`tj-actions/changed-files@${SHA('c')} # v35.9.2`));
    expect(r.version).toBe('v47.0.0'); // the tag list says which release that commit is
    expect(r.advisories).toEqual([]);
    const d = await decideActions([use('actions/checkout@v99')]);
    expect(d.action).toBe('deny');
    expect(d.problems[0]).toMatch(/no such tag, branch or commit/);
  });

  it('never clean without verifying: branch refs with advisories and OSV down are unverified', async () => {
    refs.set('tj-actions/changed-files@main', SHA('e'));
    let r = await checkAction(use('tj-actions/changed-files@main'));
    expect(r.unverified).toMatch(/could not be told/);
    let d = await decideActions([use('tj-actions/changed-files@main')]);
    expect(d.action).toBe('allow');
    expect(d.warnings.join(' ')).toMatch(/could not be verified/);
    osvDown = true;
    process.env.SAFECTX_HOOK_ON_ERROR = 'deny';
    r = await checkAction(use('actions/checkout@v4'));
    expect(r.unverified).toMatch(/osv\.dev did not answer/);
    d = await decideActions([use('actions/checkout@v4')]);
    expect(d.action).toBe('deny');
  });

  it('SAFECTX_ALLOW skips an org', async () => {
    process.env.SAFECTX_ALLOW = 'tj-actions/*';
    expect((await decideActions([use('tj-actions/changed-files@v35')])).action).toBe('allow');
  });
});

describe('audit', () => {
  it('an action whose advisories could not be checked fails the audit (security review F6)', async () => {
    const levels = ['low', 'moderate', 'high', 'critical'];
    refs.set('tj-actions/changed-files@main', SHA('e'));
    let a = await auditActions([{ file: 'ci.yml', uses: parseUses('- uses: tj-actions/changed-files@main', 'ci.yml') }]);
    expect(a).toMatchObject({ vulnerable: 0, unverified: 1, advisoriesUnknown: 1 });
    expect(actionsAuditFails(a, levels.indexOf('high'), levels)).toBe(true);
    osvDown = true;
    a = await auditActions([{ file: 'ci.yml', uses: parseUses('- uses: actions/checkout@v4', 'ci.yml') }]);
    expect(a.advisoriesUnknown).toBe(1);
    expect(actionsAuditFails(a, levels.indexOf('critical'), levels)).toBe(true);
  });

  it('reports every action across files, worst first', async () => {
    const a = await auditActions([{ file: 'ci.yml', uses: parseUses(wf, 'ci.yml').slice(0, 2) }, { file: 'other.yml', uses: parseUses('- uses: actions/checkout@v4', 'other.yml') }]);
    expect(a).toMatchObject({ actions: 2, vulnerable: 1, unpinned: 2, bySeverity: { high: 1 } });
    expect(a.findings[0].name).toBe('tj-actions/changed-files');
    expect(a.findings[1].locations).toEqual(['ci.yml:4', 'other.yml:1']);
    const text = formatActionsAudit(a);
    expect(text).toMatch(/^SECURITY NOTICE: 1 of 2 GitHub Actions/);
    expect(text).toContain(`Pin: uses: actions/checkout@${SHA('a')} # v4.2.2`);
  });
});
