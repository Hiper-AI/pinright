/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON from registries, lockfiles and agent hooks, read defensively */
/**
 * Readers for lockfiles and manifests. A lockfile gives the exact tree; a
 * manifest only gives direct dependencies and their ranges, and the tree is
 * then resolved through deps.dev (see resolveManifest.ts).
 *
 * Every reader is a small line-oriented parser on purpose: no YAML/TOML
 * dependency, and a malformed file yields fewer packages, never a crash.
 */
import { parseComposerJson, parseComposerLock } from '../composer/manifest.js';
import { type Ecosystem } from '../ecosystems.js';
import { parseGradleBuild, parseGradleLockfile, parseVersionCatalog } from '../jvm/gradle.js';
import { parsePom } from '../jvm/maven.js';
import type { Constraint } from './constraints.js';

export interface TreePackage {
  name: string;
  version: string;
  /** Declared by the project itself. Undefined when the file does not say. */
  direct?: boolean;
  dev?: boolean;
  /** Chain from a direct dependency down to this package, when known. */
  path?: string[];
  /** Ranges the resolved graphs put on this package (manifests resolved through deps.dev, pip and Composer only). */
  requiredBy?: Constraint[];
}

export interface ParsedTree {
  ecosystem: Ecosystem;
  kind: 'lockfile' | 'manifest';
  file: string;
  packages: TreePackage[];
  /** For manifests: the declared ranges, to be resolved. */
  declared?: { name: string; spec: string; dev?: boolean }[];
}

export const SUPPORTED_FILES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'package.json',
  'requirements.txt', 'poetry.lock', 'uv.lock', 'pdm.lock', 'pyproject.toml',
  'Cargo.lock', 'Cargo.toml', 'go.mod', 'Gemfile.lock', 'packages.lock.json',
  'gradle.lockfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'libs.versions.toml',
  'composer.lock', 'composer.json',
];

/** Which reader to use for a file name. requirements-dev.txt and friends count as requirements. */
export function detectKind(fileName: string): string | undefined {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  if (/^requirements.*\.(txt|in)$/i.test(base)) return 'requirements.txt';
  return SUPPORTED_FILES.find((f) => f.toLowerCase() === base.toLowerCase());
}

export function parseFile(fileName: string, content: string, siblings: Record<string, string> = {}): ParsedTree {
  const kind = detectKind(fileName);
  switch (kind) {
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return parseNpmLock(fileName, content);
    case 'pnpm-lock.yaml':
      return parsePnpmLock(fileName, content);
    case 'yarn.lock':
      return parseYarnLock(fileName, content, siblings['package.json']);
    case 'package.json':
      return parsePackageJson(fileName, content);
    case 'requirements.txt':
      return parseRequirements(fileName, content);
    case 'poetry.lock':
    case 'uv.lock':
    case 'pdm.lock':
      return parseTomlLock(fileName, content, 'pypi', directFromPyproject(siblings['pyproject.toml']));
    case 'pyproject.toml':
      return parsePyproject(fileName, content);
    case 'Cargo.lock':
      return parseTomlLock(fileName, content, 'cargo', directFromCargoToml(siblings['Cargo.toml']));
    case 'Cargo.toml':
      return parseCargoToml(fileName, content);
    case 'go.mod':
      return parseGoMod(fileName, content);
    case 'Gemfile.lock':
      return parseGemfileLock(fileName, content);
    case 'packages.lock.json':
      return parseNugetLock(fileName, content);
    case 'pom.xml':
      return parsePom(fileName, content);
    case 'build.gradle':
    case 'build.gradle.kts':
      return parseGradleBuild(fileName, content, siblings);
    case 'libs.versions.toml':
      return parseVersionCatalog(fileName, content);
    case 'gradle.lockfile':
      return parseGradleLockfile(fileName, content, siblings);
    case 'composer.json':
      return parseComposerJson(fileName, content);
    case 'composer.lock':
      return parseComposerLock(fileName, content, siblings['composer.json']);
    default:
      throw new Error(`Unsupported file "${fileName}". Supported: ${SUPPORTED_FILES.join(', ')}, requirements*.txt.`);
  }
}

