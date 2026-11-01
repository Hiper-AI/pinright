**Hook latency.** p50 (bar) and p95 (whisker) over 5 runs per case, Windows, Node 24, live services,
log scale; the dashed tick is the budget. A command that installs nothing: 121 / 177 ms, with Node's
own start (`node -e 0`) at 88 ms, so the budget of "150 ms above Node's start" is drawn at 238 ms. One
install with a warm cache: 358 / 372 ms (budget 1 s). One install with a cold cache: 2.4 / 3.7 s
(budget 5 s). The full table, with manifests and workflows, is in `data/latency.csv`.

Source: README, section "Latency" (`scripts/latency.ts`); `data/latency.csv`.
Use: answers "will it slow my agent down?". Files: `fig-f-hook-latency{,-dark}.{svg,png}`.
