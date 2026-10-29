/**
 * The public API of a Python distribution, read from its source text: module
 * docstrings, top-level function and class signatures with their docstrings,
 * public methods, respecting __all__ and skipping private names, tests and
 * vendored code. A small statement scanner, not a Python parser, and nothing
 * is ever imported or executed: the files are data.
 *
 * The output is rendered as stub-like Python, one string per module, which the
 * python chunker in retrieve.ts splits into one section per class or function.
 */
import { type ArchiveEntry } from './archive.js';

// ------------------------------------------------------------ scanning ------

export interface Stmt {
  indent: number;
  /** The logical line: continuation lines joined, comments removed. */
  text: string;
}

function skipString(s: string, k: number): number {
  const q = s[k];
  const triple = s.startsWith(q + q + q, k);
  const close = triple ? q + q + q : q;
  let p = k + (triple ? 3 : 1);
  while (p < s.length) {
    if (s[p] === '\\') {
      p += 2;
      continue;
    }
    if (!triple && s[p] === '\n') return p; // unterminated: stop at the line end
    if (s.startsWith(close, p)) return p + close.length;
    p++;
  }
  return s.length;
}

/** Splits source into logical lines (brackets, strings and backslashes join physical lines). */
export function pyStatements(source: string): Stmt[] {
  const s = source.replace(/\r\n?/g, '\n');
  const out: Stmt[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    let j = i;
    let indent = 0;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\f')) {
      indent += s[j] === '\t' ? 8 - (indent % 8) : s[j] === ' ' ? 1 : 0;
      j++;
    }
    if (j >= n) break;
    if (s[j] === '\n' || s[j] === '#' || (s[j] === '\\' && s[j + 1] === '\n')) {
      const e = s.indexOf('\n', j + (s[j] === '\\' ? 2 : 0));
      i = e < 0 ? n : e + 1;
      continue;
    }
    let depth = 0;
    let k = j;
    let seg = j;
    let text = '';
    while (k < n) {
      const c = s[k];
      if (c === '#') {
        text += s.slice(seg, k);
        const e = s.indexOf('\n', k);
        k = e < 0 ? n : e;
        seg = k;
        continue;
      }
      if (c === '"' || c === "'") {
        k = skipString(s, k);
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
      else if (c === '\\' && s[k + 1] === '\n') {
        k += 2;
        continue;
      } else if (c === '\n' && depth === 0) break;
      k++;
    }
    text += s.slice(seg, k);
    out.push({ indent, text: text.replace(/\s+$/, '') });
    i = k + 1;
  }
  return out;
}

interface Node {
  s: Stmt;
  kids: Node[];
}

function toTree(stmts: Stmt[]): Node[] {
  const root: Node = { s: { indent: -1, text: '' }, kids: [] };
  const stack = [root];
  for (const s of stmts) {
    while (stack.length > 1 && s.indent <= stack[stack.length - 1].s.indent) stack.pop();
    const node: Node = { s, kids: [] };
    stack[stack.length - 1].kids.push(node);
    stack.push(node);
  }
  return root.kids;
}

/** Splits "def f(x) -> int: return x" at the colon that ends the header. */
function splitHeader(text: string): { header: string; inline: string } | undefined {
  let depth = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === '"' || c === "'") {
      k = skipString(text, k) - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0) return { header: text.slice(0, k).trimEnd(), inline: text.slice(k + 1).trim() };
  }
  return undefined;
}

