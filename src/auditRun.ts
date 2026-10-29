/**
 * `safectx audit` end to end, shared by the CLI and the GitHub Action: the
 * dependency files and workflows under a path, the team policy, the advisory
 * audit of each tree, the supply-chain checks of the direct dependencies, and
 * the exit code. No MCP imports here: the Action bundle is built from this.
 */
import fs from 'node:fs';
import path from 'node:path';
import { actionsAuditFails, auditActions, formatActionsAudit, type ActionsAudit } from './actions/check.js';
import { parseUses, workflowFiles } from './actions/workflow.js';
import { applyCooldownDays } from './config.js';
import { buildSarif, type SarifLog } from './sarif/build.js';
import { loadTeamConfig, parseTeamConfig, type Policy, type PolicyHit, resolvePolicy, treePolicyHits } from './teamConfig.js';
import { auditTree, formatTreeAudit, type TreeAudit } from './tree/audit.js';
import { manifestsIn, readSiblings } from './tree/discover.js';
import { parseFile, type ParsedTree, type TreePackage } from './tree/lockfiles.js';
import { supplyChecks, type SupplyFinding } from './tree/supply.js';

export const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
/** "none" reports without failing (exit 0) unless the audit itself could not run. */
export type FailOn = (typeof SEVERITIES)[number] | 'none';

export interface AuditOptions {
  target: string;
  /** A .safectx.json to use instead of the nearest one. */
  config?: string;
  /** Typosquat, registry and risk-signal checks of direct dependencies (network, one verdict each). */
  supplyChain?: boolean;
}

export interface FileAudit {
  tree: ParsedTree;
  audit: TreeAudit;
  packages: TreePackage[];
  policy: PolicyHit[];
  supply: SupplyFinding[];
}

export interface AuditRun {
  target: string;
  files: FileAudit[];
  actions?: ActionsAudit;
  policy: Policy;
  /** The .safectx.json exists and cannot be used: the run fails closed. */
  policyError?: string;
  notes: string[];
}

export class AuditInputError extends Error {}

function loadPolicy(target: string, configFile?: string): { policy: Policy; error?: string } {
  let team;
  if (configFile) {
    const file = path.resolve(configFile);
    try {
      team = parseTeamConfig(fs.readFileSync(file, 'utf8'), file);
    } catch (err) {
      team = { file, error: `${file} cannot be read: ${(err as Error).message}` };
    }
  } else {
    const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
    team = loadTeamConfig(dir);
  }
  if (team.error) return { policy: resolvePolicy(undefined, process.env, team.file), error: team.error };
  const policy = resolvePolicy(team.config, process.env, team.file);
  applyCooldownDays(policy.cooldownDays);
  // The Actions check reads SAFECTX_ACTIONS_PIN; the environment still wins over the file.
  if (policy.actionsPin && !process.env.SAFECTX_ACTIONS_PIN) process.env.SAFECTX_ACTIONS_PIN = policy.actionsPin;
  return { policy };
}

export async function runAudit(opts: AuditOptions): Promise<AuditRun> {
  const target = path.resolve(opts.target);
  if (!fs.existsSync(target)) throw new AuditInputError(`${target} does not exist`);
  const wf = workflowFiles(target);
  const files = fs.statSync(target).isDirectory() ? manifestsIn(target) : wf.length ? [] : [target];
  if (!files.length && !wf.length) throw new AuditInputError(`No supported lockfile, manifest or workflow in ${target}`);
  const { policy, error } = loadPolicy(target, opts.config);

  const out: FileAudit[] = [];
  const notes: string[] = [];
  for (const f of files) {
    const tree = parseFile(f, fs.readFileSync(f, 'utf8'), readSiblings(f));
    const packages: TreePackage[] = [];
    const audit = await auditTree(tree, { packagesOut: packages });
    const policyHits = await treePolicyHits(policy, tree).catch((err) => [{ kind: 'note' as const, text: `Policy not checked: ${(err as Error).message}` }]);
    let supply: SupplyFinding[] = [];
    if (opts.supplyChain !== false) {
      // Malware is already reported; its verdict would only repeat it.
      const skip = new Set(audit.findings.filter((x) => x.malicious).map((x) => x.name));
      const s = await supplyChecks(tree.ecosystem, packages, { policy, skip });
      supply = s.findings;
      audit.notes.push(...s.notes);
    }
    out.push({ tree, audit, packages, policy: policyHits, supply });
  }
  const actions = wf.length ? await auditActions(wf.map((f) => ({ file: f, uses: parseUses(fs.readFileSync(f, 'utf8'), f) }))) : undefined;
  return { target, files: out, actions, policy, policyError: error, notes };
}

