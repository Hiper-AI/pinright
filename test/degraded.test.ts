/**
 * Degraded upstreams: no network, DNS failure, deps.dev or OSV down, a host that
 * never answers, jsDelivr 5xx. Every path must end in an honest answer: the
 * verdict is "unknown" (never "ok") and says which source failed, the hook follows
 * its onError policy and says so, and nothing waits longer than its deadline.
 * fetch itself is replaced; nothing leaves the machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.PINRIGHT_NO_CACHE = '1';
process.env.PINRIGHT_COOLDOWN_DAYS = '3';

type Route = (url: URL, init?: RequestInit) => Promise<Response> | Response;
let route: Route = () => new Response(null, { status: 404 });

const dnsFailure = (host: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }) });
/** A server that accepts the connection and never answers: only the abort signal ends it. */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  return Promise.resolve().then(() => route(url, init));
});

const { config } = await import('../src/config.js');
const { resetHostHealth, trackUpstreams } = await import('../src/http.js');
const { checkPackage } = await import('../src/verdict.js');
const { securityNotice } = await import('../src/format.js');
const { decide, agentMessage } = await import('../src/hook/policy.js');
const { decideWithin, evaluateHook, hookAnswer } = await import('../src/hook/run.js');
const { hookTimeoutMs } = await import('../src/hook/late.js');
const { resolvePolicy } = await import('../src/teamConfig.js');
const { checkPackages, formatBatch } = await import('../src/batch.js');
const { decideActions } = await import('../src/actions/check.js');
const { resetGitHubState } = await import('../src/github.js');

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

/** deps.dev and OSV for a package "lib" with clean versions 1.0.0 and 1.1.0. */
function healthy(url: URL): Response | undefined {
  if (url.host === 'api.deps.dev') {
    if (url.pathname.endsWith('/packages/quuxfixture')) {
      return json({
        packageKey: { system: 'NPM', name: 'quuxfixture' },
        versions: ['1.0.0', '1.1.0'].map((v, k) => ({ versionKey: { system: 'NPM', name: 'quuxfixture', version: v }, publishedAt: ago(100 - k), isDefault: v === '1.1.0' })),
      });
    }
    const m = url.pathname.match(/\/packages\/quuxfixture\/versions\/([^/:]+)$/);
    if (m) return json({ versionKey: { system: 'NPM', name: 'quuxfixture', version: m[1] }, publishedAt: ago(100), licenses: ['MIT'], advisoryKeys: [] });
    return new Response(null, { status: 404 });
  }
  if (url.host === 'api.osv.dev') return url.pathname.endsWith('querybatch') ? json({ results: [] }) : json({});
  return undefined;
}

const intent = { ecosystem: 'npm' as const, name: 'quuxfixture', spec: '1.1.0', source: 'npm install quuxfixture@1.1.0' };
const policy = (onError: string) => resolvePolicy(undefined, { PINRIGHT_HOOK_ON_ERROR: onError });

beforeEach(() => {
  resetHostHealth();
  resetGitHubState();
});
afterEach(() => {
  (config as { requestTimeoutMs: number }).requestTimeoutMs = 15_000;
});

describe('no network at all (DNS fails for every host)', () => {
  beforeEach(() => {
    route = (url) => {
      throw dnsFailure(url.host);
    };
  });

  it('the verdict is unknown, names the host and the cause, and is never ok', async () => {
    const v = await checkPackage('npm', 'quuxfixture', '1.1.0');
    expect(v.report.verdict).toBe('unknown');
    expect(v.report.reason).toMatch(/deps\.dev did not answer \(api\.deps\.dev unreachable \(DNS lookup failed\)\)/);
    expect(v.report.unavailable).toEqual(['deps.dev']);
    expect(securityNotice(v.report)).toMatch(/no security verdict .* Treat as unverified/);
  });

  it('the hook allows with onError allow, and says the change was not verified', async () => {
    const d = await decide([intent], policy('allow'));
    expect(d.action).toBe('allow');
    expect(d.warnings.join('\n')).toMatch(/quuxfixture.*could not be verified.*DNS lookup failed.*Allowed unverified \(onError: allow\)/);
  });

  it('the hook denies with onError deny, with the reason in the block message (not only in a note)', async () => {
    const d = await decide([intent], policy('deny'));
    expect(d.action).toBe('deny');
    expect(d.problems.join('\n')).toMatch(/could not be verified.*onError policy is "deny"/);
    expect(agentMessage(d)).toMatch(/^pinright blocked this dependency change:\n- quuxfixture.*could not be verified/);
  });

  it('the hook asks with onError ask', async () => {
    expect((await decide([intent], policy('ask'))).action).toBe('ask');
  });

  it('an Action ref is unverified, never "does not exist", and onError decides', async () => {
    const use = { owner: 'actions', repo: 'checkout', ref: 'v4', line: 1, file: 'ci.yml' };
    const d = await decideActions([use], 'deny');
    expect(d.problems.join('\n')).not.toMatch(/no such tag/);
    expect(d.action).toBe('deny');
    expect(d.problems.join('\n')).toMatch(/could not be verified/);
  });
});

