/**
 * The MCP server. resolve-library-id and query-docs keep Context7's names so
 * "use context7"-style prompts work unchanged, but the docs come from the
 * package itself (published files and the repo at the release tag) and the
 * project's llms.txt; Context7 is only a fallback. check-package and
 * check-manifest are the security verdict on their own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDocs } from './docs/index.js';
import { ECOSYSTEMS, type Ecosystem, parseEcosystem } from './ecosystems.js';
import { securityNotice } from './format.js';
import { HttpError } from './http.js';
import { resolvePackage } from './mapping.js';
import { ecosystemHint, formatLibraryId, parseLibraryRef, searchPackages } from './search.js';
import { auditTree, formatTreeAudit } from './tree/audit.js';
import { detectKind, parseFile, SUPPORTED_FILES } from './tree/lockfiles.js';
import { findLookalike } from './typosquat.js';
import { checkPackage, type Verdict } from './verdict.js';

export const SERVER_INFO = { name: 'safectx', version: '0.2.0' } as const;

const VERDICT_RESULTS = 3;

function text(payload: unknown) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1);
  return { content: [{ type: 'text' as const, text: body }] };
}

function errorText(err: unknown) {
  let message = (err as Error).message;
  if (err instanceof HttpError && err.status === 429) {
    message = `Rate limited by ${new URL(err.url).hostname}${err.retryAfterSec ? ` (retry in ${err.retryAfterSec}s)` : ''}.`;
  }
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

function summarize(v: Verdict) {
  const r = v.report;
  return {
    verdict: r.verdict,
    reason: r.reason,
    safeVersion: r.safeVersion,
    latestVersion: r.latestVersion,
    license: r.safeVersionLicenses,
    lookalikeOf: v.typo?.lookalikeOf,
  };
}

/** Our ids ("npm:next@16.4.3") or Context7's ("/vercel/next.js/v16.4.3"). */
async function refFromId(libraryId: string, ecosystem?: string, packageName?: string) {
  const ours = parseLibraryRef(libraryId);
  if (ours) return ours;
  if (libraryId.startsWith('/')) {
    const parts = libraryId.replace(/^\/+/, '').split('/');
    const version = parts[2]?.replace(/^v(?=\d)/, '');
    const pkg = await resolvePackage(libraryId, { ecosystem, packageName }).catch(() => undefined);
    return pkg ? { ecosystem: pkg.ecosystem, name: pkg.name, version } : undefined;
  }
  // A bare name: take the best search hit.
  const hits = await searchPackages(libraryId, '', ecosystem).catch(() => []);
  return hits[0] ? { ecosystem: hits[0].ecosystem, name: hits[0].name } : undefined;
}

const LOCK_PRIORITY = [
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'uv.lock', 'poetry.lock', 'pdm.lock', 'Cargo.lock', 'go.mod', 'Gemfile.lock', 'packages.lock.json',
  'requirements.txt', 'pyproject.toml', 'package.json', 'Cargo.toml',
];

function ecosystemOfFile(f: string): string {
  if (/package|pnpm|yarn|shrinkwrap/.test(f)) return /packages\.lock/.test(f) ? 'nuget' : 'npm';
  if (/Cargo/.test(f)) return 'cargo';
  if (/go\.mod/.test(f)) return 'go';
  if (/Gemfile/.test(f)) return 'ruby';
  return 'python';
}

/** In a directory, one file per ecosystem: the lockfile when there is one, else the manifest. */
export function manifestsIn(dir: string): string[] {
  const chosen: string[] = [];
  const taken = new Set<string>();
  for (const f of LOCK_PRIORITY) {
    if (!fs.existsSync(path.join(dir, f))) continue;
    const eco = ecosystemOfFile(f);
    if (taken.has(eco)) continue;
    taken.add(eco);
    chosen.push(path.join(dir, f));
  }
  return chosen;
}

