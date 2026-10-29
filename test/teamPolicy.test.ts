/**
 * The team policy inside the hook: deny and allow lists, licenses, severity
 * threshold, and the file-level knobs that used to be env-only. A broken
 * .safectx.json fails closed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageReport } from '../src/advisories/resolve.js';

const reports = new Map<string, Partial<PackageReport>>();
const versions = new Map<string, string[]>();
const graphs = new Map<string, Record<string, string>>();
const vulnerable = new Map<string, string[]>(); // "name@version" -> OSV ids
const severities = new Map<string, string>(); // OSV id -> severity
const looked: string[] = [];

vi.mock('../src/verdict.js', () => ({
  checkPackage: vi.fn(async (eco: string, name: string, version?: string) => {
    looked.push(name);
    const r = reports.get(`${name}@${version ?? ''}`) ?? reports.get(name) ?? { verdict: 'ok', requested: version ? { version, verdict: 'ok', advisories: [], licenses: ['MIT'] } : undefined };
    return { report: { package: name, ecosystem: eco, checkedAt: '', sources: [], ...r } };
  }),
}));
vi.mock('../src/advisories/osv.js', () => ({
  queryBatch: vi.fn(async (items: { name: string; version: string }[]) => items.map((i) => vulnerable.get(`${i.name}@${i.version}`) ?? [])),
  getVuln: vi.fn(async (id: string) => ({ id, severity: severities.get(id) })),
  severityOf: (v: { severity?: string }) => v.severity,
}));
vi.mock('../src/advisories/depsdev.js', () => ({
  getDependencies: vi.fn(async (_eco: string, name: string, version: string) => {
    const g = graphs.get(`${name}@${version}`);
    if (!g) return undefined;
    const deps = Object.entries(g);
    return {
      nodes: [{ versionKey: { name, version } }, ...deps.map(([n, v]) => ({ versionKey: { name: n, version: v } }))],
      edges: deps.map((_, k) => ({ fromNode: 0, toNode: k + 1 })),
    };
  }),
  getPackage: vi.fn(async (_eco: string, name: string) => {
    const vs = versions.get(name);
    return vs ? { versions: vs.map((v, i) => ({ versionKey: { version: v }, isDefault: i === vs.length - 1, publishedAt: '2026-01-01' })) } : undefined;
  }),
}));

const { decide } = await import('../src/hook/policy.js');
const { resolvePolicy } = await import('../src/teamConfig.js');
const adv = (id: string, severity?: string) => ({ id, aliases: [], url: '', severity });

beforeEach(() => {
  reports.clear();
  versions.clear();
  graphs.clear();
  vulnerable.clear();
  severities.clear();
  looked.length = 0;
});

describe('deny and allow lists', () => {
  it('denies a listed package with the reason, without asking any registry', async () => {
    const p = resolvePolicy({ deny: [{ name: 'request', ecosystem: 'npm', reason: 'unmaintained; use undici' }] }, {}, '/r/.safectx.json');
    const d = await decide([{ ecosystem: 'npm', name: 'request', spec: '2.88.2', source: 'npm i' }], p);
    expect(d.action).toBe('deny');
    expect(d.problems).toEqual(['request (npm): denied by the project policy (.safectx.json): unmaintained; use undici']);
    expect(looked).toEqual([]);
  });

  it('allow list from the file and SAFECTX_ALLOW both skip checks; allow beats deny', async () => {
    const p = resolvePolicy({ allow: ['@acme/*'], deny: ['@acme/*'] }, { SAFECTX_ALLOW: 'internal-lib' });
    const d = await decide(
      [
        { ecosystem: 'npm', name: '@acme/ui', spec: '1.0.0', source: 'x' },
        { ecosystem: 'npm', name: 'internal-lib', spec: '1.0.0', source: 'x' },
      ],
      p,
    );
    expect(d.action).toBe('allow');
    expect(looked).toEqual([]);
  });

  it('unchanged lines of a manifest are not denied, so an old project is not blocked by a new rule', async () => {
    versions.set('request', ['2.88.2']);
    const p = resolvePolicy({ deny: ['request'] }, {});
    const d = await decide([{ ecosystem: 'npm', name: 'request', spec: '2.88.2', source: 'package.json', contextOnly: true }], p);
    expect(d.action).toBe('allow');
  });
});

describe('licenses', () => {
  it('denies a denied license and notes an unknown one', async () => {
    versions.set('copyleft', ['1.0.0']);
    versions.set('mystery', ['1.0.0']);
    reports.set('copyleft@1.0.0', { verdict: 'ok', requested: { version: '1.0.0', verdict: 'ok', advisories: [], licenses: ['AGPL-3.0-only'] } });
    reports.set('mystery@1.0.0', { verdict: 'ok', requested: { version: '1.0.0', verdict: 'ok', advisories: [], licenses: [] } });
    const p = resolvePolicy({ licenses: { deny: ['AGPL-*'] } }, {});
    const d = await decide(
      [
        { ecosystem: 'npm', name: 'copyleft', spec: '1.0.0', source: 'x' },
        { ecosystem: 'npm', name: 'mystery', spec: '1.0.0', source: 'x' },
      ],
      p,
    );
    expect(d.action).toBe('deny');
    expect(d.problems[0]).toMatch(/copyleft@1\.0\.0 \(npm\): license AGPL-3\.0-only is not allowed/);
    expect(d.warnings[0]).toMatch(/mystery@1\.0\.0 \(npm\): license unknown/);
  });
});

describe('severity threshold', () => {
  it('a moderate advisory with a clean version available only notes under threshold "high"; a high one still blocks', async () => {
    versions.set('mod', ['1.0.0', '1.0.1']);
    versions.set('bad', ['1.0.0', '1.0.1']);
    reports.set('mod@1.0.0', { verdict: 'vulnerable', line: '1.x', safeVersionSameLine: '1.0.1', requested: { version: '1.0.0', verdict: 'vulnerable', advisories: [adv('GHSA-m', 'MODERATE')] } });
    reports.set('bad@1.0.0', { verdict: 'vulnerable', line: '1.x', safeVersionSameLine: '1.0.1', requested: { version: '1.0.0', verdict: 'vulnerable', advisories: [adv('GHSA-h', 'HIGH')] } });
    const p = resolvePolicy({ severityThreshold: 'high' }, {});
    const mod = await decide([{ ecosystem: 'npm', name: 'mod', spec: '1.0.0', source: 'x' }], p);
    expect(mod.action).toBe('allow');
    expect(mod.warnings[0]).toMatch(/below the project's severity threshold \(high\); allowed\. Clean version 1\.0\.1/);
    expect((await decide([{ ecosystem: 'npm', name: 'bad', spec: '1.0.0', source: 'x' }], p)).action).toBe('deny');
    // Without a threshold the moderate one blocks, as before.
    expect((await decide([{ ecosystem: 'npm', name: 'mod', spec: '1.0.0', source: 'x' }], resolvePolicy(undefined, {}))).action).toBe('deny');
  });

  it('transitive advisories below the threshold are notes; unrated ones still count', async () => {
    versions.set('app', ['1.0.0', '1.1.0']);
    graphs.set('app@1.0.0', { dep: '2.0.0' });
    graphs.set('app@1.1.0', { dep: '2.0.1' });
    reports.set('app@1.0.0', { verdict: 'ok', line: '1.x', safeVersionSameLine: '1.1.0', requested: { version: '1.0.0', verdict: 'ok', advisories: [] } });
    vulnerable.set('dep@2.0.0', ['GHSA-low']);
    severities.set('GHSA-low', 'LOW');
    const p = resolvePolicy({ severityThreshold: 'moderate' }, {});
    const d = await decide([{ ecosystem: 'npm', name: 'app', spec: '1.0.0', source: 'x' }], p);
    expect(d.action).toBe('allow');
    expect(d.warnings[0]).toMatch(/pulls dep@2\.0\.0, whose advisories \(GHSA-low\) are below/);
    severities.delete('GHSA-low');
    expect((await decide([{ ecosystem: 'npm', name: 'app', spec: '1.0.0', source: 'x' }], p)).action).toBe('deny');
  });
});

describe('file-level knobs', () => {
  it('onError, noFix and cooldown come from the policy object', async () => {
    versions.set('down', ['1.0.0']);
    reports.set('down@1.0.0', { verdict: 'unknown', reason: 'deps.dev timeout' });
    expect((await decide([{ ecosystem: 'npm', name: 'down', spec: '1.0.0', source: 'x' }], resolvePolicy({ onError: 'deny' }, {}))).action).toBe('deny');

    versions.set('stuck', ['1.0.0']);
    reports.set('stuck@1.0.0', { verdict: 'vulnerable', requested: { version: '1.0.0', verdict: 'vulnerable', advisories: [adv('GHSA-s', 'LOW')] } });
    expect((await decide([{ ecosystem: 'npm', name: 'stuck', spec: '1.0.0', source: 'x' }], resolvePolicy({ noFix: 'deny' }, {}))).action).toBe('deny');
    expect((await decide([{ ecosystem: 'npm', name: 'stuck', spec: '1.0.0', source: 'x' }], resolvePolicy(undefined, {}))).action).toBe('allow');

    versions.set('fresh', ['1.0.0', '1.1.0']);
    reports.set('fresh@1.1.0', { verdict: 'ok', safeVersion: '1.0.0', requested: { version: '1.1.0', verdict: 'ok', advisories: [] } });
    expect((await decide([{ ecosystem: 'npm', name: 'fresh', source: 'x' }], resolvePolicy({ cooldown: 'enforce' }, {}))).action).toBe('deny');
  });
});

describe('the hook with a broken .safectx.json', () => {
  it('denies the dependency change with the parse error, and lets other tool calls through', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safectx-hook-'));
    try {
      fs.mkdirSync(path.join(dir, '.git'));
      fs.writeFileSync(path.join(dir, '.safectx.json'), '{ "deny": [ "request" ');
      const run = (input: unknown) =>
        spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'hook', 'claude'], {
          input: JSON.stringify(input),
          encoding: 'utf8',
          env: { ...process.env, SAFECTX_NO_CACHE: '1', DEPSDEV_BASE_URL: 'http://127.0.0.1:9', OSV_BASE_URL: 'http://127.0.0.1:9' },
        });
      const res = run({ tool_name: 'Bash', tool_input: { command: 'npm install left-pad@1.3.0' }, cwd: dir });
      const out = JSON.parse(res.stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/project policy cannot be read.*not valid JSON/s);
      // Fixing the file is not a dependency change, so the hook stays out of the way.
      const fix = run({ tool_name: 'Write', tool_input: { file_path: path.join(dir, '.safectx.json'), content: '{}' }, cwd: dir });
      expect(fix.stdout).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
