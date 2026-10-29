/**
 * Where documentation comes from, without Context7:
 *   1. the published package at the exact version (jsDelivr mirrors npm tarballs):
 *      README, bundled docs and the .d.ts type definitions;
 *   2. the source repository at the release tag (GitHub tree + raw files):
 *      docs/ folders, README, migration guides;
 *   3. the project's llms.txt / llms-full.txt, which describe the current site,
 *      not a specific version.
 * Every fetch is cached and fails soft: a missing source means fewer docs.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { getJson, getText, HttpError } from '../http.js';
import { type PackageMeta } from '../registry.js';

export interface RemoteFile {
  path: string;
  url: string;
  size?: number;
  origin: 'package' | 'repo';
  inPackageDir?: boolean;
}

const DOC_EXT = /\.(md|mdx|markdown|rst)$|(^|\/)readme\.txt$/i;
const SKIP = /(^|\/)(node_modules|test|tests|__tests__|fixtures|\.github|\.changeset|vendor|third_party|dist\/compiled)(\/|$)|LICEN[SC]E|CODE_OF_CONDUCT|SECURITY\.md|CONTRIBUTING|\.d\.ts\.map$/i;
const MAX_FILE_BYTES = 400_000;

// ------------------------------------------------------------ npm tarball ---

interface JsDelivrFlat {
  files?: { name: string; size: number }[];
}

export async function npmPackageFiles(name: string, version: string): Promise<RemoteFile[]> {
  const listing = await cached(`jsd:npm:${name}@${version}`, config.ttl.docs, () =>
    getJson<JsDelivrFlat>(`https://data.jsdelivr.com/v1/packages/npm/${name}@${encodeURIComponent(version)}?structure=flat`),
  ).catch(() => ({ files: [] }) as JsDelivrFlat);
  return (listing.files ?? [])
    .filter((f) => (DOC_EXT.test(f.name) || f.name.endsWith('.d.ts')) && !SKIP.test(f.name) && f.size <= MAX_FILE_BYTES)
    .map((f) => ({
      path: f.name.replace(/^\//, ''),
      url: `https://cdn.jsdelivr.net/npm/${name}@${version}${f.name}`,
      size: f.size,
      origin: 'package' as const,
    }));
}

// ------------------------------------------------------------ GitHub tag ----

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

interface TreeResult {
  ref: string;
  /** False when no tag matched and we fell back to the default branch. */
  atTag: boolean;
  files: { path: string; size?: number }[];
}

/** Release tags come in several spellings; monorepos prefix the package name. */
export function tagCandidates(name: string, version: string): string[] {
  const short = name.replace(/^@[^/]+\//, '');
  return [
    ...new Set([
      `v${version}`, version, `${name}@${version}`, `${short}@${version}`, `${short}-v${version}`, `${short}-${version}`,
      `${name}==${version}`, // langchain-ai/langchain tags "langchain==1.4.7"
    ]),
  ];
}

async function treeAt(owner: string, repo: string, ref: string): Promise<{ path: string; size?: number }[] | undefined> {
  try {
    const t = await getJson<{ tree: { path: string; type: string; size?: number }[] }>(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { headers: githubHeaders() },
    );
    // Keep only what can be documentation; a monorepo tree has tens of thousands of entries.
    return t.tree
      .filter((e) => e.type === 'blob' && DOC_EXT.test(e.path) && !SKIP.test(e.path) && (e.size ?? 0) <= MAX_FILE_BYTES)
      .slice(0, 4000)
      .map((e) => ({ path: e.path, size: e.size }));
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 422)) return undefined;
    throw err;
  }
}

export async function repoFiles(meta: PackageMeta): Promise<{ files: RemoteFile[]; ref?: string; atTag: boolean }> {
  if (!meta.repo) return { files: [], atTag: false };
  const { owner, repo } = meta.repo;
  const key = `gh:tree2:${owner}/${repo}@${meta.name}@${meta.version}`;
  const res = await cached<TreeResult | null>(key, config.ttl.docs, async () => {
    for (const tag of tagCandidates(meta.name, meta.version)) {
      const files = await treeAt(owner, repo, tag);
      if (files) return { ref: tag, atTag: true, files };
    }
    const files = await treeAt(owner, repo, 'HEAD');
    return files ? { ref: 'HEAD', atTag: false, files } : null;
  }).catch(() => null); // rate limit or network: no repo docs this time
  if (!res) return { files: [], atTag: false };
  const dir = meta.repo.directory?.replace(/^\.?\//, '').replace(/\/$/, '');
  return {
    ref: res.ref,
    atTag: res.atTag,
    files: res.files.map((f) => ({
      path: f.path,
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(res.ref)}/${f.path}`,
      size: f.size,
      origin: 'repo' as const,
      // In a monorepo, the package's own folder is the most relevant part of the repo.
      inPackageDir: Boolean(dir && f.path.startsWith(`${dir}/`)),
    })),
  };
}

export async function fetchFile(url: string): Promise<string | undefined> {
  return cached(`file:${url}`, config.ttl.docs, () => getText(url)).catch(() => undefined);
}

// ------------------------------------------------------------ llms.txt ------

function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype html|<html|<head|<body)/i.test(text.slice(0, 500));
}

async function fetchTextDoc(url: string): Promise<string | undefined> {
  const text = await cached(`llms:${url}`, config.ttl.docs, async () => {
    try {
      return await getText(url);
    } catch {
      return '';
    }
  });
  return text && !looksLikeHtml(text) ? text : undefined;
}

export interface LlmsDocs {
  site: string;
  /** llms-full.txt content, when the site publishes one. */
  full?: { url: string; content: string };
  /** llms.txt entries: title, url, description. */
  index?: { url: string; entries: { title: string; url: string; description: string }[] };
}

export function parseLlmsIndex(content: string, base: string): { title: string; url: string; description: string }[] {
  const out: { title: string; url: string; description: string }[] = [];
  for (const m of content.matchAll(/^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)\s*:?\s*(.*)$/gm)) {
    try {
      out.push({ title: m[1], url: new URL(m[2], base).toString(), description: m[3] });
    } catch {
      // malformed link: skip
    }
  }
  return out;
}

export async function llmsDocs(site: string | undefined): Promise<LlmsDocs | undefined> {
  if (!site) return undefined;
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    return undefined;
  }
  const bases = [...new Set([`${u.origin}${u.pathname.replace(/\/[^/]*\.[a-z]+$/i, '').replace(/\/$/, '')}`, u.origin])];
  for (const base of bases) {
    const full = await fetchTextDoc(`${base}/llms-full.txt`);
    const idx = await fetchTextDoc(`${base}/llms.txt`);
    if (full || idx) {
      return {
        site: base,
        full: full ? { url: `${base}/llms-full.txt`, content: full } : undefined,
        index: idx ? { url: `${base}/llms.txt`, entries: parseLlmsIndex(idx, `${base}/`) } : undefined,
      };
    }
  }
  return undefined;
}

/** A page linked from llms.txt; many sites serve a .md twin of each HTML page. */
export async function fetchLlmsPage(url: string): Promise<string | undefined> {
  const direct = await fetchTextDoc(url);
  if (direct) return direct;
  if (!/\.(md|mdx|txt)$/i.test(url)) return fetchTextDoc(`${url.replace(/\/$/, '')}.md`);
  return undefined;
}
