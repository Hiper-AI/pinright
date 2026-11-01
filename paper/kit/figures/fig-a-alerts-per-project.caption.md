**Whole-tree alerts per project, by arm and model.** Mean number of `npm audit` / `pip-audit` alerts
per generated project (12 tasks x 2 runs per arm and model; the no-pin reference has 1 run per task).
Whiskers: 95% cluster-bootstrap intervals that resample tasks. Left: all arms on a 0 to 50 scale.
Right: the same data without the no-docs arm, on a 0 to 6 scale. Without tools each model averaged
30 to 33 alerts per project. The docs-only ablation (pinright with its security layer off) averaged
2.0, 0.9 and 0.3; the full pinright server 0.3 for every model, the same as installing the packages
without a version. The 0.3 left in the MCP arms is in nuxt's dependencies, which have no fixed
release; the hook-only arm adds `next` 15.5.28's `postcss`.

Source: `data/agents_by_model_arm.csv` (`alerts_per_project_mean`, `_ci95_lo`, `_ci95_hi`), from runs
`v6-{sonnet,haiku,opus}-2026-11-01`; `bench/RESULTS-v6.md`.
Use: the headline chart (report Figure 3, blog, landing). Files: `fig-a-alerts-per-project{,-dark}.{svg,png}`.
