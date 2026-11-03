/**
 * check-packages: the verdict for a whole dependency list in one call. Agents
 * used to call check-package once per dependency; one compact table costs a
 * fraction of that, and the full notice is still there for every package that
 * is not plainly ok.
 *
 * The list is a project of its own: a version recommended for one package can be outside a range
 * another package in the same call sets on it (constraints.ts, as in the hook). With pip or Composer
 * those are the requirements in the other packages' resolved graphs; with npm, their peer ranges,
 * read only when the recommended version leaves the release line asked for.
 */
import { getDependencies, getPeerRequirements } from './advisories/depsdev.js';
import { pullsText } from './advisories/lineTree.js';
import { recommendedUpgrade, releaseLine } from './advisories/resolve.js';
import { type Ecosystem, parseEcosystem } from './ecosystems.js';
import { securityNotice } from './format.js';
import { pool } from './tree/audit.js';
import { checkFix, conflictText, type Constraint, type FixConflict, graphConstraints, rangeText, SINGLE_VERSION, violations } from './tree/constraints.js';
import { normalizePypiName } from './tree/lockfiles.js';
import { checkPackage, type Verdict } from './verdict.js';

export const MAX_BATCH = 50;
const CONCURRENCY = 8;
/** Packages per ecosystem whose graphs (pip, Composer) or peer ranges (npm) are read for the ranges they set on the others. */
const MAX_RANGE_PARENTS = 20;
/** Recommended versions per call that get the lookups for a release inside the ranges, as in the hook; past this, only the conflict is named. */
const MAX_FIX_CHECKS = 3;
/**
 * The whole batch answers within this, slow upstreams or not: packages still
 * pending are reported as "not checked", never dropped and never called ok.
 */
const BATCH_DEADLINE_MS = Number(process.env.PINRIGHT_BATCH_TIMEOUT_MS ?? 45_000);
const SEV_ORDER = ['CRITICAL', 'HIGH', 'MODERATE', 'MEDIUM', 'LOW'];

export interface BatchItem {
  name: string;
  ecosystem?: string;
  version?: string;
}

export interface BatchResult {
  ecosystem?: Ecosystem;
  name: string;
  version?: string;
  verdict?: Verdict;
  error?: string;
  /** What the other packages in the call say about this row's version (set only when one of their ranges excludes it). */
  ranges?: RowRanges;
}

export interface RowRanges {
  /** The version pinright would recommend breaks a range another package in the call sets. */
  conflict?: FixConflict;
  /** The version to pin instead: the clean release inside the ranges, or "-" when there is none. */
  use?: string;
  /** The version asked for is outside a range another package in the call sets (pip, Composer). */
  outside?: Constraint;
  /** The explanation, for the details. */
  text: string;
}

/** The version to pin: the requested one when clean, else the fix on its line, else the newest clean one. */
export function versionToUse(v: Verdict): string | undefined {
  const r = v.report;
  if (r.verdict === 'malicious' || r.verdict === 'possible-typosquat' || r.verdict === 'unknown') return undefined;
  const req = r.requested;
  if (req && req.verdict === 'ok') return req.version;
  if (req && req.verdict !== 'unknown-package' && recommendedUpgrade(r)) return recommendedUpgrade(r);
  return r.safeVersion ?? r.leastExposed?.version;
}

function worstSeverity(v: Verdict): string | undefined {
  const sevs = (v.report.requested?.advisories ?? []).map((a) => a.severity?.toUpperCase()).filter((s): s is string => Boolean(s));
  return SEV_ORDER.find((s) => sevs.includes(s));
}