/** 1 when something at or above `failOn` was found, or anything the policy or the supply checks block. */
export function auditExitCode(run: AuditRun, failOn: FailOn): number {
  if (run.policyError) return 1;
  if (failOn === 'none') return 0;
  const floor = SEVERITIES.indexOf(failOn);
  const levels = SEVERITIES as readonly string[];
  const bad = run.files.some(
    (f) =>
      f.audit.malicious > 0 ||
      levels.slice(floor).some((s) => f.audit.bySeverity[s as keyof TreeAudit['bySeverity']] > 0) ||
      (floor === 0 && f.audit.bySeverity.unknown > 0) ||
      f.policy.some((h) => h.kind === 'deny' || h.kind === 'license') ||
      f.supply.some((s) => s.blocking),
  );
  return bad || (run.actions && actionsAuditFails(run.actions, floor, [...levels])) ? 1 : 0;
}

export function parseFailOn(v: string | undefined): FailOn | undefined {
  const s = (v ?? 'low').trim().toLowerCase();
  if (s === 'medium') return 'moderate';
  return s === 'none' || (SEVERITIES as readonly string[]).includes(s) ? (s as FailOn) : undefined;
}

export function formatAuditRun(run: AuditRun, maxFindings = 50): string {
  const parts: string[] = [];
  if (run.policyError) parts.push(`POLICY ERROR: ${run.policyError} Dependency changes are blocked until the file is fixed.`);
  for (const f of run.files) {
    const lines = [formatTreeAudit(f.audit, maxFindings)];
    if (f.policy.length) {
      lines.push(`Project policy (${run.policy.file ? path.basename(run.policy.file) : 'env'}):`, ...f.policy.map((h) => `  - ${h.text}`));
    }
    if (f.supply.length) {
      lines.push('Supply chain (direct dependencies):', ...f.supply.slice(0, maxFindings).map((s) => `  - [${s.blocking ? 'block' : s.level}] ${s.message}`));
      if (f.supply.length > maxFindings) lines.push(`  - ... and ${f.supply.length - maxFindings} more`);
    }
    parts.push(lines.join('\n'));
  }
  if (run.actions) parts.push(formatActionsAudit(run.actions, maxFindings));
  return parts.join('\n\n');
}

/** The JSON the CLI prints: the tree audits as before, with policy and supply-chain findings when there are any. */
export function auditJson(run: AuditRun): unknown[] {
  const trees = run.files.map((f) => ({
    ...f.audit,
    ...(f.policy.length ? { policy: f.policy } : {}),
    ...(f.supply.length ? { supplyChain: f.supply } : {}),
  }));
  return [...trees, ...(run.actions ? [{ actions: run.actions }] : []), ...(run.policyError ? [{ policyError: run.policyError }] : [])];
}

/**
 * The directory SARIF paths are relative to: GITHUB_WORKSPACE when the target
 * is inside it, else the enclosing git repository, else the audited directory.
 */
export function sarifRoot(target: string, explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const abs = path.resolve(target);
  const inside = (dir: string) => {
    const rel = path.relative(dir, abs);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const ws = process.env.GITHUB_WORKSPACE ? path.resolve(process.env.GITHUB_WORKSPACE) : undefined;
  if (ws && inside(ws)) return ws;
  const start = fs.existsSync(abs) && !fs.statSync(abs).isDirectory() ? path.dirname(abs) : abs;
  for (let cur = start; ; ) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return start;
    cur = up;
  }
}

export function runToSarif(run: AuditRun, opts: { root: string; toolVersion: string }): SarifLog {
  return buildSarif({
    root: opts.root,
    toolVersion: opts.toolVersion,
    trees: run.files.map((f) => ({ audit: f.audit, packages: f.packages, policy: f.policy, supply: f.supply })),
    actions: run.actions,
    notes: [...(run.policyError ? [`Policy error: ${run.policyError}`] : []), ...run.files.flatMap((f) => f.audit.notes), ...(run.actions?.notes ?? [])],
    read: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
  });
}
