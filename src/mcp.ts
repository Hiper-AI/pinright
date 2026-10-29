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
import { auditActions, formatActionsAudit } from './actions/check.js';
import { type ActionUse, isWorkflowFile, parseUses, workflowFiles } from './actions/workflow.js';
import { getDocs } from './docs/index.js';
import { ECOSYSTEMS, type Ecosystem, parseEcosystem } from './ecosystems.js';
import { securityNotice } from './format.js';
import { HttpError } from './http.js';
import { resolvePackage } from './mapping.js';
import { describeInstalled, manifestsIn, Project, readSiblings, watchRoots } from './project.js';
import { ecosystemHint, formatLibraryId, parseLibraryRef, searchPackages } from './search.js';
import { auditTree, formatTreeAudit } from './tree/audit.js';
import { detectKind, parseFile, SUPPORTED_FILES } from './tree/lockfiles.js';
import { findLookalike } from './typosquat.js';
import { upgradeGuide } from './upgrade/index.js';
import { policyFindings, treePolicyFindings } from './teamConfig.js';
import { checkPackage, type Verdict } from './verdict.js';

// Moved to project.ts; re-exported for existing importers.
export { manifestsIn, readSiblings };

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
function hitLine(
  h: { id: string; repo?: string; stars?: number; latestVersion?: string },
  v?: Verdict,
  installed?: { version: string; file: string },
): string {
  const parts = [h.id];
  if (installed) parts.push(`installed ${installed.version} (${installed.file})`);
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

/** Policy lines for the agent, with the file's error first when it cannot be read. */
function policyLines(found: string[], error?: string): string[] {
  return [...(error ? [`POLICY ERROR: ${error} Fix the file; the hook denies dependency changes until then.`] : []), ...found.map((f) => `POLICY: ${f}`)];
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
      'Without a version, the tools use the version installed in the project, read from its lockfile or manifest. ' +
      'A "SECURITY NOTICE" is authoritative: prefer the recommended version, and the one on the same release ' +
      'line to avoid breaking changes. When moving to a new major, call upgrade-guide for what changed.',
  });
  const project = new Project();
  watchRoots(server.server, project);

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
        ecosystem: z.string().optional().describe('npm, pypi, cargo, go, maven, nuget, rubygems or composer, when you know it.'),
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
            const inst = await project.installed(h.ecosystem, h.name).catch(() => undefined);
            const v = i < VERDICT_RESULTS ? await checkPackage(h.ecosystem, h.name, inst?.version, { risk: false }).catch(() => undefined) : undefined;
            return hitLine(h, v, inst);
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
        const inst = version || ref.version ? undefined : await project.installed(ref.ecosystem, ref.name).catch(() => undefined);
        const requested = (version ?? ref.version ?? inst?.version)?.replace(/^v(?=\d)/, '');
        const { policy, error } = await project.policy();
        const v = await checkPackage(ref.ecosystem, ref.name, requested);
        const r = v.report;
        const notice = [
          ...(inst ? [describeInstalled(inst)] : []),
          ...policyLines(policyFindings(policy, ref.ecosystem, ref.name, r.requested?.licenses, Boolean(r.requested?.licenses)), error),
          securityNotice(r, v.typo, v.risk),
        ].join('\n');
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
        ecosystem: z.string().describe('npm, pypi, cargo, go, maven, nuget, rubygems or composer (aliases like "python" work).'),
        version: z.string().optional().describe('Version you intend to install or already use.'),
        detail: z.boolean().optional().describe('Return the full JSON report (every advisory, dates, sources) instead of the summary.'),
      },
    },
    async ({ name, ecosystem, version, detail }) => {
      try {
        const eco = parseEcosystem(ecosystem);
        if (!eco) return errorText(new Error(`Unknown ecosystem "${ecosystem}". Use one of: ${ECOSYSTEMS.join(', ')}.`));
        const inst = version?.trim() ? undefined : await project.installed(eco, name.trim()).catch(() => undefined);
        const { policy, error } = await project.policy();
        const v = await checkPackage(eco, name.trim(), version?.trim() || inst?.version);
        const r = v.report;
        // The license of the version asked about, else of the recommended one.
        const licenses = r.requested ? r.requested.licenses : r.safeVersionLicenses;
        const known = r.requested ? !['unknown', 'unknown-package'].includes(r.requested.verdict) : Boolean(r.safeVersion);
        const policyNotes = policyLines(policyFindings(policy, eco, name.trim(), licenses, known), error);
        const notice = [...(inst ? [describeInstalled(inst)] : []), ...policyNotes, securityNotice(r, v.typo, v.risk)].join('\n');
        if (detail) {
          return text({
            notice, ...r, typosquat: v.typo, risk: v.risk,
            ...(inst ? { installed: { version: inst.version, file: inst.file, source: inst.source } } : {}),
            ...(policyNotes.length ? { policy: policyNotes } : {}),
          });
        }
        const more = (r.requested?.advisories.length ?? 0) > 8 ? '\nCall again with detail: true for every advisory.' : '';
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
        'you plan to add, before writing the manifest, instead of one check per package. Packages already in the ' +
        'project are checked at their installed version when you omit it.',
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
        ecosystem: z.string().optional().describe('Default for every package: npm, pypi, cargo, go, maven, nuget, rubygems or composer.'),
      },
    },
    async ({ packages, ecosystem }) => {
      try {
        // Fill in the installed version for packages the project already has.
        const filled = await Promise.all(
          packages.map(async (p) => {
            if (p.version) return p;
            const eco = parseEcosystem(p.ecosystem ?? ecosystem ?? '');
            const inst = eco ? await project.installed(eco, p.name).catch(() => undefined) : undefined;
            return inst ? { ...p, version: inst.version } : p;
          }),
        );
        return text(formatBatch(await checkPackages(filled, ecosystem)));
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
        `Supported: ${SUPPORTED_FILES.join(', ')}, requirements*.txt. Without a lockfile the tree is resolved through deps.dev. ` +
        'GitHub workflows (.github/workflows/*.yml, action.yml, or the directory) get an Actions check: advisories and SHA pinning.',
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
        const workflows: { file: string; uses: ActionUse[] }[] = [];
        if (content) {
          if (fileName && !detectKind(fileName) && (isWorkflowFile(fileName) || /\.ya?ml$/i.test(fileName))) {
            workflows.push({ file: fileName, uses: parseUses(content, fileName) });
          } else if (!fileName || !detectKind(fileName)) {
            return errorText(new Error(`fileName must be one of: ${SUPPORTED_FILES.join(', ')}, requirements*.txt, a GitHub workflow (.yml) or action.yml.`));
          } else targets.push({ file: fileName, content, siblings: {} });
        } else if (p) {
          const abs = path.resolve(p);
          const wf = workflowFiles(abs);
          for (const f of wf) workflows.push({ file: f, uses: parseUses(fs.readFileSync(f, 'utf8'), f) });
          const files = fs.statSync(abs).isDirectory() ? manifestsIn(abs) : wf.length ? [] : [abs];
          if (!files.length && !wf.length) return text(`No supported lockfile, manifest or workflow in ${abs}.`);
          for (const f of files) {
            // Only dependency files: this tool never reads anything else from disk.
            if (!detectKind(f)) return errorText(new Error(`Unsupported file ${f}.`));
            targets.push({ file: f, content: fs.readFileSync(f, 'utf8'), siblings: readSiblings(f) });
          }
        } else {
          return errorText(new Error('Pass path, or content with fileName.'));
        }
        const parts: string[] = [];
        // The policy of the audited project when a path is given, else of the current one.
        const { policy, error } = await project.policy(p ? path.resolve(p) : undefined);
        if (error) parts.push(policyLines([], error).join('\n'));
        for (const t of targets) {
          const tree = parseFile(t.file, t.content, t.siblings);
          const audit = await auditTree(tree, { includeDev });
          const found = await treePolicyFindings(policy, tree);
          parts.push([formatTreeAudit(audit, 25), ...(found.length ? [`Project policy (${policy.file ? path.basename(policy.file) : 'env'}):`, ...found.map((f) => `- ${f}`)] : [])].join('\n'));
        }
        if (workflows.length) parts.push(formatActionsAudit(await auditActions(workflows), 25));
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
