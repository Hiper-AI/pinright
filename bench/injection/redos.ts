/**
 * Timing of every detector rule on pathological inputs at growing sizes: a
 * rule whose time grows faster than the input is a ReDoS that a hostile README
 * could use to hang the server.
 *
 * Run: npx tsx bench/injection/redos.ts
 */
import { RULE_PATTERNS, skeleton } from '../../src/untrusted/detect.js';

const SEEDS = ['-', ' * ', '\n', 'ai ', 'AI agents should ', '<p>', '<!--', 'A', '![x](https://a.b/', 'ignore previous ', 'curl ', 'a.', '  ', 'x ', '`', '"', 'note to ai ', 'https://a.b/?q={', '$('];

for (const seed of SEEDS) {
  for (const r of RULE_PATTERNS) {
    const times: number[] = [];
    for (const n of [1000, 2000, 4000]) {
      const s = seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
      const text = r.raw ? s : skeleton(s);
      const re = new RegExp(r.re.source, r.re.flags);
      const t0 = performance.now();
      for (const _m of text.matchAll(re)) void _m;
      times.push(performance.now() - t0);
    }
    if (times[2] > 20 || (times[2] > 5 && times[2] > times[0] * 6)) console.log(`${r.id} on ${JSON.stringify(seed)}: ${times.map((t) => t.toFixed(1)).join(' / ')} ms`);
  }
}
console.log('done');
