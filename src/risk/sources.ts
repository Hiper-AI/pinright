/**
 * Where the risk facts come from. npm version documents (registry.npmjs.org/<name>/<version>,
 * a few KB each, unlike the full packument that runs to tens of MB for big
 * packages), npm and PyPI download counts, and the OpenSSF Scorecard that
 * deps.dev keeps per source repository. Only the fields we use are cached.
 */
import { cached } from '../cache.js';
import { getProject, getVersion } from '../advisories/depsdev.js';
import { type Ecosystem } from '../ecosystems.js';
import { getJson, isNotFound } from '../http.js';
import { type ScorecardFacts, type VersionFacts } from './signals.js';

const DAY = 24 * 3600_000;
/** A published npm version document does not change (scripts, provenance, publisher). */
const TTL_VERSION_DOC = 7 * DAY;
const TTL_DOWNLOADS = DAY;

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'] as const;

interface NpmVersionDoc {
  version?: string;
  scripts?: Record<string, unknown>;
  gypfile?: boolean;
  hasInstallScript?: boolean;
  dist?: { attestations?: { url?: string; provenance?: { predicateType?: string } } };
  _npmUser?: { name?: string } | string;
  maintainers?: ({ name?: string } | string)[];
}

function npmPath(name: string): string {
  return encodeURIComponent(name).replace('%40', '@');
}

function userName(u: { name?: string } | string | undefined): string | undefined {
  if (!u) return undefined;
  if (typeof u === 'string') return u.replace(/\s*<.*$/, '').trim() || undefined;
  return u.name || undefined;
}

/** The lifecycle scripts npm runs on install, as "hook: command". */
export function installScriptsOf(doc: NpmVersionDoc): string[] {
  const out: string[] = [];
  for (const hook of INSTALL_HOOKS) {
    const cmd = doc.scripts?.[hook];
    if (typeof cmd === 'string' && cmd.trim()) out.push(`${hook}: ${cmd.trim()}`);
  }
  // npm runs "node-gyp rebuild" for a binding.gyp without an explicit install script.
  if (!out.length && doc.gypfile) out.push('install: node-gyp rebuild (binding.gyp)');
  if (!out.length && doc.hasInstallScript) out.push('install script (flagged by the registry)');
  return out;
}

export function versionFactsFromDoc(version: string, doc: NpmVersionDoc): VersionFacts {
  return {
    version,
    installScripts: installScriptsOf(doc),
    provenance: Boolean(doc.dist?.attestations?.provenance),
    publisher: userName(doc._npmUser),
    maintainers: (doc.maintainers ?? []).map(userName).filter((m): m is string => Boolean(m)),
  };
}

/** Facts from one npm version document. Undefined when the version is not in the registry. */
export async function npmVersionFacts(name: string, version: string): Promise<VersionFacts | undefined> {
  const url = `https://registry.npmjs.org/${npmPath(name)}/${encodeURIComponent(version)}`;
  const facts = await cached<VersionFacts | null>(`risk:npmver:${name}@${version}`, TTL_VERSION_DOC, async () => {
    try {
      return versionFactsFromDoc(version, await getJson<NpmVersionDoc>(url));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  });
  return facts ?? undefined;
}

/** Downloads in the last 7 days. Undefined when the service has no number for it. */
export async function weeklyDownloads(eco: Ecosystem, name: string): Promise<number | undefined> {
  let url: string;
  let pick: (body: unknown) => number | undefined;
  if (eco === 'npm') {
    url = `https://api.npmjs.org/downloads/point/last-week/${npmPath(name)}`;
    pick = (b) => (b as { downloads?: number }).downloads;
  } else if (eco === 'pypi') {
    url = `https://pypistats.org/api/packages/${encodeURIComponent(name.toLowerCase().replace(/[-_.]+/g, '-'))}/recent`;
    pick = (b) => (b as { data?: { last_week?: number } }).data?.last_week;
  } else {
    return undefined;
  }
  const n = await cached<number | null>(`risk:dl:${eco}:${name}`, TTL_DOWNLOADS, async () => {
    try {
      const v = pick(await getJson<unknown>(url));
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  });
  return n ?? undefined;
}

export const DOWNLOAD_ECOSYSTEMS: Ecosystem[] = ['npm', 'pypi'];

/** deps.dev fields we read that its client does not type. */
interface VersionLinks {
  slsaProvenances?: { verified?: boolean }[];
  attestations?: { verified?: boolean }[];
  relatedProjects?: { projectKey: { id: string }; relationType: string; relationProvenance?: string }[];
}

interface ScorecardDoc {
  date?: string;
  overallScore?: number;
  checks?: { name: string; score: number }[];
}

/** Checks worth naming when they fail. Pinned-Dependencies fails almost everywhere and is left out. */
const NOTABLE_CHECKS = [
  'Dangerous-Workflow', 'Maintained', 'Code-Review', 'Branch-Protection', 'Token-Permissions',
  'Binary-Artifacts', 'Vulnerabilities', 'Signed-Releases',
];

export function scorecardFacts(repo: string, verifiedRepo: boolean, sc: ScorecardDoc | undefined): ScorecardFacts | undefined {
  if (!sc || typeof sc.overallScore !== 'number') return undefined;
  const checks = sc.checks ?? [];
  // -1 is "inconclusive", not a failure.
  const failing = checks
    .filter((c) => NOTABLE_CHECKS.includes(c.name) && c.score >= 0 && c.score <= 3)
    .map((c) => `${c.name} ${c.score}`);
  return {
    repo,
    score: sc.overallScore,
    date: sc.date,
    failing,
    dangerousWorkflow: checks.some((c) => c.name === 'Dangerous-Workflow' && c.score === 0),
    verifiedRepo,
  };
}

/**
 * From the deps.dev version: the source repository's Scorecard, and whether
 * deps.dev saw a provenance attestation (all ecosystems; npm also has the
 * registry's own field). Undefined fields mean deps.dev has nothing on them.
 */
export async function depsDevFacts(
  eco: Ecosystem,
  name: string,
  version: string,
): Promise<{ scorecard?: ScorecardFacts; provenance?: boolean }> {
  const v = (await getVersion(eco, name, version)) as (VersionLinks & object) | undefined;
  if (!v) return {};
  const provenance = Boolean(v.slsaProvenances?.length || v.attestations?.length) || undefined;
  const repos = (v.relatedProjects ?? []).filter((p) => p.relationType === 'SOURCE_REPO');
  const repo = repos.find((p) => p.relationProvenance && p.relationProvenance !== 'UNVERIFIED_METADATA') ?? repos[0];
  if (!repo) return { provenance };
  const project = await getProject(repo.projectKey.id);
  const verified = Boolean(repo.relationProvenance && repo.relationProvenance !== 'UNVERIFIED_METADATA');
  return { provenance, scorecard: scorecardFacts(repo.projectKey.id, verified, project?.scorecard as ScorecardDoc | undefined) };
}
