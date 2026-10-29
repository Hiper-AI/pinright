/**
 * Renames a package announces itself: `@deprecated Use \`instructions\` instead.` on the `system`
 * option of its type definitions, "on_event is deprecated, use lifespan" in a docstring, "`system`
 * → `instructions`" in the migration guide of its current major. An agent asks with the words it
 * learned ("system prompt", "on_event", "nativeEnum"); the docs answer with the new ones. When a
 * question uses an old name, the new one joins the query, and the answer says what was renamed.
 * Learned from each package's own files, never from a hand-written list.
 */
import { type Ecosystem } from '../ecosystems.js';
import { type PackageMeta } from '../registry.js';
import { type PythonApi } from './python.js';
import { tokenize } from './retrieve.js';
import { fetchFile, type RemoteFile } from './sources.js';

export interface Rename {
  from: string;
  to: string;
  /** Where it was read: "index.d.ts", "migration-guide-7-0.mdx". */
  source: string;
}

/** An identifier as code writes it; anything else in a matched phrase is not a rename. */
const IDENT = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const MAX_NAME = 40;

/** Language keywords: "`let` → `var`" in a compiler's changelog is about the language, not the API. */
const KEYWORDS = new Set('let var const new export import function class def return async await type interface from true false null none self this'.split(' '));

function clean(name: string): string | undefined {
  const n = name.trim().replace(/^[.@]/, '').replace(/\(\)$/, '').replace(/[:,;]$/, '');
  return n.length <= MAX_NAME && IDENT.test(n) && !KEYWORDS.has(n.toLowerCase()) ? n : undefined;
}

function add(out: Rename[], from: string, to: string, source: string): void {
  const f = clean(from);
  const t = clean(to);
  if (!f || !t || f === t || f.split('.').pop() === t.split('.').pop()) return;
  // The source is a file name from the package listing, shown to the agent: plain path characters only.
  const src = source.replace(/[^\w./-]/g, '').slice(0, 80);
  if (!out.some((r) => r.from === f && r.to === t)) out.push({ from: f, to: t, source: src });
}

const VERB = '\\b(?:use|renamed to|replaced (?:by|with)|in favou?r of|prefer|switch to|migrate to)\\s+(?:the\\s+)?';
/**
 * The replacement a deprecation note names: "Use `instructions` instead", "renamed to {@link isStepCount}",
 * "use lifespan event handlers instead". A bare word counts only when it looks like code or "instead"
 * follows: "use with caution" names nothing.
 */
const TARGETS = [
  new RegExp(`${VERB}(?:\`|\\{@link\\s+|\\[\`?)([A-Za-z_$][\\w$.]*)`, 'i'),
  new RegExp(`${VERB}([A-Za-z_$][\\w$]*[A-Z_.][\\w$.]*)(?:\\(\\))?`),
  new RegExp(`${VERB}([A-Za-z_$][\\w$]*)(?:\\(\\))?(?:\\s+[a-z]+){0,2}\\s+instead\\b`, 'i'),
];
const target = (note: string): string | undefined => {
  for (const re of TARGETS) {
    const m = note.match(re)?.[1];
    if (m) return m;
  }
  return undefined;
};

/**
 * Whether the API declares `name` (a parameter, property, function, class, attribute): "use lifespan
 * event handlers instead" names the `lifespan` parameter, "use literal values instead" names nothing.
 */
export function declaredIn(api: string, name: string): boolean {
  const n = (name.split('.').pop() ?? name).replace(/\$/g, '\\$');
  return new RegExp(`(\\b(def|class|function|const|let|interface|type|enum)\\s+${n}\\b)|((^|[\\s(,{.])${n}\\??\\s*[:=(<])`, 'm').test(api);
}

/** `@deprecated` in a doc comment, paired with the declaration it documents. */
export function renamesFromTypes(dts: string, source: string): Rename[] {
  const out: Rename[] = [];
  const lines = dts.replace(/\r\n/g, '\n').split('\n');
  let inDoc = false;
  let note: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\*\*/.test(line)) {
      inDoc = true;
      note = undefined;
    }
    if (inDoc) {
      const d = line.match(/@deprecated\b(.*)/);
      if (d) note = d[1];
      else if (note !== undefined && !/^\s*\*\s*@/.test(line)) note += ` ${line.replace(/^\s*\*\/?/, '')}`;
      else if (/^\s*\*\s*@/.test(line)) note = note === undefined ? undefined : `${note} `;
      if (/\*\//.test(line)) {
        inDoc = false;
        if (note === undefined) continue;
        const decl = lines.slice(i + 1, i + 4).find((l) => l.trim());
        const name = decl?.match(/^\s*(?:export\s+)?(?:declare\s+)?(?:readonly\s+)?(?:(?:function|const|let|var|class|interface|type|enum)\s+)?([A-Za-z_$][\w$]*)\s*[?(:<=]/)?.[1];
        const to = target(note);
        if (name && to) add(out, name, to, source);
        note = undefined;
      }
    }
  }
  return out;
}

