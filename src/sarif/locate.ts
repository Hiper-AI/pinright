/**
 * Where a package is declared in a dependency file: the line (and the columns
 * of the name) for a SARIF region, so a code-scanning alert lands on the entry
 * that brings the package in. Line-based like the readers in tree/lockfiles.ts;
 * when nothing matches the caller falls back to the top of the file.
 */
import { type Ecosystem } from '../ecosystems.js';
import { detectKind } from '../tree/lockfiles.js';

export interface Region {
  startLine: number;
  startColumn: number;
  endColumn: number;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** PyPI treats "-", "_" and "." alike and ignores case: "Typing_Extensions" is "typing-extensions". */
const pyName = (name: string) => name.split(/[-_.]+/).map(esc).join('[-_.]+');

function region(lines: string[], i: number, needle?: string | RegExp): Region {
  const text = lines[i];
  let start = 0;
  let len = text.trimEnd().length;
  if (needle) {
    const m = typeof needle === 'string' ? { index: text.toLowerCase().indexOf(needle.toLowerCase()), 0: needle } : needle.exec(text);
    if (m && (m.index ?? -1) >= 0) {
      start = m.index as number;
      len = m[0].length;
    }
  } else {
    start = text.length - text.trimStart().length;
    len -= start;
  }
  return { startLine: i + 1, startColumn: start + 1, endColumn: start + 1 + Math.max(len, 1) };
}

/** First line matching `re`, or with a version check in the next few lines the one that matches it. */
function entry(lines: string[], re: RegExp, versionRe: RegExp | undefined, needle: string | RegExp, span = 8): Region | undefined {
  let first: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    first ??= i;
    if (!versionRe) break;
    if (versionRe.test(lines[i]) || lines.slice(i + 1, i + 1 + span).some((l) => versionRe.test(l))) return region(lines, i, needle);
  }
  return first === undefined ? undefined : region(lines, first, needle);
}

/** Lines inside JSON objects whose key matches `section` ("dependencies", "require-dev"...). */
function inJsonSection(lines: string[], section: RegExp, key: RegExp, needle: string): Region | undefined {
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (depth === 0) {
      if (section.test(l) && /\{\s*$/.test(l)) depth = 1;
      continue;
    }
    if (key.test(l)) return region(lines, i, needle);
    depth += (l.match(/\{/g)?.length ?? 0) - (l.match(/\}/g)?.length ?? 0);
    if (depth <= 0) depth = 0;
  }
  return undefined;
}

/** Lines inside TOML tables whose header matches `table`. */
function inTomlTable(lines: string[], table: RegExp, key: RegExp, needle: RegExp | string): Region | undefined {
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/);
    if (header) {
      inside = table.test(header[1].trim());
      continue;
    }
    if (inside && key.test(lines[i])) return region(lines, i, needle);
  }
  return undefined;
}

const versionLine = (version: string | undefined, re: (v: string) => RegExp) => (version ? re(esc(version.replace(/^v/, ''))) : undefined);

/**
 * The region declaring `name` (at `version`, when the file lists several) in a
 * dependency file, or undefined when it cannot be told.
 */
