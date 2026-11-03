# Claims and their sources

Every number and factual claim in the report, the blog post, the launch copy, the README and the
landing page, with the file (and section) or command that backs it. "CSV" means a file in
`paper/kit/data/`. Run stamps: agent runs `v7-{sonnet,haiku,opus}-2026-11-02`, docs runs
`docs-v7-{sonnet,haiku,opus}-2026-11-02`, both on 2026-11-02 and 2026-11-03 at `8efc4f0` (the 1.0.0
`src/`); probes `probes-v6`, 2026-11-01 on `b2fcfe2`. The v6 values these rows replaced are in
`bench/RESULTS-v6.md` and in git history.

Regenerate the benchmark CSVs:
`npx tsx paper/kit/make-data.ts --agents v7-sonnet-2026-11-02,v7-haiku-2026-11-02,v7-opus-2026-11-02 --docs docs-v7-sonnet-2026-11-02,docs-v7-haiku-2026-11-02,docs-v7-opus-2026-11-02 --probes <probes-v6 dir>`.
Regenerate the figures: `npx tsx paper/kit/make-figures.ts`. Regenerate the CLI renders:
`npm run build && npx tsx paper/kit/render-cli.ts --project <dir>`.

## 1. Corrected on this branch

| Where | Was | Now | Why |
|---|---|---|---|
| README, intro | "Coding agents pin versions from memory, or from whatever version a docs index saw last. Both are often months old" | "Coding agents pin versions from memory. Those versions are often months old" | The data does not support it. In the docs-only ablation, a docs tool that documents the latest release moved agents to current versions (v7: 85% to 93% of direct deps on the registry default) and cut alerts by 89% to 99% (`agents_by_model_arm.csv`; v6: 90% to 94% and 94% to 99%). We never measured a docs index. |
| README, CLI exit codes | "`pinright hook` always exits 0 ... It exits 1 only if it crashes" | decision on stdout with exit 0; Windsurf blocks with exit 2; an error while deciding asks; non-JSON input exits 1 | `src/hook/run.ts` (`runHook`, `hookAnswer`): non-JSON input returns 1, Windsurf blocks with code 2; `docs/SECURITY-REVIEW.md` round 2, residual 3 |
| README, Benchmark | "docs-only ... Its docs keep agents on recent versions, yet Sonnet and Haiku still pinned a vulnerable `next` and a `next-auth` beta there." | adds that steering to current versions already removes most alerts and that the runs cost more | `bench/AGENTS.md`, "Failure diagnoses"; `agents_by_model_arm.csv` (cost, turns, MCP calls) |
| Report draft | "pinright 0.2.0"; v5 Sonnet-only numbers; section "1.2 Docs alone do not change the version" | 1.0.0; v6 three-model numbers; section 1.2 "What changes the version" states that steering removes most alerts | `package.json` version; `bench/RESULTS-v6.md` |
| Report draft, 3.3 | "The hook process always exits 0 with its decision on stdout" | exit codes as in the README fix | `src/hook/run.ts` |
| Report draft, 4.5; blog; launch copy | "49 vectors" | 57 | `docs/HOOK-THREAT-MODEL.md`, vector table: 57 rows (review 2 and the false-positive replay added rows) |
| Report draft, 3.1 | "A name one edit away ... is a lookalike" | one edit; two for names of 7+ characters near the 1,000 most popular; established packages with 50,000+ weekly downloads pass | `src/typosquat.ts` (`HEAD`, `TWO_EDITS_MIN_LENGTH`), `src/verdict.ts` (`OWN_AUDIENCE`) |
| Blog draft, launch copy | v5 numbers only (41%, 678 to 6/10/2 alerts, "0.03 to 0.05", 12/16) | v6 numbers for three models, the docs-only ablation, the residual nuxt alerts | `bench/RESULTS-v6.md` |
| Blog draft | "Most remaining alerts come from Next.js 15.5.28" | in the MCP arms the remaining 6 are nuxt's; `next` 15.5.28's `postcss` is the hook-only remainder | `bench/AGENTS.md`, "Failure diagnoses" |
| Every surface (README, site, docs, report, kit) | v6 numbers (2026-11-01, pre-release `b2fcfe2`) and the caveat that the run predates the release by 28 source files | v7 numbers (2026-11-02 and 2026-11-03, `8efc4f0`, the 1.0.0 `src/`); the caveat now names the two hook commits after v7 and the scorer fixes | `bench/RESULTS-v7.md`; `git diff --stat 093175b 8efc4f0 -- src` is empty |
| `bench/agents/score.ts` | a failed deps.dev lookup scored as "version does not exist"; an empty `pip-audit` answer as a clean tree | both retried, then the run fails; 34 v7 runs rescored | `bench/AGENTS.md`, "Scoring fixes" |
| `paper/build-pdf.mjs` | rendered with `md-to-pdf@5.2.4` | `md-to-pdf@5.2.5` | pinright's own hook denied `npx md-to-pdf@5.2.4` while building this kit: CVE-2025-65108, critical (`pinright check npm md-to-pdf@5.2.5` is clean) |

