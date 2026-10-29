/**
 * The hook's decision. A hook runs whether or not the agent called the MCP
 * tools, so this is the enforcement layer; the MCP server is the explaining one.
 *
 *   deny : malware, typosquat lookalike, package or version that does not exist,
 *          a version with known advisories when a clean one exists, a deprecated
 *          version when a maintained one exists;
 *   ask  : the newest version itself has advisories and nothing clean exists;
 *   allow: everything else. Warnings (cooldown, unknown source) go to the agent
 *          as context without blocking, unless configured otherwise.
 */
import { getDependencies, getPackage } from '../advisories/depsdev.js';
import { queryBatch } from '../advisories/osv.js';
import { config } from '../config.js';
import { type Ecosystem, installCommand } from '../ecosystems.js';
import { normalizePypiName } from '../tree/lockfiles.js';
import semver from 'semver';
import { GRAPH_ECOSYSTEMS, pickVersion, satisfiesPep440 } from '../tree/resolveManifest.js';
import { checkPackage, type Verdict } from '../verdict.js';
import { type DepIntent } from './intent.js';

export type Action = 'allow' | 'deny' | 'ask';

export interface HookDecision {
  action: Action;
  /** One line per package with a problem, written for the agent. */
  problems: string[];
  warnings: string[];
  checked: number;
}

const MAX_CHECKS = 25;
/** Unchanged lines of a manifest read for the compatibility check only. */
const MAX_CONTEXT = 60;

function allowed(name: string): boolean {
  const list = (process.env.SAFECTX_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : p === name));
}

function onError(): Action {
  const v = process.env.SAFECTX_HOOK_ON_ERROR;
  return v === 'deny' || v === 'ask' ? v : 'allow';
}

