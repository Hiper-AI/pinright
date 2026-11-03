/**
 * Ranges the rest of a project puts on one package. pinright picks a package's fix on its own; in a
 * manifest, another dependency may forbid that version. stirrup 0.2.1 pulls moviepy 2.2.1, which
 * requires pillow<12.0, and pillow 11.3.0's advisories are fixed only in 13.0.0: a pin to 13.0.0 next
 * to stirrup makes the file unresolvable. This finds such a range, the newest release that fits it, and
 * whether a newer release of the package that sets the range accepts the fix.
 *
 * Ranges bind only where the package manager installs one version per name (pip, Composer, Bundler,
 * NuGet): there every requirement in the resolved graph counts. npm nests a second copy for an ordinary
 * dependency, so for npm only peer ranges bind. Graph ranges come from the deps.dev graphs the caller
 * already fetched. Per conflicting package the extra lookups are one version list, one OSV batch, and
 * one version list plus one graph (or requirements) lookup for the package that sets the range, all
 * cached. A lookup that fails leaves the recommendation as it was.
 */
import semver from 'semver';
import { config } from '../config.js';
import { satisfiesComposer } from '../composer/constraint.js';
import { type Ecosystem, installCommand } from '../ecosystems.js';
import { getDependencies, getPackage, getPeerRequirements, type DepsDevGraph } from '../advisories/depsdev.js';
import { fixedVersions, isMalware, queryBatch, queryVersion } from '../advisories/osv.js';
import { compareVersionsDesc, isPrerelease } from '../advisories/resolve.js';
import { normalizePypiName } from './lockfiles.js';
import { satisfiesPep440 } from './resolveManifest.js';

/**
 * Package managers that install one version per name, so a pin outside a parent's range fails the install.
 * npm nests a second copy and Cargo keeps one per semver-incompatible line, so for them it is no failure:
 * typescript@7 next to a package that wants typescript@^6 installs fine.
 */
export const SINGLE_VERSION: Ecosystem[] = ['pypi', 'composer', 'rubygems', 'nuget'];

