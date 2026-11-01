/**
 * Docs that live outside the package and its repo (Supabase, Stripe, Astro), found from the package's
 * own metadata instead of an entry in src/data/docsRepos.ts:
 *   1. the site: the registry's docs URL or homepage; when those point to a code host, the homepage
 *      the source repo declares on GitHub (supabase/supabase-js -> https://supabase.com); without one,
 *      the site the README's documentation section links to (platform.claude.com for the Claude SDKs);
 *   2. an llms.txt on that site, on its docs. subdomain or under /docs (sources.ts, llmsBases);
 *   3. without one, the GitHub repo the site is built from: `<org>/docs`, `<org>/<name>-docs`,
 *      `<org>/<name>.dev`, `<org>/<site host>`, or the docs folder of the org's monorepo
 *      (`<org>/<org>`, `apps/docs/` or `docs/`). A candidate counts only when GitHub says its homepage is
 *      the same site (withastro/docs -> https://docs.astro.build/), so a stray `docs` repo of the org is
 *      never read. It is read at its default branch and labeled current site docs.
 * Every URL taken from metadata is fetched through getUntrustedText (sources.ts); GitHub is only asked
 * about repos of the package's own org. Lookups are cached, the misses too.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { githubJson } from '../github.js';
import { HttpError } from '../http.js';
import { docsSite, type PackageMeta } from '../registry.js';

export interface RepoInfo {
  homepage?: string;
  defaultBranch?: string;
}

/**
 * What GitHub says about a repo: the site it declares and its default branch; null when there is no
 * such repo, undefined when GitHub did not answer (rate limit, network).
 */
export async function repoInfo(owner: string, repo: string): Promise<RepoInfo | null | undefined> {
  return cached(`gh:repo:${owner}/${repo}`, config.ttl.docs, async () => {
    try {
      const j = await githubJson<{ homepage?: string | null; default_branch?: string; archived?: boolean }>(`/repos/${owner}/${repo}`, {
        what: `the homepage of ${owner}/${repo} (to find docs kept outside the package)`,
      });
      return j.archived ? null : { homepage: j.homepage ?? undefined, defaultBranch: j.default_branch };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 451)) return null;
      throw err;
    }
  }).catch(() => undefined); // rate limit or network: not cached, tried again next time
}

/** "docs.astro.build", "www.astro.build" -> "astro.build". */
export function siteHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^(www|docs)\./, '');
  } catch {
    return undefined;
  }
}

/** Two URLs of one site: the same host once `www.`/`docs.` are dropped, or one a subdomain of the other. */
export function sameSite(a: string | undefined, b: string | undefined): boolean {
  const x = a && siteHost(a);
  const y = b && siteHost(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/**
 * The site that documents the package: its docs URL or homepage, else the homepage of its source repo.
 * `fromRepo` tells the site came from the repo, which covers a product family (supabase.com for
 * supabase-js), so its pages are ranked with the package name too.
 */
export async function packageSite(meta: PackageMeta): Promise<{ site: string; fromRepo: boolean } | undefined> {
  if (meta.docsUrl) return { site: meta.docsUrl, fromRepo: false };
  if (!meta.repo) return undefined;
  const info = await repoInfo(meta.repo.owner, meta.repo.repo);
  const site = docsSite(info?.homepage);
  return site ? { site, fromRepo: true } : undefined;
}

/**
 * The docs site a README points to: a link under a "Documentation" heading, or on a line that says
 * documentation ("Full documentation is available at [platform.claude.com/...](https://...)"). Code
 * hosts, registries and badge images are not sites.
 */
export function readmeDocsLink(readme: string): string | undefined {
  let inDocs = false;
  for (const line of readme.replace(/\r\n/g, '\n').split('\n').slice(0, 300)) {
    const h = line.match(/^#{1,4}[ \t]+(.*)$/);
    if (h) {
      inDocs = /\b(documentation|docs)\b/i.test(h[1]);
      continue;
    }
    // The word in the text, not in a link target ("[Claude API](https://docs.anthropic.com/...)").
    // A link target stops at the next bracket or parenthesis: "](https://a](https://a..." stays linear.
    if (!inDocs && !/\b(documentation|docs)\b/i.test(line.replace(/\]\([^()[\]\s]*\)/g, ']'))) continue;
    for (const m of line.matchAll(/\]\((https:\/\/[^()[\]\s]+)\)/g)) {
      const site = docsSite(m[1]);
      if (site && !/(^|\.)(shields\.io|badgen\.net|badge\.fury\.io)$/i.test(new URL(site).hostname) && !/\.(svg|png|gif)$/i.test(new URL(site).pathname)) return site;
    }
  }
  return undefined;
}

export interface SiteRepo {
  owner: string;
  repo: string;
  branch: string;
  /** Path prefixes holding the site's pages; every docs file when unset. */
  paths?: string[];
}

/** Repos of the package's org that may hold the site's source, most specific first. */
export function siteRepoCandidates(meta: PackageMeta, site: string): { repo: string; paths?: string[] }[] {
  if (!meta.repo) return [];
  const short = meta.name.replace(/^@[^/]+\//, '').toLowerCase();
  const host = (() => {
    try {
      return new URL(site).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const org = meta.repo.owner;
  const names = [`docs`, `${short}-docs`, `${short}.dev`, host, siteHost(site) ?? ''].filter(Boolean);
  const out: { repo: string; paths?: string[] }[] = [...new Set(names)].map((repo) => ({ repo }));
  out.push({ repo: org, paths: ['apps/docs/', 'docs/'] });
  const own = meta.repo.repo.toLowerCase();
  return out.filter((c) => c.repo.toLowerCase() !== own || c.paths);
}

/** The repo the package's docs site is built from, when one of the candidates declares that site. */
export async function discoverSiteRepo(meta: PackageMeta, site: string): Promise<SiteRepo | undefined> {
  if (!meta.repo) return undefined;
  const owner = meta.repo.owner;
  const found = await cached(`site-repo:${owner}:${site}:${meta.name}`, config.ttl.docs, async () => {
    const cands = siteRepoCandidates(meta, site);
    const infos = await Promise.all(cands.map((c) => repoInfo(owner, c.repo)));
    for (const [i, c] of cands.entries()) {
      const info = infos[i];
      if (info?.defaultBranch && sameSite(info.homepage, site)) return { owner, repo: c.repo, branch: info.defaultBranch, paths: c.paths };
    }
    // A candidate GitHub did not answer about may be the one: no answer is not cached as "none".
    if (infos.includes(undefined)) throw new Error('GitHub did not answer');
    return null;
  }).catch(() => null);
  return found ?? undefined;
}
