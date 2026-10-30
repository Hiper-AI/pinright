/**
 * The disk cache holds verdict inputs: it must not take them from a directory
 * others can write, nor believe an entry that claims to live forever
 * (security review F10).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheDirTrusted, cacheGet, cacheSet } from '../src/cache.js';
import { config } from '../src/config.js';

const mutable = config as { cacheDir: string; cacheDisabled: boolean };
let dir: string;
let saved: { cacheDir: string; cacheDisabled: boolean };

beforeEach(() => {
  saved = { cacheDir: mutable.cacheDir, cacheDisabled: mutable.cacheDisabled };
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinright-cache-'));
  mutable.cacheDir = path.join(dir, 'c');
  mutable.cacheDisabled = false;
});

afterEach(() => {
  Object.assign(mutable, saved);
  fs.rmSync(dir, { recursive: true, force: true });
});

function entryFiles(): string[] {
  const out: string[] = [];
  for (const sub of fs.readdirSync(mutable.cacheDir)) for (const f of fs.readdirSync(path.join(mutable.cacheDir, sub))) out.push(path.join(mutable.cacheDir, sub, f));
  return out;
}

describe('disk cache', () => {
  it('round-trips a value and leaves no temp file', () => {
    cacheSet('k', { a: 1 }, 60_000);
    expect(cacheGet('k')).toEqual({ a: 1 });
    expect(entryFiles().filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('ignores an entry that claims to outlive any TTL pinright sets', () => {
    cacheSet('k', 'clean', 60_000);
    const [file] = entryFiles();
    fs.writeFileSync(file, JSON.stringify({ expiresAt: Date.now() + 50 * 365 * 24 * 3600_000, value: 'poisoned' }));
    expect(cacheGet('k')).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ expiresAt: 'never', value: 'poisoned' }));
    expect(cacheGet('k')).toBeUndefined();
  });

  it('on POSIX, a group- or world-writable cache directory is not used', (ctx) => {
    if (process.platform === 'win32') return ctx.skip();
    const shared = path.join(dir, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o777);
    expect(cacheDirTrusted(shared)).toBe(false);
    const own = path.join(dir, 'own');
    expect(cacheDirTrusted(own)).toBe(true);
    expect(fs.statSync(own).mode & 0o077).toBe(0);
  });
});
