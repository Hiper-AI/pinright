/**
 * The GitHub Actions check, for the hook and for audits:
 *   (a) OSV "GitHub Actions" advisories for the version behind the ref, e.g.
 *       the compromised tj-actions/changed-files (GHSA-mrrh-fwg8-r2c3); the fix
 *       is the fixed release, pinned to its commit SHA;
 *   (b) a ref that is not a full commit SHA can be moved under you (tags were
 *       re-pointed in that attack): recommend the SHA of the same tag, with the
 *       version as a comment. Warn by default; PINRIGHT_ACTIONS_PIN=enforce denies.
 *
 * OSV cannot compare versions for this ecosystem, so we ask for every advisory
 * of the action and evaluate the ranges here. A ref whose version we cannot
 * tell (a branch, an untagged SHA) is never reported clean when advisories exist.
 */
import semver from 'semver';
import { cached } from '../cache.js';
import { config } from '../config.js';
import { GitHubRateLimitError, githubAuthConfigured } from '../github.js';
import { getJson } from '../http.js';
import { dedupeAdvisories, type AdvisoryInfo } from '../advisories/resolve.js';
import { fixedVersions, severityOf, titleOf, type OsvVuln } from '../advisories/osv.js';
import { cvss3Of } from '../advisories/cvss.js';
import { type HookDecision, unverified } from '../hook/policy.js';
import { latestRelease, resolveRef, specificTag, tagForSha } from './github.js';
import { actionName, useKey, type ActionUse } from './workflow.js';
import { cleanText } from '../untrusted/index.js';

const OSV_ECOSYSTEM = 'GitHub Actions';
const MAX_CHECKS = 25;

/** Every OSV advisory for an action, any version (OSV cannot filter versions for this ecosystem). */
export async function actionAdvisories(name: string): Promise<OsvVuln[]> {
  return cached(`osv:gha:${name.toLowerCase()}`, config.ttl.advisories, async () => {
    const out: OsvVuln[] = [];
    let token: string | undefined;
    for (let page = 0; page < 10; page++) {
      const body = { package: { name, ecosystem: OSV_ECOSYSTEM }, ...(token ? { page_token: token } : {}) };
      const res = await getJson<{ vulns?: OsvVuln[]; next_page_token?: string }>(`${config.osvBaseUrl}/v1/query`, { method: 'POST', body });
      out.push(...(res.vulns ?? []));
      token = res.next_page_token;
      if (!token) break;
    }
    return out;
  });
}

function coerce(v: string): semver.SemVer | undefined {
  return semver.coerce(v.replace(/^v/i, ''), { includePrerelease: false }) ?? undefined;
}

/** True when GitHub's "last known affected" bound ("< 3.0.0", "<= 2.4.1") excludes `v`. */
function aboveLastKnown(aff: NonNullable<OsvVuln['affected']>[number], v: semver.SemVer): boolean {
  const bound = (aff as { database_specific?: { last_known_affected_version_range?: unknown } }).database_specific?.last_known_affected_version_range;
  const m = typeof bound === 'string' ? bound.trim().match(/^(<=?)\s*v?(\S+)$/) : null;
  const at = m ? coerce(m[2]) : undefined;
  if (!m || !at) return false;
  const c = semver.compare(v, at);
  return m[1] === '<' ? c >= 0 : c > 0;
}

