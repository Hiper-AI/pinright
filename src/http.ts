/**
 * One HTTP helper for every upstream. Timeouts always; errors carry the
 * status so callers can tell "not found" from "service down".
 */
import { fetch, type RequestInit } from 'undici';
import { config } from './config.js';

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

const USER_AGENT = 'safectx/0.1 (+https://github.com/Hiper-AI/safectx)';

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

/** Returns true for a 404, false otherwise; rethrows anything that is not a 404. */
export function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}
