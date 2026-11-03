/**
 * Per-arm numbers of a docs-benchmark run, shared by report.ts (bench/DOCS.md) and
 * the cross-model summary (bench/summary.ts).
 */
import { bootstrap, mean, sum } from '../stats.js';
import type { DocsRunScore } from './score.js';
import { ALL_TASKS } from './sets.js';

export const docsCalls = (s: DocsRunScore) => s.calls.filter((c) => /(get|query)-docs|upgrade-guide/.test(c.tool));

export interface DocsArmMetrics {
  runs: number;
  current: number;
  /** 95% cluster-bootstrap interval (tasks resampled) of the current-API rate. */
  currentCi: [number, number];
  works: number;
  installed: number;
  built: number;
  smokeRuns: number;
  smokePass: number;
  versionOk: number;
  requiredOk: number;
  removed: number;
  deprecated: number;
  checksPassed: number;
  checksAll: number;
  costMean: number;
  costSum: number;
  turns: number;
  durationS: number;
  mcpCalls: number;
  docsCallsMean: number;
  docsKChars: number;
}

export function docsArmMetrics(rs: DocsRunScore[]): DocsArmMetrics {
  const fin = (xs: (number | undefined)[]) => xs.filter((x): x is number => Number.isFinite(x));
  const byTask = new Map<string, number[]>();
  for (const r of rs) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r.current ? 1 : 0]);
  const withSmoke = rs.filter((r) => ALL_TASKS.find((t) => t.id === r.task)?.smoke);
  const checks = rs.flatMap((r) => r.checks);
  return {
    runs: rs.length,
    current: rs.filter((r) => r.current).length,
    currentCi: bootstrap([...byTask.values()], mean),
    works: rs.filter((r) => r.works).length,
    installed: rs.filter((r) => r.build?.installed).length,
    built: rs.filter((r) => r.build?.built).length,
    smokeRuns: withSmoke.length,
    smokePass: withSmoke.filter((r) => r.smoke?.pass).length,
    versionOk: rs.filter((r) => r.versionOk).length,
    requiredOk: rs.filter((r) => r.checks.filter((c) => c.kind === 'required').every((c) => c.pass)).length,
    removed: rs.filter((r) => r.checks.some((c) => c.kind === 'removed' && !c.pass)).length,
    deprecated: rs.filter((r) => r.checks.some((c) => c.kind === 'deprecated' && !c.pass)).length,
    checksPassed: checks.filter((c) => c.pass).length,
    checksAll: checks.length,
    costMean: mean(fin(rs.map((r) => r.costUsd))),
    costSum: sum(fin(rs.map((r) => r.costUsd))),
    turns: mean(fin(rs.map((r) => r.turns))),
    durationS: mean(fin(rs.map((r) => (r.durationMs == null ? undefined : r.durationMs / 1000)))),
    mcpCalls: mean(rs.map((r) => r.calls.length)),
    docsCallsMean: mean(rs.map((r) => docsCalls(r).length)),
    docsKChars: mean(rs.map((r) => sum(docsCalls(r).map((c) => c.resultChars)) / 1000)),
  };
}
