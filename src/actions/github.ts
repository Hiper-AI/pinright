/**
 * The GitHub REST calls the Actions check needs: the commit a ref points to,
 * the most specific tag on that commit, and the latest release. GITHUB_TOKEN or
 * GH_TOKEN raises the limit from 60 to 5,000 requests an hour; nothing is written.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { getJson, getText, HttpError } from '../http.js';

const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const HOUR = 3600_000;

function headers(accept = 'application/vnd.github+json'): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return { accept, 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

/** 404 and 422 ("No commit found for SHA") mean the ref does not exist. */
function missing(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 404 || err.status === 422);
}

const enc = encodeURIComponent;

/** The commit SHA a tag, branch or SHA resolves to, or undefined when it does not exist. */
export async function resolveRef(owner: string, repo: string, ref: string): Promise<string | undefined> {
  // Tags move (that is the attack this check is about): keep the answer for an hour only.
  try {
    const sha = await cached(`gh:ref:${owner}/${repo}@${ref}`, HOUR, () =>
      getText(`${API}/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}`, { headers: headers('application/vnd.github.sha') }),
    );
    return /^[0-9a-f]{40}$/i.test(sha.trim()) ? sha.trim().toLowerCase() : undefined;
  } catch (err) {
    if (missing(err)) return undefined;
    throw err;
  }
}

interface MatchingRef {
  ref: string;
  object: { sha: string; type: 'commit' | 'tag' };
}

/**
 * The most specific tag that starts with `prefix` and points at `sha`: for
 * "v4" at the same commit as "v4.2.1", returns "v4.2.1". Annotated tags are
 * dereferenced, at most a few, newest first.
 */
export async function specificTag(owner: string, repo: string, prefix: string, sha: string): Promise<string | undefined> {
  let refs: MatchingRef[];
  try {
    refs = await cached(`gh:tags:${owner}/${repo}:${prefix}`, HOUR, () =>
      getJson<MatchingRef[]>(`${API}/repos/${enc(owner)}/${enc(repo)}/git/matching-refs/tags/${enc(prefix)}`, { headers: headers() }),
    );
  } catch (err) {
    if (missing(err)) return undefined;
    throw err;
  }
  const names = refs
    .map((r) => ({ name: r.ref.replace(/^refs\/tags\//, ''), r }))
    .filter((x) => x.name === prefix || x.name.startsWith(`${prefix}.`))
    .sort((a, b) => b.name.split('.').length - a.name.split('.').length || b.name.localeCompare(a.name, undefined, { numeric: true }));
  let annotated = 0;
  for (const { name, r } of names) {
    let commit = r.object.type === 'commit' ? r.object.sha : undefined;
    if (r.object.type === 'tag' && annotated++ < 6) {
      const t = await cached(`gh:tagobj:${owner}/${repo}:${r.object.sha}`, config.ttl.versions, () =>
        getJson<{ object?: { sha: string } }>(`${API}/repos/${enc(owner)}/${enc(repo)}/git/tags/${r.object.sha}`, { headers: headers() }),
      ).catch(() => undefined);
      commit = t?.object?.sha;
    }
    if (commit?.toLowerCase() === sha.toLowerCase()) return name;
  }
  return undefined;
}

/** Tag of the newest tagged commit among the latest 100 tags whose commit is `sha`, for refs pinned to a SHA. */
export async function tagForSha(owner: string, repo: string, sha: string): Promise<string | undefined> {
  try {
    const tags = await cached(`gh:taglist:${owner}/${repo}`, HOUR, () =>
      getJson<{ name: string; commit: { sha: string } }[]>(`${API}/repos/${enc(owner)}/${enc(repo)}/tags?per_page=100`, { headers: headers() }),
    );
    const hits = tags.filter((t) => t.commit.sha.toLowerCase() === sha.toLowerCase()).map((t) => t.name);
    return hits.sort((a, b) => b.split('.').length - a.split('.').length)[0];
  } catch (err) {
    if (missing(err)) return undefined;
    throw err;
  }
}

/** Tag name of the latest (non-prerelease, non-draft) release, when the repo publishes releases. */
export async function latestRelease(owner: string, repo: string): Promise<string | undefined> {
  try {
    const r = await cached(`gh:latest:${owner}/${repo}`, HOUR, () =>
      getJson<{ tag_name?: string }>(`${API}/repos/${enc(owner)}/${enc(repo)}/releases/latest`, { headers: headers() }),
    );
    return r.tag_name;
  } catch (err) {
    if (missing(err)) return undefined;
    throw err;
  }
}
