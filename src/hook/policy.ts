/**
 * The hook's decision. A hook runs whether or not the agent called the MCP
 * tools, so this is the enforcement layer; the MCP server is the explaining one.
 *
 *   deny : malware, typosquat lookalike, package or version that does not exist,
 *          a version with known advisories when a clean one exists, a deprecated
 *          version when a maintained one exists, a brand-new package with install
 *          scripts, a release that adds install scripts from a new publisher (src/risk);
 *   ask  : the newest version itself has advisories and nothing clean exists; a package
 *          the registry publishes but deps.dev has not indexed yet (hours old);
 *   allow: everything else. Warnings (cooldown, unknown source) go to the agent
 *          as context without blocking, unless configured otherwise.
 *
 * The team policy (.pinright.json, then env) adds deny and allow lists, license
 * rules and a severity threshold on top; see teamConfig.ts.
 */
import { getDependencies, getPackage } from '../advisories/depsdev.js';
import { getVuln, queryBatch, severityOf } from '../advisories/osv.js';
import { lineTreeMessage } from '../advisories/lineTree.js';
import { recommendedUpgrade, releaseLine } from '../advisories/resolve.js';
import { satisfiesComposer } from '../composer/constraint.js';
import { config } from '../config.js';
import { type Ecosystem, installCommand } from '../ecosystems.js';
import { riskOutcome } from '../risk/index.js';
import { normalizePypiName } from '../tree/lockfiles.js';
import semver from 'semver';
import { GRAPH_ECOSYSTEMS, pickVersion, satisfiesPep440 } from '../tree/resolveManifest.js';
import { belowThreshold, checkLicenses, denyEntry, denyMessage, isAllowed, type Policy, resolvePolicy, severityLevel } from '../teamConfig.js';
import { findLookalike } from '../typosquat.js';
import { stripInvisible } from '../untrusted/index.js';
import { checkPackage, type Verdict } from '../verdict.js';
import { type DepIntent } from './intent.js';
import { lateProblem } from './late.js';

export type Action = 'allow' | 'deny' | 'ask';

export interface HookDecision {
  action: Action;
  /** One line per package with a problem, written for the agent. */
  problems: string[];
  warnings: string[];
  checked: number;
}

/** Dependencies looked up per change. More than this asks a human instead of passing the rest unchecked. */
const MAX_CHECKS = 40;
/** Unchanged lines of a manifest read for the compatibility check only. */
const MAX_CONTEXT = 60;

async function versionFor(eco: Ecosystem, name: string, spec: string | undefined): Promise<{ version?: string; implicit: boolean; exists: boolean }> {
  const pkg = await getPackage(eco, name);
  if (!pkg?.versions.length) return { exists: false, implicit: !spec };
  const exact = spec?.replace(/^(==|=|v)/, '');
  // PEP 440: "3.10" and "3.10.0" are the same release, and deps.dev lists the padded form.
  const key = (s: string) => (eco === 'pypi' ? s.replace(/^v/, '').replace(/(\.0)+$/, '') : s.replace(/^v/, ''));
  const hit = exact ? pkg.versions.find((v) => key(v.versionKey.version) === key(exact)) : undefined;
  if (hit) return { version: hit.versionKey.version, implicit: false, exists: true };
  // A pin to a version that was never published: checkPackage reports it. Cargo's bare "1.2" is a range, not a pin.
  // A bare PyPI version comes from a "==" line the file parser already stripped.
  const pinned =
    spec &&
    ((eco === 'npm' && /^\d+\.\d+\.\d+/.test(spec)) || (eco === 'pypi' && /^(==|\d)/.test(spec)) || (eco === 'cargo' && /^=/.test(spec)) ||
      eco === 'go' || ((eco === 'rubygems' || eco === 'nuget') && /^\d/.test(spec)) ||
      (eco === 'maven' && /^\d[^[\](),+]*$/.test(spec)) || (eco === 'composer' && /^v?\d+\.\d+\.\d+(\.\d+)?$/.test(spec)));
  if (pinned) return { version: eco === 'go' ? `v${exact?.replace(/^v/, '')}` : exact, implicit: false, exists: true };
  return { version: pickVersion(eco, spec ?? '', pkg.versions), implicit: !spec, exists: true };
}

