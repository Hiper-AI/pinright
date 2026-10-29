/**
 * Documentation for one package version, assembled locally:
 * package files and repo docs at the exact version, plus the project's
 * llms.txt, ranked with BM25 against the agent's question. No third-party docs index.
 */
import { config } from '../config.js';
import { type Ecosystem } from '../ecosystems.js';
import { packageMeta, type PackageMeta } from '../registry.js';
import { docsSourceFor } from '../data/docsRepos.js';
import { UntrustedOutput } from '../untrusted/index.js';
import { apiDocFiles, packageNotes, pythonApi, type PythonApi } from './python.js';
import { chunkFile, rank, rankPaths, select, type Chunk, type DocFile } from './retrieve.js';
import {
  docsRepoFiles, fetchFile, fetchLlmsPage, keepLanguage, llmsDocs, llmsIndexDocs, npmPackageFiles, repoFiles, type RemoteFile,
} from './sources.js';

export interface DocsResult {
  text: string;
  sources: { label: string; url: string; versionAccurate: boolean }[];
  via: 'local' | 'none';
  meta: PackageMeta;
  note?: string;
}

const UPGRADE_TERMS = /\b(upgrad|migrat|breaking|changelog|what'?s new|deprecat)/i;
const MD_FILES = 8;
const MAX_PROSE_FILES = 40;
const MAX_PROSE_BYTES = 1_200_000;
/** docs/ru/..., docs/zh-hant/..., i18n/...: translations of the English pages. */
const TRANSLATION =
  /(^|\/)(i18n|translations?|locales?)\/|(^|\/)docs\/(?!en\/)(ar|az|bn|cs|de|em|es|fa|fr|he|hi|hu|id|it|ja|ko|nl|pl|pt|pt-br|ru|sv|th|tr|uk|ur|vi|yo|zh|zh-cn|zh-hant|zh-tw)\//i;
const TYPE_FILES = 3;
const LLMS_PAGES = 4;
const CURATED_LLMS_PAGES = 8;

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

function pickFiles(files: RemoteFile[], meta: PackageMeta, query: string, wantUpgrade: boolean): RemoteFile[] {
  const isReadme = (p: string) => /(^|\/)readme\.(md|mdx|rst|txt)$/i.test(p);
  const entry = meta.typesEntry?.replace(/^\.\//, '');
  const isUpgrade = (p: string) => /(changelog|migrat|upgrad|history|releases?)[^/]*\.(md|mdx|rst)$/i.test(p);
  const nameTerms = [meta.name.replace(/^@[^/]+\//, '')];

  const readmes = files.filter((f) => isReadme(f.path)).sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const readme = readmes.find((f) => f.origin === 'package' || f.inPackageDir) ?? readmes[0];

  const prose = files.filter(
    (f) => !f.path.endsWith('.d.ts') && !isReadme(f.path) && !TRANSLATION.test(f.path) && (wantUpgrade || !isUpgrade(f.path)),
  );
  // Path names hint at content but miss a lot ("advanced.rst" holds the retry docs).
  // Files whose path matches go first; docs folders fill the rest up to a byte budget,
  // and BM25 over the content decides.
  const scored = rankPaths(prose, query, nameTerms).map((f) => ({
    ...f,
    hit: f.score > 0,
    score: f.score + (f.inPackageDir ? 0.5 : 0) + (/(^|\/)docs?\//.test(f.path) ? 0.3 : 0),
  }));
  const hits = scored.filter((f) => f.hit).sort((a, b) => b.score - a.score).slice(0, MD_FILES);
  const fill = scored.filter((f) => !f.hit && (f.fill ?? /(^|\/)(docs?|guides?|documentation)\//i.test(f.path))).sort((a, b) => b.score - a.score);
  const rankedProse: RemoteFile[] = [...hits];
  let bytes = hits.reduce((a, f) => a + (f.size ?? 20_000), 0);
  for (const f of fill) {
    if (rankedProse.length >= MAX_PROSE_FILES || bytes + (f.size ?? 20_000) > MAX_PROSE_BYTES) break;
    rankedProse.push(f);
    bytes += f.size ?? 20_000;
  }

  // Public types live at the entry, at the package root or under types/; deep dist/ files are internals.
  const types = files.filter(
    (f) => f.path.endsWith('.d.ts') && (f.path === entry || f.path.split('/').length <= 2 || /^types?\//.test(f.path)) && !/internal|devtools|private|compiled/i.test(f.path),
  );
  const rankedTypes = rankPaths(types, query, nameTerms)
    .map((f) => ({ ...f, score: f.score + (entry && f.path === entry ? 2 : 0) - (f.path.includes('/internal') ? 1 : 0) }))
    .sort((a, b) => b.score - a.score)
    .filter((f) => f.score > 0)
    .slice(0, TYPE_FILES);

  const upgrade = wantUpgrade ? files.filter((f) => isUpgrade(f.path)).slice(0, 2) : [];
  return [...new Set([readme, ...rankedProse, ...upgrade, ...rankedTypes].filter((f): f is RemoteFile => Boolean(f)))];
}

/** Packages often ship the same docs their repo has; keep the first copy of each section. */
function dedupe(chunks: Chunk[]): Chunk[] {
  const seen = new Set<string>();
  return chunks.filter((c) => {
    const key = c.text.replace(/\s+/g, ' ').slice(0, 300).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Where a chunk comes from, for its untrusted-data fence. */
function chunkSource(meta: PackageMeta, c: Chunk): string {
  return `${c.file.label}, ${meta.name}@${meta.version}${c.file.versionAccurate ? '' : ' (current site docs)'}`;
}

function format(meta: PackageMeta, chunks: Chunk[], header: string[], out: UntrustedOutput): string {
  const parts = [...header, ...out.notes, ''];
  for (const c of chunks) {
    // The label says where it comes from; the full URL is listed once per file at the end.
    const head = `### ${c.title || c.file.label} [${c.file.label}${c.file.versionAccurate ? '' : ', current site docs'}]`;
    // Python docstrings often hold ``` examples: fence them with a longer run of backticks.
    const fence = c.file.lang === 'python' && c.text.includes('```') ? '````' : '```';
    const body = c.file.kind === 'types' ? fence + (c.file.lang ?? 'ts') + '\n' + c.text + '\n' + fence : c.text;
    parts.push(out.block(`${head}\n${body}`, chunkSource(meta, c), out.scan(c.text)));
    parts.push('');
  }
  const urls = [...new Set(chunks.map((c) => c.file.url))];
  parts.push(`Sources (${meta.name}@${meta.version}): ${urls.join(' ')}`);
  return parts.join('\n');
}

export interface DocsOptions {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  query: string;
  budgetChars?: number;
  /** Include changelogs and migration guides (set when the fix crosses a major). */
  upgrade?: boolean;
}

export async function getDocs(opts: DocsOptions): Promise<DocsResult> {
  const budget = opts.budgetChars ?? config.docsBudgetChars;
  const out = new UntrustedOutput();
  const { meta, docFiles, pyApi } = await collectDocs(opts);
  // Normalized before chunking: hidden text never reaches a chunk, and hiding instructions is a finding.
  for (const d of docFiles) d.content = out.prepare(d.content, `${d.label}, ${meta.name}@${meta.version}`, d.kind === 'types' ? 'code' : 'markdown');
  const result = await assemble(opts, budget, meta, docFiles, pyApi, out);
  out.record(opts.ecosystem, meta.name, meta.version);
  return result;
}

/** Every document gathered for one package version, before ranking (exported for bench/injection). */
export async function collectDocs(opts: DocsOptions): Promise<{ meta: PackageMeta; docFiles: DocFile[]; pyApi?: PythonApi; wantUpgrade: boolean }> {
  const meta = await packageMeta(opts.ecosystem, opts.name, opts.version);
  const wantUpgrade = Boolean(opts.upgrade) || UPGRADE_TERMS.test(opts.query);

  // Docs that live outside the package's repo (LangChain, PyYAML...), and the API of a PyPI distribution.
  const docsSource = docsSourceFor(opts.ecosystem, meta.name);
  const keep = (text: string) => (docsSource?.language ? keepLanguage(text, docsSource.language) : text);
  const [pkgFiles, repo, llms, docsRepo, pyApi] = await Promise.all([
    opts.ecosystem === 'npm' ? npmPackageFiles(opts.name, opts.version) : Promise.resolve([] as RemoteFile[]),
    repoFiles(meta),
    docsSource?.llmsIndex ? llmsIndexDocs(docsSource.llmsIndex) : llmsDocs(meta.docsUrl),
    docsSource?.repo ? docsRepoFiles(docsSource.repo) : Promise.resolve([] as RemoteFile[]),
    opts.ecosystem === 'pypi' ? pythonApi(meta.name, meta.version) : Promise.resolve(undefined),
  ]);

  const chosen = pickFiles([...pkgFiles, ...repo.files, ...docsRepo], meta, opts.query, wantUpgrade);
  const docFiles: DocFile[] = (
    await pool(chosen, 6, async (f): Promise<DocFile | undefined> => {
      const content = await fetchFile(f.url);
      if (!content) return undefined;
      return {
        label: f.label ?? (f.origin === 'repo' ? `${meta.repo?.repo}/${f.path}${repo.atTag ? `@${repo.ref}` : ' (default branch)'}` : f.path),
        url: f.url,
        content: keep(content),
        kind: f.path.endsWith('.d.ts') ? 'types' : 'markdown',
        versionAccurate: f.versionAccurate ?? (f.origin === 'package' || repo.atTag),
        boost: f.inPackageDir ? 1.2 : 1,
      };
    })
  ).filter((d): d is DocFile => Boolean(d));
  if (pyApi) docFiles.push(...apiDocFiles(pyApi, opts.query));

  if (meta.readme && !docFiles.some((d) => /readme/i.test(d.label))) {
    docFiles.push({ label: `README (${opts.ecosystem} ${meta.name} ${meta.version})`, url: `https://pypi.org/project/${meta.name}/${meta.version}/`, content: meta.readme, kind: 'markdown', versionAccurate: true });
  }

  if (llms?.full) {
    docFiles.push({ label: 'llms-full.txt', url: llms.full.url, content: llms.full.content, kind: 'markdown', versionAccurate: false, boost: docFiles.length ? 0.7 : 1 });
  } else if (llms?.index?.entries.length) {
    const entries = llms.index.entries.filter((e) => wantUpgrade || !/\/(blog|changelog|releases?|news)\b/i.test(e.url));
    // A curated index (docsRepos.ts) covers a whole product family: favor this package's pages, read more of them.
    const ranked = rankPaths(
      entries.map((e) => ({ ...e, path: `${e.title} ${e.description} ${new URL(e.url).pathname}` })),
      opts.query,
      docsSource?.llmsIndex ? [meta.name] : [],
    ).slice(0, docsSource?.llmsIndex ? CURATED_LLMS_PAGES : LLMS_PAGES);
    const pages = await pool(ranked, 4, async (e) => ({ e, content: await fetchLlmsPage(e.url) }));
    for (const { e, content } of pages) {
      if (content) docFiles.push({ label: e.title, url: e.url, content: keep(content), kind: 'markdown', versionAccurate: false, boost: docFiles.length ? 0.8 : 1 });
    }
  }
  return { meta, docFiles, pyApi, wantUpgrade };
}

function assemble(opts: DocsOptions, budget: number, meta: PackageMeta, docFiles: DocFile[], pyApi: PythonApi | undefined, out: UntrustedOutput): DocsResult {
  const ranked = dedupe(rank(docFiles.flatMap(chunkFile), opts.query));
  const best = ranked[0]?.score ?? 0;
  const sources = docFiles.map((d) => ({ label: d.label, url: d.url, versionAccurate: d.versionAccurate }));
  // PyPI: import name and sibling packages to install, checked against the query and the returned text.
  const notesFor = (text: string): string[] =>
    opts.ecosystem === 'pypi'
      ? packageNotes({ name: meta.name, version: meta.version, query: opts.query, text, importNames: pyApi?.importNames ?? [], requiresDist: pyApi?.requiresDist ?? [] })
      : [];

  if (!ranked.length || best <= 0) {
    const notes = notesFor('');
    return {
      meta,
      via: 'none',
      sources,
      text: `No documentation found for ${meta.name}@${meta.version} that matches "${opts.query}".` +
        (meta.docsUrl ? ` Project docs: ${meta.docsUrl}` : '') + (meta.repo ? ` Source: https://github.com/${meta.repo.owner}/${meta.repo.repo}` : '') +
        (notes.length ? `\n${notes.join('\n')}` : '') + (out.notes.length ? `\n${out.notes.join('\n')}` : ''),
    };
  }
  const picked = out.select(ranked, (pool) => select(pool, budget), (c) => chunkSource(meta, c));
  const accurate = picked.filter((c) => c.file.versionAccurate).length;
  const header = [
    `Docs for ${meta.name}@${meta.version} (${opts.ecosystem}), ${picked.length} sections` +
      (accurate === picked.length
        ? ', all from the published package or the repo at its release tag.'
        : `: ${accurate} from the package or the repo at its release tag, ${picked.length - accurate} from the current site docs (may describe a newer version).`),
    ...notesFor(picked.map((c) => c.text).join('\n')),
  ];
  return { meta, via: 'local', sources, text: format(meta, picked, header, out) };
}