/** Does this advisory cover `version` of `name`? Explicit version lists first, then ECOSYSTEM/SEMVER ranges. */
export function affects(vuln: OsvVuln, name: string, version: string): boolean {
  const v = coerce(version);
  if (!v) return false;
  const plain = version.replace(/^v/i, '');
  for (const aff of vuln.affected ?? []) {
    if (aff.package && (aff.package.ecosystem !== OSV_ECOSYSTEM || aff.package.name.toLowerCase() !== name.toLowerCase())) continue;
    if ((aff.versions ?? []).some((x) => x.replace(/^v/i, '') === plain)) return true;
    for (const range of aff.ranges ?? []) {
      if (range.type === 'GIT') continue;
      const events = range.events
        .map((e) => {
          const [kind, raw] = Object.entries(e)[0] as [string, string];
          return { kind, at: raw === '0' ? new semver.SemVer('0.0.0') : coerce(raw) };
        })
        .filter((e): e is { kind: string; at: semver.SemVer } => Boolean(e.at))
        .sort((a, b) => semver.compare(a.at, b.at));
      let hit = false;
      for (const e of events) {
        const c = semver.compare(v, e.at);
        if (e.kind === 'introduced' && c >= 0) hit = true;
        else if (e.kind === 'fixed' && c >= 0) hit = false;
        else if (e.kind === 'last_affected' && c > 0) hit = false;
      }
      // An open range ("introduced: 2.26.11", no fix on that line) is bounded by GitHub's
      // last_known_affected_version_range ("< 3.0.0"); without it every later major would match.
      if (hit && !events.some((e) => e.kind !== 'introduced') && aboveLastKnown(aff, v)) hit = false;
      if (hit) return true;
    }
  }
  return false;
}

export interface ActionReport {
  use: ActionUse;
  name: string;
  pinned: boolean;
  sha?: string;
  /** The release behind the ref ("v4.2.1" for "v4"), when it could be told. */
  version?: string;
  /** False when the tag, branch or commit does not exist in the repo. */
  exists: boolean;
  advisories: AdvisoryInfo[];
  /** Lowest release that fixes every advisory listed. */
  fixedIn?: string;
  /** Where to move: "owner/repo@<sha> # v46.0.1". */
  upgradeTo?: string;
  /** For a mutable ref with no advisory: the same release pinned to its commit. */
  pinTo?: string;
  /** Why the check is incomplete (source down, version unknown). Never reported as clean. */
  unverified?: string;
  /**
   * The advisory check itself is incomplete: OSV did not answer, or advisories exist for the
   * action and the release behind the ref could not be told. An audit fails on these; a
   * GitHub hiccup for an action OSV has nothing on does not set it.
   */
  advisoriesUnknown?: boolean;
  checkedAt: string;
}

const isSha = (ref: string) => /^[0-9a-f]{40}$/i.test(ref);
const semverish = (ref: string) => /^v?\d+(\.\d+){0,2}$/.test(ref);
const vcmp = (a: string, b: string) => {
  const x = coerce(a);
  const y = coerce(b);
  return x && y ? semver.compare(x, y) : a.localeCompare(b, undefined, { numeric: true });
};

function fixFor(version: string, list: { fixedIn?: string[] }[]): string | undefined {
  let need: string | undefined;
  for (const a of list) {
    const above = (a.fixedIn ?? []).filter((f) => vcmp(f, version) > 0).sort(vcmp);
    if (!above.length) return undefined;
    if (!need || vcmp(above[0], need) > 0) need = above[0];
  }
  return need;
}

async function pinned(use: ActionUse, tag: string): Promise<string | undefined> {
  const sha = await resolveRef(use.owner, use.repo, tag).catch(() => undefined);
  return sha ? `${actionName(use)}${use.path ? `/${use.path}` : ''}@${sha} # ${tag}` : undefined;
}

