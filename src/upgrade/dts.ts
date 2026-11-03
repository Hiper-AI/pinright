/**
 * The exported API of an npm package, read from its .d.ts files at two versions
 * and diffed: removed exports, changed signatures, removed members of classes and
 * interfaces. Changelogs can be vague; the type definitions are what the code
 * compiles against.
 *
 * No TypeScript compiler here (no new dependencies): declarations are split at
 * top-level braces and semicolons, which is enough for emitted .d.ts files.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { fetchFile } from '../docs/sources.js';
import { getJson } from '../http.js';

export type ExportKind = 'function' | 'class' | 'interface' | 'type' | 'const' | 'enum' | 'namespace' | 'unknown';

export interface ExportEntry {
  kind: ExportKind;
  /** Normalized declaration text; overloads joined. */
  signature: string;
  /** Member names, for classes, interfaces and enums. */
  members?: string[];
}

export type ExportMap = Map<string, ExportEntry>;

export function stripComments(src: string): string {
  // Strings in .d.ts are short literal types; a "//" inside one is rare enough to accept.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1');
}

/** Statements at brace depth 0: ends at ";" or at the "}" that closes a block statement. */
export function splitTopLevel(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | undefined;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && c === '}') {
        const head = src.slice(start, i).trimStart();
        // A block declaration ends at its brace; a type alias or const continues to its ";".
        if (/^(export\s+)?(declare\s+)?(default\s+)?(abstract\s+)?(class|interface|namespace|module|enum|global)\b/.test(head) && !/^[^{]*=/.test(head)) {
          if (src[i + 1] !== ';') {
            out.push(src.slice(start, i + 1).trim());
            start = i + 1;
          }
        }
      }
    } else if (c === ';' && depth === 0) {
      out.push(src.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  const tail = src.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/\s*([(){}<>[\],;:|&=?])\s*/g, '$1').replace(/;$/, '').trim();

function bodyOf(stmt: string): string {
  const open = stmt.indexOf('{');
  const close = stmt.lastIndexOf('}');
  return open >= 0 && close > open ? stmt.slice(open + 1, close) : '';
}

function memberNames(body: string): string[] {
  const names = new Set<string>();
  // Interface and class members end with ";"; enum members are separated by ",".
  const enumLike = !/;/.test(body);
  for (const m of splitTopLevel(enumLike ? body.replace(/,/g, ';') : body)) {
    const n = m.match(/^(?:(?:readonly|static|public|protected|private|abstract|declare|get|set|async|override)\s+)*(\[[^\]]+\]|"[^"]+"|'[^']+'|[A-Za-z_$][\w$]*)\s*[?!]?\s*[(:<=;,]?/);
    if (n && !/^(private|protected)\s/.test(m) && !n[1].startsWith('#')) names.add(n[1]);
  }
  return [...names];
}

/**
 * Members of a const typed with one object literal: `declare const graphql: { link(url: Path): GraphQLLink; }`
 * has `link` and nothing else. Undefined when the type is named, intersected or indexed, since its members
 * are then not all spelled out here.
 */
export function literalMembers(stmt: string): string[] | undefined {
  const head = stmt.match(/^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*\{/);
  if (!head) return undefined;
  const open = head[0].length - 1;
  let depth = 0;
  for (let i = open; i < stmt.length; i++) {
    if (stmt[i] === '{') depth++;
    else if (stmt[i] === '}' && --depth === 0) {
      if (!/^\s*;?\s*$/.test(stmt.slice(i + 1))) return undefined;
      const names = memberNames(stmt.slice(open + 1, i));
      return names.some((n) => n.startsWith('[')) ? undefined : names;
    }
  }
  return undefined;
}

const DECL =/^(export\s+)?(declare\s+)?(default\s+)?(abstract\s+)?(async\s+)?(function|class|interface|type|const|let|var|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/;

export interface ParsedDts {
  /** Declarations by name, exported or not (an "export { a }" list may expose them later). */
  decls: Map<string, ExportEntry & { exported: boolean; body?: string }>;
  /** `export * from "x"`. */
  starFrom: string[];
  /** `export { a, b as c } from "x"`: local name -> [exported name, module]. */
  namedFrom: { name: string; as: string; from: string }[];
  /** `export * as ns from "x"` or `import * as ns from "x"` + `export { ns }`. */
  namespaceFrom: { as: string; from: string }[];
  /** `export { a, b as c }` without a module. */
  localExports: { name: string; as: string }[];
  /** `export = x`. */
  exportEquals?: string;
}

function kindOf(word: string): ExportKind {
  if (word === 'let' || word === 'var') return 'const';
  if (word === 'module') return 'namespace';
  return word as ExportKind;
}

export function parseDts(src: string): ParsedDts {
  const res: ParsedDts = { decls: new Map(), starFrom: [], namedFrom: [], namespaceFrom: [], localExports: [] };
  const nsImports = new Map<string, string>();
  for (const stmt of splitTopLevel(stripComments(src))) {
    let m: RegExpMatchArray | null;
    if ((m = stmt.match(/^export\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]/))) {
      res.namespaceFrom.push({ as: m[1], from: m[2] });
      continue;
    }
    if ((m = stmt.match(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/))) {
      res.starFrom.push(m[1]);
      continue;
    }
    if ((m = stmt.match(/^import\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]/))) {
      nsImports.set(m[1], m[2]);
      continue;
    }
    if ((m = stmt.match(/^export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s+['"]([^'"]+)['"])?/))) {
      for (const part of m[1].split(',').map((p) => p.trim().replace(/^type\s+/, '')).filter(Boolean)) {
        const [name, as] = part.split(/(?<!\s)\s+as\s+/).map((x) => x.trim());
        if (m[2]) res.namedFrom.push({ name, as: as ?? name, from: m[2] });
        else if (nsImports.has(name)) res.namespaceFrom.push({ as: as ?? name, from: nsImports.get(name) as string });
        else res.localExports.push({ name, as: as ?? name });
      }
      continue;
    }
    if ((m = stmt.match(/^export\s*=\s*([\w$.]+)/))) {
      res.exportEquals = m[1];
      continue;
    }
    if ((m = stmt.match(/^export\s+default\s+([\w$]+)\s*;?$/))) {
      res.localExports.push({ name: m[1], as: 'default' });
      continue;
    }
    const d = stmt.match(DECL);
    if (!d) continue;
    const kind = kindOf(d[6]);
    const name = d[3] ? 'default' : d[7];
    const exported = Boolean(d[1]);
    const head = norm(stmt.replace(/^export\s+/, '').replace(/^declare\s+/, ''));
    const block = kind === 'class' || kind === 'interface' || kind === 'enum' || kind === 'namespace';
    const body = block ? bodyOf(stmt) : undefined;
    const signature = block ? norm(head.slice(0, head.indexOf('{') >= 0 ? head.indexOf('{') : undefined)) : head;
    const prev = res.decls.get(name);
    if (prev && kind === 'function' && prev.kind === 'function') {
      prev.signature = [prev.signature, signature].sort().join(' | ');
      prev.exported ||= exported;
      continue;
    }
    if (prev && block && prev.members) {
      // Declaration merging: interface A {..} interface A {..}.
      prev.members = [...new Set([...prev.members, ...memberNames(body ?? '')])];
      prev.exported ||= exported;
      continue;
    }
    const members = block && kind !== 'namespace' ? memberNames(body ?? '') : kind === 'const' ? literalMembers(stmt) : undefined;
    res.decls.set(name, { kind, signature, members, exported, body });
  }
  return res;
}

