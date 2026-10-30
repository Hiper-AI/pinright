/**
 * One HTTP helper for every upstream. Timeouts always; errors carry the
 * status so callers can tell "not found" from "service down".
 */
// Node's built-in fetch (undici bundled in the runtime): no extra dependency.
// Behind a proxy, recent Node 22/24 honour HTTP(S)_PROXY when NODE_USE_ENV_PROXY=1 (see SECURITY.md).
// These helpers are for fixed, trusted hosts; a URL taken from package metadata goes through safeFetch.ts.
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';
import { PKG_NAME, PKG_VERSION } from './pkg.js';

// ------------------------------------------------- what did not answer ---

/** Hosts that failed during one tool call or command, with why: the answer has to say what it is missing. */
const failures = new AsyncLocalStorage<Map<string, string>>();

function recordFailure(url: string, why: string): void {
  const m = failures.getStore();
  const host = hostOf(url);
  if (m && !m.has(host)) m.set(host, why);
}

/**
 * Runs one tool call or command and returns, besides its value, a note naming the
 * upstreams that failed (network error, timeout, 5xx, 429) while it ran. Many of
 * those failures are absorbed downstream (fewer docs, a risk signal marked unknown),
 * so without this the answer would not say that something is missing.
 */
export async function trackUpstreams<T>(fn: () => Promise<T>): Promise<{ value: T; notice?: string }> {
  const m = new Map<string, string>();
  const value = await failures.run(m, fn);
  if (!m.size) return { value };
  const list = [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([host, why]) => `${host} (${why})`).join(', ');
  return { value, notice: `NOTE: some sources did not answer: ${list}. Whatever came from them is missing from this answer; nothing missing was assumed safe.` };
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly retryAfterSec?: number,
    /** GitHub's x-ratelimit-remaining and x-ratelimit-reset (epoch seconds), when the response had them. */
    public readonly rateLimit?: { remaining?: number; resetSec?: number },
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
  }
}

export interface HttpOptions {
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as is, for non-JSON protocols (git); set the content-type in headers. */
  rawBody?: string;
}

export const USER_AGENT = `${PKG_NAME}/${PKG_VERSION} (+https://github.com/Hiper-AI/${PKG_NAME})`;

/**
 * PINRIGHT_DEBUG_HTTP=1 logs one line per request to stderr: method, URL, status,
 * when it started (ms since the process did) and how long it took. Never headers.
 */
function debug(method: string, url: string, status: number | string, startedAt?: number): void {
  if (process.env.PINRIGHT_DEBUG_HTTP !== '1') return;
  const timing = startedAt === undefined ? '' : ` +${Math.round(startedAt)}ms ${Math.round(performance.now() - startedAt)}ms`;
  process.stderr.write(`[pinright:http] ${method} ${url} ${status}${timing}\n`);
}

/**
 * The upstream did not answer at all: DNS failure, refused connection, reset,
 * TLS error or no answer within the timeout. The message names the host and the
 * cause in words, so a verdict that says "unknown" can say why.
 */
export class NetworkError extends Error {
  constructor(
    public readonly url: string,
    public readonly code: string,
    detail: string,
  ) {
    super(`${hostOf(url)} unreachable (${detail})`);
    this.name = 'NetworkError';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const CAUSES: Record<string, string> = {
  ENOTFOUND: 'DNS lookup failed',
  EAI_AGAIN: 'DNS lookup failed',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ETIMEDOUT: 'connection timed out',
  ENETUNREACH: 'network unreachable',
  EHOSTUNREACH: 'host unreachable',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  UND_ERR_SOCKET: 'connection closed',
};

/** fetch's "fetch failed" / AbortError -> NetworkError; anything else (HttpError, a parse error) unchanged. */
export function toNetworkError(err: unknown, url: string, timeoutMs: number, timedOut: boolean): unknown {
  if (err instanceof HttpError || err instanceof NetworkError) return err;
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } };
  if (timedOut || e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return new NetworkError(url, 'TIMEOUT', `no answer within ${Math.round(timeoutMs / 100) / 10} s`);
  }
  const code = e?.cause?.code ?? e?.code;
  if ((e?.name === 'TypeError' && /fetch failed/i.test(e.message ?? '')) || (code && code in CAUSES)) {
    return new NetworkError(url, code ?? 'NETWORK', code ? (CAUSES[code] ?? code) : (e?.cause?.message ?? 'network error'));
  }
  return err;
}

/** Network and server failures, as opposed to "not found" or a bad request: the source is down, not the package. */
export function isUnavailable(err: unknown): boolean {
  return err instanceof NetworkError || (err instanceof HttpError && (err.status >= 500 || err.status === 429 || err.status === 403));
}

