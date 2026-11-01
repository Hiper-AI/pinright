/**
 * What the Actions check needs from GitHub: the commit a ref points to, the
 * most specific tag on that commit, and the latest release. Tags and branches
 * come from the git protocol (one ls-refs request per repo, the way `git
 * ls-remote` asks), which does not count against the REST API's 60 requests an
 * hour; the REST API (../github.ts) is the fallback for short SHAs, private
 * repos and anything the git endpoint does not answer. Nothing is written.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { GITHUB_API, githubJson, githubText } from '../github.js';
import { getText, HttpError } from '../http.js';

const HOUR = 3600_000;
const WHAT = 'GitHub Actions ref checks';

/** 404 and 422 ("No commit found for SHA") mean the ref does not exist. */
function missing(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 404 || err.status === 422);
}

const enc = encodeURIComponent;

// --------------------------------------------------------- git ls-refs -----

export interface RepoRefs {
  /** Tag name -> commit SHA (annotated tags already peeled). */
  tags: Record<string, string>;
  /** Branch name -> commit SHA. */
  heads: Record<string, string>;
}

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

/** git protocol v2: `ls-refs` for tags and branches, peeled. */
export const LS_REFS_BODY = `${pkt('command=ls-refs\n')}0001${pkt('peel\n')}${pkt('ref-prefix refs/tags/\n')}${pkt('ref-prefix refs/heads/\n')}0000`;

/** Parses an ls-refs response: pkt-lines of "<sha> <ref>[ peeled:<sha>]". */
export function parseLsRefs(body: string): RepoRefs | undefined {
  const refs: RepoRefs = { tags: {}, heads: {} };
  let n = 0;
  // Every pkt-line ends in "\n": after splitting, each piece starts with its 4-hex length.
  for (const piece of body.split('\n')) {
    const m = piece.slice(4).match(/^([0-9a-f]{40}) refs\/(tags|heads)\/(\S+)(?: peeled:([0-9a-f]{40}))?$/);
    if (!m) continue;
    refs[m[2] as 'tags' | 'heads'][m[3]] = m[4] ?? m[1];
    n++;
  }
  return n ? refs : undefined;
}

/**
 * Tags and branches of a public github.com repo, or undefined when the git
 * endpoint does not answer (private repo, GitHub Enterprise, network). No token
 * is sent: this is the anonymous read `git ls-remote` does.
 */
export async function repoRefs(owner: string, repo: string): Promise<RepoRefs | undefined> {
  if (GITHUB_API !== 'https://api.github.com') return undefined;
  // Tags move (that is the attack this check is about): keep the answer for an hour only.
  return cached(`gh:lsrefs:${owner}/${repo}`, HOUR, async () => {
    const body = await getText(`https://github.com/${enc(owner)}/${enc(repo)}.git/git-upload-pack`, {
      method: 'POST',
      headers: { 'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request', accept: 'application/x-git-upload-pack-result' },
      rawBody: LS_REFS_BODY,
    });
    const refs = parseLsRefs(body);
    if (!refs) throw new Error('no refs in the git response');
    return refs;
  }).catch(() => undefined);
}

const looksLikeSha = (ref: string) => /^[0-9a-f]{7,40}$/i.test(ref);

// ---------------------------------------------------------------- lookups ---

/** The commit SHA a tag, branch or SHA resolves to, or undefined when it does not exist. */
export async function resolveRef(owner: string, repo: string, ref: string): Promise<string | undefined> {
  const refs = await repoRefs(owner, repo);
  if (refs) {
    // git's order: a tag wins over a branch of the same name.
    const sha = refs.tags[ref] ?? refs.heads[ref];
    if (sha) return sha.toLowerCase();
    if (!looksLikeSha(ref)) return undefined;
  }
  try {
    const sha = await cached(`gh:ref:${owner}/${repo}@${ref}`, HOUR, () =>
      githubText(`/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}`, { what: WHAT, accept: 'application/vnd.github.sha' }),
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

/** "v4.2.1" before "v4.2" before "v4"; among equals, the highest. */
const bySpecificity = (a: string, b: string) => b.split('.').length - a.split('.').length || b.localeCompare(a, undefined, { numeric: true });

const underPrefix = (name: string, prefix: string) => name === prefix || name.startsWith(`${prefix}.`);

/**
 * The most specific tag that starts with `prefix` and points at `sha`: for
 * "v4" at the same commit as "v4.2.1", returns "v4.2.1". Through the REST API,
 * annotated tags are dereferenced, at most a few, newest first.
 */
export async function specificTag(owner: string, repo: string, prefix: string, sha: string): Promise<string | undefined> {
  const want = sha.toLowerCase();
  const refs = await repoRefs(owner, repo);
  if (refs) {
    return Object.keys(refs.tags)
      .filter((name) => underPrefix(name, prefix))
      .sort(bySpecificity)
      .find((name) => refs.tags[name].toLowerCase() === want);
  }
  let matching: MatchingRef[];
  try {
    matching = await cached(`gh:tags:${owner}/${repo}:${prefix}`, HOUR, () =>
      githubJson<MatchingRef[]>(`/repos/${enc(owner)}/${enc(repo)}/git/matching-refs/tags/${enc(prefix)}`, { what: WHAT }),
    );
  } catch (err) {
    if (missing(err)) return undefined;
    throw err;
  }
  const names = matching
    .map((r) => ({ name: r.ref.replace(/^refs\/tags\//, ''), r }))
    .filter((x) => underPrefix(x.name, prefix))
    .sort((a, b) => bySpecificity(a.name, b.name));
  let annotated = 0;
  for (const { name, r } of names) {
    let commit = r.object.type === 'commit' ? r.object.sha : undefined;
    if (r.object.type === 'tag' && annotated++ < 6) {
      const t = await cached(`gh:tagobj:${owner}/${repo}:${r.object.sha}`, config.ttl.versions, () =>
        githubJson<{ object?: { sha: string } }>(`/repos/${enc(owner)}/${enc(repo)}/git/tags/${r.object.sha}`, { what: WHAT }),
      ).catch(() => undefined);
      commit = t?.object?.sha;
    }
    if (commit?.toLowerCase() === want) return name;
  }
  return undefined;
}

/** The most specific tag whose commit is `sha`, for refs pinned to a SHA (REST fallback: among the latest 100 tags). */
export async function tagForSha(owner: string, repo: string, sha: string): Promise<string | undefined> {
  const want = sha.toLowerCase();
  const refs = await repoRefs(owner, repo);
  if (refs) {
    const hits = Object.keys(refs.tags).filter((name) => refs.tags[name].toLowerCase() === want);
    return hits.sort((a, b) => b.split('.').length - a.split('.').length)[0];
  }
  try {
    const tags = await cached(`gh:taglist:${owner}/${repo}`, HOUR, () =>
      githubJson<{ name: string; commit: { sha: string } }[]>(`/repos/${enc(owner)}/${enc(repo)}/tags?per_page=100`, { what: WHAT }),
    );
    const hits = tags.filter((t) => t.commit.sha.toLowerCase() === want).map((t) => t.name);
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
      githubJson<{ tag_name?: string }>(`/repos/${enc(owner)}/${enc(repo)}/releases/latest`, { what: 'the latest release of a vulnerable action' }),
    );
    return r.tag_name;
  } catch (err) {
    if (missing(err)) return undefined;
    throw err;
  }
}
