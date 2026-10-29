/**
 * The team policy: a `.safectx.json` at the project root, versioned with the
 * repo, so every developer and every agent on the project enforces the same
 * rules. Precedence: built-in defaults < the file < environment variables.
 *
 * A broken file is an error, never "no policy": the hook denies dependency
 * changes until the file is fixed, so a typo cannot silently turn a deny list off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { getPackage, getVersion } from './advisories/depsdev.js';
import { type Ecosystem } from './ecosystems.js';
import { normalizePypiName, type ParsedTree } from './tree/lockfiles.js';
import { pickVersion } from './tree/resolveManifest.js';

export const CONFIG_FILE = '.safectx.json';

const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];
type Action = 'allow' | 'ask' | 'deny';

const denyRule = z.union([
  z.string().min(1),
  z.strictObject({
    name: z.string().min(1).describe('Package name; `*` matches any run of characters.'),
    ecosystem: z.enum(['npm', 'pypi', 'cargo', 'go', 'maven', 'nuget', 'rubygems']).optional(),
    reason: z.string().optional(),
  }),
]);

export const teamConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  /** Names that skip every check (private packages). `*` is a wildcard: "@acme/*". */
  allow: z.array(z.string().min(1)).optional(),
  /** Packages nobody on the team may add, with the reason shown to the agent. */
  deny: z.array(denyRule).optional(),
  /** SPDX ids, `*` allowed ("GPL-*"). With `allow`, anything else is denied. */
  licenses: z.strictObject({ allow: z.array(z.string().min(1)).optional(), deny: z.array(z.string().min(1)).optional() }).optional(),
  /** Minimum age in days of a version before it is recommended. */
  cooldownDays: z.number().int().min(0).max(365).optional(),
  /** `enforce` blocks an unpinned install whose newest version is inside the cooldown window. */
  cooldown: z.enum(['warn', 'enforce']).optional(),
  /** Advisories below this severity do not block; they become notes. Unrated advisories always count. */
  severityThreshold: z.enum(SEVERITIES).optional(),
  /** When no version without advisories exists. */
  noFix: z.enum(['severity', 'allow', 'ask', 'deny']).optional(),
  /** When deps.dev or OSV cannot be reached. */
  onError: z.enum(['allow', 'ask', 'deny']).optional(),
  /** Pinning of GitHub Actions to commit SHAs; read by the workflow checks. */
  actionsPin: z.enum(['off', 'warn', 'enforce']).optional(),
});

export type TeamConfig = z.infer<typeof teamConfigSchema>;

export interface DenyEntry {
  name: string;
  ecosystem?: Ecosystem;
  reason?: string;
}

/** Everything the hook and the tools need, after defaults, file and env are merged. */
export interface Policy {
  allow: string[];
  deny: DenyEntry[];
  licenses: { allow?: string[]; deny?: string[] };
  severityThreshold: Severity;
  noFix: 'severity' | Action;
  onError: Action;
  cooldown: 'warn' | 'enforce';
  cooldownDays?: number;
  actionsPin?: 'off' | 'warn' | 'enforce';
  /** The file the policy came from, for messages. */
  file?: string;
}

export interface LoadedConfig {
  file?: string;
  config?: TeamConfig;
  /** Set when the file exists but cannot be used. */
  error?: string;
}

/** JSON with // and /* comments and trailing commas, as written by `safectx init`. */
export function stripJsonComments(src: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === '\\') out += src[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  // Trailing commas before } or ], outside strings (strings were copied verbatim and cannot end in ",}").
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseTeamConfig(content: string, file = CONFIG_FILE): LoadedConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(content));
  } catch (err) {
    return { file, error: `${file} is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = teamConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.length ? i.path.join('.') : '(top level)'}: ${i.message}`);
    return { file, error: `${file} does not match the safectx schema: ${issues.join('; ')}` };
  }
  return { file, config: parsed.data };
}

/**
 * The nearest .safectx.json from `dir` upwards, stopping at the repository root
 * (the directory holding .git) or the home directory, whichever comes first.
 */
export function findConfigFile(dir: string): string | undefined {
  const home = path.resolve(os.homedir());
  let cur = path.resolve(dir);
  for (;;) {
    const candidate = path.join(cur, CONFIG_FILE);
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(cur, '.git')) || cur === home) return undefined;
    const up = path.dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
}

