/**
 * One HTTP helper for every upstream. Timeouts always; errors carry the
 * status so callers can tell "not found" from "service down".
 */
// Node's built-in fetch (undici bundled in the runtime): no extra dependency.
// Behind a proxy, recent Node 22/24 honour HTTP(S)_PROXY when NODE_USE_ENV_PROXY=1 (see SECURITY.md).
// These helpers are for fixed, trusted hosts; a URL taken from package metadata goes through safeFetch.ts.
import { config } from './config.js';
import { PKG_VERSION } from './pkg.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly retryAfterSec?: number,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
  }
}

export interface HttpOptions {
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
}

export const USER_AGENT =`safectx/${PKG_VERSION} (+https://github.com/Hiper-AI/safectx)`;

async function request(url: string, opts: HttpOptions = {}) {
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
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: controller.signal,
  };
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      const retry = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
      throw new HttpError(res.status, url, Number.isFinite(retry) ? retry : undefined);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T>(url: string, opts?: HttpOptions): Promise<T> {
  const res = await request(url, opts);
  return (await res.json()) as T;
}

export async function getText(url: string, opts?: HttpOptions): Promise<string> {
  const res = await request(url, opts);
  return await res.text();
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
