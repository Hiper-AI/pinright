/**
 * Docs pages whose examples live in separate files: FastAPI, Typer and SQLModel write
 * `{* ../../docs_src/events/tutorial003_py310.py hl[16,19] *}`, Material for MkDocs
 * `--8<-- "docs/snippets/x.py"`, Sphinx `.. literalinclude:: ../examples/x.py`, VitePress
 * `<<< @/snippets/x.ts`. Shown as is, the agent gets the directive and none of the code. The
 * directives of the sections picked for an answer are replaced with the file they name, read
 * from the same repo at the same ref, within what is left of the budget.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { getText } from '../http.js';

const DIRECTIVES: RegExp[] = [
  /^[ \t]*\{\*\s+(\S+)[^\n]*?\*\}[ \t]*$/gm,
  /^[ \t]*-{2}8<-{2}[ \t]+["']([^"':\n]+)(?::[\w-]+)?["'][ \t]*$/gm,
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
}

/**
 * The text with each include directive replaced by a fenced copy of the file, cut to `maxLines`
 * and to the budget left; a directive whose file cannot be read stays as it was.
 */
export async function expandIncludes(text: string, pageUrl: string, opts: IncludeOptions): Promise<{ text: string; added: number }> {
  if (!repoBase(pageUrl)) return { text, added: 0 };
  const found: { line: string; path: string }[] = [];
  for (const re of DIRECTIVES) for (const m of text.matchAll(re)) found.push({ line: m[0], path: m[1] });
  if (!found.length) return { text, added: 0 };
  let added = 0;
  let out = text;
  for (const f of found.slice(0, 6)) {
    if (added >= opts.budget) break;
    let code = '';
    let from = '';
    for (const url of includeCandidates(pageUrl, f.path)) {
      code = await fetchInclude(url);
      if (code && !/^\s*(<!doctype html|<html)/i.test(code)) {
        from = url;
        break;
      }
      code = '';
    }
    if (!code) continue;
    const lines = code.replace(/\r\n/g, '\n').trimEnd().split('\n');
    const max = opts.maxLines ?? 60;
    let body = lines.slice(0, max).join('\n');
    if (body.length > opts.budget - added) body = body.slice(0, Math.max(0, opts.budget - added)).replace(/\n[^\n]*$/, '');
    if (!body.trim()) continue;
    const cut = body.length < lines.join('\n').length ? '\n...' : '';
    const lang = LANG[f.path.split('.').pop()?.toLowerCase() ?? ''] ?? '';
    const fence = body.includes('```') ? '````' : '```';
    const block = `${fence}${lang}\n${opts.prepare(body, from.split('/').pop() ?? f.path)}${cut}\n${fence}`;
    out = out.replace(f.line, block);
    added += block.length - f.line.length;
  }
  return { text: out, added };
}
