/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON from Packagist, read defensively */
/**
 * Packagist, for the composer ecosystem. deps.dev does not index it, so the
 * version list comes from Composer's own metadata (repo.packagist.org/p2) and
 * advisories from OSV ("Packagist") plus Packagist's security advisories API,
 * which also carries FriendsOfPHP records. Both are shaped like deps.dev's
 * answers so the verdict code does not need to know the difference.
 *
 * Gaps, stated in the report: no dependency graphs (transitive checks need a
 * composer.lock), and dev branches ("dev-main", the ~dev file) are not releases
 * and are never recommended.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { getJson, isNotFound } from '../http.js';
import type { DepsDevPackage, DepsDevVersion, DepsDevVersionSummary } from '../advisories/depsdev.js';
import type { OsvVuln } from '../advisories/osv.js';
import { fixedFromConstraint, satisfiesComposer } from './constraint.js';

const REPO = process.env.PACKAGIST_REPO_URL ?? 'https://repo.packagist.org';
const API = process.env.PACKAGIST_API_URL ?? 'https://packagist.org';

export interface PackagistRelease {
  version: string;
  time?: string;
  license?: string[];
  abandoned?: boolean | string;
}

export interface PackagistAdvisory {
  advisoryId: string;
  remoteId?: string;
  title?: string;
  link?: string;
  cve?: string | null;
  affectedVersions: string;
  severity?: string | null;
}

/** "vendor/pkg" with Composer's naming rules; anything else is not a Packagist name. */
export function isComposerName(name: string): boolean {
  return /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/.test(name);
}

/**
 * Composer 2 metadata is "minified": each entry only lists the fields that
 * changed from the previous one, and "__unset" removes a field.
 */
export function expandMinified(list: any[]): any[] {
  const out: any[] = [];
  let prev: Record<string, any> = {};
  for (const entry of list) {
    const cur: Record<string, any> = { ...prev };
    for (const [k, v] of Object.entries(entry ?? {})) {
      if (v === '__unset') delete cur[k];
      else cur[k] = v;
    }
    out.push(cur);
    prev = cur;
  }
  return out;
}

const clean = (v: string) => v.replace(/^v(?=\d)/i, '');