/** The content of a string-literal statement (a docstring), or undefined. */
export function stringLiteral(text: string): string | undefined {
  const m = text.match(/^[rRuU]?("""|'''|"|')([\s\S]*)\1$/);
  return m ? m[2] : undefined;
}

/** inspect.cleandoc: strip the first line, dedent the rest, drop blank edges. */
export function cleandoc(doc: string): string {
  const lines = doc.replace(/\t/g, '    ').split('\n');
  const rest = lines.slice(1);
  const indents = rest.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const min = indents.length ? Math.min(...indents) : 0;
  const out = [lines[0].trim(), ...rest.map((l) => l.slice(min).trimEnd())];
  while (out.length && !out[0]) out.shift();
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join('\n');
}

// ------------------------------------------------------------ parsing -------

export interface PyDef {
  kind: 'def' | 'class' | 'assign';
  name: string;
  decorators: string[];
  /** "def f(x: int) -> str" / "class A(B)" / "X: int = 3", without the trailing colon. */
  header: string;
  doc?: string;
  members: PyDef[];
}

export interface PyImport {
  /** Module as written: ".functional_validators", "pkg.sub". */
  from: string;
  names: { name: string; alias?: string }[];
}

export interface PyModule {
  doc?: string;
  /** Names in __all__ when it is a plain literal; undefined otherwise. */
  all?: string[];
  defs: PyDef[];
  imports: PyImport[];
  allDynamic?: boolean;
}

const COMPOUND = /^(if|elif|else|try|except|finally|with|async\s+with)\b/;
const KEEP_DUNDER = new Set(['__init__', '__call__']);

function docOf(node: Node, inline: string): string | undefined {
  const first = node.kids[0]?.s.text ?? inline;
  const lit = first ? stringLiteral(first) : undefined;
  return lit === undefined ? undefined : cleandoc(lit);
}

function parseImport(text: string): PyImport | undefined {
  const m = text.match(/^from\s+(\.*[\w.]*)\s+import\s+([\s\S]+)$/);
  if (!m) return undefined;
  const names = m[2]
    .replace(/[()\\]/g, ' ')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [name, alias] = x.split(/\s+as\s+/);
      return { name: name.trim(), alias: alias?.trim() };
    })
    .filter((x) => /^[A-Za-z_]\w*$/.test(x.name));
  return { from: m[1], names };
}

function collect(nodes: Node[], inClass: boolean, mod: PyModule, out: PyDef[]): void {
  let decorators: string[] = [];
  for (const node of nodes) {
    const t = node.s.text;
    if (t.startsWith('@')) {
      decorators.push(t);
      continue;
    }
    const def = t.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/);
    const cls = t.match(/^class\s+([A-Za-z_]\w*)/);
    if (def || cls) {
      const split = splitHeader(t);
      if (split) {
        const d: PyDef = { kind: def ? 'def' : 'class', name: (def ?? cls)![1], decorators, header: split.header, doc: docOf(node, split.inline), members: [] };
        if (cls) collect(node.kids, true, mod, d.members);
        out.push(d);
      }
      decorators = [];
      continue;
    }
    decorators = [];
    if (!inClass && COMPOUND.test(t)) {
      // Definitions under "if sys.version_info ...", "try: ... except ImportError" still count.
      collect(node.kids, false, mod, out);
      continue;
    }
    if (inClass) {
      // Class attributes: annotated fields (dataclasses, pydantic models) and enum-style constants.
      const attr = t.match(/^([A-Za-z_]\w*)\s*(:|=)/);
      if (attr && !attr[1].startsWith('_') && (attr[2] === ':' || /^[A-Z][A-Z0-9_]*$/.test(attr[1]))) {
        out.push({ kind: 'assign', name: attr[1], decorators: [], header: t.split('\n')[0].slice(0, 160), members: [] });
      }
      continue;
    }
    const imp = parseImport(t);
    if (imp) {
      mod.imports.push(imp);
      continue;
    }
    const assignAll = t.match(/^__all__\s*(?::[^=]*)?(\+=|=)\s*([\s\S]*)$/);
    const extendAll = t.match(/^__all__\.(?:extend|append)\(([\s\S]*)\)$/);
    if (assignAll || extendAll) {
      const expr = assignAll ? assignAll[2] : extendAll![1];
      const names = [...expr.matchAll(/(['"])([A-Za-z_]\w*)\1/g)].map((m) => m[2]);
      // Only a literal list is trustworthy; "__all__ = a.__all__ + [...]" cannot be known statically.
      const literal = /^[\s[\](),]*$/.test(expr.replace(/(['"])[A-Za-z_]\w*\1/g, ''));
      if (!literal) mod.allDynamic = true;
      else mod.all = assignAll?.[1] === '=' ? names : [...(mod.all ?? []), ...names];
      continue;
    }
    const assign = t.match(/^([A-Za-z_]\w*)\s*(:[^=]+)?=/) ?? t.match(/^([A-Za-z_]\w*)\s*:\s*\S/);
    if (assign) out.push({ kind: 'assign', name: assign[1], decorators: [], header: t.split('\n')[0].slice(0, 160), members: [] });
  }
}

export function parseModule(source: string): PyModule {
  const tree = toTree(pyStatements(source));
  const mod: PyModule = { defs: [], imports: [] };
  const first = tree[0]?.s.text;
  const lit = first ? stringLiteral(first) : undefined;
  if (lit !== undefined) mod.doc = cleandoc(lit);
  collect(tree, false, mod, mod.defs);
  if (mod.allDynamic) mod.all = undefined;
  return mod;
}

// ------------------------------------------------------------ rendering -----

const DOC_CAP = 2000;
const METHOD_DOC_CAP = 900;
const MODULE_DOC_CAP = 1200;
const MAX_MEMBERS = 60;

function capDoc(doc: string, cap: number): string {
  if (doc.length <= cap) return doc;
  const cut = doc.slice(0, cap);
  return `${cut.slice(0, Math.max(cut.lastIndexOf('\n'), cap * 0.6))}\n...`;
}

function docLines(doc: string, indent: string, cap: number): string[] {
  const body = capDoc(doc, cap).replace(/"""/g, '\\"\\"\\"');
  const lines = body.split('\n');
  if (lines.length === 1) return [`${indent}"""${lines[0]}"""`];
  return [`${indent}"""${lines[0]}`, ...lines.slice(1).map((l) => (l ? indent + l : '')), `${indent}"""`];
}

/** Multi-line headers lose their original indentation; give continuation lines a uniform one. */
function headerLines(header: string, indent: string): string[] {
  const lines = header.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.map((l, i) => (i === 0 || /^[)\]]/.test(l) ? indent + l : `${indent}    ${l}`));
}

