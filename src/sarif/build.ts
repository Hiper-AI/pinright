/**
 * SARIF 2.1.0 for GitHub code scanning (and any SARIF viewer): one rule per
 * advisory and per finding kind, results located on the manifest or lockfile
 * line that brings the package in, with the fix in the message.
 *
 * Follows GitHub's documented subset: rules carry shortDescription,
 * fullDescription, help and `security-severity` (> 9 critical, >= 7 high,
 * >= 4 medium, else low); every result has a physical location with a start
 * line and a `primaryLocationLineHash` fingerprint. The fingerprint is ours and
 * stable (rule, file, package; no line, no version), so an alert survives
 * lockfile churn and closes when the package is fixed or gone.
 *
 * Pure: the caller passes the audits and a reader for the files.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ActionsAudit } from '../actions/check.js';
import { useKey } from '../actions/workflow.js';
import { type AdvisoryInfo } from '../advisories/resolve.js';
import { type PolicyHit } from '../teamConfig.js';
import { type TreeAudit, type TreeFinding } from '../tree/audit.js';
import { type TreePackage } from '../tree/lockfiles.js';
import { type SupplyFinding } from '../tree/supply.js';
import { locatePackage, locateUses, type Region } from './locate.js';

export const SARIF_SCHEMA = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';
const INFO_URI = 'https://github.com/Hiper-AI/safectx';
/** GitHub keeps the top 5,000 results of a run by severity; past that, we drop the mildest ourselves and say so. */
export const MAX_RESULTS = 5000;
const MAX_TEXT = 1000; // GitHub truncates descriptions at 1,024 characters

type Level = 'error' | 'warning' | 'note';

export interface SarifTreeInput {
  audit: TreeAudit;
  /** Packages audited, for the parent of a transitive finding; defaults to none. */
  packages?: TreePackage[];
  policy?: PolicyHit[];
  supply?: SupplyFinding[];
}

