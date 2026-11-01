/**
 * The verdict. Given a package (and maybe a version the agent is about to use),
 * say which version is the newest one with no known advisory, and what is wrong
 * with the requested one.
 *
 * Rule: never say "ok" without having resolved the package and inspected the
 * version. If a source is down, the verdict is "unknown" and says why.
 */
import semver from 'semver';
import { config } from '../config.js';
import { packagistAdvisoryInfo } from '../composer/packagist.js';
import { type Ecosystem, NO_DEPS_DEV } from '../ecosystems.js';
import { getAdvisory, getPackage, getVersion, type DepsDevVersionSummary } from './depsdev.js';
import { cleanField, cleanText } from '../untrusted/index.js';
import { fixedVersions, isMalware, queryVersion, severityOf, titleOf } from './osv.js';
import type { LineTreeNote } from './lineTree.js';

export type Verdict =
  | 'ok'
  | 'vulnerable'
  | 'malicious'
  | 'deprecated'
  | 'unknown-package'
  | 'possible-typosquat'
  | 'unknown';

export interface AdvisoryInfo {
  id: string;
  aliases: string[];
  title?: string;
  severity?: string;
  cvss3Score?: number;
  fixedIn?: string[];
  url: string;
}

export interface RequestedVersionReport {
  version: string;
  verdict: Verdict;
  isDeprecated?: boolean;
  /** The publisher's message, cleaned (one line, capped, withheld when it addresses the agent). */
  deprecatedReason?: string;
  publishedAt?: string;
  licenses?: string[];
  advisories: AdvisoryInfo[];
  /** Publisher text of this version that reads as instructions to an AI agent ("deprecation message: ..."). */
  agentText?: string[];
}

export interface PackageReport {
  package: string;
  ecosystem: Ecosystem;
  verdict: Verdict;
  reason?: string;
  latestVersion?: string;
  latestPublishedAt?: string;
  /** Newest stable, non-deprecated version with no known advisory, past the cooldown. */
  safeVersion?: string;
  safeVersionPublishedAt?: string;
  safeVersionLicenses?: string[];
  /**
   * Release line of the version the project uses ("3.x", or "0.28.x" before 1.0,
   * where minors break). Set when a version was given.
   */
  line?: string;
  /** Newest safe version on that line: the upgrade that should not break the API. */
  safeVersionSameLine?: string;
  /** True when no release on the line is clean and the fix needs a new major. */
  crossLineRequired?: boolean;
  /**
   * When the line has no clean release: the newest clean version on the nearest newer
   * line that has one, if that is older than safeVersion's line (Spring 5.3 -> 6.2, not 7.0).
   */
  safeVersionNearestLine?: string;
  /** Release line of safeVersionNearestLine ("6.x"). */
  nearestLine?: string;
  /** The safe version's release line started less than a year ago. */
  recentMajor?: { line: string; since: string };
  /** When no version is clean: the one with the mildest worst advisory (then fewest), newest on ties. */
  leastExposed?: { version: string; advisories: number; maxSeverity?: string };
  /** The same-line fix pulls dependencies with advisories that only a newer line's safe version clears (lineTree.ts). */
  sameLineTree?: LineTreeNote;
  /** No advisories, but every stable release is inside the cooldown window, so none is recommended. */
  cooldownOnly?: boolean;
  /** Every stable release is deprecated (left-pad, request): the maintainers' message for the latest one. */
  deprecatedReason?: string;
  requested?: RequestedVersionReport;
  checkedAt: string;
  /** Sources that did not answer during this check ("osv.dev", "deps.dev"): the verdict is partial or unknown because of them. */
  unavailable?: string[];
  sources: string[];
}

const PRERELEASE_HINT = /(alpha|beta|rc|canary|dev|preview|nightly|snapshot|pre|next|experimental)/i;
// Go pseudo-versions ("v0.0.0-20190210073940-906799fef2f8") and "+incompatible"
// tags are commits, not releases.
const GO_PSEUDO = /^v?\d+\.\d+\.\d+-(?:\w+\.)?(?:0\.)?\d{14}-[0-9a-f]{12}$|\+incompatible$/;

/**
 * One parse per version string. A package with a few thousand releases is sorted,
 * filtered and split into lines several times per check; parsing each time was a
 * second of CPU for a 30-dependency manifest.
 */
function memoized<T>(fn: (version: string) => T): (version: string) => T {
  const seen = new Map<string, T>();
  return (version) => {
    if (seen.has(version)) return seen.get(version) as T;
    if (seen.size > 50_000) seen.clear();
    const v = fn(version);
    seen.set(version, v);
    return v;
  };
}

