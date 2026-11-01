/**
 * Tiny on-disk cache: one JSON file per key, with a TTL.
 * Registries and advisory databases are slow and rate-limited; most answers repeat.
 * Everything fails soft: a cache problem never breaks a lookup.
 *
 * The cache holds verdict inputs (advisory lists, versions, the GitHub rate-limit stop), so
 * whoever can write to it can make a vulnerable package look clean. On POSIX the directory
 * must be the user's own and not writable by group or others (a shared PINRIGHT_CACHE_DIR or
 * XDG_CACHE_HOME under /tmp would be); otherwise caching is off. Entries cannot claim a TTL
 * longer than any pinright sets, and files are created without following links.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

interface Entry<T> {
  expiresAt: number;
  value: T;
}

/** Longer than the longest TTL pinright uses (a year for tagged repo listings). */
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
  if (!ok && process.env.PINRIGHT_DEBUG_HTTP === '1') process.stderr.write(`[pinright] cache disabled: ${dir} is not a private directory of this user
`);
  vetted.set(dir, ok);
  return ok;
}

/**
 * Parsed entries this process already read, keyed by file and checked against its
 * mtime and size, so another process's write is seen. A package's version list from
 * deps.dev can be megabytes and one check reads it four or five times. Only the
 * registry and advisory data (read-only by every caller) is kept, and not much of it.
 */
const memo = new Map<string, { mtimeMs: number; size: number; entry: Entry<unknown> }>();
const MEMO_MAX = 500;
const memoizable = (key: string) => key.startsWith('dd:') || key.startsWith('osv:');

function remember(file: string, st: fs.Stats, entry: Entry<unknown>): void {
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
  memo.set(file, { mtimeMs: st.mtimeMs, size: st.size, entry });
}

/** An entry that is not expired and whose expiry is believable (MAX_TTL_MS at most from now). */
function live(entry: Entry<unknown> | undefined, now: number): boolean {
  return typeof entry?.expiresAt === 'number' && entry.expiresAt >= now && entry.expiresAt <= now + MAX_TTL_MS;
}

export function cacheGet<T>(key: string): T | undefined {
  if (config.cacheDisabled || !cacheDirTrusted()) return undefined;
  const file = fileFor(key);
  try {
    const st = fs.statSync(file);
    const known = memo.get(file);
    let entry: Entry<T>;
    if (known && known.mtimeMs === st.mtimeMs && known.size === st.size) entry = known.entry as Entry<T>;
    else {
      entry = JSON.parse(fs.readFileSync(file, 'utf8')) as Entry<T>;
      if (memoizable(key) && live(entry, Date.now())) remember(file, st, entry);
    }
    if (!live(entry, Date.now())) {
      memo.delete(file);
      fs.rmSync(file, { force: true }); // expired or implausible: nobody will read it again
      return undefined;
    }
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

// ------------------------------------------------------------ housekeeping ---

export interface CacheStats {
  dir: string;
  files: number;
  bytes: number;
}

interface FileEntry {
  file: string;
  size: number;
  mtimeMs: number;
}

/**
 * Only names cacheSet writes: `ab/<sha-256>.json` and its temp files. PINRIGHT_CACHE_DIR set to
 * a folder that holds other things (`.`, ~/.cache) must not lose a file to a prune or a clear.
 */
const SHARD = /^[0-9a-f]{2}$/;
const ENTRY = /^[0-9a-f]{64}\.json(\.\d+\.[0-9a-f]{12}\.tmp)?$/;

/** The shard folders of the cache: real directories with a shard name, never a link to elsewhere. */
function shardDirs(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => SHARD.test(n)).map((n) => path.join(dir, n)).filter((sub) => {
    try {
      return fs.lstatSync(sub).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Every entry file with its size and age; temp files of a crashed write count too. */
function entries(dir: string): FileEntry[] {
  const out: FileEntry[] = [];
  for (const sub of shardDirs(dir)) {
    let names: string[];
    try {
      names = fs.readdirSync(sub).filter((n) => ENTRY.test(n));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        // lstat: a link planted in the cache is neither followed nor counted.
        const st = fs.lstatSync(path.join(sub, name));
        if (st.isFile()) out.push({ file: path.join(sub, name), size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // removed meanwhile by another process
      }
    }
  }
  return out;
}

/** `pinright cache clear`: every entry and the prune marker; anything else in the folder stays. */
export function clearCache(dir = config.cacheDir): number {
  let removed = 0;
  for (const e of entries(dir)) {
    try {
      fs.rmSync(e.file, { force: true });
      removed++;
    } catch {
      // in use on Windows: next time
    }
  }
  for (const sub of shardDirs(dir)) {
    try {
      fs.rmdirSync(sub); // only when empty
    } catch {
      // something else lives there
    }
  }
  fs.rmSync(path.join(dir, PRUNE_MARKER), { force: true });
  return removed;
}

export function cacheStats(dir = config.cacheDir): CacheStats {
  const list = entries(dir);
  return { dir, files: list.length, bytes: list.reduce((n, e) => n + e.size, 0) };
}

const PRUNE_MARKER = '.last-prune';
const PRUNE_EVERY_MS = 24 * 3600_000;

/**
 * Removes expired entries and leftover temp files, then the least recently
 * written ones until the cache fits `maxBytes`. Returns what was removed.
 */
export function pruneCache(
  maxBytes = config.cacheMaxBytes,
  now = Date.now(),
  dir = config.cacheDir,
): { removed: number; freedBytes: number; remaining: CacheStats } {
  // Same rule as reading: a directory other users can write to is left alone.
  if (!cacheDirTrusted(dir)) return { removed: 0, freedBytes: 0, remaining: cacheStats(dir) };
  let removed = 0;
  let freedBytes = 0;
  const drop = (e: FileEntry) => {
    try {
      fs.rmSync(e.file, { force: true });
      removed++;
      freedBytes += e.size;
    } catch {
      // in use on Windows, or already gone: next time
    }
  };
  const keep: FileEntry[] = [];
  for (const e of entries(dir)) {
    if (e.file.endsWith('.tmp')) {
      if (now - e.mtimeMs > 3600_000) drop(e);
      continue;
    }
    let expired: boolean;
    try {
      expired = !live(JSON.parse(fs.readFileSync(e.file, 'utf8')) as Entry<unknown>, now);
    } catch {
      expired = true; // unreadable: worthless as a cache entry
    }
    if (expired) drop(e);
    else keep.push(e);
  }
  let total = keep.reduce((n, e) => n + e.size, 0);
  for (const e of keep.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) break;
    drop(e);
    total -= e.size;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PRUNE_MARKER), String(now), { mode: 0o600 });
  } catch {
    // read-only cache dir: nothing was written there either
  }
  return { removed, freedBytes, remaining: cacheStats(dir) };
}

/** Prunes when the last prune was more than a day ago. The MCP server and batch commands call it, never the hook. */
export function pruneCacheIfDue(now = Date.now()): void {
  if (config.cacheDisabled) return;
  try {
    const last = Number(fs.readFileSync(path.join(config.cacheDir, PRUNE_MARKER), 'utf8'));
    if (Number.isFinite(last) && now - last < PRUNE_EVERY_MS) return;
  } catch {
    // never pruned
  }
  pruneCache(config.cacheMaxBytes, now);
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
