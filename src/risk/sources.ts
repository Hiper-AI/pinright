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
import { cleanField, cleanText } from '../untrusted/index.js';
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
  description?: unknown;
  deprecated?: unknown;
}

function npmPath(name: string): string {
  return encodeURIComponent(name).replace('%40', '@');
}

/** Account names are publisher-controlled text that ends up in notices and hook messages. */
function userName(u: { name?: string } | string | undefined): string | undefined {
  if (!u) return undefined;
  const raw = typeof u === 'string' ? u.replace(/\s*<.*$/, '') : u.name;
  return cleanText(typeof raw === 'string' ? raw : undefined, 60) || undefined;
}

/** Description and deprecation message of the version, when they address an AI agent. */
function agentTextOf(doc: NpmVersionDoc): string[] {
  const out: string[] = [];
  for (const [field, value] of [['description', doc.description], ['deprecation message', doc.deprecated]] as const) {
    if (typeof value !== 'string') continue;
    const f = cleanField(value, 300);
    if (f.level === 'high') out.push(`${field} (${f.flags.join(', ')})`);
  }
  return out;
}

/** The lifecycle scripts npm runs on install, as "hook: command". */
export function installScriptsOf(doc: NpmVersionDoc): string[] {
  const out: string[] = [];
  for (const hook of INSTALL_HOOKS) {
    const cmd = doc.scripts?.[hook];
    if (typeof cmd === 'string' && cmd.trim()) out.push(`${hook}: ${cleanText(cmd, 200)}`);
  }
  // npm runs "node-gyp rebuild" for a binding.gyp without an explicit install script.
  if (!out.length && doc.gypfile) out.push('install: node-gyp rebuild (binding.gyp)');
  if (!out.length && doc.hasInstallScript) out.push('install script (flagged by the registry)');
  return out;
}

export function versionFactsFromDoc(version: string, doc: NpmVersionDoc): VersionFacts {
  const agentText = agentTextOf(doc);
  return {
    version,
    installScripts: installScriptsOf(doc),
    provenance: Boolean(doc.dist?.attestations?.provenance),
    publisher: userName(doc._npmUser),
    maintainers: (doc.maintainers ?? []).map(userName).filter((m): m is string => Boolean(m)),
    ...(agentText.length ? { agentText } : {}),
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

const NPM_DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week';
/**
 * api.npmjs.org answers HTTP 429 to one request per package once a manifest has a few
 * dozen: unscoped names asked within this window go out together in one bulk request
 * (`/point/last-week/a,b,c`, up to 128 names). Scoped names are not supported in bulk
 * and go one by one, a few at a time.
 */
const BULK_WINDOW_MS = 25;
const BULK_MAX = 128;
const SCOPED_CONCURRENCY = 3;

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface Waiter {
  name: string;
  resolve: (n: number | null) => void;
  reject: (err: Error) => void;
}
let bulkQueue: Waiter[] = [];
let bulkTimer: NodeJS.Timeout | undefined;

async function sendBulk(batch: Waiter[]): Promise<void> {
  const names = [...new Set(batch.map((w) => w.name))];
  let counts: Record<string, { downloads?: unknown } | null>;
  try {
    const body = await getJson<Record<string, unknown>>(`${NPM_DOWNLOADS}/${names.map(npmPath).join(',')}`);
    // One name gets the single-package shape; several get an object keyed by name, null for unknown ones.
    counts = names.length === 1 ? { [names[0]]: body as { downloads?: unknown } } : (body as typeof counts);
  } catch (err) {
    if (isNotFound(err)) counts = {};
    else {
      for (const w of batch) w.reject(err as Error);
      return;
    }
  }
  for (const w of batch) w.resolve(finite(counts?.[w.name]?.downloads));
}

function flushBulk(): void {
  if (bulkTimer) clearTimeout(bulkTimer);
  bulkTimer = undefined;
  const all = bulkQueue;
  bulkQueue = [];
  for (let i = 0; i < all.length; i += BULK_MAX) void sendBulk(all.slice(i, i + BULK_MAX));
}

function npmBulkDownloads(name: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    bulkQueue.push({ name, resolve, reject });
    if (new Set(bulkQueue.map((w) => w.name)).size >= BULK_MAX) flushBulk();
    else bulkTimer ??= setTimeout(flushBulk, BULK_WINDOW_MS);
  });
}

let scopedActive = 0;
const scopedWaiting: (() => void)[] = [];

async function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  while (scopedActive >= SCOPED_CONCURRENCY) await new Promise<void>((r) => scopedWaiting.push(r));
  scopedActive++;
  try {
    return await fn();
  } finally {
    scopedActive--;
    scopedWaiting.shift()?.();
  }
}

async function singleDownloads(url: string, pick: (body: unknown) => unknown): Promise<number | null> {
  try {
    return finite(pick(await getJson<unknown>(url)));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Downloads in the last 7 days. Undefined when the service has no number for it. */
export async function weeklyDownloads(eco: Ecosystem, name: string): Promise<number | undefined> {
  let load: () => Promise<number | null>;
  if (eco === 'npm') {
    load = name.startsWith('@')
      ? () => oneAtATime(() => singleDownloads(`${NPM_DOWNLOADS}/${npmPath(name)}`, (b) => (b as { downloads?: number }).downloads))
      : () => npmBulkDownloads(name);
  } else if (eco === 'pypi') {
    const url = `https://pypistats.org/api/packages/${encodeURIComponent(name.toLowerCase().replace(/[-_.]+/g, '-'))}/recent`;
    load = () => singleDownloads(url, (b) => (b as { data?: { last_week?: number } }).data?.last_week);
  } else {
    return undefined;
  }
  // Per name, cached for a day: a manifest re-checked by the hook asks for none of them again.
  const n = await cached<number | null>(`risk:dl:${eco}:${name}`, TTL_DOWNLOADS, load);
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
