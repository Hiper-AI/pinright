/**
 * A Context7 library id is a GitHub repo ("/vercel/next.js"), not a package.
 * This module turns it into a (ecosystem, package) pair.
 *
 * Strategy, in order:
 *   1. hints from the tool call (packageName + ecosystem) win;
 *   2. guess-and-verify: try the repo name in each registry and keep it only if
 *      deps.dev says that package's source repo is this one;
 *   3. deps.dev's project -> package list, scored by name similarity.
 * Two things we learned the hard way: deps.dev caps that list at 1,500 rows (a
 * monorepo like next.js shows a single package), and it treats every GitHub
 * repo as a pseudo Go module, so Go rows only count when the repo has a go.mod.
 */
import { getPackage, getProjectPackageVersions, getVersion } from './advisories/depsdev.js';
import { compareVersionsDesc } from './advisories/resolve.js';
import { cached } from './cache.js';
import { config } from './config.js';
import { parseLibraryId } from './context7.js';
import { type Ecosystem, fromDepsDevSystem, parseEcosystem } from './ecosystems.js';
import { getText, isNotFound } from './http.js';

export interface PackageRef {
  ecosystem: Ecosystem;
  name: string;
  /** How we got here, for the agent and for debugging. */
  via: 'explicit' | 'verified-guess' | 'deps.dev-project';
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.js$|\.py$|\.rs$|-js$|-py$|-rs$|-rb$|_js$|_py$/, '')
    .replace(/[^a-z0-9]/g, '');
}

