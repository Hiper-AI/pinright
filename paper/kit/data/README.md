# Paper kit data

Every number in the report, the figures and the launch copy comes from one of these files. All are
UTF-8 CSV with a header row; empty cells mean "not applicable". Percentages are 0 to 100. Costs are the
API-equivalent at list price that Claude Code reports per transcript (`total_cost_usd`); the runs used
a subscription, so nobody paid them.

## Provenance

| What | Where it came from |
|---|---|
| Code under test (benchmarks) | `lanzamiento` at `b2fcfe2` plus the benchmark-only ablation flag (`PINRIGHT_ABLATION=docs-only`, commit `0e4f2d8`) |
| Report and kit | branch `feat/paperkit` from `lanzamiento` at `99027f5` |
| Agent runs | `bench/agents/runs/v6-sonnet-2026-11-01`, `v6-haiku-2026-11-01`, `v6-opus-2026-11-01` (`scores.json`, `config.json`) |
| Docs runs | `bench/docs/runs/docs-v6-sonnet-2026-11-01`, `docs-v6-haiku-2026-11-01`, `docs-v6-opus-2026-11-01` |
| Probes | `bench/docs/runs/probes-v6/` (`heldout-all.json`, `retrieval.log`), 2026-11-01, cold cache |
| Run date and advisory data | 2026-11-01 (OSV, deps.dev, npm audit, pip-audit as of that day) |
| Agent | Claude Code 2.1.308, headless, Write and Read only; models `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5-5` |

The run directories are gitignored (transcripts and generated projects). They were produced in the
worktree `pinright-bench6` (branch `feat/bench6`, commit `9a1cc2b`). Its three benchmark commits
reached `lanzamiento` as `0e4f2d8`, `32b5c2f` and `99027f5`, on top of the false-positive work.

## Generated from the raw runs

`npx tsx paper/kit/make-data.ts --bench <dir>` rebuilds these six files. `<dir>` is the `bench/`
directory that holds `agents/runs/<stamp>` and `docs/runs/<stamp>`. The script uses the same helpers
as `bench/AGENTS.md`, `bench/DOCS.md` and `bench/RESULTS-v6.md` (`armMetrics`, `docsArmMetrics`, and
the seeded cluster bootstrap in `bench/stats.ts`: 2,000 resamples of tasks, seed 20261101), so the
values match those reports.

### agents_by_model_arm.csv

One row per model and arm (18 rows). Arms: `no-docs`, `docs-only` (pinright with the security layer
off), `pinright` (MCP server), `hook-only`, `pinright+hook`, `latest` (no-pin reference: the no-docs
agent's packages installed without a version, 1 run per task).

| Column | Meaning |
|---|---|
| model, model_id, run_stamp, arm, arm_label, reps | identity |
| runs | agent runs scored (24 per arm and model; 12 for `latest`) |
| runs_with_manifest | runs that wrote a manifest |
| direct_deps | direct dependencies pinned that exist on the registry |
| direct_deps_with_advisory, _pct, _pct_ci95_lo, _pct_ci95_hi | of those, with at least one OSV advisory; interval resamples tasks, pools dependencies |
| direct_deps_cvss7 | with an advisory of CVSS 7 or more |
| direct_deps_nonexistent | pinned name or version that does not exist (0 everywhere) |
| alerts_sum | whole-tree alerts from npm audit / pip-audit, summed over projects |
| alerts_per_project_mean, _ci95_lo, _ci95_hi | mean over resolved projects; interval resamples tasks |
| projects_zero_alerts, projects_resolved | projects with no alert / projects whose tree resolved |
| critical_high_npm | critical plus high alerts in npm projects |
| projects_installed, projects_built, projects_build_conclusive | real install, build or import check; inconclusive builds (a native binary that needs an install script) are left out |
| median_pinned_age_days | median age of the pinned version on 2026-11-01 |
| direct_deps_on_registry_default_pct | share pinned to the registry's default (latest) version |
| cost_per_run_usd_list_price, cost_all_runs_usd_list_price | API-equivalent cost |
| turns_per_run, duration_s_per_run, mcp_calls_per_run, hook_blocks_per_run | means |

### agents_by_task.csv

One row per model, arm, task and repetition (396 rows). Columns as above at run level, plus
`alerts_pinright_check_manifest` (what `check-manifest` reported on the same lockfile), `build_step`
and `build_inconclusive`. `alerts` is empty when the run wrote no manifest.

### docs_by_model_arm.csv

One row per model and arm of the docs benchmark (7 rows; `docs-only` ran for Sonnet only).
`current_api_runs` counts runs that install, build, pass the smoke test (6 of 8 tasks have one), pin
the asked major, use every required new API and no removed or deprecated one; the interval resamples
tasks. `works_runs` drops the API checks. `api_checks_passed_pct` pools every check of every run.
`docs_calls_per_run` counts `get-docs` and `upgrade-guide` calls; `docs_kchars_per_run` is the docs
text they returned.

### docs_by_task.csv

One row per model, arm, task and repetition (112 rows). `required_missing`, `removed_used` and
`deprecated_used` list the failed check ids, space-separated (see `bench/docs/checks.ts`).

### probes.csv

One row per probe set. `before` is the set's first score, on the commit in `before_code`;
`after_round3` the score at the end of the third docs round (`bench/DOCS.md`); `v6_rerun_2026_11_01`
the rerun on the release candidate, computed from `probes-v6/heldout-all.json` (sets in file order:
A 81, B 28, C 45) and the summary line of `retrieval.log` (original set). The `before` and
`after_round3` columns are transcribed from `bench/DOCS.md`.

### probes_heldout_questions.csv

The 154 held-out questions of the rerun: set, library, package and version, question, pass,
answer length, time on a cold cache.

## Transcribed from committed result files

These have no raw data in the repository beyond the result file named.

| File | Source | Notes |
|---|---|---|
| fp_by_source.csv | `bench/fp/RESULTS.md`, "Corpus" and "Rates" | Per-source rates leave out entries with `${{ }}` templating; `scope` says which rows include them. Commits: baseline `lanzamiento` before `feat/fp`; after `feat/fp`; the last two rows on `lanzamiento` at `35c33a4` |
| fp_categories.csv | `bench/fp/RESULTS.md`, "False positives found and fixed" and "What still blocks or asks" | `table` = `fixed` (corpus entries the fix let through) or `remaining` (361 entries still blocked or asked, by cause) |
| latency.csv | README, "Latency" (`scripts/latency.ts`, 5 runs per cell, Windows, Node 24, live services) | `budget_ms` for the first row is Node's start (88 ms) plus 150 ms |
| injection.csv | `bench/injection/RESULTS.md` (2026-10-29) and the headers of `bench/injection/heldout*.ts` | high = dropped, medium = kept with a warning |
| security_findings.csv | `docs/SECURITY-REVIEW.md`, both rounds | round, date, id, severity, area, finding, status, fix commits |

The public-command corpus itself (25,077 entries from 180 repositories) stays outside the repository;
`bench/fp/collect.ts` rebuilds it from GitHub.