/** Python API as rendered from the wheel: a def/class whose decorator or docstring says it is deprecated in favor of another name. */
export function renamesFromPython(api: string, source: string): Rename[] {
  const out: Rename[] = [];
  // Each top-level or method definition with what precedes it up to the next one.
  const blocks = api.split(/\n(?=\s*(?:@|(?:async\s+)?def\s|class\s))/);
  let decorators = '';
  for (const b of blocks) {
    const def = b.match(/^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/);
    if (!def) {
      decorators += b;
      continue;
    }
    const text = decorators + b;
    decorators = '';
    if (!/deprecat/i.test(text)) continue;
    // Only the sentence about the deprecation: a docstring that merely mentions "use X" elsewhere is not a rename.
    const sentence = text.match(/[^.\n]*deprecat[^.]*\.?[^.]*/i)?.[0] ?? '';
    const to = target(sentence);
    if (to) add(out, def[1], to, source);
  }
  return out;
}

const CODE = '`([^`\\n]{1,60})`';

/** "`a` → `b`", "`a` was renamed to `b`", "replace `a` with `b`", "use `b` instead of `a`" in a migration guide. */
export function renamesFromGuide(md: string, source: string): Rename[] {
  const out: Rename[] = [];
  const pairs: [RegExp, 'ab' | 'ba'][] = [
    [new RegExp(`${CODE}\\s*(?:→|->|=>|⟶)\\s*${CODE}`, 'g'), 'ab'],
    [new RegExp(`${CODE}\\s+(?:has been |was |is now |is )?(?:renamed|changed) to\\s+${CODE}`, 'gi'), 'ab'],
    [new RegExp(`\\brenamed?\\s+${CODE}\\s+to\\s+${CODE}`, 'gi'), 'ab'],
    [new RegExp(`${CODE}\\s+(?:has been |was |is )?(?:replaced|superseded) (?:by|with)\\s+${CODE}`, 'gi'), 'ab'],
    [new RegExp(`\\breplace\\s+${CODE}\\s+with\\s+${CODE}`, 'gi'), 'ab'],
    [new RegExp(`${CODE}\\s+(?:has been |was |is )?deprecated(?:,| and| in favou?r of| —| -)?\\s+(?:use\\s+)?${CODE}`, 'gi'), 'ab'],
    [new RegExp(`\\buse\\s+${CODE}\\s+instead of\\s+${CODE}`, 'gi'), 'ba'],
    [new RegExp(`${CODE}\\s+(?:is now|becomes)\\s+${CODE}`, 'gi'), 'ab'],
  ];
  for (const [re, order] of pairs) {
    for (const m of md.matchAll(re)) {
      const [a, b] = order === 'ab' ? [m[1], m[2]] : [m[2], m[1]];
      add(out, a, b, source);
    }
  }
  return out;
}

/**
 * Renames whose old name the question uses: every word of the old name is in the question, and
 * the new name is not. At most four, the most specific old names first.
 */
export function applicableRenames(renames: Rename[], query: string): Rename[] {
  const q = new Set(tokenize(query));
  const lower = query.toLowerCase();
  const seen = new Set<string>();
  return renames
    .filter((r) => {
      const last = r.from.split('.').pop() ?? r.from;
      const from = tokenize(last);
      const to = tokenize(r.to.split('.').pop() ?? r.to);
      // A one-word name must appear as written ("system", not "responses" for "response"); a compound one may be spelled out.
      const asked = from.length > 1 ? from.every((t) => q.has(t)) : new RegExp(`(^|[^\\w$])${last.replace(/\$/g, '\\$')}([^\\w$]|$)`, 'i').test(query);
      // Already asked for: the new name as written, or its one word ("system prompt via instructions").
      const has = lower.includes(r.to.toLowerCase()) || (to.length === 1 && q.has(to[0]));
      return from.length && asked && !has;
    })
    .sort((a, b) => b.from.length - a.from.length)
    .filter((r) => !seen.has(r.from) && Boolean(seen.add(r.from)))
    .slice(0, 4);
}

