/**
 * Context7 under Upstash's terms (docs/CONTEXT7.md): off unless the user brings
 * their own key, answers cached for a day in a folder of their own that can be
 * deleted on request, and attributed when they reach the agent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safectx-c7-'));
process.env.SAFECTX_CACHE_DIR = dir;
delete process.env.SAFECTX_NO_CACHE;
process.env.CONTEXT7_API_KEY = 'ctx7sk-test';
delete process.env.SAFECTX_CONTEXT7;

const calls: string[] = [];
vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return {
    ...actual,
    getJson: vi.fn(async (url: string) => {
      calls.push(url);
      return { results: [{ id: '/o/lib', title: 'lib' }] };
    }),
    getText: vi.fn(async (url: string) => {
      calls.push(url);
      return 'docs from context7';
    }),
  };
});

const { context7ModeFrom, config } = await import('../src/config.js');
const { cacheGet, clearContext7Cache, context7CacheDir } = await import('../src/cache.js');
const c7 = await import('../src/context7.js');

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const files = (d: string): string[] =>
  fs.existsSync(d) ? fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : [];

describe('Context7 is opt-in, with your own key', () => {
  it('is off by default and with SAFECTX_CONTEXT7=fallback but no key', () => {
    expect(context7ModeFrom({})).toBe('off');
    expect(context7ModeFrom({ SAFECTX_CONTEXT7: 'fallback' })).toBe('off');
  });
  it('turns on with CONTEXT7_API_KEY, and SAFECTX_CONTEXT7=off still wins', () => {
    expect(context7ModeFrom({ CONTEXT7_API_KEY: 'ctx7sk-x' })).toBe('fallback');
    expect(context7ModeFrom({ CONTEXT7_API_KEY: 'ctx7sk-x', SAFECTX_CONTEXT7: 'off' })).toBe('off');
  });
});

describe('Context7 answers on disk', () => {
  it('are cached for a day in their own folder, and only there', async () => {
    expect(config.ttl.context7).toBe(24 * 3600_000);
    await c7.searchLibraries('lib', 'how');
    await c7.fetchDocs('/o/lib', 'how');
    await c7.fetchDocs('/o/lib', 'how');
    expect(calls).toHaveLength(2); // the second fetchDocs came from the cache
    expect(files(context7CacheDir())).toHaveLength(2);
    const outside = files(dir).length - files(context7CacheDir()).length;
    expect(outside).toBe(0);
  });

  it('can be deleted on their own', async () => {
    clearContext7Cache();
    expect(fs.existsSync(context7CacheDir())).toBe(false);
    const url = new URL('/api/v2/context', config.context7BaseUrl);
    url.searchParams.set('libraryId', '/o/lib');
    url.searchParams.set('query', 'how');
    expect(cacheGet(`c7:docs:${url.search}`)).toBeUndefined();
    await c7.fetchDocs('/o/lib', 'how');
    expect(calls).toHaveLength(3);
  });
});
