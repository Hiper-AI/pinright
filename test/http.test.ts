/**
 * The HTTP helper on Node's built-in fetch: headers, JSON body, status
 * errors with Retry-After, the request timeout and the streaming size cap.
 * A local server stands in for the upstreams; nothing leaves the machine.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { HttpError, NetworkError, getBytes, getJson, getText, isNotFound, isUnavailable, resetHostHealth } from '../src/http.js';

// A timeout marks the host down for this process; every test starts with a healthy one.
afterEach(() => resetHostHealth());

async function withTimeout<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const saved = config.requestTimeoutMs;
  (config as { requestTimeoutMs: number }).requestTimeoutMs = ms;
  try {
    return await run();
  } finally {
    (config as { requestTimeoutMs: number }).requestTimeoutMs = saved;
  }
}

let server: http.Server;
let base = '';
let lastRequest: { method?: string; headers: http.IncomingHttpHeaders; body: string } | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastRequest = { method: req.method, headers: req.headers, body };
      switch (req.url) {
        case '/json':
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null }));
          return;
        case '/text':
          res.end('hello');
          return;
        case '/missing':
          res.statusCode = 404;
          res.end();
          return;
        case '/limited':
          res.statusCode = 429;
          res.setHeader('retry-after', '7');
          res.end();
          return;
        case '/slow':
          setTimeout(() => res.end('late'), 2_000).unref();
          return;
        case '/stalled-body':
          // Headers at once, then the body never finishes.
          res.setHeader('content-type', 'application/json');
          res.write('{"partial":');
          return;
        case '/big-declared':
          res.setHeader('content-length', '5000');
          res.end(Buffer.alloc(5000));
          return;
        case '/big-chunked':
          // No content-length: the cap has to trip while streaming.
          for (let i = 0; i < 10; i++) res.write(Buffer.alloc(1000));
          res.end();
          return;
        case '/slow-body':
          // Headers at once, then the body never finishes.
          res.setHeader('content-type', 'application/json');
          res.write('{"a":');
          return;
        case '/small':
          res.end(Buffer.from('abc'));
          return;
        default:
          res.statusCode = 500;
          res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('http on the built-in fetch', () => {
  it('sends the user agent and posts a JSON body', async () => {
    const out = await getJson<{ ok: boolean; echo: unknown }>(`${base}/json`, { method: 'POST', body: { q: 1 } });
    expect(out).toEqual({ ok: true, echo: { q: 1 } });
    expect(lastRequest?.method).toBe('POST');
    expect(lastRequest?.headers['user-agent']).toMatch(/^pinright\//);
    expect(lastRequest?.headers['content-type']).toBe('application/json');
  });

  it('reads text', async () => {
    expect(await getText(`${base}/text`)).toBe('hello');
  });

  it('turns a 404 into an HttpError that isNotFound recognises', async () => {
    const err = await getJson(`${base}/missing`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(isNotFound(err)).toBe(true);
  });

  it('carries Retry-After on a 429', async () => {
    const err = await getJson(`${base}/limited`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).retryAfterSec).toBe(7);
    expect(isNotFound(err)).toBe(false);
  });

  it('aborts a request that outlives the timeout', async () => {
    const saved = config.requestTimeoutMs;
    (config as { requestTimeoutMs: number }).requestTimeoutMs = 100;
    try {
      const started = Date.now();
      await expect(getText(`${base}/slow`)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      (config as { requestTimeoutMs: number }).requestTimeoutMs = saved;
    }
  });

  it('the timeout covers the body too, not only the headers (security review F11)', async () => {
    const saved = config.requestTimeoutMs;
    (config as { requestTimeoutMs: number }).requestTimeoutMs = 200;
    try {
      const started = Date.now();
      await expect(getJson(`${base}/slow-body`)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      (config as { requestTimeoutMs: number }).requestTimeoutMs = saved;
    }
  });

  it('downloads bytes under the cap', async () => {
    const buf = await getBytes(`${base}/small`, { maxBytes: 10 });
    expect(buf.toString()).toBe('abc');
  });

  it('refuses a body whose declared length is over the cap', async () => {
    await expect(getBytes(`${base}/big-declared`, { maxBytes: 1000 })).rejects.toThrow(/larger than 1000 bytes/);
  });

  it('stops streaming once the body passes the cap', async () => {
    await expect(getBytes(`${base}/big-chunked`, { maxBytes: 2500 })).rejects.toThrow(/larger than 2500 bytes/);
  });

  it('times out a slow download', async () => {
    await expect(getBytes(`${base}/slow`, { maxBytes: 10, timeoutMs: 100 })).rejects.toThrow();
  });
});

describe('when an upstream does not answer', () => {
  it('names the host and the cause of a timeout', async () => {
    const err = await withTimeout(100, () => getText(`${base}/slow`).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toMatch(/^127\.0\.0\.1:\d+ unreachable \(no answer within 0\.1 s\)$/);
    expect(isUnavailable(err)).toBe(true);
  });

  it('times out a body that starts and never finishes, not only the headers', async () => {
    const started = Date.now();
    const err = await withTimeout(150, () => getJson(`${base}/stalled-body`).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(NetworkError);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('fails the next requests to a host that just timed out at once, instead of waiting each time', async () => {
    await withTimeout(100, () => getText(`${base}/slow`).catch(() => undefined));
    const started = Date.now();
    // /text would answer, but the host is marked down for a while: no request goes out.
    const errs = await Promise.all(Array.from({ length: 5 }, () => getText(`${base}/text`).catch((e: unknown) => e)));
    expect(errs.every((e) => e instanceof NetworkError)).toBe(true);
    expect(Date.now() - started).toBeLessThan(100);
    resetHostHealth();
    expect(await getText(`${base}/text`)).toBe('hello');
  });

  it('says "connection refused" for a port nobody listens on', async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const err = await getJson(`http://127.0.0.1:${port}/x`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toBe(`127.0.0.1:${port} unreachable (connection refused)`);
  });

  it('says "DNS lookup failed" for a name that does not resolve', async () => {
    const err = await getJson('http://pinright-does-not-exist.invalid/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toMatch(/pinright-does-not-exist\.invalid unreachable \(DNS lookup failed\)/);
  });

  it('keeps a 5xx an HttpError (the host answered) but counts it as unavailable; a 404 is not', async () => {
    const err = await getJson(`${base}/whatever-500`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(isUnavailable(err)).toBe(true);
    expect(isUnavailable(await getJson(`${base}/missing`).catch((e: unknown) => e))).toBe(false);
    // and the host is not marked down by an answer, even a failing one
    expect(await getText(`${base}/text`)).toBe('hello');
  });
});
