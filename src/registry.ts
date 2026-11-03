/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON from registries, lockfiles and agent hooks, read defensively */
/**
 * What each registry says about one package version: description, homepage,
 * documentation site, source repository, type definitions entry and README.
 * Docs discovery starts here.
 */
import { getVersion } from './advisories/depsdev.js';
import { cached } from './cache.js';
import { config } from './config.js';
import { type Ecosystem } from './ecosystems.js';
import { getJson, isNotFound } from './http.js';

export interface PackageMeta {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  description?: string;
  homepage?: string;
  docsUrl?: string;
  repo?: { owner: string; repo: string; directory?: string };
  /** npm: the "types"/"typings" entry of that version. */
  typesEntry?: string;
  /** PyPI ships the README of each version in its JSON. */
  readme?: string;
}

export function githubRepo(url: string | undefined): { owner: string; repo: string } | undefined {
  if (!url) return undefined;
  const m = url.match(/github\.com[/:]([^/\s#?]+)\/([^/\s#?]+)/i);
  if (!m) return undefined;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, '');
  // Both go into api.github.com paths (with the token): GitHub's own charset, no dot segments.
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[\w.-]{1,100}$/.test(repo) || /^\.+$/.test(repo)) return undefined;
  return { owner, repo };
}

const CODE_HOSTS = /(^|\.)(github\.com|gitlab\.com|npmjs\.com|npmjs\.org|pypi\.org|crates\.io|rubygems\.org|pkg\.go\.dev|nuget\.org|bitbucket\.org)$/i;

/** A homepage that is a docs site, not a code host or registry page. */
export function docsSite(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url.replace(/^git\+/, ''));
    if (!/^https?:$/.test(u.protocol) || CODE_HOSTS.test(u.hostname)) return undefined;
    return u.toString().replace(/#.*$/, '');
  } catch {
    return undefined;
  }
}

function npmPath(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

async function fromRegistry(eco: Ecosystem, name: string, version: string): Promise<Partial<PackageMeta>> {
  switch (eco) {
    case 'npm': {
      const j = await getJson<any>(`https://registry.npmjs.org/${npmPath(name)}/${encodeURIComponent(version)}`);
      const repoUrl = typeof j.repository === 'string' ? j.repository : j.repository?.url;
      return {
        description: j.description,
        homepage: j.homepage,
        docsUrl: docsSite(j.homepage),
        repo: githubRepo(repoUrl) && { ...(githubRepo(repoUrl) as { owner: string; repo: string }), directory: j.repository?.directory },
        typesEntry: j.types ?? j.typings,
      };
    }
    case 'pypi': {
      const j = await getJson<any>(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`);
      const urls: Record<string, string> = j.info?.project_urls ?? {};
      const pick = (re: RegExp) => Object.entries(urls).find(([k]) => re.test(k))?.[1];
      const repoUrl = pick(/source|repo|code|github/i) ?? Object.values(urls).find((u) => /github\.com/.test(u)) ?? j.info?.home_page;
      return {
        description: j.info?.summary,
        homepage: pick(/home/i) ?? j.info?.home_page,
        docsUrl: docsSite(pick(/doc/i)) ?? docsSite(pick(/home/i) ?? j.info?.home_page),
        repo: githubRepo(repoUrl),
        readme: j.info?.description,
      };
    }
    case 'cargo': {
      const j = await getJson<any>(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`);
      return {
        description: j.crate?.description,
        homepage: j.crate?.homepage,
        docsUrl: docsSite(j.crate?.homepage) ?? `https://docs.rs/${name}/${version}`,
        repo: githubRepo(j.crate?.repository),
      };
    }
    case 'rubygems': {
      const j = await getJson<any>(`https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`);
      return {
        description: j.info,
        homepage: j.homepage_uri,
        docsUrl: docsSite(j.documentation_uri) ?? docsSite(j.homepage_uri),
        repo: githubRepo(j.source_code_uri) ?? githubRepo(j.homepage_uri),
      };
    }
    case 'go':
      return { repo: githubRepo(`https://${name}`), docsUrl: undefined };
    default:
      return {};
  }
}

/** The registries existsInRegistry (typosquat.ts) and versionInRegistry ask, by the host named in the agent's notice. */
export const REGISTRY_HOST: Partial<Record<Ecosystem, string>> = { npm: 'registry.npmjs.org', pypi: 'pypi.org', cargo: 'crates.io', rubygems: 'rubygems.org' };

/** What the registry itself says about one version, for when deps.dev has not indexed it yet. */
export interface RegistryVersion {
  /** Host that answered ("pypi.org"), named in the agent's notice. */
  registry: string;
  publishedAt?: string;
}

/** A version that was missing an hour ago may be published now: answers are kept for an hour, not a day. */
const TTL_REGISTRY_VERSION = 3600_000;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Is this version published, according to the registry itself? deps.dev indexes new releases with a
 * lag of hours (jsonpointer 3.8 on PyPI was still a 404 there eight hours after its upload), so its
 * 404 alone does not mean "never published". Null: the registry has no such version. Undefined: no
 * registry client for this ecosystem, or the registry did not answer; the caller keeps deps.dev's answer.
 */
export async function versionInRegistry(eco: Ecosystem, name: string, version: string): Promise<RegistryVersion | null | undefined> {
  let url: string;
  let registry: string;
  let published: (j: any) => string | undefined;
  switch (eco) {
    case 'npm':
      // The version document, a few KB; the packument with every version's time can run to tens of MB.
      url = `https://registry.npmjs.org/${npmPath(name)}/${encodeURIComponent(version)}`;
      registry = 'registry.npmjs.org';
      published = () => undefined;
      break;
    case 'pypi':
      url = `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
      registry = 'pypi.org';
      published = (j) => str(j?.urls?.[0]?.upload_time_iso_8601);
      break;
    case 'cargo':
      url = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
      registry = 'crates.io';
      published = (j) => str(j?.version?.created_at);
      break;
    case 'rubygems':
      url = `https://rubygems.org/api/v2/rubygems/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}.json`;
      registry = 'rubygems.org';
      published = (j) => str(j?.version_created_at) ?? str(j?.created_at);
      break;
    default:
      return undefined;
  }
  try {
    return await cached<RegistryVersion | null>(`regver:${eco}:${name}@${version}`, TTL_REGISTRY_VERSION, async () => {
      try {
        const j = await getJson<any>(url, { headers: { accept: 'application/json' } });
        const at = published(j);
        return at ? { registry, publishedAt: at } : { registry };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    });
  } catch {
    return undefined;
  }
}

export async function packageMeta(eco: Ecosystem, name: string, version: string): Promise<PackageMeta> {
  const base: PackageMeta = { ecosystem: eco, name, version };
  const reg = await cached(`meta:${eco}:${name}:${version}`, config.ttl.registry, () => fromRegistry(eco, name, version)).catch(
    () => ({}) as Partial<PackageMeta>,
  );
  const meta: PackageMeta = { ...base, ...reg };
  if (!meta.repo || !meta.homepage) {
    // deps.dev knows the source repo for most packages, attested or declared.
    const v = await getVersion(eco, name, version).catch(() => undefined);
    const links = v?.links ?? [];
    meta.repo ??= githubRepo(links.find((l) => l.label === 'SOURCE_REPO')?.url) ?? githubRepo(v?.relatedProjects?.[0]?.projectKey.id);
    meta.homepage ??= links.find((l) => l.label === 'HOMEPAGE')?.url;
    meta.docsUrl ??= docsSite(links.find((l) => l.label === 'DOCUMENTATION')?.url) ?? docsSite(meta.homepage);
  }
  return meta;
}
