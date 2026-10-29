/**
 * Where documentation comes from, without Context7:
 *   1. the published package at the exact version (jsDelivr mirrors npm tarballs):
 *      README, bundled docs and the .d.ts type definitions;
 *   2. the source repository at the release tag (GitHub tree + raw files):
 *      docs/ folders, README, migration guides;
 *   3. the project's llms.txt / llms-full.txt, which describe the current site,
 *      not a specific version;
 *   4. for packages whose docs live elsewhere (src/data/docsRepos.ts), that docs
 *      repo or llms.txt index.
 * PyPI distributions (wheel/sdist API) are read in python.ts.
 * Every fetch is cached and fails soft: a missing source means fewer docs.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { githubJson } from '../github.js';
import { getJson, getText, HttpError } from '../http.js';
import { getUntrustedText } from '../safeFetch.js';
import { type DocsSource } from '../data/docsRepos.js';
import { type PackageMeta } from '../registry.js';

export interface RemoteFile {
  path: string;
  url: string;
  size?: number;
  origin: 'package' | 'repo';
  inPackageDir?: boolean;
  /** Files from a separate docs repo (src/data/docsRepos.ts) carry their own label. */
  label?: string;
  versionAccurate?: boolean;
  /** Whether the file may fill the docs budget without a path match (default: docs/ folders only). */
  fill?: boolean;
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

interface TreeResult {
  ref: string;
  /** False when no tag matched and we fell back to the default branch. */
  atTag: boolean;
  files: { path: string; size?: number }[];
  /** Listed by jsDelivr: read the files from its CDN too (it resolves the tag the same way). */
  cdn?: boolean;
}

export interface RepoListing {
  /** Text-like files only (docs, changelogs): source code is never needed and makes the cache large. */
  files: { path: string; size?: number }[];
  cdn: boolean;
}

/** Docs, changelogs and extension-less files ("CHANGES"): what the docs and upgrade readers can use. */
const TEXT_LIKE = /\.(md|mdx|markdown|rst|txt)$|(^|\/)[^./]+$/i;

/**
 * jsDelivr's file list of a repo at a tag. It needs no GitHub API call, and
 * jsDelivr caches a tag forever. "missing": no such tag. "too-large": the repo
 * is over jsDelivr's 50 MB limit for GitHub (a 403), so only the API can list it.
 * https://github.com/jsdelivr/data.jsdelivr.com: free, no rate limits.
 */