export interface SarifInput {
  /** Repository root: URIs are relative to it. */
  root: string;
  toolVersion: string;
  trees: SarifTreeInput[];
  actions?: ActionsAudit;
  notes?: string[];
  /** Reads a file for line numbers; undefined when it cannot. */
  read: (file: string) => string | undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- SARIF objects are plain JSON */
export type SarifLog = { $schema: string; version: '2.1.0'; runs: any[] };

interface Rule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help: { text: string; markdown: string };
  helpUri?: string;
  defaultConfiguration: { level: Level };
  properties: Record<string, unknown>;
}

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 3)}...` : s);
/** The advisory title without its trailing period, so it can sit inside a sentence. */
const titleOf = (a: Pick<AdvisoryInfo, 'id' | 'title'>) => a.title?.trim().replace(/\.+$/, '') || a.id;

/** GitHub's buckets for a named severity when there is no CVSS score. */
const NAMED_SCORE: Record<string, number> = { CRITICAL: 9.5, HIGH: 8.0, MODERATE: 5.5, MEDIUM: 5.5, LOW: 2.5 };

export function securitySeverity(a: Pick<AdvisoryInfo, 'severity' | 'cvss3Score'>): number | undefined {
  if (a.cvss3Score != null && a.cvss3Score > 0) return a.cvss3Score;
  return NAMED_SCORE[(a.severity ?? '').toUpperCase()];
}

export function levelOf(score: number | undefined): Level {
  if (score === undefined) return 'warning'; // unrated is never quiet
  return score >= 7 ? 'error' : score >= 4 ? 'warning' : 'note';
}

const pascal = (s: string) => s.replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_, __, c: string) => c.toUpperCase());

/** Fixed rules, one per finding kind that is not an advisory. */
const KINDS: Record<string, { name: string; short: string; full: string; level: Level; score?: number; tags: string[] }> = {
  'safectx/malware': {
    name: 'MaliciousPackage',
    short: 'Malicious package in the dependency tree',
    full: 'A package in the dependency tree has a malware record (OSV MAL-*): it was published to steal credentials, run code on install or otherwise attack whoever installs it. Remove it, rotate any secret the machine or CI had access to, and check what ran.',
    level: 'error',
    score: 10,
    tags: ['security', 'malware', 'supply-chain'],
  },
  'safectx/typosquat': {
    name: 'Typosquat',
    short: 'Dependency name looks like a typosquat of a popular package',
    full: 'A direct dependency is one or two edits away from a popular package and is either very new or used by a tiny fraction of its audience. Misspelled names are a common way to get malware installed.',
    level: 'error',
    score: 8.0,
    tags: ['security', 'typosquatting', 'supply-chain'],
  },
  'safectx/unknown-package': {
    name: 'UnknownPackage',
    short: 'Dependency not found in the public registry',
    full: 'A direct dependency does not exist in the public registry. It may be a name an agent hallucinated, which anyone could register with malicious code, or a private package; private packages belong in the "allow" list of .safectx.json.',
    level: 'warning',
    score: 5.0,
    tags: ['security', 'slopsquatting', 'supply-chain'],
  },
  'safectx/unpublished-version': {
    name: 'UnpublishedVersion',
    short: 'Locked version is not published in the registry',
    full: 'The version a lockfile pins is not published: it was unpublished or yanked (registries remove malicious releases this way), or it is too new to be indexed. Re-lock to a published version.',
    level: 'warning',
    score: 5.0,
    tags: ['security', 'supply-chain'],
  },
  'safectx/deprecated': {
    name: 'DeprecatedVersion',
    short: 'Dependency version is deprecated',
    full: 'The registry marks this version as deprecated. Deprecated packages stop receiving security fixes.',
    level: 'note',
    tags: ['maintenance', 'supply-chain'],
  },
  'safectx/policy-deny': {
    name: 'PolicyDeniedPackage',
    short: 'Package denied by the project policy',
    full: 'The team policy (.safectx.json) denies this package. Replace it as the policy says, or change the policy.',
    level: 'error',
    tags: ['policy', 'supply-chain'],
  },
  'safectx/policy-license': {
    name: 'PolicyLicense',
    short: 'License not allowed by the project policy',
    full: 'The license of a direct dependency is not allowed by the team policy (.safectx.json).',
    level: 'error',
    tags: ['policy', 'license'],
  },
  'safectx/action-unpinned': {
    name: 'UnpinnedAction',
    short: 'GitHub Action referenced by a mutable tag or branch',
    full: 'A tag or branch can be re-pointed to other code, as in the tj-actions/changed-files compromise. Pin third-party actions to a full commit SHA, with the version as a comment.',
    level: 'warning',
    score: 5.0,
    tags: ['security', 'github-actions', 'supply-chain'],
  },
  'safectx/action-missing-ref': {
    name: 'MissingActionRef',
    short: 'GitHub Action reference does not exist',
    full: 'The tag, branch or commit in a `uses:` line does not exist in the action repository. Check the action name and ref; a misspelled owner is a typosquat risk.',
    level: 'error',
    score: 7.0,
    tags: ['security', 'github-actions'],
  },
  'safectx/action-unverified': {
    name: 'UnverifiedAction',
    short: 'GitHub Action could not be verified',
    full: 'Advisories exist for this action and the release behind the ref could not be told, or a source did not answer. It is not reported clean.',
    level: 'note',
    tags: ['security', 'github-actions'],
  },
};

const RISK_SCORE: Record<Level, number> = { error: 7.5, warning: 5.0, note: 3.0 };

function kindRule(id: string): Rule {
  const k = KINDS[id];
  return {
    id,
    name: k.name,
    shortDescription: { text: k.short },
    fullDescription: { text: k.full },
    help: { text: k.full, markdown: `${k.full}\n\nReported by [safectx](${INFO_URI}).` },
    helpUri: `${INFO_URI}#github-action--ci`,
    defaultConfiguration: { level: k.level },
    properties: { tags: k.tags, precision: 'high', ...(k.score ? { 'security-severity': k.score.toFixed(1) } : {}) },
  };
}

function riskRule(signal: string, level: Level): Rule {
  const text = `Supply-chain risk signal "${signal}" (behavior, not a known advisory): install scripts, provenance, publisher changes, package age and downloads. Review the package before trusting it.`;
  return {
    id: `safectx/risk/${signal}`,
    name: `Risk${pascal(signal)}`,
    shortDescription: { text: `Supply-chain risk: ${signal.replace(/-/g, ' ')}` },
    fullDescription: { text },
    help: { text, markdown: text },
    helpUri: `${INFO_URI}#supply-chain-signals`,
    defaultConfiguration: { level },
    properties: { tags: ['security', 'supply-chain', 'risk'], precision: 'medium', 'security-severity': RISK_SCORE[level].toFixed(1) },
  };
}

