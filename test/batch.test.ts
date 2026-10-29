/**
 * check-packages and the compact tool outputs, offline: the verdict is mocked
 * per package, and the MCP server is driven through an in-memory transport.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PackageReport } from '../src/advisories/resolve.js';
import type { Verdict } from '../src/verdict.js';

process.env.SAFECTX_NO_CACHE = '1';
// An empty project, so the tools do not pick up versions from safectx's own lockfile.
process.env.SAFECTX_PROJECT_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'sctx-empty-'));

const base = (over: Partial<PackageReport>): PackageReport => ({
  package: 'x',
  ecosystem: 'npm',
  verdict: 'ok',
  checkedAt: '2026-10-29T00:00:00.000Z',
  sources: ['deps.dev', 'osv.dev'],
  ...over,
});

const adv = (id: string, severity: string) => ({ id, aliases: [], title: `${id} title`, severity, fixedIn: ['9.0.0'], url: '' });

const VERDICTS: Record<string, Verdict | Error> = {
  'npm:express@': { report: base({ package: 'express', safeVersion: '5.3.0', latestVersion: '5.3.0', safeVersionLicenses: ['MIT'] }) },
  'npm:express@4.21.2': { report: base({ package: 'express', safeVersion: '5.3.0', requested: { version: '4.21.2', verdict: 'ok', advisories: [] } }) },
  'npm:jsonwebtoken@8.5.1': {
    report: base({
      package: 'jsonwebtoken', verdict: 'vulnerable', line: '8.x', crossLineRequired: true, safeVersion: '9.0.3',
      requested: { version: '8.5.1', verdict: 'vulnerable', advisories: [adv('GHSA-a', 'MODERATE'), adv('GHSA-b', 'HIGH')] },
    }),
  },
  'pypi:pyjwt@2.10.1': {
    report: base({
      package: 'pyjwt', ecosystem: 'pypi', verdict: 'vulnerable', line: '2.x', safeVersionSameLine: '2.15.1', safeVersion: '2.15.1',
      requested: { version: '2.10.1', verdict: 'vulnerable', advisories: Array.from({ length: 10 }, (_, i) => adv(`GHSA-${i}`, i ? 'MODERATE' : 'CRITICAL')) },
    }),
  },
  'npm:evil@1.0.0': { report: base({ package: 'evil', verdict: 'malicious', requested: { version: '1.0.0', verdict: 'malicious', advisories: [adv('MAL-1', 'CRITICAL')] } }) },
  'npm:expresss@': { report: base({ package: 'expresss', verdict: 'possible-typosquat' }), typo: { existsInRegistry: false, lookalikeOf: 'express', distance: 1 } },
  'npm:dotenv@': { report: base({ package: 'dotenv', safeVersion: '18.0.9', recentMajor: { line: '18.x', since: '2026-09-17' } }) },
  'npm:flaky@': new Error('HTTP 503 from https://api.deps.dev/x'),
  'npm:quiet@': { report: base({ package: 'quiet', verdict: 'unknown', reason: 'osv.dev did not answer' }) },
};

const seen: string[] = [];
vi.mock('../src/verdict.js', () => ({
  checkPackage: vi.fn(async (eco: string, name: string, version?: string) => {
    const key = `${eco}:${name}@${version ?? ''}`;
    seen.push(key);
    const v = VERDICTS[key];
    if (!v) throw new Error(`no fixture for ${key}`);
    if (v instanceof Error) throw v;
    return structuredClone(v);
  }),
}));

const { checkPackages, formatBatch, versionToUse } = await import('../src/batch.js');

describe('check-packages', () => {
  it('one row per package, details only for the ones that need attention', async () => {
    const res = await checkPackages(
      [
        { name: 'express' },
        { name: 'jsonwebtoken', version: '8.5.1' },
        { name: 'pyjwt', version: '2.10.1', ecosystem: 'python' },
        { name: 'express' },
        { name: 'dotenv' },
      ],
      'npm',
    );
    expect(res).toHaveLength(4); // the duplicate express is checked once
    const out = formatBatch(res);
    expect(out.split('\n')[0]).toBe('4 packages checked, 2 need attention. Pin the "use" version. Verified against deps.dev + osv.dev on 2026-10-29.');
    expect(out).toContain('| npm express | - | ok | 5.3.0 | MIT |');
    expect(out).toContain('| npm jsonwebtoken | 8.5.1 | VULNERABLE (2, HIGH) | 9.0.3 | fix needs a new major: breaking changes |');
    expect(out).toContain('| pypi pyjwt | 2.10.1 | VULNERABLE (10, CRITICAL) | 2.15.1 | fix on the same release line |');
    expect(out).toContain('18.x is a recent major (since 2026-09-17): read get-docs');
    // Full notices, advisories included, for the vulnerable ones only.
    expect(out).toContain('SECURITY NOTICE: jsonwebtoken (npm)@8.5.1 has 2 known advisories.');
    expect(out).toContain('GHSA-b');
    expect(out).toContain('pip install "pyjwt==2.15.1"');
    expect(out).not.toContain('Security check: express');
    expect(out).not.toContain('Verified against deps.dev + osv.dev on 2026-10-29.\n\nSECURITY');
  });

  it('never reports ok for what it could not check, and gives no version for malware or typosquats', async () => {
    const res = await checkPackages([
      { name: 'evil', version: '1.0.0', ecosystem: 'npm' },
      { name: 'expresss', ecosystem: 'npm' },
      { name: 'flaky', ecosystem: 'npm' },
      { name: 'quiet', ecosystem: 'npm' },
      { name: 'thing', ecosystem: 'swift' },
    ]);
    const out = formatBatch(res);
    expect(out).toContain('| npm evil | 1.0.0 | MALWARE | - | do not install |');
    expect(out).toContain('| npm expresss | - | TYPOSQUAT? | - | looks like "express"; confirm the name |');
    expect(out).toContain('| npm flaky | - | ERROR, not checked | - | HTTP 503');
    expect(out).toContain('| npm quiet | - | UNVERIFIED | - | osv.dev did not answer |');
    expect(out).toContain('| ? thing | - | ERROR, not checked | - | unknown ecosystem "swift" |');
    expect(out).toContain('5 need attention');
    expect(out).toContain('ERROR rows were not checked');
    expect(out).not.toMatch(/\| ok \|/);
  });

  it('versionToUse keeps a clean pin and prefers the same-line fix', () => {
    expect(versionToUse(VERDICTS['npm:express@4.21.2'] as Verdict)).toBe('4.21.2');
    expect(versionToUse(VERDICTS['pypi:pyjwt@2.10.1'] as Verdict)).toBe('2.15.1');
    expect(versionToUse(VERDICTS['npm:jsonwebtoken@8.5.1'] as Verdict)).toBe('9.0.3');
    expect(versionToUse(VERDICTS['npm:evil@1.0.0'] as Verdict)).toBeUndefined();
  });
});

describe('MCP tools, compact by default', () => {
  async function connect() {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { buildMcpServer } = await import('../src/mcp.js');
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildMcpServer().connect(a);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      return (res.content as { text: string }[]).map((c) => c.text).join('\n');
    };
    return { client, call };
  }

  it('lists check-packages and steers agents to one batch call', async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toContain('check-packages');
    expect(client.getInstructions()).toContain('check-packages ONCE');
  });

  it('check-package answers in text, with the full JSON only on detail: true', async () => {
    const { call } = await connect();
    const ok = await call('check-package', { name: 'express', ecosystem: 'npm' });
    expect(ok).toBe('Security check: express (npm) has no known advisories | Recommended version: 5.3.0 (latest) | License: MIT | Verified against deps.dev + osv.dev on 2026-10-29');
    const many = await call('check-package', { name: 'pyjwt', ecosystem: 'pypi', version: '2.10.1' });
    expect(many).toContain('... and 2 more');
    expect(many).toContain('detail: true');
    const full = JSON.parse(await call('check-package', { name: 'pyjwt', ecosystem: 'pypi', version: '2.10.1', detail: true }));
    expect(full.requested.advisories).toHaveLength(10);
    expect(full.notice).toContain('SECURITY NOTICE');
  });

  it('check-packages rejects more than the cap', async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: 'check-packages', arguments: { ecosystem: 'npm', packages: Array.from({ length: 51 }, (_, i) => ({ name: `p${i}` })) } });
    expect(res.isError).toBe(true);
  });
});
