**Hook false-positive rate by source, before and after fixes.** 25,077 commands and manifest writes
(14,902 distinct) from 180 public repositories, each run through the real hook (`pinright hook
claude`, default policy) in its repository checkout on 2026-11-01. Bars: share blocked or asked,
leaving out entries with GitHub `${{ }}` templating, which an agent never types. Gray: the 1.0.0
release candidate; blue: after the fixes the replay prompted. All entries: 2.22% to 1.44% (1.46% on
top of the second security review). Most of what still asks does so on purpose: versions, packages or
paths in variables, manifests rewritten by `sed`, git sources, other registries. 32 entries are true
positives (known advisories). The corpus is CI and README commands, not agent sessions.

Source: `data/fp_by_source.csv`, `data/fp_categories.csv`; `bench/fp/RESULTS.md`.
Use: answers "will it get in my way?". Files: `fig-e-hook-false-positives{,-dark}.{svg,png}`.
