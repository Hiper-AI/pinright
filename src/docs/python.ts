/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON from PyPI, read defensively */
/**
 * PyPI's counterpart of the npm .d.ts files: the API of the published
 * distribution at the exact version. The wheel (or sdist) is downloaded with a
 * size cap, its .py/.pyi files are read as text (never imported or run) and
 * rendered as stub-like Python; a typeshed `types-<name>` package fills in
 * signatures when the distribution ships no types. The rendered API is what
 * gets cached, not the archive.
 *
 * Also the notes an agent needs to import the right thing: which import names
 * the distribution provides, and which sibling packages (LangChain's split
 * packages) the question needs but the package does not depend on.
 */
import { cached } from '../cache.js';
import { config } from '../config.js';
import { IMPORT_TO_PYPI, normalizePypiName, siblingsFor, type SiblingPackage } from '../data/docsRepos.js';
import { getBytes, getJson, isNotFound } from '../http.js';
import { readTarGz, readZip } from './archive.js';
import { distLayout, renderDistribution, wantEntry, type DistLayout } from './pyapi.js';
import { rank, topics, topicsFirst, type DocFile } from './retrieve.js';

const MAX_ARCHIVE_BYTES = 30_000_000;
const MAX_ENTRY_BYTES = 1_000_000;
const API_MODULES = 4;
const LEGACY_MODULE = /(^|\/)(v1|deprecated|compat|legacy)(\/|\.pyi?$)/;

interface PypiFile {
  filename: string;
  url: string;
  size: number;
  yanked?: boolean;
}

interface PypiRelease {
  files: PypiFile[];
  requiresDist: string[];
}

export interface PythonApi {
  /** File the API was read from ("PyYAML-6.0.3-cp312-...whl"). */
  dist: string;
  url: string;
  importNames: string[];
  requiresDist: string[];
  /** "types-requests 2.32.4.20250913" when typeshed stubs filled in signatures. */
  stubs?: string;
  modules: { path: string; content: string }[];
}

function toFiles(urls: any[]): PypiFile[] {
  return (urls ?? []).map((u: any) => ({ filename: String(u.filename), url: String(u.url), size: Number(u.size) || 0, yanked: Boolean(u.yanked) }));
}

