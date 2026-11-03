**Docs benchmark: runs that wrote the current API.** Eight tasks whose library changed API in its
current major (Next.js 16, Tailwind CSS 4, Zod 4, AI SDK 7, Express 5, ESLint 10, Pydantic 2,
LangChain 1), 2 runs each. A run counts when it installs, builds, passes its smoke test, pins the
asked major, uses every required new API and no removed or deprecated one. Bars: share of runs;
labels: runs; whiskers: 95% intervals (tasks resampled). No docs: 13, 9 and 14 of 16. docs-only: 16,
15 and 16 of 16. pinright: 16 of 16 for every model. Most of the gap is AI SDK 7, newer than the
models, and LangChain 1, where no-docs runs pinned a release that does not import.

Source: `data/docs_by_model_arm.csv`; `bench/DOCS.md`. Runs `docs-v7-{sonnet,haiku,opus}-2026-11-02`.
Use: report Figure 5, the docs claim in the blog. Files: `fig-c-docs-current-api{,-dark}.{svg,png}`.
