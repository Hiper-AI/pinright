# Claims and their sources

Every number and factual claim in the report, the blog post, the launch copy, the README and the
landing page, with the file (and section) or command that backs it. "CSV" means a file in
`paper/kit/data/`. Run stamps: agent runs `v6-{sonnet,haiku,opus}-2026-11-01`, docs runs
`docs-v6-{sonnet,haiku,opus}-2026-11-01`, probes `probes-v6`, all on 2026-11-01.

Regenerate the benchmark CSVs: `npx tsx paper/kit/make-data.ts --bench <bench dir>`. Regenerate the
figures: `npx tsx paper/kit/make-figures.ts`. Regenerate the CLI renders:
`npm run build && npx tsx paper/kit/render-cli.ts --project <dir>`.

## 1. Corrected on this branch

| Where | Was | Now | Why |
|---|---|---|---|
| README, intro | "Coding agents pin versions from memory, or from whatever version a docs index saw last. Both are often months old" | "Coding agents pin versions from memory. Those versions are often months old" | The data does not support it. In the docs-only ablation, a docs tool that documents the latest release moved agents to current versions (90% to 94% of direct deps on the registry default) and cut alerts by 94% to 99% (`agents_by_model_arm.csv`). We never measured a docs index. |
| README, CLI exit codes | "`pinright hook` always exits 0 ... It exits 1 only if it crashes" | decision on stdout with exit 0; Windsurf blocks with exit 2; an error while deciding asks; non-JSON input exits 1 | `src/hook/run.ts` (`runHook`, `hookAnswer`): non-JSON input returns 1, Windsurf blocks with code 2; `docs/SECURITY-REVIEW.md` round 2, residual 3 |
| README, Benchmark | "docs-only ... Its docs keep agents on recent versions, yet Sonnet and Haiku still pinned a vulnerable `next` and a `next-auth` beta there." | adds that steering to current versions already removes most alerts and that the runs cost more | `bench/AGENTS.md`, "Failure diagnoses"; `agents_by_model_arm.csv` (cost, turns, MCP calls) |
| Report draft | "pinright 0.2.0"; v5 Sonnet-only numbers; section "1.2 Docs alone do not change the version" | 1.0.0; v6 three-model numbers; section 1.2 "What changes the version" states that steering removes most alerts | `package.json` version; `bench/RESULTS-v6.md` |
| Report draft, 3.3 | "The hook process always exits 0 with its decision on stdout" | exit codes as in the README fix | `src/hook/run.ts` |
| Report draft, 4.5; blog; launch copy | "49 vectors" | 57 | `docs/HOOK-THREAT-MODEL.md`, vector table: 57 rows (review 2 and the false-positive replay added rows) |
| Report draft, 3.1 | "A name one edit away ... is a lookalike" | one edit; two for names of 7+ characters near the 1,000 most popular; established packages with 50,000+ weekly downloads pass | `src/typosquat.ts` (`HEAD`, `TWO_EDITS_MIN_LENGTH`), `src/verdict.ts` (`OWN_AUDIENCE`) |
| Blog draft, launch copy | v5 numbers only (41%, 678 to 6/10/2 alerts, "0.03 to 0.05", 12/16) | v6 numbers for three models, the docs-only ablation, the residual nuxt alerts | `bench/RESULTS-v6.md` |
| Blog draft | "Most remaining alerts come from Next.js 15.5.28" | in the MCP arms the remaining 6 are nuxt's; `next` 15.5.28's `postcss` is the hook-only remainder | `bench/AGENTS.md`, "Failure diagnoses" |
| `paper/build-pdf.mjs` | rendered with `md-to-pdf@5.2.4` | `md-to-pdf@5.2.5` | pinright's own hook denied `npx md-to-pdf@5.2.4` while building this kit: CVE-2025-65108, critical (`pinright check npm md-to-pdf@5.2.5` is clean) |

## 2. Landing page (repository `website`, branch `feat/pinright`, `client/src/pages/product/Pinright.tsx`)

Not changed here; these are the edits it needs.