// ---------------------------------------------------------------- npm -------

interface NpmLockEntry {
  version?: string;
  dev?: boolean;
  link?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function npmNameFromKey(key: string): string {
  const i = key.lastIndexOf('node_modules/');
  return i >= 0 ? key.slice(i + 'node_modules/'.length) : key;
}

/** Node's lookup: walk up the nested node_modules chain until the name resolves. */
function npmResolve(from: string, dep: string, entries: Record<string, NpmLockEntry>): string | undefined {
  let base = from;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${dep}` : `node_modules/${dep}`;
    if (entries[candidate]) return candidate;
    if (!base) return undefined;
    const i = base.lastIndexOf('/node_modules/');
    base = i >= 0 ? base.slice(0, i) : '';
  }
}

export function parseNpmLock(file: string, content: string): ParsedTree {
  const j = JSON.parse(content) as { packages?: Record<string, NpmLockEntry>; dependencies?: Record<string, unknown> };
  const packages: TreePackage[] = [];
  if (j.packages) {
    const entries = j.packages;
    const root = entries[''] ?? {};
    const directNames = new Set([
      ...Object.keys(root.dependencies ?? {}),
      ...Object.keys(root.devDependencies ?? {}),
      ...Object.keys(root.optionalDependencies ?? {}),
    ]);
    // Breadth-first from the root gives every installed package its shortest chain.
    const pathOf = new Map<string, string[]>();
    const queue: string[] = [];
    for (const name of directNames) {
      const key = npmResolve('', name, entries);
      if (key && !pathOf.has(key)) {
        pathOf.set(key, [name]);
        queue.push(key);
      }
    }
    while (queue.length) {
      const key = queue.shift() as string;
      const e = entries[key];
      const deps = { ...(e.dependencies ?? {}), ...(e.optionalDependencies ?? {}), ...(e.peerDependencies ?? {}) };
      for (const dep of Object.keys(deps)) {
        const child = npmResolve(key, dep, entries);
        if (child && !pathOf.has(child)) {
          pathOf.set(child, [...(pathOf.get(key) as string[]), dep]);
          queue.push(child);
        }
      }
    }
    for (const [key, e] of Object.entries(entries)) {
      if (!key || e.link || !e.version || !key.includes('node_modules/')) continue;
      const name = npmNameFromKey(key);
      const path = pathOf.get(key);
      packages.push({ name, version: e.version, direct: key === `node_modules/${name}` && directNames.has(name), dev: Boolean(e.dev), path });
    }
  } else if (j.dependencies) {
    // lockfileVersion 1: a nested tree.
    const walk = (deps: Record<string, any>, chain: string[]) => {
      for (const [name, d] of Object.entries(deps)) {
        if (!d?.version || String(d.version).startsWith('file:')) continue;
        const path = [...chain, name];
        packages.push({ name, version: d.version, direct: chain.length === 0, dev: Boolean(d.dev), path });
        if (d.dependencies) walk(d.dependencies, path);
      }
    };
    walk(j.dependencies as Record<string, any>, []);
  }
  return { ecosystem: 'npm', kind: 'lockfile', file, packages };
}

/** "@scope/name@1.2.3(peer@1)" -> ["@scope/name", "1.2.3"] */
function splitNameAtVersion(s: string): [string, string] | undefined {
  const clean = s.replace(/^\/+/, '').replace(/\(.*$/, '');
  const at = clean.lastIndexOf('@');
  if (at <= 0) return undefined;
  return [clean.slice(0, at), clean.slice(at + 1)];
}

export function parsePnpmLock(file: string, content: string): ParsedTree {
  const lines = content.split(/\r?\n/);
  const packages: TreePackage[] = [];
  const direct = new Set<string>();
  let section = '';
  let inRootImporter = false;
  let inRootDeps = false;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, '');
      inRootImporter = false;
      inRootDeps = false;
      continue;
    }
    if (section === 'importers') {
      if (/^ {2}\S/.test(line)) inRootImporter = /^ {2}['"]?\.['"]?:/.test(line);
      else if (inRootImporter && /^ {4}\S/.test(line)) inRootDeps = /^ {4}(dependencies|devDependencies|optionalDependencies):/.test(line);
      else if (inRootImporter && inRootDeps && /^ {6}\S/.test(line)) direct.add(line.trim().replace(/:.*$/, '').replace(/^['"]|['"]$/g, ''));
    }
    // pnpm v6-v8 kept the root deps at top level, without importers.
    if ((section === 'dependencies' || section === 'devDependencies') && /^ {2}\S/.test(line)) {
      direct.add(line.trim().replace(/:.*$/, '').replace(/^['"]|['"]$/g, ''));
    }
    if (section === 'packages' && /^ {2}\S/.test(line) && line.trim().endsWith(':')) {
      const key = line.trim().slice(0, -1).replace(/^['"]|['"]$/g, '');
      const nv = splitNameAtVersion(key);
      if (nv && /^\d/.test(nv[1])) packages.push({ name: nv[0], version: nv[1] });
    }
  }
  for (const p of packages) p.direct = direct.has(p.name);
  return { ecosystem: 'npm', kind: 'lockfile', file, packages: dedupe(packages) };
}

export function parseYarnLock(file: string, content: string, packageJson?: string): ParsedTree {
  const packages: TreePackage[] = [];
  let currentName: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (/^\S/.test(line)) {
      // `"a@^1.0.0", a@^1.1.0:` (v1) or `"a@npm:^1.0.0":` (berry)
      const first = line.split(',')[0].trim().replace(/:$/, '').replace(/^"|"$/g, '');
      if (first.startsWith('__metadata')) {
        currentName = undefined;
        continue;
      }
      const at = first.lastIndexOf('@');
      currentName = at > 0 ? first.slice(0, at) : undefined;
      if (first.includes('@workspace:') || first.includes('@patch:')) currentName = undefined;
      continue;
    }
    const m = line.match(/^ {2}version:? "?([^"\s]+)"?/);
    if (m && currentName) {
      packages.push({ name: currentName, version: m[1] });
      currentName = undefined;
    }
  }
  const direct = new Set<string>();
  if (packageJson) {
    try {
      const pj = JSON.parse(packageJson);
      for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) Object.keys(pj[k] ?? {}).forEach((n) => direct.add(n));
    } catch {
      // No usable package.json: direct stays unknown.
    }
  }
  const out = dedupe(packages);
  if (direct.size) for (const p of out) p.direct = direct.has(p.name);
  return { ecosystem: 'npm', kind: 'lockfile', file, packages: out };
}

export function parsePackageJson(file: string, content: string): ParsedTree {
  const pj = JSON.parse(content);
  const declared: { name: string; spec: string; dev?: boolean }[] = [];
  for (const [name, spec] of Object.entries<string>(pj.dependencies ?? {})) declared.push({ name, spec });
  for (const [name, spec] of Object.entries<string>(pj.optionalDependencies ?? {})) declared.push({ name, spec });
  for (const [name, spec] of Object.entries<string>(pj.devDependencies ?? {})) declared.push({ name, spec, dev: true });
  return { ecosystem: 'npm', kind: 'manifest', file, packages: [], declared };
}

// ---------------------------------------------------------------- Python ----

export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * requirements.txt. When every line is pinned with == it is treated as a lock
 * (pip-compile output); `# via` comments give the parent. Otherwise it is a manifest.
 */
export function parseRequirements(file: string, content: string): ParsedTree {
  const lines = content.split(/\r?\n/);
  const pinned: TreePackage[] = [];
  const declared: { name: string; spec: string }[] = [];
  let last: TreePackage | undefined;
  let inVia = false;
  for (const raw of lines) {
    const viaInline = raw.match(/#\s*via\s+(\S.*)$/);
    const line = raw.replace(/#.*/, '').replace(/\\$/, '').trim();
    if (!line) {
      const via = raw.match(/^\s*#\s*via(?:\s+(\S.*))?$/);
      const parentOf = (parent: string) => {
        if (!last) return;
        if (/^-[rc]\b/.test(parent)) last.direct = true;
        else if (!last.path) last.path = [normalizePypiName(parent), last.name];
      };
      if (via) {
        inVia = !via[1];
        if (via[1]) parentOf(via[1].trim());
      } else if (inVia && /^\s*#\s+(\S+)/.test(raw)) {
        parentOf(raw.replace(/^\s*#\s+/, '').trim());
      }
      continue;
    }
    inVia = false;
    if (line.startsWith('-') || line.startsWith('--')) continue;
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]*\])?\s*(.*)$/);
    if (!m) continue;
    const name = normalizePypiName(m[1]);
    const spec = m[2].split(';')[0].trim();
    const eq = spec.match(/^===?\s*([^,\s]+)$/);
    if (eq) {
      last = { name, version: eq[1] };
      if (viaInline) {
        const parent = viaInline[1].trim();
        if (parent.startsWith('-r')) last.direct = true;
        else last.path = [normalizePypiName(parent), name];
      }
      pinned.push(last);
    } else {
      last = undefined;
    }
    declared.push({ name, spec });
  }
  const allPinned = declared.length > 0 && pinned.length === declared.length;
  if (allPinned) {
    // Hand-written pinned files carry no `# via`: every line is a direct dependency.
    const anyVia = pinned.some((p) => p.path || p.direct);
    for (const p of pinned) if (!anyVia) p.direct = true;
    return { ecosystem: 'pypi', kind: 'lockfile', file, packages: pinned };
  }
  return { ecosystem: 'pypi', kind: 'manifest', file, packages: [], declared };
}

/** PEP 621 `dependencies = [...]` and Poetry `[tool.poetry.dependencies]`. */
export function parsePyproject(file: string, content: string): ParsedTree {
  const declared: { name: string; spec: string; dev?: boolean }[] = [];
  // The closing bracket is the one outside quotes: extras like "httpx[http2]" contain brackets too.
  const arr = content.match(/^\s*dependencies\s*=\s*\[((?:"[^"]*"|'[^']*'|[^\]"'])*)\]/m);
  if (arr) {
    for (const s of arr[1].matchAll(/["']([^"']+)["']/g)) {
      const m = s[1].match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]*\])?\s*(.*)$/);
      if (m) declared.push({ name: normalizePypiName(m[1]), spec: m[2].split(';')[0].trim() });
    }
  }
  const poetry = content.match(/^\[tool\.poetry\.dependencies\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m);
  if (poetry) {
    for (const line of poetry[1].split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)")/);
      if (m && m[1].toLowerCase() !== 'python') declared.push({ name: normalizePypiName(m[1]), spec: m[2] ?? m[3] ?? '' });
    }
  }
  return { ecosystem: 'pypi', kind: 'manifest', file, packages: [], declared };
}

function directFromPyproject(content?: string): Set<string> | undefined {
  if (!content) return undefined;
  return new Set((parsePyproject('pyproject.toml', content).declared ?? []).map((d) => d.name));
}

/** poetry.lock, uv.lock, pdm.lock and Cargo.lock all list `[[package]]` with name and version. */
export function parseTomlLock(file: string, content: string, ecosystem: Ecosystem, direct?: Set<string>): ParsedTree {
  const packages: TreePackage[] = [];
  for (const block of content.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    // uv.lock lists the project itself as a virtual/editable source.
    if (!name || !version || /source\s*=\s*\{\s*(editable|virtual)\s*=/.test(block)) continue;
    const n = ecosystem === 'pypi' ? normalizePypiName(name) : name;
    packages.push({ name: n, version, direct: direct ? direct.has(n) : undefined });
  }
  return { ecosystem, kind: 'lockfile', file, packages: dedupe(packages) };
}

// ---------------------------------------------------------------- Rust ------

function cargoDeps(content: string): { name: string; spec: string; dev?: boolean }[] {
  const out: { name: string; spec: string; dev?: boolean }[] = [];
  const sections = content.split(/^\[/m);
  for (const sec of sections) {
    const header = sec.split(/\r?\n/)[0].replace(/\]\s*$/, '');
    if (!/^(dependencies|dev-dependencies|build-dependencies|target\..*\.dependencies)$/.test(header)) continue;
    const dev = header === 'dev-dependencies';
    for (const line of sec.split(/\r?\n/).slice(1)) {
      const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|\{([^}]*)\})/);
      if (!m) continue;
      if (m[3] && /\b(path|git)\s*=/.test(m[3]) && !/\bversion\s*=/.test(m[3])) continue;
      const pkg = m[3]?.match(/package\s*=\s*"([^"]+)"/)?.[1];
      const spec = m[2] ?? m[3]?.match(/version\s*=\s*"([^"]+)"/)?.[1] ?? '';
      out.push({ name: pkg ?? m[1], spec, dev });
    }
  }
  return out;
}

