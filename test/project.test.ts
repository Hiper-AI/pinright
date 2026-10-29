/**
 * Project awareness: which version of a package the project uses, read from
 * its dependency files, and how the MCP tools use it. Registry calls are mocked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = new Map<string, string[]>();
vi.mock('../src/advisories/depsdev.js', () => ({
  getPackage: vi.fn(async (_eco: string, name: string) => {
    const vs = registry.get(name);
    return vs ? { versions: vs.map((v) => ({ versionKey: { version: v }, publishedAt: '2026-01-01' })) } : undefined;
  }),
  getVersion: vi.fn(async (_eco: string, _name: string, _v: string) => ({ licenses: ['MIT'] })),
}));

const checks: { name: string; version?: string }[] = [];
vi.mock('../src/verdict.js', () => ({
  checkPackage: vi.fn(async (eco: string, name: string, version?: string) => {
    checks.push({ name, version });
    const vulnerable = name === 'next' && version === '15.1.0';
    return {
      report: {
        package: name, ecosystem: eco, checkedAt: '2026-10-29T00:00:00Z', sources: ['deps.dev', 'osv.dev'],
        verdict: vulnerable ? 'vulnerable' : 'ok', safeVersion: '16.4.3', latestVersion: '16.4.3', safeVersionLicenses: ['MIT'],
        ...(version
          ? {
              line: version.startsWith('15') ? '15.x' : undefined,
              safeVersionSameLine: vulnerable ? '15.5.28' : version,
              requested: { version, verdict: vulnerable ? 'vulnerable' : 'ok', licenses: name === 'gpl-thing' ? ['AGPL-3.0'] : ['MIT'], advisories: vulnerable ? [{ id: 'GHSA-x', aliases: ['CVE-2025-29927'], url: '', severity: 'CRITICAL' }] : [] },
            }
          : {}),
      },
    };
  }),
}));
vi.mock('../src/docs/index.js', () => ({
  getDocs: vi.fn(async (o: { name: string; version: string }) => ({ text: `Docs for ${o.name}@${o.version}` })),
}));
vi.mock('../src/search.js', async (orig) => ({
  ...(await orig<typeof import('../src/search.js')>()),
  searchPackages: vi.fn(async () => [
    { id: 'npm:next', ecosystem: 'npm', name: 'next', latestVersion: '16.4.3' },
    { id: 'npm:other', ecosystem: 'npm', name: 'other', latestVersion: '1.0.0' },
  ]),
}));

const { Project, describeInstalled } = await import('../src/project.js');
const { buildMcpServer } = await import('../src/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { ListRootsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

const tmp: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'safectx-proj-'));
  tmp.push(d);
  fs.mkdirSync(path.join(d, '.git'));
  return d;
}
function write(dir: string, file: string, content: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
}
const lock = (deps: Record<string, string>, extra: Record<string, { version: string }> = {}) => ({
  lockfileVersion: 3,
  packages: {
    '': { dependencies: Object.fromEntries(Object.keys(deps).map((n) => [n, '*'])) },
    ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v }])),
    ...extra,
  },
});

beforeEach(() => {
  registry.clear();
  checks.length = 0;
  delete process.env.SAFECTX_PROJECT_DIR;
});
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('Project.installed', () => {
  it('reads the exact version from a lockfile, preferring the direct dependency over a nested copy', async () => {
    const d = tempDir();
    write(d, 'package-lock.json', lock({ next: '15.1.0', foo: '1.0.0' }, { 'node_modules/foo/node_modules/next': { version: '14.0.0' } }));
    const p = new Project();
    p.setRoots([d]);
    const i = await p.installed('npm', 'next');
    expect(i).toMatchObject({ version: '15.1.0', file: 'package-lock.json', source: 'lockfile', direct: true });
    expect(describeInstalled(i!)).toBe('Using next 15.1.0, installed in this project (package-lock.json).');
    expect(await p.installed('npm', 'absent')).toBeUndefined();
    expect(await p.installed('pypi', 'next')).toBeUndefined();
  });

  it('pinned requirements.txt, with PyPI name normalization', async () => {
    const d = tempDir();
    write(d, 'requirements.txt', 'Django==4.2.1\nrequests==2.31.0\n');
    const p = new Project();
    p.setRoots([d]);
    expect(await p.installed('pypi', 'django')).toMatchObject({ version: '4.2.1', file: 'requirements.txt' });
  });

  it('without a lockfile: node_modules first, then exact pins, then the range resolved against the registry', async () => {
    const d = tempDir();
    write(d, 'package.json', { dependencies: { axios: '^1.7.0', zod: '3.23.8', next: '^15.0.0' } });
    write(d, 'node_modules/axios/package.json', { name: 'axios', version: '1.7.9' });
    registry.set('next', ['15.0.0', '15.5.28', '16.0.0']);
    const p = new Project();
    p.setRoots([d]);
    expect(await p.installed('npm', 'axios')).toMatchObject({ version: '1.7.9', source: 'node_modules' });
    expect(await p.installed('npm', 'zod')).toMatchObject({ version: '3.23.8', source: 'pin' });
    const next = await p.installed('npm', 'next');
    expect(next).toMatchObject({ version: '15.5.28', source: 'range', spec: '^15.0.0' });
    expect(describeInstalled(next!)).toMatch(/what "\^15\.0\.0" in package\.json resolves to today \(no lockfile\)/);
  });

  it('monorepo: finds subprojects, skips node_modules, and reports other versions', async () => {
    const d = tempDir();
    write(d, 'web/package-lock.json', lock({ react: '18.3.1' }));
    write(d, 'apps/api/package-lock.json', lock({ react: '17.0.2' }));
    write(d, 'node_modules/x/package-lock.json', lock({ react: '1.0.0' }));
    const p = new Project();
    p.setRoots([d]);
    const i = await p.installed('npm', 'react');
    expect(i?.version).toBe('18.3.1');
    expect(i?.file).toBe('web/package-lock.json');
    expect(i?.others).toEqual(['17.0.2 (apps/api/package-lock.json)']);
    expect((await p.files()).some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('launched from a subfolder without dependency files: uses the nearest parent that has them', async () => {
    const d = tempDir();
    write(d, 'package-lock.json', lock({ next: '15.1.0' }));
    fs.mkdirSync(path.join(d, 'src', 'app'), { recursive: true });
    const p = new Project();
    p.setRoots([path.join(d, 'src', 'app')]);
    expect((await p.installed('npm', 'next'))?.version).toBe('15.1.0');
  });

  it('re-reads a file when it changes, and falls back to SAFECTX_PROJECT_DIR without roots', async () => {
    const d = tempDir();
    write(d, 'package-lock.json', lock({ next: '15.1.0' }));
    process.env.SAFECTX_PROJECT_DIR = d;
    const p = new Project();
    expect(p.roots()).toEqual([path.resolve(d)]);
    expect((await p.installed('npm', 'next'))?.version).toBe('15.1.0');
    write(d, 'package-lock.json', lock({ next: '15.5.28' }));
    fs.utimesSync(path.join(d, 'package-lock.json'), new Date(), new Date(Date.now() + 5000));
    expect((await p.installed('npm', 'next'))?.version).toBe('15.5.28');
  });
});

describe('MCP tools use the installed version', () => {
  async function connect(roots: string[] | undefined) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer();
    const client = new Client({ name: 't', version: '0' }, { capabilities: roots ? { roots: { listChanged: true } } : {} });
    let current = roots ?? [];
    if (roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: current.map((r) => ({ uri: pathToFileURL(r).href })) }));
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      return (res.content as { text: string }[])[0].text;
    };
    return { client, call, setRoots: async (r: string[]) => { current = r; await client.sendRootsListChanged(); } };
  }

  it('get-docs and check-package without a version use the one in the project (from MCP roots)', async () => {
    const d = tempDir();
    write(d, 'package-lock.json', lock({ next: '15.1.0' }));
    const { client, call } = await connect([d]);
    const docs = await call('get-docs', { libraryId: 'npm:next', query: 'middleware' });
    expect(docs.split('\n')[0]).toBe('Using next 15.1.0, installed in this project (package-lock.json).');
    // The installed version is the "requested" one: the safety logic still moves to the same-line fix.
    expect(docs).toContain('These docs are for 15.5.28, the version to move to, not 15.1.0.');
    expect(docs).toContain('Docs for next@15.5.28');

    const pkg = JSON.parse(await call('check-package', { name: 'next', ecosystem: 'npm', detail: true }));
    expect(pkg.installed).toEqual({ version: '15.1.0', file: 'package-lock.json', source: 'lockfile' });
    expect(pkg.requested.version).toBe('15.1.0');

    // An explicit version still wins.
    const explicit = await call('get-docs', { libraryId: 'npm:next@16.4.3', query: 'x' });
    expect(explicit).not.toContain('installed in this project');
    expect(checks.at(-1)).toEqual({ name: 'next', version: '16.4.3' });
    await client.close();
  });

  it('find-library marks hits that are already dependencies', async () => {
    const d = tempDir();
    write(d, 'package-lock.json', lock({ next: '15.1.0' }));
    const { client, call } = await connect([d]);
    const lines = (await call('find-library', { libraryName: 'next.js', query: 'x' })).split('\n').filter((l) => l.startsWith('npm:'));
    expect(lines[0]).toMatch(/^npm:next \| installed 15\.1\.0 \(package-lock\.json\)/);
    expect(lines[1]).not.toContain('installed');
    await client.close();
  });

  it('follows roots/list_changed', async () => {
    const a = tempDir();
    const b = tempDir();
    write(a, 'package-lock.json', lock({ next: '15.1.0' }));
    write(b, 'package-lock.json', lock({ next: '16.4.3' }));
    const { client, call, setRoots } = await connect([a]);
    expect(await call('get-docs', { libraryId: 'npm:next', query: 'x' })).toMatch(/^Using next 15\.1\.0/);
    await setRoots([b]);
    await new Promise((r) => setTimeout(r, 50));
    expect(await call('get-docs', { libraryId: 'npm:next', query: 'x' })).toMatch(/^Using next 16\.4\.3/);
    await client.close();
  });

  it('shows team policy violations and a broken policy file in check-package', async () => {
    const d = tempDir();
    write(d, 'package-lock.json', lock({ 'gpl-thing': '1.0.0' }));
    write(d, '.safectx.json', '{ "deny": [{ "name": "request", "reason": "unmaintained" }], "licenses": { "deny": ["AGPL-*"] } }');
    const { client, call } = await connect([d]);
    const denied = JSON.parse(await call('check-package', { name: 'request', ecosystem: 'npm', version: '2.88.2', detail: true }));
    expect(denied.policy).toEqual(['POLICY: request: denied by the project policy (.safectx.json): unmaintained']);
    const lic = JSON.parse(await call('check-package', { name: 'gpl-thing', ecosystem: 'npm', detail: true }));
    expect(lic.notice).toMatch(/POLICY: gpl-thing: license AGPL-3\.0 is not allowed/);
    write(d, '.safectx.json', '{ "deny": [ }');
    fs.utimesSync(path.join(d, '.safectx.json'), new Date(), new Date(Date.now() + 5000));
    const broken = JSON.parse(await call('check-package', { name: 'left-pad', ecosystem: 'npm', version: '1.3.0', detail: true }));
    expect(broken.notice).toMatch(/^POLICY ERROR: .*not valid JSON/);
    await client.close();
  });

  it('a client without roots falls back to the working directory', async () => {
    const d = tempDir();
    write(d, 'package-lock.json', lock({ next: '15.1.0' }));
    const cwd = process.cwd();
    process.chdir(d);
    try {
      const { client, call } = await connect(undefined);
      expect(await call('get-docs', { libraryId: 'npm:next', query: 'x' })).toMatch(/^Using next 15\.1\.0/);
      await client.close();
    } finally {
      process.chdir(cwd);
    }
  });
});