## 2. Landing page (repository `website`, branch `feat/pinright`, `client/src/pages/product/Pinright.tsx`)

Not changed here; these are the edits it needs.

| Current text | Problem | Proposed |
|---|---|---|
| Stat "41%" / "0%" with "of the direct dependencies the agent pinned had a known advisory, without pinright" / "with pinright, through the MCP server, the hook, or both." | Still true in v7 (40% to 42% per model; 0% in every pinright arm), but it hides the ablation: docs alone got 0% to 2%. Read on its own it credits the whole drop to the verdict. | Keep the pair as "40 to 42%" and "0%", and add a third line: "Docs for the current release alone got most of the way: 0 to 2%. The verdict closed the rest." Or switch the headline to alerts per project: "about 30" vs "0.3". Source: `agents_by_model_arm.csv`. |
| method: "Our benchmark, v5, run on 2026-10-29: Claude Code on 12 coding tasks ... 2 runs per arm." (EN and ES) | Stale run and model count | "Our benchmark, v7, run on 2026-11-02 on the 1.0.0 code: Claude Code with Sonnet 5.5, Haiku 5.5 and Opus 5.5 on 12 coding tasks that ask for pinned versions, 2 runs per arm. We audited each project with npm audit or pip-audit, which share no code with pinright." ES: "Nuestro benchmark, v7, corrido el 2026-11-02 sobre el código de la 1.0.0: Claude Code con Sonnet 5.5, Haiku 5.5 y Opus 5.5 en 12 tareas ..." |
| caveat: "These numbers come from one model, one day and tasks we wrote." | Now three models from one vendor | "These numbers come from three models of one vendor, two days of advisory data and tasks we wrote." ES: "Estos números salen de tres modelos de un mismo proveedor, dos días de datos y tareas que escribimos nosotros." |
| `REPORT = ${REPO}/blob/main/bench/AGENTS.md` (TODO(pinright-launch)) | The report now exists | Point at `${REPO}/blob/main/paper/kit/pinright-report.pdf` (or the release asset), keep `bench/RESULTS-v7.md` as the data link |
| Commit message of `dba5b3f` says "el número del benchmark v5 (41% contra 0%...)" | History only | No change needed; mention v7 in the next commit |

Everything else on the page checked out against the code: the lodash block message (identical to
`visuals/cli/hook-block.txt`), the six hook clients, the ten MCP-only clients, "If deps.dev or OSV does
not answer, the verdict is unknown, never ok" (`src/verdict.ts`), "no install scripts"
(`package.json`), "GITHUB_TOKEN ... goes only to api.github.com" (`src/github.ts`, SECURITY.md), the
list of hosts in the privacy table (network diagram in `docs/how-it-works.md`).

## 3. Agent benchmark (report 5.1, 5.2; blog; one-pager; README "Benchmark"; social; press)

