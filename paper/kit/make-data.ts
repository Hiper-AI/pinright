/**
 * Regenerates the benchmark CSVs of the paper kit from the raw v6 runs.
 *
 *   npx tsx paper/kit/make-data.ts [--bench <dir>]
 *
 * `--bench` is the `bench/` directory that holds `agents/runs/<stamp>` and `docs/runs/<stamp>`
 * (gitignored; default: this repository's `bench/`). The numbers go through the same helpers
 * as bench/AGENTS.md, bench/DOCS.md and bench/RESULTS-v6.md (armMetrics, docsArmMetrics, the
 * seeded cluster bootstrap), so the CSVs match those reports to the last digit.
 *
 * Writes paper/kit/data/{agents_by_model_arm,agents_by_task,docs_by_model_arm,docs_by_task,
 * probes,probes_heldout_questions}.csv. The other CSVs in data/ are transcribed from committed
 * result files; data/README.md says which.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { armMetrics, LABEL, modelName } from '../../bench/agents/metrics.js';
import type { RunScore } from '../../bench/agents/score.js';
import { docsArmMetrics, docsCalls } from '../../bench/docs/metrics.js';
import type { DocsRunScore } from '../../bench/docs/score.js';
import { canonicalScores } from '../../bench/legacy.js';
import { bootstrap, mean, sum } from '../../bench/stats.js';

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const root = resolve(import.meta.dirname, '..', '..');
const bench = resolve(opt('bench') ?? join(root, 'bench'));
const out = resolve(opt('out') ?? join(import.meta.dirname, 'data'));

// --agents and --docs pick other runs (comma-separated stamps), e.g. a rerun on the release code.
const AGENT_STAMPS = (opt('agents') ?? 'v6-sonnet-2026-11-01,v6-haiku-2026-11-01,v6-opus-2026-11-01').split(',');
const DOCS_STAMPS = (opt('docs') ?? 'docs-v6-sonnet-2026-11-01,docs-v6-haiku-2026-11-01,docs-v6-opus-2026-11-01').split(',');
const AGENT_ARMS = ['no-docs', 'docs-only', 'pinright', 'hook-only', 'pinright+hook', 'latest'];
const DOCS_ARMS = ['no-docs', 'docs-only', 'pinright'];

type Cell = string | number | boolean | undefined | null;
const fmt = (v: Cell, digits = 4) =>
  v == null || (typeof v === 'number' && !Number.isFinite(v)) ? '' : typeof v === 'number' ? String(Number(v.toFixed(digits))) : String(v);
const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
function csv(name: string, header: string[], rows: Cell[][]) {
  const text = [header.join(','), ...rows.map((r) => r.map((c) => esc(fmt(c))).join(','))].join('\n') + '\n';
  writeFileSync(join(out, name), text);
  console.log(`wrote data/${name} (${rows.length} rows)`);
}

function load<T extends { arm: string; model?: string }>(kind: 'agents' | 'docs', stamp: string) {
  const dir = join(bench, kind, 'runs', stamp);
  if (!existsSync(join(dir, 'scores.json'))) throw new Error(`missing ${join(dir, 'scores.json')}: pass --bench <dir with ${kind}/runs/${stamp}>`);
  const scores = canonicalScores(JSON.parse(readFileSync(join(dir, 'scores.json'), 'utf8'))) as T[];
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  return { stamp, scores, reps: Number(config.reps), model: String(scores.find((s) => s.model)?.model ?? config.model) };
}

// ---------------------------------------------------------------- agent benchmark
const agentRows: Cell[][] = [];
const agentTaskRows: Cell[][] = [];
for (const stamp of AGENT_STAMPS) {
  const run = load<RunScore>('agents', stamp);
  for (const arm of AGENT_ARMS) {
    const rs = run.scores.filter((s) => s.arm === arm);
    if (!rs.length) continue;
    const m = armMetrics(rs);
    // Interval of the share of direct deps with an advisory: tasks resampled, deps pooled.
    const byTask = new Map<string, number[]>();
    for (const r of rs.filter((x) => x.deps.length)) {
      for (const d of r.deps.filter((x) => x.exists === 'yes')) byTask.set(r.task, [...(byTask.get(r.task) ?? []), d.advisories.length ? 1 : 0]);
    }
    const vulnCi = bootstrap([...byTask.values()], mean);
    const agent = arm !== 'latest';
    agentRows.push([
      modelName(run.model), run.model, stamp, arm, LABEL[arm], agent ? run.reps : 1, m.runs, m.withManifest,
      m.realDeps, m.vulnDeps, m.realDeps ? (100 * m.vulnDeps) / m.realDeps : NaN, 100 * vulnCi[0], 100 * vulnCi[1], m.highDeps, m.missingDeps,
      m.alertsSum, m.alertsMean, m.alertsCi[0], m.alertsCi[1], m.zeroAlert, m.resolved, m.critHigh,
      agent ? m.installed : null, agent ? m.built : null, agent ? m.conclusive : null,
      m.medianAge, 100 * m.onDefault,
      agent ? m.costMean : null, agent ? m.costSum : null, agent ? m.turns : null, agent ? m.durationS : null, agent ? m.mcpCalls : null, agent ? m.hookBlocks : null,
    ]);
    for (const r of [...rs].sort((a, b) => a.task.localeCompare(b.task) || a.rep - b.rep)) {
      const real = r.deps.filter((d) => d.exists === 'yes');
      agentTaskRows.push([
        modelName(run.model), stamp, arm, r.task, r.ecosystem, r.rep, r.deps.length > 0, r.deps.length, real.filter((d) => d.advisories.length).length,
        real.filter((d) => (d.maxCvss ?? 0) >= 7).length, r.deps.filter((d) => d.exists !== 'yes').length,
        r.tree?.resolved ?? false, r.tree?.resolved ? (r.tree.alerts ?? 0) : null, r.tree?.critical, r.tree?.high, r.tree?.pinright?.alerts,
        r.build?.installed, r.build?.built, r.build?.step, r.build?.inconclusive ?? false,
        r.costUsd, r.turns, r.durationMs == null ? null : r.durationMs / 1000, sum(Object.values(r.mcpCalls)), r.hookBlocks,
      ]);
    }
  }
}
csv('agents_by_model_arm.csv', [
  'model', 'model_id', 'run_stamp', 'arm', 'arm_label', 'reps', 'runs', 'runs_with_manifest',
  'direct_deps', 'direct_deps_with_advisory', 'direct_deps_with_advisory_pct', 'direct_deps_with_advisory_pct_ci95_lo', 'direct_deps_with_advisory_pct_ci95_hi', 'direct_deps_cvss7', 'direct_deps_nonexistent',
  'alerts_sum', 'alerts_per_project_mean', 'alerts_per_project_ci95_lo', 'alerts_per_project_ci95_hi', 'projects_zero_alerts', 'projects_resolved', 'critical_high_npm',
  'projects_installed', 'projects_built', 'projects_build_conclusive',
  'median_pinned_age_days', 'direct_deps_on_registry_default_pct',
  'cost_per_run_usd_list_price', 'cost_all_runs_usd_list_price', 'turns_per_run', 'duration_s_per_run', 'mcp_calls_per_run', 'hook_blocks_per_run',
], agentRows);
csv('agents_by_task.csv', [
  'model', 'run_stamp', 'arm', 'task', 'ecosystem', 'rep', 'manifest_written', 'direct_deps', 'direct_deps_with_advisory', 'direct_deps_cvss7', 'direct_deps_nonexistent',
  'tree_resolved', 'alerts', 'critical', 'high', 'alerts_pinright_check_manifest',
  'installed', 'built', 'build_step', 'build_inconclusive', 'cost_usd_list_price', 'turns', 'duration_s', 'mcp_calls', 'hook_blocks',
], agentTaskRows);

// ---------------------------------------------------------------- docs benchmark
const docsRows: Cell[][] = [];
const docsTaskRows: Cell[][] = [];
for (const stamp of DOCS_STAMPS) {
  const run = load<DocsRunScore>('docs', stamp);
  for (const arm of DOCS_ARMS) {
    const rs = run.scores.filter((s) => s.arm === arm);
    if (!rs.length) continue;
    const m = docsArmMetrics(rs);
    docsRows.push([
      modelName(run.model), run.model, stamp, arm, LABEL[arm], run.reps, m.runs, m.current, (100 * m.current) / m.runs, 100 * m.currentCi[0], 100 * m.currentCi[1],
      m.works, m.installed, m.built, m.smokeRuns, m.smokePass, m.versionOk, m.requiredOk, m.removed, m.deprecated,
      m.checksAll ? (100 * m.checksPassed) / m.checksAll : NaN, m.costMean, m.costSum, m.turns, m.durationS, m.mcpCalls, m.docsCallsMean, m.docsKChars,
    ]);
    for (const r of [...rs].sort((a, b) => a.task.localeCompare(b.task) || a.rep - b.rep)) {
      const failed = (kind: string) => r.checks.filter((c) => c.kind === kind && !c.pass).map((c) => c.id).join(' ');
      docsTaskRows.push([
        modelName(run.model), stamp, arm, r.task, r.rep, r.current, r.works, r.build?.installed, r.build?.built, r.smoke ? r.smoke.pass : null, r.versionOk,
        failed('required'), failed('removed'), failed('deprecated'), r.costUsd, r.turns, r.durationMs == null ? null : r.durationMs / 1000, r.calls.length, docsCalls(r).length,
      ]);
    }
  }
}
csv('docs_by_model_arm.csv', [
  'model', 'model_id', 'run_stamp', 'arm', 'arm_label', 'reps', 'runs', 'current_api_runs', 'current_api_pct', 'current_api_pct_ci95_lo', 'current_api_pct_ci95_hi',
  'works_runs', 'installed_runs', 'built_runs', 'smoke_runs', 'smoke_pass', 'pinned_asked_major', 'all_required_present', 'runs_using_removed_api', 'runs_using_deprecated_api',
  'api_checks_passed_pct', 'cost_per_run_usd_list_price', 'cost_all_runs_usd_list_price', 'turns_per_run', 'duration_s_per_run', 'mcp_calls_per_run', 'docs_calls_per_run', 'docs_kchars_per_run',
], docsRows);
csv('docs_by_task.csv', [
  'model', 'run_stamp', 'arm', 'task', 'rep', 'current_api', 'works', 'installed', 'built', 'smoke_pass', 'pinned_asked_major',
  'required_missing', 'removed_used', 'deprecated_used', 'cost_usd_list_price', 'turns', 'duration_s', 'mcp_calls', 'docs_calls',
], docsTaskRows);

// ---------------------------------------------------------------- retrieval probes
// heldout-all.json lists set A (81), then B (28), then C (45), in that order (probe-heldout.ts --set all).
const probesDir = resolve(opt('probes') ?? join(bench, 'docs', 'runs', 'probes-v6'));
const heldout = JSON.parse(readFileSync(join(probesDir, 'heldout-all.json'), 'utf8')) as { task: string; name: string; query: string; pass: boolean; chars: number; ms: number }[];
const SIZES: [string, number][] = [['A', 81], ['B', 28], ['C', 45]];
if (heldout.length !== sum(SIZES.map((s) => s[1]))) throw new Error(`heldout-all.json has ${heldout.length} probes, expected 154`);
const setOf = (i: number) => (i < 81 ? 'A' : i < 109 ? 'B' : 'C');
const v6 = Object.fromEntries(SIZES.map(([s]) => [s, heldout.filter((_, i) => setOf(i) === s && heldout[i].pass).length]));
const retrievalLog = readFileSync(join(probesDir, 'retrieval.log'), 'utf8');
const orig = retrievalLog.match(/(\d+) \/ (\d+) probes answered/);
if (!orig) throw new Error('retrieval.log: no summary line');
// "Before" is each set's score on the code it was first scored on, and "after" the end of the third
// docs round (bench/DOCS.md, sections "Retrieval probe", "Held-out probe" and "Third round").
csv('probes.csv', ['set', 'role', 'questions', 'libraries', 'before', 'before_code', 'after_round3', 'v6_rerun_2026_11_01'], [
  ['Original', 'the eight benchmark tasks; tuned on', 25, 8, 16, 'e644213', 24, Number(orig[1])],
  ['Held-out A', 'looked at while tuning (from round 2)', 81, 29, 53, 'dd570aa', 75, v6.A],
  ['Held-out B', 'untouched since round 2', 28, 12, 22, 'dd570aa', 25, v6.B],
  ['Held-out C', 'untouched, written before round 3', 45, 15, 28, 'd2f082a', 33, v6.C],
]);
csv('probes_heldout_questions.csv', ['set', 'library', 'package', 'question', 'pass', 'answer_chars', 'ms_cold_cache'],
  heldout.map((p, i) => [setOf(i), p.task, p.name, p.query, p.pass, p.chars, p.ms]));