export function locatePackage(file: string, content: string, eco: Ecosystem, name: string, version?: string): Region | undefined {
  const lines = content.split(/\r?\n/);
  const n = esc(name);
  const kind = detectKind(file);
  switch (kind) {
    case 'package.json':
      return inJsonSection(lines, /"(?:dev|peer|optional|bundle)?[dD]ependencies"\s*:/, new RegExp(`^\\s*"${n}"\\s*:`), name);
    case 'package-lock.json':
    case 'npm-shrinkwrap.json': {
      // v2/v3: "node_modules/a/node_modules/name": {; v1: "name": { under "dependencies".
      const key = new RegExp(`^\\s*"(?:[^"]*node_modules/)?${n}"\\s*:\\s*\\{`);
      const ver = versionLine(version, (v) => new RegExp(`^\\s*"version"\\s*:\\s*"${v}"`));
      // The shallowest copy first: "node_modules/name" sorts before nested ones in npm's output.
      return entry(lines, key, ver, new RegExp(`${n}(?=")`), 3) ?? generic(lines, name);
    }
    case 'pnpm-lock.yaml': {
      const v = version ? esc(version) : '[^\'"(:\\s]+';
      return (
        entry(lines, new RegExp(`^\\s*['"]?/?${n}[@/]${v}(?:[('":]|$)`), undefined, new RegExp(n)) ??
        entry(lines, new RegExp(`^\\s+['"]?${n}['"]?\\s*:\\s*$`), undefined, new RegExp(n)) ??
        generic(lines, name)
      );
    }
    case 'yarn.lock': {
      const header = new RegExp(`^(?:"?|.*,\\s*"?)${n}@`);
      const ver = versionLine(version, (x) => new RegExp(`^\\s+version:?\\s+"?${x}"?\\s*$`));
      return entry(lines, header, ver, new RegExp(`${n}@`), 2) ?? generic(lines, name);
    }
    case 'requirements.txt':
      return entry(lines, new RegExp(`^\\s*${pyName(name)}\\s*(?:\\[[^\\]]*\\])?\\s*(?:[=<>!~;@#]|$)`, 'i'), undefined, new RegExp(pyName(name), 'i'));
    case 'pyproject.toml': {
      const quoted = new RegExp(`["']${pyName(name)}\\s*(?:\\[[^\\]]*\\])?\\s*(?:[=<>!~;@]|["'])`, 'i');
      const needle = new RegExp(pyName(name), 'i');
      const pep621 = entry(lines, quoted, undefined, needle);
      const poetry = inTomlTable(lines, /dependencies$/, new RegExp(`^\\s*["']?${pyName(name)}["']?\\s*=`, 'i'), needle);
      if (pep621 && poetry) return pep621.startLine < poetry.startLine ? pep621 : poetry;
      return pep621 ?? poetry;
    }
    case 'poetry.lock':
    case 'uv.lock':
    case 'pdm.lock':
    case 'Cargo.lock': {
      const nm = eco === 'pypi' ? pyName(name) : n;
      const ver = versionLine(version, (v) => new RegExp(`^\\s*version\\s*=\\s*"${v}"`));
      return entry(lines, new RegExp(`^\\s*name\\s*=\\s*"${nm}"`, eco === 'pypi' ? 'i' : ''), ver, new RegExp(nm, 'i'), 2);
    }
    case 'Cargo.toml':
      return (
        inTomlTable(lines, /dependencies$/, new RegExp(`^\\s*["']?${n}["']?\\s*=`), name) ??
        entry(lines, new RegExp(`^\\s*\\[(?:.*\\.)?(?:dev-|build-)?dependencies\\.${n}\\]`), undefined, name)
      );
    case 'go.mod':
      return entry(lines, new RegExp(`^\\s*(?:require\\s+)?${n}\\s+v`), undefined, name);
    case 'Gemfile.lock': {
      const v = version ? esc(version) : '[^)]+';
      return entry(lines, new RegExp(`^ {4}${n} \\(${v}\\)`), undefined, name) ?? entry(lines, new RegExp(`^\\s+${n}( |$)`), undefined, name);
    }
    case 'packages.lock.json':
      return entry(lines, new RegExp(`^\\s*"${n}"\\s*:\\s*\\{`, 'i'), undefined, name);
    case 'pom.xml':
    case 'build.gradle':
    case 'build.gradle.kts':
    case 'libs.versions.toml':
    case 'gradle.lockfile':
      return locateMaven(lines, kind, name, version);
    case 'composer.json':
      return inJsonSection(lines, /"require(?:-dev)?"\s*:/, new RegExp(`^\\s*"${n}"\\s*:`, 'i'), name);
    case 'composer.lock': {
      const ver = versionLine(version, (v) => new RegExp(`^\\s*"version"\\s*:\\s*"v?${v}"`));
      return entry(lines, new RegExp(`^\\s*"name"\\s*:\\s*"${n}"`, 'i'), ver, name, 3);
    }
    default:
      return generic(lines, name);
  }
}

function locateMaven(lines: string[], kind: string, name: string, version?: string): Region | undefined {
  const [group, artifact] = name.split(':');
  if (!group || !artifact) return generic(lines, name);
  const g = esc(group);
  const a = esc(artifact);
  if (kind === 'pom.xml') {
    const art = new RegExp(`<artifactId>\\s*${a}\\s*</artifactId>`);
    const grp = new RegExp(`<groupId>\\s*${g}\\s*</groupId>`);
    for (let i = 0; i < lines.length; i++) {
      if (!art.test(lines[i])) continue;
      // The groupId of the same <dependency> (or <parent>, <plugin>) block, not of a neighbor.
      let from = i;
      while (from > 0 && from > i - 10 && !/<(dependency|parent|plugin|extension)>/.test(lines[from])) from--;
      let to = i;
      while (to < lines.length - 1 && to < i + 10 && !/<\/(dependency|parent|plugin|extension)>/.test(lines[to])) to++;
      if (lines.slice(from, to + 1).some((l) => grp.test(l))) return region(lines, i, artifact);
    }
    return undefined;
  }
  if (kind === 'gradle.lockfile') {
    const v = version ? esc(version) : '[^=]+';
    return entry(lines, new RegExp(`^${g}:${a}:${v}=`), undefined, name);
  }
  // Gradle scripts and version catalogs: "g:a:1.0", module = "g:a", or group = "g", name = "a".
  const coord = entry(lines, new RegExp(`["']${g}:${a}(?::|["'])`), undefined, name);
  if (coord) return coord;
  return entry(lines, new RegExp(`group\\s*[:=]\\s*["']${g}["'].*name\\s*[:=]\\s*["']${a}["']`), undefined, artifact);
}

/** Last resort: the first line naming the package as a whole word. */
function generic(lines: string[], name: string): Region | undefined {
  const re = new RegExp(`(^|[^\\w@/.-])${esc(name)}(?![\\w-])`);
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) {
      const start = m.index + m[1].length;
      return { startLine: i + 1, startColumn: start + 1, endColumn: start + 1 + name.length };
    }
  }
  return undefined;
}

/** The `uses:` value on a workflow line, for the region of an Actions finding. */
export function locateUses(content: string, line: number): Region {
  const lines = content.split(/\r?\n/);
  const text = lines[line - 1] ?? '';
  const m = /uses\s*:\s*["']?([^"'\s#]+)/.exec(text);
  if (!m) return { startLine: line, startColumn: 1, endColumn: Math.max(text.length, 1) + 1 };
  const start = m.index + m[0].length - m[1].length;
  return { startLine: line, startColumn: start + 1, endColumn: start + 1 + m[1].length };
}
