/**
 * Small-sample statistics shared by the reports. The benchmarks have 8 to 12 tasks
 * and 1 or 2 repetitions per arm, so every interval here is wide on purpose:
 * a cluster bootstrap that resamples tasks (with all their repetitions), seeded
 * so a report regenerates byte for byte.
 */

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
export const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : 'n/a');
export const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
export const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
export const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
export const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');

/** mulberry32: a tiny seeded PRNG, so intervals do not change between report runs. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 95% percentile interval of `stat` over a cluster bootstrap: each resample draws
 * as many clusters (tasks) as there are, with replacement, and pools their values.
 * `stat` gets the pooled values of one resample. Returns [lo, hi].
 */
export function bootstrap<T>(clusters: T[][], stat: (xs: T[]) => number, iters = 2000, seed = 20261101): [number, number] {
  const ks = clusters.filter((c) => c.length);
  if (!ks.length) return [NaN, NaN];
  const r = rng(seed);
  const out: number[] = [];
  for (let i = 0; i < iters; i++) {
    const pool: T[] = [];
    for (let j = 0; j < ks.length; j++) pool.push(...ks[Math.floor(r() * ks.length)]);
    const v = stat(pool);
    if (Number.isFinite(v)) out.push(v);
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * out.length)], out[Math.min(out.length - 1, Math.floor(0.975 * out.length))]];
}

/**
 * 95% Wilson score interval of a proportion k / n. Unlike the task bootstrap it does
 * not collapse to [1, 1] when every run passes (16 of 16 gives [0.81, 1]), but it
 * treats runs as independent, which repetitions of one task are not.
 */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [NaN, NaN];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

/** "12.3 [8.1, 17.0]" */
export const withCi = (x: number, ci: [number, number], fmt = f1) => `${fmt(x)} [${fmt(ci[0])}, ${fmt(ci[1])}]`;

/** "mean (min-max)" over the repetitions of one task; just the value when they agree. */
export function spread(xs: number[], fmt = f1): string {
  if (!xs.length) return '-';
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return lo === hi ? fmt(mean(xs)) : `${fmt(mean(xs))} (${fmt(lo)}-${fmt(hi)})`;
}
