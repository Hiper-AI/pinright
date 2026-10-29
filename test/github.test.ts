/**
 * The GitHub client: token handling (env, opt-in GitHub CLI, never leaked),
 * the rate limit (stop until reset, say so in the answer), and the sources that
 * spare the API budget (jsDelivr listings, git ls-refs). Upstreams are fixtures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SAFECTX_NO_CACHE = '1';

type Opts = { headers?: Record<string, string>; method?: string; rawBody?: string };
let route: (url: string, opts?: Opts) => unknown;
const calls: { url: string; headers?: Record<string, string> }[] = [];

vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  const get = async (url: string, opts?: Opts) => {
    calls.push({ url, headers: opts?.headers });
    const v = route(url, opts);
    if (v instanceof Error) throw v;
    if (v === undefined) throw new actual.HttpError(404, url);
    return v;
  };
  return {
    ...actual,
    getJson: vi.fn(get),
    getText: vi.fn(async (url: string, opts?: Opts) => {
      const v = await get(url, opts);
      return typeof v === 'string' ? v : JSON.stringify(v);
    }),
  };
});

const CLI_TOKEN = `gho_${'c'.repeat(36)}`;
const execFile = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => cb(null, `${CLI_TOKEN}\n`));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile };
});

const { HttpError } = await import('../src/http.js');
const gh = await import('../src/github.js');
const { repoFiles } = await import('../src/docs/sources.js');
const { githubReleases } = await import('../src/upgrade/sources.js');
const actions = await import('../src/actions/github.js');

const ENV_TOKEN = `ghp_${'e'.repeat(36)}`;
const SHA = (c: string) => c.repeat(40);
const now = () => Math.floor(Date.now() / 1000);
const primaryLimit = (url: string) => new HttpError(403, url, undefined, { remaining: 0, resetSec: now() + 600 });

/** An ls-refs answer the way GitHub sends it: pkt-lines, annotated tags peeled. */
function lsRefsBody(refs: [string, string, string?][]): string {
  const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
  return `${refs.map(([sha, ref, peeled]) => pkt(`${sha} ${ref}${peeled ? ` peeled:${peeled}` : ''}\n`)).join('')}0000`;
}

beforeEach(() => {
  calls.length = 0;
  execFile.mockClear();
  gh.resetGitHubState();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.SAFECTX_GH_CLI;
  route = () => undefined;
});

const apiCalls = () => calls.filter((c) => c.url.startsWith('https://api.github.com/'));

describe('rate limit detection', () => {
  const at = 1_800_000_000_000;
  it('reads the primary limit from x-ratelimit-reset', () => {
    const err = new HttpError(403, 'u', undefined, { remaining: 0, resetSec: at / 1000 + 900 });
    expect(gh.limitedUntil(err, at)).toBe(at + 900_000);
  });
  it('honours retry-after (secondary limit), and a bare 429 waits a minute', () => {
    expect(gh.limitedUntil(new HttpError(429, 'u', 120), at)).toBe(at + 120_000);
    expect(gh.limitedUntil(new HttpError(403, 'u', 45), at)).toBe(at + 45_000);
    expect(gh.limitedUntil(new HttpError(429, 'u'), at)).toBe(at + 60_000);
  });
  it('does not take a permission error or a 404 for a limit', () => {
    expect(gh.limitedUntil(new HttpError(403, 'u'), at)).toBeUndefined();
    expect(gh.limitedUntil(new HttpError(403, 'u', undefined, { remaining: 12, resetSec: at / 1000 + 900 }), at)).toBeUndefined();
    expect(gh.limitedUntil(new HttpError(404, 'u'), at)).toBeUndefined();
    expect(gh.limitedUntil(new Error('network'), at)).toBeUndefined();
  });
});

