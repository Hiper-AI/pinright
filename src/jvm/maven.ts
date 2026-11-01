/**
 * pom.xml, read with a few regular expressions instead of an XML parser: we
 * only need <dependency> coordinates and the <properties> their versions use.
 * A dependency without a version (managed by a parent or a BOM) or with a
 * property we cannot resolve from the same file is left out: checking some
 * other version would be a guess.
 */
import type { ParsedTree } from '../tree/lockfiles.js';

export interface JvmDependency {
  /** "groupId:artifactId", the name deps.dev and OSV use for Maven. */
  name: string;
  spec: string;
  dev?: boolean;
}

const tag = (block: string, name: string) => block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`))?.[1];

function stripBlocks(xml: string, names: string[]): string {
  let out = xml;
  for (const n of names) out = out.replace(new RegExp(`<${n}>[\\s\\S]*?</${n}>`, 'g'), '');
  return out;
}

/** <properties> plus project.version / project.groupId, for ${...} interpolation. */
export function pomProperties(xml: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const block of xml.match(/<properties>[\s\S]*?<\/properties>/g) ?? []) {
    for (const m of block.matchAll(/<([A-Za-z0-9_.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props.set(m[1], m[2]);
  }
  const top = stripBlocks(xml, ['parent', 'dependencies', 'dependencyManagement', 'build', 'profiles', 'properties', 'reporting', 'plugins']);
  const parent = xml.match(/<parent>[\s\S]*?<\/parent>/)?.[0] ?? '';
  const version = tag(top, 'version') ?? tag(parent, 'version');
  const group = tag(top, 'groupId') ?? tag(parent, 'groupId');
  if (version) {
    props.set('project.version', version);
    props.set('version', version);
  }
  if (group) props.set('project.groupId', group);
  if (tag(parent, 'version')) props.set('project.parent.version', tag(parent, 'version') as string);
  return props;
}

/** Replace ${x} from props; undefined when something stays unresolved. */
export function interpolate(value: string, props: Map<string, string>): string | undefined {
  let v = value;
  for (let i = 0; i < 5 && v.includes('${'); i++) v = v.replace(/\$\{([^}]+)\}/g, (all, k: string) => props.get(k) ?? all);
  return v.includes('${') ? undefined : v;
}

export function pomDependencies(content: string): JvmDependency[] {
  const xml = content.replace(/<!--[\s\S]*?-->/g, '');
  const props = pomProperties(xml);
  // Build plugins and their own dependencies are not part of the application's classpath.
  const body = stripBlocks(xml, ['build', 'reporting', 'pluginRepositories']);
  const out: JvmDependency[] = [];
  for (const m of body.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const g = tag(m[1], 'groupId');
    const a = tag(m[1], 'artifactId');
    const v = tag(m[1], 'version');
    if (!g || !a || !v) continue;
    const group = interpolate(g, props);
    const artifact = interpolate(a, props);
    const version = interpolate(v, props);
    if (!group || !artifact || !version) continue;
    out.push({ name: `${group}:${artifact}`, spec: version, dev: tag(m[1], 'scope') === 'test' ? true : undefined });
  }
  return out;
}

export function parsePom(file: string, content: string): ParsedTree {
  return { ecosystem: 'maven', kind: 'manifest', file, packages: [], declared: pomDependencies(content) };
}

// ------------------------------------------------------------ versions -----

function tuple(v: string): (number | string)[] {
  return v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p.toLowerCase()));
}

/** Maven-ish ordering: numeric parts numerically, a qualifier ("-beta1") before the bare release. */
export function compareMaven(a: string, b: string): number {
  const ta = tuple(a);
  const tb = tuple(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === y) continue;
    if (x === undefined) return typeof y === 'number' ? (y === 0 ? 0 : -1) : 1;
    if (y === undefined) return typeof x === 'number' ? (x === 0 ? 0 : 1) : -1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return 1;
    if (typeof y === 'number') return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** "[1.0,2.0)", "(,1.5]", "[1.2]" and "1.+" (Gradle). Undefined when the spec is neither. */
export function satisfiesMavenSpec(version: string, spec: string): boolean | undefined {
  const s = spec.trim();
  if (s.endsWith('+')) return version.startsWith(s.slice(0, -1));
  if (!/^[[(]/.test(s)) return undefined;
  // A union of ranges: "[1.0,1.5),[2.0,)".
  const ranges = s.match(/[[(][^\])]*[\])]/g) ?? [];
  if (!ranges.length) return undefined;
  return ranges.some((r) => {
    const inner = r.slice(1, -1);
    if (!inner.includes(',')) return compareMaven(version, inner.trim()) === 0;
    const [lo, hi] = inner.split(',').map((x) => x.trim());
    if (lo && (r[0] === '[' ? compareMaven(version, lo) < 0 : compareMaven(version, lo) <= 0)) return false;
    if (hi && (r.endsWith(']') ? compareMaven(version, hi) > 0 : compareMaven(version, hi) >= 0)) return false;
    return true;
  });
}

/** The version Maven/Gradle would pick from `stable` (any order), or undefined. */
export function pickMavenVersion(spec: string, stable: string[], fallback?: string): string | undefined {
  const s = spec.trim();
  if (!s || /^latest\.(release|integration)$/.test(s) || s === '+') return fallback;
  if (stable.includes(s)) return s;
  const ok = stable.filter((v) => satisfiesMavenSpec(v, s) === true);
  if (ok.length) return ok.sort(compareMaven).pop();
  return undefined;
}