const loaded = new Map<string, { mtimeMs: number; result: LoadedConfig }>();

/** Reads and validates the config that applies to `dir`; cached until the file changes. */
export function loadTeamConfig(dir: string): LoadedConfig {
  const file = findConfigFile(dir);
  if (!file) return {};
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return { file, error: `${file} cannot be read: ${(err as Error).message}` };
  }
  const hit = loaded.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.result;
  let result: LoadedConfig;
  try {
    result = parseTeamConfig(fs.readFileSync(file, 'utf8'), file);
  } catch (err) {
    result = { file, error: `${file} cannot be read: ${(err as Error).message}` };
  }
  loaded.set(file, { mtimeMs: stat.mtimeMs, result });
  return result;
}

function envList(name: string, env: NodeJS.ProcessEnv): string[] {
  return (env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function envEnum<T extends string>(name: string, values: readonly T[], env: NodeJS.ProcessEnv): T | undefined {
  const v = env[name]?.trim().toLowerCase();
  return v && (values as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** Defaults < file < env. SAFECTX_ALLOW adds to the file's allow list instead of replacing it. */
export function resolvePolicy(cfg?: TeamConfig, env: NodeJS.ProcessEnv = process.env, file?: string): Policy {
  const days = env.SAFECTX_COOLDOWN_DAYS ? Number.parseInt(env.SAFECTX_COOLDOWN_DAYS, 10) : undefined;
  return {
    allow: [...(cfg?.allow ?? []), ...envList('SAFECTX_ALLOW', env)],
    deny: (cfg?.deny ?? []).map((d) => (typeof d === 'string' ? { name: d } : d)),
    licenses: { allow: cfg?.licenses?.allow, deny: cfg?.licenses?.deny },
    severityThreshold: envEnum('SAFECTX_SEVERITY_THRESHOLD', SEVERITIES, env) ?? cfg?.severityThreshold ?? 'low',
    noFix: envEnum('SAFECTX_HOOK_NO_FIX', ['severity', 'allow', 'ask', 'deny'] as const, env) ?? cfg?.noFix ?? 'severity',
    onError: envEnum('SAFECTX_HOOK_ON_ERROR', ['allow', 'ask', 'deny'] as const, env) ?? cfg?.onError ?? 'allow',
    cooldown: envEnum('SAFECTX_HOOK_COOLDOWN', ['warn', 'enforce'] as const, env) ?? cfg?.cooldown ?? 'warn',
    cooldownDays: days !== undefined && Number.isFinite(days) && days >= 0 ? days : cfg?.cooldownDays,
    actionsPin: envEnum('SAFECTX_ACTIONS_PIN', ['off', 'warn', 'enforce'] as const, env) ?? cfg?.actionsPin,
    file,
  };
}

function glob(pattern: string): RegExp {
  const body = pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'i');
}

const same = (eco: Ecosystem, pattern: string, name: string) =>
  eco === 'pypi' ? glob(normalizePypiName(pattern)).test(normalizePypiName(name)) : glob(pattern).test(name);

export function isAllowed(p: Policy, eco: Ecosystem, name: string): boolean {
  return p.allow.some((a) => same(eco, a, name));
}

export function denyEntry(p: Policy, eco: Ecosystem, name: string): DenyEntry | undefined {
  return p.deny.find((d) => (!d.ecosystem || d.ecosystem === eco) && same(eco, d.name, name));
}

export function denyMessage(p: Policy, d: DenyEntry): string {
  return `denied by the project policy${p.file ? ` (${path.basename(p.file)})` : ''}${d.reason ? `: ${d.reason}` : '.'}`;
}

const UNKNOWN_LICENSE = /^(non-standard|noassertion|unknown|unlicensed|other|)$/i;

/** "MIT OR (Apache-2.0 AND BSD-3-Clause)" -> [["MIT"], ["Apache-2.0", "BSD-3-Clause"]]. Several entries all apply. */
function licenseBranches(licenses: string[]): string[][] {
  const product = (a: string[][], b: string[][]) => a.flatMap((x) => b.map((y) => [...x, ...y]));
  let branches: string[][] = [[]];
  for (const expr of licenses) {
    // SPDX expression to "OR of ANDs": OR binds looser than AND, parentheses group, "WITH exception" stays with its id.
    const toks = expr.match(/\(|\)|[^\s()]+/g) ?? [];
    let k = 0;
    const parseOr = (): string[][] => {
      let out = parseAnd();
      while (/^or$/i.test(toks[k] ?? '')) {
        k++;
        out = [...out, ...parseAnd()];
      }
      return out;
    };
    const parseAnd = (): string[][] => {
      let out = parseAtom();
      while (/^and$/i.test(toks[k] ?? '')) {
        k++;
        out = product(out, parseAtom());
      }
      return out;
    };
    const parseAtom = (): string[][] => {
      const t = toks[k++];
      if (t === undefined) return [[]];
      if (t === '(') {
        const inner = parseOr();
        if (toks[k] === ')') k++;
        return inner;
      }
      if (/^with$/i.test(toks[k] ?? '')) k += 2;
      return [[t]];
    };
    const dnf = toks.length ? parseOr() : [[]];
    branches = product(branches, dnf);
  }
  return branches;
}

export interface LicenseCheck {
  action: 'deny' | 'note' | 'ok';
  message?: string;
}

/**
 * A license expression is denied when every alternative it offers carries a
 * denied id (or, with an allow list, an id outside it). Missing or non-SPDX
 * license data is a note: safectx cannot tell, so a human should look.
 */
export function checkLicenses(p: Policy, licenses: string[] | undefined): LicenseCheck {
  const { allow, deny } = p.licenses;
  if (!allow?.length && !deny?.length) return { action: 'ok' };
  const list = (licenses ?? []).filter((l) => l.trim());
  const shown = list.join(' AND ') || 'none declared';
  const branches = licenseBranches(list);
  if (!list.length || branches.every((b) => b.some((id) => UNKNOWN_LICENSE.test(id)))) {
    return { action: 'note', message: `license unknown (${shown}); the project policy restricts licenses, check it by hand.` };
  }
  const bad = (id: string) =>
    (deny ?? []).some((d) => glob(d).test(id)) || (allow?.length ? !allow.some((a) => glob(a).test(id)) && !UNKNOWN_LICENSE.test(id) : false);
  const usable = branches.filter((b) => !b.some(bad));
  if (usable.length) {
    if (usable.every((b) => b.some((id) => UNKNOWN_LICENSE.test(id)))) {
      return { action: 'note', message: `license partly unknown (${shown}); check it by hand.` };
    }
    return { action: 'ok' };
  }
  return { action: 'deny', message: `license ${shown} is not allowed by the project policy${p.file ? ` (${path.basename(p.file)})` : ''}.` };
}

/** CRITICAL 3, HIGH 2, MODERATE 1, LOW 0. Unrated is undefined. */
export function severityLevel(severity: string | undefined, cvss?: number): number | undefined {
  const s = (severity ?? '').toUpperCase();
  const named: Record<string, number> = { CRITICAL: 3, HIGH: 2, MODERATE: 1, MEDIUM: 1, LOW: 0 };
  if (s in named) return named[s];
  if (cvss != null && cvss > 0) return cvss >= 9 ? 3 : cvss >= 7 ? 2 : cvss >= 4 ? 1 : 0;
  return undefined;
}

/** True when every advisory is rated below the threshold. Unrated ones count as serious. */
export function belowThreshold(p: Policy, advisories: { severity?: string; cvss3Score?: number }[]): boolean {
  const floor = SEVERITIES.indexOf(p.severityThreshold);
  if (floor <= 0 || !advisories.length) return false;
  return advisories.every((a) => {
    const lvl = severityLevel(a.severity, a.cvss3Score);
    return lvl !== undefined && lvl < floor;
  });
}

/**
 * Policy findings for one package version, for check-package and check-manifest.
 * Lines are written for the agent; empty when nothing applies.
 */
export function policyFindings(p: Policy, eco: Ecosystem, name: string, licenses?: string[], licensesKnown = true): string[] {
  if (isAllowed(p, eco, name)) return [];
  const out: string[] = [];
  const d = denyEntry(p, eco, name);
  if (d) out.push(`${name}: ${denyMessage(p, d)}`);
  if (licensesKnown) {
    const l = checkLicenses(p, licenses);
    if (l.message) out.push(`${name}: ${l.message}`);
  }
  return out;
}

const MAX_LICENSE_LOOKUPS = 60;

/** One policy finding for a dependency file, structured for SARIF; `text` is the line the tools show. */
export interface PolicyHit {
  kind: 'deny' | 'license' | 'note';
  name?: string;
  version?: string;
  text: string;
}

/**
 * Policy findings for a whole dependency file: the deny list over every package
 * (direct and transitive, no network), and licenses of the direct dependencies
 * (one deps.dev lookup each, cached).
 */
export async function treePolicyHits(p: Policy, tree: ParsedTree): Promise<PolicyHit[]> {
  const restrictsLicenses = Boolean(p.licenses.allow?.length || p.licenses.deny?.length);
  if (!p.deny.length && !restrictsLicenses) return [];
  const eco = tree.ecosystem;
  const out: PolicyHit[] = [];
  const all = new Map<string, string | undefined>();
  for (const pk of tree.packages) if (!all.has(pk.name)) all.set(pk.name, pk.version);
  for (const d of tree.declared ?? []) if (!all.has(d.name)) all.set(d.name, undefined);
  for (const [name, version] of all) {
    const d = isAllowed(p, eco, name) ? undefined : denyEntry(p, eco, name);
    if (d) out.push({ kind: 'deny', name, version, text: `${name}: ${denyMessage(p, d)}` });
  }
  if (!restrictsLicenses) return out;

  const hasDirect = tree.packages.some((pk) => pk.direct);
  const direct: { name: string; version?: string; spec?: string }[] =
    tree.kind === 'lockfile'
      ? tree.packages.filter((pk) => (hasDirect ? pk.direct : true)).map((pk) => ({ name: pk.name, version: pk.version }))
      : (tree.declared ?? []).map((d) => ({ name: d.name, spec: d.spec }));
  const todo = direct.filter((d) => !isAllowed(p, eco, d.name)).slice(0, MAX_LICENSE_LOOKUPS);
  const hits: (PolicyHit | undefined)[] = new Array(todo.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, todo.length) }, async () => {
      while (next < todo.length) {
        const k = next++;
        const d = todo[k];
        try {
          let version = d.version;
          if (!version) {
            const pkg = await getPackage(eco, d.name);
            version = pkg ? pickVersion(eco, d.spec ?? '', pkg.versions) : undefined;
          }
          if (!version) continue;
          const detail = await getVersion(eco, d.name, version);
          if (!detail) continue;
          const l = checkLicenses(p, detail.licenses);
          if (l.message) hits[k] = { kind: l.action === 'deny' ? 'license' : 'note', name: d.name, version, text: `${d.name}@${version}: ${l.message}` };
        } catch (err) {
          hits[k] = { kind: 'note', name: d.name, text: `${d.name}: license not verified (${(err as Error).message}).` };
        }
      }
    }),
  );
  out.push(...hits.filter((h): h is PolicyHit => Boolean(h)));
  if (direct.length > todo.length + direct.filter((d) => isAllowed(p, eco, d.name)).length) {
    out.push({ kind: 'note', text: `Licenses checked for the first ${MAX_LICENSE_LOOKUPS} direct dependencies only.` });
  }
  return out;
}

