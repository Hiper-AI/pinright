/**
 * check-packages: the verdict for a whole dependency list in one call. Agents
 * used to call check-package once per dependency; one compact table costs a
 * fraction of that, and the full notice is still there for every package that
 * is not plainly ok.
 */
import { recommendedUpgrade } from './advisories/resolve.js';
import { type Ecosystem, parseEcosystem } from './ecosystems.js';
import { securityNotice } from './format.js';
import { pool } from './tree/audit.js';
import { checkPackage, type Verdict } from './verdict.js';

export const MAX_BATCH = 50;
const CONCURRENCY = 4;
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

export async function checkPackages(items: BatchItem[], defaultEcosystem?: string): Promise<BatchResult[]> {
  const seen = new Set<string>();
  const unique = items
    .map((i) => ({ name: i.name.trim(), version: i.version?.trim() || undefined, ecoRaw: i.ecosystem ?? defaultEcosystem }))
    .filter((i) => {
      const key = `${i.ecoRaw}:${i.name}@${i.version ?? ''}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return pool(unique, CONCURRENCY, async (i): Promise<BatchResult> => {
    const eco = parseEcosystem(i.ecoRaw ?? '');
    if (!eco) return { name: i.name, version: i.version, error: `unknown ecosystem "${i.ecoRaw ?? ''}"` };
    try {
      return { ecosystem: eco, name: i.name, version: i.version, verdict: await checkPackage(eco, i.name, i.version) };
    } catch (err) {
      return { ecosystem: eco, name: i.name, version: i.version, error: (err as Error).message };
    }
  });
}

/** True when the line in the table says everything there is to say. */
function plainlyOk(r: BatchResult): boolean {
  const v = r.verdict;
  if (!v || v.report.verdict !== 'ok') return false;
  // A supply-chain signal worth a warning (new install scripts, publisher change...) needs its details shown.
  if (v.risk?.signals.some((s) => s.level !== 'info')) return false;
  if (v.report.cooldownOnly) return false;
  const use = versionToUse(v);
  return !r.version || use === r.version;
}

function row(r: BatchResult): string {
  const pkg = `${r.ecosystem ?? '?'} ${r.name}`;
  const asked = r.version ?? '-';
  if (r.error || !r.verdict) return `| ${pkg} | ${asked} | ERROR, not checked | - | ${short(r.error)} |`;
  const v = r.verdict;
  const rep = v.report;
  const use = versionToUse(v) ?? '-';
  const notes: string[] = [];
  let verdict: string = rep.verdict;
  const n = rep.requested?.advisories.length ?? 0;
  switch (rep.verdict) {
    case 'vulnerable':
      verdict = rep.requested ? `VULNERABLE (${n}${worstSeverity(v) ? `, ${worstSeverity(v)}` : ''})` : 'VULNERABLE (no clean version)';
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
      notes.push(short(rep.requested?.deprecatedReason, 60));
      break;
    case 'unknown-package':
      verdict = rep.requested && rep.latestVersion ? 'VERSION NOT PUBLISHED' : 'NOT FOUND';
      break;
    case 'unknown':
      verdict = 'UNVERIFIED';
      notes.push(short(rep.reason ?? 'a data source did not answer', 60));
      break;
    case 'ok':
      if (rep.cooldownOnly) {
        verdict = 'TOO NEW';
        notes.push('every release is inside the cooldown; none recommended yet');
      }
      if (rep.safeVersionLicenses?.length && use === rep.safeVersion) notes.push(rep.safeVersionLicenses.join('/'));
      break;
  }
  const risky = v.risk?.signals.filter((s) => s.level !== 'info') ?? [];
  if (risky.length) notes.push(`supply-chain: ${risky.map((s) => s.id).join(', ')}`);
  if (rep.recentMajor && use !== '-' && use.startsWith(rep.recentMajor.line.replace(/x$/, ''))) {
    notes.push(`${rep.recentMajor.line} is a recent major (since ${rep.recentMajor.since}): read query-docs`);
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
      const notice = securityNotice(r.verdict!.report, r.verdict!.typo, r.verdict!.risk).split('\n').filter((l) => !l.startsWith('Verified against '));
      lines.push('', ...notice);
    }
  }
  if (results.some((r) => r.error)) lines.push('', 'ERROR rows were not checked: treat them as unverified and retry, or call check-package for each.');
  return lines.join('\n');
}