interface Checked {
  i: DepIntent;
  label: string;
  version?: string;
  implicit: boolean;
  exists: boolean;
  v?: Verdict;
  graph?: Map<string, string>;
  /** What this version requires of its direct dependencies, per deps.dev ("typing-inspection" -> ">=0.4.2"). */
  requires?: Map<string, string>;
}

type Outcome = { action: Action; problem?: string; warning?: string };

/**
 * Something could not be verified: the team's onError decides, and the message says which way it went.
 * Allowed, it is a note; asked or denied, it is the reason, so the agent is never blocked without one.
 */
export function unverified(p: Pick<Policy, 'onError'>, text: string): Outcome {
  if (p.onError === 'allow') return { action: 'allow', warning: `${text} Allowed unverified (onError: allow).` };
  return { action: p.onError, problem: `${text} The project's onError policy is "${p.onError}" for checks that cannot complete.` };
}

const norm = (eco: Ecosystem, n: string) => (eco === 'pypi' ? normalizePypiName(n) : n);

/**
 * "go install golang.org/x/vuln/cmd/govulncheck@v1.1.0" names a package inside a module; deps.dev and OSV know
 * the module (golang.org/x/vuln). The nearest parent path deps.dev has seen is the module that gets installed.
 */
export async function goModule(path: string): Promise<string> {
  const parts = path.split('/');
  for (let n = parts.length; n >= 2; n--) {
    const candidate = parts.slice(0, n).join('/');
    const pkg = await getPackage('go', candidate).catch(() => undefined);
    if (pkg?.versions.length) return candidate;
  }
  return path;
}

async function inspect(i: DepIntent): Promise<Checked> {
  if (i.ecosystem === 'go') i = { ...i, name: await goModule(i.name) };
  const spec = i.spec ? (/^[=<>~!]/.test(i.spec) ? i.spec : `@${i.spec}`) : '';
  const label = `${i.name}${spec} (${i.ecosystem}${i.executes ? ', executed' : ''})`;
  const { version, implicit, exists } = await versionFor(i.ecosystem, i.name, i.spec);
  // The verdict and the dependency graph are fetched side by side; the graph of a malicious version is dropped.
  const wantsGraph = Boolean(exists && version && !i.executes && GRAPH_ECOSYSTEMS.includes(i.ecosystem));
  const [v, g] = await Promise.all([
    // Unchanged lines of the file only take part in the compatibility check.
    i.contextOnly ? undefined : checkPackage(i.ecosystem, i.name, exists ? version : undefined),
    wantsGraph ? getDependencies(i.ecosystem, i.name, version as string).catch(() => undefined) : undefined,
  ]);
  let graph: Map<string, string> | undefined;
  let requires: Map<string, string> | undefined;
  if (wantsGraph && v?.report.verdict !== 'malicious') {
    if (g?.nodes?.length) {
      graph = new Map(g.nodes.slice(1).map((n) => [norm(i.ecosystem, n.versionKey.name), n.versionKey.version]));
      requires = new Map(
        g.edges.filter((e) => e.fromNode === 0 && e.requirement).map((e) => [norm(i.ecosystem, g.nodes[e.toNode].versionKey.name), e.requirement as string]),
      );
    }
  }
  return { i, label, version, implicit, exists, v, graph, requires };
}

