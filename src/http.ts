/**
 * One HTTP helper for every upstream. Timeouts always; errors carry the
 * status so callers can tell "not found" from "service down".
 */
// Node's built-in fetch (undici bundled in the runtime): no extra dependency.
// Behind a proxy, recent Node 22/24 honour HTTP(S)_PROXY when NODE_USE_ENV_PROXY=1 (see SECURITY.md).
// These helpers are for fixed, trusted hosts; a URL taken from package metadata goes through safeFetch.ts.
import { config } from './config.js';
import { PKG_NAME, PKG_VERSION } from './pkg.js';

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

/** SAFECTX_DEBUG_HTTP=1 logs one line per request to stderr: method, URL and status. Never headers. */
function debug(method: string, url: string, status: number | string): void {
  if (process.env.SAFECTX_DEBUG_HTTP === '1') process.stderr.write(`[safectx:http] ${method} ${url} ${status}\n`);
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

/** One request, body included: the timeout covers the whole body, not just the headers. */
async function requestText(url: string, opts: HttpOptions = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
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
  try {
    const res = await fetch(url, init).catch((err: unknown) => {
      debug(init.method ?? 'GET', url, 'ERR');
      throw err;
    });
    debug(init.method ?? 'GET', url, res.status);
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? config.requestTimeoutMs * 4);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...opts.headers },
      signal: controller.signal,
    });
    debug('GET', url, res.status);
    if (!res.ok) throw new HttpError(res.status, url);
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
  } finally {
    clearTimeout(timer);
  }
}

/** Returns true for a 404, false otherwise; rethrows anything that is not a 404. */
export function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}