| Current text | Problem | Proposed |
|---|---|---|
| Stat "41%" / "0%" with "of the direct dependencies the agent pinned had a known advisory, without pinright" / "with pinright, through the MCP server, the hook, or both." | Still true in v6 (40% to 42% per model; 0% in every pinright arm), but it hides the ablation: docs alone got 0% to 2%. Read on its own it credits the whole drop to the verdict. | Keep the pair as "40 to 42%" and "0%", and add a third line: "Docs for the current release alone got most of the way: 0 to 2%. The verdict closed the rest." Or switch the headline to alerts per project: "about 30" vs "0.3". Source: `agents_by_model_arm.csv`. |
| method: "Our benchmark, v5, run on 2026-10-29: Claude Code on 12 coding tasks ... 2 runs per arm." (EN and ES) | Stale run and model count | "Our benchmark, v6, run on 2026-11-01: Claude Code with Sonnet 5.5, Haiku 5.5 and Opus 5.5 on 12 coding tasks that ask for pinned versions, 2 runs per arm. We audited each project with npm audit or pip-audit, which share no code with pinright." ES: "Nuestro benchmark, v6, corrido el 2026-11-01: Claude Code con Sonnet 5.5, Haiku 5.5 y Opus 5.5 en 12 tareas ..." |
| caveat: "These numbers come from one model, one day and tasks we wrote." | Now three models from one vendor | "These numbers come from three models of one vendor, one day of advisory data and tasks we wrote." ES: "Estos números salen de tres modelos de un mismo proveedor, un día de datos y tareas que escribimos nosotros." |
| `REPORT = ${REPO}/blob/main/bench/AGENTS.md` (TODO(pinright-launch)) | The report now exists | Point at `${REPO}/blob/main/paper/kit/pinright-report.pdf` (or the release asset), keep `bench/RESULTS-v6.md` as the data link |
| Commit message of `dba5b3f` says "el número del benchmark v5 (41% contra 0%...)" | History only | No change needed; mention v6 in the next commit |

Everything else on the page checked out against the code: the lodash block message (identical to
`visuals/cli/hook-block.txt`), the six hook clients, the ten MCP-only clients, "If deps.dev or OSV does
not answer, the verdict is unknown, never ok" (`src/verdict.ts`), "no install scripts"
(`package.json`), "GITHUB_TOKEN ... goes only to api.github.com" (`src/github.ts`, SECURITY.md), the
list of hosts in the privacy table (network diagram in `docs/how-it-works.md`).

## 3. Agent benchmark (report 5.1, 5.2; blog; one-pager; README "Benchmark"; social; press)

| Claim | Value | Source |
|---|---|---|
| Direct deps with an advisory, no docs | Sonnet 66/157 (42%), Haiku 63/157 (40%), Opus 65/157 (41%) | `agents_by_model_arm.csv` `direct_deps_with_advisory*`; `bench/AGENTS.md` |
| 95% CI of that share | [30, 52], [30, 48], [32, 52] | same CSV, `_pct_ci95_*` (computed by `make-data.ts`, not in `bench/`) |
| Whole-tree alerts, no docs | 794, 711, 718; per project 33.1, 29.6, 29.9 | `alerts_sum`, `alerts_per_project_mean`; `bench/RESULTS-v6.md` |
| "projects averaged 30 to 33 alerts" | 29.6 to 33.1, rounded | same |
| Critical + high (npm), no docs | 190, 173, 164 | `critical_high_npm` |
| "Four of 72 projects came out clean" (no docs) | 0 + 2 + 2 | `projects_zero_alerts` |
| Median pinned age, no docs | 747, 583, 583 days | `median_pinned_age_days` |
| docs-only alerts | 48, 21, 6; per project 2.0, 0.9, 0.3 | CSV rows `docs-only` |
| docs-only direct deps with an advisory | 1/120, 2/127, 0/126 | same |
| "cut alerts by 94% to 99%" (docs-only vs no docs) | 1 - 48/794 = 94.0%, 1 - 21/711 = 97.0%, 1 - 6/718 = 99.2% | computed from `alerts_sum` |
| docs-only on registry default | 94%, 90%, 91% (no docs 8%, 10%, 13%) | `direct_deps_on_registry_default_pct` |
| docs-only cost and effort vs MCP | turns 8.9/10.0/9.5 vs 6.0/7.0/6.5; MCP calls 5.0/6.1/5.5 vs 2.0/2.9/2.3; cost per run 1.7x, 1.8x, 1.6x | `turns_per_run`, `mcp_calls_per_run`, `cost_per_run_usd_list_price` |
| docs-only failures | Sonnet `next@15.5.4` (35 advisories, 42 alerts, 23 crit/high in one run); Haiku `next-auth@5.0.0-beta.31` x2 (7 alerts each) | `bench/AGENTS.md`, "Vulnerable or non-existent direct pins" and "Failure diagnoses"; `agents_by_task.csv` |
| pinright MCP alerts | 6, 6, 6; 0 vulnerable direct deps | CSV rows `pinright` |
| MCP + hook | 6, 6, 6; 0 | rows `pinright+hook` |
| Hook only | 14, 10, 14; 0 vulnerable direct deps | rows `hook-only` |
| "the remaining 6 are nuxt's", "3 per run", no-pin gets the same | `nuxt` 4.6.3 pulls `deepmerge`, `glob`, `minimatch` with no fixed release | `bench/AGENTS.md`, "Failure diagnoses"; per-task table (nuxt-app 3.0 in every pinright arm and in No pin) |
| Hook-only remainder | `next` 15.5.28 pulls `postcss`; 4 alerts (2 high) per next-auth run | `bench/AGENTS.md`, "Hook only" |
| Security layer removes the rest: Sonnet 48 to 6, Haiku 21 to 6, Opus 6 to 6 | | rows `docs-only` vs `pinright` |
| Builds in pinright arms | 5 of 214 runs with a manifest failed | `projects_built` / `projects_build_conclusive` for the three pinright arms; `bench/AGENTS.md` "Runs without a manifest or that do not build" |
| Projects that build, MCP | 23/24, 22/24, 24/24 | same |
| Cost per run, no docs / MCP | 0.034/0.051, 0.003/0.005, 0.080/0.130 USD (API-equivalent, list price) | `cost_per_run_usd_list_price` |
| "1.5 to 2 times the cost", "2 to 4 more turns" (one-pager) | agents 1.5x to 1.7x, docs 1.8x to 2.0x; turns +2.0 to +4.1 | both `*_by_model_arm.csv` |
| Agreement with npm audit / pip-audit | 262 lockfiles, Jaccard 0.96, 235 identical; 132, 1.00, 132; only `nuxt` and `@nuxt/nitro-server` differ (27 each) | `bench/RESULTS-v6.md`, "check-manifest vs npm audit"; `bench/agents/metrics.ts` `agreement` |
| "394 lockfiles" | 262 + 132 | same |
| Example pins | `axios@1.7.9` (33), `pillow@11.0.0` (86), `pyjwt@2.10.1` (32), `next@15.5.4` (35) | `bench/AGENTS.md` vulnerable-pin lists |
| No arm pinned a nonexistent package or version | 0 everywhere | `direct_deps_nonexistent` |
| 360 agent runs; 472 runs and USD 31.34 in total | 5 arms x 24 x 3; 360 + 112 docs runs | `bench/RESULTS-v6.md`, cost table |
| Claude Code 2.1.308, Write and Read only | | `bench/AGENTS.md` intro |