describe('after GitHub says stop', () => {
  it('stops calling until the reset and says what was skipped, when, and how to add a token', async () => {
    route = (url) => (url.startsWith('https://api.github.com/') ? primaryLimit(url) : undefined);
    const { value, notice } = await gh.trackGitHub(async () => {
      const first = await gh.githubJson('/repos/a/b/releases', { what: 'GitHub release notes of a/b' }).catch((e: unknown) => e);
      const second = await gh.githubJson('/repos/c/d/releases', { what: 'GitHub release notes of c/d' }).catch((e: unknown) => e);
      return [first, second];
    });
    expect(value[0]).toBeInstanceOf(gh.GitHubRateLimitError);
    expect(value[1]).toBeInstanceOf(gh.GitHubRateLimitError);
    expect(apiCalls()).toHaveLength(1); // the second never left the process
    expect(notice).toMatch(/GitHub's API rate limit was reached \(anonymous: 60 requests an hour per IP\)/);
    expect(notice).toContain('GitHub release notes of a/b; GitHub release notes of c/d');
    expect(notice).toMatch(/until \d\d:\d\d UTC \(about 10 min\)/);
    expect(notice).toContain('GITHUB_TOKEN');
    expect(notice).toContain('SAFECTX_GH_CLI=1');
  });

  it('handles a 429 with retry-after the same way', async () => {
    route = (url) => (url.startsWith('https://api.github.com/') ? new HttpError(429, url, 90) : undefined);
    const { notice } = await gh.trackGitHub(() => gh.githubJson('/x', { what: 'X' }).catch(() => undefined));
    expect(notice).toMatch(/about 2 min/);
    await gh.githubJson('/y', { what: 'Y' }).catch(() => undefined);
    expect(apiCalls()).toHaveLength(1);
  });

  it('keeps an anonymous stop separate from a token budget', async () => {
    route = (url) => (url.startsWith('https://api.github.com/') ? primaryLimit(url) : undefined);
    await gh.githubJson('/x', { what: 'X' }).catch(() => undefined);
    process.env.GITHUB_TOKEN = ENV_TOKEN;
    route = () => ({ ok: true });
    await expect(gh.githubJson('/x', { what: 'X' })).resolves.toEqual({ ok: true });
  });

  it('a 403 that is not a limit is passed through and blocks nothing', async () => {
    route = (url) => new HttpError(403, url);
    await expect(gh.githubJson('/x', { what: 'X' })).rejects.not.toBeInstanceOf(gh.GitHubRateLimitError);
    const { notice } = await gh.trackGitHub(() => gh.githubJson('/x', { what: 'X' }).catch(() => undefined));
    expect(notice).toBeUndefined();
    expect(apiCalls()).toHaveLength(2);
  });

  it('repo docs come back empty with the notice instead of failing silently', async () => {
    // jsDelivr cannot list the repo (over 50 MB), and the API is out of budget.
    route = (url) => {
      if (url.includes('data.jsdelivr.com') && url.includes('@v1.0.0')) return new HttpError(403, url);
      if (url.startsWith('https://api.github.com/')) return primaryLimit(url);
      return undefined;
    };
    const meta = { ecosystem: 'npm' as const, name: 'big', version: '1.0.0', repo: { owner: 'o', repo: 'big' } };
    const { value, notice } = await gh.trackGitHub(() => repoFiles(meta));
    expect(value.files).toEqual([]);
    expect(notice).toContain('the file list of o/big@v1.0.0');
  });

  it('upgrade release notes stop at the limit and say so', async () => {
    route = (url) => (url.startsWith('https://api.github.com/') ? primaryLimit(url) : undefined);
    const meta = { ecosystem: 'npm' as const, name: 'lib', version: '2.0.0', repo: { owner: 'o', repo: 'lib' } };
    const r = await githubReleases(meta, '1.0.0', '2.0.0');
    expect(r.notes).toEqual([]);
    expect(r.note).toContain('rate limited; set GITHUB_TOKEN or SAFECTX_GH_CLI=1');
  });
});

describe('the token', () => {
  it('is sent to api.github.com from GITHUB_TOKEN, and only there', async () => {
    process.env.GITHUB_TOKEN = ENV_TOKEN;
    route = (url) => (url.includes('data.jsdelivr.com') ? new HttpError(503, url) : { tree: [{ path: 'README.md', type: 'blob', size: 10 }] });
    const meta = { ecosystem: 'npm' as const, name: 'lib', version: '1.0.0', repo: { owner: 'o', repo: 'lib' } };
    await repoFiles(meta);
    const withAuth = calls.filter((c) => c.headers?.authorization);
    expect(withAuth.length).toBeGreaterThan(0);
    expect(withAuth.every((c) => c.url.startsWith('https://api.github.com/'))).toBe(true);
    expect(withAuth[0].headers?.authorization).toBe(`Bearer ${ENV_TOKEN}`);
    expect(calls.filter((c) => !c.url.startsWith('https://api.github.com/')).every((c) => !JSON.stringify(c.headers ?? {}).includes(ENV_TOKEN))).toBe(true);
  });

  it('never appears in errors or notices', async () => {
    process.env.GITHUB_TOKEN = ENV_TOKEN;
    route = (url) => primaryLimit(url);
    const { value, notice } = await gh.trackGitHub(() => gh.githubJson('/x', { what: 'X' }).catch((e: unknown) => e as Error));
    expect(`${(value as Error).message} ${notice}`).not.toContain(ENV_TOKEN);
    expect(notice).toContain('for the configured token');
    expect(notice).not.toContain('SAFECTX_GH_CLI'); // nothing to add when a token is already there
  });

  it('does not ask the GitHub CLI unless SAFECTX_GH_CLI=1', async () => {
    route = () => ({});
    await gh.githubJson('/x', { what: 'X' });
    expect(execFile).not.toHaveBeenCalled();
    expect(calls[0].headers?.authorization).toBeUndefined();
  });

  it('with SAFECTX_GH_CLI=1, reads `gh auth token` once, on first need', async () => {
    process.env.SAFECTX_GH_CLI = '1';
    route = () => ({});
    expect(execFile).not.toHaveBeenCalled();
    await gh.githubJson('/x', { what: 'X' });
    await gh.githubJson('/y', { what: 'Y' });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0][0]).toBe('gh');
    expect(execFile.mock.calls[0][1]).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect(calls.map((c) => c.headers?.authorization)).toEqual([`Bearer ${CLI_TOKEN}`, `Bearer ${CLI_TOKEN}`]);
  });

  it('an env token wins over the CLI, and a CLI failure means anonymous', async () => {
    process.env.SAFECTX_GH_CLI = '1';
    process.env.GH_TOKEN = ENV_TOKEN;
    route = () => ({});
    await gh.githubJson('/x', { what: 'X' });
    expect(execFile).not.toHaveBeenCalled();
    delete process.env.GH_TOKEN;
    execFile.mockImplementationOnce((_c, _a, _o, cb) => cb(new Error('gh: not logged in'), ''));
    await gh.githubJson('/y', { what: 'Y' });
    expect(calls[1].headers?.authorization).toBeUndefined();
  });
});