export const isPrerelease = memoized((version: string): boolean => {
  if (GO_PSEUDO.test(version)) return true;
  const parsed = semver.parse(version, { loose: true }) ?? semver.coerce(version, { includePrerelease: true });
  if (parsed && parsed.prerelease.length > 0) return true;
  return PRERELEASE_HINT.test(version);
});

const coerced = memoized((version: string) => semver.coerce(version, { includePrerelease: true }));

/** Newest first. Semver when both sides parse; publish date otherwise. */
export function compareVersionsDesc(a: DepsDevVersionSummary, b: DepsDevVersionSummary): number {
  const va = coerced(a.versionKey.version);
  const vb = coerced(b.versionKey.version);
  if (va && vb) {
    const c = semver.rcompare(va, vb);
    if (c !== 0) return c;
  }
  return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '');
}

/** "3.x" for 3.2.1, "0.28.x" for 0.28.1 (pre-1.0 minors are breaking by semver). */
export const releaseLine = memoized((version: string): string | undefined => {
  const v = semver.coerce(version, { includePrerelease: false });
  if (!v) return undefined;
  return v.major === 0 ? `0.${v.minor}.x` : `${v.major}.x`;
});

/** Order of two release lines as releaseLine writes them ("0.28.x" < "1.x" < "6.x"). */
export function compareLines(a: string, b: string): number {
  const va = semver.coerce(a.replace(/\.x$/, ''));
  const vb = semver.coerce(b.replace(/\.x$/, ''));
  return va && vb ? semver.compare(va, vb) : 0;
}

/**
 * The upgrade to recommend for a requested version: the clean release on its line,
 * then the nearest newer line with one, then the newest clean release.
 */
export function recommendedUpgrade(r: Pick<PackageReport, 'safeVersionSameLine' | 'safeVersionNearestLine' | 'safeVersion'>): string | undefined {
  return r.safeVersionSameLine ?? r.safeVersionNearestLine ?? r.safeVersion;
}

/** Intermediate lines inspected for a nearer fix before falling back to the newest one. */
const MAX_NEAREST_LINES = 4;
const RECENT_MAJOR_DAYS = 365;

function olderThanCooldown(publishedAt: string | undefined, now: number): boolean {
  if (!publishedAt) return true;
  const age = now - Date.parse(publishedAt);
  return age >= config.cooldownDays * 24 * 3600_000;
}

async function describeAdvisories(
  eco: Ecosystem,
  name: string,
  version: string,
  ids: string[],
): Promise<{ advisories: AdvisoryInfo[]; osvDown?: string }> {
  // OSV gives summary, severity and the fixed versions in one call.
  let osvDown: string | undefined;
  const osv = await queryVersion(eco, name, version).catch((err: Error) => {
    osvDown = err.message;
    return [];
  });
  const byId = new Map(osv.map((v) => [v.id, v]));
  const allIds = [...new Set<string>([...ids, ...osv.map((v) => v.id)])];
  const out = await Promise.all(
    allIds.map(async (id): Promise<AdvisoryInfo> => {
      const vuln = byId.get(id);
      // Packagist ids (FriendsOfPHP) are not in deps.dev; Packagist's own API describes them.
      const pk = !vuln && eco === 'composer' ? await packagistAdvisoryInfo(name, id) : undefined;
      const dd = vuln || eco === 'composer' ? undefined : await getAdvisory(id).catch(() => undefined);
      return {
        id,
        aliases: vuln?.aliases ?? dd?.aliases ?? pk?.aliases ?? [],
        title: cleanText((vuln && titleOf(vuln)) ?? dd?.title ?? pk?.title),
        severity: vuln ? severityOf(vuln) : pk?.severity,
        cvss3Score: dd?.cvss3Score,
        fixedIn: vuln ? fixedVersions(vuln, name) : pk?.fixedIn,
        url: dd?.url ?? pk?.url ?? `https://osv.dev/vulnerability/${id}`,
      };
    }),
  );
  return { advisories: dedupeAdvisories(out), osvDown };
}

/** Candidates probed at once while looking for the newest clean version: 1, then 3, then 8 (order still decides). */
const PROBE_GROWTH = 3;
const PROBE_WINDOW_MAX = 8;

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, MEDIUM: 2, LOW: 3 };

/**
 * OSV mirrors the same CVE under several ids (GHSA-*, PYSEC-*, RUSTSEC-*).
 * Keep one per CVE, preferring the record that carries a title. Worst first,
 * so an agent that reads only the first line sees the critical one.
 */