| Claim | Value | Source |
|---|---|---|
| Direct deps with an advisory, no docs | Sonnet 66/164 (40%), Haiku 63/157 (40%), Opus 66/159 (42%) | `agents_by_model_arm.csv` `direct_deps_with_advisory*`; `bench/AGENTS.md` |
| "~41%" (site stat) | pooled 195/480 = 40.6%; per model 40.2%, 40.1%, 41.5% | same CSV, summed |
| 95% CI of that share | [29, 50], [30, 49], [32, 50] | same CSV, `_pct_ci95_*` (computed by `make-data.ts`, not in `bench/`) |
| Whole-tree alerts, no docs | 766, 715, 732; per project 31.9, 29.8, 30.5 | `alerts_sum`, `alerts_per_project_mean`; `bench/RESULTS-v7.md` |
| "projects averaged 30 to 32 alerts", "~30" | 29.8 to 31.9, rounded | same |
| Critical + high (npm), no docs | 178, 164, 170 | `critical_high_npm` |
| "Four of 72 projects came out clean" (no docs) | 0 + 2 + 2 | `projects_zero_alerts` |
| Median pinned age, no docs | 717, 607, 686 days ("607 to 717") | `median_pinned_age_days` |
| docs-only alerts | 84, 63, 6; per project 3.5, 2.6, 0.3 | CSV rows `docs-only` |
| docs-only direct deps with an advisory | 2/125, 3/142, 0/126 ("0% to 2%") | same |
| "cut alerts by 89% to 99%" (docs-only vs no docs) | 1 - 84/766 = 89.0%, 1 - 63/715 = 91.2%, 1 - 6/732 = 99.2% | computed from `alerts_sum` |
| docs-only on registry default | 85%, 86%, 93% (no docs 10%, 11%, 11%) | `direct_deps_on_registry_default_pct` |
| docs-only cost and effort vs MCP | turns 9.3/11.1/9.9 vs 5.9/7.5/6.8; MCP calls 5.3/7.0/5.7 vs 1.9/3.4/2.5; cost per run 1.76x, 1.53x, 1.69x ("1.5x to 1.8x") | `turns_per_run`, `mcp_calls_per_run`, `cost_per_run_usd_list_price` |
| docs-only failures | Sonnet `next@15.5.0` (32 advisories) in both next-auth runs, 39 alerts and 21 critical or high each; Haiku `next@15.5.4` + `next-auth@5.0.0-beta.25` (50 alerts) and `next-auth@5.0.0-beta.31` (7 alerts) | `bench/AGENTS.md`, "Vulnerable or non-existent direct pins" and "Failure diagnoses"; `agents_by_task.csv` |
| pinright MCP alerts | 6, 6, 6; 0 vulnerable direct deps | CSV rows `pinright` |
| MCP + hook | 6, 6, 6; 0 | rows `pinright+hook` |
| Hook only | 14, 14, 14; 0 vulnerable direct deps; 0.58, 0.61, 0.58 per project | rows `hook-only` |
| "the remaining 6 are nuxt's", "3 per run", no-pin gets the same | `nuxt` 4.6.3 pulls `deepmerge`, `glob`, `minimatch` with no fixed release | `bench/AGENTS.md`, "Failure diagnoses"; per-task table (nuxt-app 3.0 in every pinright arm and in No pin) |
| Hook-only remainder | `next` 15.5.28 pulls `postcss`; 4 alerts (2 high) per next-auth run | `bench/AGENTS.md`, "Hook only" |
| Hook-only pin age | median 391 to 398 days against 34 to 39 in the MCP arms | `median_pinned_age_days` |
| Security layer removes the rest: Sonnet 84 to 6, Haiku 63 to 6, Opus 6 to 6 | | rows `docs-only` vs `pinright` |
| Builds in pinright arms | 4 of 214 runs with a manifest failed (Sonnet next-auth r2 and Haiku mcp-server-ts r2, each in both MCP arms) | `projects_built` / `projects_build_conclusive` for the three pinright arms; `bench/AGENTS.md` "Runs without a manifest or that do not build" |
| Projects that build, MCP | 23/24, 23/24, 24/24 | same |
| Cost per run, no docs / MCP | 0.033/0.050, 0.003/0.006, 0.074/0.126 USD (API-equivalent, list price) | `cost_per_run_usd_list_price` |
| "1.5 to 2 times the cost", "2 to 4 more turns" (one-pager, evidence page) | agents 1.49x to 1.77x, docs 1.90x to 2.06x; turns +1.8 to +3.9 | both `*_by_model_arm.csv` |
| Agreement with npm audit / pip-audit | 264 lockfiles, Jaccard 0.96, 236 identical; 130, 1.00, 130; `nuxt` and `@nuxt/nitro-server` differ (27 each) and one `multer` | `bench/RESULTS-v7.md`, "check-manifest vs npm audit"; `bench/agents/metrics.ts` `agreement` |
| "394 lockfiles" | 264 + 130 | same |
| Example pins | `axios@1.7.9` (33), `pillow@11.0.0` (86), `pyjwt@2.10.1` (32), `next@15.1.6` (36) | `bench/AGENTS.md` vulnerable-pin lists (no-docs arms) |
| No arm pinned a nonexistent package or version | 0 everywhere, after the rescore | `direct_deps_nonexistent`; `bench/AGENTS.md` "Scoring fixes" |
| 360 agent runs; 504 runs and USD 35.10 in total | 5 arms x 24 x 3; 360 + 144 docs runs (3 arms x 16 x 3) | `bench/RESULTS-v7.md`, cost table |
| v6 to v7, alerts per project | no docs 33.1/29.6/29.9 to 31.9/29.8/30.5; MCP 0.25 in both; docs-only 2.0/0.88/0.25 to 3.5/2.6/0.25 | `bench/RESULTS-v6.md` and `bench/RESULTS-v7.md` tables; `git show 0b8d229^:paper/kit/data/agents_by_model_arm.csv` |
| Scorer fixes moved | Sonnet docs-only 0 to 2 vulnerable direct deps; Sonnet no-docs 66/160 to 66/164; Haiku no-docs 701 to 715 alerts | `bench/AGENTS.md`, "Scoring fixes"; commits `d038934`, `b8af24d`, `8846ff0` |
| Claude Code 2.1.308, Write and Read only | | `bench/AGENTS.md` intro |
| Shell arm: 216 runs (3 models x 3 arms x 12 tasks x 2), Bash in a disposable container; every arm 6 whole-tree alerts per model (latest nuxt tree, both nuxt-app runs), 0 direct deps with an advisory | "every arm ended at the same 6 alerts" (site, README, docs/benchmark.md, RESULTS-v7) | `bench/RESULTS-shell.md`, results table and "What we saw" |
| Shell arm: without the MCP server the agent ran `npm view` / `pip index versions` before pinning in every run; with it in 1, 3 and 5 of 24 (Sonnet, Haiku, Opus) | "looked versions up themselves" | `bench/RESULTS-shell.md`, "What we saw" |
| Shell arm hook: 897 tool calls, 28 denies and 20 asks; 13 false positives on `npm install && npx tsc`, 13 on `jsonpointer==3.8` missing from deps.dev; hook-only runs 15% to 21% longer than no docs | evidence page, shell section | `bench/RESULTS-shell.md`, "Hook events" |

