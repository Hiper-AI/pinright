**Direct dependencies pinned with a known advisory, by arm and model.** Share of the direct
dependencies the agent pinned that had at least one OSV advisory when the runs were scored
(2026-11-02 and 2026-11-03), with 95% cluster-bootstrap intervals (tasks resampled, dependencies
pooled). No docs: 40% (Sonnet, 66 of 164), 40% (Haiku, 63 of 157), 42% (Opus, 66 of 159). docs-only:
2% (2 of 125), 2% (3 of 142), 0% (0 of 126). Every pinright arm and the no-pin reference: 0%.

Source: `data/agents_by_model_arm.csv` (`direct_deps_with_advisory_pct` and its interval columns);
`bench/AGENTS.md`.
Use: the "41% vs 0%" stat with its context (docs-only sits at 0 to 2%). Files:
`fig-b-direct-deps-with-advisories{,-dark}.{svg,png}`.