export async function checkAction(use: ActionUse): Promise<ActionReport> {
  const name = actionName(use);
  const report: ActionReport = { use, name, pinned: isSha(use.ref), exists: true, advisories: [], checkedAt: new Date().toISOString() };

  let vulns: OsvVuln[] | undefined;
  try {
    vulns = await actionAdvisories(name);
  } catch (err) {
    report.unverified = `osv.dev did not answer (${(err as Error).message})`;
    report.advisoriesUnknown = true;
  }

  try {
    report.sha = report.pinned ? use.ref.toLowerCase() : await resolveRef(use.owner, use.repo, use.ref);
    if (!report.sha) {
      report.exists = false;
      return report;
    }
    if (report.pinned) {
      // Trust the "# v1.2.3" comment only when that tag really points at this commit.
      const viaComment = use.comment ? await resolveRef(use.owner, use.repo, use.comment).catch(() => undefined) : undefined;
      report.version = viaComment === report.sha ? use.comment : await tagForSha(use.owner, use.repo, report.sha);
    } else if (semverish(use.ref)) {
      report.version = (await specificTag(use.owner, use.repo, use.ref, report.sha)) ?? use.ref;
    }
  } catch (err) {
    report.unverified ??= err instanceof GitHubRateLimitError ? err.message : `GitHub did not answer (${(err as Error).message})`;
  }

  if (vulns?.length) {
    if (report.version && coerce(report.version)) {
      const hits = vulns.filter((v) => affects(v, name, report.version as string));
      report.advisories = dedupeAdvisories(
        hits.map((v) => ({
          id: v.id,
          aliases: v.aliases ?? [],
          title: cleanText(titleOf(v)),
          severity: severityOf(v),
          cvss3Score: cvss3Of(v),
          fixedIn: fixedVersions(v, name),
          url: `https://osv.dev/vulnerability/${v.id}`,
        })),
      );
    } else {
      report.unverified ??= `${vulns.length} advisor${vulns.length === 1 ? 'y exists' : 'ies exist'} for ${name} and the release behind "${use.ref}" could not be told`;
      report.advisoriesUnknown = true;
    }
  }

  if (report.advisories.length) {
    report.fixedIn = fixFor(report.version as string, report.advisories);
    const latest = await latestRelease(use.owner, use.repo).catch(() => undefined);
    const latestClean = latest && coerce(latest) && !vulns?.some((v) => affects(v, name, latest)) && (!report.fixedIn || vcmp(latest, report.fixedIn) >= 0);
    const candidates = latestClean ? [latest as string] : report.fixedIn ? [`v${report.fixedIn}`, report.fixedIn] : [];
    for (const tag of candidates) {
      report.upgradeTo = await pinned(use, tag);
      if (report.upgradeTo) break;
    }
  } else if (!report.pinned && report.sha) {
    report.pinTo = `${actionName(use)}${use.path ? `/${use.path}` : ''}@${report.sha} # ${report.version ?? use.ref}`;
  }
  return report;
}

function allowed(name: string): boolean {
  const list = (process.env.PINRIGHT_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : p === name));
}

type Action = HookDecision['action'];

/** PINRIGHT_HOOK_ON_ERROR when the caller has no resolved team policy. */
function envOnError(): Action {
  const v = process.env.PINRIGHT_HOOK_ON_ERROR;
  return v === 'deny' || v === 'ask' ? v : 'allow';
}

const advisoryList = (r: ActionReport) => {
  const ids = r.advisories.slice(0, 3).map((a) => a.id).join(', ');
  const sev = r.advisories.find((a) => a.severity)?.severity;
  return `${r.advisories.length} known advisor${r.advisories.length === 1 ? 'y' : 'ies'} (${ids}${sev ? `, ${sev}` : ''})`;
};

const limited = (unverified: string) => unverified.startsWith('GitHub API rate limit');
const TOKEN_HINT =
  'GitHub rate limit: without a token GitHub allows 60 API requests an hour. Set GITHUB_TOKEN (or PINRIGHT_GH_CLI=1 to use the GitHub CLI login) and re-run to verify the rest.';

