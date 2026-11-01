**Direct dependencies pinned with a known advisory, by arm and model.** Share of the direct
dependencies the agent pinned that had at least one OSV advisory on 2026-11-01, with 95%
cluster-bootstrap intervals (tasks resampled, dependencies pooled). No docs: 42% (Sonnet, 66 of 157),
40% (Haiku, 63 of 157), 41% (Opus, 65 of 157). docs-only: 1% (1 of 120), 2% (2 of 127), 0% (0 of
126). Every pinright arm and the no-pin reference: 0%.

Source: `data/agents_by_model_arm.csv` (`direct_deps_with_advisory_pct` and its interval columns);
`bench/AGENTS.md`.
Use: the "41% vs 0%" stat with its context (docs-only sits at 0 to 2%). Files:
`fig-b-direct-deps-with-advisories{,-dark}.{svg,png}`.