/** The same findings as lines, for the agent-facing tools. */
export async function treePolicyFindings(p: Policy, tree: ParsedTree): Promise<string[]> {
  return (await treePolicyHits(p, tree)).map((h) => h.text);
}

/** The starter file `safectx init` writes. Comments are allowed; safectx strips them. */
export const STARTER_CONFIG = `{
  // safectx team policy. Versioned with the repo; environment variables override it.
  // Every key is optional; see "Team policy" in the safectx README.

  // Private or vetted packages that skip every check. "*" is a wildcard.
  "allow": [],

  // Packages nobody may add. A string, or { "name", "ecosystem", "reason" }.
  "deny": [
    // { "name": "request", "ecosystem": "npm", "reason": "unmaintained; use undici or fetch" }
  ],

  // SPDX license ids. With "allow", anything not listed is denied. Unknown licenses are noted, not denied.
  "licenses": {
    "deny": ["AGPL-*", "SSPL-*"]
  },

  // Advisories below this severity (low, moderate, high, critical) are notes, not blocks.
  "severityThreshold": "low",

  // Days a release must age before it is recommended; "enforce" blocks unpinned installs inside it.
  "cooldownDays": 3,
  "cooldown": "warn",

  // When no clean version exists: "severity" asks for high/critical and allows the rest; or allow, ask, deny.
  "noFix": "severity",

  // When deps.dev or OSV cannot be reached: allow, ask or deny.
  "onError": "allow"
}
`;
