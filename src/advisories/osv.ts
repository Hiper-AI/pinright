/**
 * Client for OSV (https://google.github.io/osv.dev/api/). Used for the detail
 * deps.dev does not carry: summaries, "fixed in" events and MAL-* malware records.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { type Ecosystem, toOsvEcosystem } from '../ecosystems.js';
import { getJson } from '../http.js';

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

/** The versions that fix a vulnerability for this package, in the order OSV lists them. */
export function fixedVersions(vuln: OsvVuln, name: string): string[] {
  const out: string[] = [];
  for (const aff of vuln.affected ?? []) {
    if (aff.package && aff.package.name !== name) continue;
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