function advisoryUrl(a: AdvisoryInfo): string {
  return a.id.startsWith('GHSA-') ? `https://github.com/advisories/${a.id}` : a.url;
}

function advisoryRule(a: AdvisoryInfo, eco: string): Rule {
  const cve = a.aliases.find((x) => x.startsWith('CVE-'));
  const title = titleOf(a);
  const score = securitySeverity(a);
  const sev = a.severity ? a.severity.toLowerCase() : a.cvss3Score != null ? `CVSS ${a.cvss3Score}` : 'unrated';
  const full = `${a.id}${cve ? ` (${cve})` : ''}: ${title}. Severity: ${sev}${a.cvss3Score != null && a.severity ? `, CVSS ${a.cvss3Score}` : ''}.`;
  const more = a.aliases.filter((x) => x !== cve).slice(0, 5);
  return {
    id: a.id,
    name: pascal(a.id),
    shortDescription: { text: clip(cve ? `${cve}: ${title}` : title) },
    fullDescription: { text: clip(full) },
    help: {
      text: clip(`${full} Details: ${advisoryUrl(a)}. Upgrade to a version without the advisory; the result message names it.`),
      markdown: clip(
        `**${a.id}**${cve ? ` (${cve})` : ''}: ${title}\n\nSeverity: ${sev}${more.length ? `. Also known as ${more.join(', ')}` : ''}.\n\n` +
          `[Advisory](${advisoryUrl(a)}) · [OSV](${a.url})\n\nThe result message has the upgrade that clears it.`,
      ),
    },
    helpUri: advisoryUrl(a),
    defaultConfiguration: { level: levelOf(score) },
    properties: {
      tags: ['security', 'vulnerability', 'dependency', eco, ...(cve ? [cve] : [])],
      precision: 'very-high',
      ...(score !== undefined ? { 'security-severity': score.toFixed(1) } : {}),
    },
  };
}

