/**
 * Imports nobody declared. An agent can pin every dependency it lists and still
 * write `from langchain_text_splitters import ...` without listing
 * langchain-text-splitters: the hook passes, the import fails. When the agent
 * writes a source file, its new imports are compared with the manifests above
 * it; when it writes a manifest, the project's source files are. The answer is
 * only ever a note (never a block), with a pinned clean version to add.
 *
 * Conservative on purpose: stdlib and Node builtins, relative and aliased
 * imports, project-local modules, imports guarded by try/if (optional
 * dependencies), and names the registry does not know are all left alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { type Ecosystem, installCommand } from '../ecosystems.js';
import { PYTHON_STDLIB, npmPackageOf, pythonAliasesOf, pythonDistributions } from '../data/importNames.js';
import { normalizePypiName, parseFile } from '../tree/lockfiles.js';
import { checkPackage } from '../verdict.js';

type Lang = 'python' | 'js';

const PY_SOURCE = /\.pyw?$/i;
const JS_SOURCE = /\.(m|c)?(j|t)sx?$|\.(vue|svelte|astro)$/i;
const PY_MANIFEST = /(^|[\\/])(requirements[^\\/]*\.(txt|in)|pyproject\.toml)$/i;
const JS_MANIFEST = /(^|[\\/])package\.json$/i;
const SKIP_DIRS = /^(node_modules|__pycache__|site-packages|dist|build|out|coverage|target|vendor|venv|env|\..*)$/i;

const MAX_FILES = 400;
const MAX_ENTRIES = 5000;
const MAX_BYTES = 256_000;
const MAX_DEPTH = 6;
const MAX_REPORTED = 6;
const UP_LEVELS = 6;

export function languageOf(file: string): { lang: Lang; manifest: boolean } | undefined {
  if (/node_modules|[\\/]site-packages[\\/]|[\\/]\.?venv[\\/]/.test(file)) return undefined;
  if (PY_MANIFEST.test(file)) return { lang: 'python', manifest: true };
  if (JS_MANIFEST.test(file)) return { lang: 'js', manifest: true };
  if (PY_SOURCE.test(file)) return { lang: 'python', manifest: false };
  if (JS_SOURCE.test(file) && !/\.d\.[mc]?ts$/i.test(file)) return { lang: 'js', manifest: false };
  return undefined;
}

// ---------------------------------------------------------------- parsing ---

/**
 * Absolute imports of a Python file ("a.b.c"), skipping relative ones and the ones
 * inside try/except or if/else blocks: those are optional or version-dependent.
 */