/** Does an exact version satisfy a requirement string as deps.dev reports it for this ecosystem? */
export function satisfiesRequirement(eco: Ecosystem, version: string, requirement: string): boolean | undefined {
  const req = requirement.split(';')[0].trim();
  if (!req || req === '*') return true;
  try {
    if (eco === 'pypi') return satisfiesPep440(version, req);
    if (eco === 'composer') return satisfiesComposer(version, requirement.trim() === 'self.version' ? version : requirement);
    if (eco === 'npm' || eco === 'cargo') {
      const range = eco === 'cargo' ? req.split(',').map((p) => (/^\d/.test(p.trim()) ? `^${p.trim()}` : p.trim())).join(' ') : req;
      if (!semver.validRange(range, { loose: true })) return undefined;
      return semver.satisfies(version, range, { loose: true, includePrerelease: true });
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Package managers that install one version per name, so a pin outside a parent's range fails the install.
 * npm nests a second copy and Cargo keeps one per semver-incompatible line, so for them it is no failure:
 * typescript@7 next to a package that wants typescript@^6 installs fine.
 */
const SINGLE_VERSION: Ecosystem[] = ['pypi', 'composer', 'rubygems', 'nuget'];

/** "==1.2.3", "1.2.3", "v1.2.3": one version, not a range. */
const exactPin = (spec: string | undefined) => Boolean(spec && /^(===?\s*)?v?\d[\w.!+-]*$/.test(spec.trim()));

/** Pinned versions in the same file that their parents do not accept: the install would fail. */
function conflicts(checked: Checked[]): Outcome[] {
  const out: Outcome[] = [];
  const byName = new Map(checked.map((c) => [`${c.i.ecosystem}:${norm(c.i.ecosystem, c.i.name)}`, c]));
  for (const p of checked) {
    // Only exact pins on both sides: with a range ("scipy", "rich>=10,<15") the resolver picks a release that fits.
    if (!p.requires || !p.version || !SINGLE_VERSION.includes(p.i.ecosystem) || !exactPin(p.i.spec)) continue;
    for (const [child, req] of p.requires) {
      const c = byName.get(`${p.i.ecosystem}:${child}`);
      if (!c || !c.version || c.implicit || c === p || !exactPin(c.i.spec)) continue;
      if (p.i.contextOnly && c.i.contextOnly) continue; // nothing in this change touched either
      if (satisfiesRequirement(p.i.ecosystem, c.version, req) !== false) continue;
      const pulled = p.graph?.get(child);
      out.push({
        action: 'deny',
        problem:
          `${c.i.name} ${c.version} does not satisfy ${p.i.name} ${p.version}'s requirement "${req}", so this install would fail.` +
          (pulled ? ` ${p.i.name} ${p.version} resolves it to ${pulled}; pin that or drop the ${c.i.name} pin.` : ` Pin a version that satisfies it or drop the ${c.i.name} pin.`),
      });
    }
  }
  return out;
}

/** The upgrade of `parent` whose resolved graph carries clean versions of every name in `names`. */
async function parentUpgrade(c: Checked, names: string[]): Promise<{ to: string; sameLine: boolean; pulled: Map<string, string> } | undefined> {
  if (!c.version) return undefined;
  const r = c.v?.report ?? (await checkPackage(c.i.ecosystem, c.i.name, c.version, { risk: false }).catch(() => undefined))?.report;
  if (!r) return undefined;
  const candidates = [...new Set([r.safeVersionSameLine, r.safeVersionNearestLine, r.safeVersion].filter((x): x is string => Boolean(x) && x !== c.version))];
  // At most three candidates, looked at together; the first in order that pulls clean versions wins.
  const tried = await Promise.all(
    candidates.map(async (to) => {
      const g = await getDependencies(c.i.ecosystem, c.i.name, to).catch(() => undefined);
      if (!g?.nodes?.length) return undefined;
      const pulled = new Map<string, string>();
      for (const n of g.nodes.slice(1)) {
        const nm = norm(c.i.ecosystem, n.versionKey.name);
        if (names.includes(nm)) pulled.set(nm, n.versionKey.version);
      }
      const list = [...pulled.entries()];
      const ids = await queryBatch(list.map(([name, version]) => ({ ecosystem: c.i.ecosystem, name, version }))).catch(() => undefined);
      return ids && ids.every((x) => x.length === 0) ? { to, sameLine: to === r.safeVersionSameLine, pulled } : undefined;
    }),
  );
  return tried.find(Boolean);
}

/**
 * When no version without advisories exists, noFix (PINRIGHT_HOOK_NO_FIX) decides:
 * "severity" (default) asks for HIGH/CRITICAL and lets the rest through with a note;
 * "allow", "ask" or "deny" apply to every case.
 */
function noFix(p: Policy, head: string, severity: string | undefined, malware: boolean): Outcome {
  const mode = p.noFix;
  const serious = malware || /^(HIGH|CRITICAL)$/i.test(severity ?? '');
  const action: Action = mode === 'allow' || mode === 'ask' || mode === 'deny' ? mode : serious ? 'ask' : 'allow';
  const text = `${head} No version without known advisories exists yet${action === 'allow' ? '; allowed, keep an eye on it' : '; a human should decide'}.`;
  return action === 'allow' ? { action, warning: text } : { action, problem: text };
}

/** Higher is milder: CRITICAL 0, HIGH 1, unrated 1.5, MODERATE 2, LOW 3. */
function sevRank(s: string | undefined): number {
  const r: Record<string, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, MEDIUM: 2, LOW: 3 };
  return r[(s ?? '').toUpperCase()] ?? 1.5;
}

/**
 * Bins whose npm package of the same name is something else. Without the real package installed,
 * "npx tsc" downloads the unrelated "tsc" package; the lookalike check then called it a typo of "tsx".
 */
const NPX_BIN_PACKAGE: Record<string, string> = { tsc: 'typescript', tsserver: 'typescript', ng: '@angular/cli' };

function judge(c: Checked, p: Policy): Outcome {
  const { i, label, version, implicit } = c;
  const v = c.v as Verdict;
  const r = v.report;
  const realPkg = i.ecosystem === 'npm' && i.executes && !i.spec ? NPX_BIN_PACKAGE[i.name] : undefined;
  if (realPkg) {
    return {
      action: 'deny',
      problem:
        `${label}: npx ${i.name} runs the npm package "${i.name}", not the ${i.name} command of "${realPkg}", which is not installed here. ` +
        `Install it first (npm install -D ${realPkg}) and run npx ${i.name} again, or run npx -p ${realPkg} ${i.name}.`,
    };
  }
  const fix = (to: string | undefined, why: string) => (to ? ` ${why} ${to}: ${installCommand(i.ecosystem, i.name, to)}` : '');
  // Malware in the version being installed blocks whatever the package-wide verdict is.
  switch (r.requested?.verdict === 'malicious' ? 'malicious' : r.verdict) {
    case 'malicious':
      return { action: 'deny', problem: `${label}: flagged as MALWARE (${r.requested?.advisories.find((a) => a.id.startsWith('MAL-'))?.id ?? 'OSV'}). Do not install it.` };
    case 'possible-typosquat':
      return { action: 'deny', problem: `${label}: looks like a typo of "${v.typo?.lookalikeOf}"${v.typo?.existsInRegistry === false ? ' and does not exist' : ''}. Use the real package name.` };
    case 'unknown-package':
      return r.latestVersion
        ? { action: 'deny', problem: `${label}: version ${version} was never published (or was removed).${fix(r.safeVersion, 'Use')}` }
        : { action: 'deny', problem: `${label}: no such package in the ${i.ecosystem} registry. Check the name; if it is a private package, add it to "allow" in .pinright.json (or PINRIGHT_ALLOW).` };
    case 'unknown':
      // A package deps.dev has not indexed yet is hours old: nothing about it is known, so a human decides.
      if (r.notIndexed) return { action: p.onError === 'deny' ? 'deny' : 'ask', problem: `${label}: ${r.reason}. A human should confirm it before it is installed.` };
      // A fresh version of a known package: published, OSV checked, the rest unknown. The onError policy decides.
      if (r.requested?.notIndexed) return unreachable(p, i, `${label}: ${r.reason}.`);
      return unreachable(p, i, `${label}: could not be verified (${r.reason}).`);
    default:
      break;
  }
  const req = r.requested;
  if (req && req.verdict === 'vulnerable') {
    const ids = req.advisories.slice(0, 3).map((a) => a.aliases.find((x) => x.startsWith('CVE-')) ?? a.id).join(', ');
    const sev = req.advisories.find((a) => a.severity)?.severity;
    const head = `${label}${implicit ? ` resolves to ${version}, which` : ''} has ${req.advisories.length} known advisor${req.advisories.length === 1 ? 'y' : 'ies'} (${ids}${sev ? `, ${sev}` : ''}).`;
    if (belowThreshold(p, req.advisories)) {
      return { action: 'allow', warning: `${head} All are below the project's severity threshold (${p.severityThreshold}); allowed.${fix(recommendedUpgrade(r), 'Clean version')}` };
    }
    if (r.safeVersionSameLine && r.safeVersionSameLine !== version) return { action: 'deny', problem: `${head}${fix(r.safeVersionSameLine, `Use ${r.line} release`)}` };
    if (r.safeVersionNearestLine && r.safeVersionNearestLine !== version) {
      const guide = ` Call upgrade-guide (pinright MCP, or \`pinright upgrade ${i.ecosystem} ${i.name} ${version} ${r.safeVersionNearestLine}\`) for the breaking changes before writing code for it.`;
      return { action: 'deny', problem: `${head}${fix(r.safeVersionNearestLine, `No clean release on this line; the nearest fix is on ${r.nearestLine} (newest safe: ${r.safeVersion}),`)}${guide}` };
    }
    if (r.safeVersion && r.safeVersion !== version) {
      const guide = ` Call upgrade-guide (pinright MCP, or \`pinright upgrade ${i.ecosystem} ${i.name} ${version} ${r.safeVersion}\`) for the breaking changes before writing code for it.`;
      return { action: 'deny', problem: `${head}${fix(r.safeVersion, 'No clean release on this line; the fix needs a new major,')}${guide}` };
    }
    // No version is clean. If another one is clearly less exposed, point there.
    const le = r.leastExposed;
    if (le && le.version !== version) {
      const milder = sevRank(le.maxSeverity) > sevRank(sev) || (sevRank(le.maxSeverity) === sevRank(sev) && le.advisories < req.advisories.length);
      if (milder) {
        return {
          action: 'deny',
          problem: `${head} No version is free of known advisories; the least exposed is ${le.version} (${le.advisories} advisor${le.advisories === 1 ? 'y' : 'ies'}, worst ${le.maxSeverity ?? 'unrated'}): ${installCommand(i.ecosystem, i.name, le.version)}`,
        };
      }
    }
    // This is already the least exposed: blocking would only stop the work. Ask for serious ones, note the rest.
    return noFix(p, head, sev, req.advisories.some((a) => /^MAL-/.test(a.id)));
  }
  if (req && req.verdict === 'deprecated') {
    // deps.dev alone found no advisory, but OSV did not answer: a deprecated version is not "verified clean" either.
    if (r.unavailable?.includes('osv.dev') && !(r.safeVersion && r.safeVersion !== version)) {
      return unreachable(p, i, `${label}: deprecated by its maintainers${req.deprecatedReason ? `: ${req.deprecatedReason}` : ''}; its advisories could not be verified (osv.dev did not answer).`);
    }
    if (r.safeVersion && r.safeVersion !== version) return { action: 'deny', problem: `${label}: deprecated (${req.deprecatedReason ?? 'by its maintainers'}).${fix(r.safeVersion, 'Use')}` };
    return { action: 'allow', warning: `${label}: deprecated by its maintainers${req.deprecatedReason ? `: ${req.deprecatedReason}` : ''}.` };
  }
  if (implicit && r.safeVersion && version && r.safeVersion !== version) {
    const msg = `${label}: the newest version ${version} is younger than the ${config.cooldownDays}-day cooldown or a pre-release; pin ${r.safeVersion} instead.`;
    return p.cooldown === 'enforce' ? { action: 'deny', problem: msg } : { action: 'allow', warning: msg };
  }
  if (r.cooldownOnly) {
    const msg = `${label}: every release is younger than the ${config.cooldownDays}-day cooldown (latest ${r.latestVersion}); no version can be vouched for yet.`;
    return p.cooldown === 'enforce' ? { action: 'deny', problem: msg } : { action: 'allow', warning: msg };
  }
  return { action: 'allow' };
}

/** The license of the version being installed, against the team's license rules. */
function licenseOutcome(c: Checked, p: Policy): Outcome | undefined {
  const req = c.v?.report.requested;
  if (!req || req.verdict === 'unknown' || req.verdict === 'unknown-package') return undefined;
  const l = checkLicenses(p, req.licenses);
  if (l.action === 'deny') return { action: 'deny', problem: `${c.label}: ${l.message}` };
  if (l.action === 'note') return { action: 'allow', warning: `${c.label}: ${l.message}` };
  return undefined;
}

/** OSV ids whose advisories are all rated below the threshold, so transitive findings only note them. */
async function mildIds(ids: string[], p: Policy): Promise<Set<string>> {
  const mild = new Set<string>();
  if (p.severityThreshold === 'low') return mild;
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const v = await getVuln(id).catch(() => undefined);
      const sev = v ? severityOf(v) : undefined;
      if (v && !/^MAL-/.test(id) && severityLevel(sev) !== undefined && belowThreshold(p, [{ severity: sev }])) mild.add(id);
    }),
  );
  return mild;
}

