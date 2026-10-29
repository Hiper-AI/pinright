/**
 * Whole-tree audit: every package in a lockfile (or in the tree resolved from a
 * manifest) against OSV in batches, then a fix per finding:
 *   - direct dependency: the safe version on its release line;
 *   - transitive: the upgrade of the direct parent that clears it, verified on
 *     deps.dev's graph of that parent version; otherwise an override pin.
 * Counting matches Dependabot: one alert per (package, advisory).
 */
import semver from 'semver';
import { getDependencies } from '../advisories/depsdev.js';
import { cvss3Of } from '../advisories/cvss.js';
import { fixedVersions, getVuln, isMalware, queryBatch, severityOf } from '../advisories/osv.js';
import { assessPackage, dedupeAdvisories, recommendedUpgrade, type AdvisoryInfo } from '../advisories/resolve.js';
import { packagistAuditExtras } from '../composer/packagist.js';
import { type Ecosystem, installCommand } from '../ecosystems.js';
import { normalizePypiName, type ParsedTree, type TreePackage } from './lockfiles.js';
import { GRAPH_ECOSYSTEMS, resolveManifest } from './resolveManifest.js';

export interface TreeFinding {
  name: string;
  version: string;
  direct?: boolean;
  dev?: boolean;
  path?: string[];
  malicious: boolean;
  severity?: string;
  /** Smallest version that fixes every advisory listed, when OSV says. */
  fixedVersion?: string;
  advisories: AdvisoryInfo[];
}

export interface Remediation {
  /** The direct dependency to change. */
  target: string;
  from?: string;
  to: string;
  kind: 'upgrade-direct' | 'upgrade-parent' | 'override';
  command: string;
  clears: string[];
  crossesMajor?: boolean;
}

export interface TreeAudit {
  ecosystem: Ecosystem;
  file: string;
  source: 'lockfile' | 'manifest resolved by deps.dev' | 'manifest resolved from Packagist metadata';
  packages: number;
  vulnerablePackages: number;
  alerts: number;
  bySeverity: Record<'critical' | 'high' | 'moderate' | 'low' | 'unknown', number>;
  malicious: number;
  findings: TreeFinding[];
  remediation: Remediation[];
  notes: string[];
  checkedAt: string;
}

const SEV_ORDER = ['CRITICAL', 'HIGH', 'MODERATE', 'MEDIUM', 'LOW'];
const MAX_VULN_DETAILS = 400;
const MAX_PARENTS = 12;

export async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function vcmp(a: string, b: string): number {
  const va = semver.coerce(a);
  const vb = semver.coerce(b);
  if (va && vb) return semver.compare(va, vb);
  return a.localeCompare(b, undefined, { numeric: true });
}

/** For each advisory, the lowest fix above the current version; the fix for all is the highest of those. */
function fixFor(current: string, advisories: AdvisoryInfo[]): string | undefined {
  let need: string | undefined;
  for (const a of advisories) {
    const above = (a.fixedIn ?? []).filter((f) => vcmp(f, current) > 0).sort(vcmp);
    if (!above.length) return undefined; // one advisory without a fix: no single version fixes all
    if (!need || vcmp(above[0], need) > 0) need = above[0];
  }
  return need;
}

function overrideHint(eco: Ecosystem, name: string, version: string): string {
  switch (eco) {
    case 'npm':
      return `add "overrides": { "${name}": "${version}" } to package.json (pnpm: pnpm.overrides, yarn: resolutions)`;
    case 'pypi':
      return `add "${name}>=${version}" to your constraints/requirements and re-lock`;
    case 'cargo':
      return `cargo update -p ${name} --precise ${version}`;
    case 'go':
      return `go get ${name}@v${version.replace(/^v/, '')} && go mod tidy`;
    case 'rubygems':
      return `bundle update ${name} (needs ${version} or newer)`;
    case 'composer':
      return `composer update ${name} --with-all-dependencies (needs ${version} or newer; or require "${name}": "^${version}")`;
    case 'maven':
      return `pin ${name}:${version} in <dependencyManagement> (Maven) or with a constraints block (Gradle)`;
    default:
      return installCommand(eco, name, version);
  }
}