/** The hook's decision for new or changed `uses:` lines. `onError` is the team policy's (see teamConfig.ts). */
export async function decideActions(uses: ActionUse[], onError: Action = envOnError()): Promise<HookDecision> {
  const unique = [...new Map(uses.map((u) => [useKey(u), u])).values()].filter((u) => !allowed(actionName(u)));
  const list = unique.slice(0, MAX_CHECKS);
  const reports = await Promise.all(list.map((u) => checkAction(u)));
  const outcomes: { action: Action; problem?: string; warning?: string }[] = [];
  const enforcePin = process.env.PINRIGHT_ACTIONS_PIN === 'enforce';
  for (const r of reports) {
    const label = `uses: ${useKey(r.use)}${r.version && r.version !== r.use.ref ? ` (${r.version})` : ''}`;
    if (!r.exists) {
      outcomes.push({ action: 'deny', problem: `${label}: no such tag, branch or commit in ${r.name}. Check the action name and ref.` });
      continue;
    }
    if (r.advisories.length) {
      outcomes.push(
        r.upgradeTo
          ? { action: 'deny', problem: `${label} has ${advisoryList(r)}. Use: uses: ${r.upgradeTo}` }
          : { action: 'ask', problem: `${label} has ${advisoryList(r)} and no fixed release was found; a human should decide.` },
      );
      continue;
    }
    if (r.unverified) outcomes.push(unverified({ onError }, `${label}: could not be verified (${r.unverified}).`));
    if (!r.pinned) {
      const msg = `${label} is a mutable ref; a tag can be re-pointed to other code. Pin the commit: ${r.pinTo ? `uses: ${r.pinTo}` : 'uses: owner/repo@<40-char SHA> # tag'}`;
      outcomes.push(enforcePin ? { action: 'deny', problem: msg } : { action: 'allow', warning: msg });
    }
  }
  const problems = outcomes.map((o) => o.problem).filter((p): p is string => Boolean(p));
  const warnings = outcomes.map((o) => o.warning).filter((w): w is string => Boolean(w));
  if (unique.length > MAX_CHECKS) warnings.push(`Only the first ${MAX_CHECKS} of ${unique.length} actions were checked.`);
  if (reports.some((r) => r.unverified && limited(r.unverified)) && !githubAuthConfigured()) warnings.push(TOKEN_HINT);
  const action: Action = outcomes.some((o) => o.action === 'deny') ? 'deny' : outcomes.some((o) => o.action === 'ask') ? 'ask' : 'allow';
  return { action, problems, warnings, checked: list.length };
}

// ------------------------------------------------------------- audit -------

export interface ActionsAudit {
  files: string[];
  actions: number;
  vulnerable: number;
  unpinned: number;
  unverified: number;
  /** Actions whose advisories could not be checked (see ActionReport.advisoriesUnknown): they fail the audit. */
  advisoriesUnknown: number;
  missing: number;
  bySeverity: Record<'critical' | 'high' | 'moderate' | 'low' | 'unknown', number>;
  malicious: number;
  findings: (ActionReport & { locations: string[] })[];
  notes: string[];
  checkedAt: string;
}

export async function auditActions(files: { file: string; uses: ActionUse[] }[]): Promise<ActionsAudit> {
  const byKey = new Map<string, { use: ActionUse; locations: string[] }>();
  for (const f of files) {
    for (const u of f.uses) {
      const k = useKey(u);
      const e = byKey.get(k) ?? { use: u, locations: [] };
      e.locations.push(`${f.file}:${u.line}`);
      byKey.set(k, e);
    }
  }
  const entries = [...byKey.values()];
  const findings: ActionsAudit['findings'] = [];
  // A few at a time: unauthenticated GitHub allows 60 requests an hour.
  for (let i = 0; i < entries.length; i += 4) {
    const batch = await Promise.all(entries.slice(i, i + 4).map(async (e) => ({ ...(await checkAction(e.use)), locations: e.locations })));
    findings.push(...batch);
  }
  const bySeverity = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
  for (const f of findings) {
    for (const a of f.advisories) {
      const s = (a.severity ?? '').toUpperCase();
      if (s === 'CRITICAL') bySeverity.critical++;
      else if (s === 'HIGH') bySeverity.high++;
      else if (s === 'MODERATE' || s === 'MEDIUM') bySeverity.moderate++;
      else if (s === 'LOW') bySeverity.low++;
      else bySeverity.unknown++;
    }
  }
  const rank = (f: ActionReport) => (f.advisories.length ? 0 : !f.exists ? 1 : f.unverified ? 2 : !f.pinned ? 3 : 4);
  findings.sort((a, b) => rank(a) - rank(b));
  const notes: string[] = [];
  if (findings.some((f) => f.unverified && limited(f.unverified)) && !githubAuthConfigured()) notes.push(TOKEN_HINT);
  return {
    files: files.map((f) => f.file),
    actions: findings.length,
    vulnerable: findings.filter((f) => f.advisories.length).length,
    unpinned: findings.filter((f) => !f.pinned).length,
    unverified: findings.filter((f) => f.unverified && !f.advisories.length).length,
    advisoriesUnknown: findings.filter((f) => f.advisoriesUnknown && !f.advisories.length).length,
    missing: findings.filter((f) => !f.exists).length,
    bySeverity,
    malicious: 0,
    findings,
    notes,
    checkedAt: new Date().toISOString(),
  };
}

