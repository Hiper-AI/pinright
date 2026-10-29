/**
 * How many popular Context7 ids map to a registry package? This is the number
 * that decides whether the verdict is useful. Run: npm run coverage:ecosystem
 * Hits the real APIs (cached on disk afterwards).
 */
import { LIBRARIES } from '../bench/libraries.js';
import { resolvePackage } from '../src/mapping.js';

let ok = 0;
const misses: string[] = [];
const t0 = Date.now();
for (const id of LIBRARIES) {
  const ref = await resolvePackage(id).catch(() => undefined);
  if (ref) {
    ok += 1;
    console.log(`${id.padEnd(42)} -> ${ref.ecosystem}:${ref.name} (${ref.via})`);
  } else {
    misses.push(id);
    console.log(`${id.padEnd(42)} -> (unresolved)`);
  }
}
console.log(`\n${ok}/${LIBRARIES.length} resolved (${Math.round((100 * ok) / LIBRARIES.length)}%) in ${Math.round((Date.now() - t0) / 1000)} s`);
if (misses.length) console.log('unresolved:', misses.join(', '));