/** `packagesOut` receives the packages audited (for a manifest, the tree deps.dev resolved). */
export async function auditTree(tree: ParsedTree, opts: { includeDev?: boolean; packagesOut?: TreePackage[] } = {}): Promise<TreeAudit> {
  const notes: string[] = [];
  const eco = tree.ecosystem;
  let packages: TreePackage[] = tree.packages;
  if (tree.kind === 'manifest') {
    packages = await resolveManifest(tree, notes);
    notes.push(
      GRAPH_ECOSYSTEMS.includes(eco)
        ? `No lockfile: the tree was resolved by ${eco === 'composer' ? "safectx from Packagist's metadata" : 'deps.dev'}, one direct dependency at a time. Audit the lockfile for the exact tree.`
        : 'No lockfile and no graph resolution for this ecosystem: only direct dependencies were checked.',
    );
  }
  if (opts.includeDev === false) packages = packages.filter((p) => !p.dev);
  opts.packagesOut?.push(...packages);

  const ids = await queryBatch(packages.map((p) => ({ ecosystem: eco, name: p.name, version: p.version })));
  // Packagist also publishes FriendsOfPHP advisories that OSV does not carry.
  const extra = eco === 'composer' ? await packagistAuditExtras(packages, ids).catch(() => undefined) : undefined;
  if (eco === 'composer' && !extra) notes.push("Packagist's advisories API did not answer: only OSV advisories were checked.");
  extra?.ids.forEach((more, i) => ids[i].push(...more));
  const allIds = [...new Set(ids.flat())].filter((id) => !extra?.details.has(id));
  if (allIds.length > MAX_VULN_DETAILS) notes.push(`${allIds.length} advisories found; details fetched for the first ${MAX_VULN_DETAILS}.`);
  const details = new Map(
    (await pool(allIds.slice(0, MAX_VULN_DETAILS), 8, async (id) => [id, await getVuln(id).catch(() => undefined)] as const)),
  );
  for (const [id, v] of extra?.details ?? []) details.set(id, v);

  const findings: TreeFinding[] = [];
  packages.forEach((p, i) => {
    if (!ids[i].length) return;
    const advisories = dedupeAdvisories(
      ids[i].map((id) => {
        const v = details.get(id);
        return {
          id,
          aliases: v?.aliases ?? [],
          title: v?.summary,
          severity: v ? severityOf(v) : undefined,
          cvss3Score: v ? cvss3Of(v) : undefined,
          fixedIn: v ? fixedVersions(v, p.name) : undefined,
          url: `https://osv.dev/vulnerability/${id}`,
        };
      }),
    );
    const sev = advisories
      .map((a) => a.severity?.toUpperCase())
      .filter((s): s is string => Boolean(s))
      .sort((a, b) => SEV_ORDER.indexOf(a) - SEV_ORDER.indexOf(b))[0];
    findings.push({
      name: p.name,
      version: p.version,
      direct: p.direct,
      dev: p.dev,
      path: p.path,
      malicious: advisories.some((a) => isMalware(a.id)),
      severity: sev === 'MEDIUM' ? 'MODERATE' : sev,
      fixedVersion: fixFor(p.version, advisories),
      advisories,
    });
  });

  const rank = (f: TreeFinding) => (f.malicious ? -1 : f.severity ? SEV_ORDER.indexOf(f.severity) : 9);
  findings.sort((a, b) => rank(a) - rank(b) || b.advisories.length - a.advisories.length);

  const remediation = await remediate(eco, packages, findings, notes);

  const bySeverity = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
  let alerts = 0;
  for (const f of findings) {
    for (const a of f.advisories) {
      alerts++;
      const s = (a.severity ?? '').toUpperCase();
      if (s === 'CRITICAL') bySeverity.critical++;
      else if (s === 'HIGH') bySeverity.high++;
      else if (s === 'MODERATE' || s === 'MEDIUM') bySeverity.moderate++;
      else if (s === 'LOW') bySeverity.low++;
      else bySeverity.unknown++;
    }
  }
  return {
    ecosystem: eco,
    file: tree.file,
    source: tree.kind === 'lockfile' ? 'lockfile' : eco === 'composer' ? 'manifest resolved from Packagist metadata' : 'manifest resolved by deps.dev',
    packages: packages.length,
    vulnerablePackages: findings.length,
    alerts,
    bySeverity,
    malicious: findings.filter((f) => f.malicious).length,
    findings,
    remediation,
    notes,
    checkedAt: new Date().toISOString(),
  };
}