/** Tagged releases of a package, newest first as Packagist lists them. Undefined when the package does not exist. */
export async function packagistReleases(name: string): Promise<PackagistRelease[] | undefined> {
  const n = name.toLowerCase();
  if (!isComposerName(n)) return undefined;
  try {
    const j = await cached(`packagist:p2:${n}`, config.ttl.versions, () => getJson<any>(`${REPO}/p2/${n}.json`));
    let list: any[] = j?.packages?.[n] ?? [];
    if (j?.minified) list = expandMinified(list);
    return list
      .filter((e) => typeof e?.version === 'string' && !/^dev-|\.x-dev$|-dev$/i.test(e.version))
      .map((e) => ({ version: clean(e.version), time: e.time, license: e.license, abandoned: e.abandoned }));
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

/** Advisories Packagist knows for a package (GitHub and FriendsOfPHP), with the affected range as a Composer constraint. */
export async function packagistAdvisories(name: string): Promise<PackagistAdvisory[]> {
  const n = name.toLowerCase();
  const j = await cached(`packagist:adv:${n}`, config.ttl.advisories, () =>
    getJson<any>(`${API}/api/security-advisories/?packages[]=${encodeURIComponent(n)}`),
  );
  const list = j?.advisories?.[n];
  return Array.isArray(list) ? list : Object.values(list ?? {});
}

/** The id we report for a Packagist advisory: the GHSA when there is one (OSV knows it), else the CVE, else Packagist's. */
export function advisoryKey(a: PackagistAdvisory): string {
  if (a.remoteId?.startsWith('GHSA-')) return a.remoteId;
  return a.cve || a.advisoryId;
}

/** FriendsOfPHP often repeats a CVE that a GitHub advisory already covers: keep the GitHub one. */
export function distinctAdvisories(list: PackagistAdvisory[]): PackagistAdvisory[] {
  const ghCves = new Set(list.filter((a) => a.remoteId?.startsWith('GHSA-') && a.cve).map((a) => a.cve));
  return list.filter((a) => a.remoteId?.startsWith('GHSA-') || !a.cve || !ghCves.has(a.cve));
}

/**
 * deps.dev-shaped package: versions with dates. Abandonment is a property of
 * the package, not of a release, so it is reported on the version detail
 * (the requested version says "deprecated: use X") and does not remove every
 * release from the safe-version candidates.
 */
export async function packagistPackage(name: string): Promise<DepsDevPackage | undefined> {
  const rel = await packagistReleases(name);
  if (!rel?.length) return undefined;
  const versions: DepsDevVersionSummary[] = rel.map((r) => ({
    versionKey: { system: 'PACKAGIST', name: name.toLowerCase(), version: r.version },
    publishedAt: r.time,
  }));
  return { packageKey: { system: 'PACKAGIST', name: name.toLowerCase() }, versions };
}

function abandonedReason(a: boolean | string): string {
  return typeof a === 'string' && a ? `abandoned on Packagist; use ${a} instead` : 'abandoned on Packagist';
}

/** deps.dev-shaped version: licenses and the Packagist advisories whose range contains it. */
export async function packagistVersion(name: string, version: string): Promise<DepsDevVersion | undefined> {
  const rel = await packagistReleases(name);
  const hit = rel?.find((r) => r.version === clean(version));
  if (!rel || !hit) return undefined;
  const advisories = await packagistAdvisories(name);
  const keys = distinctAdvisories(advisories).filter((a) => satisfiesComposer(hit.version, a.affectedVersions) === true).map(advisoryKey);
  const abandoned = rel[0].abandoned || hit.abandoned;
  return {
    versionKey: { system: 'PACKAGIST', name: name.toLowerCase(), version: hit.version },
    publishedAt: hit.time,
    isDeprecated: Boolean(abandoned),
    deprecatedReason: abandoned ? abandonedReason(abandoned) : undefined,
    licenses: hit.license,
    advisoryKeys: [...new Set(keys)].map((id) => ({ id })),
  };
}

const BATCH = 50;

/**
 * For a whole composer.lock: the Packagist advisories (one request per 50
 * packages) that OSV did not already return, shaped as OSV records so the tree
 * audit treats them alike. `known` is OSV's ids per package, same order.
 */
export async function packagistAuditExtras(
  packages: { name: string; version: string }[],
  known: string[][],
): Promise<{ ids: string[][]; details: Map<string, OsvVuln> }> {
  const byName = new Map<string, PackagistAdvisory[]>();
  const names = [...new Set(packages.map((p) => p.name.toLowerCase()))].filter(isComposerName);
  for (let i = 0; i < names.length; i += BATCH) {
    const chunk = names.slice(i, i + BATCH);
    const qs = chunk.map((n) => `packages[]=${encodeURIComponent(n)}`).join('&');
    const j = await cached(`packagist:adv:batch:${chunk.join(',')}`, config.ttl.advisories, () => getJson<any>(`${API}/api/security-advisories/?${qs}`));
    for (const [n, list] of Object.entries<any>(j?.advisories ?? {})) byName.set(n.toLowerCase(), Array.isArray(list) ? list : Object.values(list ?? {}));
  }
  const details = new Map<string, OsvVuln>();
  const ids = packages.map((p, i) => {
    const seen = new Set(known[i] ?? []);
    const out: string[] = [];
    for (const a of distinctAdvisories(byName.get(p.name.toLowerCase()) ?? [])) {
      const id = advisoryKey(a);
      if (seen.has(id) || satisfiesComposer(p.version, a.affectedVersions) !== true) continue;
      seen.add(id);
      out.push(id);
      details.set(id, {
        id,
        summary: a.title,
        aliases: [a.cve, a.remoteId].filter((x): x is string => Boolean(x) && x !== id),
        database_specific: a.severity ? { severity: a.severity.toUpperCase() === 'MEDIUM' ? 'MODERATE' : a.severity.toUpperCase() } : undefined,
        // fixedVersions() reads "fixed" events: derive them from the affected-versions constraint.
        affected: [{ package: { name: p.name.toLowerCase(), ecosystem: 'Packagist' }, ranges: [{ type: 'ECOSYSTEM', events: fixedFromConstraint(a.affectedVersions).map((fixed) => ({ fixed })) }] }],
      });
    }
    return out;
  });
  return { ids, details };
}

/** Title and severity of a Packagist advisory, for ids OSV does not carry (FriendsOfPHP). */
export async function packagistAdvisoryInfo(
  name: string,
  id: string,
): Promise<{ title?: string; severity?: string; aliases: string[]; url?: string; fixedIn: string[] } | undefined> {
  const list = await packagistAdvisories(name).catch(() => []);
  const a = list.find((x) => advisoryKey(x) === id);
  if (!a) return undefined;
  return {
    title: a.title,
    severity: a.severity ? (a.severity.toUpperCase() === 'MEDIUM' ? 'MODERATE' : a.severity.toUpperCase()) : undefined,
    aliases: [a.cve, a.remoteId, a.advisoryId].filter((x): x is string => Boolean(x) && x !== id),
    url: a.link,
    fixedIn: fixedFromConstraint(a.affectedVersions),
  };
}