/** The exports one file declares itself (no following of other modules). */
export function ownExports(p: ParsedDts): ExportMap {
  const out: ExportMap = new Map();
  if (p.exportEquals) {
    const target = p.decls.get(p.exportEquals);
    if (target?.kind === 'namespace' && target.body) {
      for (const [k, v] of parseDts(target.body).decls) out.set(k, { kind: v.kind, signature: v.signature, members: v.members });
    } else if (target) out.set('export=', { kind: target.kind, signature: target.signature, members: target.members });
  }
  for (const [k, v] of p.decls) if (v.exported) out.set(k, { kind: v.kind, signature: v.signature, members: v.members });
  for (const e of p.localExports) {
    const v = p.decls.get(e.name);
    out.set(e.as, v ? { kind: v.kind, signature: v.signature, members: v.members } : { kind: 'unknown', signature: e.name });
  }
  return out;
}

export interface ApiDiff {
  removed: { name: string; kind: ExportKind }[];
  changed: { name: string; kind: ExportKind; before: string; after: string; removedMembers?: string[] }[];
  added: string[];
}

export function diffExports(before: ExportMap, after: ExportMap): ApiDiff {
  const removed: ApiDiff['removed'] = [];
  const changed: ApiDiff['changed'] = [];
  for (const [name, a] of before) {
    const b = after.get(name);
    if (!b) {
      removed.push({ name, kind: a.kind });
      continue;
    }
    if (a.kind === 'unknown' || b.kind === 'unknown') continue;
    if (a.members && b.members) {
      const gone = a.members.filter((m) => !b.members?.includes(m));
      if (gone.length || a.kind !== b.kind) changed.push({ name, kind: b.kind, before: a.signature, after: b.signature, removedMembers: gone });
      // A const's signature is its whole type: a member whose type changed is still a change.
      else if (a.kind === 'const' && a.signature !== b.signature) changed.push({ name, kind: b.kind, before: a.signature, after: b.signature });
      continue;
    }
    if (a.signature !== b.signature) changed.push({ name, kind: b.kind, before: a.signature, after: b.signature });
  }
  const added = [...after.keys()].filter((k) => !before.has(k));
  return { removed, changed, added };
}

