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
import { GRAPH_ECOSYSTEMS, pickVersion } from '../tree/resolveManifest.js';
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
}

type Outcome = { action: Action; problem?: string; warning?: string };

const norm = (eco: Ecosystem, n: string) => (eco === 'pypi' ? normalizePypiName(n) : n);

async function inspect(i: DepIntent): Promise<Checked> {
  const spec = i.spec ? (/^[=<>~!]/.test(i.spec) ? i.spec : `@${i.spec}`) : '';
  const label = `${i.name}${spec} (${i.ecosystem}${i.executes ? ', executed' : ''})`;
  const { version, implicit, exists } = await versionFor(i.ecosystem, i.name, i.spec);
  const v = await checkPackage(i.ecosystem, i.name, exists ? version : undefined);
  let graph: Map<string, string> | undefined;
  if (exists && version && !i.executes && GRAPH_ECOSYSTEMS.includes(i.ecosystem) && v.report.verdict !== 'malicious') {
    const g = await getDependencies(i.ecosystem, i.name, version).catch(() => undefined);
    if (g?.nodes?.length) graph = new Map(g.nodes.slice(1).map((n) => [norm(i.ecosystem, n.versionKey.name), n.versionKey.version]));
  }
  return { i, label, version, implicit, exists, v, graph };
}

/** The upgrade of `parent` whose resolved graph carries clean versions of every name in `names`. */
async function parentUpgrade(c: Checked, names: string[]): Promise<{ to: string; sameLine: boolean; pulled: Map<string, string> } | undefined> {
  const r = c.v?.report;
  if (!r || !c.version) return undefined;
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
    if (r.safeVersion) return { action: 'deny', problem: `${head}${fix(r.safeVersion, 'No clean release on this line; the fix needs a new major,')}` };
    return { action: 'ask', problem: `${head} No version without advisories exists; a human should decide.` };
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
  const list = unique.slice(0, MAX_CHECKS);
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

  // Transitive dependencies nobody declared: block only when a same-line upgrade clears them.
  const withGraph = checked.filter((c) => c.graph?.size);
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
  if (unique.length > MAX_CHECKS) warnings.push(`Only the first ${MAX_CHECKS} of ${unique.length} dependencies were checked.`);
  const action: Action = outcomes.some((r) => r.action === 'deny') ? 'deny' : outcomes.some((r) => r.action === 'ask') ? 'ask' : 'allow';
  return { action, problems, warnings, checked: list.length };
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