## 4. Docs benchmark and probes (report 5.3, 5.4)

| Claim | Value | Source |
|---|---|---|
| Current API, no docs | 13/16, 9/16, 14/16 (81% [56, 100], 56% [25, 88], 88% [63, 100]); "9 to 14 of 16" | `docs_by_model_arm.csv`; `bench/DOCS.md` |
| Current API, pinright | 16/16 for each model | same |
| docs-only (all three models in v7) | 16/16, 15/16 (94% [81, 100]), 16/16; Haiku lost one AI SDK run that failed to build | same; `bench/DOCS.md` "Where the runs fail (v7)" |
| Cost per run docs, no docs / pinright | 0.044/0.084, 0.004/0.007, 0.099/0.195 ("roughly doubled": 1.90x, 2.06x, 1.98x) | `cost_per_run_usd_list_price` |
| AI SDK 7 released 2026-06-25; all 6 no-docs runs wrote 5/6 code; 4 of them failed to install or build | | `bench/DOCS.md`; `docs_by_task.csv` |
| LangChain: 3 of 6 no-docs runs fail the import check (Sonnet r2 on 1.2.0, Haiku twice on 1.0.3); pinright pinned 1.4.7 | | `bench/DOCS.md`; `docs_by_task.csv` |
| Haiku no docs also lost ESLint 10 (2 runs) and Pydantic 2 (1 run) | | `bench/DOCS.md` "Where the runs fail (v7)" |
| Fully current no-docs tasks: Sonnet 6, Haiku 4, Opus 7 of 8 ("four to seven", report 6) | | `bench/DOCS.md` per-task tables |
| v6 docs values | no docs 13, 10, 12 of 16; Sonnet docs-only 15 of 16 | `bench/RESULTS-v6.md` |
| Post-cutoff set: 2/48 no docs, 46/48 pinright, 45/48 docs-only | | `bench/RESULTS-post-cutoff.md`, "Result" |
| Probes 24/25; 133/154 (A 75/81, B 25/28, C 33/45), run on `b2fcfe2`, not rerun for v7 | | `probes.csv` (from `probes-v6/heldout-all.json`, `retrieval.log`) |
| Probe "before" values 16, 53, 22, 28 | | `bench/DOCS.md` (rounds 1 to 3); `probes.csv` `before` |

