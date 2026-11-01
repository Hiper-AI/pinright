/**
 * CVSS v3.x base score from the vector OSV carries ("CVSS:3.1/AV:N/AC:L/..."),
 * so a tree audit can rank findings like Dependabot does without one more
 * lookup per advisory. v2 and v4 vectors are not scored: the named severity
 * stands for those.
 */
import type { OsvVuln } from './osv.js';

const W = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
} as const;

/** CVSS 3.1's Roundup: the smallest one-decimal number >= x, immune to float noise. */
function roundup(x: number): number {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
}

export function cvss3BaseScore(vector: string): number | undefined {
  if (!/^CVSS:3\.[01]\//.test(vector)) return undefined;
  const m: Record<string, string> = {};
  for (const part of vector.split('/').slice(1)) {
    const [k, v] = part.split(':');
    if (k && v) m[k] = v;
  }
  const scopeChanged = m.S === 'C';
  const av = W.AV[m.AV as keyof typeof W.AV];
  const ac = W.AC[m.AC as keyof typeof W.AC];
  const ui = W.UI[m.UI as keyof typeof W.UI];
  const pr = m.PR === 'N' ? 0.85 : m.PR === 'L' ? (scopeChanged ? 0.68 : 0.62) : m.PR === 'H' ? (scopeChanged ? 0.5 : 0.27) : undefined;
  const c = W.CIA[m.C as keyof typeof W.CIA];
  const i = W.CIA[m.I as keyof typeof W.CIA];
  const a = W.CIA[m.A as keyof typeof W.CIA];
  if ([av, ac, ui, pr, c, i, a].some((x) => x === undefined) || (m.S !== 'U' && m.S !== 'C')) return undefined;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * (pr as number) * ui;
  return roundup(Math.min((scopeChanged ? 1.08 : 1) * (impact + exploitability), 10));
}

/** The highest v3 base score among the vectors of an OSV record. */
export function cvss3Of(vuln: OsvVuln): number | undefined {
  const scores = (vuln.severity ?? [])
    .filter((s) => s.type === 'CVSS_V3')
    .map((s) => cvss3BaseScore(s.score))
    .filter((s): s is number => s !== undefined);
  return scores.length ? Math.max(...scores) : undefined;
}
