/**
 * Client for deps.dev (https://docs.deps.dev/api/v3/). No key, no published
 * rate limit, data from the registries plus OSV. Everything we need to pick a
 * safe version comes from here; OSV is only consulted for details.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { type Ecosystem, toDepsDevSystem } from '../ecosystems.js';
import { getJson, isNotFound } from '../http.js';
import { packagistDependencies } from '../composer/graph.js';
import { packagistPackage, packagistVersion } from '../composer/packagist.js';

export interface DepsDevVersionSummary {
  versionKey: { system: string; name: string; version: string };
  publishedAt?: string;
  isDefault?: boolean;
  isDeprecated?: boolean;
  deprecatedReason?: string;
}

export interface DepsDevPackage {
  packageKey: { system: string; name: string };
  versions: DepsDevVersionSummary[];
}

export interface DepsDevVersion extends DepsDevVersionSummary {
  licenses?: string[];
  advisoryKeys?: { id: string }[];
  links?: { label: string; url: string }[];
  slsaProvenances?: { sourceRepository: string; verified?: boolean }[];
  relatedProjects?: { projectKey: { id: string }; relationType: string }[];
}

export interface DepsDevAdvisory {
  advisoryKey: { id: string };
  url?: string;
  title?: string;
  aliases?: string[];
  cvss3Score?: number;
  cvss3Vector?: string;
}

export interface DepsDevProjectPackageVersion {
  versionKey: { system: string; name: string; version: string };
  relationType?: string;
  relationProvenance?: string;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

/** All versions of a package, or undefined when deps.dev has never seen it. */
export async function getPackage(
  eco: Ecosystem,
  name: string,
): Promise<DepsDevPackage | undefined> {
  if (eco === 'composer') return packagistPackage(name);
  const url = `${config.depsDevBaseUrl}/v3/systems/${toDepsDevSystem(eco)}/packages/${enc(name)}`;
  try {
    return await cached(`dd:pkg:${eco}:${name}`, config.ttl.versions, () =>
      getJson<DepsDevPackage>(url),
    );
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

export async function getVersion(
  eco: Ecosystem,
  name: string,
  version: string,
): Promise<DepsDevVersion | undefined> {
  if (eco === 'composer') return packagistVersion(name, version);
  const url =
    `${config.depsDevBaseUrl}/v3/systems/${toDepsDevSystem(eco)}/packages/${enc(name)}` +
    `/versions/${enc(version)}`;
  try {
    return await cached(`dd:ver:${eco}:${name}:${version}`, config.ttl.advisories, () =>
      getJson<DepsDevVersion>(url),
    );
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

export async function getAdvisory(id: string): Promise<DepsDevAdvisory | undefined> {
  const url = `${config.depsDevBaseUrl}/v3/advisories/${enc(id)}`;
  try {
    return await cached(`dd:adv:${id}`, config.ttl.advisories, () =>
      getJson<DepsDevAdvisory>(url),
    );
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

/**
 * Package versions that deps.dev links to a source repository, e.g.
 * "github.com/vercel/next.js". This is how a GitHub repo id becomes a package.
 */
export async function getProjectPackageVersions(
  projectId: string,
): Promise<DepsDevProjectPackageVersion[]> {
  const url = `${config.depsDevBaseUrl}/v3/projects/${enc(projectId)}:packageversions`;
  try {
    const res = await cached(`dd:proj:${projectId}`, config.ttl.versions, () =>
      getJson<{ versions?: DepsDevProjectPackageVersion[] }>(url),
    );
    return res.versions ?? [];
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

export interface DepsDevGraph {
  nodes: { versionKey: { system: string; name: string; version: string }; relation: 'SELF' | 'DIRECT' | 'INDIRECT'; errors?: string[] }[];
  edges: { fromNode: number; toNode: number; requirement?: string }[];
  error?: string;
}

/**
 * The resolved dependency graph of one package version, as deps.dev resolves it
 * in isolation (npm, PyPI, Cargo and Maven; Composer from Packagist's metadata, see
 * composer/graph.ts; Go is not supported). Undefined on 404.
 */
export async function getDependencies(
  eco: Ecosystem,
  name: string,
  version: string,
): Promise<DepsDevGraph | undefined> {
  if (eco === 'composer') return packagistDependencies(name, version); // deps.dev resolves no Packagist graphs
  const url =
    `${config.depsDevBaseUrl}/v3/systems/${toDepsDevSystem(eco)}/packages/${enc(name)}` +
    `/versions/${enc(version)}:dependencies`;
  try {
    return await cached(`dd:deps:${eco}:${name}:${version}`, config.ttl.versions, () => getJson<DepsDevGraph>(url));
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

export interface DepsDevProject {
  projectKey: { id: string };
  starsCount?: number;
  forksCount?: number;
  description?: string;
  homepage?: string;
  scorecard?: { overallScore?: number };
}

/** A source repository as deps.dev knows it ("github.com/vercel/next.js"): stars, Scorecard. */
export async function getProject(projectId: string): Promise<DepsDevProject | undefined> {
  const url = `${config.depsDevBaseUrl}/v3/projects/${enc(projectId)}`;
  try {
    return await cached(`dd:project:${projectId}`, config.ttl.versions, () => getJson<DepsDevProject>(url));
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}
