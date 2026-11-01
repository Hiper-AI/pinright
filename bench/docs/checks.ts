/**
 * Static API checks for the docs benchmark. A project is the set of text
 * files an agent wrote; each check says whether it uses the current API of a
 * library (required), or an API the current major removed or deprecated.
 * Comments are stripped before matching, so "// not middleware.ts" does not
 * count as using middleware. Pure functions: unit-tested in test/benchDocs.test.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

export type CheckKind = 'required' | 'removed' | 'deprecated';

export interface Project {
  /** Relative path (forward slashes) -> content with comments stripped. */
  files: Map<string, string>;
  /** package.json, parsed, when present. */
  pkg?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
  /** requirements.txt pins: normalized name -> version spec. */
  reqs?: Map<string, string>;
}

export interface ApiCheck {
  id: string;
  kind: CheckKind;
  /** What the check looks for, shown in the report. */
  desc: string;
  /** required: true when the current API is used. removed/deprecated: true when the old API is used. */
  test: (p: Project) => boolean;
}

export interface CheckResult { id: string; kind: CheckKind; desc: string; pass: boolean }

const TEXT_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.css', '.py', '.json', '.txt', '.toml', '.cfg', '.ini', '.md', '.yaml', '.yml', '.html']);
const SKIP_DIR = /^(node_modules|\.venv|\.next|dist|build|__pycache__|\.git)$/;

/** JS/TS/CSS: drops // and /* *\/ comments outside strings, template literals and regex-free code. */
export function stripJsComments(src: string, lineComments = true): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? src.length : e + 2;
      out += ' ';
      continue;
    }
    if (lineComments && c === '/' && n === '/' && src[i - 1] !== ':') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? src.length : e;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Python: drops # comments outside strings. Docstrings stay (they are strings). */
export function stripPyComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      let j = i + close.length;
      while (j < src.length && !src.startsWith(close, j)) {
        if (src[j] === '\\') j++;
        else if (!triple && src[j] === '\n') break;
        j++;
      }
      out += src.slice(i, j + close.length);
      i = j + close.length;
      continue;
    }
    if (c === '#') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? src.length : e;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function stripComments(path: string, src: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.py') return stripPyComments(src);
  if (ext === '.css') return stripJsComments(src, false);
  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return stripJsComments(src);
  return src;
}

export function projectFromFiles(raw: Record<string, string>): Project {
  const files = new Map<string, string>();
  for (const [p, c] of Object.entries(raw)) files.set(p.replace(/\\/g, '/'), stripComments(p, c));
  let pkg: Project['pkg'];
  try {
    if (raw['package.json']) pkg = JSON.parse(raw['package.json']);
  } catch {
    pkg = undefined;
  }
  let reqs: Map<string, string> | undefined;
  if (raw['requirements.txt'] !== undefined) {
    reqs = new Map();
    for (const l of raw['requirements.txt'].split(/\r?\n/).map((x) => x.replace(/#.*/, '').trim()).filter(Boolean)) {
      const m = l.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(.*)$/);
      if (m) reqs.set(m[1].toLowerCase().replace(/[-_.]+/g, '-'), m[2].trim());
    }
  }
  return { files, pkg, reqs };
}

export function loadProject(dir: string): Project {
  const raw: Record<string, string> = {};
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      if (SKIP_DIR.test(e)) continue;
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if ((TEXT_EXT.has(extname(e).toLowerCase()) || /^\.?(eslintrc|eslintignore)/.test(e)) && st.size < 500_000) {
        raw[relative(dir, p).replace(/\\/g, '/')] = readFileSync(p, 'utf8');
      }
    }
  };
  walk(dir);
  return projectFromFiles(raw);
}

// ------------------------------------------------------------ helpers -------

/** Files whose path matches. */
export function filesMatching(p: Project, path: RegExp): [string, string][] {
  return [...p.files.entries()].filter(([f]) => path.test(f));
}

export const SRC_JS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const SRC_PY = /\.py$/;
export const CSS = /\.css$/;

/** Some file matching `path` contains `re`. */
export function has(p: Project, re: RegExp, path: RegExp = SRC_JS): boolean {
  return filesMatching(p, path).some(([, c]) => re.test(c));
}

export function fileExists(p: Project, path: RegExp): boolean {
  return [...p.files.keys()].some((f) => path.test(f));
}

/**
 * Argument lists of every call to `fn` (e.g. "revalidateTag"), split at
 * top-level commas, with strings, template literals and nested brackets kept whole.
 */
export function callArgs(src: string, fn: string): string[][] {
  const out: string[][] = [];
  // ".min" matches method calls (x.min(...)); "z.record" or "revalidateTag" match that exact callee.
  const esc = fn.replace(/[$.]/g, '\\$&');
  const re = new RegExp(fn.startsWith('.') ? `${esc}\\s*\\(` : `(?<![\\w$.])${esc}\\s*\\(`, 'g');
  for (const m of src.matchAll(re)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 0;
    let cur = '';
    const args: string[] = [];
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
        cur += src.slice(i, j + 1);
        i = j;
        continue;
      }
      if ('([{'.includes(c)) depth++;
      if (')]}'.includes(c)) {
        if (depth === 0) break;
        depth--;
      }
      if (c === ',' && depth === 0) {
        args.push(cur.trim());
        cur = '';
        continue;
      }
      cur += c;
    }
    if (cur.trim()) args.push(cur.trim());
    out.push(args);
  }
  return out;
}

/** The major of the version pinned for an npm package (any dependency field); undefined when absent. */
export function npmMajor(p: Project, name: string): number | undefined {
  const spec = p.pkg?.dependencies?.[name] ?? p.pkg?.devDependencies?.[name];
  const m = spec?.match(/(\d+)(?:\.\d+)*/);
  return m ? Number(m[1]) : undefined;
}

/** The major of a PyPI requirement pinned with ==, >=, ~= or a range; undefined when unpinned or absent. */
export function pypiMajor(p: Project, name: string): number | undefined {
  const spec = p.reqs?.get(name.toLowerCase().replace(/[-_.]+/g, '-'));
  const m = spec?.match(/(?:==|>=|~=|===)\s*(\d+)/);
  return m ? Number(m[1]) : undefined;
}

export function runChecks(p: Project, checks: ApiCheck[]): CheckResult[] {
  return checks.map((c) => {
    const hit = c.test(p);
    return { id: c.id, kind: c.kind, desc: c.desc, pass: c.kind === 'required' ? hit : !hit };
  });
}
