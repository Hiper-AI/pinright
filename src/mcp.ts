/**
 * The MCP server. resolve-library-id and query-docs keep Context7's names so
 * "use context7"-style prompts work unchanged, but the docs come from the
 * package itself (published files and the repo at the release tag) and the
 * project's llms.txt; Context7 is only a fallback. check-package,
 * check-packages and check-manifest are the security verdict on their own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { checkPackages, formatBatch, MAX_BATCH } from './batch.js';
import { getDocs } from './docs/index.js';
import { ECOSYSTEMS, type Ecosystem, parseEcosystem } from './ecosystems.js';
import { securityNotice } from './format.js';
import { HttpError } from './http.js';
import { resolvePackage } from './mapping.js';
import { ecosystemHint, formatLibraryId, parseLibraryRef, searchPackages } from './search.js';
import { auditTree, formatTreeAudit } from './tree/audit.js';
import { detectKind, parseFile, SUPPORTED_FILES } from './tree/lockfiles.js';
import { findLookalike } from './typosquat.js';
import { upgradeGuide } from './upgrade/index.js';
import { checkPackage, type Verdict } from './verdict.js';

export const SERVER_INFO = { name: 'safectx', version: '0.2.0' } as const;

const VERDICT_RESULTS = 3;

function text(payload: unknown) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text' as const, text: body }] };
}

function errorText(err: unknown) {
  let message = (err as Error).message;
  if (err instanceof HttpError && err.status === 429) {
    message = `Rate limited by ${new URL(err.url).hostname}${err.retryAfterSec ? ` (retry in ${err.retryAfterSec}s)` : ''}.`;
  }
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

/** One line per search hit: id, repo, versions and the verdict for the top ones. */
function hitLine(h: { id: string; repo?: string; stars?: number; latestVersion?: string }, v?: Verdict): string {
  const parts = [h.id];
  if (h.repo) parts.push(`${h.repo.replace(/^github\.com\//, '')}${h.stars ? ` (${h.stars >= 1000 ? `${Math.round(h.stars / 1000)}k` : h.stars} stars)` : ''}`);
  if (h.latestVersion) parts.push(`latest ${h.latestVersion}`);
  if (v) {
    const r = v.report;
    parts.push(r.safeVersion ? `safe ${r.safeVersion}` : 'no safe version');
    parts.push(r.verdict + (v.typo?.lookalikeOf ? ` (looks like ${v.typo.lookalikeOf})` : '') + (r.verdict !== 'ok' && r.reason ? `: ${r.reason}` : ''));
    if (r.safeVersionLicenses?.length) parts.push(r.safeVersionLicenses.join('/'));
  }
  return parts.join(' | ');
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
      'you install. Efficient flow: decide the full dependency list first, then call check-packages ONCE with ' +
      'all of them (registry names; versions if the project already pins some) and pin the "use" version of each. ' +
      'Then call query-docs only for the APIs you are unsure of, or when a notice says a major is recent ' +
      '(pass the version you pin). resolve-library-id is only for when you do not know the registry name; ' +
      'check-package is the deep view of one package; check-manifest audits a whole lockfile. ' +
      'A "SECURITY NOTICE" is authoritative: prefer the recommended version, and the one on the same release ' +
      'line to avoid breaking changes. When moving to a new major, call upgrade-guide for what changed.',
  });

  // 1) resolve-library-id -------------------------------------------------------
  server.registerTool(
    'resolve-library-id',
    {
      title: 'Find a library (with security verdict)',
      description:
        'Finds the registry package for a library name ("next.js" -> npm:next, "pytorch" -> pypi:torch) and returns ' +
        'ids for query-docs, with the newest version that has no known advisories (safe) and a verdict. ' +
        'Skip it when you know the registry name: query-docs takes "npm:next" or "pypi:requests" directly, and ' +
        'check-packages takes plain names.',
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
        const lines = await Promise.all(
          hits.map(async (h, i) => {
            const v = i < VERDICT_RESULTS ? await checkPackage(h.ecosystem, h.name, undefined, { risk: false }).catch(() => undefined) : undefined;
            return hitLine(h, v);
          }),
        );
        return text([...lines, 'Use the best id with query-docs. Pin the safe version, not latest, when they differ.'].join('\n'));
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
        tokens: z.number().int().optional().describe('Approximate size of the answer in tokens (default 2500; raise it only when the answer was cut short).'),
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
        const notice = securityNotice(r, v.typo, v.risk);
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
        'and typosquat lookalikes. For several packages use check-packages, one call for the whole list.',
      inputSchema: {
        name: z.string().describe('Package name as the registry knows it, e.g. "lodash", "requests".'),
        ecosystem: z.string().describe('npm, pypi, cargo, go, maven, nuget or rubygems (aliases like "python" work).'),
        version: z.string().optional().describe('Version you intend to install or already use.'),
        detail: z.boolean().optional().describe('Return the full JSON report (every advisory, dates, sources) instead of the summary.'),
      },
    },
    async ({ name, ecosystem, version, detail }) => {
      try {
        const eco = parseEcosystem(ecosystem);
        if (!eco) return errorText(new Error(`Unknown ecosystem "${ecosystem}". Use one of: ${ECOSYSTEMS.join(', ')}.`));
        const v = await checkPackage(eco, name.trim(), version?.trim() || undefined);
        const notice = securityNotice(v.report, v.typo, v.risk);
        if (detail) return text({ notice, ...v.report, typosquat: v.typo, risk: v.risk });
        const more = (v.report.requested?.advisories.length ?? 0) > 8 ? '\nCall again with detail: true for every advisory.' : '';
        return text(notice + more);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // 3b) check-packages ----------------------------------------------------------
  server.registerTool(
    'check-packages',
    {
      title: 'Check a whole dependency list in one call',
      description:
        `Supply-chain verdict for up to ${MAX_BATCH} packages at once: one table row per package (verdict, version to pin, ` +
        'short reason) and the full notice only for the ones that need attention. Call it once with every dependency ' +
        'you plan to add, before writing the manifest, instead of one check per package.',
      inputSchema: {
        packages: z
          .array(
            z.object({
              name: z.string().describe('Registry name, e.g. "express", "pyjwt".'),
              version: z.string().optional().describe('Version you intend to pin or already use; omit to get the version to use.'),
              ecosystem: z.string().optional().describe('Overrides the default ecosystem for this package.'),
            }),
          )
          .min(1)
          .max(MAX_BATCH),
        ecosystem: z.string().optional().describe('Default for every package: npm, pypi, cargo, go, maven, nuget or rubygems.'),
      },
    },
    async ({ packages, ecosystem }) => {
      try {
        return text(formatBatch(await checkPackages(packages, ecosystem)));
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

  // 5) upgrade-guide ------------------------------------------------------------
  server.registerTool(
    'upgrade-guide',
    {
      title: 'What changes between two versions',
      description:
        'Breaking changes, removed or renamed APIs, config and default changes, packages that split off, deprecations, ' +
        'and the advisories fixed, between the version a project uses and the one to move to. Sources: changelogs and ' +
        'GitHub release notes for the versions in between, migration guides when a major is crossed, and (npm) a diff of ' +
        'the exported .d.ts API. Call it before upgrading across a major, when a SECURITY NOTICE recommends a new major, ' +
        'or to fix a Dependabot PR. Without "to" it uses the version safectx recommends.',
      inputSchema: {
        libraryId: z.string().optional().describe('Id like "npm:next" or "pypi:langchain" (a version in it is used as "from").'),
        package: z.string().optional().describe('Package name, with ecosystem, instead of libraryId.'),
        ecosystem: z.string().optional().describe('npm, pypi, cargo, go, maven, nuget or rubygems.'),
        from: z.string().optional().describe('Version the project uses now, e.g. "15.5.28" (a range like "4.x" picks its newest release).'),
        to: z.string().optional().describe('Version to move to. Default: the recommended safe version.'),
        query: z.string().optional().describe('What you are changing, e.g. "middleware auth redirect"; ranks entries about it first.'),
        tokens: z.number().int().optional().describe('Approximate size of the answer in tokens (default 5000).'),
      },
    },
    async ({ libraryId, package: pkgName, ecosystem, from, to, query, tokens }) => {
      try {
        let eco = parseEcosystem(ecosystem);
        let name = pkgName?.trim();
        let fromVersion = from?.trim();
        if (libraryId) {
          const ref = await refFromId(libraryId, ecosystem, pkgName);
          if (!ref) return text(`Could not map "${libraryId}" to a registry package. Use an id like "npm:<name>".`);
          eco = ref.ecosystem;
          name = ref.name;
          fromVersion ||= ref.version;
        }
        if (!eco || !name) return errorText(new Error('Pass libraryId, or package with ecosystem.'));
        if (!fromVersion) return errorText(new Error('Pass "from": the version the project uses now.'));
        const budget = tokens ? Math.min(Math.max(tokens, 500), 15_000) * 4 : undefined;
        const r = await upgradeGuide({ ecosystem: eco, name, from: fromVersion, to: to?.trim() || undefined, query, budgetChars: budget });
        return text(r.text);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  return server;
}
