/**
 * Per-arm numbers of an agent-benchmark run, shared by report.ts (bench/AGENTS.md)
 * and the cross-model summary (bench/summary.ts).
 */
import { bootstrap, mean, median, sum } from '../stats.js';
import type { RunScore } from './score.js';

export interface ArmMetrics {
  runs: number;
  withManifest: number;
  deps: number;
  realDeps: number;
  vulnDeps: number;
  highDeps: number;
  missingDeps: number;
  resolved: number;
  alerts: number[];
  alertsSum: number;
  alertsMean: number;
  /** 95% cluster-bootstrap interval (tasks resampled) of alerts per project. */
  alertsCi: [number, number];
  zeroAlert: number;
  critHigh: number;
  builds: number;
  installed: number;
  conclusive: number;
  built: number;
  medianAge: number;
  onDefault: number;
  costMean: number;
  costSum: number;
  turns: number;
  durationS: number;
  mcpCalls: number;
  hookBlocks: number;
}

export const isAgentArm = (arm: string) => arm !== 'latest';

export const LABEL: Record<string, string> = {
  'no-docs': 'No docs',
  pinright: 'pinright MCP',
  'hook-only': 'pinright hook only',
  'docs-only': 'docs-only (pinright with the security layer off)',
  'pinright+hook': 'pinright MCP + hook',
  latest: 'No pin (reference)',
};

/** "claude-sonnet-5-5" -> "Sonnet 5.5". */
export const modelName = (id: string) => {
  const m = id.match(/claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
};

export function armMetrics(runs: RunScore[]): ArmMetrics {
  const withManifest = runs.filter((r) => r.deps.length);
  const deps = withManifest.flatMap((r) => r.deps);
  const real = deps.filter((d) => d.exists === 'yes');
  const resolved = withManifest.filter((r) => r.tree?.resolved);
  const alerts = resolved.map((r) => r.tree?.alerts ?? 0);
  const builds = runs.filter((r) => r.build);
  const withCode = builds.filter((r) => r.build?.step !== 'none');
  const conclusive = withCode.filter((r) => !r.build?.inconclusive);
  const byTask = new Map<string, number[]>();
  for (const r of resolved) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r.tree?.alerts ?? 0]);
  const fin = (xs: (number | undefined)[]) => xs.filter((x): x is number => Number.isFinite(x));
  return {
    runs: runs.length,
    withManifest: withManifest.length,
    deps: deps.length,
    realDeps: real.length,
    vulnDeps: real.filter((d) => d.advisories.length).length,
    highDeps: real.filter((d) => (d.maxCvss ?? 0) >= 7).length,
    missingDeps: deps.filter((d) => d.exists !== 'yes').length,
    resolved: resolved.length,
    alerts,
    alertsSum: sum(alerts),
    alertsMean: mean(alerts),
    alertsCi: bootstrap([...byTask.values()], mean),
    zeroAlert: alerts.filter((a) => a === 0).length,
    critHigh: sum(resolved.filter((r) => r.ecosystem === 'npm').map((r) => (r.tree?.critical ?? 0) + (r.tree?.high ?? 0))),
    builds: builds.length,
    installed: builds.filter((r) => r.build?.installed).length,
    conclusive: conclusive.length,
    built: conclusive.filter((r) => r.build?.built).length,
    medianAge: median(fin(real.map((d) => d.ageDays))),
    onDefault: real.length ? real.filter((d) => d.isLatest).length / real.length : NaN,
    costMean: mean(fin(runs.map((r) => r.costUsd))),
    costSum: sum(fin(runs.map((r) => r.costUsd))),
    turns: mean(fin(runs.map((r) => r.turns))),
    durationS: mean(fin(runs.map((r) => (r.durationMs == null ? undefined : r.durationMs / 1000)))),
    mcpCalls: mean(runs.map((r) => sum(Object.values(r.mcpCalls)))),
    hookBlocks: mean(runs.map((r) => r.hookBlocks ?? 0)),
  };
}

/** check-manifest against npm audit / pip-audit on the very same lockfiles. */
export function agreement(scores: RunScore[]) {
  const pairs = scores.filter((s) => s.tree?.resolved && s.tree.pinright && s.tree.auditNames);
  const rows = pairs.map((s) => {
    const A = new Set(s.tree!.auditNames);
    const B = new Set(s.tree!.pinright!.vulnerableNames);
    const union = new Set([...A, ...B]);
    const inter = [...A].filter((x) => B.has(x)).length;
    return { s, jaccard: union.size ? inter / union.size : 1, onlyAudit: [...A].filter((x) => !B.has(x)), onlyOurs: [...B].filter((x) => !A.has(x)) };
  });
  const byEco = (eco: string) => {
    const xs = rows.filter((x) => x.s.ecosystem === eco);
    return {
      lockfiles: xs.length,
      auditAlerts: sum(xs.map((x) => x.s.tree!.alerts ?? 0)),
      oursAlerts: sum(xs.map((x) => x.s.tree!.pinright!.alerts)),
      jaccard: mean(xs.map((x) => x.jaccard)),
      identical: xs.filter((x) => x.jaccard === 1).length,
    };
  };
  const diffs = new Map<string, number>();
  for (const x of rows) {
    for (const n of x.onlyAudit) diffs.set(`only the audit tool: ${n}`, (diffs.get(`only the audit tool: ${n}`) ?? 0) + 1);
    for (const n of x.onlyOurs) diffs.set(`only pinright: ${n}`, (diffs.get(`only pinright: ${n}`) ?? 0) + 1);
  }
  return { npm: byEco('npm'), pypi: byEco('pypi'), diffs: [...diffs.entries()].sort((a, b) => b[1] - a[1]) };
}
