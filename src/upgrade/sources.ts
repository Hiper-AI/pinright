/**
 * Where upgrade notes come from, all at the target version and all cached:
 *   - CHANGELOG / HISTORY / CHANGES / RELEASES files in the published package
 *     (jsDelivr) and in the repo at the release tag;
 *   - GitHub Releases bodies for the tags in (from, to], and the announcement
 *     post a short release body links to ("For release notes, see the blog");
 *   - migration guides: files or llms.txt pages named migrat*, upgrad*, breaking*,
 *     filtered to the majors being crossed.
 * Every source fails soft: a rate limit or a 404 means fewer notes, never an error.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { fetchFile, fetchLlmsPage, llmsDocs, npmPackageFiles, parseLlmsIndex, repoFileUrl, repoFiles, repoListing } from '../docs/sources.js';
import { type Ecosystem } from '../ecosystems.js';
import { githubAuthConfigured, githubJson } from '../github.js';
import { getJson, HttpError } from '../http.js';
import { getUntrustedText } from '../safeFetch.js';
import { docsSite, type PackageMeta } from '../registry.js';
import { majorsInRange, inUpgradeRange, isPrereleaseVersion, versionFromTag } from './versions.js';

export interface UpgradeDoc {
  label: string;
  url: string;
  content: string;
  /** From the package or the repo at the target tag (not a site that may describe another version). */
  versionAccurate: boolean;
}


const CHANGELOG_NAME = /^(changelog|changes|history|releases?|release[-_]notes|news|whats?[-_]new)(\.(md|mdx|markdown|rst|txt))?$/i;
const SKIP_DIR = /(^|\/)(node_modules|test|tests|__tests__|fixtures|\.github|\.changeset|vendor|third_party|dist\/compiled|examples?)(\/|$)/i;
const TRANSLATION = /(^|\/)(i18n|translations?|locales?)\/|(^|\/)docs\/(?!en\/)(ar|de|es|fa|fr|he|hi|id|it|ja|ko|nl|pl|pt|pt-br|ru|sv|th|tr|uk|vi|zh|zh-cn|zh-hant|zh-tw)\//i;
const MAX_CHANGELOG_BYTES = 3_000_000;

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Is a changelog path about this package? In a monorepo only the package's own
 * folder, the repo root, or a path naming the package or a major being crossed.
 */
export function changelogPathRelevant(path: string, name: string, dir: string | undefined, majors: number[]): boolean {
  if (!CHANGELOG_NAME.test(basename(path)) || SKIP_DIR.test(path) || TRANSLATION.test(path)) return false;
  if (!path.includes('/')) return true;
  if (dir && path.startsWith(`${dir}/`)) return true;
  const short = name.replace(/^@[^/]+\//, '').toLowerCase();
  const segs = path.toLowerCase().split('/').slice(0, -1);
  if (segs.some((s) => s === short || s === short.replace(/-/g, '_') || s === short.replace(/_/g, '-'))) return true;
  return majorMarkers(path).some((m) => majors.includes(m));
}

/** Majors a path or title names: "version-16", "v4/changelog", "langchain-v1", "migrating-to-v2". */
export function majorMarkers(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/(?:^|[/_\s(-])(?:v|version[-_\s]?)(\d{1,3})(?=$|[/._\s)-])/gi)) out.add(Number(m[1]));
  for (const m of text.matchAll(/(?:migrat\w*|upgrad\w*)[-_\s]?(?:to[-_\s]?)?(?:v|version[-_\s]?)?(\d{1,3})(?=$|[/._\s-])/gi)) out.add(Number(m[1]));
  for (const m of text.matchAll(/\b(?:to|in)\s+\w+\s+(\d{1,3})(?:\.0)?\b/gi)) out.add(Number(m[1]));
  // Blog slugs: "announcing-typescript-7-0", "zod-4-6".
  for (const m of text.matchAll(/(?:^|[/_-])[a-z]+-(\d{1,3})-\d{1,2}(?=$|[/._-])/gi)) out.add(Number(m[1]));
  return [...out];
}

const GUIDE = /migrat|upgrad|breaking|what'?s[-_\s]?new/i;

/**
 * How relevant a migration guide is to this upgrade, or undefined to drop it:
 * a guide that names a major being crossed beats a generic one, and one that only
 * names other majors ("version-14" when going 15 -> 16) is dropped.
 */