async function release(name: string, version: string): Promise<PypiRelease> {
  return cached(`pypi:release:${normalizePypiName(name)}@${version}`, config.ttl.registry, async () => {
    const j = await getJson<any>(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`);
    return { files: toFiles(j.urls), requiresDist: Array.isArray(j.info?.requires_dist) ? j.info.requires_dist.map(String) : [] };
  });
}

/** A pure-Python wheel, else the smallest wheel (the Python files are the same), else the sdist. */
export function pickDistribution(files: PypiFile[]): PypiFile | undefined {
  const ok = files.filter((f) => !f.yanked && f.size <= MAX_ARCHIVE_BYTES);
  const wheels = ok.filter((f) => f.filename.endsWith('.whl'));
  return (
    wheels.find((f) => /-py3-none-any\.whl$|-py2\.py3-none-any\.whl$/.test(f.filename)) ??
    wheels.find((f) => /-none-any\.whl$/.test(f.filename)) ??
    [...wheels].sort((a, b) => a.size - b.size)[0] ??
    ok.find((f) => /\.(tar\.gz|zip)$/.test(f.filename))
  );
}

async function readDistribution(file: PypiFile): Promise<DistLayout> {
  const buf = await getBytes(file.url, { maxBytes: MAX_ARCHIVE_BYTES, timeoutMs: 90_000 });
  const opts = { want: wantEntry, maxEntryBytes: MAX_ENTRY_BYTES };
  if (file.filename.endsWith('.whl')) return distLayout(readZip(buf, opts), 'wheel');
  return distLayout(file.filename.endsWith('.zip') ? readZip(buf, opts) : readTarGz(buf, opts), 'sdist');
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** typeshed stubs for an untyped package: the newest `types-<name>` release for the same major.minor. */
async function stubPackage(name: string, version: string): Promise<{ label: string; modules: DistLayout['modules'] } | undefined> {
  const stubName = `types-${name}`;
  let j: any;
  try {
    j = await getJson<any>(`https://pypi.org/pypi/${encodeURIComponent(stubName)}/json`);
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  const releases: Record<string, any[]> = j.releases ?? {};
  const stable = Object.keys(releases).filter((v) => /^[\d.]+$/.test(v) && releases[v]?.length);
  const [major, minor] = version.split('.');
  const sameLine = stable.filter((v) => v.startsWith(`${major}.${minor}.`)).sort(compareVersions);
  const pick = sameLine[sameLine.length - 1] ?? String(j.info?.version ?? '');
  const file = pickDistribution(toFiles(releases[pick] ?? []));
  if (!file) return undefined;
  const layout = await readDistribution(file);
  return { label: `${stubName} ${pick}`, modules: layout.modules.filter((m) => m.path.endsWith('.pyi')) };
}

/** The rendered API of name@version, cached; undefined when there is no readable distribution. */
export async function pythonApi(name: string, version: string): Promise<PythonApi | undefined> {
  const key = `pyapi:v2:${normalizePypiName(name)}@${version}`;
  const res = await cached<PythonApi | null>(key, config.ttl.docs, async () => {
    const rel = await release(name, version);
    const file = pickDistribution(rel.files);
    if (!file) return null;
    const layout = await readDistribution(file);
    const stubs = layout.typed ? undefined : await stubPackage(name, version).catch(() => undefined);
    return {
      dist: file.filename,
      url: file.url,
      importNames: layout.importNames,
      requiresDist: rel.requiresDist,
      stubs: stubs?.modules.length ? stubs.label : undefined,
      modules: renderDistribution(layout, stubs?.modules ?? []),
    };
  }).catch(() => undefined); // network, size cap or a broken archive: no API this time
  return res ?? undefined;
}

/** The API modules that best match the query, as `types` docs rendered as Python. */
export function apiDocFiles(api: PythonApi, query: string, max = API_MODULES): DocFile[] {
  const files: DocFile[] = api.modules.map((m) => ({
    label: `${m.path} (from the ${api.dist.endsWith('.whl') ? 'wheel' : 'sdist'}${api.stubs ? `; signatures from ${api.stubs}` : ''})`,
    url: `${api.url}#${m.path}`,
    content: m.content,
    kind: 'types',
    lang: 'python',
    versionAccurate: true,
    // Compatibility layers (pydantic.v1, deprecated/) match every query about the old API.
    boost: LEGACY_MODULE.test(m.path) ? 0.5 : 1,
  }));
  // A question with several topics gets the best module of each topic first.
  const tl = topics(query);
  const ranked = rank(files.map((file) => ({ file, title: file.label, text: file.content, score: 0 })), query, tl).filter((c) => c.score > 0);
  const perTopic = tl.map((_, i) => ranked.filter((c) => (c.topicScores?.[i] ?? 0) > 0).sort((a, b) => (b.topicScores?.[i] ?? 0) - (a.topicScores?.[i] ?? 0)));
  return topicsFirst(ranked, perTopic, max, (c) => c.file.url).map((c) => c.file);
}

// ------------------------------------------------------------ import notes --

function parseRequirement(req: string): { name: string; extra?: string } | undefined {
  const name = req.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1];
  if (!name) return undefined;
  return { name: normalizePypiName(name), extra: req.match(/extra\s*==\s*['"]([^'"]+)['"]/)?.[1] };
}

const IMPORT_LINE = /^\s*(?:from\s+([A-Za-z_]\w*)[\w.]*\s+import\b|import\s+([A-Za-z_]\w*))/gm;

/**
 * What the agent must know to import and install correctly: the import name
 * when it differs from the package name, and packages that the question or
 * the returned examples need but this package does not declare as dependencies.
 */
export function packageNotes(opts: {
  name: string;
  version: string;
  query: string;
  /** Text returned to the agent: its import lines are checked too. */
  text: string;
  importNames: string[];
  requiresDist: string[];
}): string[] {
  const norm = normalizePypiName(opts.name);
  const notes: string[] = [];
  if (opts.importNames.length && !opts.importNames.some((n) => normalizePypiName(n) === norm)) {
    notes.push(`Import name: ${opts.importNames.map((n) => `\`${n}\``).join(', ')} (the package installs as \`${opts.name}\`).`);
  }
  const reqs = opts.requiresDist.map(parseRequirement).filter((r): r is { name: string; extra?: string } => Boolean(r));
  const declared = new Set([norm, ...reqs.filter((r) => !r.extra).map((r) => r.name)]);
  const extras = new Map(reqs.filter((r) => r.extra).map((r) => [r.name, r.extra!]));
  const siblings = siblingsFor(opts.name);
  const missing = new Map<string, SiblingPackage | { pkg: string; importName: string; what?: string }>();
  for (const s of siblings) if (s.terms.test(opts.query) && !declared.has(normalizePypiName(s.pkg))) missing.set(s.pkg, s);
  const byImport = new Map(siblings.map((s) => [s.importName, s]));
  for (const m of opts.text.matchAll(IMPORT_LINE)) {
    const imp = m[1] ?? m[2];
    if (opts.importNames.includes(imp)) continue;
    const s = byImport.get(imp) ?? (IMPORT_TO_PYPI[imp] ? { pkg: IMPORT_TO_PYPI[imp], importName: imp } : undefined);
    if (s && !declared.has(normalizePypiName(s.pkg))) missing.set(s.pkg, s);
  }
  if (missing.size) {
    notes.push(`Not dependencies of ${opts.name} ${opts.version}; install them yourself if you use them:`);
    for (const s of missing.values()) {
      const extra = extras.get(normalizePypiName(s.pkg));
      notes.push(`- ${s.pkg} (import \`${s.importName}\`)${s.what ? `: ${s.what}` : ''}${extra ? `; also available as the extra ${opts.name}[${extra}]` : ''}`);
    }
  }
  return notes;
}