/**
 * The registries could not be reached: the policy's onError decides, except that a name one edit
 * away from a popular package is never let through unseen (the lookalike check needs no network).
 */
function unreachable(p: Policy, i: DepIntent, text: string): Outcome {
  const look = findLookalike(i.ecosystem, i.name);
  if (look && p.onError === 'allow') return { action: 'ask', problem: `${text} The name is one edit away from "${look.of}"; a human should confirm it.` };
  return unverified(p, text);
}

/** What pinright can say without deps.dev or OSV: unverifiable sources and the team's deny list. */
function offlineOutcomes(intents: DepIntent[], p: Policy): Outcome[] {
  const out: Outcome[] = [];
  const seen = new Set<string>();
  for (const i of intents) {
    const u = i.unverifiable;
    if (!u) continue;
    const key = `${u.reason}\0${i.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (u.level !== 'guard' && isAllowed(p, i.ecosystem, i.name)) continue;
    const action: Action = u.level === 'guard' ? 'ask' : u.level === 'note' ? 'allow' : p.unverifiable;
    const text = `${u.reason}${i.source && !u.reason.includes(i.source) ? ` (${i.source.slice(0, 160)})` : ''}`;
    out.push(action === 'allow' ? { action, warning: text } : { action, problem: text });
  }
  return out;
}

/**
 * The hook's answer when the full check ran out of time: what is known offline (unverifiable
 * sources, the deny list), then "ask" for the rest. Not onError: the agent's own hook timeout lets
 * the change through when the hook does not answer, so the hook answers first and a human decides.
 * Only a stricter onError ("deny") wins. Codex, Gemini CLI and Windsurf have no "ask" and get a deny.
 */
export function timeoutDecision(intents: DepIntent[], policy: Policy, ms = 0, actions: string[] = []): HookDecision {
  const outcomes = offlineOutcomes(intents, policy);
  const rest = intents.filter((i) => !i.unverifiable && !i.contextOnly && !isAllowed(policy, i.ecosystem, i.name));
  const late: string[] = [];
  for (const i of rest) {
    const d = denyEntry(policy, i.ecosystem, i.name);
    if (d) outcomes.push({ action: 'deny', problem: `${i.name} (${i.ecosystem}): ${denyMessage(policy, d)}` });
    else {
      const look = findLookalike(i.ecosystem, i.name);
      if (look) outcomes.push({ action: 'ask', problem: `${i.name} (${i.ecosystem}) is one edit away from "${look.of}"; a human should confirm it.` });
      late.push(i.name);
    }
  }
  late.push(...actions);
  if (late.length) outcomes.push({ action: policy.onError === 'deny' ? 'deny' : 'ask', problem: lateProblem(late, ms) });
  const action: Action = outcomes.some((o) => o.action === 'deny') ? 'deny' : outcomes.some((o) => o.action === 'ask') ? 'ask' : 'allow';
  return {
    action,
    problems: outcomes.map((o) => o.problem).filter((x): x is string => Boolean(x)),
    warnings: outcomes.map((o) => o.warning).filter((x): x is string => Boolean(x)),
    checked: 0,
  };
}

export async function decide(intents: DepIntent[], policy: Policy = resolvePolicy()): Promise<HookDecision> {
  const p = policy;
  const outcomes: Outcome[] = offlineOutcomes(intents, p);
  intents = intents.filter((i) => !i.unverifiable);
  const seen = new Set<string>();
  const unique = intents.filter((i) => {
    const k = `${i.ecosystem}:${i.name}:${i.spec ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    if (isAllowed(p, i.ecosystem, i.name)) return false;
    const d = i.contextOnly ? undefined : denyEntry(p, i.ecosystem, i.name);
    if (d) {
      // No lookup needed: the team said no.
      outcomes.push({ action: 'deny', problem: `${i.name} (${i.ecosystem}): ${denyMessage(p, d)}` });
      return false;
    }
    return true;
  });
  const changed = unique.filter((i) => !i.contextOnly);
  const list = [...changed.slice(0, MAX_CHECKS), ...unique.filter((i) => i.contextOnly).slice(0, MAX_CONTEXT)];
  // In the order of the change, whichever lookup finishes first: the message and the cache keys stay stable.
  const inspected = await Promise.all(
    list.map(async (i) => {
      try {
        return await inspect(i);
      } catch (err) {
        outcomes.push(unreachable(p, i, `${i.name}: could not be verified (${(err as Error).message}).`));
        return undefined;
      }
    }),
  );
  const checked = inspected.filter((c): c is Checked => Boolean(c));

  // Which declared package pulls which other declared package (agents often pin a whole tree by hand).
  const declared = new Map(checked.map((c) => [`${c.i.ecosystem}:${norm(c.i.ecosystem, c.i.name)}`, c]));
  const parentOf = new Map<Checked, Checked>();
  for (const p of checked) {
    for (const name of p.graph?.keys() ?? []) {
      const child = declared.get(`${p.i.ecosystem}:${name}`);
      if (child && child !== p && !parentOf.has(child)) parentOf.set(child, p);
    }
  }

  // The parent upgrades each pinned child needs, looked up together before the outcomes are written in order.
  const viaParent = await Promise.all(
    checked.map((c) => {
      if (c.i.contextOnly) return undefined;
      const parent = parentOf.get(c);
      const req = c.v?.report.requested;
      const name = norm(c.i.ecosystem, c.i.name);
      const ownFix = c.v ? recommendedUpgrade(c.v.report) : undefined;
      const range = parent?.requires?.get(name);
      // The package's own fix already fits the parent's range ("idna<4,>=2.5"): repinning it is enough.
      const fitsParent = Boolean(ownFix && range && satisfiesRequirement(c.i.ecosystem, ownFix, range));
      if (!parent || fitsParent || req?.verdict !== 'vulnerable' || belowThreshold(p, req.advisories) || !SINGLE_VERSION.includes(c.i.ecosystem)) return undefined;
      // Pinning a dependency of another pinned package outside that package's range does not install.
      return parentUpgrade(parent, [name]).then((up) => ({ parent, up }));
    }),
  );

  for (const [k, c] of checked.entries()) {
    if (c.i.contextOnly) continue;
    let o = judge(c, p);
    const lic = licenseOutcome(c, p);
    if (lic) outcomes.push(lic);
    const name = norm(c.i.ecosystem, c.i.name);
    const via = viaParent[k];
    if (via) {
      const { parent, up } = via;
      const head = (o.problem ?? '').replace(/ (Use|No clean).*$/, '');
      if (up) {
        o = {
          action: 'deny',
          problem: `${head} It comes in through ${parent.i.name}: upgrade ${parent.i.name} to ${up.to}${up.sameLine ? '' : ' (new major)'}, which pulls ${c.i.name} ${up.pulled.get(name)} with no known advisories, and pin ${c.i.name} to that version or drop the pin.`,
        };
      } else {
        o = { action: 'ask', problem: `${head} It is a dependency of ${parent.i.name}, and no release of ${parent.i.name} pulls a fixed version yet; pinning it outside ${parent.i.name}'s range would not install.` };
      }
    }
    outcomes.push(o);
    // Told to move to the same-line fix, whose own tree still has advisories a newer line clears: say so, without blocking.
    const tree = c.v?.report.sameLineTree;
    if (tree && tree.version !== c.version && o.problem?.includes(tree.version)) outcomes.push({ action: 'allow', warning: lineTreeMessage(c.i.name, tree) });
    // Behavior signals (install scripts, publisher, provenance, age): deny only the narrow cases, note the rest.
    const risky = riskOutcome(c.label, c.v?.risk);
    if (risky) outcomes.push(risky);
  }

  outcomes.push(...conflicts(checked));

  // Transitive dependencies nobody declared: block only when a same-line upgrade clears them.
  const withGraph = checked.filter((c) => c.graph?.size && !c.i.contextOnly);
  const nodes = withGraph.flatMap((c) => [...(c.graph as Map<string, string>).entries()].filter(([n]) => !declared.has(`${c.i.ecosystem}:${n}`)).map(([name, version]) => ({ c, name, version })));
  let ids: string[][] | undefined = [];
  if (nodes.length) {
    ids = await queryBatch(nodes.map((n) => ({ ecosystem: n.c.i.ecosystem, name: n.name, version: n.version }))).catch((err: Error) => {
      // Not checking them is not the same as finding them clean: say so, and let onError decide.
      outcomes.push(unverified(p, `${nodes.length} transitive dependencies could not be checked (${err.message}).`));
      return undefined;
    });
  }
  const mild = await mildIds((ids ?? []).flat(), p);
  const vulnerableBy = new Map<Checked, string[]>();
  const idsOf = new Map<string, string[]>();
  nodes.forEach((n, k) => {
    const found = ids?.[k] ?? [];
    if (!found.length) return;
    if (found.every((id) => mild.has(id))) {
      outcomes.push({ action: 'allow', warning: `${n.c.label} pulls ${n.name}@${n.version}, whose advisories (${found.slice(0, 3).join(', ')}) are below the project's severity threshold (${p.severityThreshold}).` });
    } else {
      vulnerableBy.set(n.c, [...(vulnerableBy.get(n.c) ?? []), `${n.name}@${n.version}`]);
      idsOf.set(`${n.name}@${n.version}`, found);
    }
  });
  const fixes = await Promise.all(
    [...vulnerableBy].map(([c, vulns]) => parentUpgrade(c, [...new Set(vulns.map((x) => x.slice(0, x.lastIndexOf('@'))))])),
  );
  for (const [k, [c, vulns]] of [...vulnerableBy].entries()) {
    const up = fixes[k];
    const list = vulns.slice(0, 4).join(', ') + (vulns.length > 4 ? `, +${vulns.length - 4} more` : '');
    if (up?.sameLine) {
      outcomes.push({ action: 'deny', problem: `${c.label} pulls dependencies with known advisories (${list}). ${installCommand(c.i.ecosystem, c.i.name, up.to)} pulls fixed versions on the same release line.` });
    } else if (up) {
      // The pinned version is clean itself; moving to the new major is the only way to clear its tree.
      const pulls = vulns.map((x) => ({ name: x.slice(0, x.lastIndexOf('@')), version: x.slice(x.lastIndexOf('@') + 1), ids: idsOf.get(x) ?? [] }));
      const line = c.version ? releaseLine(c.version) : undefined;
      const clean = c.v?.report.requested?.verdict === 'ok';
      outcomes.push({
        action: 'allow',
        warning: clean && c.version && line
          ? lineTreeMessage(c.i.name, { version: c.version, line, pulls, cleaner: up.to, cleanerLine: releaseLine(up.to) ?? up.to })
          : `${c.label} pulls dependencies with known advisories (${list}); only ${c.i.name} ${up.to}, a new major, pulls fixed versions.`,
      });
    } else {
      outcomes.push({ action: 'allow', warning: `${c.label} pulls dependencies with known advisories (${list}) and no release of ${c.i.name} fixes them yet; consider an override.` });
    }
  }

  const problems = outcomes.map((r) => r.problem).filter((p): p is string => Boolean(p));
  const warnings = outcomes.map((r) => r.warning).filter((w): w is string => Boolean(w));
  if (changed.length > MAX_CHECKS) {
    // Padding a change with harmless packages must not push a bad one past the check.
    const skipped = changed.slice(MAX_CHECKS).map((i) => i.name);
    problems.push(
      `This change adds ${changed.length} dependencies and pinright checks ${MAX_CHECKS} per change, so ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? `, +${skipped.length - 8} more` : ''} were not checked. Add them in smaller batches, or a human should approve.`,
    );
    outcomes.push({ action: 'ask' });
  }
  const action: Action = outcomes.some((r) => r.action === 'deny') ? 'deny' : outcomes.some((r) => r.action === 'ask') ? 'ask' : 'allow';
  return { action, problems, warnings, checked: Math.min(changed.length, MAX_CHECKS) };
}