## 5. Hook false positives (report 5.5; blog; social)

| Claim | Value | Source |
|---|---|---|
| Corpus | 25,077 entries, 14,902 distinct, 180 repositories (174 with something to extract) | `bench/fp/RESULTS.md`, "Corpus"; `fp_by_source.csv` |
| Blocked or asked | 2.22% to 1.44% (1.46% on top of review 2); without templating 1.92% to 1.16%; denied 0.42% to 0.13% | "Rates"; `fp_by_source.csv` |
| Per source | see `fp_by_source.csv` (README lines 0.61% after) | "Rates" |
| Root causes fixed, remaining causes, 32 true positives | | "False positives found and fixed", "What still blocks or asks"; `fp_categories.csv` |
| `npm install -g pnpm@8`: 26 advisories in a public workflow | microsoft/playwright | "True positives" |
| Real-session replay: 156,977 tool calls, 154,402 cases, one user, 2026-10-02 to 2026-11-02 | | `bench/fp/RESULTS.md`, "Real agent sessions", "Corpus" |
| Real-session replay: asked or blocked 0.46% before and after the fixes; after: 52 true positives, 79 by design, 10 false positives (0.006% of cases, 22 before), 568 replay artifacts | "10 misreads in 154,402 tool calls" (site, README, blog) | same, "Rates" and "Adjudication" |
| Real-tasks set (GitHub issues): no docs 26% to 29% vulnerable direct pins, 504 to 600 alerts per model; MCP 0 and 114 to 116 (112 from `stirrup-gdpval`) | scored before the v7 scorer fixes; its run data shows the same misses only in no-docs runs | `bench/RESULTS-real-issues.md`, "Headline"; run dirs in the `pinright-real-tasks` worktree |

## 6. Security of the tool (report 4; blog; Show HN)

| Claim | Source |
|---|---|
| Round 1: 11 findings (5 high, 5 medium, 1 low), all fixed; 759 regex literals timed on about 900 inputs | `docs/SECURITY-REVIEW.md`, first round; `security_findings.csv` |
| Round 2: 13 findings (1 high, 9 medium, 3 low), all fixed; about 120 hook red-team cases; 51 commits, about 7,000 lines | `docs/SECURITY-REVIEW.md`, "Second round" |
| "24 findings, all fixed" | 11 + 13; `security_findings.csv` |
| Open items after round 2 (self-hosted release runner, hook reader gaps, malformed input exits 1, round-1 residuals) | "Residual risks and recommendations", both rounds |
| 57 hook vectors, each reproduced in `test/hookBypass.test.ts` | `docs/HOOK-THREAT-MODEL.md`, vector table |
| Injection: 4 of 38,381 sections dropped (0.01%), 26 warned; 61/61 corpus, 0/41 negatives; held-out 5/20, 6/15, 3/15, 0/35 benign | `bench/injection/RESULTS.md`; headers of `bench/injection/heldout*.ts`; `injection.csv` |
| "caught 20% to 40%" | 3/15 = 20%, 6/15 = 40% (5/20 = 25%) | same |
| Unit tests: 983 pass, 10 skipped (54 files) | `npx vitest run` on `release` after the launch-review commits, 2026-11-02, Windows; the skipped ones are POSIX-only (symlinks, FIFO) and run in the Linux CI |

