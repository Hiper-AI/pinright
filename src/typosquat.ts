/**
 * Typosquat and slopsquat check. Two signals:
 *   1. the package does not exist in the official registry at all
 *      (an agent hallucinated it, or it is a name an attacker could register);
 *   2. the name is one edit away from a popular package.
 * Registry existence is checked for npm and PyPI only; the other ecosystems
 * rely on deps.dev having seen the package.
 */
import { cached } from './cache.js';
import { config } from './config.js';
import { POPULAR } from './data/popular.js';
import { type Ecosystem } from './ecosystems.js';
import { getJson, isNotFound } from './http.js';

export interface TyposquatReport {
  existsInRegistry?: boolean;
  lookalikeOf?: string;
  distance?: number;
}

/** Damerau-Levenshtein (optimal string alignment), enough for typos and swaps. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

function canon(name: string): string {
  return name.toLowerCase().replace(/[-_.]/g, '');
}

export function findLookalike(eco: Ecosystem, name: string): { of: string; distance: number } | undefined {
  const list = POPULAR[eco] ?? [];
  const target = canon(name);
  if (list.some((p) => canon(p) === target)) return undefined; // it IS the popular one
  const maxDist = target.length <= 4 ? 1 : 2;
  let best: { of: string; distance: number } | undefined;
  for (const p of list) {
    const pc = canon(p);
    if (Math.abs(pc.length - target.length) > maxDist) continue;
    const dist = editDistance(target, pc);
    if (dist <= maxDist && (!best || dist < best.distance)) best = { of: p, distance: dist };
  }
  return best;
}

export async function existsInRegistry(eco: Ecosystem, name: string): Promise<boolean | undefined> {
  let url: string | undefined;
  if (eco === 'npm') url = `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`;
  else if (eco === 'pypi') url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
  else if (eco === 'cargo') url = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`;
  else if (eco === 'rubygems') url = `https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`;
  if (!url) return undefined;
  const key = `reg:${eco}:${name}`;
  try {
    return await cached(key, config.ttl.registry, async () => {
      try {
        await getJson(url, { headers: { accept: 'application/json' } });
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    });
  } catch {
    return undefined;
  }
}

export async function checkTyposquat(eco: Ecosystem, name: string): Promise<TyposquatReport> {
  const exists = await existsInRegistry(eco, name);
  const look = findLookalike(eco, name);
  return {
    existsInRegistry: exists,
    lookalikeOf: look?.of,
    distance: look?.distance,
  };
}
