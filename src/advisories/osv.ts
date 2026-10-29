/**
 * Client for OSV (https://google.github.io/osv.dev/api/). Used for the detail
 * deps.dev does not carry: summaries, "fixed in" events and MAL-* malware records.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { type Ecosystem, toOsvEcosystem } from '../ecosystems.js';
import { getJson, isNotFound } from '../http.js';

export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  modified?: string;
  published?: string;
  database_specific?: { severity?: string; [k: string]: unknown };
  severity?: { type: string; score: string }[];
  affected?: {
    package?: { name: string; ecosystem: string };
    ranges?: { type: string; events: { introduced?: string; fixed?: string }[] }[];
    versions?: string[];
  }[];
  references?: { type: string; url: string }[];
}

export async function queryVersion(
  eco: Ecosystem,
  name: string,
  version: string,
): Promise<OsvVuln[]> {
  const url = `${config.osvBaseUrl}/v1/query`;
  const body = { package: { name, ecosystem: toOsvEcosystem(eco) }, version };
  const res = await cached(`osv:q:${eco}:${name}:${version}`, config.ttl.advisories, () =>
    getJson<{ vulns?: OsvVuln[] }>(url, { method: 'POST', body }),
  );
  return res.vulns ?? [];
}

const norm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, '-');

/** The versions that fix a vulnerability for this package, in the order OSV lists them. */
export function fixedVersions(vuln: OsvVuln, name: string): string[] {
  const out: string[] = [];
  for (const aff of vuln.affected ?? []) {
    if (aff.package && norm(aff.package.name) !== norm(name)) continue;
    for (const range of aff.ranges ?? []) {
      for (const ev of range.events) {
        if (ev.fixed) out.push(ev.fixed);
      }
    }
  }
  return out;
}

export function isMalware(id: string): boolean {
  return id.startsWith('MAL-');
}

export function severityOf(vuln: OsvVuln): string | undefined {
  const s = vuln.database_specific?.severity;
  return typeof s === 'string' ? s : undefined;
}

export interface BatchItem {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

const BATCH_SIZE = 1000; // OSV's documented maximum per querybatch call

/**
 * Advisory ids for many exact versions at once (POST /v1/querybatch).
 * Returns one array per input item, same order. querybatch only returns ids;
 * call getVuln for the details.
 */
export async function queryBatch(items: BatchItem[]): Promise<string[][]> {
  const out: string[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const body = {
      queries: chunk.map((it) => ({ package: { name: it.name, ecosystem: toOsvEcosystem(it.ecosystem) }, version: it.version })),
    };
    const res = await getJson<{ results: { vulns?: { id: string }[]; next_page_token?: string }[] }>(
      `${config.osvBaseUrl}/v1/querybatch`,
      { method: 'POST', body },
    );
    for (let j = 0; j < chunk.length; j++) {
      const r = res.results[j];
      let ids = (r?.vulns ?? []).map((v) => v.id);
      // A paginated result means more vulns than fit; ask for that one alone.
      if (r?.next_page_token) {
        const all = await queryVersion(chunk[j].ecosystem, chunk[j].name, chunk[j].version);
        ids = all.map((v) => v.id);
      }
      out.push(ids);
    }
  }
  return out;
}

export async function getVuln(id: string): Promise<OsvVuln | undefined> {
  try {
    return await cached(`osv:vuln:${id}`, config.ttl.advisories, () =>
      getJson<OsvVuln>(`${config.osvBaseUrl}/v1/vulns/${encodeURIComponent(id)}`),
    );
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}