/** One requirement on a package, and where in the project it comes from. */
export interface Constraint {
  /** The package that declares the range, at its resolved version ("moviepy" 2.2.1). */
  by: string;
  byVersion: string;
  requirement: string;
  /** The project's own dependency that pulls `by`, when that is not `by` itself ("stirrup" 0.2.1). */
  via?: string;
  viaVersion?: string;
  /** `via`'s range on `by`, when `by` is its direct dependency. */
  viaRequirement?: string;
  /** An npm peerDependencies range. */
  peer?: boolean;
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

const key = (eco: Ecosystem, n: string) => (eco === 'pypi' ? normalizePypiName(n) : n);

/** Every requirement on `target` inside one resolved graph: its root's own, and those of packages deeper in it. */
export function graphConstraints(eco: Ecosystem, graph: DepsDevGraph | undefined, target: string): Constraint[] {
  if (!SINGLE_VERSION.includes(eco) || !graph?.nodes?.length) return [];
  const root = graph.nodes[0].versionKey;
  const t = key(eco, target);
  const out = new Map<string, Constraint>();
  for (const e of graph.edges ?? []) {
    const to = graph.nodes[e.toNode];
    const from = graph.nodes[e.fromNode];
    if (!to || !from || !e.requirement || key(eco, to.versionKey.name) !== t) continue;
    const c: Constraint =
      e.fromNode === 0
        ? { by: root.name, byVersion: root.version, requirement: e.requirement }
        : {
            by: from.versionKey.name,
            byVersion: from.versionKey.version,
            requirement: e.requirement,
            via: root.name,
            viaVersion: root.version,
            viaRequirement: graph.edges.find((x) => x.fromNode === 0 && x.toNode === e.fromNode)?.requirement,
          };
    out.set(`${c.by}@${c.byVersion}:${c.requirement}`, c);
  }
  return [...out.values()];
}

/** npm peer ranges on `target` declared by these packages (one cached requirements lookup each). */
export async function peerConstraints(target: string, parents: { name: string; version: string }[]): Promise<Constraint[]> {
  const peers = await Promise.all(parents.map((p) => getPeerRequirements('npm', p.name, p.version).catch(() => undefined)));
  return parents.flatMap((p, k) => {
    const req = peers[k]?.get(target);
    return req ? [{ by: p.name, byVersion: p.version, requirement: req, peer: true }] : [];
  });
}

/** The constraints a version breaks. A range pinright cannot read counts as no conflict. */
export function violations(eco: Ecosystem, version: string, cons: Constraint[]): Constraint[] {
  return cons.filter((c) => satisfiesRequirement(eco, version, c.requirement) === false);
}

function vcmp(a: string, b: string): number {
  const va = semver.coerce(a);
  const vb = semver.coerce(b);
  if (va && vb) return semver.compare(va, vb);
  return a.localeCompare(b, undefined, { numeric: true });
}

/** For each advisory, the lowest fix above the current version; the fix for all is the highest of those. */
export function fixFor(current: string, advisories: { fixedIn?: string[] }[]): string | undefined {
  let need: string | undefined;
  for (const a of advisories) {
    const above = (a.fixedIn ?? []).filter((f) => vcmp(f, current) > 0).sort(vcmp);
    if (!above.length) return undefined; // one advisory without a fix: no single version fixes all
    if (!need || vcmp(above[0], need) > 0) need = above[0];
  }
  return need;
}

/** The release that fixes every advisory of a version, per OSV (one cached query), and how many it has. */
export async function osvFix(eco: Ecosystem, name: string, version: string): Promise<{ fix?: string; advisories: number }> {
  const vulns = await queryVersion(eco, name, version);
  return { fix: vulns.length ? fixFor(version, vulns.map((v) => ({ fixedIn: fixedVersions(v, name) }))) : undefined, advisories: vulns.length };
}

export interface Fit {
  version: string;
  advisories: number;
}

/** Newest releases inside the ranges looked at for a clean one, in one OSV batch. */
const FIT_CANDIDATES = 8;
const DAY = 24 * 3600_000;

/**
 * The newest release inside every range with no known advisory, else the one with the fewest (newest on
 * ties), when that is fewer than `currentAdvisories`. Stable, not deprecated or yanked, past the cooldown.
 */
export async function bestFitting(eco: Ecosystem, name: string, cons: Constraint[], currentAdvisories?: number): Promise<Fit | undefined> {
  const pkg = await getPackage(eco, name);
  const now = Date.now();
  const fits = [...(pkg?.versions ?? [])]
    .filter((v) => !v.isDeprecated && !isPrerelease(v.versionKey.version))
    .filter((v) => !v.publishedAt || now - Date.parse(v.publishedAt) >= config.cooldownDays * DAY)
    .filter((v) => cons.every((c) => satisfiesRequirement(eco, v.versionKey.version, c.requirement) === true))
    .sort(compareVersionsDesc)
    .slice(0, FIT_CANDIDATES);
  if (!fits.length) return undefined;
  const ids = await queryBatch(fits.map((v) => ({ ecosystem: eco, name, version: v.versionKey.version })));
  let best: Fit | undefined;
  fits.forEach((v, k) => {
    const list = ids[k] ?? [];
    if (list.some(isMalware)) return;
    if (!best || list.length < best.advisories) best = { version: v.versionKey.version, advisories: list.length };
  });
  if (!best || (best.advisories > 0 && (currentAdvisories === undefined || best.advisories >= currentAdvisories))) return undefined;
  return best;
}

export interface Lift {
  /** Newest stable release of the package that sets the range. */
  newest: string;
  /** That release accepts the fix. */
  accepts: boolean;
  /** It accepts the fix, but the project's dependency that pulls it requires an older one. */
  viaBlocks?: boolean;
}

/** `by`'s range on `target` at one version: a string, null when it has none, undefined when unknown. */
async function rangeAt(eco: Ecosystem, by: string, version: string, target: string): Promise<string | null | undefined> {
  if (eco === 'npm') {
    const peers = await getPeerRequirements(eco, by, version);
    return peers ? (peers.get(target) ?? null) : undefined;
  }
  const g = await getDependencies(eco, by, version);
  if (!g?.nodes?.length) return undefined;
  const e = g.edges.find((x) => x.fromNode === 0 && key(eco, g.nodes[x.toNode]?.versionKey.name ?? '') === key(eco, target));
  return e ? (e.requirement ?? undefined) : null;
}

/** Whether the newest release of the package that sets the range accepts the fix. */
export async function liftCheck(eco: Ecosystem, con: Constraint, target: string, fix: string): Promise<Lift | undefined> {
  const pkg = await getPackage(eco, con.by);
  const stable = (pkg?.versions ?? []).filter((v) => !isPrerelease(v.versionKey.version)).sort(compareVersionsDesc);
  const newest = (stable.find((v) => v.isDefault) ?? stable[0])?.versionKey.version;
  if (!newest) return undefined;
  if (vcmp(newest, con.byVersion) <= 0) return { newest: con.byVersion, accepts: false };
  const range = await rangeAt(eco, con.by, newest, target);
  if (range === undefined) return undefined;
  const accepts = range === null || satisfiesRequirement(eco, fix, range) === true;
  const viaBlocks = Boolean(accepts && con.via && con.viaRequirement && satisfiesRequirement(eco, newest, con.viaRequirement) === false);
  return { newest, accepts, viaBlocks };
}

export interface FixConflict {
  name: string;
  /** The version pinright would otherwise recommend. */
  fix: string;
  /** The ranges it breaks, first one named in the message. */
  bad: Constraint[];
  fit?: Fit;
  lift?: Lift;
}

/** The recommended fix of `name` against the project's ranges on it; undefined when it fits them all. */
export async function checkFix(eco: Ecosystem, name: string, fix: string, cons: Constraint[], currentAdvisories?: number): Promise<FixConflict | undefined> {
  const bad = violations(eco, fix, cons);
  if (!bad.length) return undefined;
  const [fit, lift] = await Promise.all([
    bestFitting(eco, name, cons, currentAdvisories).catch(() => undefined),
    liftCheck(eco, bad[0], name, fix).catch(() => undefined),
  ]);
  return { name, fix, bad, fit, lift };
}

const who = (c: Constraint) => `${c.by} ${c.byVersion}${c.via ? ` (via ${c.via} ${c.viaVersion})` : ''}`;
/** "pillow<12.0,>=9.2.0" for PEP 440, "react ^18.3.1" elsewhere. */
export const rangeText = (eco: Ecosystem, name: string, req: string) => (eco === 'pypi' && /^[<>=!~]/.test(req) ? `${name}${req}` : `${name} ${req}`);

/**
 * The explanation, after `lead` ("pillow 13.0.0 fixes these advisories"). With a clean release inside the
 * range it ends on the command to install it; otherwise it names the options: the least exposed release
 * in range, upgrading the package that sets the range (and whether a release of it accepts the fix yet),
 * or accepting the advisories.
 */
export function conflictText(eco: Ecosystem, k: FixConflict, lead: string): string {
  const c = k.bad[0];
  const others = k.bad.slice(1, 3).map((x) => `${who(x)} requires ${rangeText(eco, k.name, x.requirement)}`);
  let s = `${lead}, but ${who(c)} requires ${rangeText(eco, k.name, c.requirement)}${c.peer ? ' as a peer dependency' : ''}${others.length ? `, and ${others.join(', ')}` : ''}.`;
  if (k.fit && k.fit.advisories === 0) {
    return `${s} The newest ${k.name} release in that range with no known advisories is ${k.fit.version}: ${installCommand(eco, k.name, k.fit.version)}`;
  }
  s += ` No ${k.name} release in that range is free of them`;
  s += k.fit ? `; the least exposed is ${k.fit.version} (${k.fit.advisories} advisor${k.fit.advisories === 1 ? 'y' : 'ies'}): ${installCommand(eco, k.name, k.fit.version)}.` : '.';
  const l = k.lift;
  if (l?.accepts && l.viaBlocks) {
    s += ` ${c.by} ${l.newest} accepts ${k.name} ${k.fix}, but ${c.via} ${c.viaVersion} requires ${rangeText(eco, c.by, c.viaRequirement as string)}; upgrading ${c.via}, or accepting the advisories, are the options.`;
  } else if (l?.accepts) {
    s += ` ${c.by} ${l.newest} accepts ${k.name} ${k.fix}${c.via ? ` and fits ${c.via} ${c.viaVersion}` : ''}: upgrading ${c.by} to it, or accepting the advisories, are the options.`;
  } else if (l) {
    s += ` No ${c.by} release accepts ${k.name} ${k.fix} yet (newest: ${l.newest}); upgrading ${c.by} once one does, or accepting the advisories, are the options.`;
  } else {
    s += ` Upgrading ${c.via ?? c.by}, or accepting the advisories, are the options.`;
  }
  s += c.peer
    ? ` With ${k.name} outside that range, npm stops the install with a peer dependency conflict.`
    : ` A ${k.name} pin outside that range would make the install fail.`;
  return s;
}
