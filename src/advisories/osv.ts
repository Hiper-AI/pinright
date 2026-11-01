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
    // GIT ranges carry commit hashes, not releases; PYSEC records list both.
    for (const range of aff.ranges ?? []) {
      if (range.type === 'GIT') continue;
      for (const ev of range.events) {
        if (ev.fixed && !out.includes(ev.fixed)) out.push(ev.fixed);
      }
    }
  }
  return out;
}

/** The advisory's one-line title: its summary, else the first sentence of its details (PYSEC records have no summary). */
export function titleOf(vuln: OsvVuln): string | undefined {
  if (vuln.summary?.trim()) return vuln.summary;
  const sentences = (vuln.details?.trim().split(/(?<=[.!?])\s|\n\s*\n/) ?? []).filter((s) => s.trim());
  // PYSEC details often open by describing the product ("FastAPI is a web framework for ..."); the next sentence names the bug.
  const first = sentences.length > 1 && /^[\w .-]{1,40} (is|are) (a|an|the) /i.test(sentences[0]) ? sentences[1] : sentences[0];
  return first ? (first.length > 160 ? `${first.slice(0, 157)}...` : first) : undefined;
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
  if (!items.length) return [];
  // The same set comes back every time the hook re-checks a manifest, not always in the same order:
  // the key and the request use a sorted copy, and the answers are put back in the caller's order.
  const id = (it: BatchItem) => `${it.ecosystem}:${it.name}@${it.version}`;
  const sorted = [...new Map(items.map((it) => [id(it), it])).values()].sort((a, b) => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0));
  const answers = await cached(`osv:qb:${sorted.map(id).join('|')}`, config.ttl.advisories, () => queryBatchUncached(sorted));
  const byId = new Map(sorted.map((it, k) => [id(it), answers[k]]));
  return items.map((it) => byId.get(id(it)) ?? []);
}

async function queryBatchUncached(items: BatchItem[]): Promise<string[][]> {
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
    // One result per query, in order: anything else and a missing result would read as "no advisories".
    if (!Array.isArray(res?.results) || res.results.length !== chunk.length) {
      throw new Error(`OSV querybatch returned ${Array.isArray(res?.results) ? res.results.length : 'no'} results for ${chunk.length} queries`);
    }
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