/** The question with each new name next to the old one, so the topic that asked for it searches for both. */
export function expandQuery(query: string, renames: Rename[]): string {
  let q = query;
  for (const r of renames) {
    const old = (r.from.split('.').pop() ?? r.from).replace(/[$]/g, '\\$');
    const words = tokenize(old);
    // Right after the first word of the old name, or at the end when the question spells it differently.
    const at = new RegExp(`(${old}|${words[0]}\\w*)`, 'i');
    q = at.test(q) ? q.replace(at, (m) => `${m} ${r.to}`) : `${q} ${r.to}`;
  }
  return q;
}

const GUIDE = /(^|\/)[^/]*(migrat|upgrad)[^/]*\.(md|mdx|rst)$/i;
const GUIDE_DIR = /(^|\/)(migrat|upgrad)[^/]*\/[^/]+\.(md|mdx|rst)$/i;
const VERSIONED_NOTES = /(^|\/)(changelog|release-notes|whats-new)[^/]*\.(md|mdx|rst)$/i;

/**
 * The migration guide of the current major ("migration-guide-7-0.mdx", "upgrading/version-16.mdx",
 * "v4/changelog.mdx", "migrate-to-10.0.0.md"), else an unnumbered one ("docs/migration.md"). Two at most.
 */
export function currentGuides<T extends { path: string }>(files: T[], version: string): T[] {
  const major = version.split('.')[0];
  if (!/^\d+$/.test(major) || major === '0') return [];
  const numbered = new RegExp(`(^|[^\\d.])v?${major}(?:[-._]0)*(?:[^\\d]|$)`);
  const depth = (f: T) => f.path.split('/').length;
  const isGuide = (p: string) => GUIDE.test(p) || GUIDE_DIR.test(p);
  // "CHANGELOG-pre-5.md" is the history before this major, not its guide.
  const forMajor = files.filter(
    (f) => (isGuide(f.path) || VERSIONED_NOTES.test(f.path)) && numbered.test(f.path.replace(/\.(mdx?|rst)$/i, '')) && !/(pre|before|until)[-_]v?\d/i.test(f.path),
  );
  const pick = forMajor.length ? forMajor : files.filter((f) => isGuide(f.path) && !/\d/.test(f.path.split('/').pop() ?? ''));
  return [...pick].sort((a, b) => depth(a) - depth(b)).slice(0, 2);
}

/**
 * Every rename the package announces for this version: deprecations in its entry type definitions
 * (npm) or its Python API (PyPI), and the migration guide of its current major.
 */
export async function packageRenames(eco: Ecosystem, meta: PackageMeta, files: RemoteFile[], pyApi?: PythonApi): Promise<Rename[]> {
  const entry = meta.typesEntry?.replace(/^\.\//, '');
  const typesUrl = eco === 'npm' && entry?.endsWith('.d.ts') ? `https://cdn.jsdelivr.net/npm/${meta.name}@${meta.version}/${entry}` : undefined;
  const guides = currentGuides(files.filter((f) => !f.path.endsWith('.d.ts')), meta.version);
  const [types, ...texts] = await Promise.all([typesUrl ? fetchFile(typesUrl) : Promise.resolve(undefined), ...guides.map((g) => fetchFile(g.url))]);
  const out: Rename[] = [];
  if (types) out.push(...renamesFromTypes(types, entry!).filter((r) => declaredIn(types, r.to)));
  const py = pyApi?.modules ?? [];
  const pyText = py.map((m) => m.content).join('\n');
  for (const m of py) if (/deprecat/i.test(m.content)) out.push(...renamesFromPython(m.content, m.path).filter((r) => declaredIn(pyText, r.to)));
  guides.forEach((g, i) => {
    if (texts[i]) out.push(...renamesFromGuide(texts[i]!, g.path.split('/').pop() ?? g.path));
  });
  return out;
}

/** The line that tells the agent which names it asked about changed (identifiers only). */
export function renamesNote(name: string, version: string, renames: Rename[]): string | undefined {
  if (!renames.length) return undefined;
  const list = renames.map((r) => `\`${r.from}\` -> \`${r.to}\` (${r.source})`).join(', ');
  return `Renamed or deprecated in ${name}@${version}, per the package's own files: ${list}. The docs below were also searched for the new names.`;
}