export function guideScore(pathOrTitle: string, majors: number[]): number | undefined {
  if (!GUIDE.test(pathOrTitle) || TRANSLATION.test(pathOrTitle) || SKIP_DIR.test(pathOrTitle)) return undefined;
  const marks = majorMarkers(pathOrTitle);
  if (marks.some((m) => majors.includes(m))) return 3;
  if (marks.length) return undefined;
  return 1;
}

// ---------------------------------------------------------- changelogs ----

async function repoChangelogs(meta: PackageMeta, majors: number[]): Promise<UpgradeDoc[]> {
  if (!meta.repo) return [];
  // repoFiles resolves the release tag (cached); its listing skips big files, and changelogs are big.
  const repo = await repoFiles(meta).catch(() => undefined);
  if (!repo?.ref) return [];
  const { owner, repo: name } = meta.repo;
  const ref = repo.ref;
  // The same listing repoFiles used (cached): jsDelivr at a tag, the API otherwise.
  const listing = await repoListing(owner, name, ref).catch(() => undefined);
  const paths = (listing?.files ?? []).filter((f) => CHANGELOG_NAME.test(basename(f.path)) && (f.size ?? 0) <= MAX_CHANGELOG_BYTES).map((f) => f.path);
  const dir = meta.repo.directory?.replace(/^\.?\//, '').replace(/\/$/, '');
  const picked = paths.filter((p) => changelogPathRelevant(p, meta.name, dir, majors)).slice(0, 4);
  const docs = await Promise.all(
    picked.map(async (p) => {
      const url = repoFileUrl(owner, name, ref, p, listing?.cdn);
      const content = await fetchFile(url);
      return content ? { label: `${name}/${p}@${ref}`, url, content, versionAccurate: repo.atTag } : undefined;
    }),
  );
  return docs.filter((d): d is UpgradeDoc => Boolean(d));
}

async function packageChangelogs(name: string, version: string): Promise<UpgradeDoc[]> {
  const l = await cached(`jsd:npm:${name}@${version}`, config.ttl.docs, () =>
    getJson<{ files?: { name: string; size: number }[] }>(`https://data.jsdelivr.com/v1/packages/npm/${name}@${encodeURIComponent(version)}?structure=flat`),
  ).catch(() => ({ files: [] as { name: string; size: number }[] }));
  const files = (l.files ?? [])
    .map((f) => ({ path: f.name.replace(/^\//, ''), size: f.size }))
    .filter((f) => CHANGELOG_NAME.test(basename(f.path)) && f.path.split('/').length <= 2 && !SKIP_DIR.test(f.path) && f.size <= MAX_CHANGELOG_BYTES);
  const docs = await Promise.all(
    files.slice(0, 2).map(async (f) => {
      const url = `https://cdn.jsdelivr.net/npm/${name}@${version}/${f.path}`;
      const content = await fetchFile(url);
      return content ? { label: `${f.path} (${name}@${version})`, url, content, versionAccurate: true } : undefined;
    }),
  );
  return docs.filter((d): d is UpgradeDoc => Boolean(d));
}

/** Changelog files at the target version: the package's own first, then the repo's. */
export async function changelogDocs(meta: PackageMeta, from: string, to: string): Promise<UpgradeDoc[]> {
  const majors = majorsInRange(from, to);
  const [pkg, repo] = await Promise.all([
    meta.ecosystem === 'npm' ? packageChangelogs(meta.name, to) : Promise.resolve([] as UpgradeDoc[]),
    repoChangelogs(meta, majors),
  ]);
  return [...pkg, ...repo];
}

// ------------------------------------------------------- GitHub releases ----

export interface ReleaseNote {
  tag: string;
  version: string;
  name: string;
  body: string;
  url: string;
  publishedAt?: string;
}

interface GhRelease {
  tag_name: string;
  name?: string;
  body?: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  created_at?: string;
}

/**
 * Release bodies for this package's tags in (from, to]. Pages are newest first;
 * paging stops once a page is older than the oldest version in the range.
 * Without a token GitHub allows 60 requests an hour, so fewer pages.
 */
export async function githubReleases(meta: PackageMeta, from: string, to: string, oldest?: string): Promise<{ notes: ReleaseNote[]; note?: string }> {
  if (!meta.repo) return { notes: [] };
  const { owner, repo } = meta.repo;
  const maxPages = githubAuthConfigured() ? 10 : 3;
  const notes: ReleaseNote[] = [];
  const stopBefore = oldest ? Date.parse(oldest) - 3 * 86_400_000 : undefined;
  for (let page = 1; page <= maxPages; page++) {
    let list: GhRelease[];
    try {
      list = await cached(`gh:releases:${owner}/${repo}:${page}`, config.ttl.search, () =>
        githubJson<GhRelease[]>(`/repos/${owner}/${repo}/releases?per_page=100&page=${page}`, { what: `GitHub release notes of ${owner}/${repo}` }),
      );
    } catch (err) {
      const limited = err instanceof HttpError && (err.status === 403 || err.status === 429);
      return { notes, note: limited ? `GitHub releases were rate limited${githubAuthConfigured() ? '' : '; set GITHUB_TOKEN or SAFECTX_GH_CLI=1 for more'}.` : undefined };
    }
    for (const r of list) {
      if (r.draft) continue;
      const version = versionFromTag(r.tag_name, meta.name);
      if (!version || !inUpgradeRange(version, from, to)) continue;
      if ((r.prerelease || isPrereleaseVersion(version)) && !isPrereleaseVersion(to)) continue;
      notes.push({ tag: r.tag_name, version, name: r.name ?? r.tag_name, body: r.body ?? '', url: r.html_url, publishedAt: r.published_at });
    }
    if (list.length < 100) break;
    const last = list[list.length - 1];
    const lastDate = Date.parse(last.published_at ?? last.created_at ?? '');
    if (stopBefore !== undefined && Number.isFinite(lastDate) && lastDate < stopBefore) break;
  }
  return { notes };
}

/** A short release body that only points at an announcement post: the post is the release note. */
export function announcementLink(body: string): string | undefined {
  if (body.length > 1500) return undefined;
  for (const m of body.matchAll(/https?:\/\/[^\s)\]>"']+/g)) {
    const u = m[0];
    if (/github\.com|githubusercontent|npmjs\.com|pypi\.org|cve|security|advisor/i.test(u)) continue;
    if (/announc|release[-_]?notes|\/blog\/|\/news\/|whats?-new|changelog/i.test(u)) return u;
  }
  return undefined;
}

// --------------------------------------------------------------- HTML ------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '...', mdash: '-', ndash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      if (n === 8217 || n === 8216) return "'";
      if (n === 8220 || n === 8221) return '"';
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, ''));

/** Enough HTML-to-markdown for a blog post: headings, lists, code, paragraphs. Nothing is executed. */
export function htmlToMarkdown(html: string): string {
  const body = html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
  return body
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c: string) => `\n\`\`\`\n${stripTags(c).trim()}\n\`\`\`\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c: string) => `\`${stripTags(c)}\``)
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l: string, t: string) => `\n\n${'#'.repeat(Number(l))} ${stripTags(t).replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|ul|ol|li|table|tr|blockquote|section)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m) => decode(m))
    .replace(/^- \s*\n+\s*/gm, '- ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The post a release links to; it describes that release, so it counts as version-accurate. */
export async function fetchAnnouncement(url: string, tag: string): Promise<UpgradeDoc | undefined> {
  const text = await cached(`html:${url}`, config.ttl.docs, async () => {
    try {
      const raw = await getUntrustedText(url);
      return /^\s*(<!doctype html|<html|<head|<body)/i.test(raw.slice(0, 500)) ? htmlToMarkdown(raw) : raw;
    } catch {
      return '';
    }
  });
  return text ? { label: `announcement linked from GitHub release ${tag}`, url, content: text, versionAccurate: true } : undefined;
}

// ---------------------------------------------------------------- guides ----

const MAX_GUIDES = 4;

/**
 * Migration guides for the majors being crossed: files in the package at `to`,
 * in the repo at its tag, and pages listed in the project's llms.txt (following
 * nested llms indexes one level, the way docs.langchain.com splits them).
 */
export async function guideDocs(meta: PackageMeta, from: string, to: string): Promise<UpgradeDoc[]> {
  const majors = majorsInRange(from, to);
  const [pkgFiles, repo] = await Promise.all([
    meta.ecosystem === 'npm' ? npmPackageFiles(meta.name, to).catch(() => []) : Promise.resolve([]),
    repoFiles(meta).catch(() => ({ files: [], atTag: false, ref: undefined })),
  ]);
  const dir = meta.repo?.directory?.replace(/^\.?\//, '').replace(/\/$/, '');
  const short = meta.name.replace(/^@[^/]+\//, '').toLowerCase();
  const candidates = [...pkgFiles, ...repo.files]
    .filter((f) => !f.path.endsWith('.d.ts') && !CHANGELOG_NAME.test(basename(f.path)))
    .map((f) => {
      const s = guideScore(f.path, majors);
      if (s === undefined) return undefined;
      const own = f.origin === 'package' || (dir && f.path.startsWith(`${dir}/`)) || f.path.toLowerCase().includes(short);
      return { f, score: s + (own ? 0.5 : 0) + (f.origin === 'package' ? 0.2 : 0) - f.path.split('/').length * 0.01 };
    })
    .filter((x): x is { f: (typeof pkgFiles)[number]; score: number } => Boolean(x))
    .sort((a, b) => b.score - a.score);
  // A guide written for the major being crossed makes the generic ones ("upgrading/index", agent prompts) noise.
  const specific = candidates.some((c) => c.score >= 3);
  // The same guide ships in the package and the repo: keep one by file name.
  const seenNames = new Set<string>();
  const picked = candidates.filter((c) => !specific || c.score >= 3).filter((c) => {
    const k = basename(c.f.path).replace(/\.(mdx?|rst)$/i, '');
    if (seenNames.has(k)) return false;
    seenNames.add(k);
    return true;
  }).slice(0, MAX_GUIDES);
  const files = await Promise.all(
    picked.map(async ({ f }) => {
      const content = await fetchFile(f.url);
      if (!content) return undefined;
      const label = f.origin === 'repo' ? `${meta.repo?.repo}/${f.path}@${repo.ref ?? 'HEAD'}` : `${f.path} (${meta.name}@${to})`;
      return { label, url: f.url, content, versionAccurate: f.origin === 'package' || repo.atTag };
    }),
  );
  const out = files.filter((d): d is UpgradeDoc => Boolean(d));
  if (out.some((d) => guideScore(d.label, majors) === 3)) return out;
  return [...out, ...(await llmsGuides(meta, majors, MAX_GUIDES - out.length))];
}

async function llmsGuides(meta: PackageMeta, majors: number[], max: number): Promise<UpgradeDoc[]> {
  if (max <= 0) return [];
  const sites = [...new Set([meta.docsUrl, docsSite(meta.homepage)].filter((s): s is string => Boolean(s)))];
  const lang = meta.ecosystem === 'pypi' ? /python/i : meta.ecosystem === 'npm' ? /typescript|javascript|\bjs\b/i : undefined;
  const otherLang = meta.ecosystem === 'pypi' ? /typescript|javascript/i : meta.ecosystem === 'npm' ? /python/i : undefined;
  for (const site of sites) {
    const llms = await llmsDocs(site).catch(() => undefined);
    let entries = llms?.index?.entries ?? [];
    // Nested indexes: "[Build / Python (234 pages)](.../_llms/build/python.txt)".
    const nested = entries.filter((e) => /\.txt$/i.test(new URL(e.url).pathname) && (!otherLang || !otherLang.test(e.title))).sort((a, b) => Number(Boolean(lang?.test(b.title))) - Number(Boolean(lang?.test(a.title)))).slice(0, 3);
    for (const n of nested) {
      const text = await fetchLlmsPage(n.url).catch(() => undefined);
      if (text) entries = [...entries, ...parseLlmsIndex(text, n.url)];
    }
    const short = meta.name.replace(/^@[^/]+\//, '').toLowerCase();
    // Title and path only: the host ("docs.langchain.com") names every page.
    const mentions = (e: { title: string; url: string }) => `${e.title} ${new URL(e.url).pathname}`.toLowerCase().includes(short);
    const scored = entries
      .map((e) => ({ e, s: guideScore(`${e.title} ${new URL(e.url).pathname}`, majors) }))
      .filter((x): x is { e: (typeof entries)[number]; s: number } => x.s !== undefined && !/\.txt$/i.test(new URL(x.e.url).pathname))
      .filter((x) => !otherLang || !otherLang.test(x.e.url))
      .map((x) => ({ ...x, s: x.s + (mentions(x.e) ? 1 : 0) }));
    // When some guides name the package, the others are for sibling products (langgraph vs langchain).
    const named = scored.filter((x) => mentions(x.e));
    const pool = (named.length ? named : scored).sort((a, b) => b.s - a.s);
    const seen = new Set<string>();
    const pages: UpgradeDoc[] = [];
    for (const { e } of pool) {
      const base = e.url.replace(/[?#].*$/, '');
      if (seen.has(base) || pages.length >= max) continue;
      seen.add(base);
      const content = await fetchLlmsPage(base).catch(() => undefined);
      if (content) pages.push({ label: e.title, url: base, content, versionAccurate: false });
    }
    if (pages.length) return pages;
  }
  return [];
}

export function ecosystemHasApiDiff(eco: Ecosystem): boolean {
  return eco === 'npm';
}
