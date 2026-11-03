/**
 * Glue between the advisory scan and the typosquat check, producing the final
 * verdict for a package. Lookalike names are flagged when the package is unknown,
 * very new, or used by a tiny fraction of the original's audience: "preact" is one
 * edit from "react" and perfectly fine, "expresss" is not.
 */
import { assessPackage, type PackageReport } from './advisories/resolve.js';
import { sameLineTree } from './advisories/lineTree.js';
import { getPackage } from './advisories/depsdev.js';
import { config } from './config.js';
import { type Ecosystem } from './ecosystems.js';
import { REGISTRY_HOST } from './registry.js';
import { assessRisk, type RiskReport } from './risk/index.js';
import { weeklyDownloads } from './risk/sources.js';
import { checkTyposquat, findLookalike, type TyposquatReport } from './typosquat.js';

const YOUNG_PACKAGE_DAYS = 60;

export interface Verdict {
  report: PackageReport;
  typo?: TyposquatReport;
  /** Behavior signals beyond known advisories (install scripts, provenance, publisher, age). */
  risk?: RiskReport;
}

async function firstPublishedAt(eco: Ecosystem, name: string): Promise<number | undefined> {
  const pkg = await getPackage(eco, name).catch(() => undefined);
  const dates = (pkg?.versions ?? [])
    .map((v) => (v.publishedAt ? Date.parse(v.publishedAt) : NaN))
    .filter((d) => Number.isFinite(d));
  return dates.length ? Math.min(...dates) : undefined;
}

/**
 * The verdict plus the supply-chain risk signals of the version the agent would
 * get: the one it asked for, or the latest (what a bare install resolves to).
 * Pass `{ risk: false }` where only the verdict matters (search results).
 */
export async function checkPackage(
  eco: Ecosystem,
  name: string,
  version?: string,
  opts: { risk?: boolean } = {},
): Promise<Verdict> {
  // With a version, the risk signals' lookups start alongside the verdict instead of after it; the second
  // call below finds them in the cache. Wasted only when the verdict rules risk out (malware, unknown).
  if (version && opts.risk !== false && !config.cacheDisabled) void assessRisk(eco, name, version.replace(/^v/, ''), Date.now()).catch(() => undefined);
  const v = await checkVerdict(eco, name, version);
  if (opts.risk === false) return v;
  const r = v.report;
  const target = version ? r.requested?.version : r.latestVersion;
  if (!target || r.verdict === 'unknown-package' || r.verdict === 'malicious' || r.verdict === 'unknown') return v;
  const agentText = version && r.requested?.version === target ? (r.requested.agentText ?? []) : [];
  // The same-line fix's own tree (two cached graph lookups, only when it is not the newest safe version) beside the risk signals.
  const [risk, tree] = await Promise.all([
    assessRisk(eco, name, target, Date.now(), agentText).catch(() => ({ version: target, signals: [], unknown: ['risk signals'], sources: [] })),
    sameLineTree(r),
  ]);
  v.risk = risk;
  if (tree) r.sameLineTree = tree;
  return v;
}

async function checkVerdict(
  eco: Ecosystem,
  name: string,
  version?: string,
): Promise<Verdict> {
  const report = await assessPackage(eco, name, version);

  if (report.verdict === 'unknown-package' && !report.requested) {
    const typo = await checkTyposquat(eco, name);
    if (typo.lookalikeOf) report.verdict = 'possible-typosquat';
    else if (typo.existsInRegistry && REGISTRY_HOST[eco]) {
      // deps.dev indexes new packages hours late: the registry has it, so "no such package" would be false.
      // Nothing about it could be checked, and a package this new is where most malicious publishes hide.
      report.verdict = 'unknown';
      report.notIndexed = REGISTRY_HOST[eco];
      report.sources = [...report.sources, REGISTRY_HOST[eco]];
      report.reason =
        `${name} is published on ${REGISTRY_HOST[eco]}, but deps.dev has no data for it yet (it indexes new packages with a delay of hours); ` +
        'its versions, advisories, age and install scripts could not be checked';
    }
    return { report, typo };
  }

  const look = findLookalike(eco, name);
  if (look) {
    const first = await firstPublishedAt(eco, name);
    const young = first !== undefined && Date.now() - first < YOUNG_PACKAGE_DAYS * 24 * 3600_000;
    if (young) {
      const typo: TyposquatReport = { existsInRegistry: true, lookalikeOf: look.of, distance: look.distance };
      report.verdict = 'possible-typosquat';
      report.reason = `published ${Math.round((Date.now() - first) / 86_400_000)} days ago and one edit away from "${look.of}"`;
      return { report, typo };
    }
    // An old lookalike can still be a squat or a placeholder ("expresss"): compare how much each is used.
    // A real package with a similar name ("preact" next to "react") has its own large audience.
    const [mine, theirs] = await Promise.all([weeklyDownloads(eco, name).catch(() => undefined), weeklyDownloads(eco, look.of).catch(() => undefined)]);
    if (mine !== undefined && theirs !== undefined && theirs > 0 && mine < theirs * LOOKALIKE_SHARE && mine < OWN_AUDIENCE) {
      const typo: TyposquatReport = { existsInRegistry: true, lookalikeOf: look.of, distance: look.distance };
      report.verdict = 'possible-typosquat';
      report.reason = `${look.distance} edit${look.distance === 1 ? '' : 's'} away from "${look.of}", with ${mine.toLocaleString('en-US')} weekly downloads against ${theirs.toLocaleString('en-US')}`;
      return { report, typo };
    }
  }
  return { report };
}

/** A lookalike with less than this share of the original's weekly downloads is flagged even when old. */
const LOOKALIKE_SHARE = 0.01;
/**
 * ...unless it has an audience of its own: "unicorn" (the CPU emulator, ~570k a week) is 1 edit from
 * "uvicorn" and "xterm" (~630k) 2 from "xtend", both under 1% of a giant. A squat or a placeholder is
 * downloaded by mirrors and mistakes, far below this. New packages never get here (the young rule above).
 */
const OWN_AUDIENCE = 50_000;
