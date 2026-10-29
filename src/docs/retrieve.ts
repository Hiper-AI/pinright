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
}

const STOP = new Set(
  'a an and are as at be by for from how i in is it of on or that the this to use using with what when where which why do does can my your you me we our'.split(' '),
);

export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase -> camel Case
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
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
    const md = !inFence && line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    // RST: a title line followed by ==== / ---- / ~~~~ underline.
    const rst = rstHeadings && !inFence && /^[=\-~^]{3,}\s*$/.test(lines[i + 1] ?? '') && line.trim() && !/^[=\-~^]{3,}/.test(line);
    if (md || rst) {
      flush();
      const level = md ? md[1].length : ({ '=': 1, '-': 2, '~': 3, '^': 4 } as Record<string, number>)[lines[i + 1].trim()[0]] ?? 2;
      trail.length = level - 1;
      // "{ #anchor }" suffixes (mkdocs) are noise in a title.
      trail[level - 1] = (md ? md[2] : line.trim()).replace(/\s*\{\s*#[^}]*\}\s*$/, '');
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

/** BM25 over the chunks; title and file path count twice. */
export function rank(chunks: Chunk[], query: string): Chunk[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !chunks.length) return chunks;
  const docs = chunks.map((c) => {
    const toks = [...tokenize(c.text), ...tokenize(c.title), ...tokenize(c.title), ...tokenize(c.file.label)];
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { len: toks.length, tf };
  });
  const avg = docs.reduce((a, d) => a + d.len, 0) / docs.length;
  const df = new Map<string, number>();
  for (const t of q) df.set(t, docs.filter((d) => d.tf.has(t)).length);
  const k1 = 1.2;
  const b = 0.75;
  const N = docs.length;
  chunks.forEach((c, i) => {
    let s = 0;
    for (const t of q) {
      const f = docs[i].tf.get(t) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docs[i].len) / avg)));
    }
    // Code examples are what agents copy; favor chunks that carry some.
    if (/```|^\s{4}\S/m.test(c.text)) s *= 1.15;
    c.score = s * (c.file.boost ?? 1);
  });
  return [...chunks].sort((a, b2) => b2.score - a.score);
}

/** Best chunks that fit the budget, at most `perFile` from one file so one long page cannot crowd out the rest. */
export function select(ranked: Chunk[], budgetChars: number, perFile = 3): Chunk[] {
  const out: Chunk[] = [];
  const count = new Map<string, number>();
  let used = 0;
  for (const c of ranked) {
    if (c.score <= 0) break;
    const n = count.get(c.file.url) ?? 0;
    if (n >= perFile) continue;
    const size = c.text.length + c.title.length + 80;
    if (used + size > budgetChars) {
      if (used > budgetChars * 0.6) break;
      continue;
    }
    out.push(c);
    count.set(c.file.url, n + 1);
    used += size;
  }
  return out;
}

/** Ranks file paths before downloading them: we cannot fetch 500 docs pages per question. */
export function rankPaths<T extends { path: string }>(files: T[], query: string, extraTerms: string[] = []): (T & { score: number })[] {
  const q = new Set([...tokenize(query), ...extraTerms.flatMap(tokenize)]);
  return files
    .map((f) => {
      const toks = tokenize(f.path.replace(/\.(mdx?|rst|txt|d\.ts)$/i, ''));
      let s = 0;
      for (const t of toks) if (q.has(t)) s += 1;
      // Shallow, docs-like paths beat deep ones with the same hits.
      s -= f.path.split('/').length * 0.02;
      return { ...f, score: s };
    })
    .sort((a, b) => b.score - a.score);
}