## 4. Docs benchmark and probes (report 5.3, 5.4)

| Claim | Value | Source |
|---|---|---|
| Current API, no docs | 13/16, 10/16, 12/16 (81% [56, 100], 63% [25, 88], 75% [50, 100]) | `docs_by_model_arm.csv`; `bench/DOCS.md` |
| Current API, pinright | 16/16 for each model | same |
| docs-only (Sonnet) | 15/16, 94% [81, 100]; one AI SDK run kept `system:` | same; `bench/DOCS.md` "Where the runs fail" |
| Cost per run docs, no docs / pinright | 0.044/0.081, 0.004/0.008, 0.103/0.203 | `cost_per_run_usd_list_price` |
| AI SDK 7 released 2026-06-25; all 6 no-docs runs wrote 5/6 code | | `bench/DOCS.md` |
| LangChain: 5 of 6 no-docs runs fail the import check; pinright pinned 1.4.7 | | `bench/DOCS.md`; `docs_by_task.csv` |
| Probes 24/25; 133/154 (A 75/81, B 25/28, C 33/45) | | `probes.csv` (from `probes-v6/heldout-all.json`, `retrieval.log`) |
| Probe "before" values 16, 53, 22, 28 | | `bench/DOCS.md` (rounds 1 to 3); `probes.csv` `before` |

## 5. Hook false positives (report 5.5; blog; social)

| Claim | Value | Source |
|---|---|---|
| Corpus | 25,077 entries, 14,902 distinct, 180 repositories (174 with something to extract) | `bench/fp/RESULTS.md`, "Corpus"; `fp_by_source.csv` |
| Blocked or asked | 2.22% to 1.44% (1.46% on top of review 2); without templating 1.92% to 1.16%; denied 0.42% to 0.13% | "Rates"; `fp_by_source.csv` |
| Per source | see `fp_by_source.csv` (README lines 0.61% after) | "Rates" |
| Root causes fixed, remaining causes, 32 true positives | | "False positives found and fixed", "What still blocks or asks"; `fp_categories.csv` |
| `npm install -g pnpm@8`: 26 advisories in a public workflow | microsoft/playwright | "True positives" |

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
| Unit tests: 962 pass, 9 skipped | `npm test` on `feat/paperkit` (base `99027f5`), 2026-11-01 |

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
| GitHub API request counts in `docs/cli.md` "GitHub rate limit" (1 request for 8 packages, etc.) | that page only; measured 2026-10-29 by hand, no committed log. Not used in the kit |

## 8. Claims we checked and left out

- "No index service in between" (README, landing): true of pinright's architecture
  (`src/docs/*`); it says nothing about other tools, so it stays.
- The landing's lodash example and the README quick start: reproduced on 2026-11-01
  (`visuals/cli/hook-block.txt`).
- Nothing in the kit names or compares to a third-party docs service, and no claim uses
  "certified", "compliant", "guarantee" or "100%" as a promise (the docs benchmark's "100%" appears
  only as a measured rate, 16 of 16).
