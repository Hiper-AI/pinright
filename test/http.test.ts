/**
 * The HTTP helper on Node's built-in fetch: headers, JSON body, status
 * errors with Retry-After, the request timeout and the streaming size cap.
 * A local server stands in for the upstreams; nothing leaves the machine.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { HttpError, getBytes, getJson, getText, isNotFound } from '../src/http.js';

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
    expect(lastRequest?.headers['user-agent']).toMatch(/^safectx\//);
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
