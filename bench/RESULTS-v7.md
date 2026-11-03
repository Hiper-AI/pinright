# pinright benchmark v7: results across three models

Run on 2026-11-02 and 2026-11-03 (UTC-3) at commit `8efc4f0`, whose `src/` is the 1.0.0 release
(`093175b`); between the two only `bench/`, the docs, the site, the paper kit and the README
changed. Claude Code 2.1.308 in headless mode, driving
Sonnet 5.5, Haiku 5.5 and Opus 5.5. Same tasks, arms, prompts and repetitions as v6. Details,
per-task tables and failure diagnoses: [AGENTS.md](AGENTS.md) (what the agent pins) and
[DOCS.md](DOCS.md) (what the agent writes). The previous run is [RESULTS-v6.md](RESULTS-v6.md).

**Headline.** Without docs, 40% to 42% of the direct dependencies each model pinned carried a known
advisory, and the projects averaged 30 to 32 whole-tree alerts. With the pinright MCP server, no model
pinned a direct dependency with an advisory, and each model's 24 projects totaled 6 alerts, all from one
upstream package with no fix (nuxt's dependencies; the no-pin reference has the same ones). With
pinright's docs, every model wrote the current API of eight recently changed libraries in 16 of 16 runs,
against 9 to 14 of 16 without docs. The docs-only ablation (pinright with its security layer off) cut
alerts by 89% to 99% from no docs and wrote the current API in 15 or 16 of 16 runs. In four of its 72
agent runs the agent still pinned a vulnerable `next` or `next-auth` (Sonnet twice, Haiku twice),
which the verdict arms never did. With two repetitions the intervals of docs-only and MCP overlap for
every model, so this is an observation, not a measured difference. The no-pin reference (the same
packages installed with no version) also lands at 0.25 alerts per project: on a new project, pinright
matters because agents pin, and it keeps the pin on a clean version.

## Headline tables

Two repetitions of 12 tasks (agent benchmark) or 8 tasks (docs benchmark) per arm and model. Brackets
are 95% cluster-bootstrap intervals that resample tasks, seeded so they regenerate identically. With
n this small, two arms whose intervals overlap are not shown to differ. Cost is Claude Code's
API-equivalent at list price (`total_cost_usd`): the runs used a Claude subscription, so this is not
money spent.

<!-- generated:start -->
### Agent security benchmark (12 tasks; whole-tree alerts from npm audit / pip-audit)

| Model | Arm | Reps | Alerts, whole tree (sum) | Alerts per project, mean [95% CI] | Projects with 0 alerts | Direct deps with advisories | Critical + high (npm) | Builds | API-equivalent cost / run (USD, list price) | Turns | Duration (s) | MCP calls |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | No docs | 2 | 766 | 31.9 [20.3, 44.7] | 0 / 24 | 66 / 164 (40%) | 178 | 24 / 24 | 0.033 | 4.1 | 14.4 | 0.0 |
| Sonnet 5.5 | docs-only (pinright with the security layer off) | 2 | 84 | 3.5 [0.0, 10.0] | 20 / 24 | 2 / 125 (2%) | 42 | 24 / 24 | 0.088 | 9.3 | 34.9 | 5.3 |
| Sonnet 5.5 | pinright MCP | 2 | 6 | 0.3 [0.0, 0.8] | 22 / 24 | 0 / 131 (0%) | 0 | 23 / 24 | 0.050 | 5.9 | 21.1 | 1.9 |
| Sonnet 5.5 | pinright hook only | 2 | 14 | 0.6 [0.0, 1.4] | 20 / 24 | 0 / 160 (0%) | 4 | 24 / 24 | 0.044 | 5.5 | 27.2 | 0.0 |
| Sonnet 5.5 | pinright MCP + hook | 2 | 6 | 0.3 [0.0, 0.8] | 21 / 23 | 0 / 122 (0%) | 0 | 22 / 23 | 0.045 | 5.8 | 19.9 | 1.8 |
| Sonnet 5.5 | No pin (reference) | 1 | 3 | 0.3 [0.0, 0.8] | 11 / 12 | 0 / 83 (0%) | 0 | n/a | n/a | n/a | n/a | n/a |
| Haiku 5.5 | No docs | 2 | 715 | 29.8 [17.8, 43.5] | 2 / 24 | 63 / 157 (40%) | 164 | 24 / 24 | 0.003 | 4.3 | 16.5 | 0.0 |
| Haiku 5.5 | docs-only (pinright with the security layer off) | 2 | 63 | 2.6 [0.0, 7.6] | 20 / 24 | 3 / 142 (2%) | 33 | 22 / 24 | 0.008 | 11.1 | 28.0 | 7.0 |
| Haiku 5.5 | pinright MCP | 2 | 6 | 0.3 [0.0, 0.8] | 22 / 24 | 0 / 137 (0%) | 0 | 23 / 24 | 0.006 | 7.5 | 22.2 | 3.4 |
| Haiku 5.5 | pinright hook only | 2 | 14 | 0.6 [0.0, 1.5] | 19 / 23 | 0 / 148 (0%) | 4 | 23 / 23 | 0.004 | 5.7 | 26.5 | 0.0 |
| Haiku 5.5 | pinright MCP + hook | 2 | 6 | 0.3 [0.0, 0.8] | 22 / 24 | 0 / 123 (0%) | 0 | 23 / 24 | 0.005 | 7.6 | 23.2 | 3.3 |
| Haiku 5.5 | No pin (reference) | 1 | 3 | 0.3 [0.0, 0.8] | 11 / 12 | 0 / 76 (0%) | 0 | n/a | n/a | n/a | n/a | n/a |
| Opus 5.5 | No docs | 2 | 732 | 30.5 [18.0, 43.5] | 2 / 24 | 66 / 159 (42%) | 170 | 24 / 24 | 0.074 | 4.0 | 23.8 | 0.0 |
| Opus 5.5 | docs-only (pinright with the security layer off) | 2 | 6 | 0.3 [0.0, 0.8] | 22 / 24 | 0 / 126 (0%) | 0 | 24 / 24 | 0.212 | 9.9 | 39.2 | 5.7 |
| Opus 5.5 | pinright MCP | 2 | 6 | 0.3 [0.0, 0.8] | 22 / 24 | 0 / 154 (0%) | 0 | 24 / 24 | 0.126 | 6.8 | 32.3 | 2.5 |
| Opus 5.5 | pinright hook only | 2 | 14 | 0.6 [0.0, 1.4] | 20 / 24 | 0 / 156 (0%) | 4 | 24 / 24 | 0.097 | 5.5 | 37.3 | 0.0 |
| Opus 5.5 | pinright MCP + hook | 2 | 6 | 0.3 [0.0, 0.8] | 22 / 24 | 0 / 149 (0%) | 0 | 24 / 24 | 0.116 | 6.6 | 31.5 | 2.5 |
| Opus 5.5 | No pin (reference) | 1 | 3 | 0.3 [0.0, 0.8] | 11 / 12 | 0 / 78 (0%) | 0 | n/a | n/a | n/a | n/a | n/a |

"No pin" is not an agent: the no-docs agent's packages, installed without a version, for reference.

### Docs benchmark (8 tasks whose library changed API in its current major)

| Model | Arm | Reps | Current API, runs [95% CI of the rate] | Works (install + build + smoke) | Deprecated API used | API-equivalent cost / run (USD, list price) | Turns | Duration (s) | MCP calls |
|---|---|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | No docs | 2 | 13 / 16 (81% [56%, 100%]) | 13 / 16 | 2 | 0.044 | 5.3 | 18.4 | 0.0 |
| Sonnet 5.5 | docs-only (pinright with the security layer off) | 2 | 16 / 16 (100% [100%, 100%]) | 16 / 16 | 0 | 0.120 | 11.7 | 38.4 | 6.4 |
| Sonnet 5.5 | pinright MCP | 2 | 16 / 16 (100% [100%, 100%]) | 16 / 16 | 0 | 0.084 | 8.1 | 29.4 | 2.9 |
| Haiku 5.5 | No docs | 2 | 9 / 16 (56% [25%, 88%]) | 9 / 16 | 3 | 0.004 | 5.6 | 20.2 | 0.0 |
| Haiku 5.5 | docs-only (pinright with the security layer off) | 2 | 15 / 16 (94% [81%, 100%]) | 15 / 16 | 0 | 0.010 | 13.4 | 37.2 | 8.2 |
| Haiku 5.5 | pinright MCP | 2 | 16 / 16 (100% [100%, 100%]) | 16 / 16 | 0 | 0.007 | 9.1 | 30.5 | 4.0 |
| Opus 5.5 | No docs | 2 | 14 / 16 (88% [63%, 100%]) | 16 / 16 | 2 | 0.099 | 5.4 | 30.7 | 0.0 |
| Opus 5.5 | docs-only (pinright with the security layer off) | 2 | 16 / 16 (100% [100%, 100%]) | 16 / 16 | 0 | 0.263 | 12.4 | 47.4 | 7.2 |
| Opus 5.5 | pinright MCP | 2 | 16 / 16 (100% [100%, 100%]) | 16 / 16 | 0 | 0.195 | 9.3 | 41.5 | 3.8 |

### API-equivalent cost of the runs (USD at list price, from the transcripts)

| Model | Agent benchmark | Docs benchmark | Total | Runs |
|---|---|---|---|---|
| Sonnet 5.5 | 6.22 | 3.98 | 10.20 | 168 |
| Haiku 5.5 | 0.64 | 0.34 | 0.98 | 168 |
| Opus 5.5 | 15.02 | 8.91 | 23.93 | 168 |
| **All** | 21.88 | 13.23 | **35.10** | 504 |

### pinright check-manifest vs npm audit / pip-audit (same lockfiles, every arm and model)

|  | Lockfiles | Alerts (audit tool) | Alerts (pinright) | Vulnerable packages, mean Jaccard | Identical sets |
|---|---|---|---|---|---|
| npm (npm audit) | 264 | 1333 | 1411 | 0.96 | 236 / 264 |
| PyPI (pip-audit) | 130 | 1120 | 1144 | 1.00 | 130 / 130 |

Flagged by one side only: only pinright: @nuxt/nitro-server (27); only pinright: nuxt (27); only pinright: multer (1).

<!-- generated:end -->

**Reading the tables.** "Direct deps with advisories" is counted with deps.dev's advisory keys through
pinright's own deps.dev client, so the 0% in the pinright arms follows from how pinright picks a
version; the whole-tree alert columns come from `npm audit` and `pip-audit`, which do not share that
path, and are the independent measure. The docs benchmark's `[100%, 100%]` is what a task bootstrap
gives when every run passes, not certainty: a Wilson interval for 16 of 16 is [81%, 100%]. In the
concordance table the mean Jaccard counts a clean-against-clean pair as 1: of the 264 npm lockfiles,
183 are clean on both sides, 53 agree on a non-empty set, and 28 differ. 27 of those are the nuxt
projects, where pinright also flags `nuxt` and `@nuxt/nitro-server` themselves (their current release
pulls the vulnerable `deepmerge`, `glob` and `minimatch`, so pinright reports the package that carries
them, while `npm audit` reports only the three); the other is one `multer` we did not diagnose. Of the
130 PyPI lockfiles, 106 are clean on both sides and 24 agree on a non-empty set.

**Arms.** No docs: nothing attached. docs-only (pinright with the security layer off): the same server
with `PINRIGHT_ABLATION=docs-only`, which registers only `find-library` and `get-docs`, documents the
registry's latest version when asked without one, and shows no security notice, verdict or recommended
version; docs content, ranking and fencing are the same code. pinright MCP: the full server. Hook only:
the pre-install hook with no MCP server. MCP + hook: both. No pin: no agent, the no-docs agent's
packages installed without a version.

**Retrieval probes** (no agent): the current API in the answer for 24 of 25 questions on the benchmark
tasks and 133 of 154 held-out questions over 56 other libraries (set A 75/81, set B 25/28, set C
33/45). These come from the v6 probe run of 2026-11-01 on the release candidate `b2fcfe2`; v7 did not
rerun them.

## v7 against v6

v6 ran on 2026-11-01 at `b2fcfe2`, before the release: 28 files under `src/` changed between that
commit and 1.0.0 (the hook readers, `verdict.ts`, `typosquat.ts`, the tree audit). v7 measures the
release code. The headline numbers moved little:

| Model | Alerts per project, no docs | pinright MCP | docs-only | hook only | Docs: current API, no docs | pinright |
|---|---|---|---|---|---|---|
| Sonnet 5.5 | 33.1 to 31.9 | 0.25 to 0.25 | 2.0 to 3.5 | 0.61 to 0.58 | 13 to 13 of 16 | 16 to 16 |
| Haiku 5.5 | 29.6 to 29.8 | 0.25 to 0.25 | 0.88 to 2.6 | 0.43 to 0.61 | 10 to 9 of 16 | 16 to 16 |
| Opus 5.5 | 29.9 to 30.5 | 0.25 to 0.25 | 0.25 to 0.25 | 0.58 to 0.58 | 12 to 14 of 16 | 16 to 16 |

The MCP and MCP + hook arms stayed at 0 direct dependencies with an advisory and 6 alerts per model.
The docs-only arm read worse in v7 for Sonnet and Haiku: one next-auth choice per model decides it, so
it swings from run to run. Sonnet pinned `next` 15.5.0 in both next-auth runs (39 alerts each), and
Haiku pinned `next-auth` betas with advisories in both (one with `next` 15.5.4, 50 alerts). The docs
benchmark now runs docs-only on all three models (v6: Sonnet only): 16, 15 and 16 of 16.

## Other result sets

- **Post-cutoff docs set** ([RESULTS-post-cutoff.md](RESULTS-post-cutoff.md)). Eight APIs first
  released on 2026-08-01 or later, so the models cannot know them. Without docs the agent wrote the new
  API in 2 of 48 runs; with pinright in 46 of 48, and with the docs-only ablation in 45 of 48.
- **Tasks from public GitHub issues** ([RESULTS-real-issues.md](RESULTS-real-issues.md)). 12 tasks we
  did not write, picked by a fixed search rule, on the same release code. Without docs, 26% to 29% of
  direct dependencies carried an advisory and the projects totaled 504 to 600 alerts per model; with
  the MCP server, 0 direct dependencies and 114 to 116 alerts, 112 of them from one task whose current
  upstream release pulls a capped `pillow`. That set was scored before the two scorer fixes below; its
  run data shows the same misses only in no-docs runs, so its no-docs counts are low, not high.
- **Shell arm** ([RESULTS-shell.md](RESULTS-shell.md)). The same 12 tasks with Bash, each job in a
  disposable Linux container, with a real install and a build check: 216 runs over three models and
  three arms (no docs, hook only, MCP and hook). Without the MCP server the agents looked versions up
  with `npm view` or `pip index versions` in every run, and every arm ended at the same 6 whole-tree
  alerts per model, from the latest `nuxt` tree. On these tasks, with a shell, pinright made no
  measurable difference to what got pinned.
- **Hook replay of real agent sessions** ([fp/RESULTS.md](fp/RESULTS.md#real-agent-sessions-2026-11-02)).
  156,977 tool calls from one month of the maintainers' Claude Code sessions. The hook asked or blocked
  on 0.46%; read by hand, 10 cases in 154,402 were false positives (0.006%) after the fixes, against 52
  true positives and 79 asks by design.
- **Hook false positives on public commands** ([fp/RESULTS.md](fp/RESULTS.md)). 25,077 CI steps, scripts,
  README lines, Dockerfiles, Makefiles and manifest writes from 180 public repositories: blocked or
  asked on 1.46%, denied 0.13% of the entries without GitHub templating.
- **Latency** ([report, section 5.6](../paper/kit/pinright-report.md#56-latency)). In a Linux container
  on 2026-11-02, the hook took 109 ms (p50, warm) on a command that installs nothing and 554 ms on one
  install; a 30-dependency `package.json` took 2.5 s warm, over its 1.5 s budget.

## Caveats

- **One vendor.** Every agent is Claude Code driving a Claude model. Codex and Gemini CLI were not
  installed on the benchmark machine, so we did not run them. The hook supports them; the benchmark
  does not show how they behave.
- **We wrote the tasks**: 12 dependency tasks (8 npm, 4 PyPI) and 8 API-change tasks. They ask for
  exact pins and name the libraries, which favors a tool that answers version questions. The
  real-issues set above tests this with tasks we did not write.
- **Small n.** 24 runs per arm and model in the agent benchmark, 16 in the docs benchmark. Two
  repetitions cannot separate 100% from 90%. The intervals above quantify only task-to-task variation.
- **Two days of advisory data.** Alerts are what npm audit, pip-audit and deps.dev reported when each
  run was scored, on 2026-11-02 and 2026-11-03. A version clean today can carry advisories tomorrow,
  and the no-docs numbers grow as advisories land.
- **Scorer fixes during v7.** The first scoring pass read a failed deps.dev lookup as a version that
  does not exist (`next` 15.5.0, `pytz` 2024.2, `tzdata` 2024.2) and an empty `pip-audit` answer as a
  clean tree (9 PyPI projects). `bench/agents/score.ts` now retries both and fails the run if they
  keep failing; we rescored the affected runs. That moved Sonnet docs-only from 0 to 2 vulnerable
  direct deps and Haiku no-docs from 701 to 715 alerts; the 8 other empty audits stayed at 0 alerts.
  v6 had 6 empty PyPI audits of the same kind, all in arms where check-manifest also found 0.
- **The hook changed after v7.** Two commits on the release branch after the run (`6837139`,
  `699770d`) fix false positives in the hook's shell command reader (`src/hook/command.ts`), found in
  the real-session replay. The hook arms ran without them. Agents here have no shell, so the hook read
  only their manifest writes.
- **No shell.** Agents had only Write and Read. They could not run `npm install`, read a lockfile they
  did not write, or test their code, so the hook only saw manifest writes. In the shell arm
  ([RESULTS-shell.md](RESULTS-shell.md)), with Bash in a container, the agents looked versions up
  with `npm view` or `pip index versions` before pinning, and every arm (no docs, hook only, MCP and
  hook) ended at the same 6 whole-tree alerts per model. On these tasks, the gap measured here is
  the gap of an agent that pins from memory.
- **The models know most of the docs tasks.** Without docs they already wrote the current API of
  Next 16, Tailwind 4, Zod 4 and Express 5; the docs benchmark separates arms mainly on AI SDK 7,
  LangChain 1 and, for Haiku, ESLint 10 and Pydantic 2. The post-cutoff set addresses this.
- **Cost is not money.** The runs used a subscription; the cost columns are list-price equivalents.
- **The ablation is ours.** docs-only is pinright with its security layer off, not any other product.
  It shows what version-accurate docs do alone; other docs sources may behave differently.
- **Build checks are partial.** "Builds" means install plus build, type-check or import check. Only the
  docs benchmark runs smoke tests, and the AI SDK task has none.
- **Every prompt asks the agent to use its docs tools.** Each task ends with "If you have
  documentation tools available, use them to check the libraries before choosing versions" (agent
  benchmark) or "... the current API of each library before writing code" (docs benchmark), in every
  arm. A session without that line may call the tools less often; the hook does not depend on it.
- **The direct-dependency share is not independent of pinright.** It is scored with deps.dev through
  pinright's own client. The whole-tree alerts from `npm audit` and `pip-audit` are.
- **The retrieval probes predate the release.** They ran on `b2fcfe2` with v6 and were not rerun.
- **The false-positive corpus is also the tuning corpus.** The 13 root causes were found and fixed on
  the same 25,077 entries the 1.46% is measured on; there is no held-out set, and 32 of the entries
  counted as "blocked or asked" are true positives.
- **No model cutoff dates.** Anthropic does not publish training cutoffs for these models, so "newer
  than the models" is an inference from the no-docs runs, not a fact about training data.

## Reproduce

You need: Node 20.9+, the `claude` CLI (we used 2.1.308) logged in to an account that can run the
three models, `uv` and `uvx` on PATH (the PyPI tasks resolve with `uv pip compile` and audit with
`pip-audit`), `npm`, and a `GITHUB_TOKEN` for the docs pipeline's rate limit. The agent transcripts
and scored projects are not in the repository; a new run reads live advisory data and will not
reproduce these numbers exactly. To compare another docs server, pass `--mcp-arm name=mcp.json` to
either `run.ts` (a Claude Code MCP config); `score.ts`, `report.ts` and `summary.ts` pick the extra
arm up by its directory name.

```bash
npm ci && npm run build
# agent benchmark, per model (sonnet, haiku, opus); all five agent arms in one pass
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp v7-sonnet-2026-11-02
npx tsx bench/agents/make-latest.ts v7-sonnet-2026-11-02 && npx tsx bench/agents/score.ts v7-sonnet-2026-11-02
# docs benchmark, per model
GITHUB_TOKEN=... npx tsx bench/docs/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp docs-v7-sonnet-2026-11-02
GITHUB_TOKEN=... npx tsx bench/docs/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp docs-v7-sonnet-2026-11-02 --arms docs-only --resume
npx tsx bench/docs/score.ts docs-v7-sonnet-2026-11-02
# reports
npx tsx bench/agents/report.ts v7-sonnet-2026-11-02 v7-haiku-2026-11-02 v7-opus-2026-11-02
npx tsx bench/docs/report.ts docs-v7-sonnet-2026-11-02 docs-v7-haiku-2026-11-02 docs-v7-opus-2026-11-02
npx tsx bench/summary.ts --agents v7-sonnet-2026-11-02,v7-haiku-2026-11-02,v7-opus-2026-11-02 \
  --docs docs-v7-sonnet-2026-11-02,docs-v7-haiku-2026-11-02,docs-v7-opus-2026-11-02
npx tsx paper/kit/make-data.ts --agents v7-sonnet-2026-11-02,v7-haiku-2026-11-02,v7-opus-2026-11-02 \
  --docs docs-v7-sonnet-2026-11-02,docs-v7-haiku-2026-11-02,docs-v7-opus-2026-11-02 --probes <probes-v6 dir>
```