function short(s: string | undefined, max = 90): string {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

export async function checkPackages(items: BatchItem[], defaultEcosystem?: string, deadlineMs = BATCH_DEADLINE_MS): Promise<BatchResult[]> {
  const seen = new Set<string>();
  const unique = items
    .map((i) => ({ name: i.name.trim(), version: i.version?.trim() || undefined, ecoRaw: i.ecosystem ?? defaultEcosystem }))
    .filter((i) => {
      const key = `${i.ecoRaw}:${i.name}@${i.version ?? ''}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const done: (BatchResult | undefined)[] = new Array(unique.length);
  const all = pool(unique.map((i, k) => ({ i, k })), CONCURRENCY, async ({ i, k }): Promise<void> => {
    const eco = parseEcosystem(i.ecoRaw ?? '');
    if (!eco) {
      done[k] = { name: i.name, version: i.version, error: `unknown ecosystem "${i.ecoRaw ?? ''}"` };
      return;
    }
    try {
      done[k] = { ecosystem: eco, name: i.name, version: i.version, verdict: await checkPackage(eco, i.name, i.version) };
    } catch (err) {
      done[k] = { ecosystem: eco, name: i.name, version: i.version, error: (err as Error).message };
    }
  });
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
    timer.unref();
  });
  const started = Date.now();
  await Promise.race([all, late]);
  clearTimeout(timer);
  const secs = deadlineMs < 10_000 ? (deadlineMs / 1000).toFixed(1) : String(Math.round(deadlineMs / 1000));
  const results = unique.map(
    (i, k) =>
      done[k] ?? {
        ecosystem: parseEcosystem(i.ecoRaw ?? ''),
        name: i.name,
        version: i.version,
        error: `not checked: the upstreams did not answer within ${secs} s`,
      },
  );
  // The ranges the packages set on each other, within what is left of the deadline. Late or failed: the table as it was.
  const left = deadlineMs - (Date.now() - started);
  if (left > 0 && results.filter((r) => r.verdict).length > 1) {
    let t2: NodeJS.Timeout | undefined;
    const ranges = await Promise.race([
      rangeNotes(results).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        t2 = setTimeout(() => resolve(undefined), left);
        t2.unref();
      }),
    ]);
    clearTimeout(t2);
    for (const [r, n] of ranges ?? []) r.ranges = n;
  }
  return results;
}

const key = (eco: Ecosystem, n: string) => (eco === 'pypi' ? normalizePypiName(n) : n);

/** The version a row will be pinned at: the one to use, else the one asked for. */
const pinnedAt = (r: BatchResult) => (r.verdict ? versionToUse(r.verdict) : undefined) ?? r.version;

/** Why that version is the one recommended, to open the explanation ("pillow 13.0.0 fixes the advisories of pillow 11.3.0"). */
function leadFor(r: BatchResult, use: string): string {
  const rep = (r.verdict as Verdict).report;
  const n = rep.requested?.advisories.length ?? 0;
  if (n && r.version) return `${r.name} ${use} fixes the advisor${n === 1 ? 'y' : 'ies'} of ${r.name} ${r.version}`;
  if (rep.verdict === 'deprecated') return `${r.name} ${use} is the newest maintained release`;
  if (use === rep.safeVersion) return `${r.name} ${use} is the newest release with no known advisories`;
  return `${r.name} ${use} is the least exposed release`;
}

/** "moviepy 2.2.1's pillow<12.0,>=9.2.0 (via stirrup 0.2.1)", for the table. */
const rangeShort = (eco: Ecosystem, name: string, c: Constraint) =>
  `${c.by} ${c.byVersion}'s ${c.peer ? 'peer range ' : ''}${rangeText(eco, name, c.requirement)}${c.via ? ` (via ${c.via} ${c.viaVersion})` : ''}`;

/**
 * For each row, the ranges the other packages in the call set on it, against the version the table would
 * recommend (and, with pip or Composer, the version asked for). Same rules and caps as the hook: graph
 * ranges where one version per name is installed, one cached graph per package in the call; npm peer
 * ranges only when the recommended version leaves the release line asked for; at most MAX_FIX_CHECKS
 * conflicts get the lookups for a release that fits. Rows without a conflict are left out.
 */
export async function rangeNotes(results: BatchResult[]): Promise<Map<BatchResult, RowRanges>> {
  const out = new Map<BatchResult, RowRanges>();
  let budget = MAX_FIX_CHECKS;
  const ecos = [...new Set(results.map((r) => r.ecosystem).filter((e): e is Ecosystem => Boolean(e)))];
  for (const eco of ecos) {
    const rows = results.filter((r) => r.ecosystem === eco && r.verdict);
    if (rows.length < 2) continue;
    // Packages that set ranges: ones that exist and are not malware or a typosquat, at the version they will be pinned at.
    const parents = rows
      .filter((r) => {
        const v = (r.verdict as Verdict).report.verdict;
        return pinnedAt(r) && v !== 'malicious' && v !== 'possible-typosquat' && !(v === 'unknown-package' && !r.verdict?.report.requested);
      })
      .slice(0, MAX_RANGE_PARENTS);
    const single = SINGLE_VERSION.includes(eco);
    const graphs = single ? await Promise.all(parents.map((p) => getDependencies(eco, p.name, pinnedAt(p) as string).catch(() => undefined))) : [];
    // npm peer ranges: one cached requirements lookup per package in the call, made once, and only if a row needs them.
    let peerMaps: Promise<(Map<string, string> | undefined)[]> | undefined;
    const rangesOn = async (r: BatchResult, to: string): Promise<Constraint[]> => {
      if (single) {
        // One per range: moviepy's cap seen in its own graph and again under stirrup is named once, as moviepy's (it is in the call).
        const seen = new Map<string, Constraint>();
        for (const c of parents.flatMap((p, k) => (key(eco, p.name) === key(eco, r.name) ? [] : graphConstraints(eco, graphs[k], r.name)))) {
          const id = `${key(eco, c.by)}@${c.byVersion}:${c.requirement}`;
          if (key(eco, c.by) !== key(eco, r.name) && (!seen.has(id) || !c.via)) seen.set(id, c);
        }
        return [...seen.values()];
      }
      // A peer range almost always names a major: only a recommendation that leaves the line asked for is looked at.
      if (eco === 'npm' && r.version && releaseLine(to) !== releaseLine(r.version)) {
        peerMaps ??= Promise.all(parents.map((p) => getPeerRequirements(eco, p.name, pinnedAt(p) as string).catch(() => undefined)));
        const maps = await peerMaps;
        return parents.flatMap((p, k) => {
          const req = p.name !== r.name ? maps[k]?.get(r.name) : undefined;
          return req ? [{ by: p.name, byVersion: pinnedAt(p) as string, requirement: req, peer: true }] : [];
        });
      }
      return [];
    };
    const checked = await Promise.all(
      rows.map(async (r) => {
        const use = versionToUse(r.verdict as Verdict);
        if (!use) return undefined;
        const cons = await rangesOn(r, use).catch(() => [] as Constraint[]);
        return cons.length ? { r, use, cons } : undefined;
      }),
    );
    for (const c of checked) {
      if (!c) continue;
      const { r, use, cons } = c;
      const bad = violations(eco, use, cons);
      if (!bad.length) continue;
      if (use === r.version) {
        // Asked for and clean, but another package in the call forbids it: a note, the version stays.
        const x = bad[0];
        out.set(r, {
          outside: x,
          text:
            `${r.name} ${use} is outside ${x.by} ${x.byVersion}'s requirement ${rangeText(eco, r.name, x.requirement)}` +
            `${x.via ? `, and ${x.via} ${x.viaVersion} pulls ${x.by} ${x.byVersion}. The install will likely fail unless the resolver finds a ${x.by} release that accepts ${r.name} ${use}` : `. The install will fail`}; ` +
            `pin ${r.name} inside that range or drop the pin.`,
        });
        continue;
      }
      const n = r.verdict?.report.requested?.advisories.length;
      const k = (budget-- > 0 ? await checkFix(eco, r.name, use, cons, n || undefined).catch(() => undefined) : undefined) ?? { name: r.name, fix: use, bad };
      out.set(r, { conflict: k, use: k.fit?.advisories === 0 ? k.fit.version : '-', text: conflictText(eco, k, leadFor(r, use)) });
    }
  }
  return out;
}

/** True when the line in the table says everything there is to say. */
function plainlyOk(r: BatchResult): boolean {
  const v = r.verdict;
  if (!v || v.report.verdict !== 'ok') return false;
  // A supply-chain signal worth a warning (new install scripts, publisher change...) needs its details shown.
  if (v.risk?.signals.some((s) => s.level !== 'info')) return false;
  if (v.report.cooldownOnly) return false;
  if (v.report.sameLineTree) return false;
  if (r.ranges) return false;
  const use = versionToUse(v);
  return !r.version || use === r.version;
}

function row(r: BatchResult): string {
  const pkg = `${r.ecosystem ?? '?'} ${r.name}`;
  const asked = r.version ?? '-';
  if (r.error || !r.verdict) return `| ${pkg} | ${asked} | ERROR, not checked | - | ${short(r.error)} |`;
  const v = r.verdict;
  const rep = v.report;
  const conflict = r.ranges?.conflict;
  const use = (conflict ? r.ranges?.use : undefined) ?? versionToUse(v) ?? '-';
  const notes: string[] = [];
  if (conflict && r.ecosystem) {
    // The other packages in the call forbid the version pinright would recommend: say so before anything else.
    const range = rangeShort(r.ecosystem, r.name, conflict.bad[0]);
    notes.push(use === '-' ? `${conflict.fix} is outside ${range} and no clean release fits it; see details` : `${conflict.fix} is outside ${range}; ${use} is the newest clean release in range`);
  } else if (r.ranges?.outside && r.ecosystem) {
    notes.push(`outside ${rangeShort(r.ecosystem, r.name, r.ranges.outside)}: the install will likely fail`);
  }
  let verdict: string = rep.verdict;
  const n = rep.requested?.advisories.length ?? 0;
  switch (rep.verdict) {
    case 'vulnerable':
      verdict = rep.requested ? `VULNERABLE (${n}${worstSeverity(v) ? `, ${worstSeverity(v)}` : ''})` : 'VULNERABLE (no clean version)';
      if (conflict) break;
      if (rep.requested && rep.safeVersionSameLine && use === rep.safeVersionSameLine) notes.push('fix on the same release line');
      else if (rep.requested && rep.safeVersionNearestLine && use === rep.safeVersionNearestLine) notes.push(`nearest fix on ${rep.nearestLine}: breaking changes`);
      else if (rep.requested && rep.crossLineRequired) notes.push('fix needs a new major: breaking changes');
      else if (!rep.safeVersion && rep.leastExposed) notes.push('no clean version; least exposed');
      break;
    case 'malicious':
      verdict = 'MALWARE';
      notes.push('do not install');
      break;
    case 'possible-typosquat':
      verdict = 'TYPOSQUAT?';
      notes.push(`looks like "${v.typo?.lookalikeOf}"; confirm the name`);
      break;
    case 'deprecated':
      verdict = 'DEPRECATED';
      notes.push(short(rep.requested?.deprecatedReason ?? rep.deprecatedReason, 60));
      break;
    case 'unknown-package':
      verdict = rep.requested && rep.latestVersion ? 'VERSION NOT PUBLISHED' : 'NOT FOUND';
      break;
    case 'unknown':
      verdict = 'UNVERIFIED';
      if (rep.requested?.notIndexed || rep.notIndexed) {
        // The long reason would be cut before its point: say it short.
        notes.push(`published on ${rep.requested?.notIndexed ?? rep.notIndexed}; deps.dev has no data for it yet`);
        if (rep.requested?.notIndexed) notes.push(rep.unavailable?.includes('osv.dev') ? 'advisories unknown' : 'osv.dev lists no advisories');
      } else {
        notes.push(short(rep.reason ?? 'a data source did not answer', 60));
      }
      break;
    case 'ok':
      if (rep.cooldownOnly) {
        verdict = 'TOO NEW';
        notes.push('every release is inside the cooldown; none recommended yet');
      }
      if (rep.safeVersionLicenses?.length && use === rep.safeVersion) notes.push(rep.safeVersionLicenses.join('/'));
      break;
  }
  // Advisories from osv.dev alone (malware, a known CVE) on a version deps.dev has not indexed: the rest is still unknown.
  if (rep.requested?.notIndexed && rep.verdict !== 'unknown') notes.push(`published on ${rep.requested.notIndexed}; deps.dev has no data for it yet`);
  const tree = rep.sameLineTree;
  if (tree && use === tree.version) notes.push(`its tree still pulls ${pullsText(tree.pulls, 2)}; ${tree.cleaner} (${tree.cleanerLine}) pulls fixed versions`);
  const risky = v.risk?.signals.filter((s) => s.level !== 'info') ?? [];
  if (risky.length) notes.push(`supply-chain: ${risky.map((s) => s.id).join(', ')}`);
  if (rep.recentMajor && use !== '-' && use.startsWith(rep.recentMajor.line.replace(/x$/, ''))) {
    notes.push(`${rep.recentMajor.line} is a recent major (since ${rep.recentMajor.since}): read get-docs`);
  }
  return `| ${pkg} | ${asked} | ${verdict} | ${use} | ${notes.filter(Boolean).join('; ')} |`;
}

export function formatBatch(results: BatchResult[]): string {
  const checked = results.filter((r) => r.verdict);
  const attention = results.filter((r) => !plainlyOk(r));
  const sources = [...new Set(checked.flatMap((r) => r.verdict!.report.sources))].join(' + ');
  const date = checked.map((r) => r.verdict!.report.checkedAt.slice(0, 10)).sort()[0];
  const lines = [
    `${results.length} package${results.length === 1 ? '' : 's'} checked, ${attention.length} need${attention.length === 1 ? 's' : ''} attention. ` +
      `Pin the "use" version.${sources ? ` Verified against ${sources} on ${date}.` : ''}`,
    '| package | asked | verdict | use | notes |',
    '|---|---|---|---|---|',
    ...results.map(row),
  ];
  const details = attention.filter((r) => r.verdict);
  if (details.length) {
    lines.push('', 'Details for the packages that need attention:');
    for (const r of details) {
      // The header already carries the sources and the date.
      // A conflict: the notice recommends only the release inside the ranges, never the upgrade the NOTE says would not install.
      const rangeConflict = r.ranges?.conflict ? { use: r.ranges.use && r.ranges.use !== '-' ? r.ranges.use : undefined } : undefined;
      const notice = securityNotice(r.verdict!.report, r.verdict!.typo, r.verdict!.risk, { rangeConflict }).split('\n').filter((l) => !l.startsWith('Verified against '));
      // A range another package in the call sets: right under the headline, before the upgrade the notice suggests on its own.
      if (r.ranges) notice.splice(1, 0, `NOTE (packages in this call): ${r.ranges.text}`);
      lines.push('', ...notice);
    }
  }
  if (results.some((r) => r.error)) lines.push('', 'ERROR rows were not checked: treat them as unverified and retry, or call check-package for each.');
  return lines.join('\n');
}