async function jsdListing(owner: string, repo: string, ref: string): Promise<RepoListing | 'missing' | 'too-large'> {
  return cached(`jsd:gh:${owner}/${repo}@${ref}`, config.ttl.tagged, async (): Promise<RepoListing | 'too-large'> => {
    try {
      const l = await getJson<JsDelivrFlat>(`https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}@${encodeURIComponent(ref)}?structure=flat`);
      const files = (l.files ?? []).map((f) => ({ path: f.name.replace(/^\//, ''), size: f.size })).filter((f) => TEXT_LIKE.test(f.path));
      return { files, cdn: true };
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) return 'too-large';
      throw err;
    }
  }).catch((err: unknown) => {
    // Not cached: a tag pushed after the release would stay invisible.
    if (err instanceof HttpError && err.status === 404) return 'missing' as const;
    throw err;
  });
}

async function apiListing(owner: string, repo: string, ref: string): Promise<RepoListing | undefined> {
  const ttl = ref === 'HEAD' ? config.ttl.docs : config.ttl.tagged;
  const files = await cached(`gh:listing:${owner}/${repo}@${ref}`, ttl, async () => {
    try {
      const t = await githubJson<{ tree: { path: string; type: string; size?: number }[] }>(
        `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        { what: `the file list of ${owner}/${repo}${ref === 'HEAD' ? '' : `@${ref}`} (docs, changelogs and migration guides from the repo)` },
      );
      return t.tree.filter((e) => e.type === 'blob' && TEXT_LIKE.test(e.path)).map((e) => ({ path: e.path, size: e.size }));
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 422)) return null;
      throw err;
    }
  });
  return files ? { files, cdn: false } : undefined;
}

/**
 * The text files of a repo at a ref, or undefined when the ref does not exist.
 * jsDelivr for tags; the GitHub API for the default branch, for repos over
 * jsDelivr's size limit, and when jsDelivr does not answer.
 */
export async function repoListing(owner: string, repo: string, ref: string): Promise<RepoListing | undefined> {
  if (ref !== 'HEAD') {
    const j = await jsdListing(owner, repo, ref).catch(() => 'down' as const);
    if (j === 'missing') return undefined;
    if (typeof j === 'object') return j;
  }
  return apiListing(owner, repo, ref);
}

/** Where to read a file of a listing from. */
export function repoFileUrl(owner: string, repo: string, ref: string, path: string, cdn: boolean | undefined): string {
  return cdn
    ? `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${encodeURIComponent(ref)}/${path}`
    : `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${path}`;
}

/** Keep only what can be documentation; a monorepo tree has tens of thousands of entries. */
function docsOnly(files: { path: string; size?: number }[]): { path: string; size?: number }[] {
  return files.filter((f) => DOC_EXT.test(f.path) && !SKIP.test(f.path) && (f.size ?? 0) <= MAX_FILE_BYTES).slice(0, 4000);
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

export async function repoFiles(meta: PackageMeta): Promise<{ files: RemoteFile[]; ref?: string; atTag: boolean }> {
  if (!meta.repo) return { files: [], atTag: false };
  const { owner, repo } = meta.repo;
  const key = `gh:tree2:${owner}/${repo}@${meta.name}@${meta.version}`;
  const res = await cached<TreeResult | null>(key, config.ttl.docs, async () => {
    // Every tag spelling at once on jsDelivr (no API budget); the API only for what jsDelivr cannot list.
    const tags = tagCandidates(meta.name, meta.version);
    const probes = await Promise.all(tags.map((t) => jsdListing(owner, repo, t).catch(() => 'down' as const)));
    for (const [i, tag] of tags.entries()) {
      const p = probes[i];
      if (p === 'missing') continue;
      const listing = typeof p === 'object' ? p : await apiListing(owner, repo, tag);
      if (listing) return { ref: tag, atTag: true, files: docsOnly(listing.files), cdn: listing.cdn };
    }
    const head = await apiListing(owner, repo, 'HEAD');
    return head ? { ref: 'HEAD', atTag: false, files: docsOnly(head.files) } : null;
  }).catch(() => null); // rate limit or network: no repo docs this time
  if (!res) return { files: [], atTag: false };
  const dir = meta.repo.directory?.replace(/^\.?\//, '').replace(/\/$/, '');
  return {
    ref: res.ref,
    atTag: res.atTag,
    files: res.files.map((f) => ({
      path: f.path,
      url: repoFileUrl(owner, repo, res.ref, f.path, res.cdn),
      size: f.size,
      origin: 'repo' as const,
      // In a monorepo, the package's own folder is the most relevant part of the repo.
      inPackageDir: Boolean(dir && f.path.startsWith(`${dir}/`)),
    })),
  };
}

/**
 * Docs kept in a repo other than the package's own (src/data/docsRepos.ts),
 * read from its default branch: they describe the current release, not a
 * specific version.
 */
export async function docsRepoFiles(src: NonNullable<DocsSource['repo']>): Promise<RemoteFile[]> {
  const { owner, repo, paths, exclude } = src;
  const listing = await apiListing(owner, repo, 'HEAD').catch(() => undefined);
  const inScope = (p: string) => paths.some((prefix) => p === prefix || (prefix.endsWith('/') && p.startsWith(prefix)));
  const scoped = docsOnly(listing?.files ?? []).filter((f) => inScope(f.path) && !exclude?.test(f.path));
  return scoped.map((f) => ({
    path: f.path,
    url: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${f.path}`,
    size: f.size,
    origin: 'repo' as const,
    label: `${owner}/${repo}/${f.path} (docs repo, default branch)`,
    versionAccurate: false,
    // A small docs set can fill the budget; a large one (hundreds of integration pages) only by path match.
    fill: scoped.length <= 60,
  }));
}

/** Docs written for several languages with `:::python` / `:::js` blocks (Mintlify): keep one language. */
export function keepLanguage(md: string, lang: string): string {
  return md
    .replace(/^:::(\w+)[ \t]*\n([\s\S]*?)^:::[ \t]*(?:\n|$)/gm, (_m, l: string, body: string) => (l === lang ? body : ''))
    // Mintlify's rendered markdown tags fences with a theme: "```python theme={...}".
    .replace(/^(```[^\n]*?)\s+theme=\{.*\}[ \t]*$/gm, '$1');
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
      return await getUntrustedText(url);
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

/** A known llms.txt-style index (one per language on some sites) instead of discovering one. */
export async function llmsIndexDocs(url: string): Promise<LlmsDocs | undefined> {
  const idx = await fetchTextDoc(url);
  return idx ? { site: new URL(url).origin, index: { url, entries: parseLlmsIndex(idx, url) } } : undefined;
}

/** A page linked from llms.txt; many sites serve a .md twin of each HTML page. */
export async function fetchLlmsPage(url: string): Promise<string | undefined> {
  const direct = await fetchTextDoc(url);
  if (direct) return direct;
  if (!/\.(md|mdx|txt)$/i.test(url)) return fetchTextDoc(`${url.replace(/\/$/, '')}.md`);
  return undefined;
}
