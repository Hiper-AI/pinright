/**
 * npm weekly downloads: one request per package hit HTTP 429 at about 40 packages
 * and the signal disappeared. Unscoped names now share bulk requests (up to 128),
 * scoped ones go one by one with little concurrency. fetch is replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SAFECTX_NO_CACHE = '1';

let requests: string[];
let active = 0;
let maxActive = 0;
let answer: (url: URL) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

vi.stubGlobal('fetch', async (input: string | URL) => {
  const url = new URL(String(input));
  requests.push(decodeURIComponent(url.pathname));
  active++;
  maxActive = Math.max(maxActive, active);
  try {
    await new Promise((r) => setTimeout(r, 10));
    return await answer(url);
  } finally {
    active--;
  }
});

const { weeklyDownloads } = await import('../src/risk/sources.js');
const { resetHostHealth } = await import('../src/http.js');

/** The live API's shapes (checked 2026-10-30): keyed by name with null for unknown ones; one name gets the plain shape. */
function npmApi(url: URL): Response {
  const list = decodeURIComponent(url.pathname.replace('/downloads/point/last-week/', ''));
  if (list.startsWith('@')) {
    if (list.includes(',')) return json({ error: 'scoped packages are not currently supported in bulk lookups' }, 400);
    return json({ downloads: 7, package: list });
  }
  const names = list.split(',');
  const one = (n: string) => (n.startsWith('missing') ? null : { downloads: n.length * 1000, package: n, start: '2026-10-23', end: '2026-10-29' });
  if (names.length === 1) return one(names[0]) ? json(one(names[0])) : json({ error: `package ${names[0]} not found` }, 404);
  return json(Object.fromEntries(names.map((n) => [n, one(n)])));
}

beforeEach(() => {
  requests = [];
  maxActive = 0;
  answer = npmApi;
  resetHostHealth();
});

describe('npm weekly downloads', () => {
  it('40 packages asked at once go out as one bulk request', async () => {
    const names = Array.from({ length: 40 }, (_, k) => `pkg-${k}`);
    const counts = await Promise.all(names.map((n) => weeklyDownloads('npm', n)));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toBe(`/downloads/point/last-week/${names.join(',')}`);
    expect(counts).toEqual(names.map((n) => n.length * 1000));
  });

  it('more than 128 names are split, and unknown names come back undefined', async () => {
    const names = [...Array.from({ length: 129 }, (_, k) => `p${k}`), 'missing-one'];
    const counts = await Promise.all(names.map((n) => weeklyDownloads('npm', n)));
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.split(',').length).sort((a, b) => a - b)).toEqual([2, 128]);
    expect(counts.at(-1)).toBeUndefined();
    expect(counts[0]).toBe(2000);
  });

  it('a single name reads the plain shape; a 404 is "no number", not an error', async () => {
    expect(await weeklyDownloads('npm', 'left-pad')).toBe(8000);
    expect(await weeklyDownloads('npm', 'missing-pkg')).toBeUndefined();
    expect(requests).toEqual(['/downloads/point/last-week/left-pad', '/downloads/point/last-week/missing-pkg']);
  });

  it('scoped packages go one by one, at most three at a time, beside the bulk request', async () => {
    const scoped = Array.from({ length: 8 }, (_, k) => `@acme/p${k}`);
    const counts = await Promise.all([...scoped, 'react', 'vue'].map((n) => weeklyDownloads('npm', n)));
    expect(counts).toEqual([...scoped.map(() => 7), 5000, 3000]);
    expect(requests.filter((r) => r.includes('@'))).toHaveLength(8);
    expect(requests.filter((r) => r.includes('@')).every((r) => !r.includes(','))).toBe(true);
    expect(requests).toContain('/downloads/point/last-week/react,vue');
    expect(maxActive).toBeLessThanOrEqual(4); // three scoped plus the bulk one
  });

  it('an HTTP 429 on the bulk request fails each lookup in it, so the caller reports the signal as unknown', async () => {
    answer = () => new Response('slow down', { status: 429 });
    const out = await Promise.allSettled(['a1', 'b2'].map((n) => weeklyDownloads('npm', n)));
    expect(out.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    expect(requests).toHaveLength(1);
  });
});
