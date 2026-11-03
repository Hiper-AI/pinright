**Tokens per run, by arm and model.** Thousands of tokens the model processed per run (uncached
input, cache reads, cache writes and output), read from the usage record Claude Code prices each run
from. Left: the agent benchmark (12 tasks x 2 runs). Right: the docs benchmark (8 tasks x 2 runs).
Whiskers: 95% cluster-bootstrap intervals that resample tasks. Paired by task, pinright used 24%,
21% and 26% fewer tokens than the docs-only ablation in the agent benchmark and 33%, 30% and 26% fewer
in the docs benchmark (Sonnet, Haiku, Opus). The per-arm intervals overlap in five of the six pairs.
No docs used the fewest tokens in every cell. The docs-only arm is pinright with its security layer
off, not another product.

Source: `data/tokens_by_model_arm.csv` (`ktokens_total_per_run`, `_ci95_lo`, `_ci95_hi`,
`tokens_saved_vs_docs_only_pct`), from runs `v7-{sonnet,haiku,opus}-2026-11-02` and
`docs-v7-{sonnet,haiku,opus}-2026-11-02` on the 1.0.0 code; `bench/tokens.ts`; `bench/RESULTS-v7.md`,
"Efficiency against the docs-only server".
Use: report Figure 4, the efficiency section of the evidence page. Files: `fig-i-tokens-per-run{,-dark}.{svg,png}`.