function overloadsPruned(defs: PyDef[], stub: boolean): PyDef[] {
  const byName = new Map<string, PyDef[]>();
  for (const d of defs) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
  const isOverload = (d: PyDef) => d.decorators.some((x) => /^@(typing\.)?overload\b/.test(x));
  const out: PyDef[] = [];
  const done = new Set<string>();
  for (const d of defs) {
    const same = byName.get(d.name)!;
    if (same.length === 1) {
      out.push(d);
      continue;
    }
    if (done.has(d.name)) continue;
    done.add(d.name);
    const impl = same.filter((x) => !isOverload(x));
    // Keep the implementation (it carries the docstring); a stub has only overloads, keep a few.
    if (impl.length && !stub) out.push(impl.find((x) => x.doc) ?? impl[impl.length - 1]);
    else out.push(...same.slice(0, 3));
  }
  return out;
}

export interface RenderOptions {
  /** Restrict top-level names (re-exported names of a private module). */
  only?: Set<string>;
  /** Typed signatures from a stub package, by "name" or "Class.method". */
  stubSigs?: Map<string, string>;
  isStub?: boolean;
}

function renderDef(d: PyDef, indent: string, opts: RenderOptions, qual: string, cap: number): string[] {
  if (d.kind === 'assign') return [indent + d.header];
  const header = (d.kind === 'def' && opts.stubSigs?.get(qual)) || d.header;
  // Long decorator calls (pandas' @Appender(_doc.format(...))) are noise: keep the name only.
  const decorators = d.decorators.map((x) => x.replace(/\s*\n\s*/g, ' ')).map((x) => (x.length > 100 ? x.replace(/\(.*$/s, '(...)') : x));
  const lines = [...decorators.map((x) => indent + x), ...headerLines(header, indent)];
  lines[lines.length - 1] += ':';
  const inner = `${indent}    `;
  const body: string[] = [];
  if (d.doc) body.push(...docLines(d.doc, inner, cap));
  if (d.kind === 'class') {
    const members = overloadsPruned(d.members, Boolean(opts.isStub))
      .filter((m) => !m.name.startsWith('_') || KEEP_DUNDER.has(m.name))
      .slice(0, MAX_MEMBERS);
    for (const m of members) {
      if (m.kind !== 'assign' && body.length) body.push('');
      body.push(...renderDef(m, inner, opts, `${qual}.${m.name}`, METHOD_DOC_CAP));
    }
  }
  if (!body.length) lines[lines.length - 1] += ' ...';
  else lines.push(...body);
  return lines;
}

/** Dotted module name for a path inside the import root: "pkg/sub/__init__.py" -> "pkg.sub". */
export function moduleName(path: string): string {
  return path.replace(/\.pyi?$/, '').replace(/\/__init__$/, '').replace(/\//g, '.');
}

/** Absolute module for "from .x import y" written in `path`. */
export function resolveRelative(path: string, from: string): string {
  const dots = from.match(/^\.*/)![0].length;
  if (!dots) return from;
  const mod = moduleName(path);
  const pkg = /__init__\.pyi?$/.test(path) ? mod.split('.') : mod.split('.').slice(0, -1);
  const base = pkg.slice(0, Math.max(0, pkg.length - (dots - 1)));
  const rest = from.slice(dots);
  return [...base, ...(rest ? [rest] : [])].join('.');
}

export function isPrivatePath(path: string): boolean {
  return path.split('/').some((part) => part.startsWith('_') && !/^__init__\.pyi?$/.test(part));
}

/** Renders one module as stub-like Python; empty when it exposes nothing public. */
export function renderModule(path: string, mod: PyModule, opts: RenderOptions = {}): string {
  const all = mod.all ? new Set(mod.all) : undefined;
  const isInit = /__init__\.pyi?$/.test(path);
  const visible = (name: string) => (opts.only ? opts.only.has(name) : all ? all.has(name) : !name.startsWith('_'));
  const blocks: string[] = [];
  if (isInit && !opts.only) {
    // What the package re-exports is what agents import from it.
    const groups = new Map<string, string[]>();
    for (const imp of mod.imports) {
      const names = imp.names.map((n) => n.alias ?? n.name).filter(visible);
      if (!names.length) continue;
      const from = resolveRelative(path, imp.from);
      groups.set(from, [...(groups.get(from) ?? []), ...names]);
    }
    const lines = [...groups].slice(0, 80).map(([from, names]) => `from ${from} import ${[...new Set(names)].join(', ')}`);
    if (lines.length) blocks.push(lines.join('\n'));
    if (mod.all?.length) {
      const list = `__all__ = [${mod.all.map((x) => `"${x}"`).join(', ')}]`;
      blocks.push(list.length > 3000 ? `${list.slice(0, 3000)}, ...]` : list);
    }
  }
  const seen = new Set<string>();
  for (const d of overloadsPruned(mod.defs, Boolean(opts.isStub))) {
    if (!visible(d.name)) continue;
    if (d.kind === 'assign' && !(opts.only || all?.has(d.name) || opts.isStub)) continue;
    if (d.kind === 'assign' && seen.has(d.name)) continue;
    seen.add(d.name);
    blocks.push(renderDef(d, '', opts, d.name, DOC_CAP).join('\n'));
  }
  if (!blocks.length) return '';
  const head = [`# module ${moduleName(path)}`];
  if (mod.doc && !opts.only) head.push(docLines(mod.doc, '', MODULE_DOC_CAP).join('\n'));
  return [head.join('\n'), ...blocks].join('\n\n') + '\n';
}

// ------------------------------------------------------------ distributions -

/** Tests, vendored copies, examples and build scripts are not the package's API. */
const SKIP_PATH =
  /(^|\/)(tests?|_?vendor(ed)?|_vendored|third_party|externals?|examples?|benchmarks?|docs?|__pycache__)\/|(^|\/)(test_[^/]*|[^/]*_test|conftest)\.pyi?$|^(setup|noxfile|tasks)\.py$|^build\//i;

export interface DistLayout {
  /** Module files relative to the import root ("yaml/__init__.py"). */
  modules: { path: string; source: string }[];
  /** Top-level import names the distribution provides. */
  importNames: string[];
  /** Ships py.typed or .pyi stubs. */
  typed: boolean;
}

/** Entry names worth decompressing from a wheel or sdist. */
export function wantEntry(name: string): boolean {
  if (/\.pyi?$/.test(name)) return !/(^|\/)(tests?|_?vendor(ed)?|_vendored|third_party|__pycache__)\//i.test(name);
  return /(^|\/)(py\.typed|top_level\.txt)$/.test(name);
}

/**
 * Maps archive entries to import-root paths. Wheels are laid out from the
 * import root already (plus `*.data/purelib/`); sdists have a `name-version/`
 * prefix and often a `src/` layout. Stub packages name their dirs `X-stubs`.
 */
export function distLayout(entries: ArchiveEntry[], kind: 'wheel' | 'sdist'): DistLayout {
  let files = entries.map((e) => ({ path: e.name, data: e.data }));
  if (kind === 'sdist') {
    files = files.map((f) => ({ ...f, path: f.path.split('/').slice(1).join('/') })).filter((f) => f.path);
    const hasSrc = files.some((f) => /^src\/[^/]+\/__init__\.pyi?$/.test(f.path));
    if (hasSrc) files = files.filter((f) => f.path.startsWith('src/')).map((f) => ({ ...f, path: f.path.slice(4) }));
  }
  files = files.map((f) => ({ ...f, path: f.path.replace(/^[^/]+\.data\/(purelib|platlib)\//, '').replace(/^([^/]+)-stubs\//, '$1/') }));
  const topLevel = files.find((f) => /\.(dist|egg)-info\/top_level\.txt$/.test(f.path));
  const typed = files.some((f) => /(^|\/)py\.typed$/.test(f.path) || f.path.endsWith('.pyi'));
  const modules = files
    .filter((f) => /\.pyi?$/.test(f.path) && !/\.(dist|egg)-info\//.test(f.path) && !SKIP_PATH.test(f.path))
    .map((f) => ({ path: f.path, source: f.data.toString('utf8') }));
  let importNames = topLevel
    ? topLevel.data.toString('utf8').split(/\s+/).filter(Boolean)
    : [...new Set(modules.map((m) => m.path.split('/')[0].replace(/\.pyi?$/, '')))];
  importNames = importNames.filter((n) => !n.startsWith('_') && /^[A-Za-z_]\w*$/.test(n) && modules.some((m) => m.path.split('/')[0].replace(/\.pyi?$/, '') === n));
  return { modules, importNames, typed };
}

const MAX_MODULES = 1500;
const MAX_RENDERED = 3_000_000;

/** Typed signatures of a stub tree, keyed by module then "name" / "Class.method". */
export function stubSignatures(stubs: { path: string; source: string }[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const s of stubs) {
    const mod = parseModule(s.source);
    const sigs = new Map<string, string>();
    const add = (d: PyDef, qual: string) => {
      if (d.kind !== 'def') return;
      // Overloaded stubs have several headers; the source signature is clearer then.
      if (sigs.has(qual)) sigs.set(qual, '');
      else sigs.set(qual, d.header);
    };
    for (const d of mod.defs) {
      add(d, d.name);
      if (d.kind === 'class') for (const m of d.members) add(m, `${d.name}.${m.name}`);
    }
    out.set(moduleName(s.path), sigs);
  }
  return out;
}

/**
 * Renders every public module of a distribution. Private modules contribute
 * only the names a public module re-exports from them ("from ._client import
 * Client"), so packages that keep their code in _impl files still show it.
 * Stub-package modules fill in typed signatures, and stand in for modules the
 * distribution has no Python source for (C extensions).
 */
export function renderDistribution(layout: DistLayout, stubs: { path: string; source: string }[] = []): { path: string; content: string }[] {
  const parsed = layout.modules.slice(0, MAX_MODULES * 2).map((m) => ({ path: m.path, mod: parseModule(m.source), stub: m.path.endsWith('.pyi') }));
  // A .pyi next to a .py: the .py has the docstrings, the .pyi the types.
  const sigs = stubSignatures([
    ...layout.modules.filter((m) => m.path.endsWith('.pyi')),
    ...stubs,
  ]);
  const haveSource = new Set(parsed.filter((p) => !p.stub).map((p) => moduleName(p.path)));
  const all = [
    ...parsed.filter((p) => !p.stub || !haveSource.has(moduleName(p.path))),
    ...stubs.filter((s) => !haveSource.has(moduleName(s.path)) && !parsed.some((p) => moduleName(p.path) === moduleName(s.path))).map((s) => ({ path: s.path, mod: parseModule(s.source), stub: true })),
  ];

  const reexported = new Map<string, Set<string>>();
  for (const p of all) {
    if (isPrivatePath(p.path)) continue;
    // A package __init__ re-exports what it imports; another public module only what its __all__ lists.
    const isInit = /__init__\.pyi?$/.test(p.path);
    const listed = new Set(p.mod.all ?? []);
    for (const imp of p.mod.imports) {
      const from = resolveRelative(p.path, imp.from);
      const set = reexported.get(from) ?? new Set<string>();
      for (const n of imp.names) if ((isInit && !n.name.startsWith('_')) || listed.has(n.alias ?? n.name)) set.add(n.name);
      reexported.set(from, set);
    }
  }

  const out: { path: string; content: string }[] = [];
  let total = 0;
  // Shallow public modules first, so the caps cut the deep internals.
  const ordered = [...all].sort((a, b) => Number(isPrivatePath(a.path)) - Number(isPrivatePath(b.path)) || a.path.split('/').length - b.path.split('/').length);
  for (const p of ordered) {
    if (out.length >= MAX_MODULES || total >= MAX_RENDERED) break;
    const name = moduleName(p.path);
    const only = isPrivatePath(p.path) ? reexported.get(name) : undefined;
    if (isPrivatePath(p.path) && !only?.size) continue;
    const stubSigs = new Map([...(sigs.get(name) ?? [])].filter(([, v]) => v));
    const content = renderModule(p.path, p.mod, { only, stubSigs, isStub: p.stub });
    if (!content) continue;
    out.push({ path: p.path, content });
    total += content.length;
  }
  return out;
}