// ------------------------------------------------------------- fetching ----

interface JsDelivrFlat {
  files?: { name: string; size: number }[];
}

/** Same cache key and URL as the docs listing, so both features share one request. */
async function listing(name: string, version: string): Promise<Set<string>> {
  const l = await cached(`jsd:npm:${name}@${version}`, config.ttl.docs, () =>
    getJson<JsDelivrFlat>(`https://data.jsdelivr.com/v1/packages/npm/${name}@${encodeURIComponent(version)}?structure=flat`),
  ).catch(() => ({ files: [] }) as JsDelivrFlat);
  return new Set((l.files ?? []).map((f) => f.name.replace(/^\//, '')));
}

/** "types" of an exports condition object, preferring import types. */
export function typesFromExport(value: unknown): string | undefined {
  if (typeof value === 'string') return /\.d\.[cm]?ts$/.test(value) ? value : undefined;
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.types === 'string') return o.types;
  for (const k of ['import', 'require', 'node', 'default']) {
    const t = typesFromExport(o[k]);
    if (t) return t;
  }
  return undefined;
}

const clean = (p: string) => p.replace(/^\.\//, '').replace(/^\//, '');

/** A module specifier inside a .d.ts, resolved to a file in the package listing. */
function resolveModule(fromFile: string, spec: string, files: Set<string>): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const parts = [...(dir ? dir.split('/') : []), ...spec.split('/')];
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  const base = stack.join('/');
  const stem = base.replace(/\.(c|m)?js$/, '');
  const tries = [
    base, `${stem}.d.ts`, `${stem}.d.cts`, `${stem}.d.mts`, `${base}.d.ts`,
    `${base}/index.d.ts`, `${base}/index.d.cts`, `${base}/index.d.mts`,
  ];
  if (/\.cjs$/.test(base)) tries.unshift(`${stem}.d.cts`);
  if (/\.mjs$/.test(base)) tries.unshift(`${stem}.d.mts`);
  return tries.find((t) => /\.d\.[cm]?ts$/.test(t) && files.has(t));
}

export interface ApiSurface {
  /** Entry point label ("." or "./server") -> exports. */
  entries: Map<string, ExportMap>;
  /** Entries whose re-export graph was cut by the file budget or did not parse: not comparable. */
  incomplete: Set<string>;
}

const FILES_PER_ENTRY = 150;
const MAX_ENTRIES = 8;

/** Entry points with their .d.ts: the root, each exports subpath, or root-level .d.ts files when there is no exports map. */
export function typeEntries(pkg: Record<string, unknown>, files: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  const exp = pkg.exports as Record<string, unknown> | string | undefined;
  const rootTypes = (pkg.types ?? pkg.typings) as string | undefined;
  if (exp && typeof exp === 'object' && Object.keys(exp).some((k) => k.startsWith('.'))) {
    for (const [k, v] of Object.entries(exp)) {
      if (!k.startsWith('.') || k.includes('*') || k.endsWith('.json')) continue;
      const t = typesFromExport(v) ?? (k === '.' ? rootTypes : undefined);
      if (t && files.has(clean(t))) out.set(k, clean(t));
    }
  } else {
    const t = typesFromExport(exp) ?? rootTypes;
    if (t && files.has(clean(t))) out.set('.', clean(t));
    else if (files.has('index.d.ts')) out.set('.', 'index.d.ts');
    // Without an exports map, "pkg/server" resolves to server.d.ts at the package root.
    for (const f of files) if (/^[\w-]+\.d\.ts$/.test(f) && f !== 'index.d.ts' && f !== out.get('.')) out.set(`./${f.replace(/\.d\.ts$/, '')}`, f);
  }
  return out;
}

/** Entry points walk the same files in parallel: one request per file. */
const inflight = new Map<string, Promise<string | undefined>>();

async function readDts(name: string, version: string, file: string): Promise<string | undefined> {
  const url = `https://cdn.jsdelivr.net/npm/${name}@${version}/${file}`;
  let p = inflight.get(url);
  if (!p) {
    p = fetchFile(url);
    inflight.set(url, p);
    p.finally(() => setTimeout(() => inflight.delete(url), 60_000).unref?.());
  }
  return p;
}

interface Walk {
  left: number;
  cut: boolean;
  failed: boolean;
}

/** Follows re-exports from one entry file under a file budget; sibling modules are read in parallel. */
async function exportsOf(name: string, version: string, file: string, files: Set<string>, walk: Walk, seen: Set<string>): Promise<ExportMap> {
  const out: ExportMap = new Map();
  if (seen.has(file)) return out;
  if (walk.left <= 0) {
    walk.cut = true;
    return out;
  }
  seen.add(file);
  walk.left--;
  const src = await readDts(name, version, file);
  if (!src) {
    walk.failed = true;
    return out;
  }
  const p = parseDts(src);
  for (const [k, v] of ownExports(p)) out.set(k, v);
  const stars = await Promise.all(
    p.starFrom.map((spec) => {
      const target = resolveModule(file, spec, files);
      return target ? exportsOf(name, version, target, files, walk, seen) : Promise.resolve(new Map() as ExportMap);
    }),
  );
  for (const sub of stars) for (const [k, v] of sub) if (!out.has(k) && k !== 'default') out.set(k, v);
  const named = await Promise.all(
    p.namedFrom.map(async (n) => {
      const target = resolveModule(file, n.from, files);
      // Already-read modules return empty here; their names were merged above.
      return target ? exportsOf(name, version, target, files, walk, new Set([...seen].filter((s) => s !== target))) : undefined;
    }),
  );
  p.namedFrom.forEach((n, i) => {
    if (!out.has(n.as) || out.get(n.as)?.kind === 'unknown') out.set(n.as, named[i]?.get(n.name) ?? { kind: 'unknown', signature: n.name });
  });
  for (const ns of p.namespaceFrom) {
    out.set(ns.as, { kind: 'namespace', signature: `namespace ${ns.as}` });
    // "import * as z" + "export { z }" next to "export * from" the same module: the members are already listed.
    if (p.starFrom.includes(ns.from)) continue;
    const target = resolveModule(file, ns.from, files);
    if (!target) continue;
    const sub = await exportsOf(name, version, target, files, walk, new Set([...seen].filter((s) => s !== target)));
    for (const [k, v] of sub) out.set(`${ns.as}.${k}`, v);
  }
  return out;
}

export async function apiSurface(name: string, version: string): Promise<ApiSurface | undefined> {
  const files = await listing(name, version);
  if (!files.size) return undefined;
  const raw = await fetchFile(`https://cdn.jsdelivr.net/npm/${name}@${version}/package.json`);
  let pkg: Record<string, unknown> = {};
  try {
    pkg = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // keep {}
  }
  const entries = typeEntries(pkg, files);
  const out = new Map<string, ExportMap>();
  const incomplete = new Set<string>();
  const ordered = [...entries.entries()].sort((a, b) => (a[0] === '.' ? -1 : b[0] === '.' ? 1 : a[0].localeCompare(b[0]))).slice(0, MAX_ENTRIES);
  await Promise.all(
    ordered.map(async ([entry, file]) => {
      const walk: Walk = { left: FILES_PER_ENTRY, cut: false, failed: false };
      const exp = await exportsOf(name, version, file, files, walk, new Set());
      out.set(entry, exp);
      if (walk.cut || walk.failed || !exp.size) incomplete.add(entry);
    }),
  );
  return { entries: out, incomplete };
}

export interface EntryDiff extends ApiDiff {
  entry: string;
  /** Exports gone from this entry that another entry now has (msw 3's `graphql`, now in msw/graphql). */
  moved?: { name: string; kind: ExportKind; to: string; removedMembers?: string[] }[];
}

/** Removed exports that another entry of `to` gained: moved, not gone, with the members they lost on the way. */
function movedExports(entry: string, d: ApiDiff, before: ExportMap, from: ApiSurface, to: ApiSurface): EntryDiff['moved'] {
  const moved: NonNullable<EntryDiff['moved']> = [];
  for (const r of d.removed) {
    // Every entry has its own default export: the same name there says nothing about where this one went.
    if (r.name === 'default' || r.name === 'export=') continue;
    const dest = [...to.entries.entries()].find(([e, exp]) => e !== entry && exp.has(r.name) && !from.entries.get(e)?.has(r.name));
    if (!dest) continue;
    const a = before.get(r.name);
    const b = dest[1].get(r.name);
    const gone = a?.members && b?.members ? a.members.filter((m) => !b.members?.includes(m)) : [];
    moved.push({ name: r.name, kind: b?.kind === 'unknown' ? r.kind : (b?.kind ?? r.kind), to: dest[0], ...(gone.length ? { removedMembers: gone } : {}) });
  }
  return moved;
}

/**
 * Diff of every entry point present at `from`; an entry missing at `to` is
 * reported as removed. Entries either side could not read completely are not
 * compared, so a cut-off walk never shows up as "removed".
 */
export function diffSurfaces(from: ApiSurface, to: ApiSurface): { diffs: EntryDiff[]; removedEntries: string[]; addedEntries: string[]; skipped: string[] } {
  const diffs: EntryDiff[] = [];
  const removedEntries: string[] = [];
  const skipped: string[] = [];
  for (const [entry, before] of from.entries) {
    const after = to.entries.get(entry);
    if (!after) {
      removedEntries.push(entry);
      continue;
    }
    if (from.incomplete.has(entry) || to.incomplete.has(entry)) {
      skipped.push(entry);
      continue;
    }
    const d = diffExports(before, after);
    const moved = movedExports(entry, d, before, from, to) ?? [];
    if (moved.length) d.removed = d.removed.filter((r) => !moved.some((m) => m.name === r.name));
    if (d.removed.length || d.changed.length || d.added.length || moved.length) diffs.push({ entry, ...d, ...(moved.length ? { moved } : {}) });
  }
  const addedEntries = [...to.entries.keys()].filter((e) => !from.entries.has(e));
  return { diffs, removedEntries, addedEntries, skipped };
}