export function pythonImports(source: string): string[] {
  // Blank out docstrings and other triple-quoted strings, keeping the line count.
  const text = source.replace(/("""|''')[\s\S]*?\1/g, (m) => m.replace(/[^\n]/g, ' '));
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, ''));
  const out: string[] = [];
  const indent = (l: string) => l.length - l.trimStart().length;
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)|from\s+([\w.]+)\s+import\b)/);
    if (!m) return;
    const ind = indent(line);
    if (ind > 0) {
      for (let k = i - 1; k >= 0; k--) {
        if (!lines[k].trim() || indent(lines[k]) >= ind) continue;
        if (/^\s*(try|except|else|elif|if|finally)\b/.test(lines[k])) return;
        break;
      }
    }
    const mods = m[1] ? m[1].split(',').map((s) => s.trim().split(/\s+/)[0]) : [m[2]];
    for (const mod of mods) if (mod && !mod.startsWith('.')) out.push(mod);
  });
  return [...new Set(out)];
}

/** Registry packages a JS/TS file imports: import/export from, side-effect imports, require() and import(). */
export function jsImports(source: string): string[] {
  // Comments out; strings stay, since the specifiers are strings.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
  const out = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
    /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const pkg = npmPackageOf(m[1]);
      if (pkg) out.add(pkg);
    }
  }
  return [...out];
}

// --------------------------------------------------------------- project ---

interface Project {
  dir: string;
  /** Normalized declared names (PEP 503 for Python, as written for npm). */
  declared: Set<string>;
  /** Manifest files read, for the message. */
  manifests: string[];
  /** Names of local files and directories, any of which an import may resolve to. */
  local: Set<string>;
  /** tsconfig/jsconfig "paths" prefixes ("@app/"). */
  aliases: string[];
}

function read(p: string): string | undefined {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size <= MAX_BYTES ? fs.readFileSync(p, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function list(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function manifestsIn(dir: string, lang: Lang): string[] {
  const names = list(dir).filter((e) => e.isFile()).map((e) => e.name);
  if (lang === 'js') return names.filter((n) => n === 'package.json');
  return names.filter((n) => /^(requirements[^\\/]*\.(txt|in)|pyproject\.toml|setup\.py|setup\.cfg|Pipfile)$/i.test(n));
}

/** Names a Python manifest declares. Over-inclusive on purpose: a name quoted anywhere in it counts. */
function pythonDeclared(file: string, content: string, seen = new Set<string>()): string[] {
  const out: string[] = [];
  const base = path.basename(file);
  if (/^requirements/i.test(base) || /\.(txt|in)$/i.test(base)) {
    try {
      const t = parseFile(base, content);
      out.push(...(t.declared ?? t.packages).map((d) => d.name));
    } catch {
      // unreadable: the loose pass below still runs
    }
    // -r / -c includes, relative to the file.
    for (const m of content.matchAll(/^\s*-(?:r|c|-requirement|-constraint)[\s=]+(\S+)/gm)) {
      const inc = path.resolve(path.dirname(file), m[1]);
      if (seen.has(inc)) continue;
      seen.add(inc);
      const c = read(inc);
      if (c) out.push(...pythonDeclared(inc, c, seen));
    }
    for (const line of content.split(/\r?\n/)) {
      const m = line.replace(/#.*/, '').trim().match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)/);
      if (m) out.push(m[1]);
    }
  } else {
    // pyproject.toml, setup.py, setup.cfg, Pipfile: every quoted requirement and every "name =" key.
    for (const m of content.matchAll(/["']([A-Za-z0-9][A-Za-z0-9_.-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@ ][^"']*)?["']/g)) out.push(m[1]);
    for (const m of content.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*=/gm)) out.push(m[1]);
    for (const m of content.matchAll(/^\s+([A-Za-z0-9][A-Za-z0-9_.-]*)\s*(?:[<>=!~;[]|$)/gm)) out.push(m[1]);
  }
  return out.map(normalizePypiName);
}

function jsDeclared(content: string): string[] {
  try {
    const pj = JSON.parse(content);
    const keys = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pj?.[k] ?? {}));
    return [...keys, ...(typeof pj?.name === 'string' ? [pj.name] : [])];
  } catch {
    return [];
  }
}

function jsonName(content: string | undefined): string | undefined {
  try {
    const n = content ? JSON.parse(content)?.name : undefined;
    return typeof n === 'string' ? n : undefined;
  } catch {
    return undefined;
  }
}

/** tsconfig/jsconfig "paths" keys as prefixes; their baseUrl directory's entries count as local. */
function jsAliases(dir: string, local: Set<string>): string[] {
  const out: string[] = [];
  for (const f of ['tsconfig.json', 'jsconfig.json']) {
    const c = read(path.join(dir, f));
    if (!c) continue;
    const paths = c.match(/"paths"\s*:\s*\{([^}]*)\}/)?.[1] ?? '';
    for (const m of paths.matchAll(/"([^"]+)"\s*:/g)) out.push(m[1].replace(/\*.*$/, ''));
    const baseUrl = c.match(/"baseUrl"\s*:\s*"([^"]+)"/)?.[1];
    if (baseUrl) for (const e of list(path.resolve(dir, baseUrl))) local.add(e.name.replace(/\.[^.]+$/, ''));
  }
  return out.filter(Boolean);
}

/**
 * Source files under `dir` (not inside another project with its own manifest)
 * and every local file or directory name, which imports may resolve to.
 */
function walk(dir: string, lang: Lang, wantFiles: boolean): { files: string[]; local: Set<string> } {
  const files: string[] = [];
  // Workspace packages are local too: an import of "@acme/ui" resolves to packages/ui.
  const local = new Set<string>();
  let entries = 0;
  const visit = (d: string, depth: number) => {
    for (const e of list(d)) {
      if (++entries > MAX_ENTRIES) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.test(e.name) || depth >= MAX_DEPTH) continue;
        local.add(e.name);
        // A nested project has its own manifest and its own imports.
        if (manifestsIn(p, lang).length) {
          const name = lang === 'js' ? jsonName(read(path.join(p, 'package.json'))) : undefined;
          if (name) local.add(name);
          continue;
        }
        visit(p, depth + 1);
      } else if (e.isFile()) {
        local.add(e.name.replace(/\.[^.]+$/, ''));
        const l = languageOf(p);
        if (wantFiles && l && !l.manifest && l.lang === lang && files.length < MAX_FILES) files.push(p);
      }
    }
  };
  visit(dir, 0);
  return { files, local };
}

/** The project a file belongs to: the nearest directory above it with a manifest for its language. */
function findProjectDir(start: string, lang: Lang): string | undefined {
  let dir = start;
  for (let i = 0; i <= UP_LEVELS; i++) {
    if (manifestsIn(dir, lang).length) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return undefined;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/** Declared names from the project's manifests and those of enclosing projects (workspaces, hoisting). */
function loadProject(dir: string, lang: Lang, override?: { file: string; content: string }): Project {
  const declared = new Set<string>();
  const manifests: string[] = [];
  let d = dir;
  for (let i = 0; i <= UP_LEVELS; i++) {
    for (const name of manifestsIn(d, lang)) {
      const file = path.join(d, name);
      const content = override && path.resolve(override.file) === path.resolve(file) ? override.content : read(file);
      if (content === undefined) continue;
      if (d === dir) manifests.push(name);
      for (const n of lang === 'js' ? jsDeclared(content) : pythonDeclared(file, content)) declared.add(n);
    }
    if (fs.existsSync(path.join(d, '.git'))) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  // A manifest being written for the first time is not on disk yet.
  if (override && path.dirname(path.resolve(override.file)) === path.resolve(dir) && !manifests.includes(path.basename(override.file))) {
    manifests.push(path.basename(override.file));
    for (const n of lang === 'js' ? jsDeclared(override.content) : pythonDeclared(override.file, override.content)) declared.add(n);
  }
  return { dir, declared, manifests, local: new Set(), aliases: [] };
}

// --------------------------------------------------------------- the check ---

export interface Undeclared {
  ecosystem: Ecosystem;
  /** What the code imports ("langchain_text_splitters", "zod"). */
  importName: string;
  /** The package that provides it, as the registry names it. */
  pkg: string;
  /** Other distributions that also provide it (opencv-python-headless for cv2). */
  alternatives: string[];
  /** From the curated map, or a guess from the import name. */
  curated: boolean;
  files: string[];
}

/** Pure part: imports per file against a project, nothing fetched. */
export function undeclaredImports(lang: Lang, importsByFile: Map<string, string[]>, project: Project): Undeclared[] {
  const found = new Map<string, Undeclared>();
  for (const [file, imports] of importsByFile) {
    for (const imp of imports) {
      let u: Undeclared | undefined;
      if (lang === 'python') {
        const top = imp.split('.')[0];
        if (PYTHON_STDLIB.has(top) || project.local.has(top)) continue;
        const { dists, curated, module } = pythonDistributions(imp);
        if (!dists.length) continue;
        // Declaring the import's own name always counts: that package installs a module by that name.
        const accepted = [...dists, ...(curated ? [normalizePypiName(top)] : pythonAliasesOf(top))];
        if (accepted.some((d) => project.declared.has(normalizePypiName(d)))) continue;
        // A namespace guess (google-cloud-x) that is not declared under a sibling name is too uncertain to report.
        if (!curated && imp.includes('.') && dists[0] !== normalizePypiName(top)) {
          const ns = normalizePypiName(top);
          if ([...project.declared].some((d) => d.startsWith(`${ns}-`))) continue;
        }
        u = { ecosystem: 'pypi', importName: module ?? (dists[0] === normalizePypiName(top) ? top : imp), pkg: dists[0], alternatives: dists.slice(1), curated, files: [] };
      } else {
        if (project.declared.has(imp) || project.local.has(imp) || project.aliases.some((a) => imp.startsWith(a) || `${imp}/`.startsWith(a))) continue;
        u = { ecosystem: 'npm', importName: imp, pkg: imp, alternatives: [], curated: false, files: [] };
      }
      const prev = found.get(u.pkg) ?? u;
      prev.files.push(file);
      found.set(u.pkg, prev);
    }
  }
  return [...found.values()];
}

function changedImports(lang: Lang, next: string, old: string | undefined): string[] {
  const parse = lang === 'python' ? pythonImports : jsImports;
  const before = new Set(old ? parse(old) : []);
  return parse(next).filter((i) => !before.has(i));
}

/** What to tell the agent about a write, or nothing. */
export async function undeclaredImportNotes(abs: string, next: string, old: string | undefined): Promise<string[]> {
  const kind = languageOf(abs);
  if (!kind) return [];
  const { lang } = kind;
  const dir = kind.manifest ? path.dirname(abs) : findProjectDir(path.dirname(abs), lang);
  if (!dir) return []; // no manifest yet: the agent has not declared anything, there is nothing to compare with
  const project = loadProject(dir, lang, kind.manifest ? { file: abs, content: next } : undefined);
  if (!project.manifests.length) return [];
  const scan = walk(dir, lang, kind.manifest);
  project.local = scan.local;
  if (lang === 'js') project.aliases = jsAliases(dir, project.local);
  if (lang === 'python') {
    const own = read(path.join(dir, 'pyproject.toml'))?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
    if (own) project.local.add(own.replace(/-/g, '_'));
  }
  if (!kind.manifest) {
    // The file being written may not exist yet; its own name and directory are local too.
    project.local.add(path.basename(abs).replace(/\.[^.]+$/, ''));
    for (const e of list(path.dirname(abs))) project.local.add(e.name.replace(/\.[^.]+$/, ''));
  }

  const byFile = new Map<string, string[]>();
  if (kind.manifest) {
    for (const f of scan.files) {
      const src = read(f);
      if (src) byFile.set(path.relative(dir, f) || path.basename(f), lang === 'python' ? pythonImports(src) : jsImports(src));
    }
  } else {
    byFile.set(path.relative(dir, abs) || path.basename(abs), changedImports(lang, next, old));
  }
  const missing = undeclaredImports(lang, byFile, project).slice(0, MAX_REPORTED);
  if (!missing.length) return [];

  const notes = await Promise.all(missing.map((u) => describe(u, project)));
  return notes.filter((n): n is string => Boolean(n));
}

/** One line per missing package, verified against the registry; undefined when it cannot be named with confidence. */
async function describe(u: Undeclared, project: Project): Promise<string | undefined> {
  const v = await checkPackage(u.ecosystem, u.pkg, undefined, { risk: false }).catch(() => undefined);
  const r = v?.report;
  // A guessed name the registry does not know (or that looks like a typo of another) is not ours to suggest.
  if (!r || r.verdict === 'unknown-package' || r.verdict === 'possible-typosquat' || r.verdict === 'malicious') return undefined;
  if (r.verdict === 'unknown' && !u.curated) return undefined;
  const version = r.safeVersion ?? r.leastExposed?.version;
  const files = u.files.slice(0, 3).join(', ') + (u.files.length > 3 ? ` (+${u.files.length - 3} more)` : '');
  const where = project.manifests.join(' / ');
  const add =
    version && u.ecosystem === 'pypi' ? `\`${u.pkg}==${version}\``
    : version ? `\`"${u.pkg}": "${version}"\` (${installCommand(u.ecosystem, u.pkg, version)})`
    : `\`${u.pkg}\``;
  const alt = u.alternatives.length ? ` (or ${u.alternatives.join(', ')})` : '';
  const guess = u.curated || u.ecosystem === 'npm' ? '' : ' (Package name guessed from the import; ignore if a declared package provides it.)';
  return (
    `${files} import${u.files.length === 1 ? 's' : ''} \`${u.importName}\`, but ${where} does not declare ${u.pkg}${alt}: ` +
    `the import fails unless another package happens to pull it in. Declare it: ${add}${version ? ' (newest version with no known advisories)' : ''}.${guess}`
  );
}
