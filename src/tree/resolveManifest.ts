/**
 * A manifest without a lockfile names direct dependencies and ranges. To audit
 * the tree we pick the version each range would install today and ask deps.dev
 * for that version's resolved graph. deps.dev resolves each package on its own,
 * so the union is close to, not identical with, what the package manager would
 * install. The report says so.
 */
import semver from 'semver';
import { getDependencies, getPackage, type DepsDevVersionSummary } from '../advisories/depsdev.js';
import { compareVersionsDesc, isPrerelease } from '../advisories/resolve.js';
import { pickComposerVersion } from '../composer/constraint.js';
import { type Ecosystem } from '../ecosystems.js';
import { pickMavenVersion } from '../jvm/maven.js';
import { type ParsedTree, type TreePackage, normalizePypiName } from './lockfiles.js';

export const GRAPH_ECOSYSTEMS: Ecosystem[] = ['npm', 'pypi', 'cargo', 'maven', 'composer'];

/** PEP 440 release tuple, enough to order and compare ordinary versions. */
function pep440(v: string): number[] {
  const m = v.match(/^(\d+(?:\.\d+)*)/);
  return m ? m[1].split('.').map(Number) : [];
}

function cmpTuple(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function satisfiesPep440(version: string, spec: string): boolean {
  const v = pep440(version);
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(~=|===|==|!=|>=|<=|>|<)\s*(.+)$/);
    if (!m) continue;
    const [, op, raw] = m;
    if (raw.endsWith('.*')) {
      const prefix = pep440(raw.slice(0, -2));
      const matches = prefix.every((n, i) => v[i] === n);
      if ((op === '==' && !matches) || (op === '!=' && matches)) return false;
      continue;
    }
    const t = pep440(raw);
    const c = cmpTuple(v, t);
    if ((op === '==' || op === '===') && c !== 0) return false;
    if (op === '!=' && c === 0) return false;
    if (op === '>=' && c < 0) return false;
    if (op === '<=' && c > 0) return false;
    if (op === '>' && c <= 0) return false;
    if (op === '<' && c >= 0) return false;
    if (op === '~=') {
      const upper = t.slice(0, Math.max(1, t.length - 1));
      upper[upper.length - 1] += 1;
      if (c < 0 || cmpTuple(v, upper) >= 0) return false;
    }
  }
  return true;
}

/** The version a package manager would pick today for this spec, or undefined. */
export function pickVersion(eco: Ecosystem, spec: string, versions: DepsDevVersionSummary[]): string | undefined {
  const stable = [...versions].filter((v) => !isPrerelease(v.versionKey.version)).sort(compareVersionsDesc);
  const def = versions.find((v) => v.isDefault)?.versionKey.version ?? stable[0]?.versionKey.version;
  const s = spec.trim();
  if (!s || s === '*' || s === 'latest') return def;
  const names = stable.map((v) => v.versionKey.version);
  if (eco === 'pypi') return names.find((v) => satisfiesPep440(v, s));
  if (eco === 'npm' || eco === 'cargo') {
    if (/^(file:|link:|git|https?:|github:|workspace:|npm:)/.test(s)) return undefined;
    // Cargo's bare "1.2" means "^1.2".
    const range = eco === 'cargo' && /^\d/.test(s) ? `^${s}` : s;
    if (names.includes(s)) return s;
    return semver.maxSatisfying(names, range, { loose: true }) ?? undefined;
  }
  if (eco === 'composer') return pickComposerVersion(s, names);
  if (eco === 'maven') {
    // An exact Maven version is a pin even when it is a milestone; ranges and "1.+" pick among releases.
    if (versions.some((v) => v.versionKey.version === s)) return s;
    return pickMavenVersion(s, names, def);
  }
  return names.includes(s) ? s : def;
}

/** Resolve a manifest's declared ranges into a tree with paths. */
export async function resolveManifest(tree: ParsedTree, notes: string[]): Promise<TreePackage[]> {
  const eco = tree.ecosystem;
  const out = new Map<string, TreePackage>();
  for (const d of tree.declared ?? []) {
    const name = eco === 'pypi' ? normalizePypiName(d.name) : d.name;
    const pkg = await getPackage(eco, name).catch(() => undefined);
    if (!pkg) {
      notes.push(`${name}: not found in the ${eco} registry (${eco === 'composer' ? 'Packagist' : 'deps.dev'}).`);
      continue;
    }
    const version = pickVersion(eco, d.spec, pkg.versions);
    if (!version) {
      notes.push(`${name}: no published version satisfies "${d.spec}".`);
      continue;
    }
    out.set(`${name}@${version}`, { name, version, direct: true, dev: d.dev, path: [name] });
    if (!GRAPH_ECOSYSTEMS.includes(eco)) continue;
    const graph = await getDependencies(eco, name, version).catch(() => undefined);
    if (!graph?.nodes?.length) {
      notes.push(`${name}@${version}: ${eco === 'composer' ? 'Packagist' : 'deps.dev'} has no resolved graph; only the package itself was checked.`);
      continue;
    }
    // Breadth-first from SELF so every node gets its shortest chain.
    const paths = new Map<number, string[]>([[0, [name]]]);
    const queue = [0];
    while (queue.length) {
      const from = queue.shift() as number;
      for (const e of graph.edges.filter((x) => x.fromNode === from)) {
        if (paths.has(e.toNode)) continue;
        paths.set(e.toNode, [...(paths.get(from) as string[]), graph.nodes[e.toNode].versionKey.name]);
        queue.push(e.toNode);
      }
    }
    graph.nodes.forEach((n, i) => {
      if (i === 0) return;
      const nm = eco === 'pypi' ? normalizePypiName(n.versionKey.name) : n.versionKey.name;
      const key = `${nm}@${n.versionKey.version}`;
      if (!out.has(key)) out.set(key, { name: nm, version: n.versionKey.version, direct: false, dev: d.dev, path: paths.get(i) });
    });
  }
  return [...out.values()];
}