/** Longest line of a hook message: problems quote registry text (deprecation messages, script names). */
const MAX_ITEM = 700;

/**
 * One problem or warning as it goes into permissionDecisionReason / additionalContext.
 * Registry fields are already cleaned at their source; this is the last pass: one line,
 * no invisible characters, capped, so nothing a publisher wrote can open a new paragraph.
 */
function hookLine(s: string): string {
  const one = stripInvisible(s).text.replace(/\s+/g, ' ').trim();
  return `- ${one.length > MAX_ITEM ? `${one.slice(0, MAX_ITEM - 3)}...` : one}`;
}

export function agentMessage(d: HookDecision): string {
  const lines: string[] = [];
  if (d.action !== 'allow') {
    lines.push(`pinright ${d.action === 'deny' ? 'blocked' : 'needs approval for'} this dependency change:`);
    for (const p of d.problems) lines.push(hookLine(p));
    if (d.action === 'deny') lines.push('Change the version (or the name) and try again. check-package and get-docs from the pinright MCP server explain each case.');
  }
  if (d.warnings.length) {
    lines.push(d.action === 'allow' ? 'pinright notes about the dependencies in this change:' : 'Also:');
    for (const w of d.warnings) lines.push(hookLine(w));
  }
  return lines.join('\n');
}
