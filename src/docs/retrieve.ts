/**
 * Local retrieval: split documents into sections and rank them with BM25
 * against the agent's query. No embeddings, no index service: the documents of
 * one package version are small enough to rank on the fly.
 */

export interface DocFile {
  /** Shown to the agent: "README.md", "docs/routing/middleware.mdx", "index.d.ts". */
  label: string;
  url: string;
  content: string;
  kind: 'markdown' | 'types' | 'text';
  /** Docs that match the exact version (package files, repo at the release tag). */
  versionAccurate: boolean;
  /** Multiplier for a source we trust more for this query (README of a small package...). */
  boost?: number;
  /** Code language of a `types` file; TypeScript when unset. */
  lang?: 'python';
}

export interface Chunk {
  file: DocFile;
  title: string;
  text: string;
  score: number;
  /** Score against each topic of a question that asks several things (see `topics`). */
  topicScores?: number[];
}

const STOP = new Set(
  'a an and are as at be by for from how i in is it of on or that the this to use using with what when where which why do does can my your you me we our'.split(' '),
);

/**
 * Plural to singular, enough for "errors" to find error.md and "guard" to find guards.md. Not a
 * stemmer: verb forms stay apart. Both sides of every comparison go through it, so an odd stem
 * ("cookies", "cookie" -> "cooky") still matches itself.
 */
export function singular(t: string): string {
  if (t.length <= 3) return t;
  if (/(ss|ch|sh|x)es$/.test(t)) return t.slice(0, -2);
  if (/ies$/.test(t) && t.length > 4) return `${t.slice(0, -3)}y`;
  if (/ie$/.test(t)) return `${t.slice(0, -2)}y`;
  if (/[^su]s$/.test(t) && !/is$/.test(t)) return t.slice(0, -1);
  return t;
}

export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase -> camel Case
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(singular);
}

const MAX_CHUNK = 2400;

function splitLong(title: string, body: string): { title: string; text: string }[] {
  if (body.length <= MAX_CHUNK) return [{ title, text: body }];
  const out: { title: string; text: string }[] = [];
  let buf = '';
  for (const para of body.split(/\n{2,}/)) {
    if (buf && buf.length + para.length > MAX_CHUNK) {
      out.push({ title, text: buf });
      buf = '';
    }
    buf += (buf ? '\n\n' : '') + para.slice(0, MAX_CHUNK * 2);
  }
  if (buf.trim()) out.push({ title, text: buf });
  return out;
}

/**
 * "Title ##" -> "Title": an ATX heading's optional closing sequence, stripped by hand. The regex
 * that did it (lazy text, then whitespace, hashes, whitespace) backtracked cubically on a heading
 * full of spaces.
 */
export function closingHashes(s: string): string {
  const t = s.trimEnd();
  let end = t.length;
  while (end > 0 && t[end - 1] === '#') end--;
  const u = t.slice(0, end);
  return u === t || u === '' || /\s$/.test(u) ? u.trimEnd() || t : t;
}

