/**
 * Composer version constraints (https://getcomposer.org/doc/articles/versions.md):
 * "^1.2", "~1.2.3", ">=1.0 <2.0", "1.0 - 2.0", "1.2.*", "1.2.3", "!=1.5",
 * alternatives with "|" or "||", conjunctions with "," or a space, and
 * stability flags ("@dev", "@stable"), which are ignored here.
 *
 * Versions compare as up to four numeric parts plus a stability suffix
 * (dev < alpha < beta < RC < stable < patch), like Composer's VersionParser.
 */

interface Parsed {
  parts: number[];
  /** 0 dev, 1 alpha, 2 beta, 3 RC, 4 stable, 5 patch/pl. */
  stability: number;
  stabilityNum: number;
}

const STABILITY: Record<string, number> = { dev: 0, alpha: 1, a: 1, beta: 2, b: 2, rc: 3, stable: 4, patch: 5, pl: 5, p: 5 };

function parseVersion(raw: string): Parsed | undefined {
  const m = raw.trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+){0,3})(?:[-_.]?(dev|alpha|a|beta|b|rc|stable|patch|pl|p)[-_.]?(\d*))?$/i);
  if (!m) return undefined;
  const parts = m[1].split('.').map(Number);
  while (parts.length < 4) parts.push(0);
  return { parts, stability: m[2] ? STABILITY[m[2].toLowerCase()] : 4, stabilityNum: m[3] ? Number(m[3]) : 0 };
}

function cmp(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 4; i++) {
    const d = a.parts[i] - b.parts[i];
    if (d) return d;
  }
  return a.stability - b.stability || a.stabilityNum - b.stabilityNum;
}

/** Composer's own ordering of two version strings; undefined when either does not parse. */
export function compareComposer(a: string, b: string): number | undefined {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  return pa && pb ? cmp(pa, pb) : undefined;
}

type Check = (v: Parsed) => boolean;

/** Number of numeric parts written ("1.2" -> 2), and the parsed lower bound. */
function bound(raw: string): { p: Parsed; given: number } | undefined {
  const p = parseVersion(raw);
  if (!p) return undefined;
  const given = raw.replace(/^v/i, '').split(/[-_]/)[0].split('.').filter((x) => /^\d+$/.test(x)).length;
  return { p, given };
}

/** The first version after the prefix of `given` parts: next(1.2.3, 2) = 1.3.0.0-dev. */
function bump(p: Parsed, at: number): Parsed {
  const parts = p.parts.slice(0, 4).map((n, i) => (i < at ? n : i === at ? n + 1 : 0));
  return { parts, stability: 0, stabilityNum: 0 };
}

function single(atom: string): Check | undefined {
  const s = atom.replace(/@\w+$/, '').trim();
  if (!s || s === '*' || s === 'x') return () => true;
  if (/^dev-/i.test(s)) return undefined; // a branch, not a release
  let m = s.match(/^\^\s*(.+)$/);
  if (m) {
    const b = bound(m[1]);
    if (!b) return undefined;
    // ^1.2.3 -> <2.0.0; ^0.3 -> <0.4.0; ^0.0.3 -> <0.0.4: the first non-zero part is the major.
    const nz = b.p.parts.findIndex((n, i) => n !== 0 || i >= b.given - 1);
    const upper = bump(b.p, Math.max(0, Math.min(nz, b.given - 1)));
    return (v) => cmp(v, b.p) >= 0 && cmp(v, upper) < 0;
  }
  m = s.match(/^~\s*(.+)$/);
  if (m) {
    const b = bound(m[1]);
    if (!b) return undefined;
    // ~1.2 -> <2.0; ~1.2.3 -> <1.3; ~1 -> <2.
    const upper = bump(b.p, Math.max(0, b.given - 2));
    return (v) => cmp(v, b.p) >= 0 && cmp(v, upper) < 0;
  }
  m = s.match(/^(\d+(?:\.\d+)*)\.[*x]$/i);
  if (m) {
    const b = bound(m[1]);
    if (!b) return undefined;
    const lower = { ...b.p, stability: 0 };
    const upper = bump(b.p, b.given - 1);
    return (v) => cmp(v, lower) >= 0 && cmp(v, upper) < 0;
  }
  m = s.match(/^(>=|<=|>|<|!=|==|=)?\s*(.+)$/);
  if (!m) return undefined;
  const b = bound(m[2]);
  if (!b) return undefined;
  const op = m[1] ?? '=';
  switch (op) {
    case '>=':
      return (v) => cmp(v, b.p) >= 0;
    case '>':
      return (v) => cmp(v, b.p) > 0;
    case '<=':
      return (v) => cmp(v, b.p) <= 0;
    case '<':
      // "<2.0" excludes 2.0's pre-releases, as Composer does.
      return (v) => cmp(v, { ...b.p, stability: b.p.stability === 4 ? 0 : b.p.stability }) < 0;
    case '!=':
      return (v) => cmp(v, b.p) !== 0;
    default:
      return (v) => cmp(v, b.p) === 0;
  }
}

function conjunction(group: string): Check | undefined {
  const g = group.trim();
  // Hyphen range: "1.0 - 2.0" (a partial upper bound is a prefix: <2.1).
  const hy = g.match(/^(\S+)\s+-\s+(\S+)$/);
  if (hy) {
    const lo = bound(hy[1]);
    const hi = bound(hy[2]);
    if (!lo || !hi) return undefined;
    const upper = hi.given < 3 ? bump(hi.p, hi.given - 1) : undefined;
    return (v) => cmp(v, lo.p) >= 0 && (upper ? cmp(v, upper) < 0 : cmp(v, hi.p) <= 0);
  }
  // Operators may be separated from their version by a space (">= 1.0"): glue them first.
  const atoms = g.replace(/(>=|<=|!=|==|>|<|\^|~)\s+/g, '$1').split(/\s*,\s*|\s+/).filter(Boolean);
  const checks = atoms.map(single);
  if (checks.some((c) => !c)) return undefined;
  return (v) => (checks as Check[]).every((c) => c(v));
}

/** Does `version` satisfy the constraint? Undefined when either cannot be read (dev branches, junk). */
export function satisfiesComposer(version: string, constraint: string): boolean | undefined {
  const v = parseVersion(version);
  if (!v) return undefined;
  const groups = constraint.split(/\s*\|\|?\s*/).filter((x) => x.trim());
  if (!groups.length) return true;
  let readable = false;
  for (const g of groups) {
    const c = conjunction(g);
    if (!c) continue;
    readable = true;
    if (c(v)) return true;
  }
  return readable ? false : undefined;
}

/**
 * The fixed versions an "affected versions" constraint implies: the "<X" upper
 * bound of each alternative (">=8.0.0,<8.0.1|<7.15.2" -> ["8.0.1", "7.15.2"]).
 * An alternative bounded by "<=X" or not at all has no known fix.
 */
export function fixedFromConstraint(constraint: string): string[] {
  const out: string[] = [];
  for (const g of constraint.split(/\s*\|\|?\s*/)) {
    const m = g.match(/(?:^|[\s,])<\s*v?(\d[^\s,]*)/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** The newest of `versions` (stable, newest first or any order) that satisfies the constraint. */
export function pickComposerVersion(constraint: string, versions: string[]): string | undefined {
  const ok = versions.filter((v) => satisfiesComposer(v, constraint) === true);
  return ok.sort((a, b) => compareComposer(b, a) ?? 0)[0];
}