describe('init', () => {
  it('adds or removes SAFECTX_GH_CLI in the MCP entry, keeps the rest, and never adds a token', () => {
    expect(gh.mcpEntryEnv(undefined, false)).toEqual({ env: undefined, warnings: [] });
    expect(gh.mcpEntryEnv(undefined, true)).toEqual({ env: { SAFECTX_GH_CLI: '1' }, warnings: [] });
    expect(gh.mcpEntryEnv({ SAFECTX_GH_CLI: '1', SAFECTX_COOLDOWN_DAYS: '5' }, false).env).toEqual({ SAFECTX_COOLDOWN_DAYS: '5' });
    const kept = gh.mcpEntryEnv({ GITHUB_TOKEN: 'x' }, true);
    expect(kept.env).toEqual({ GITHUB_TOKEN: 'x', SAFECTX_GH_CLI: '1' });
    expect(kept.warnings[0]).toContain('GITHUB_TOKEN is set in this MCP entry');
  });

  it('explains how auth will work without writing a token', () => {
    expect(gh.githubAuthAdvice({ envToken: false, ghLoggedIn: true, optIn: false })).toContain('safectx init --gh-cli');
    expect(gh.githubAuthAdvice({ envToken: false, ghLoggedIn: true, optIn: true })).toContain('added SAFECTX_GH_CLI=1');
    expect(gh.githubAuthAdvice({ envToken: false, ghLoggedIn: false, optIn: true })).toContain('not installed or not logged in');
    expect(gh.githubAuthAdvice({ envToken: true, ghLoggedIn: false, optIn: false })).toContain('not written to any file');
    expect(gh.githubAuthAdvice({ envToken: false, ghLoggedIn: false, optIn: false })).toContain('do not put it in .mcp.json');
  });
});