function intHeader(res: { headers: { get(name: string): string | null } }, name: string): number | undefined {
  const n = Number.parseInt(res.headers.get(name) ?? '', 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Largest JSON or text body accepted. The hosts are fixed, but some serve what package
 * publishers wrote (raw files of a repo, jsDelivr listings): no answer may exhaust memory.
 */
const MAX_TEXT_BYTES = 64_000_000;

/**
 * Hosts that just failed at the network level (timeout, DNS, refused). For a
 * short while every later request to them fails at once: a check that needs 40
 * lookups from a dead host should take one timeout, not forty.
 */
const downHosts = new Map<string, { until: number; err: NetworkError }>();
const HOST_DOWN_MS = 30_000;

function hostDown(url: string): NetworkError | undefined {
  const h = downHosts.get(hostOf(url));
  if (!h) return undefined;
  if (h.until > Date.now()) return h.err;
  downHosts.delete(hostOf(url));
  return undefined;
}

function noteFailure(url: string, err: unknown): unknown {
  if (err instanceof NetworkError) {
    downHosts.set(hostOf(url), { until: Date.now() + HOST_DOWN_MS, err });
    recordFailure(url, err.message.replace(/^.* unreachable \((.*)\)$/, '$1'));
  } else if (err instanceof HttpError && (err.status >= 500 || err.status === 429)) {
    // GitHub's 429 has its own, more useful notice (github.ts: until when, and how to raise the limit).
    if (!(err.status === 429 && hostOf(url).startsWith('api.github'))) recordFailure(url, `HTTP ${err.status}`);
  }
  return err;
}

/** Tests: forget which hosts failed. */
export function resetHostHealth(): void {
  downHosts.clear();
}

/**
 * One request, body included: the timeout covers the whole body, not just the headers.
 * A host that just failed to connect is not tried again for a while (hostDown).
 */
async function requestText(url: string, opts: HttpOptions = {}): Promise<string> {
  const down = hostDown(url);
  if (down) {
    debug(opts.method ?? 'GET', url, 'SKIP');
    throw noteFailure(url, down);
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.requestTimeoutMs);
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    signal: controller.signal,
  };
  const t0 = performance.now();
  try {
    const res = await fetch(url, init).catch((err: unknown) => {
      debug(init.method ?? 'GET', url, 'ERR', t0);
      throw err;
    });
    debug(init.method ?? 'GET', url, res.status, t0);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const remaining = intHeader(res, 'x-ratelimit-remaining');
      const resetSec = intHeader(res, 'x-ratelimit-reset');
      throw new HttpError(res.status, url, intHeader(res, 'retry-after'), remaining !== undefined || resetSec !== undefined ? { remaining, resetSec } : undefined);
    }
    const tooLarge = () => new Error(`${url} is larger than ${MAX_TEXT_BYTES} bytes`);
    if (Number.parseInt(res.headers.get('content-length') ?? '', 10) > MAX_TEXT_BYTES) {
      controller.abort();
      throw tooLarge();
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body ?? []) {
      total += chunk.length;
      if (total > MAX_TEXT_BYTES) {
        controller.abort();
        throw tooLarge();
      }
      chunks.push(Buffer.from(chunk));
    }
    return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
  } catch (err) {
    throw noteFailure(url, toNetworkError(err, url, config.requestTimeoutMs, timedOut));
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T>(url: string, opts?: HttpOptions): Promise<T> {
  return JSON.parse(await requestText(url, opts)) as T;
}

export async function getText(url: string, opts?: HttpOptions): Promise<string> {
  return await requestText(url, opts);
}

/**
 * A binary download (package archives) with a size cap enforced while
 * streaming and a timeout that covers the whole body, not just the headers.
 */
export async function getBytes(url: string, opts: { maxBytes: number; timeoutMs?: number; headers?: Record<string, string> }): Promise<Buffer> {
  const down = hostDown(url);
  if (down) throw noteFailure(url, down);
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? config.requestTimeoutMs * 4;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...opts.headers },
      signal: controller.signal,
    }).catch((err: unknown) => {
      debug('GET', url, 'ERR', t0);
      // Only a failure to connect marks the host down; a large body that takes long is not the host's fault.
      throw noteFailure(url, toNetworkError(err, url, timeoutMs, timedOut));
    });
    debug('GET', url, res.status, t0);
    if (!res.ok) throw noteFailure(url, new HttpError(res.status, url));
    const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    const tooLarge = () => new Error(`${url} is larger than ${opts.maxBytes} bytes`);
    if (declared > opts.maxBytes) {
      controller.abort();
      throw tooLarge();
    }
    const chunks: Buffer[] = [];
    let total = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > opts.maxBytes) {
          controller.abort();
          throw tooLarge();
        }
        chunks.push(Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks);
  } catch (err) {
    throw timedOut ? toNetworkError(err, url, timeoutMs, true) : err;
  } finally {
    clearTimeout(timer);
  }
}

/** Returns true for a 404, false otherwise; rethrows anything that is not a 404. */
export function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}
