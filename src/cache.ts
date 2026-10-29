/**
 * Tiny on-disk cache: one JSON file per key, with a TTL.
 * Registries and advisory databases are slow and rate-limited; most answers repeat.
 * Everything fails soft: a cache problem never breaks a lookup.
 *
 * The cache holds verdict inputs (advisory lists, versions, the GitHub rate-limit stop), so
 * whoever can write to it can make a vulnerable package look clean. On POSIX the directory
 * must be the user's own and not writable by group or others (a shared SAFECTX_CACHE_DIR or
 * XDG_CACHE_HOME under /tmp would be); otherwise caching is off. Entries cannot claim a TTL
 * longer than any safectx sets, and files are created without following links.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

interface Entry<T> {
  expiresAt: number;
  value: T;
}

/** Longer than the longest TTL safectx uses (a year for tagged repo listings). */
const MAX_TTL_MS = 366 * 24 * 3600_000;

function fileFor(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(config.cacheDir, hash.slice(0, 2), `${hash}.json`);
}

const vetted = new Map<string, boolean>();

/** Whether the cache directory is safe to read verdict data from. Checked once per directory. */
export function cacheDirTrusted(dir = config.cacheDir): boolean {
  const hit = vetted.get(dir);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    const uid = process.getuid?.();
    // Windows: per-user %LOCALAPPDATA% with ACLs; mode bits and uid mean nothing there.
    ok = st.isDirectory() && (uid === undefined || (st.uid === uid && (st.mode & 0o022) === 0));
  } catch {
    ok = false;
  }
  if (!ok && process.env.SAFECTX_DEBUG_HTTP === '1') process.stderr.write(`[safectx] cache disabled: ${dir} is not a private directory of this user
`);
  vetted.set(dir, ok);
  return ok;
}

export function cacheGet<T>(key: string): T | undefined {
  if (config.cacheDisabled || !cacheDirTrusted()) return undefined;
  try {
    const raw = fs.readFileSync(fileFor(key), 'utf8');
    const entry = JSON.parse(raw) as Entry<T>;
    const now = Date.now();
    if (typeof entry?.expiresAt !== 'number' || entry.expiresAt < now || entry.expiresAt > now + MAX_TTL_MS) return undefined;
    return entry.value;
  } catch {
    return undefined;
  }
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  if (config.cacheDisabled || !cacheDirTrusted()) return;
  try {
    const file = fileFor(key);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const entry: Entry<T> = { expiresAt: Date.now() + Math.min(ttlMs, MAX_TTL_MS), value };
    // A fresh name opened with O_EXCL: never writes through a planted link.
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
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
