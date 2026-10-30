/**
 * Docs pages whose examples live in separate files: FastAPI, Typer and SQLModel write
 * `{* ../../docs_src/events/tutorial003_py310.py hl[16,19] *}`, Material for MkDocs
 * `--8<-- "docs/snippets/x.py"`, Sphinx `.. literalinclude:: ../examples/x.py`, VitePress
 * `<<< @/snippets/x.ts`, and mkdocs-macros sites call a macro with the file's path and snippet
 * section (Polars: `{{code_block('user-guide/expressions/aggregation','basic',['group_by'])}}`).
 * Shown as is, the agent gets the directive and none of the code. The directives of the sections
 * picked for an answer are replaced with the file they name, read from the same repo at the same
 * ref, within what is left of the budget. A path the page's folders do not resolve is looked up by
 * its ending among the example code of the repo's docs folders, and a `:section` keeps only the
 * lines between the file's `[start:section]` and `[end:section]` markers.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { getText } from '../http.js';

/** Group 1: the path; group 2: a snippet section, when the directive names one. */
const DIRECTIVES: RegExp[] = [
  // A macro called with a quoted path and, optionally, a quoted section: `{{ code_block('a/b', 'sec', [...]) }}`.
  /^[ \t]*\{\{[ \t]*\w+\([ \t]*['"]([\w./-]+)['"](?:[ \t]*,[ \t]*['"]([\w-]+)['"])?[^\n]*\}\}[ \t]*$/gm,
  /^[ \t]*\{\*\s+(\S+)[^\n]*?\*\}[ \t]*$/gm,
  /^[ \t]*-{2}8<-{2}[ \t]+["']([^"':\n]+)(?::([\w-]+))?["'][ \t]*$/gm,
  /^[ \t]*\.\.[ \t]+literalinclude::[ \t]+(\S+)[ \t]*$/gm,
  /^[ \t]*<<<[ \t]+(?:@\/)?(\S+?)(?:\{[^}\n]*\})?[ \t]*$/gm,
];

const LANG: Record<string, string> = { py: 'python', ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', rs: 'rust', go: 'go', toml: 'toml', yaml: 'yaml', yml: 'yaml', json: 'json', sh: 'bash', html: 'html', css: 'css', vue: 'vue', svelte: 'svelte' };

/** Where repo files are served at a ref: jsDelivr or raw GitHub. Other URLs (llms.txt pages, wheels) have no includes we can read. */
function repoBase(url: string): { root: string; dir: string[] } | undefined {
  const m = url.match(/^(https:\/\/cdn\.jsdelivr\.net\/gh\/[^/]+\/[^/@]+@[^/]+\/|https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/)(.*)$/);
  if (!m) return undefined;
  return { root: m[1], dir: m[2].split('/').slice(0, -1) };
}

/** Candidate URLs for an include path: relative to the page, then to each folder above it (MkDocs resolves from its config folder). */
export function includeCandidates(pageUrl: string, path: string): string[] {
  const base = repoBase(pageUrl);
  if (!base || /^[a-z]+:/i.test(path) || path.includes('..\\')) return [];
  const clean = path.replace(/^\.\//, '');
  const out: string[] = [];
  for (let depth = base.dir.length; depth >= 0; depth--) {
    const parts = [...base.dir.slice(0, depth)];
    for (const seg of clean.split('/')) {
      if (seg === '..') {
        if (!parts.length) return out;
        parts.pop();
      } else if (seg && seg !== '.') parts.push(seg);
    }
    const url = base.root + parts.join('/');
    if (!out.includes(url)) out.push(url);
    if (out.length >= 4) break;
  }
  return out;
}

async function fetchInclude(url: string): Promise<string> {
  // A missing candidate is cached too: the next question about the same page must not probe again.
  return cached(`include:${url}`, config.ttl.docs, async () => getText(url).catch(() => ''));
}

export interface IncludeOptions {
  /** Characters the included code may add to the whole answer. */
  budget: number;
  /** Normalizes third-party text the way every other docs file is (hidden text, instructions). */
  prepare: (code: string, source: string) => string;
  /** Lines per included file. */
  maxLines?: number;
  /** The URL of a repo file whose path ends with this one (example code under docs folders). */
  findFile?: (suffix: string) => string | undefined;
  /** Extensions to try, in order, for a macro path that has none. */
  exts?: string[];
}

/** The lines between a snippet section's `[start:name]` and `[end:name]` markers; undefined without them. */
export function snippetSection(code: string, name: string): string | undefined {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.includes(`[start:${name}]`));
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && l.includes(`[end:${name}]`));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => !/\[(start|end):[\w-]+\]/.test(l)).join('\n');
}

/** Lines of the text that sit inside a code fence. */
function fencedLines(text: string): Set<string> {
  const out = new Set<string>();
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    else if (inFence) out.add(line);
  }
  return out;
}

/** Where a directive's file may be: next to the page and the folders above it, then by its ending in the repo. */
function candidatesFor(pageUrl: string, path: string, opts: IncludeOptions): string[] {
  const hasExt = /\.[a-z0-9]+$/i.test(path.split('/').pop() ?? '');
  const tail = path.replace(/^(\.{1,2}\/)+/, '').replace(/^@?\//, '');
  const found = (hasExt ? [tail] : (opts.exts ?? []).map((e) => `${tail}.${e}`)).map((s) => opts.findFile?.(s)).filter((u): u is string => Boolean(u));
  return [...new Set([...(hasExt ? includeCandidates(pageUrl, path) : []), ...found])];
}

/**
 * The text with each include directive replaced by a fenced copy of the file, cut to `maxLines`
 * and to the budget left; a directive whose file cannot be read stays as it was.
 */
export async function expandIncludes(text: string, pageUrl: string, opts: IncludeOptions): Promise<{ text: string; added: number }> {
  if (!repoBase(pageUrl)) return { text, added: 0 };
  const found: { line: string; path: string; section?: string }[] = [];
  for (const re of DIRECTIVES) for (const m of text.matchAll(re)) found.push({ line: m[0], path: m[1], section: m[2] });
  if (!found.length) return { text, added: 0 };
  const fenced = fencedLines(text);
  // The same snippet twice (Polars shows it in a code tab and again in the block that runs it): once.
  const shown = new Set<string>();
  let added = 0;
  let out = text;
  for (const f of found.slice(0, 6)) {
    if (added >= opts.budget) break;
    let code = '';
    let from = '';
    for (const url of candidatesFor(pageUrl, f.path, opts)) {
      code = await fetchInclude(url);
      if (code && !/^\s*(<!doctype html|<html)/i.test(code)) {
        from = url;
        break;
      }
      code = '';
    }
    if (code && f.section) code = snippetSection(code, f.section) ?? '';
    const key = `${from}#${f.section ?? ''}`;
    if (!code.trim() || shown.has(key)) continue;
    shown.add(key);
    const lines = code.replace(/\r\n/g, '\n').trimEnd().split('\n');
    const max = opts.maxLines ?? 60;
    let body = lines.slice(0, max).join('\n');
    if (body.length > opts.budget - added) body = body.slice(0, Math.max(0, opts.budget - added)).replace(/\n[^\n]*$/, '');
    if (!body.trim()) continue;
    const cut = body.length < lines.join('\n').length ? '\n...' : '';
    const lang = LANG[from.split('.').pop()?.toLowerCase() ?? ''] ?? '';
    const fence = body.includes('```') ? '````' : '```';
    const prepared = `${opts.prepare(body, from.split('/').pop() ?? f.path)}${cut}`;
    // Inside a code block already (Polars runs its snippets in one): the code alone.
    const block = fenced.has(f.line) ? prepared : `${fence}${lang}\n${prepared}\n${fence}`;
    out = out.replace(f.line, block);
    added += block.length - f.line.length;
  }
  return { text: out, added };
}
