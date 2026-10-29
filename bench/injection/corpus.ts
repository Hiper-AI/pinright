/**
 * Detection rate on the adversarial corpus and false positives on its hard
 * negatives (test/fixtures/injection/cases.ts). Offline.
 *
 * Run: npx tsx bench/injection/corpus.ts
 */
import { ADVERSARIAL, BENIGN } from '../../test/fixtures/injection/cases.js';
import { cleanField, prepare, scanText } from '../../src/untrusted/index.js';

const RANK = { none: 0, medium: 1, high: 2 } as const;

/** What the pipeline does to a passage: normalize (hidden text judged on its own), then scan. */
export function verdict(text: string, surface?: string) {
  if (surface === 'deprecation' || surface === 'description') {
    const f = cleanField(text, 300);
    return { level: f.text?.startsWith('[withheld') ? 'high' : f.flags.length ? 'medium' : 'none', reasons: f.flags } as const;
  }
  const p = prepare(text, surface === 'dts' || surface === 'docstring' ? 'code' : 'markdown');
  const s = scanText(p.text, { hidden: p.hidden });
  return { level: s.level, reasons: s.reasons };
}

export function corpusNumbers() {
  const adv = ADVERSARIAL.map((c) => ({ c, v: verdict(c.text, c.surface) }));
  const ben = BENIGN.map((c) => ({ c, v: verdict(c.text) }));
  return {
    total: adv.length,
    detected: adv.filter((x) => x.v.level !== 'none').length,
    meetsExpected: adv.filter((x) => RANK[x.v.level] >= RANK[x.c.expect]).length,
    high: adv.filter((x) => x.v.level === 'high').length,
    misses: adv.filter((x) => RANK[x.v.level] < RANK[x.c.expect]).map((x) => `${x.c.id}: ${x.v.level} (want ${x.c.expect}) ${x.v.reasons.join(',')}`),
    benign: ben.length,
    benignFlagged: ben.filter((x) => x.v.level !== 'none').map((x) => `${x.c.id}: ${x.v.level} ${x.v.reasons.join(',')}`),
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('bench/injection/corpus.ts')) {
  const n = corpusNumbers();
  console.log(`adversarial: ${n.detected}/${n.total} flagged, ${n.meetsExpected}/${n.total} at the expected level, ${n.high} high`);
  for (const m of n.misses) console.log(`  miss ${m}`);
  console.log(`hard negatives: ${n.benignFlagged.length}/${n.benign} flagged`);
  for (const b of n.benignFlagged) console.log(`  fp ${b}`);
}
