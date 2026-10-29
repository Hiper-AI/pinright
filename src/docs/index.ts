/**
 * Documentation for one package version, assembled locally:
 * package files and repo docs at the exact version, plus the project's
 * llms.txt, ranked with BM25 against the agent's question. Context7 is only a
 * fallback, and only when SAFECTX_CONTEXT7 is not "off".
 */
import { config } from '../config.js';
import { fetchDocs as context7Docs, searchLibraries } from '../context7.js';
import { type Ecosystem } from '../ecosystems.js';
import { packageMeta, type PackageMeta } from '../registry.js';
import { docsSourceFor } from '../data/docsRepos.js';
import { apiDocFiles, packageNotes, pythonApi } from './python.js';
import { chunkFile, rank, rankPaths, select, type Chunk, type DocFile } from './retrieve.js';
import {
  docsRepoFiles, fetchFile, fetchLlmsPage, keepLanguage, llmsDocs, llmsIndexDocs, npmPackageFiles, repoFiles, type RemoteFile,
} from './sources.js';

export interface DocsResult {
  text: string;
  sources: { label: string; url: string; versionAccurate: boolean }[];
  via: 'local' | 'context7' | 'none';
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
/** Below this BM25 score the local docs did not really answer the question. */
const WEAK_SCORE = 2;

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

function format(meta: PackageMeta, chunks: Chunk[], header: string[]): string {
  const parts = [...header, ''];
  for (const c of chunks) {
    parts.push(`### ${c.title || c.file.label}`);
    parts.push(`Source: ${c.file.label}${c.file.versionAccurate ? ` (${meta.name}@${meta.version})` : ' (current site docs)'} ${c.file.url}`);
    parts.push('');
    // Python docstrings often hold ``` examples: fence them with a longer run of backticks.
    const fence = c.file.lang === 'python' && c.text.includes('```') ? '````' : '```';
    parts.push(c.file.kind === 'types' ? fence + (c.file.lang ?? 'ts') + '\n' + c.text + '\n' + fence : c.text);
    parts.push('');
  }
  return parts.join('\n');
}

export async function getDocs(opts: {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  query: string;
  budgetChars?: number;
  /** Include changelogs and migration guides (set when the fix crosses a major). */
  upgrade?: boolean;
}): Promise<DocsResult> {
  const budget = opts.budgetChars ?? config.docsBudgetChars;
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

  const ranked = dedupe(rank(docFiles.flatMap(chunkFile), opts.query));
  const best = ranked[0]?.score ?? 0;
  const sources = docFiles.map((d) => ({ label: d.label, url: d.url, versionAccurate: d.versionAccurate }));
  // PyPI: import name and sibling packages to install, checked against the query and the returned text.
  const notesFor = (text: string): string[] =>
    opts.ecosystem === 'pypi'
      ? packageNotes({ name: meta.name, version: meta.version, query: opts.query, text, importNames: pyApi?.importNames ?? [], requiresDist: pyApi?.requiresDist ?? [] })
      : [];

  if (best < WEAK_SCORE && config.context7Mode !== 'off') {
    const c7 = await context7Fallback(meta, opts.query).catch(() => undefined);
    if (c7) {
      const notes = notesFor(c7.text);
      return {
        meta,
        via: 'context7',
        sources: [{ label: `Context7 ${c7.id}`, url: `https://context7.com${c7.id}`, versionAccurate: c7.versioned }],
        text: `Docs for ${meta.name}@${meta.version}: local sources were thin, so these come from Context7 (${c7.id}${c7.versioned ? '' : ', not pinned to this version'}).\n${notes.length ? `${notes.join('\n')}\n` : ''}\n${c7.text}`,
      };
    }
  }

  if (!ranked.length || best <= 0) {
    const notes = notesFor('');
    return {
      meta,
      via: 'none',
      sources,
      text: `No documentation found for ${meta.name}@${meta.version} that matches "${opts.query}".` +
        (meta.docsUrl ? ` Project docs: ${meta.docsUrl}` : '') + (meta.repo ? ` Source: https://github.com/${meta.repo.owner}/${meta.repo.repo}` : '') +
        (notes.length ? `\n${notes.join('\n')}` : ''),
    };
  }

  const picked = select(ranked, budget);
  const accurate = picked.filter((c) => c.file.versionAccurate).length;
  const header = [
    `Docs for ${meta.name}@${meta.version} (${opts.ecosystem})${meta.description ? `: ${meta.description}` : ''}.`,
    `${picked.length} sections, ${accurate} from the published package or the repo at its release tag; the rest from the project's current site docs, which may describe a newer version.`,
    ...notesFor(picked.map((c) => c.text).join('\n')),
  ];
  return { meta, via: 'local', sources, text: format(meta, picked, header) };
}

async function context7Fallback(meta: PackageMeta, query: string): Promise<{ id: string; text: string; versioned: boolean } | undefined> {
  const libs = await searchLibraries(meta.name.replace(/^@[^/]+\//, ''), query);
  const repoId = meta.repo ? `/${meta.repo.owner}/${meta.repo.repo}`.toLowerCase() : undefined;
  const lib = libs.find((l) => repoId && l.id.toLowerCase() === repoId) ?? libs[0];
  if (!lib) return undefined;
  const v = (lib.versions ?? []).find((x) => x.replace(/^v/, '') === meta.version);
  const id = v ? `${lib.id}/${v}` : lib.id;
  const text = await context7Docs(id, query);
  return { id, text, versioned: Boolean(v) };
}