async function versionFor(eco: Ecosystem, name: string, spec: string | undefined): Promise<{ version?: string; implicit: boolean; exists: boolean }> {
  const pkg = await getPackage(eco, name);
  if (!pkg?.versions.length) return { exists: false, implicit: !spec };
  const exact = spec?.replace(/^(==|=|v)/, '');
  if (exact && pkg.versions.some((v) => v.versionKey.version.replace(/^v/, '') === exact.replace(/^v/, ''))) {
    const hit = pkg.versions.find((v) => v.versionKey.version.replace(/^v/, '') === exact.replace(/^v/, ''));
    return { version: hit?.versionKey.version, implicit: false, exists: true };
  }
  // A pin to a version that was never published: checkPackage reports it. Cargo's bare "1.2" is a range, not a pin.
  const pinned =
    spec &&
    ((eco === 'npm' && /^\d+\.\d+\.\d+/.test(spec)) || (eco === 'pypi' && /^==/.test(spec)) || (eco === 'cargo' && /^=/.test(spec)) ||
      eco === 'go' || ((eco === 'rubygems' || eco === 'nuget') && /^\d/.test(spec)));
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

const norm = (eco: Ecosystem, n: string) => (eco === 'pypi' ? normalizePypiName(n) : n);

async function inspect(i: DepIntent): Promise<Checked> {
  const spec = i.spec ? (/^[=<>~!]/.test(i.spec) ? i.spec : `@${i.spec}`) : '';
  const label = `${i.name}${spec} (${i.ecosystem}${i.executes ? ', executed' : ''})`;
  const { version, implicit, exists } = await versionFor(i.ecosystem, i.name, i.spec);
  // Unchanged lines of the file only take part in the compatibility check.
  const v = i.contextOnly ? undefined : await checkPackage(i.ecosystem, i.name, exists ? version : undefined);
  let graph: Map<string, string> | undefined;
  let requires: Map<string, string> | undefined;
  if (exists && version && !i.executes && GRAPH_ECOSYSTEMS.includes(i.ecosystem) && v?.report.verdict !== 'malicious') {
    const g = await getDependencies(i.ecosystem, i.name, version).catch(() => undefined);
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

/** Pinned versions in the same file that their parents do not accept: the install would fail. */
function conflicts(checked: Checked[]): Outcome[] {
  const out: Outcome[] = [];
  const byName = new Map(checked.map((c) => [`${c.i.ecosystem}:${norm(c.i.ecosystem, c.i.name)}`, c]));
  for (const p of checked) {
    if (!p.requires || !p.version) continue;
    for (const [child, req] of p.requires) {
      const c = byName.get(`${p.i.ecosystem}:${child}`);
      if (!c || !c.version || c.implicit || c === p) continue;
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
  const r = c.v?.report ?? (await checkPackage(c.i.ecosystem, c.i.name, c.version).catch(() => undefined))?.report;
  if (!r) return undefined;
  const candidates = [...new Set([r.safeVersionSameLine, r.safeVersion].filter((x): x is string => Boolean(x) && x !== c.version))];
  for (const to of candidates) {
    const g = await getDependencies(c.i.ecosystem, c.i.name, to).catch(() => undefined);
    if (!g?.nodes?.length) continue;
    const pulled = new Map<string, string>();
    for (const n of g.nodes.slice(1)) {
      const nm = norm(c.i.ecosystem, n.versionKey.name);
      if (names.includes(nm)) pulled.set(nm, n.versionKey.version);
    }
    const list = [...pulled.entries()];
    const ids = await queryBatch(list.map(([name, version]) => ({ ecosystem: c.i.ecosystem, name, version }))).catch(() => undefined);
    if (ids && ids.every((x) => x.length === 0)) return { to, sameLine: to === r.safeVersionSameLine, pulled };
  }
  return undefined;
}

/**
 * When no version without advisories exists, SAFECTX_HOOK_NO_FIX decides:
 * "severity" (default) asks for HIGH/CRITICAL and lets the rest through with a note;
 * "allow", "ask" or "deny" apply to every case.
 */
function noFix(head: string, severity: string | undefined, malware: boolean): Outcome {
  const mode = process.env.SAFECTX_HOOK_NO_FIX ?? 'severity';
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

function judge(c: Checked): Outcome {
  const { i, label, version, implicit } = c;
  const v = c.v as Verdict;
  const r = v.report;
  const fix = (to: string | undefined, why: string) => (to ? ` ${why} ${to}: ${installCommand(i.ecosystem, i.name, to)}` : '');
  switch (r.verdict) {
    case 'malicious':
      return { action: 'deny', problem: `${label}: flagged as MALWARE (${r.requested?.advisories.find((a) => a.id.startsWith('MAL-'))?.id ?? 'OSV'}). Do not install it.` };
    case 'possible-typosquat':
      return { action: 'deny', problem: `${label}: looks like a typo of "${v.typo?.lookalikeOf}"${v.typo?.existsInRegistry === false ? ' and does not exist' : ''}. Use the real package name.` };
    case 'unknown-package':
      return r.latestVersion
        ? { action: 'deny', problem: `${label}: version ${version} was never published (or was removed).${fix(r.safeVersion, 'Use')}` }
        : { action: 'deny', problem: `${label}: no such package in the ${i.ecosystem} registry. Check the name; if it is a private package, add it to SAFECTX_ALLOW.` };
    case 'unknown':
      return { action: onError(), warning: `${label}: could not be verified (${r.reason}).` };
    default:
      break;
  }
  const req = r.requested;
  if (req && req.verdict === 'vulnerable') {
    const ids = req.advisories.slice(0, 3).map((a) => a.aliases.find((x) => x.startsWith('CVE-')) ?? a.id).join(', ');
    const sev = req.advisories.find((a) => a.severity)?.severity;
    const head = `${label}${implicit ? ` resolves to ${version}, which` : ''} has ${req.advisories.length} known advisor${req.advisories.length === 1 ? 'y' : 'ies'} (${ids}${sev ? `, ${sev}` : ''}).`;
    if (r.safeVersionSameLine && r.safeVersionSameLine !== version) return { action: 'deny', problem: `${head}${fix(r.safeVersionSameLine, `Use ${r.line} release`)}` };
    if (r.safeVersion && r.safeVersion !== version) return { action: 'deny', problem: `${head}${fix(r.safeVersion, 'No clean release on this line; the fix needs a new major,')}` };
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
    return noFix(head, sev, req.advisories.some((a) => /^MAL-/.test(a.id)));
  }
  if (req && req.verdict === 'deprecated') {
    if (r.safeVersion && r.safeVersion !== version) return { action: 'deny', problem: `${label}: deprecated (${req.deprecatedReason ?? 'by its maintainers'}).${fix(r.safeVersion, 'Use')}` };
    return { action: 'allow', warning: `${label}: deprecated by its maintainers${req.deprecatedReason ? `: ${req.deprecatedReason}` : ''}.` };
  }
  if (implicit && r.safeVersion && version && r.safeVersion !== version) {
    const msg = `${label}: the newest version ${version} is younger than the ${config.cooldownDays}-day cooldown or a pre-release; pin ${r.safeVersion} instead.`;
    return process.env.SAFECTX_HOOK_COOLDOWN === 'enforce' ? { action: 'deny', problem: msg } : { action: 'allow', warning: msg };
  }
  return { action: 'allow' };
}

export async function decide(intents: DepIntent[]): Promise<HookDecision> {
  const seen = new Set<string>();
  const unique = intents.filter((i) => {
    const k = `${i.ecosystem}:${i.name}:${i.spec ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return !allowed(i.name);
  });
  const changed = unique.filter((i) => !i.contextOnly);
  const list = [...changed.slice(0, MAX_CHECKS), ...unique.filter((i) => i.contextOnly).slice(0, MAX_CONTEXT)];
  const outcomes: Outcome[] = [];
  const checked: Checked[] = [];
  await Promise.all(
    list.map(async (i) => {
      try {
        checked.push(await inspect(i));
      } catch (err) {
        outcomes.push({ action: onError(), warning: `${i.name}: could not be verified (${(err as Error).message}).` });
      }
    }),
  );

  // Which declared package pulls which other declared package (agents often pin a whole tree by hand).
  const declared = new Map(checked.map((c) => [`${c.i.ecosystem}:${norm(c.i.ecosystem, c.i.name)}`, c]));
  const parentOf = new Map<Checked, Checked>();
  for (const p of checked) {
    for (const name of p.graph?.keys() ?? []) {
      const child = declared.get(`${p.i.ecosystem}:${name}`);
      if (child && child !== p && !parentOf.has(child)) parentOf.set(child, p);
    }
  }

  for (const c of checked) {
    if (c.i.contextOnly) continue;
    let o = judge(c);
    const parent = parentOf.get(c);
    if (parent && c.v?.report.requested?.verdict === 'vulnerable') {
      // Pinning a dependency of another pinned package outside that package's range does not install.
      const name = norm(c.i.ecosystem, c.i.name);
      const up = await parentUpgrade(parent, [name]);
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
  }

  outcomes.push(...conflicts(checked));

  // Transitive dependencies nobody declared: block only when a same-line upgrade clears them.
  const withGraph = checked.filter((c) => c.graph?.size && !c.i.contextOnly);
  const nodes = withGraph.flatMap((c) => [...(c.graph as Map<string, string>).entries()].filter(([n]) => !declared.has(`${c.i.ecosystem}:${n}`)).map(([name, version]) => ({ c, name, version })));
  const ids = nodes.length ? await queryBatch(nodes.map((n) => ({ ecosystem: n.c.i.ecosystem, name: n.name, version: n.version }))).catch(() => undefined) : [];
  const vulnerableBy = new Map<Checked, string[]>();
  nodes.forEach((n, k) => {
    if (ids?.[k]?.length) vulnerableBy.set(n.c, [...(vulnerableBy.get(n.c) ?? []), `${n.name}@${n.version}`]);
  });
  for (const [c, vulns] of vulnerableBy) {
    const names = [...new Set(vulns.map((x) => x.slice(0, x.lastIndexOf('@'))))];
    const up = await parentUpgrade(c, names);
    const list = vulns.slice(0, 4).join(', ') + (vulns.length > 4 ? `, +${vulns.length - 4} more` : '');
    if (up?.sameLine) {
      outcomes.push({ action: 'deny', problem: `${c.label} pulls dependencies with known advisories (${list}). ${installCommand(c.i.ecosystem, c.i.name, up.to)} pulls fixed versions on the same release line.` });
    } else if (up) {
      outcomes.push({ action: 'allow', warning: `${c.label} pulls dependencies with known advisories (${list}); only ${c.i.name} ${up.to}, a new major, pulls fixed versions.` });
    } else {
      outcomes.push({ action: 'allow', warning: `${c.label} pulls dependencies with known advisories (${list}) and no release of ${c.i.name} fixes them yet; consider an override.` });
    }
  }

  const problems = outcomes.map((r) => r.problem).filter((p): p is string => Boolean(p));
  const warnings = outcomes.map((r) => r.warning).filter((w): w is string => Boolean(w));
  if (changed.length > MAX_CHECKS) warnings.push(`Only the first ${MAX_CHECKS} of ${changed.length} dependencies were checked.`);
  const action: Action = outcomes.some((r) => r.action === 'deny') ? 'deny' : outcomes.some((r) => r.action === 'ask') ? 'ask' : 'allow';
  return { action, problems, warnings, checked: Math.min(changed.length, MAX_CHECKS) };
}

export function agentMessage(d: HookDecision): string {
  const lines: string[] = [];
  if (d.action !== 'allow') {
    lines.push(`safectx ${d.action === 'deny' ? 'blocked' : 'needs approval for'} this dependency change:`);
    for (const p of d.problems) lines.push(`- ${p}`);
    if (d.action === 'deny') lines.push('Change the version (or the name) and try again. check-package and query-docs from the safectx MCP server explain each case.');
  }
  if (d.warnings.length) {
    lines.push(d.action === 'allow' ? 'safectx notes about the dependencies in this change:' : 'Also:');
    for (const w of d.warnings) lines.push(`- ${w}`);
  }
  return lines.join('\n');
}
