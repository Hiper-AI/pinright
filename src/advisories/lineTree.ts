/**
 * The same-line fix whose own dependency tree is still vulnerable. pinright
 * recommends the clean release on the project's line first (next 15.5.28 for a
 * 15.x project), and that stays the rule. But next 15 pins a postcss with
 * advisories that only next 16 clears: the agent pins the "safe" version and the
 * audit still flags its tree. This says so, and names the newer release whose
 * tree is clean, so the choice to stay on the line is an informed one.
 *
 * Only computed when the same-line version differs from the newest safe one and
 * the ecosystem has resolved graphs; both graphs and the OSV batch are cached.
 */
import { config } from '../config.js';
import { type Ecosystem } from '../ecosystems.js';
import { GRAPH_ECOSYSTEMS } from '../tree/resolveManifest.js';
import { getDependencies } from './depsdev.js';
import { queryBatch } from './osv.js';
import { releaseLine, type PackageReport } from './resolve.js';

export interface PulledVulnerable {
  name: string;
  version: string;
  ids: string[];
}

export interface LineTreeNote {
  /** The same-line version pinright recommends (or the one requested, when it is that version). */
  version: string;
  line: string;
  /** Dependencies of `version` with advisories, worst-known first as OSV lists them. */
  pulls: PulledVulnerable[];
  /** The newest safe version, on a newer line, whose resolved tree has no known advisories. */
  cleaner: string;
  cleanerLine: string;
}

/** Vulnerable nodes of a version's resolved graph; undefined when the graph or OSV is unavailable. */
async function vulnerableIn(eco: Ecosystem, name: string, version: string): Promise<PulledVulnerable[] | undefined> {
  const g = await getDependencies(eco, name, version).catch(() => undefined);
  if (!g?.nodes?.length) return undefined;
  const nodes = [...new Map(g.nodes.slice(1).map((n) => [`${n.versionKey.name}@${n.versionKey.version}`, n.versionKey])).values()];
  if (!nodes.length) return [];
  const ids = await queryBatch(nodes.map((n) => ({ ecosystem: eco, name: n.name, version: n.version }))).catch(() => undefined);
  if (!ids) return undefined;
  return nodes.flatMap((n, k) => (ids[k]?.length ? [{ name: n.name, version: n.version, ids: ids[k] }] : []));
}

/** In-flight and recent answers, so a batch or a hook re-check does not redo the graph walk; the lookups below are disk-cached too. */
const memo = new Map<string, { at: number; p: Promise<LineTreeNote | undefined> }>();
const MEMO_MS = 15 * 60_000;

export function sameLineTree(r: PackageReport): Promise<LineTreeNote | undefined> {
  const same = r.safeVersionSameLine;
  const newest = r.safeVersion;
  if (!r.requested || !r.line || !same || !newest || same === newest || !GRAPH_ECOSYSTEMS.includes(r.ecosystem)) return Promise.resolve(undefined);
  if (r.verdict === 'malicious' || r.verdict === 'unknown' || r.verdict === 'unknown-package') return Promise.resolve(undefined);
  const key = `${r.ecosystem}:${r.package}:${same}:${newest}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.p;
  const p = (async () => {
    const pulls = await vulnerableIn(r.ecosystem, r.package, same);
    if (!pulls?.length) return undefined;
    // Only worth saying when moving on clears it: the newest safe version's whole tree is clean.
    const after = await vulnerableIn(r.ecosystem, r.package, newest);
    if (!after || after.length) return undefined;
    return { version: same, line: r.line as string, pulls, cleaner: newest, cleanerLine: releaseLine(newest) ?? newest };
  })().catch(() => undefined);
  if (memo.size > 500) memo.clear();
  if (!config.cacheDisabled) memo.set(key, { at: Date.now(), p });
  return p;
}

/** "postcss@8.4.31 (GHSA-7fh5-64p2-3v2j)", up to `max` packages. */
export function pullsText(pulls: PulledVulnerable[], max = 3): string {
  const shown = pulls.slice(0, max).map((x) => `${x.name}@${x.version} (${x.ids.slice(0, 2).join(', ')}${x.ids.length > 2 ? ', ...' : ''})`);
  return shown.join(', ') + (pulls.length > max ? `, +${pulls.length - max} more` : '');
}

/** The sentence for the notice, the batch details and the hook. */
export function lineTreeMessage(pkg: string, n: LineTreeNote): string {
  const fixed = n.pulls.length === 1 ? 'a fixed one' : 'fixed ones';
  return (
    `${pkg} ${n.version} has no advisories itself, but pulls ${pullsText(n.pulls)}; ${pkg} ${n.cleaner} pulls ${fixed}. ` +
    `Staying on ${n.line} keeps ${n.pulls.length === 1 ? 'that alert' : 'those alerts'}; upgrade-guide from ${n.version} to ${n.cleaner} explains the changes.`
  );
}