describe('one source down', () => {
  it('deps.dev answering 503: unknown, with the status', async () => {
    route = (url) => (url.host === 'api.deps.dev' ? new Response('busy', { status: 503 }) : (healthy(url) ?? new Response(null, { status: 404 })));
    const v = await checkPackage('npm', 'quuxfixture', '1.1.0');
    expect(v.report.verdict).toBe('unknown');
    expect(v.report.reason).toMatch(/HTTP 503/);
  });

  it('OSV unreachable while deps.dev answers: no advisories in deps.dev is still not "ok"', async () => {
    route = (url) => {
      if (url.host === 'api.osv.dev') throw dnsFailure(url.host);
      return healthy(url) ?? new Response(null, { status: 404 });
    };
    const v = await checkPackage('npm', 'quuxfixture', '1.1.0');
    expect(v.report.verdict).toBe('unknown');
    expect(v.report.requested?.verdict).toBe('unknown');
    expect(v.report.reason).toMatch(/osv\.dev did not answer .*DNS lookup failed.*unverified/);
    expect(v.report.unavailable).toContain('osv.dev');
    // What deps.dev did say is kept: the version to use is still there.
    expect(v.report.safeVersion).toBe('1.1.0');
  });

  it('OSV unreachable does not hide what deps.dev knows: a flagged version stays vulnerable', async () => {
    route = (url) => {
      if (url.host === 'api.osv.dev') throw dnsFailure(url.host);
      if (url.host === 'api.deps.dev' && url.pathname.endsWith('/versions/1.0.0')) {
        return json({ versionKey: { system: 'NPM', name: 'quuxfixture', version: '1.0.0' }, publishedAt: ago(100), advisoryKeys: [{ id: 'GHSA-xxxx' }] });
      }
      return healthy(url) ?? new Response(null, { status: 404 });
    };
    const v = await checkPackage('npm', 'quuxfixture', '1.0.0');
    expect(v.report.verdict).toBe('vulnerable');
  });

  it('with everything healthy the same package is ok (the fixtures are not what makes the cases above unknown)', async () => {
    route = (url) => healthy(url) ?? new Response(null, { status: 404 });
    const v = await checkPackage('npm', 'quuxfixture', '1.1.0');
    expect(v.report.verdict).toBe('ok');
    expect(v.report.unavailable).toBeUndefined();
  });
});