async function remediate(eco: Ecosystem, packages: TreePackage[], findings: TreeFinding[], notes: string[]): Promise<Remediation[]> {
  const out: Remediation[] = [];
  const versionOf = new Map(packages.filter((p) => p.direct).map((p) => [p.name, p.version]));

  // Direct findings: upgrade on the release line, or across it if there is no other way.
  for (const f of findings.filter((x) => x.direct)) {
    const r = await assessPackage(eco, f.name, f.version).catch(() => undefined);
    const to = (r && recommendedUpgrade(r)) ?? f.fixedVersion;
    if (!to) continue;
    out.push({
      target: f.name,
      from: f.version,
      to,
      kind: 'upgrade-direct',
      command: installCommand(eco, f.name, to),
      clears: [`${f.name}@${f.version}`],
      crossesMajor: !r?.safeVersionSameLine && Boolean(r?.safeVersion),
    });
  }

  // Transitive findings, grouped by the direct dependency that pulls them in.
  const byParent = new Map<string, TreeFinding[]>();
  const orphans: TreeFinding[] = [];
  for (const f of findings.filter((x) => !x.direct)) {
    const parent = f.path && f.path.length > 1 ? f.path[0] : undefined;
    if (parent && versionOf.has(parent)) byParent.set(parent, [...(byParent.get(parent) ?? []), f]);
    else orphans.push(f);
  }
  let checked = 0;
  for (const [parent, list] of byParent) {
    let left = list;
    if (GRAPH_ECOSYSTEMS.includes(eco) && checked < MAX_PARENTS) {
      checked++;
      const current = versionOf.get(parent) as string;
      const r = await assessPackage(eco, parent, current).catch(() => undefined);
      const candidates = [...new Set([r?.safeVersionSameLine, r?.safeVersionNearestLine, r?.safeVersion].filter((v): v is string => Boolean(v) && v !== current))];
      let best: { to: string; cleared: TreeFinding[] } | undefined;
      for (const cand of candidates) {
        const graph = await getDependencies(eco, parent, cand).catch(() => undefined);
        if (!graph?.nodes?.length) continue;
        const key = (n: string) => (eco === 'pypi' ? normalizePypiName(n) : n);
        const pulled = graph.nodes.filter((n) => list.some((f) => f.name === key(n.versionKey.name)));
        const still = await queryBatch(pulled.map((n) => ({ ecosystem: eco, name: n.versionKey.name, version: n.versionKey.version })));
        const dirty = new Set(pulled.filter((_, i) => still[i].length).map((n) => key(n.versionKey.name)));
        const cleared = list.filter((f) => !dirty.has(f.name));
        if (cleared.length && (!best || cleared.length > best.cleared.length)) best = { to: cand, cleared };
        if (cleared.length === list.length) break;
      }
      if (best) {
        const direct = out.find((x) => x.target === parent && x.kind === 'upgrade-direct');
        const clears = best.cleared.map((f) => `${f.name}@${f.version}`);
        if (direct && direct.to === best.to) direct.clears.push(...clears);
        else {
          out.push({
            target: parent,
            from: current,
            to: best.to,
            kind: 'upgrade-parent',
            command: installCommand(eco, parent, best.to),
            clears,
            crossesMajor: best.to !== r?.safeVersionSameLine,
          });
        }
        left = list.filter((f) => !best.cleared.includes(f));
      }
    }
    orphans.push(...left);
  }
  if (byParent.size > MAX_PARENTS) notes.push(`Parent upgrades were verified for the first ${MAX_PARENTS} direct dependencies only.`);

  const seen = new Set<string>();
  for (const f of orphans) {
    if (!f.fixedVersion || seen.has(f.name)) continue;
    seen.add(f.name);
    out.push({
      target: f.name,
      from: f.version,
      to: f.fixedVersion,
      kind: 'override',
      command: overrideHint(eco, f.name, f.fixedVersion),
      clears: findings.filter((x) => x.name === f.name).map((x) => `${x.name}@${x.version}`),
    });
  }
  return out;
}

export function formatTreeAudit(a: TreeAudit, maxFindings = 15): string {
  const lines: string[] = [];
  const sev = a.bySeverity;
  if (!a.findings.length) {
    lines.push(`Tree check: ${a.packages} packages in ${a.file} (${a.ecosystem}, ${a.source}), no known advisories.`);
  } else {
    lines.push(
      `${a.malicious ? 'SECURITY NOTICE: MALWARE in the tree. ' : 'SECURITY NOTICE: '}` +
        `${a.vulnerablePackages} of ${a.packages} packages in ${a.file} have known advisories ` +
        `(${a.alerts} alerts: ${sev.critical} critical, ${sev.high} high, ${sev.moderate} moderate, ${sev.low} low, ${sev.unknown} unrated).`,
    );
    for (const f of a.findings.slice(0, maxFindings)) {
      const where = f.direct ? 'direct' : f.path ? `via ${f.path.join(' > ')}` : 'transitive';
      const top = f.advisories[0];
      const cve = top.aliases.find((x) => x.startsWith('CVE-'));
      lines.push(
        `  - ${f.malicious ? 'MALWARE ' : ''}${f.name}@${f.version} [${f.severity ?? 'unrated'}] ${where}: ` +
          `${top.id}${cve ? ` (${cve})` : ''} ${top.title ?? ''}` +
          `${f.advisories.length > 1 ? ` +${f.advisories.length - 1} more` : ''}${f.fixedVersion ? `; fixed in ${f.fixedVersion}` : '; no fix released'}`,
      );
    }
    if (a.findings.length > maxFindings) lines.push(`  - ... and ${a.findings.length - maxFindings} more packages`);
  }
  if (a.remediation.length) {
    lines.push('Fixes:');
    for (const r of a.remediation) {
      const what =
        r.kind === 'override'
          ? `pin ${r.target} to ${r.to} or newer: ${r.command}`
          : `${r.command}${r.crossesMajor ? ' (new major: check the migration guide)' : ''}`;
      lines.push(`  - ${what}. Clears ${r.clears.join(', ')}.`);
    }
  }
  for (const n of a.notes) lines.push(`Note: ${n}`);
  lines.push(`Verified against osv.dev + ${a.ecosystem === 'composer' ? 'packagist.org' : 'deps.dev'} on ${a.checkedAt.slice(0, 10)}.`);
  return lines.join('\n');
}
