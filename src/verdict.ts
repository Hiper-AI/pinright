/**
 * Glue between the advisory scan and the typosquat check, producing the final
 * verdict for a package. Lookalike names are only flagged when the package is
 * unknown or very new: "preact" is one edit from "react" and perfectly fine.
 */
import { assessPackage, type PackageReport } from './advisories/resolve.js';
import { getPackage } from './advisories/depsdev.js';
import { type Ecosystem } from './ecosystems.js';
import { assessRisk, type RiskReport } from './risk/index.js';
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
  const v = await checkVerdict(eco, name, version);
  if (opts.risk === false) return v;
  const r = v.report;
  const target = version ? r.requested?.version : r.latestVersion;
  if (!target || r.verdict === 'unknown-package' || r.verdict === 'malicious' || r.verdict === 'unknown') return v;
  v.risk = await assessRisk(eco, name, target).catch(() => ({ version: target, signals: [], unknown: ['risk signals'], sources: [] }));
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
  }
  return { report };
}