/** Markdown/MDX/RST: one chunk per heading, carrying the heading trail as title. */
export function chunkMarkdown(content: string, rstHeadings = false): { title: string; text: string }[] {
  // YAML front matter: keep its title as the first heading, drop the rest.
  let text = content.replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    const title = fm[1].match(/^title:\s*['"]?(.+?)['"]?\s*$/m)?.[1];
    text = (title ? `# ${title}\n` : '') + text.slice(fm[0].length);
  }
  const lines = text.split('\n');
  const out: { title: string; text: string }[] = [];
  const trail: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) out.push(...splitLong(trail.filter(Boolean).join(' > '), text));
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const md = !inFence && line.match(/^(#{1,4})\s+(\S.*)$/);
    // RST: a title line followed by ==== / ---- / ~~~~ underline.
    const rst = rstHeadings && !inFence && /^[=\-~^]{3,}\s*$/.test(lines[i + 1] ?? '') && line.trim() && !/^[=\-~^]{3,}/.test(line);
    if (md || rst) {
      flush();
      const level = md ? md[1].length : ({ '=': 1, '-': 2, '~': 3, '^': 4 } as Record<string, number>)[lines[i + 1].trim()[0]] ?? 2;
      trail.length = level - 1;
      // "{ #anchor }" suffixes (mkdocs) are noise in a title.
      trail[level - 1] = (md ? closingHashes(md[2]) : line.trim()).replace(/(?<!\s)\s*\{\s*#[^{}]*\}\s*$/, '');
      buf.push(md ? line : `## ${line.trim()}`);
      if (rst) i++;
      continue;
    }
    // MDX noise: imports and bare JSX component lines carry no prose.
    if (!inFence && /^(import|export)\s.+from\s+['"]/.test(line)) continue;
    buf.push(line);
  }
  flush();
  return out;
}

/** Type definitions: one chunk per top-level declaration with its doc comment. */
export function chunkTypes(content: string): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  let buf: string[] = [];
  let title = '';
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text && /[A-Za-z]/.test(text)) out.push(...splitLong(title, text));
    buf = [];
  };
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    const decl = line.match(/^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(function|class|interface|type|const|let|enum|namespace|module)\s+([A-Za-z0-9_$]+)/);
    if (decl || /^\/\*\*/.test(line)) {
      // A doc comment starts a new chunk unless it immediately precedes the declaration we are in.
      if (decl && buf.length && buf.every((l) => /^\s*(\/\*\*|\*|\*\/)/.test(l))) {
        title = `${decl[1]} ${decl[2]}`;
      } else {
        flush();
        title = decl ? `${decl[1]} ${decl[2]}` : '';
      }
    }
    buf.push(line);
  }
  flush();
  return out;
}

/**
 * Python API (stub-like source): one chunk per top-level function or class
 * with its decorators and docstring; a class too long for one chunk is split
 * into its header and one chunk per method. Titles carry the module path
 * ("def yaml.safe_load") when the text starts with a "# module x" line.
 */
export function chunkPython(content: string): { title: string; text: string }[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const mod = lines[0]?.match(/^# module ([\w.]+)/)?.[1];
  const prefix = mod ? `${mod}.` : '';
  const out: { title: string; text: string }[] = [];

  /** Splits `src` before each decorator/def/class line at `indent`, outside docstrings. */
  const blocks = (src: string[], indent: string): { name?: string; kind?: string; lines: string[] }[] => {
    const res: { name?: string; kind?: string; lines: string[] }[] = [{ lines: [] }];
    let inDoc = false;
    let decorated = false;
    for (const line of src) {
      if (!inDoc && line.startsWith(indent) && !/^\s/.test(line.slice(indent.length))) {
        const rest = line.slice(indent.length);
        const def = rest.match(/^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
        if (rest.startsWith('@') || def) {
          if (!decorated) res.push({ lines: [] });
          decorated = rest.startsWith('@');
          if (def) Object.assign(res[res.length - 1], { kind: def[1], name: def[2] });
        }
      }
      if ((line.match(/"""/g) ?? []).length % 2 === 1) inDoc = !inDoc;
      res[res.length - 1].lines.push(line);
    }
    return res.filter((b) => b.lines.join('').trim());
  };

  for (const b of blocks(lines, '')) {
    const text = b.lines.join('\n').trim();
    const title = b.name ? `${b.kind} ${prefix}${b.name}` : `module ${mod ?? ''}`.trim();
    if (b.kind !== 'class' || text.length <= MAX_CHUNK) {
      out.push(...splitLong(title, text));
      continue;
    }
    const parts = blocks(b.lines, '    ');
    const head = parts[0]?.name ? undefined : parts.shift();
    const classLine = b.lines.find((l) => /^class\s/.test(l));
    const headerLine = classLine?.endsWith(':') ? classLine : `class ${b.name}:`;
    if (head) out.push(...splitLong(title, head.lines.join('\n').trim()));
    for (const m of parts) out.push(...splitLong(`${title} > ${m.kind} ${m.name ?? ''}`.trim(), `${headerLine}\n${m.lines.join('\n').trimEnd()}`));
  }
  return out;
}

/**
 * Drops what costs the agent tokens and teaches it nothing: the heading line the
 * title already carries, images, HTML comments, bare JSX component tags, and the
 * targets of site-relative links. Code fences are left untouched.
 */
export function tidy(text: string): string {
  const out: string[] = [];
  let inFence = false;
  let first = true;
  for (const line of text.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence || /^\s*(```|~~~)/.test(line)) {
      out.push(line);
      first = false;
      continue;
    }
    if (first && /^#{1,6}\s/.test(line)) {
      first = false;
      continue;
    }
    if (/^\s*<\/?[A-Z][\w.]*(\s[^>]*)?\/?>\s*$/.test(line)) continue;
    const l = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\((?:\/|\.{1,2}\/|#)[^)]*\)/g, '$1');
    if (first && !l.trim()) continue;
    first = false;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function chunkFile(file: DocFile): Chunk[] {
  const parts =
    file.kind === 'types'
      ? file.lang === 'python' ? chunkPython(file.content) : chunkTypes(file.content)
      : chunkMarkdown(file.content, /\.rst$/i.test(file.url));
  return parts
    .map((p) => ({ file, title: p.title, text: file.kind === 'types' ? p.text : tidy(p.text), score: 0 }))
    .filter((c) => c.text);
}

/**
 * The topics of a question that asks several things at once ("reject unknown keys; enum from a
 * TypeScript enum; record of strings", "ConfigDict frozen, field_validator, model_validator, Field
 * pattern"): ranked as one bag of words, the topic with the most matching text takes the whole
 * answer. Split on semicolons, commas, colons and line breaks; empty when there is one topic.
 */
export function topics(query: string): string[] {
  const parts = query
    .split(/[;\n]|[,:?](?=\s)|\s+(?:\d+[.)]|-)\s+/)
    .map((p) => p.trim())
    .filter((p) => tokenize(p).length);
  return parts.length >= 2 ? [...new Set(parts)].slice(0, 8) : [];
}

/**
 * BM25 over the chunks; title and file path count twice. With `topicList`, each chunk also gets
 * a score per topic (same statistics), which `select` uses to give every topic a section.
 */
export function rank(chunks: Chunk[], query: string, topicList: string[] = []): Chunk[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !chunks.length) return chunks;
  const docs = chunks.map((c) => {
    const toks = [...tokenize(c.text), ...tokenize(c.title), ...tokenize(c.title), ...tokenize(c.file.label)];
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { len: toks.length, tf };
  });
  const avg = docs.reduce((a, d) => a + d.len, 0) / docs.length;
  const topicTerms = topicList.map((t) => [...new Set(tokenize(t))]);
  const df = new Map<string, number>();
  for (const t of new Set([...q, ...topicTerms.flat()])) df.set(t, docs.filter((d) => d.tf.has(t)).length);
  const k1 = 1.2;
  const b = 0.75;
  const N = docs.length;
  const bm25 = (i: number, terms: string[]) => {
    let s = 0;
    for (const t of terms) {
      const f = docs[i].tf.get(t) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docs[i].len) / avg)));
    }
    return s;
  };
  chunks.forEach((c, i) => {
    // Code examples are what agents copy; favor chunks that carry some.
    const weight = (/```|^\s{4}\S/m.test(c.text) ? 1.15 : 1) * (c.file.boost ?? 1);
    c.score = bm25(i, q) * weight;
    c.topicScores = topicTerms.length ? topicTerms.map((terms) => bm25(i, terms) * weight) : undefined;
  });
  return [...chunks].sort((a, b2) => b2.score - a.score);
}

/** Up to `max` items: the best of each topic's ranking first, then the overall ranking. */
export function topicsFirst<T>(overall: T[], perTopic: T[][], max: number, key: (t: T) => string): T[] {
  const out = new Map<string, T>();
  for (const list of perTopic) if (list[0] && out.size < max && !out.has(key(list[0]))) out.set(key(list[0]), list[0]);
  for (const t of overall) {
    if (out.size >= max) break;
    if (!out.has(key(t))) out.set(key(t), t);
  }
  return [...out.values()];
}

/** Share of distinct tokens two texts have in common (Jaccard). */
export function overlap(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/** Above this overlap a section repeats one already picked (the same step in the Next.js, Nuxt and SvelteKit guides). */
const NEAR_DUPLICATE = 0.7;

/**
 * Best chunks that fit the budget, at most `perFile` from one file so one long page cannot crowd out
 * the rest, and no near-duplicate of a chunk already picked.
 */
export function select(ranked: Chunk[], budgetChars: number, perFile = 3): Chunk[] {
  const out: Chunk[] = [];
  const picked: Set<string>[] = [];
  const count = new Map<string, number>();
  let used = 0;
  const sizeOf = (c: Chunk) => c.text.length + c.title.length + 80;
  const take = (c: Chunk, limit: number): boolean => {
    const n = count.get(c.file.url) ?? 0;
    if (n >= perFile || out.includes(c) || used + sizeOf(c) > limit) return false;
    const toks = new Set(tokenize(c.text));
    if (toks.size >= 20 && picked.some((p) => overlap(toks, p) >= NEAR_DUPLICATE)) return false;
    out.push(c);
    picked.push(toks);
    count.set(c.file.url, n + 1);
    used += sizeOf(c);
    return true;
  };

  // A question with several topics: first the best section for each topic, each within its share of
  // the budget (a topic whose best section is already in covers itself), then the rest by overall score.
  const nTopics = ranked.find((c) => c.topicScores)?.topicScores?.length ?? 0;
  if (nTopics) {
    const share = Math.max(budgetChars / nTopics, 1500);
    for (let t = 0; t < nTopics; t++) {
      const best = ranked.filter((c) => (c.topicScores?.[t] ?? 0) > 0).sort((a, b) => (b.topicScores?.[t] ?? 0) - (a.topicScores?.[t] ?? 0));
      if (best[0] && out.includes(best[0])) continue;
      for (const c of best.slice(0, 5)) if (sizeOf(c) <= share * 1.5 && take(c, budgetChars)) break;
    }
  }

  for (const c of ranked) {
    if (c.score <= 0) break;
    if (out.includes(c)) continue;
    if (used + sizeOf(c) > budgetChars) {
      if (used > budgetChars * 0.6) break;
      continue;
    }
    take(c, budgetChars);
  }
  return out;
}

/**
 * Text in a repo that is not documentation for the package's users: notes for contributors and
 * for coding agents (AGENTS.md, .agents/skills, docs/plans, a compiler's internal passes), eval
 * prompts, benchmark write-ups, the content of example apps. It matches the words of a question
 * as well as a guide does ("form", "action", "markdown", "connection") and teaches the wrong thing.
 */
const NOT_USER_DOCS =
  /(^|\/)(\.[\w-]+|evals?|plans?|rfcs?|benchmarks?|benchmarking|perf|performance|e2e|examples?|samples?|playground|fixtures|scripts|internals?|migrations|passes|rust-port)\/|(^|\/)(AGENTS|CLAUDE|GEMINI|SKILL|PROMPT|MAINTAIN\w*|TESTING|RELEASING|\w*PUBLISHING|DEVELOP\w*|ARCHITECTURE|GOVERNANCE|SUPPORT|ROADMAP)\.(md|mdx|rst|txt)$|(^|\/)_[\w-]+\.mdx?$/i;

/** Contributor and agent notes, evals, example apps; error-message pages (Next's errors/*) unless the question is about an error. */
export function notUserDocs(path: string, query = ''): boolean {
  return NOT_USER_DOCS.test(path) || (/(^|\/)errors\//i.test(path) && !/\berror/i.test(query));
}

/** Ranks file paths before downloading them: we cannot fetch 500 docs pages per question. */
export function rankPaths<T extends { path: string }>(files: T[], query: string, extraTerms: string[] = []): (T & { score: number; terms: string[] })[] {
  const q = new Set([...tokenize(query), ...extraTerms.flatMap(tokenize)]);
  const tokens = files.map((f) => tokenize(f.path.replace(/\.(mdx?|rst|txt|d\.ts)$/i, '')));
  // In a large tree a term found in a handful of paths ("middleware") says more than one found in hundreds
  // ("routes", "redirect"): weigh hits by rarity, between 0.5 and 1.5. Small lists keep a flat weight of 1.
  const weight = new Map<string, number>();
  const n = files.length;
  for (const t of q) {
    const df = tokens.filter((toks) => toks.includes(t)).length;
    weight.set(t, n < 20 || !df ? 1 : 0.5 + Math.log((n + 1) / df) / Math.log(n + 1));
  }
  return files
    .map((f, i) => {
      const toks = tokens[i];
      let s = 0;
      for (const t of toks) if (q.has(t)) s += weight.get(t) ?? 1;
      // Shallow, docs-like paths beat deep ones with the same hits.
      s -= f.path.split('/').length * 0.02;
      return { ...f, score: s, terms: [...new Set(toks.filter((t) => q.has(t)))] };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * The best `max` path hits, covering as many query terms as possible first: a question about
 * "ConfigDict, extra, field_validator" must not get twelve pydantic_extra_types_* pages.
 * Each pick takes the highest-scoring file that adds a term not covered yet; the rest by score.
 */
export function coverPaths<T extends { score: number; terms: string[] }>(ranked: T[], max: number): T[] {
  const out: T[] = [];
  const covered = new Set<string>();
  const left = [...ranked];
  while (out.length < max && left.length) {
    const i = left.findIndex((f) => f.terms.some((t) => !covered.has(t)));
    if (i < 0) break;
    const [f] = left.splice(i, 1);
    f.terms.forEach((t) => covered.add(t));
    out.push(f);
  }
  return [...out, ...left.slice(0, max - out.length)];
}