## 6b. Caveats added in the launch review (2026-11-02)

| Claim | Value | Source |
|---|---|---|
| v6 ran on a pre-release commit; 28 files under `src/` changed before 1.0.0 (history) | `git diff --stat b2fcfe2 093175b -- src`: 28 files, +1033/-143 (hook readers, `verdict.ts`, `typosquat.ts`, `tree/audit.ts`) | the release branch |
| v7 ran on the 1.0.0 `src/` | v7 `config.json` `startedAt` 2026-11-03T01:37Z to 05:31Z, last `scores.json` written 06:13Z; `release` HEAD then was `8efc4f0` (later commits up to `aac2bfd` touch only the site); `git diff 093175b 8efc4f0 -- src` is empty | `git log --format='%h %cI'`, run dirs (not committed) |
| Hook commits after v7 | `6837139`, `699770d` (06:14Z), `src/hook/command.ts` only | `git log -- src` |
| "Direct deps with advisories" is scored through pinright's own deps.dev client | `bench/agents/score.ts` imports `src/advisories/depsdev.js`; `metrics.ts` `vulnDeps` | code |
| The no-pin reference also gets 0.3 alerts per project | `latest` rows in `agents_by_model_arm.csv` | CSV |
| docs-only vs MCP intervals overlap for every model (alerts per project) | Sonnet [0.0, 10.0] vs [0.0, 0.75]; Haiku [0.0, 7.63] vs [0.0, 0.75]; Opus [0.0, 0.75] vs [0.0, 0.75] | `agents_by_model_arm.csv` `alerts_per_project_ci95_*`; `bench/RESULTS-v7.md`, agent table |
| docs-only vs MCP, direct-dep share | Sonnet [0, 5.5] vs [0, 0]; Haiku [0, 6.9] vs [0, 0]; Opus [0, 0] vs [0, 0]: overlap at 0 | `direct_deps_with_advisory_pct_ci95_*` |
| "four of its 72 agent runs" in docs-only pinned a vulnerable next or next-auth | Sonnet `next@15.5.0` x2, Haiku next-auth r1 and r2 (betas, one with `next@15.5.4`) | `bench/AGENTS.md`, "Failure diagnoses" |
| Docs benchmark: no-docs intervals for Sonnet and Opus overlap 16 of 16 | 81% [56, 100], 88% [63, 100]; Haiku 56% [25, 88] | `docs_by_model_arm.csv` |
| Wilson interval for 16 of 16 | [81%, 100%] (z = 1.96) | computed |
| The models already knew four of the eight docs APIs on every model | Next 16, Tailwind 4, Zod 4, Express 5 | `bench/DOCS.md` per-task tables |
| LangChain no-docs failures are version pins (1.0.3 or 1.2.0), not API | `bench/DOCS.md`, "Where the runs fail (v7)" | same |
| Concordance: 183 of 264 npm and 106 of 130 PyPI lockfiles are clean on both sides; 28 npm differ (27 nuxt, 1 `multer`) | counted from `scores.json` of the three v7 runs (`tree.auditNames` vs `tree.pinright.vulnerableNames`) | run data (not committed) |
| Every prompt carries the docs hint, in every arm | `bench/agents/tasks.ts` `DOCS_HINT`; `bench/docs/tasks.ts` `DOCS_HINT` | code |
| The false-positive corpus is the tuning corpus (no held-out set) | `bench/fp/RESULTS.md`, "False positives found and fixed" | same |
| No published cutoff dates for the models | Anthropic's model pages give none; "newer than the models" is an inference | external |
| Public rate for the hook: 1.46% (release), not 1.44% (pre-review-2) | row above, section 5; the copy now uses 1.46% everywhere | this file |

## 7. Design facts (report 2, 3; README; landing)