function sameRepo(url: string | undefined, owner: string, repo: string): boolean {
  if (!url) return false;
  const m = url.toLowerCase().match(/github\.com[/:]([^/]+)\/([^/#?]+)/);
  if (!m) return false;
  const r = m[2].replace(/\.git$/, '');
  return m[1] === owner.toLowerCase() && r === repo.toLowerCase();
}

/** Names a repo is likely to publish under. Order matters: most likely first. */
export function guessNames(owner: string, repo: string): string[] {
  const out = new Set<string>();
  const bare = repo.toLowerCase();
  out.add(bare);
  const stripped = bare.replace(/\.js$|-js$|_js$|\.py$|-py$|-python$|-rs$|-rust$|-rb$|-ruby$/, '');
  if (stripped && stripped !== bare) out.add(stripped);
  out.add(bare.replace(/_/g, '-'));
  out.add(bare.replace(/-/g, '_'));
  out.add(`@${owner.toLowerCase()}/${bare}`);
  if (bare.startsWith(`${owner.toLowerCase()}-`)) out.add(bare.slice(owner.length + 1));
  return [...out];
}

/** Does deps.dev agree that this package comes from github.com/owner/repo? */
async function verifyPackage(eco: Ecosystem, name: string, owner: string, repo: string): Promise<boolean> {
  const pkg = await getPackage(eco, name);
  if (!pkg || pkg.versions.length === 0) return false;
  // The default tag may be a pre-release whose metadata moved elsewhere (prisma's
  // 8.0.0-rc points at prisma/prisma-cli); the newest stable is the second witness.
  const sorted = [...pkg.versions].sort(compareVersionsDesc);
  const witnesses = new Set<string>();
  const def = sorted.find((v) => v.isDefault);
  if (def) witnesses.add(def.versionKey.version);
  const stable = sorted.find((v) => !v.isDeprecated && !PRERELEASE.test(v.versionKey.version));
  if (stable) witnesses.add(stable.versionKey.version);
  if (witnesses.size === 0) witnesses.add(sorted[0].versionKey.version);
  for (const version of witnesses) {
    const detail = await getVersion(eco, name, version);
    if (!detail) continue;
    const urls = [
      ...(detail.relatedProjects ?? []).map((p) => p.projectKey.id),
      ...(detail.links ?? []).filter((l) => l.label === 'SOURCE_REPO' || l.label === 'HOMEPAGE').map((l) => l.url),
      ...(detail.slsaProvenances ?? []).map((p) => p.sourceRepository),
    ];
    if (urls.some((u) => sameRepo(u, owner, repo))) return true;
  }
  return false;
}

const PRERELEASE = /[-+.](alpha|beta|rc|canary|dev|preview|nightly|snapshot|pre|next|experimental)/i;

async function hasGoMod(owner: string, repo: string): Promise<boolean> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/go.mod`;
  return cached(`gomod:${owner}/${repo}`, config.ttl.versions, async () => {
    try {
      await getText(url);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }).catch(() => false);
}

const GUESS_ORDER: Ecosystem[] = ['npm', 'pypi', 'cargo', 'rubygems', 'go'];

async function guessAndVerify(owner: string, repo: string, preferred?: Ecosystem): Promise<PackageRef | undefined> {
  const ecos = preferred ? [preferred] : GUESS_ORDER;
  const names = guessNames(owner, repo);
  for (const eco of ecos) {
    const candidates = eco === 'go' ? [`github.com/${owner}/${repo}`] : names.filter((n) => eco === 'npm' || !n.startsWith('@'));
    if (eco === 'go' && !(await hasGoMod(owner, repo))) continue;
    for (const name of candidates) {
      try {
        if (await verifyPackage(eco, name, owner, repo)) return { ecosystem: eco, name, via: 'verified-guess' };
      } catch {
        // deps.dev hiccup on one guess: try the next one.
      }
    }
  }
  return undefined;
}

/**
 * Pick, from deps.dev's project rows, the package a repo most likely publishes
 * under its own name. Exported for tests.
 */
export function pickPackage(
  owner: string,
  repo: string,
  rows: { system: string; name: string; relationType?: string; relationProvenance?: string }[],
  preferred?: Ecosystem,
  allowGo = false,
): PackageRef | undefined {
  interface Agg { ecosystem: Ecosystem; name: string; count: number; attested: number }
  const agg = new Map<string, Agg>();
  for (const r of rows) {
    const eco = fromDepsDevSystem(r.system);
    if (!eco) continue;
    if (preferred && eco !== preferred) continue;
    if (eco === 'go' && !allowGo && preferred !== 'go') continue;
    if (r.relationType && r.relationType !== 'SOURCE_REPO') continue;
    const key = `${eco}:${r.name}`;
    const a = agg.get(key) ?? { ecosystem: eco, name: r.name, count: 0, attested: 0 };
    a.count += 1;
    if (r.relationProvenance === 'SLSA_ATTESTATION') a.attested += 1;
    agg.set(key, a);
  }
  if (agg.size === 0) return undefined;

  const repoN = normalize(repo);
  const ownerRepoN = normalize(`${owner}-${repo}`);
  const score = (a: Agg): number => {
    const tail = a.name.split('/').pop() ?? a.name; // "@scope/name" -> "name"
    const n = normalize(tail);
    const full = normalize(a.name);
    let s = 0;
    if (n === repoN || full === repoN) s += 1000;
    else if (full === ownerRepoN) s += 900;
    else if (n.startsWith(repoN) || repoN.startsWith(n)) s += 300;
    else if (full.includes(repoN)) s += 100;
    if (!a.name.startsWith('@')) s += 50; // unscoped before scoped
    s += Math.min(a.count, 40) + Math.min(a.attested, 40) * 0.5;
    return s;
  };
  const best = [...agg.values()].sort((x, y) => score(y) - score(x))[0];
  // A weak name match from a capped list is worse than no answer: the agent
  // would get a verdict about the wrong package.
  if (score(best) < 300) return undefined;
  return { ecosystem: best.ecosystem, name: best.name, via: 'deps.dev-project' };
}

export async function resolvePackage(
  libraryId: string,
  hints: { ecosystem?: string; packageName?: string; language?: string } = {},
): Promise<PackageRef | undefined> {
  const eco = parseEcosystem(hints.ecosystem) ?? parseEcosystem(hints.language);
  if (hints.packageName && eco) {
    return { ecosystem: eco, name: hints.packageName, via: 'explicit' };
  }
  const { owner, repo } = parseLibraryId(libraryId);
  if (owner === 'websites' || owner === 'llmstxt') {
    // Not a repo: "/websites/nextjs". Nothing to link unless the caller told us.
    return hints.packageName ? { ecosystem: 'npm', name: hints.packageName, via: 'explicit' } : undefined;
  }

  const guessed = await guessAndVerify(owner, repo, eco);
  if (guessed) return hints.packageName ? { ...guessed, name: hints.packageName, via: 'explicit' } : guessed;

  let rows: { system: string; name: string; relationType?: string; relationProvenance?: string }[] = [];
  try {
    rows = (await getProjectPackageVersions(`github.com/${owner}/${repo}`)).map((v) => ({
      system: v.versionKey.system,
      name: v.versionKey.name,
      relationType: v.relationType,
      relationProvenance: v.relationProvenance,
    }));
  } catch {
    rows = [];
  }
  const allowGo = rows.some((r) => r.system.toUpperCase() === 'GO') ? await hasGoMod(owner, repo) : false;
  const picked = pickPackage(owner, repo, rows, eco, allowGo);
  if (picked) return hints.packageName ? { ...picked, name: hints.packageName, via: 'explicit' } : picked;
  if (hints.packageName) return { ecosystem: eco ?? 'npm', name: hints.packageName, via: 'explicit' };
  return undefined;
}