export function readSiblings(file: string): Record<string, string> {
  const dir = path.dirname(file);
  const out: Record<string, string> = {};
  for (const s of ['package.json', 'pyproject.toml', 'Cargo.toml']) {
    const p = path.join(dir, s);
    if (path.basename(file) !== s && fs.existsSync(p)) out[s] = fs.readFileSync(p, 'utf8');
  }
  return out;
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Version-accurate library docs plus a supply-chain verdict. Docs come from the published package ' +
      '(README, docs, type definitions) and the source repo at the release tag, so they match the version ' +
      'you install. Flow: resolve-library-id -> query-docs (pass the version the project uses, if any). ' +
      'Before adding or upgrading a dependency call check-package; to audit a whole project call ' +
      'check-manifest on its lockfile. A "SECURITY NOTICE" is authoritative: prefer the recommended version, ' +
      'and prefer the one on the same release line to avoid breaking changes.',
  });

  // 1) resolve-library-id -------------------------------------------------------
  server.registerTool(
    'resolve-library-id',
    {
      title: 'Find a library (with security verdict)',
      description:
        'Finds the registry package for a library name ("next.js" -> npm:next, "pytorch" -> pypi:torch) and returns ' +
        'ids for query-docs, with the newest version that has no known advisories (safeVersion) and a verdict. ' +
        'Call it before query-docs unless you already know the id ("npm:next", "pypi:requests").',
      inputSchema: {
        libraryName: z.string().describe('Library name, e.g. "next.js", "requests", "tokio".'),
        query: z.string().describe('What you want to do with it; also used to guess the language.'),
        ecosystem: z.string().optional().describe('npm, pypi, cargo, go, maven, nuget or rubygems, when you know it.'),
      },
    },
    async ({ libraryName, query, ecosystem }) => {
      try {
        const hits = await searchPackages(libraryName, query, ecosystem);
        if (!hits.length) {
          const eco = parseEcosystem(ecosystem) ?? ecosystemHint(`${libraryName} ${query}`);
          const ecos: Ecosystem[] = eco ? [eco] : ['npm', 'pypi', 'cargo', 'rubygems'];
          const looks = ecos
            .map((e) => ({ e, l: findLookalike(e, libraryName.toLowerCase()) }))
            .filter((x): x is { e: Ecosystem; l: NonNullable<ReturnType<typeof findLookalike>> } => Boolean(x.l));
          return text(
            looks.length
              ? `SECURITY NOTICE: no package named "${libraryName}" was found. Did you mean ${looks.map((x) => formatLibraryId(x.e, x.l.of)).join(' or ')}? ` +
                  'Misspelled names are a common typosquatting vector; confirm before installing.'
              : `No package found for "${libraryName}". Try the exact registry name, or pass ecosystem.`,
          );
        }
        const results = await Promise.all(
          hits.map(async (h, i) => {
            const base = { id: h.id, ecosystem: h.ecosystem, package: h.name, repo: h.repo, stars: h.stars, latestVersion: h.latestVersion };
            if (i >= VERDICT_RESULTS) return base;
            const v = await checkPackage(h.ecosystem, h.name).catch(() => undefined);
            return v ? { ...base, security: summarize(v) } : base;
          }),
        );
        return text({ results, hint: 'Call query-docs with the best id. Install safeVersion, not latestVersion, when they differ.' });
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // 2) query-docs -------------------------------------------------------------
  server.registerTool(
    'query-docs',
    {
      title: 'Documentation for the version you will use (security-checked)',
      description:
        'Returns the documentation sections that answer your question, taken from the package at a specific version ' +
        '(its published files and its repo at the release tag) and the project site. Without a version it documents ' +
        'the newest version with no known advisories. With a vulnerable version it starts with a SECURITY NOTICE and ' +
        'documents the safe version on the same release line, so the code you write keeps working after the upgrade.',
      inputSchema: {
        libraryId: z.string().describe('Id from resolve-library-id, e.g. "npm:next" or "npm:next@15.1.0". Context7 ids ("/vercel/next.js") also work.'),
        query: z.string().describe('The question or task, e.g. "protect routes with middleware".'),
        version: z.string().optional().describe('Version the project uses or pins, if any. Overrides the one in libraryId.'),
        tokens: z.number().int().optional().describe('Approximate size of the answer in tokens (default 5000).'),
        ecosystem: z.enum(ECOSYSTEMS as unknown as [string, ...string[]]).optional().describe('Only for Context7-style ids that map to several registries.'),
        packageName: z.string().optional().describe('Only for Context7-style ids whose package name differs from the repo.'),
      },
    },
    async ({ libraryId, query, version, tokens, ecosystem, packageName }) => {
      try {
        const ref = await refFromId(libraryId, ecosystem, packageName);
        if (!ref) return text(`Could not map "${libraryId}" to a registry package. Call resolve-library-id first, or use an id like "npm:<name>".`);
        const requested = (version ?? ref.version)?.replace(/^v(?=\d)/, '');
        const v = await checkPackage(ref.ecosystem, ref.name, requested);
        const r = v.report;
        const notice = securityNotice(r, v.typo);
        if (r.verdict === 'malicious' || r.verdict === 'possible-typosquat') return text(notice);

        let docsVersion = requested ?? r.safeVersion ?? r.leastExposed?.version ?? r.latestVersion;
        let upgrade = false;
        if (requested && r.requested && r.requested.verdict !== 'ok' && r.requested.verdict !== 'unknown') {
          if (r.safeVersionSameLine) docsVersion = r.safeVersionSameLine;
          else if (r.crossLineRequired && r.safeVersion) {
            docsVersion = r.safeVersion;
            upgrade = true;
          } else if (r.requested.verdict === 'unknown-package') docsVersion = r.safeVersion ?? r.leastExposed?.version ?? r.latestVersion;
          else if (!r.safeVersion && r.leastExposed) docsVersion = r.leastExposed.version;
        }
        if (!docsVersion) return text(`${notice}\n\nNo published version of ${ref.name} to document.`);

        const budget = tokens ? Math.min(Math.max(tokens, 500), 15_000) * 4 : undefined;
        const docs = await getDocs({ ecosystem: ref.ecosystem, name: ref.name, version: docsVersion, query, budgetChars: budget, upgrade });
        const switched = requested && docsVersion !== requested ? `\nThese docs are for ${docsVersion}, the version to move to, not ${requested}.` : '';
        return text(`${notice}${switched}\n\n${docs.text}`);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // 3) check-package ------------------------------------------------------------
  server.registerTool(
    'check-package',
    {
      title: 'Check a package before installing it',
      description:
        'Supply-chain verdict for one package, no docs: known advisories (CVE/GHSA, malware), deprecation, license, ' +
        'newest version with no known advisories, the safe version on the same release line as the one you pass, ' +
        'and typosquat lookalikes. Call it before any npm install / pip install / cargo add / go get.',
      inputSchema: {
        name: z.string().describe('Package name as the registry knows it, e.g. "lodash", "requests".'),
        ecosystem: z.string().describe('npm, pypi, cargo, go, maven, nuget or rubygems (aliases like "python" work).'),
        version: z.string().optional().describe('Version you intend to install or already use.'),
      },
    },
    async ({ name, ecosystem, version }) => {
      try {
        const eco = parseEcosystem(ecosystem);
        if (!eco) return errorText(new Error(`Unknown ecosystem "${ecosystem}". Use one of: ${ECOSYSTEMS.join(', ')}.`));
        const v = await checkPackage(eco, name.trim(), version?.trim() || undefined);
        return text({ notice: securityNotice(v.report, v.typo), ...v.report, typosquat: v.typo });
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // 4) check-manifest -----------------------------------------------------------
  server.registerTool(
    'check-manifest',
    {
      title: 'Audit a whole dependency tree',
      description:
        'Audits every package in a lockfile (direct and transitive) against OSV, the way Dependabot would, and says ' +
        'how to fix each finding: the direct upgrade on the same release line, the parent upgrade that clears a ' +
        'transitive one, or an override. Pass a project directory or a file path, or the file content with its name. ' +
        `Supported: ${SUPPORTED_FILES.join(', ')}, requirements*.txt. Without a lockfile the tree is resolved through deps.dev.`,
      inputSchema: {
        path: z.string().optional().describe('Project directory or path to a lockfile/manifest.'),
        content: z.string().optional().describe('File content, when the file is not on disk yet.'),
        fileName: z.string().optional().describe('Name of the file in content, e.g. "package-lock.json".'),
        includeDev: z.boolean().optional().describe('Include dev dependencies (default true).'),
      },
    },
    async ({ path: p, content, fileName, includeDev }) => {
      try {
        const targets: { file: string; content: string; siblings: Record<string, string> }[] = [];
        if (content) {
          if (!fileName || !detectKind(fileName)) return errorText(new Error(`fileName must be one of: ${SUPPORTED_FILES.join(', ')}, requirements*.txt.`));
          targets.push({ file: fileName, content, siblings: {} });
        } else if (p) {
          const abs = path.resolve(p);
          const files = fs.statSync(abs).isDirectory() ? manifestsIn(abs) : [abs];
          if (!files.length) return text(`No supported lockfile or manifest in ${abs}.`);
          for (const f of files) {
            // Only dependency files: this tool never reads anything else from disk.
            if (!detectKind(f)) return errorText(new Error(`Unsupported file ${f}.`));
            targets.push({ file: f, content: fs.readFileSync(f, 'utf8'), siblings: readSiblings(f) });
          }
        } else {
          return errorText(new Error('Pass path, or content with fileName.'));
        }
        const parts: string[] = [];
        for (const t of targets) {
          const audit = await auditTree(parseFile(t.file, t.content, t.siblings), { includeDev });
          parts.push(formatTreeAudit(audit, 25));
        }
        return text(parts.join('\n\n'));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  return server;
}
