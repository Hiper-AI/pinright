/**
 * The MCP server. Two tools keep Context7's names so that "use context7" prompts
 * keep working unchanged; the third is the verdict on its own.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fetchDocs, parseLibraryId, searchLibraries, withVersion, type Context7Library } from './context7.js';
import { ECOSYSTEMS, parseEcosystem } from './ecosystems.js';
import { securityNotice } from './format.js';
import { HttpError } from './http.js';
import { resolvePackage } from './mapping.js';
import { checkPackage, type Verdict } from './verdict.js';

export const SERVER_INFO = { name: 'safectx', version: '0.1.0' } as const;

const VERDICT_RESULTS = 3; // top search hits that get a full verdict; the rest are listed plain

function text(payload: unknown) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text' as const, text: body }] };
}

function errorText(err: unknown) {
  let message = (err as Error).message;
  if (err instanceof HttpError && err.status === 429) {
    message =
      `Context7 rate limit reached${err.retryAfterSec ? ` (retry in ${err.retryAfterSec}s)` : ''}. ` +
      'Set CONTEXT7_API_KEY for higher limits (free key at https://context7.com/dashboard).';
  }
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

function summarize(v: Verdict) {
  const r = v.report;
  return {
    ecosystem: r.ecosystem,
    package: r.package,
    verdict: r.verdict,
    reason: r.reason,
    safeVersion: r.safeVersion,
    latestVersion: r.latestVersion,
    license: r.safeVersionLicenses,
    lookalikeOf: v.typo?.lookalikeOf,
  };
}

/** Context7 lists versions as "v15.1.8" or "15"; find the one that matches a registry version. */
function context7VersionFor(lib: Context7Library | undefined, version: string): string | undefined {
  const want = version.replace(/^v/, '');
  return (lib?.versions ?? []).find((v) => v.replace(/^v/, '') === want);
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Up-to-date library documentation (Context7) with a supply-chain verdict: which version ' +
      'is free of known vulnerabilities (deps.dev + OSV), whether a name looks like a typosquat, ' +
      'and the upgrade command. Flow: resolve-library-id -> query-docs. Before installing any ' +
      'package, call check-package. A "SECURITY NOTICE" in a reply is authoritative: prefer the ' +
      'recommended version over the one you were about to use.',
  });

  // 1) resolve-library-id -------------------------------------------------------
  server.registerTool(
    'resolve-library-id',
    {
      title: 'Resolve a library id (with security verdict)',
      description:
        'Resolves a library name to a Context7-compatible library id (e.g. "/vercel/next.js") and, ' +
        'for the top matches, adds the package it publishes, the newest version with no known ' +
        'advisories (safeVersion) and a verdict. Call this before query-docs unless the user ' +
        'already gave an id in "/org/project" form.',
      inputSchema: {
        libraryName: z.string().describe('Library name to search for, e.g. "next.js", "requests".'),
        query: z
          .string()
          .describe('What you are trying to do with it; improves ranking, e.g. "auth middleware".'),
      },
    },
    async ({ libraryName, query }) => {
      try {
        const libs = await searchLibraries(libraryName, query);
        const results = await Promise.all(
          libs.map(async (lib, i) => {
            const base = {
              id: lib.id,
              title: lib.title,
              description: lib.description,
              snippets: lib.totalSnippets,
              trustScore: lib.trustScore,
              benchmarkScore: lib.benchmarkScore,
              versions: lib.versions?.filter((v) => !v.startsWith('__')),
            };
            if (i >= VERDICT_RESULTS) return base;
            const ref = await resolvePackage(lib.id, { title: lib.title }).catch(() => undefined);
            if (!ref) {
              return { ...base, security: { verdict: 'unknown-package', reason: 'could not map this id to a package; pass packageName and ecosystem to query-docs or use check-package' } };
            }
            const v = await checkPackage(ref.ecosystem, ref.name);
            return { ...base, security: summarize(v) };
          }),
        );
        return text({
          results,
          hint: 'Pick the best match and call query-docs with its id. Prefer safeVersion when choosing what to install.',
        });
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // 2) query-docs -------------------------------------------------------------
  server.registerTool(
    'query-docs',
    {
      title: 'Fetch documentation (version-checked)',
      description:
        'Fetches up-to-date documentation for a library from Context7. If the id carries no version, ' +
        'the docs come from the newest version with no known advisories when Context7 has it indexed. ' +
        'If the id pins a vulnerable or deprecated version, the reply starts with a SECURITY NOTICE ' +
        'listing the advisories and the version to use instead, followed by the docs you asked for.',
      inputSchema: {
        libraryId: z
          .string()
          .describe('Context7 id, e.g. "/vercel/next.js" or "/vercel/next.js/v15.1.8".'),
        query: z.string().describe('The question or task, e.g. "how to set up middleware".'),
        language: z.string().optional().describe('Programming language filter, e.g. "typescript".'),
        packageName: z
          .string()
          .optional()
          .describe('Registry package name when it differs from the repo, e.g. "next" or "@prisma/client".'),
        ecosystem: z
          .enum(ECOSYSTEMS as unknown as [string, ...string[]])
          .optional()
          .describe('Registry of packageName: npm, pypi, cargo, go, maven, nuget, rubygems.'),
      },
    },
    async ({ libraryId, query, language, packageName, ecosystem }) => {
      try {
        const { version: pinned, base, repo } = parseLibraryId(libraryId);
        const ref = await resolvePackage(libraryId, { ecosystem, packageName, language }).catch(() => undefined);

        let docsId = libraryId;
        let notice: string;
        if (!ref) {
          notice =
            `NOTICE: no security verdict: "${base}" could not be mapped to a registry package. ` +
            'Pass packageName and ecosystem, or call check-package before installing.';
        } else {
          const v = await checkPackage(ref.ecosystem, ref.name, pinned?.replace(/^v/, ''));
          notice = securityNotice(v.report, v.typo);
          if (!pinned && v.report.safeVersion) {
            // Only pin a version Context7 actually indexed; otherwise serve its default branch.
            const libs = await searchLibraries(repo, query).catch(() => []);
            const lib = libs.find((l) => l.id === base);
            const c7v = context7VersionFor(lib, v.report.safeVersion);
            if (c7v) docsId = withVersion(libraryId, c7v);
          }
        }

        const docs = await fetchDocs(docsId, query, language);
        const header = `${notice}\nDocs source: ${docsId}\n\n`;
        return text(header + docs);
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
        'Supply-chain verdict for a package, no docs: known advisories (CVE/GHSA, malware), ' +
        'deprecation, license, newest version with no known advisories, typosquat lookalikes. ' +
        'Call it before any npm install / pip install / cargo add / go get.',
      inputSchema: {
        name: z.string().describe('Package name as the registry knows it, e.g. "lodash", "requests".'),
        ecosystem: z
          .string()
          .describe('npm, pypi, cargo, go, maven, nuget or rubygems (aliases like "python" work).'),
        version: z.string().optional().describe('Version you intend to install, if any.'),
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

  return server;
}