export function formatActionsAudit(a: ActionsAudit, maxFindings = 50): string {
  const lines: string[] = [];
  const where = a.files.length === 1 ? a.files[0] : `${a.files.length} workflow files`;
  const s = a.bySeverity;
  lines.push(
    a.vulnerable
      ? `SECURITY NOTICE: ${a.vulnerable} of ${a.actions} GitHub Actions in ${where} have known advisories ` +
          `(${s.critical} critical, ${s.high} high, ${s.moderate} moderate, ${s.low} low, ${s.unknown} unrated); ${a.unpinned} not pinned to a commit SHA.`
      : `Actions check: ${a.actions} GitHub Actions in ${where}, no known advisories${a.unverified ? ` (${a.unverified} unverified)` : ''}; ${a.unpinned} not pinned to a commit SHA.`,
  );
  for (const f of a.findings.slice(0, maxFindings)) {
    const at = f.locations[0] + (f.locations.length > 1 ? ` +${f.locations.length - 1}` : '');
    const ver = f.version && f.version !== f.use.ref ? ` (${f.version})` : '';
    if (f.advisories.length) {
      const top = f.advisories[0];
      lines.push(
        `  - ${useKey(f.use)}${ver} [${top.severity ?? 'unrated'}] ${at}: ${top.id} ${top.title ?? ''}` +
          `${f.advisories.length > 1 ? ` +${f.advisories.length - 1} more` : ''}` +
          `${f.fixedIn ? `; fixed in ${f.fixedIn}` : '; no fix released'}${f.upgradeTo ? `. Use: uses: ${f.upgradeTo}` : ''}`,
      );
    } else if (!f.exists) {
      lines.push(`  - ${useKey(f.use)} ${at}: no such tag, branch or commit in ${f.name}.`);
    } else if (f.unverified) {
      lines.push(`  - ${useKey(f.use)}${ver} ${at}: unverified, ${f.unverified}.`);
    } else if (!f.pinned) {
      lines.push(`  - ${useKey(f.use)}${ver} ${at}: mutable ref. Pin: uses: ${f.pinTo}`);
    }
  }
  if (a.findings.length > maxFindings) lines.push(`  - ... and ${a.findings.length - maxFindings} more`);
  for (const n of a.notes) lines.push(`Note: ${n}`);
  lines.push(`Verified against osv.dev (GitHub Actions) + GitHub (git refs, REST API) on ${a.checkedAt.slice(0, 10)}.`);
  return lines.join('\n');
}

/**
 * For the CLI exit code: findings at or above the floor, refs that do not exist, actions whose
 * advisories could not be checked (never a pass without verifying); unpinned refs only when
 * pinning is enforced.
 */
export function actionsAuditFails(a: ActionsAudit, floor: number, levels: string[]): boolean {
  const s = a.bySeverity as Record<string, number>;
  if (levels.slice(floor).some((l) => s[l] > 0) || (floor === 0 && s.unknown > 0)) return true;
  if (a.missing || a.advisoriesUnknown) return true;
  return process.env.PINRIGHT_ACTIONS_PIN === 'enforce' && a.unpinned > 0;
}
