/**
 * Client for the Context7 REST API (https://context7.com/docs/api-guide).
 * The MCP tool names map 1:1 onto these two endpoints:
 *   resolve-library-id -> GET /api/v2/libs/search
 *   query-docs         -> GET /api/v2/context
 * The key is optional: without one the API answers with low rate limits.
 */
import { cached } from './cache.js';
import { config } from './config.js';
import { getJson, getText } from './http.js';

export interface Context7Library {
  id: string;
  title: string;
  description?: string;
  branch?: string;
  lastUpdateDate?: string;
  state?: string;
  totalTokens?: number;
  totalSnippets?: number;
  stars?: number;
  trustScore?: number;
  benchmarkScore?: number;
  versions?: string[];
}

interface SearchResponse {
  results: Context7Library[];
  searchFilterApplied?: boolean;
}

function headers(): Record<string, string> {
  return config.context7ApiKey
    ? { authorization: `Bearer ${config.context7ApiKey}` }
    : {};
}

export async function searchLibraries(
  libraryName: string,
  query: string,
): Promise<Context7Library[]> {
  const url = new URL('/api/v2/libs/search', config.context7BaseUrl);
  url.searchParams.set('libraryName', libraryName);
  url.searchParams.set('query', query);
  const key = `c7:search:${url.search}`;
  const res = await cached(key, config.ttl.search, () =>
    getJson<SearchResponse>(url.toString(), { headers: headers() }),
  );
  return res.results ?? [];
}

export async function fetchDocs(
  libraryId: string,
  query: string,
  language?: string,
): Promise<string> {
  const url = new URL('/api/v2/context', config.context7BaseUrl);
  url.searchParams.set('libraryId', libraryId);
  url.searchParams.set('query', query);
  if (language) url.searchParams.set('language', language);
  const key = `c7:docs:${url.search}`;
  return cached(key, config.ttl.docs, () =>
    getText(url.toString(), { headers: headers() }),
  );
}

/** Split "/owner/repo/v1.2.3" into its parts. Version is optional. */
export function parseLibraryId(libraryId: string): {
  owner: string;
  repo: string;
  version?: string;
  base: string;
} {
  const parts = libraryId.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Invalid Context7 library id: ${libraryId}`);
  }
  const [owner, repo, ...rest] = parts;
  const version = rest.length ? rest.join('/') : undefined;
  return { owner, repo, version, base: `/${owner}/${repo}` };
}

export function withVersion(libraryId: string, version: string): string {
  const { base } = parseLibraryId(libraryId);
  return `${base}/${version}`;
}