| Claim | Source |
|---|---|
| Node 20.9+, four exact runtime deps, no install scripts | `package.json` (`engines`, `dependencies`, `scripts`) |
| 16 clients for `init`, 6 with hooks | `docs/install.md` "Clients" (16 entries), `docs/hook.md` "What it reads" table |
| No telemetry; hosts contacted | network diagram in `docs/how-it-works.md`; SECURITY.md |
| Cache: 24 h advisories and versions, 7 days docs, a year for tag listings | `docs/cli.md` "Cache"; `src/cache.ts` (`MAX_TTL_MS`) |
| Cooldown 3 days; 12 candidates; four lines ahead | `src/config.ts` (`cooldownDays`); `docs/how-it-works.md` "How the safe version is chosen" |
| Lookalike lists: 3,627 npm, 3,001 PyPI names; 50,000 downloads floor | `src/data/popular.ts` (counted from `dist/data/popular.js`); `src/verdict.ts` `OWN_AUDIENCE` |
| BM25 k1 1.2, b 0.75; near-duplicate 70% | `src/docs/retrieve.ts` |
| 10,000-character docs budget | `docs/how-it-works.md` "Tools" / `src/docs` budget |
| Hook: 45 s deadline, 40-dependency limit, 14-day young-package rule | `docs/hook.md`; `docs/HOOK-THREAT-MODEL.md` |
| SSRF guard: https only, 3 redirects, 10 MB cap | `src/safeFetch.ts`; SECURITY.md |
| OpenSSF Scorecard workflow | `.github/workflows/scorecard.yml` |
| Latency figures | `docs/hook.md` "Latency" (`scripts/latency.ts`); `latency.csv`. Measured once on Windows; no raw log committed |
| Hook latency on Linux (report 5.6): `npm test` 109 / 113 ms warm, one install 554 / 687 ms warm and 2.1 / 2.8 s cold, 30-dep `package.json` 2.5 / 3.0 s warm and 9.7 / 12.3 s cold (p50 / p95, 5 runs) | `data/latency-2026-11-02/linux-container-hook.txt`. Linux container (Debian 12, Node 24.22.2) on Docker Desktop / WSL2 on a Windows host, 2026-11-02, host also running another benchmark. Not a Linux machine; the CI VM was not reachable |
| Same-session Windows re-run (report 5.6), slower than the 2026-11-01 table in most cells | `data/latency-2026-11-02/windows-same-session.txt`, Windows 11, Node 24.20.0, same host and hour as the container |
| Warm 30-dep manifest misses its 1.5 s budget on 2026-11-02 (2.5 to 3.3 s) | same two logs; the 2026-11-01 Windows run met it (1.2 / 1.5 s) |
| MCP tool latency (report 5.6): e.g. `check-packages` of 10 npm packages 4.8 s cold / 598 ms warm on Linux, 6.5 s / 780 ms on Windows | `data/latency-2026-11-02/linux-container-mcp.txt` (run 1 of 3), `windows-same-session.txt`; one call per cell; runs 2 and 3 and the Windows 40-package call hit HTTP 429 from api.npmjs.org |
| No macOS latency | GitHub-hosted jobs in the org fail to start since 2026-10-22 ("recent account payments have failed", annotation on secureai-copilot job, 2026-10-27); a macOS run would also need a new workflow in the repo. Not measured |
| GitHub API request counts in `docs/cli.md` "GitHub rate limit" (1 request for 8 packages, etc.) | that page only; measured 2026-10-29 by hand, no committed log. Not used in the kit |

## 8. Claims we checked and left out

- "No index service in between" (README, landing): true of pinright's architecture
  (`src/docs/*`); it says nothing about other tools, so it stays.
- The landing's lodash example and the README quick start: reproduced on 2026-11-01
  (`visuals/cli/hook-block.txt`).
- Nothing in the kit names or compares to a third-party docs service, and no claim uses
  "certified", "compliant", "guarantee" or "100%" as a promise (the docs benchmark's "100%" appears
  only as a measured rate, 16 of 16).
- "Raw data" was replaced by "aggregate CSVs" everywhere: the agent transcripts and scored projects
  are not committed (`bench/agents/runs/` and `bench/docs/runs/` are gitignored).
- `paper/kit/pinright-report.pdf` is gitignored (`paper/.gitignore`). The README links the Markdown
  report; the site serves the PDF from its own build; the GitHub Release should carry it as an asset.