function fingerprint(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

const MANIFEST_OF: Record<string, string[]> = {
  'package-lock.json': ['package.json'],
  'npm-shrinkwrap.json': ['package.json'],
  'pnpm-lock.yaml': ['package.json'],
  'yarn.lock': ['package.json'],
  'poetry.lock': ['pyproject.toml'],
  'uv.lock': ['pyproject.toml'],
  'pdm.lock': ['pyproject.toml'],
  'Cargo.lock': ['Cargo.toml'],
  'composer.lock': ['composer.json'],
  'gradle.lockfile': ['build.gradle.kts', 'build.gradle'],
};

/** The manifest next to a lockfile, when there is one. */
export function manifestOf(lockfile: string, exists: (file: string) => boolean): string | undefined {
  const names = MANIFEST_OF[path.basename(lockfile)] ?? [];
  return names.map((n) => path.join(path.dirname(lockfile), n)).find(exists);
}

function toUri(root: string, file: string): string {
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  return rel.split('/').map(encodeURIComponent).join('/');
}

export function buildSarif(input: SarifInput): SarifLog {
  const rules = new Map<string, Rule>();
  const results: { level: Level; score: number; result: any }[] = [];
  const contents = new Map<string, string | undefined>();
  const read = (f: string) => {
    if (!contents.has(f)) contents.set(f, input.read(f));
    return contents.get(f);
  };
  const addRule = (r: Rule) => {
    if (!rules.has(r.id)) rules.set(r.id, r);
    return r;
  };
  const location = (file: string, reg: Region | undefined, message?: string) => ({
    physicalLocation: {
      artifactLocation: { uri: toUri(input.root, file), uriBaseId: '%SRCROOT%' },
      region: reg ?? { startLine: 1, startColumn: 1, endColumn: 2 },
    },
    ...(message ? { message: { text: message } } : {}),
  });
  const push = (rule: Rule, level: Level, message: string, loc: any, key: string[], related?: any[]) => {
    const score = Number(rule.properties['security-severity'] ?? (level === 'error' ? 7 : level === 'warning' ? 4 : 1));
    results.push({
      level,
      score,
      result: {
        ruleId: rule.id,
        level,
        message: { text: clip(message) },
        locations: [loc],
        ...(related?.length ? { relatedLocations: related.map((r, i) => ({ id: i + 1, ...r })) } : {}),
        partialFingerprints: { primaryLocationLineHash: fingerprint(rule.id, loc.physicalLocation.artifactLocation.uri, ...key) },
      },
    });
  };

  for (const t of input.trees) {
    const a = t.audit;
    const eco = a.ecosystem;
    const content = read(a.file);
    const pkgs = t.packages ?? [];
    // Next to a lockfile, the manifest is where people declare (and change) a direct dependency.
    const manifestFile = a.source === 'lockfile' ? manifestOf(a.file, (f) => read(f) !== undefined) : undefined;
    const manifest = manifestFile ? { file: manifestFile, content: read(manifestFile) as string } : undefined;
    const inManifest = (name: string) => (manifest ? locatePackage(manifest.file, manifest.content, eco, name) : undefined);
    const where = (name: string, version?: string): { loc: any; related: any[]; via: string } => {
      const pkg = pkgs.find((p) => p.name === name && (!version || p.version === version)) ?? pkgs.find((p) => p.name === name);
      const parent = pkg && !pkg.direct && pkg.path && pkg.path.length > 1 ? pkg.path[0] : undefined;
      const via = pkg?.direct ? 'direct dependency' : pkg?.path && pkg.path.length > 1 ? `via ${pkg.path.join(' > ')}` : 'transitive dependency';
      if (!content) return { loc: location(a.file, undefined), related: [], via };
      // A lockfile has an entry for every package; a manifest only for the direct ones, so point at the parent there.
      const own = a.source === 'lockfile' || pkg?.direct !== false ? locatePackage(a.file, content, eco, name, version) : undefined;
      if (pkg?.direct && manifest) {
        const declared = inManifest(name);
        if (declared) return { loc: location(manifest.file, declared), related: own ? [location(a.file, own, `${name}@${pkg.version} locked here`)] : [], via };
      }
      if (!parent) return { loc: location(a.file, own), related: [], via };
      const parentVersion = pkgs.find((p) => p.name === parent)?.version;
      const parentDecl = inManifest(parent);
      const parentLoc = parentDecl
        ? location((manifest as { file: string }).file, parentDecl, `${parent} brings in ${name}`)
        : (() => {
            const r = locatePackage(a.file, content, eco, parent, parentVersion);
            return r ? location(a.file, r, `${parent} brings in ${name}`) : undefined;
          })();
      if (own) return { loc: location(a.file, own), related: parentLoc ? [parentLoc] : [], via };
      return { loc: parentLoc ? { physicalLocation: parentLoc.physicalLocation } : location(a.file, undefined), related: [], via };
    };

    for (const f of a.findings) {
      const { loc, related, via } = where(f.name, f.version);
      const fix = fixText(a, f);
      if (f.malicious) {
        const rule = addRule(kindRule('safectx/malware'));
        const ids = f.advisories.map((x) => x.id).join(', ');
        push(rule, 'error', `MALWARE: ${f.name}@${f.version} (${via}) is a known malicious package (${ids}). Remove it and rotate any secret the machine or CI could reach.`, loc, [eco, f.name], related);
        continue;
      }
      for (const adv of f.advisories) {
        const rule = addRule(advisoryRule(adv, eco));
        const cve = adv.aliases.find((x) => x.startsWith('CVE-'));
        const sev = adv.severity ? adv.severity.toLowerCase() : 'unrated';
        const msg = `${f.name}@${f.version} (${via}) is affected by ${adv.id}${cve ? ` (${cve})` : ''}: ${titleOf(adv)}. Severity: ${sev}. ${fix}`;
        push(rule, rule.defaultConfiguration.level, msg, loc, [eco, f.name], related);
      }
    }

    for (const s of t.supply ?? []) {
      const rule = addRule(s.kind === 'risk' ? riskRule(s.signal ?? 'signal', s.level) : kindRule(`safectx/${s.kind}`));
      const { loc, related } = where(s.name, s.version);
      push(rule, s.level, s.message, loc, [eco, s.name], related);
    }

    for (const h of t.policy ?? []) {
      if (h.kind === 'note' || !h.name) continue;
      const rule = addRule(kindRule(h.kind === 'deny' ? 'safectx/policy-deny' : 'safectx/policy-license'));
      const { loc, related } = where(h.name, h.version);
      push(rule, 'error', h.text, loc, [eco, h.name], related);
    }
  }

  for (const f of input.actions?.findings ?? []) {
    const ref = useKey(f.use);
    for (const at of f.locations) {
      const i = at.lastIndexOf(':');
      const file = at.slice(0, i);
      const line = Number(at.slice(i + 1));
      const content = read(file);
      const loc = location(file, content ? locateUses(content, line) : { startLine: line, startColumn: 1, endColumn: 2 });
      const key = [f.name, f.use.path ?? '', f.use.ref];
      if (f.advisories.length) {
        for (const adv of f.advisories) {
          const rule = addRule(advisoryRule(adv, 'github-actions'));
          const cve = adv.aliases.find((x) => x.startsWith('CVE-'));
          const ver = f.version && f.version !== f.use.ref ? ` (${f.version})` : '';
          const fix = f.upgradeTo ? `Use: uses: ${f.upgradeTo}` : f.fixedIn ? `Fixed in ${f.fixedIn}; pin that release to its commit SHA.` : 'No fixed release found.';
          push(rule, rule.defaultConfiguration.level, `uses: ${ref}${ver} is affected by ${adv.id}${cve ? ` (${cve})` : ''}: ${titleOf(adv)}. ${fix}`, loc, key);
        }
      } else if (!f.exists) {
        push(addRule(kindRule('safectx/action-missing-ref')), 'error', `uses: ${ref}: no such tag, branch or commit in ${f.name}.`, loc, key);
      } else if (f.unverified) {
        push(addRule(kindRule('safectx/action-unverified')), 'note', `uses: ${ref} could not be verified: ${f.unverified}.`, loc, key);
      }
      if (f.exists && !f.pinned && !f.advisories.length) {
        const pin = f.pinTo ? `uses: ${f.pinTo}` : 'uses: owner/repo@<40-char SHA> # tag';
        push(addRule(kindRule('safectx/action-unpinned')), 'warning', `uses: ${ref} is a mutable ref; a tag can be re-pointed to other code. Pin the commit: ${pin}`, loc, key);
      }
    }
  }

  const notes = [...(input.notes ?? [])];
  const order: Record<Level, number> = { error: 0, warning: 1, note: 2 };
  let kept = results;
  if (results.length > MAX_RESULTS) {
    kept = [...results].sort((x, y) => y.score - x.score || order[x.level] - order[y.level]).slice(0, MAX_RESULTS);
    notes.push(`${results.length} results; the ${MAX_RESULTS} most severe are included.`);
  }
  const ruleList = [...rules.values()].sort((x, y) => x.id.localeCompare(y.id));
  const index = new Map(ruleList.map((r, i) => [r.id, i]));
  const rootUri = pathToFileURL(path.resolve(input.root)).href.replace(/\/?$/, '/');

  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'safectx',
            semanticVersion: input.toolVersion,
            version: input.toolVersion,
            informationUri: INFO_URI,
            rules: ruleList,
          },
        },
        originalUriBaseIds: { '%SRCROOT%': { uri: rootUri } },
        invocations: [
          {
            executionSuccessful: true,
            ...(notes.length ? { toolExecutionNotifications: notes.map((n) => ({ level: 'note', message: { text: clip(n) } })) } : {}),
          },
        ],
        results: kept.map((r) => ({ ...r.result, ruleIndex: index.get(r.result.ruleId) })),
        columnKind: 'utf16CodeUnits',
      },
    ],
  };
}

/** The fix for one finding, as the text audit words it. */
export function fixText(a: TreeAudit, f: TreeFinding): string {
  const key = `${f.name}@${f.version}`;
  const r = a.remediation.find((x) => x.clears.includes(key));
  if (r) {
    const major = r.crossesMajor ? ' (new major: check the migration guide)' : '';
    if (r.kind === 'upgrade-direct') return `Fix: upgrade to ${r.to}${major}: ${r.command}`;
    if (r.kind === 'upgrade-parent') return `Fix: upgrade ${r.target} from ${r.from} to ${r.to}, which no longer pulls the affected version${major}: ${r.command}`;
    return `Fix: pin ${r.target} to ${r.to} or newer: ${r.command}`;
  }
  return f.fixedVersion ? `Fixed in ${f.fixedVersion}.` : 'No fixed version released.';
}