describe('a host that accepts connections and never answers', () => {
  beforeEach(() => {
    (config as { requestTimeoutMs: number }).requestTimeoutMs = 150;
    route = (url, init) => (url.host === 'api.deps.dev' ? hang(init) : (healthy(url) ?? new Response(null, { status: 404 })));
  });

  it('times out with the host named, and the next lookups to it fail at once', async () => {
    const t0 = Date.now();
    const v = await checkPackage('npm', 'quuxfixture', '1.1.0');
    expect(v.report.verdict).toBe('unknown');
    expect(v.report.reason).toMatch(/api\.deps\.dev unreachable \(no answer within 0\.2 s\)/);
    const t1 = Date.now();
    const again = await checkPackage('npm', 'quuxfixture', '1.0.0');
    expect(again.report.verdict).toBe('unknown');
    expect(Date.now() - t1).toBeLessThan(100);
    expect(t1 - t0).toBeLessThan(2_000);
  });

  it('the hook decision comes back within its deadline and asks, even with onError allow', async () => {
    // The upstream outlasts the hook deadline (but not the test: an in-flight lookup is shared with later callers).
    (config as { requestTimeoutMs: number }).requestTimeoutMs = 1_500;
    for (const onError of ['allow', 'ask'] as const) {
      resetHostHealth();
      const t0 = Date.now();
      const d = await decideWithin([intent], [], 200, process.cwd(), policy(onError));
      expect(Date.now() - t0).toBeLessThan(1_500);
      expect(d.action).toBe('ask');
      expect(d.problems).toEqual(['pinright could not finish checking quuxfixture in time (0.2 s, PINRIGHT_HOOK_TIMEOUT_MS); a human should approve it, or retry once deps.dev and OSV answer.']);
    }
  });

  it('a slow upstream behind the full hook: Claude and Cursor ask, Codex, Gemini and Windsurf deny with the same reason', async () => {
    (config as { requestTimeoutMs: number }).requestTimeoutMs = 1_500;
    const prev = process.env.PINRIGHT_HOOK_ON_ERROR;
    process.env.PINRIGHT_HOOK_ON_ERROR = 'allow';
    try {
      const t0 = Date.now();
      const { d, msg } = await evaluateHook([{ command: 'npm install quuxfixture@1.1.0' }], process.cwd(), 300);
      expect(Date.now() - t0).toBeLessThan(1_500);
      expect(d.action).toBe('ask');
      expect(msg).toMatch(/needs approval.*could not finish checking quuxfixture in time/s);
      expect(JSON.parse(hookAnswer('claude', d, msg).stdout as string).hookSpecificOutput.permissionDecision).toBe('ask');
      expect(JSON.parse(hookAnswer('cursor', d, msg).stdout as string).permission).toBe('ask');
      expect(JSON.parse(hookAnswer('codex', d, msg).stdout as string).hookSpecificOutput.permissionDecision).toBe('deny');
      expect(JSON.parse(hookAnswer('gemini', d, msg).stdout as string)).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/in time/) });
      expect(hookAnswer('windsurf', d, msg)).toMatchObject({ code: 2, stderr: expect.stringMatching(/in time/) });
    } finally {
      if (prev === undefined) delete process.env.PINRIGHT_HOOK_ON_ERROR;
      else process.env.PINRIGHT_HOOK_ON_ERROR = prev;
    }
  });

  it('PINRIGHT_HOOK_TIMEOUT_MS that is not a positive number falls back to 45 s instead of firing at once', () => {
    expect(hookTimeoutMs({})).toBe(45_000);
    expect(hookTimeoutMs({ PINRIGHT_HOOK_TIMEOUT_MS: 'soon' })).toBe(45_000);
    expect(hookTimeoutMs({ PINRIGHT_HOOK_TIMEOUT_MS: '0' })).toBe(45_000);
    expect(hookTimeoutMs({ PINRIGHT_HOOK_TIMEOUT_MS: '20000' })).toBe(20_000);
  });

  it('check-packages answers by its deadline: pending packages are "not checked", never ok', async () => {
    (config as { requestTimeoutMs: number }).requestTimeoutMs = 1_500;
    const t0 = Date.now();
    const rows = await checkPackages([{ name: 'quuxfixture', version: '1.1.0' }, { name: 'other' }], 'npm', 200);
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(rows.map((r) => r.error)).toEqual(['not checked: the upstreams did not answer within 0.2 s', 'not checked: the upstreams did not answer within 0.2 s']);
    const table = formatBatch(rows);
    expect(table).toMatch(/\| npm quuxfixture \| 1\.1\.0 \| ERROR, not checked \|/);
    expect(table).toMatch(/treat them as unverified/);
  });
});

describe('what failed is said in the answer', () => {
  it('trackUpstreams names each failing host once, with the cause; 404s are not failures', async () => {
    route = (url) => {
      if (url.host === 'cdn.jsdelivr.net') return new Response('bad gateway', { status: 502 });
      if (url.host === 'data.jsdelivr.com') throw dnsFailure(url.host);
      return new Response(null, { status: 404 });
    };
    const { getText } = await import('../src/http.js');
    const { notice } = await trackUpstreams(async () => {
      await Promise.all([
        getText('https://cdn.jsdelivr.net/npm/lib@1.0.0/README.md').catch(() => undefined),
        getText('https://cdn.jsdelivr.net/npm/lib@1.0.0/docs/a.md').catch(() => undefined),
        getText('https://data.jsdelivr.com/v1/packages/npm/lib@1.0.0').catch(() => undefined),
        getText('https://registry.npmjs.org/lib').catch(() => undefined),
      ]);
    });
    expect(notice).toBe(
      'NOTE: some sources did not answer: cdn.jsdelivr.net (HTTP 502), data.jsdelivr.com (DNS lookup failed). ' +
        'Whatever came from them is missing from this answer; nothing missing was assumed safe.',
    );
  });

  it('no note when everything answered', async () => {
    route = (url) => healthy(url) ?? new Response(null, { status: 404 });
    const { notice } = await trackUpstreams(() => checkPackage('npm', 'quuxfixture', '1.1.0'));
    expect(notice).toBeUndefined();
  });
});
