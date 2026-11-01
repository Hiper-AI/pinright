/**
 * PINRIGHT_ABLATION=docs-only (benchmark only): the server keeps find-library and get-docs,
 * drops the verdict tools, and get-docs carries no security notice or recommended version.
 * Upstreams are fixtures keyed by URL, as in injection.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.PINRIGHT_NO_CACHE = '1';
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

const fixtures = new Map<string, unknown>();
function lookup(url: string): unknown {
  const key = [...fixtures.keys()].filter((k) => url.includes(k)).sort((a, b) => b.length - a.length)[0];
  return key === undefined ? undefined : fixtures.get(key);
}

vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  const get = (url: string) => {
    const v = lookup(url);
    if (v === undefined) throw new actual.HttpError(404, url);
    return v;
  };
  return {
    ...actual,
    getJson: vi.fn(async (url: string) => get(url)),
    getText: vi.fn(async (url: string) => {
      const v = get(url);
      return typeof v === 'string' ? v : JSON.stringify(v);
    }),
  };
});

const { buildMcpServer } = await import('../src/mcp.js');
const { UNTRUSTED_INSTRUCTIONS } = await import('../src/untrusted/index.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

async function connect() {
  const server = buildMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return { server, client };
}

const README = '# lib\n\n## Usage\n\nCall `createClient()` to get a client.\n';
function seed() {
  // 2.0.0 is the registry default and carries an advisory; 1.0.0 is clean.
  const versions = [
    { versionKey: { system: 'NPM', name: 'lib', version: '1.0.0' }, publishedAt: '2026-01-01T00:00:00Z' },
    { versionKey: { system: 'NPM', name: 'lib', version: '2.0.0' }, publishedAt: '2026-06-01T00:00:00Z', isDefault: true },
  ];
  fixtures.set('/v3/systems/npm/packages/lib', { packageKey: { system: 'NPM', name: 'lib' }, versions });
  fixtures.set('/v3/systems/npm/packages/lib/versions/2.0.0', { ...versions[1], advisoryKeys: [{ id: 'GHSA-xxxx-xxxx-xxxx' }] });
  fixtures.set('/v3/systems/npm/packages/lib/versions/1.0.0', { ...versions[0], advisoryKeys: [] });
  for (const v of ['1.0.0', '2.0.0']) {
    fixtures.set(`registry.npmjs.org/lib/${v}`, { name: 'lib', version: v, description: 'HTTP client' });
    fixtures.set(`data.jsdelivr.com/v1/packages/npm/lib@${v}`, { files: [{ name: '/README.md', size: README.length }] });
    fixtures.set(`cdn.jsdelivr.net/npm/lib@${v}/README.md`, README);
  }
}

afterEach(() => {
  delete process.env.PINRIGHT_ABLATION;
  fixtures.clear();
});

describe('PINRIGHT_ABLATION=docs-only', () => {
  it('registers only find-library and get-docs, with no security wording', async () => {
    process.env.PINRIGHT_ABLATION = 'docs-only';
    const { server, client } = await connect();
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['find-library', 'get-docs']);
    const instructions = (server as unknown as { server: { _instructions?: string } }).server._instructions ?? '';
    // The untrusted-data paragraph is the normal server's, word for word (it names SECURITY NOTICE lines).
    expect(instructions).toContain(UNTRUSTED_INSTRUCTIONS);
    const said = [JSON.stringify(tools), instructions.replace(UNTRUSTED_INSTRUCTIONS, '')].join('\n');
    expect(said).not.toMatch(/SECURITY NOTICE|verdict|advisor|safe version|security/i);
    await client.close();
  });

  it('without the flag the verdict tools and the notice instructions are there', async () => {
    const { server, client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['check-package', 'check-packages', 'check-manifest', 'upgrade-guide', 'find-library', 'get-docs']));
    expect((server as unknown as { server: { _instructions?: string } }).server._instructions).toContain('SECURITY NOTICE');
    await client.close();
  });

  it('get-docs without a version documents the latest version and adds no notice', async () => {
    process.env.PINRIGHT_ABLATION = 'docs-only';
    seed();
    const { client } = await connect();
    const res = (await client.callTool({ name: 'get-docs', arguments: { libraryId: 'npm:lib', query: 'usage' } })) as { content: { text: string }[] };
    const t = res.content.map((c) => c.text).join('\n');
    expect(t).toContain('Docs for lib@2.0.0.');
    expect(t).toContain('createClient()');
    expect(t).toMatch(/<untrusted-data id="[0-9a-f]+" source="[^"]*lib@2\.0\.0/);
    expect(t).not.toMatch(/SECURITY NOTICE|safe|advisor|recommend|GHSA/i);
    await client.close();
  });
});
