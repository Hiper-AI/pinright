/**
 * Supply-chain checks of the direct dependencies of a tree, beyond advisories:
 * lookalike names (typosquats), versions or packages the registry does not
 * have, deprecation, and the behavior signals of src/risk. One verdict per
 * direct dependency, the same one the hook and the MCP tools give.
 *
 * Only a typosquat and the two install-script signals the hook denies are
 * blocking. Everything else is reported and never fails a build on its own:
 * a version missing from deps.dev can be a private registry or an index lag.
 */
import { type Ecosystem } from '../ecosystems.js';
import { DENY_SIGNALS } from '../risk/signals.js';
import { isAllowed, type Policy } from '../teamConfig.js';
import { checkPackage } from '../verdict.js';
import { pool } from './audit.js';
import { type TreePackage } from './lockfiles.js';

export type SupplyKind = 'malware' | 'typosquat' | 'unknown-package' | 'unpublished-version' | 'deprecated' | 'risk';

export interface SupplyFinding {
  kind: SupplyKind;
  name: string;
  version: string;
  /** Fails the audit whatever --fail-on says. */
  blocking: boolean;
  /** For SARIF: error, warning or note. */
  level: 'error' | 'warning' | 'note';
  message: string;
  /** Risk signal id ("install-script-new-package"), for kind "risk". */
  signal?: string;
  lookalikeOf?: string;
}

const MAX_CHECKS = 80;

export async function supplyChecks(
  eco: Ecosystem,
  packages: TreePackage[],
  opts: { policy?: Policy; skip?: Set<string>; max?: number } = {},
): Promise<{ findings: SupplyFinding[]; notes: string[] }> {
  const seen = new Set<string>();
  const direct = packages.filter((p) => {
    if (!p.direct || seen.has(p.name) || opts.skip?.has(p.name)) return false;
    seen.add(p.name);
    return !(opts.policy && isAllowed(opts.policy, eco, p.name));
  });
  const max = opts.max ?? MAX_CHECKS;
  const todo = direct.slice(0, max);
  const notes: string[] = [];
  if (direct.length > todo.length) notes.push(`Supply-chain signals checked for the first ${max} of ${direct.length} direct dependencies.`);
  let failed = 0;
  const per = await pool(todo, 6, async (p) => {
    try {
      return toFindings(p, await checkPackage(eco, p.name, p.version));
    } catch {
      failed++;
      return [];
    }
  });
  if (failed) notes.push(`Supply-chain signals could not be checked for ${failed} direct dependenc${failed === 1 ? 'y' : 'ies'}.`);
  return { findings: per.flat(), notes };
}

type Checked = Awaited<ReturnType<typeof checkPackage>>;

export function toFindings(p: TreePackage, v: Checked): SupplyFinding[] {
  const out: SupplyFinding[] = [];
  const base = { name: p.name, version: p.version };
  const r = v.report;
  // OSV's batch already reports malware; deps.dev can still be the first to know (or the batch missed it).
  if (r.verdict === 'malicious' || r.requested?.verdict === 'malicious') {
    out.push({ ...base, kind: 'malware', blocking: true, level: 'error', message: `${p.name}@${p.version} is flagged as MALWARE. Remove it and rotate any secret the machine had access to.` });
    return out;
  }
  if (r.verdict === 'possible-typosquat') {
    const like = v.typo?.lookalikeOf;
    out.push({
      ...base,
      kind: 'typosquat',
      blocking: true,
      level: 'error',
      lookalikeOf: like,
      message: `${p.name} looks like a typosquat${like ? ` of "${like}"` : ''}${r.reason ? `: ${r.reason}` : ''}. Check the name; if ${like ? `"${like}"` : 'the popular package'} was meant, install that instead.`,
    });
    return out;
  }
  if (r.verdict === 'unknown-package' && !r.requested) {
    out.push({
      ...base,
      kind: 'unknown-package',
      blocking: false,
      level: 'warning',
      message: `${p.name} is not in the public ${r.ecosystem} registry (${r.sources[0]}): a hallucinated name someone could register, or a private package. If it is yours, add it to "allow" in .safectx.json.`,
    });
    return out;
  }
  if (r.requested?.verdict === 'unknown-package') {
    out.push({
      ...base,
      kind: 'unpublished-version',
      blocking: false,
      level: 'warning',
      message: `${p.name}@${p.version} is not a published version${r.latestVersion ? ` (latest is ${r.latestVersion})` : ''}: unpublished or yanked from the registry, or not indexed yet. Re-lock to a published version.`,
    });
  }
  if (r.requested?.isDeprecated) {
    out.push({
      ...base,
      kind: 'deprecated',
      blocking: false,
      level: 'note',
      message: `${p.name}@${p.version} is deprecated${r.requested.deprecatedReason ? `: ${r.requested.deprecatedReason.trim().replace(/\.+$/, '')}` : ''}.`,
    });
  }
  for (const s of v.risk?.signals ?? []) {
    if (s.level === 'info') continue;
    const deny = DENY_SIGNALS.has(s.id);
    out.push({
      ...base,
      kind: 'risk',
      signal: s.id,
      blocking: deny,
      level: deny ? 'error' : s.level === 'high' ? 'warning' : 'note',
      message: `${p.name}@${p.version}: ${s.message}`,
    });
  }
  return out;
}