export function parseCargoToml(file: string, content: string): ParsedTree {
  return { ecosystem: 'cargo', kind: 'manifest', file, packages: [], declared: cargoDeps(content) };
}

function directFromCargoToml(content?: string): Set<string> | undefined {
  return content ? new Set(cargoDeps(content).map((d) => d.name)) : undefined;
}

// ---------------------------------------------------------------- Go --------

/** go.mod lists the whole module graph since Go 1.17; `// indirect` marks transitive ones. */
export function parseGoMod(file: string, content: string): ParsedTree {
  const packages: TreePackage[] = [];
  const add = (line: string) => {
    const m = line.trim().match(/^([^\s]+)\s+(v[^\s]+)(\s*\/\/\s*indirect)?/);
    if (m) packages.push({ name: m[1], version: m[2], direct: !m[3] });
  };
  let inBlock = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^require\s*\($/.test(line.trim())) inBlock = true;
    else if (inBlock && line.trim() === ')') inBlock = false;
    else if (inBlock) add(line);
    else if (/^require\s+\S/.test(line.trim())) add(line.trim().replace(/^require\s+/, ''));
  }
  return { ecosystem: 'go', kind: 'lockfile', file, packages };
}

// ---------------------------------------------------------------- Ruby / .NET

export function parseGemfileLock(file: string, content: string): ParsedTree {
  const packages: TreePackage[] = [];
  const direct = new Set<string>();
  let section = '';
  for (const line of content.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      section = line.trim();
      continue;
    }
    if (section === 'GEM') {
      const m = line.match(/^ {4}([^\s(]+) \(([^)]+)\)$/);
      if (m) packages.push({ name: m[1], version: m[2].replace(/-.*$/, '') });
    } else if (section === 'DEPENDENCIES') {
      const m = line.match(/^ {2}([^\s(!]+)/);
      if (m) direct.add(m[1]);
    }
  }
  for (const p of packages) p.direct = direct.has(p.name);
  return { ecosystem: 'rubygems', kind: 'lockfile', file, packages: dedupe(packages) };
}

export function parseNugetLock(file: string, content: string): ParsedTree {
  const j = JSON.parse(content) as { dependencies?: Record<string, Record<string, { type?: string; resolved?: string }>> };
  const packages: TreePackage[] = [];
  for (const fw of Object.values(j.dependencies ?? {})) {
    for (const [name, d] of Object.entries(fw)) {
      if (!d.resolved || d.type === 'Project') continue;
      packages.push({ name, version: d.resolved, direct: d.type === 'Direct' });
    }
  }
  return { ecosystem: 'nuget', kind: 'lockfile', file, packages: dedupe(packages) };
}

function dedupe(list: TreePackage[]): TreePackage[] {
  const seen = new Map<string, TreePackage>();
  for (const p of list) {
    const k = `${p.name}@${p.version}`;
    const prev = seen.get(k);
    if (!prev) seen.set(k, p);
    else if (p.direct) prev.direct = true;
  }
  return [...seen.values()];
}
