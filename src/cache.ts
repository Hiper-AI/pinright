/**
 * Tiny on-disk cache: one JSON file per key, with a TTL.
 * Context7's free tier is 1,000 calls/month, so caching is not optional.
 * Everything fails soft: a cache problem never breaks a lookup.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

interface Entry<T> {
  expiresAt: number;
  value: T;
}

/**
 * Keys with this prefix hold Context7 output. They live in their own folder so
 * that content can be deleted on its own: Upstash may ask for cached Outputs
 * to be deleted (docs/CONTEXT7.md).
 */
export const CONTEXT7_KEY_PREFIX = 'c7:';

export function context7CacheDir(): string {
  return path.join(config.cacheDir, 'context7');
}

function fileFor(key: string): string {
  const hash = createHash('sha1').update(key).digest('hex');
  const dir = key.startsWith(CONTEXT7_KEY_PREFIX) ? context7CacheDir() : config.cacheDir;
  return path.join(dir, hash.slice(0, 2), `${hash}.json`);
}

/** Deletes every cached Context7 answer. */
export function clearContext7Cache(): void {
  fs.rmSync(context7CacheDir(), { recursive: true, force: true });
}

export function cacheGet<T>(key: string): T | undefined {
  if (config.cacheDisabled) return undefined;
  try {
    const raw = fs.readFileSync(fileFor(key), 'utf8');
    const entry = JSON.parse(raw) as Entry<T>;
    if (entry.expiresAt < Date.now()) return undefined;
    return entry.value;
  } catch {
    return undefined;
  }
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  if (config.cacheDisabled) return;
  try {
    const file = fileFor(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry: Entry<T> = { expiresAt: Date.now() + ttlMs, value };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, file);
  } catch {
    // Read-only disk or a race with another process: skip caching.
  }
}

/** Loads in flight, so parallel callers of one key share a single upstream request. */
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const p = load().then((value) => {
    cacheSet(key, value, ttlMs);
    return value;
  });
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}