export function dedupeAdvisories(list: AdvisoryInfo[]): AdvisoryInfo[] {
  const byCve = new Map<string, AdvisoryInfo>();
  const out: AdvisoryInfo[] = [];
  for (const a of list) {
    const cve = a.aliases.find((x) => x.startsWith('CVE-')) ?? (a.id.startsWith('CVE-') ? a.id : undefined);
    if (!cve) {
      out.push(a);
      continue;
    }
    const prev = byCve.get(cve);
    if (!prev) {
      byCve.set(cve, a);
      continue;
    }
    const better = (!prev.title && a.title) || (prev.title && a.title && a.id.startsWith('GHSA-') && !prev.id.startsWith('GHSA-'));
    if (better) {
      byCve.set(cve, { ...a, fixedIn: a.fixedIn?.length ? a.fixedIn : prev.fixedIn, severity: a.severity ?? prev.severity, cvss3Score: a.cvss3Score ?? prev.cvss3Score });
    } else if (!prev.fixedIn?.length && a.fixedIn?.length) {
      prev.fixedIn = a.fixedIn;
    }
  }
  out.push(...byCve.values());
  const rank = (a: AdvisoryInfo) => {
    if (isMalware(a.id)) return -1;
    if (a.cvss3Score != null) return 10 - a.cvss3Score;
    if (a.severity && a.severity.toUpperCase() in SEVERITY_RANK) return SEVERITY_RANK[a.severity.toUpperCase()] * 2.5;
    return 5;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

export async function assessPackage(
  eco: Ecosystem,
  name: string,
  requestedVersion?: string,
): Promise<PackageReport> {
  const checkedAt = new Date().toISOString();
  // Composer is not in deps.dev: versions from Packagist, advisories from Packagist and OSV.
  const registry = NO_DEPS_DEV.includes(eco) ? 'packagist.org' : 'deps.dev';
  const sources = [registry, 'osv.dev'];
  const base = { package: name, ecosystem: eco, checkedAt, sources };

  let pkg;
  try {
    pkg = await getPackage(eco, name);
  } catch (err) {
    return {
      ...base,
      verdict: 'unknown',
      reason: `${registry} did not answer (${(err as Error).message}); no verdict possible`,
      unavailable: [registry],
    };
  }
  if (!pkg || pkg.versions.length === 0) {
    return { ...base, verdict: 'unknown-package', reason: `${registry} has no package "${name}" in ${eco}` };
  }
  // The requested version is looked at while the candidates are scanned: neither waits for the other.
  const requestedP = requestedVersion ? assessRequested(eco, name, requestedVersion) : undefined;
  requestedP?.catch(() => {}); // awaited below; this only keeps an early rejection from counting as unhandled

  const versions = [...pkg.versions].sort(compareVersionsDesc);
  const latest = versions.find((v) => v.isDefault) ?? versions.find((v) => !isPrerelease(v.versionKey.version)) ?? versions[0];
  const now = Date.now();

  // Candidates for "safe": stable, not deprecated, past the cooldown, newest first.
  const eligible = versions
    .filter((v) => !v.isDeprecated && !isPrerelease(v.versionKey.version))
    .filter((v) => olderThanCooldown(v.publishedAt, now));
  const candidates = eligible.slice(0, config.maxCandidates);

  let sourceDown: string | undefined;
  let osvDown: string | undefined;
  /** Is this candidate clean? Throws when the registry source does not answer. */
  async function probe(cand: DepsDevVersionSummary): Promise<{ cand: DepsDevVersionSummary; licenses?: string[] } | undefined> {
    // deps.dev mirrors OSV with a lag of hours; a fresh advisory may only be in OSV yet, so both are asked, at once.
    // If OSV is unreachable, deps.dev's answer is all there is, and the verdict says so.
    const [detail, osv] = await Promise.all([
      getVersion(eco, name, cand.versionKey.version),
      queryVersion(eco, name, cand.versionKey.version).catch((err: Error) => {
        osvDown = err.message;
        return [];
      }),
    ]);
    if (!detail || (detail.advisoryKeys ?? []).length > 0) return undefined;
    return osv.length === 0 ? { cand, licenses: detail.licenses } : undefined;
  }
  /**
   * The newest clean candidate, first in order wins. The newest alone first (usually
   * it is clean), then growing windows probed at once: 12 candidates in three round trips.
   */
  async function firstClean(list: DepsDevVersionSummary[]) {
    for (let i = 0, w = 1; i < list.length && !sourceDown; i += w, w = Math.min(w * PROBE_GROWTH, PROBE_WINDOW_MAX)) {
      const settled = await Promise.allSettled(list.slice(i, i + w).map(probe));
      for (const s of settled) {
        if (s.status === 'rejected') {
          sourceDown = (s.reason as Error).message;
          return undefined;
        }
        if (s.value) return s.value;
      }
    }
    return undefined;
  }

  // Same release line as the version the project uses: the upgrade that keeps the API.
  // Scanned alongside the newest candidates; the lists overlap, and the cache shares their requests.
  const line = requestedVersion ? releaseLine(requestedVersion) : undefined;
  const onLine = line ? eligible.filter((v) => releaseLine(v.versionKey.version) === line).slice(0, config.maxCandidates) : [];
  const [found, foundOnLine] = await Promise.all([firstClean(candidates), line ? firstClean(onLine) : undefined]);
  const safe = found?.cand;
  const safeLicenses = found?.licenses;
  let safeSameLine: DepsDevVersionSummary | undefined;
  if (line && !sourceDown) safeSameLine = safe && releaseLine(safe.versionKey.version) === line ? safe : foundOnLine?.cand;

  const report: PackageReport = {
    ...base,
    verdict: 'ok',
    latestVersion: latest.versionKey.version,
    latestPublishedAt: latest.publishedAt,
    safeVersion: safe?.versionKey.version,
    safeVersionPublishedAt: safe?.publishedAt,
    safeVersionLicenses: safeLicenses,
  };
  if (line) {
    report.line = line;
    report.safeVersionSameLine = safeSameLine?.versionKey.version;
    report.crossLineRequired = !safeSameLine && Boolean(safe);
  }
  if (line && safe && !safeSameLine && !sourceDown) {
    // Before jumping to the newest major, try the lines in between, oldest first:
    // a maintained older major (Spring 6.2 for a 5.3 project) breaks less than the newest one.
    const safeLine = releaseLine(safe.versionKey.version) as string;
    const between = [...new Set(eligible.map((v) => releaseLine(v.versionKey.version)).filter((l): l is string => Boolean(l)))]
      .filter((l) => compareLines(l, line) > 0 && compareLines(l, safeLine) < 0)
      .sort(compareLines)
      .slice(0, MAX_NEAREST_LINES);
    // All lines at once; the oldest one with a clean release wins.
    const hits = await Promise.all(
      between.map((l) => firstClean(eligible.filter((v) => releaseLine(v.versionKey.version) === l).slice(0, config.maxCandidates))),
    );
    const k = hits.findIndex(Boolean);
    if (!sourceDown && k >= 0) {
      report.safeVersionNearestLine = hits[k]?.cand.versionKey.version;
      report.nearestLine = between[k];
    }
  }
  if (!safe && !sourceDown && candidates.length) {
    // Nothing is clean: point at the least exposed version instead of leaving the agent stuck.
    let best: { version: string; rank: number; count: number; maxSeverity?: string } | undefined;
    const exposure = await Promise.all(candidates.map((cand) => queryVersion(eco, name, cand.versionKey.version).catch(() => undefined)));
    for (const [j, cand] of candidates.entries()) {
      const vulns = exposure[j];
      if (!vulns) continue;
      if (vulns.some((v) => isMalware(v.id))) continue;
      const sevs = vulns.map((v) => (severityOf(v) ?? 'UNKNOWN').toUpperCase());
      const rank = Math.min(...sevs.map((s) => SEVERITY_RANK[s] ?? 1.5), 4);
      const maxSeverity = sevs.sort((a, b) => (SEVERITY_RANK[a] ?? 1.5) - (SEVERITY_RANK[b] ?? 1.5))[0];
      // Lower worst severity wins; then fewer advisories; candidates are newest first, so ties keep the newer.
      if (!best || rank > best.rank || (rank === best.rank && vulns.length < best.count)) {
        best = { version: cand.versionKey.version, rank, count: vulns.length, maxSeverity };
      }
    }
    if (best) report.leastExposed = { version: best.version, advisories: best.count, maxSeverity: best.maxSeverity };
  }
  if (safe) {
    // A major younger than a year is likely newer than what the agent learned:
    // configuration and APIs it writes from memory may not apply.
    const safeLine = releaseLine(safe.versionKey.version);
    const firstOnLine = versions
      .filter((v) => !isPrerelease(v.versionKey.version) && releaseLine(v.versionKey.version) === safeLine && v.publishedAt)
      .map((v) => v.publishedAt as string)
      .sort()[0];
    if (firstOnLine && now - Date.parse(firstOnLine) < RECENT_MAJOR_DAYS * 24 * 3600_000) {
      report.recentMajor = { line: safeLine as string, since: firstOnLine.slice(0, 10) };
    }
  }

  if (sourceDown) {
    report.verdict = 'unknown';
    report.reason = `${registry} did not answer while scanning versions (${sourceDown})`;
    report.unavailable = [registry];
  } else if (!safe && candidates.length === 0 && versions.some((v) => !v.isDeprecated && !isPrerelease(v.versionKey.version))) {
    // Every stable release is inside the cooldown (a brand-new package, or only fresh releases):
    // nothing to recommend yet, but no advisory either. Saying "vulnerable" here would be false.
    report.cooldownOnly = true;
    report.reason = `every stable release is younger than the ${config.cooldownDays}-day cooldown; none can be recommended yet`;
  } else if (!safe && candidates.length === 0 && versions.some((v) => !isPrerelease(v.versionKey.version))) {
    // Every stable release is deprecated: that is the news, not "no version is free of advisories" for a package with none.
    const detail = await getVersion(eco, name, latest.versionKey.version).catch(() => undefined);
    report.deprecatedReason = cleanField(detail?.deprecatedReason || undefined, 300).text;
    // request: deprecated and its latest release has advisories; that stays the headline.
    report.verdict = (detail?.advisoryKeys ?? []).length ? 'vulnerable' : 'deprecated';
    report.reason = 'every stable release is deprecated by its maintainers';
  } else if (!safe) {
    report.verdict = 'vulnerable';
    report.reason = `none of the newest ${candidates.length} stable versions past the ${config.cooldownDays}-day cooldown is free of known advisories`;
  }

  if (requestedP) {
    const { requested, osvDown: down, error } = await requestedP;
    report.requested = requested;
    osvDown ??= down;
    if (error) report.unavailable = [registry];
    // The headline verdict is about what the agent asked for. Malware and a version that does not
    // exist win over anything the package-wide scan said: "vulnerable" (no clean version, as in a
    // package whose every release is malicious) or "unknown" (a source failed while scanning) would
    // let the hook and the MCP answer treat malware as an ordinary advisory or an unverified package.
    const definite = report.requested.verdict === 'malicious' || report.requested.verdict === 'unknown-package';
    if (report.requested.verdict !== 'ok' && (report.verdict === 'ok' || report.verdict === 'deprecated' || definite)) {
      report.verdict = report.requested.verdict;
      report.reason = report.requested.verdict === 'unknown'
        ? `${registry} did not answer for version ${requestedVersion} (${error ?? 'no answer'}); no verdict possible`
        : report.requested.verdict === 'unknown-package'
          ? `version ${requestedVersion} of ${name} does not exist in ${eco}`
          : undefined;
    }
  }
  // "No known advisories" needs both sources: deps.dev alone lags OSV by hours, and fresh malware reports land in OSV first.
  if (osvDown && report.verdict === 'ok') {
    report.verdict = 'unknown';
    report.reason = `osv.dev did not answer (${osvDown}); ${registry} lists no advisories, but it mirrors OSV with a lag, so this is unverified`;
    if (report.requested?.verdict === 'ok') report.requested.verdict = 'unknown';
  }
  if (osvDown) report.unavailable = [...new Set([...(report.unavailable ?? []), 'osv.dev'])];
  return report;
}

async function assessRequested(
  eco: Ecosystem,
  name: string,
  version: string,
): Promise<{ requested: RequestedVersionReport; osvDown?: string; error?: string }> {
  const clean = version.replace(/^v/, '');
  let detail;
  try {
    // getVersion puts back the "v" deps.dev needs for Go module versions.
    detail = await getVersion(eco, name, clean);
  } catch (err) {
    return { requested: { version: clean, verdict: 'unknown', advisories: [] }, error: (err as Error).message };
  }
  if (!detail) {
    return { requested: { version: clean, verdict: 'unknown-package', advisories: [] } };
  }
  const ids = (detail.advisoryKeys ?? []).map((a) => a.id);
  const { advisories, osvDown } = await describeAdvisories(eco, name, clean, ids);
  let verdict: Verdict = 'ok';
  if (advisories.some((a) => isMalware(a.id))) verdict = 'malicious';
  else if (advisories.length > 0) verdict = 'vulnerable';
  else if (detail.isDeprecated) verdict = 'deprecated';
  // The deprecation message is written by whoever controls the package: it goes to the agent and the hook.
  const reason = cleanField(detail.deprecatedReason || undefined, 300);
  return {
    requested: {
      version: clean,
      verdict,
      isDeprecated: detail.isDeprecated,
      deprecatedReason: reason.text,
      publishedAt: detail.publishedAt,
      licenses: detail.licenses,
      advisories,
      ...(reason.level === 'high' ? { agentText: [`deprecation message (${reason.flags.join(', ')})`] } : {}),
    },
    osvDown,
  };
}
