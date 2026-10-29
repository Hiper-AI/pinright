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
import { type Ecosystem } from '../ecosystems.js';
import { getAdvisory, getPackage, getVersion, type DepsDevVersionSummary } from './depsdev.js';
import { fixedVersions, isMalware, queryVersion, severityOf } from './osv.js';

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
  deprecatedReason?: string;
  publishedAt?: string;
  licenses?: string[];
  advisories: AdvisoryInfo[];
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
  /** The safe version's release line started less than a year ago. */
  recentMajor?: { line: string; since: string };
  requested?: RequestedVersionReport;
  checkedAt: string;
  sources: string[];
}

const PRERELEASE_HINT = /(alpha|beta|rc|canary|dev|preview|nightly|snapshot|pre|next|experimental)/i;
// Go pseudo-versions ("v0.0.0-20190210073940-906799fef2f8") and "+incompatible"
// tags are commits, not releases.
const GO_PSEUDO = /^v?\d+\.\d+\.\d+-(?:\w+\.)?(?:0\.)?\d{14}-[0-9a-f]{12}$|\+incompatible$/;

export function isPrerelease(version: string): boolean {
  if (GO_PSEUDO.test(version)) return true;
  const parsed = semver.parse(version, { loose: true }) ?? semver.coerce(version, { includePrerelease: true });
  if (parsed && parsed.prerelease.length > 0) return true;
  return PRERELEASE_HINT.test(version);
}

/** Newest first. Semver when both sides parse; publish date otherwise. */
export function compareVersionsDesc(a: DepsDevVersionSummary, b: DepsDevVersionSummary): number {
  const va = semver.coerce(a.versionKey.version, { includePrerelease: true });
  const vb = semver.coerce(b.versionKey.version, { includePrerelease: true });
  if (va && vb) {
    const c = semver.rcompare(va, vb);
    if (c !== 0) return c;
  }
  return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '');
}

/** "3.x" for 3.2.1, "0.28.x" for 0.28.1 (pre-1.0 minors are breaking by semver). */
export function releaseLine(version: string): string | undefined {
  const v = semver.coerce(version, { includePrerelease: false });
  if (!v) return undefined;
  return v.major === 0 ? `0.${v.minor}.x` : `${v.major}.x`;
}

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
): Promise<AdvisoryInfo[]> {
  // OSV gives summary, severity and the fixed versions in one call.
  const osv = await queryVersion(eco, name, version).catch(() => []);
  const byId = new Map(osv.map((v) => [v.id, v]));
  const allIds = new Set<string>([...ids, ...osv.map((v) => v.id)]);
  const out: AdvisoryInfo[] = [];
  for (const id of allIds) {
    const vuln = byId.get(id);
    const dd = vuln ? undefined : await getAdvisory(id).catch(() => undefined);
    out.push({
      id,
      aliases: vuln?.aliases ?? dd?.aliases ?? [],
      title: vuln?.summary ?? dd?.title,
      severity: vuln ? severityOf(vuln) : undefined,
      cvss3Score: dd?.cvss3Score,
      fixedIn: vuln ? fixedVersions(vuln, name) : undefined,
      url: dd?.url ?? `https://osv.dev/vulnerability/${id}`,
    });
  }
  return dedupeAdvisories(out);
}

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
      byCve.set(cve, { ...a, fixedIn: a.fixedIn?.length ? a.fixedIn : prev.fixedIn, severity: a.severity ?? prev.severity });
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
  const sources = ['deps.dev', 'osv.dev'];
  const base = { package: name, ecosystem: eco, checkedAt, sources };

  let pkg;
  try {
    pkg = await getPackage(eco, name);
  } catch (err) {
    return {
      ...base,
      verdict: 'unknown',
      reason: `deps.dev did not answer (${(err as Error).message}); no verdict possible`,
    };
  }
  if (!pkg || pkg.versions.length === 0) {
    return { ...base, verdict: 'unknown-package', reason: `deps.dev has no package "${name}" in ${eco}` };
  }

  const versions = [...pkg.versions].sort(compareVersionsDesc);
  const latest = versions.find((v) => v.isDefault) ?? versions.find((v) => !isPrerelease(v.versionKey.version)) ?? versions[0];
  const now = Date.now();

  // Candidates for "safe": stable, not deprecated, past the cooldown, newest first.
  const eligible = versions
    .filter((v) => !v.isDeprecated && !isPrerelease(v.versionKey.version))
    .filter((v) => olderThanCooldown(v.publishedAt, now));
  const candidates = eligible.slice(0, config.maxCandidates);

  let sourceDown: string | undefined;
  async function firstClean(list: DepsDevVersionSummary[]) {
    for (const cand of list) {
      try {
        const detail = await getVersion(eco, name, cand.versionKey.version);
        if (!detail) continue;
        if ((detail.advisoryKeys ?? []).length === 0) return { cand, licenses: detail.licenses };
      } catch (err) {
        sourceDown = (err as Error).message;
        return undefined;
      }
    }
    return undefined;
  }

  const found = await firstClean(candidates);
  const safe = found?.cand;
  const safeLicenses = found?.licenses;

  // Same release line as the version the project uses: the upgrade that keeps the API.
  const line = requestedVersion ? releaseLine(requestedVersion) : undefined;
  let safeSameLine: DepsDevVersionSummary | undefined;
  if (line && !sourceDown) {
    const onLine = eligible
      .filter((v) => releaseLine(v.versionKey.version) === line)
      .slice(0, config.maxCandidates);
    safeSameLine = safe && releaseLine(safe.versionKey.version) === line ? safe : (await firstClean(onLine))?.cand;
  }

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
    report.reason = `deps.dev did not answer while scanning versions (${sourceDown})`;
  } else if (!safe) {
    report.verdict = 'vulnerable';
    report.reason =
      `none of the newest ${candidates.length} stable versions is free of known advisories ` +
      `(or all are younger than the ${config.cooldownDays}-day cooldown)`;
  }

  if (requestedVersion) {
    report.requested = await assessRequested(eco, name, requestedVersion);
    // The headline verdict is about what the agent asked for.
    if (report.requested.verdict !== 'ok' && report.verdict === 'ok') {
      report.verdict = report.requested.verdict;
      report.reason = report.requested.verdict === 'unknown-package'
        ? `version ${requestedVersion} of ${name} does not exist in ${eco}`
        : undefined;
    }
  }
  return report;
}

async function assessRequested(
  eco: Ecosystem,
  name: string,
  version: string,
): Promise<RequestedVersionReport> {
  const clean = version.replace(/^v/, '');
  let detail;
  try {
    detail = await getVersion(eco, name, clean);
  } catch (err) {
    return { version: clean, verdict: 'unknown', advisories: [], deprecatedReason: (err as Error).message };
  }
  if (!detail) {
    return { version: clean, verdict: 'unknown-package', advisories: [] };
  }
  const ids = (detail.advisoryKeys ?? []).map((a) => a.id);
  const advisories = await describeAdvisories(eco, name, clean, ids);
  let verdict: Verdict = 'ok';
  if (advisories.some((a) => isMalware(a.id))) verdict = 'malicious';
  else if (advisories.length > 0) verdict = 'vulnerable';
  else if (detail.isDeprecated) verdict = 'deprecated';
  return {
    version: clean,
    verdict,
    isDeprecated: detail.isDeprecated,
    deprecatedReason: detail.deprecatedReason || undefined,
    publishedAt: detail.publishedAt,
    licenses: detail.licenses,
    advisories,
  };
}