describe('fewer API calls', () => {
  it('lists the repo at the release tag through jsDelivr, and reads its files from the jsDelivr CDN', async () => {
    route = (url) =>
      url.startsWith('https://data.jsdelivr.com/v1/packages/gh/o/lib@v1.0.0')
        ? { files: [{ name: '/docs/guide.md', size: 100 }, { name: '/src/index.ts', size: 100 }, { name: '/README.md', size: 50 }] }
        : undefined;
    const meta = { ecosystem: 'npm' as const, name: 'lib', version: '1.0.0', repo: { owner: 'o', repo: 'lib' } };
    const r = await repoFiles(meta);
    expect(r).toMatchObject({ ref: 'v1.0.0', atTag: true });
    expect(r.files.map((f) => f.url)).toEqual(['https://cdn.jsdelivr.net/gh/o/lib@v1.0.0/docs/guide.md', 'https://cdn.jsdelivr.net/gh/o/lib@v1.0.0/README.md']);
    expect(apiCalls()).toHaveLength(0);
  });

  it('asks the API once, at the tag jsDelivr found, when the repo is over its size limit', async () => {
    route = (url) => {
      if (url.includes('data.jsdelivr.com') && url.includes('@v2.0.0')) return new HttpError(403, url);
      if (url === 'https://api.github.com/repos/o/big/git/trees/v2.0.0?recursive=1') return { tree: [{ path: 'docs/a.md', type: 'blob', size: 10 }] };
      return undefined;
    };
    const meta = { ecosystem: 'npm' as const, name: 'big', version: '2.0.0', repo: { owner: 'o', repo: 'big' } };
    const r = await repoFiles(meta);
    expect(r.files.map((f) => f.url)).toEqual(['https://raw.githubusercontent.com/o/big/v2.0.0/docs/a.md']);
    expect(apiCalls().map((c) => c.url)).toEqual(['https://api.github.com/repos/o/big/git/trees/v2.0.0?recursive=1']);
  });

  it('falls back to the default branch through the API when no tag spelling exists', async () => {
    route = (url) => (url === 'https://api.github.com/repos/o/lib/git/trees/HEAD?recursive=1' ? { tree: [{ path: 'README.md', type: 'blob', size: 10 }] } : undefined);
    const meta = { ecosystem: 'pypi' as const, name: 'lib', version: '1.0.0', repo: { owner: 'o', repo: 'lib' } };
    const r = await repoFiles(meta);
    expect(r).toMatchObject({ ref: 'HEAD', atTag: false });
    expect(apiCalls()).toHaveLength(1);
  });

  it('parses an ls-refs answer, peeling annotated tags', () => {
    const body = lsRefsBody([
      [SHA('a'), 'refs/heads/main'],
      [SHA('b'), 'refs/tags/v4'],
      [SHA('c'), 'refs/tags/v4.2.1', SHA('b')],
    ]);
    expect(actions.parseLsRefs(body)).toEqual({ heads: { main: SHA('a') }, tags: { v4: SHA('b'), 'v4.2.1': SHA('b') } });
    expect(actions.parseLsRefs('0000')).toBeUndefined();
  });

  it('resolves Actions refs from one git request, without the REST API', async () => {
    let body: string | undefined;
    route = (url, opts) => {
      if (url === 'https://github.com/actions/checkout.git/git-upload-pack') {
        body = opts?.rawBody;
        return lsRefsBody([
          [SHA('a'), 'refs/heads/main'],
          [SHA('b'), 'refs/tags/v4'],
          [SHA('c'), 'refs/tags/v4.2.1', SHA('b')],
          [SHA('d'), 'refs/tags/v40.0.0', SHA('b')],
        ]);
      }
      return undefined;
    };
    expect(await actions.resolveRef('actions', 'checkout', 'v4')).toBe(SHA('b'));
    expect(await actions.resolveRef('actions', 'checkout', 'main')).toBe(SHA('a'));
    expect(await actions.resolveRef('actions', 'checkout', 'v999')).toBeUndefined();
    expect(await actions.specificTag('actions', 'checkout', 'v4', SHA('b'))).toBe('v4.2.1');
    expect(await actions.tagForSha('actions', 'checkout', SHA('b'))).toMatch(/^v4(0.0.0|.2.1)$/);
    expect(apiCalls()).toHaveLength(0);
    expect(body).toBe(actions.LS_REFS_BODY);
    expect(calls.every((c) => !c.headers?.authorization)).toBe(true);
  });

  it('falls back to the REST API when the git endpoint does not answer, or for a short SHA', async () => {
    route = (url) => {
      if (url.endsWith('git-upload-pack')) return new HttpError(401, url);
      if (url === 'https://api.github.com/repos/o/a/commits/v1') return SHA('e');
      return undefined;
    };
    expect(await actions.resolveRef('o', 'a', 'v1')).toBe(SHA('e'));
    route = (url) => {
      if (url.endsWith('git-upload-pack')) return lsRefsBody([[SHA('a'), 'refs/tags/v1']]);
      if (url === 'https://api.github.com/repos/o/b/commits/abc1234') return SHA('f');
      return undefined;
    };
    expect(await actions.resolveRef('o', 'b', 'abc1234')).toBe(SHA('f'));
  });
});

describe('MCP answers', () => {
  it('end with the rate-limit note when GitHub left something out', async () => {
    route = (url) => {
      if (url.endsWith('/v1/query')) return { vulns: [] };
      if (url.endsWith('git-upload-pack')) return new HttpError(503, url);
      if (url.startsWith('https://api.github.com/')) return primaryLimit(url);
      return undefined;
    };
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { buildMcpServer } = await import('../src/mcp.js');
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildMcpServer().connect(a);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(b);
    const res = await client.callTool({
      name: 'check-manifest',
      arguments: { content: 'jobs:\n  b:\n    steps:\n      - uses: actions/checkout@v4\n', fileName: 'ci.yml' },
    });
    const text = (res.content as { text: string }[]).map((c) => c.text).join('\n');
    expect(text).toContain('unverified');
    expect(text).toMatch(/NOTE: GitHub's API rate limit was reached .* missing: GitHub Actions ref checks/);
  });
});
