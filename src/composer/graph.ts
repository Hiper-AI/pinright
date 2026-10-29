/**
 * Dependency graphs for Composer, which deps.dev does not resolve. Packagist's
 * metadata carries each release's "require"; walking it breadth-first and
 * picking, for every requirement, the newest stable release that satisfies it
 * gives a graph shaped like deps.dev's, resolved the same way: each package on
 * its own, so the result is close to, not identical with, what Composer installs.
 *
 * Skipped: platform packages (php, ext-*, lib-*), virtual packages that only
 * exist as "provide" (psr/http-client-implementation), names that a package
 * already in the graph replaces or provides, and dev branches.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import type { DepsDevGraph } from '../advisories/depsdev.js';
import { compareComposer, pickComposerVersion } from './constraint.js';
import { isPlatformPackage } from './manifest.js';
import { isComposerName, packagistReleases, type PackagistRelease } from './packagist.js';

/** Upper bound on nodes per graph: a framework pulls a few dozen, never hundreds. */
const MAX_NODES = 200;
const CONCURRENCY = 8;
const UNSTABLE = /@(dev|alpha|beta|rc)\b|\d[-_.]?(dev|alpha|beta|rc)/i;

export function isStableComposer(version: string): boolean {
  // A stable release compares at or above its own ".0" stable form; "1.0.0-RC1" compares below.
  const base = version.replace(/^v/i, '').match(/^\d+(?:\.\d+){0,3}/)?.[0];
  return Boolean(base) && (compareComposer(version, base as string) ?? -1) >= 0;
}

/** The release a requirement installs today, on its own: newest stable match, or unstable when the constraint asks for it. */
export function pickRequirement(constraint: string, releases: PackagistRelease[], selfVersion?: string): string | undefined {
  const c = constraint.trim() === 'self.version' && selfVersion ? selfVersion : constraint;
  const all = releases.map((r) => r.version);
  const picked = pickComposerVersion(c, all.filter(isStableComposer));
  if (picked || !UNSTABLE.test(c)) return picked;
  return pickComposerVersion(c, all);
}

async function releasesOf(name: string): Promise<PackagistRelease[] | undefined> {
  // A Packagist hiccup on one dependency leaves that branch out, not the whole graph.
  return packagistReleases(name).catch(() => undefined);
}

async function inChunks<T>(items: T[], fn: (x: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += CONCURRENCY) await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
}

/** The resolved graph of one Composer package version, deps.dev-shaped. Undefined when Packagist does not have that version. */
export async function packagistDependencies(name: string, version: string): Promise<DepsDevGraph | undefined> {
  const n = name.toLowerCase();
  if (!isComposerName(n)) return undefined;
  const root = (await packagistReleases(n))?.find((r) => r.version === version.replace(/^v(?=\d)/i, ''));
  if (!root) return undefined;
  return cached(`packagist:deps:${n}:${root.version}`, config.ttl.versions, () => resolve(n, root));
}

async function resolve(name: string, root: PackagistRelease): Promise<DepsDevGraph> {
  const graph: DepsDevGraph = {
    nodes: [{ versionKey: { system: 'PACKAGIST', name, version: root.version }, relation: 'SELF' }],
    edges: [],
  };
  const index = new Map<string, number>([[name, 0]]);
  const releaseOf: PackagistRelease[] = [root];
  // Names some package in the graph replaces or provides: Composer never installs them separately.
  const covered = new Set<string>();
  const cover = (r: PackagistRelease) => {
    for (const k of Object.keys({ ...r.replace, ...r.provide })) covered.add(k.toLowerCase());
  };
  cover(root);

  let level = [0];
  while (level.length && graph.nodes.length < MAX_NODES) {
    const wanted = new Map<string, { from: number; constraint: string }[]>();
    for (const from of level) {
      for (const [dep, constraint] of Object.entries(releaseOf[from].require ?? {})) {
        const d = dep.toLowerCase();
        if (isPlatformPackage(d) || typeof constraint !== 'string') continue;
        wanted.set(d, [...(wanted.get(d) ?? []), { from, constraint }]);
      }
    }
    const fresh = [...wanted.keys()].filter((d) => !index.has(d) && !covered.has(d) && isComposerName(d));
    const fetched = new Map<string, PackagistRelease[] | undefined>();
    await inChunks(fresh, async (d) => {
      fetched.set(d, await releasesOf(d));
    });
    const next: number[] = [];
    for (const [d, reqs] of wanted) {
      for (const { from, constraint } of reqs) {
        let to = index.get(d);
        if (to === undefined) {
          if (covered.has(d) || graph.nodes.length >= MAX_NODES) continue;
          const releases = fetched.get(d);
          if (!releases?.length) continue; // virtual or unknown package
          const picked = pickRequirement(constraint, releases, graph.nodes[from].versionKey.version);
          const rel = picked ? releases.find((r) => r.version === picked) : undefined;
          if (!rel) continue;
          to = graph.nodes.length;
          graph.nodes.push({ versionKey: { system: 'PACKAGIST', name: d, version: rel.version }, relation: from === 0 ? 'DIRECT' : 'INDIRECT' });
          index.set(d, to);
          releaseOf.push(rel);
          cover(rel);
          next.push(to);
        }
        graph.edges.push({ fromNode: from, toNode: to, requirement: constraint });
      }
    }
    level = next;
  }
  return graph;
}
