# pinright benchmark v6: results across three models

Run on 2026-11-01 against the pre-release commit `b2fcfe2`, plus a benchmark-only ablation flag.
Claude Code 2.1.308 in headless mode, driving Sonnet 5.5, Haiku 5.5 and Opus 5.5. **The code under
test is not the 1.0.0 code**: 28 files under `src/` changed between that commit and the release
(the hook readers, `verdict.ts`, `typosquat.ts`, the tree audit), from the second security review
and the false-positive replay. Those changes tighten what the hook reads; none changes how a version
is chosen. A re-run on the release tag is planned, not done.
Details, per-task tables and failure diagnoses: [AGENTS.md](AGENTS.md) (what the agent pins) and
[DOCS.md](DOCS.md) (what the agent writes).

**Headline.** Without docs, about 40% of the direct dependencies each model pinned carried a known
advisory, and the projects averaged 30 to 33 whole-tree alerts. With the pinright MCP server, no model
pinned a direct dependency with an advisory, and each model's 24 projects totaled 6 alerts, all from one
upstream package with no fix (nuxt's dependencies; the no-pin reference has the same ones). With
pinright's docs, every model wrote the current API of eight recently changed libraries in 16 of 16 runs,
against 10 to 13 of 16 without docs. The docs-only ablation (pinright with its security layer off) cut
alerts by 94% to 99% from no docs. In three of its 48 Sonnet and Haiku runs the agent still pinned a
vulnerable `next` or `next-auth`, which the verdict arms never did; with two repetitions the intervals
of docs-only and MCP overlap for every model, so this is an observation, not a measured difference.
The no-pin reference (the same packages installed with no version) also lands at 0.3: on a new
project, pinright matters because agents pin, and it keeps the pin on a clean version.

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
| Sonnet 5.5 | No docs | 2 | 794 | 33.1 [21.4, 44.7] | 0 / 24 | 66 / 157 (42%) | 190 | 24 / 24 | 0.034 | 4.0 | 13.7 | 0.0 |
| Sonnet 5.5 | docs-only (pinright with the security layer off) | 2 | 48 | 2.0 [0.0, 5.8] | 21 / 24 | 1 / 120 (1%) | 23 | 24 / 24 | 0.087 | 8.9 | 29.8 | 5.0 |
| Sonnet 5.5 | pinright MCP | 2 | 6 | 0.3 [0.0, 0.8] | 22 / 24 | 0 / 130 (0%) | 0 | 23 / 24 | 0.051 | 6.0 | 21.2 | 2.0 |
| Sonnet 5.5 | pinright hook only | 2 | 14 | 0.6 [0.0, 1.5] | 19 / 23 | 0 / 154 (0%) | 4 | 23 / 23 | 0.046 | 5.7 | 23.4 | 0.0 |
| Sonnet 5.5 | pinright MCP + hook | 2 | 6 | 0.3 [0.0, 0.8] | 22 / 24 | 0 / 132 (0%) | 0 | 23 / 24 | 0.048 | 6.0 | 19.1 | 2.1 |
| Sonnet 5.5 | No pin (reference) | 1 | 3 | 0.3 [0.0, 0.8] | 11 / 12 | 0 / 78 (0%) | 0 | n/a | n/a | n/a | n/a | n/a |
| Haiku 5.5 | No docs | 2 | 711 | 29.6 [17.8, 41.9] | 2 / 24 | 63 / 157 (40%) | 173 | 23 / 24 | 0.003 | 4.2 | 15.8 | 0.0 |
| Haiku 5.5 | docs-only (pinright with the security layer off) | 2 | 21 | 0.9 [0.0, 2.3] | 20 / 24 | 2 / 127 (2%) | 11 | 23 / 24 | 0.009 | 10.0 | 30.3 | 6.1 |
| Haiku 5.5 | pinright MCP | 2 | 6 | 0.3 [0.0, 0.8] | 22 / 24 | 0 / 134 (0%) | 0 | 22 / 24 | 0.005 | 7.0 | 22.0 | 2.9 |
| Haiku 5.5 | pinright hook only | 2 | 10 | 0.4 [0.0, 1.2] | 20 / 23 | 0 / 149 (0%) | 2 | 22 / 23 | 0.004 | 5.7 | 25.8 | 0.0 |
| Haiku 5.5 | pinright MCP + hook | 2 | 6 | 0.3 [0.0, 0.8] | 22 / 24 | 0 / 121 (0%) | 0 | 24 / 24 | 0.005 | 6.8 | 21.1 | 2.7 |
| Haiku 5.5 | No pin (reference) | 1 | 3 | 0.3 [0.0, 0.8] | 11 / 12 | 0 / 76 (0%) | 0 | n/a | n/a | n/a | n/a | n/a |
| Opus 5.5 | No docs | 2 | 718 | 29.9 [17.9, 43.0] | 2 / 24 | 65 / 157 (41%) | 164 | 24 / 24 | 0.080 | 4.0 | 23.0 | 0.0 |
| Opus 5.5 | docs-only (pinright with the security layer off) | 2 | 6 | 0.3 [0.0, 0.8] | 22 / 24 | 0 / 126 (0%) | 0 | 24 / 24 | 0.204 | 9.5 | 31.0 | 5.5 |
| Opus 5.5 | pinright MCP | 2 | 6 | 0.3 [0.0, 0.8] | 22 / 24 | 0 / 135 (0%) | 0 | 24 / 24 | 0.130 | 6.5 | 29.4 | 2.3 |
| Opus 5.5 | pinright hook only | 2 | 14 | 0.6 [0.0, 1.4] | 20 / 24 | 0 / 157 (0%) | 4 | 24 / 24 | 0.101 | 5.4 | 35.6 | 0.0 |
| Opus 5.5 | pinright MCP + hook | 2 | 6 | 0.3 [0.0, 0.8] | 22 / 24 | 0 / 149 (0%) | 0 | 24 / 24 | 0.125 | 6.8 | 30.7 | 2.6 |
| Opus 5.5 | No pin (reference) | 1 | 3 | 0.3 [0.0, 0.8] | 11 / 12 | 0 / 77 (0%) | 0 | n/a | n/a | n/a | n/a | n/a |

"No pin" is not an agent: the no-docs agent's packages, installed without a version, for reference.

### Docs benchmark (8 tasks whose library changed API in its current major)

| Model | Arm | Reps | Current API, runs [95% CI of the rate] | Works (install + build + smoke) | Deprecated API used | API-equivalent cost / run (USD, list price) | Turns | Duration (s) | MCP calls |
|---|---|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | No docs | 2 | 13 / 16 (81% [56%, 100%]) | 15 / 16 | 2 | 0.044 | 5.3 | 17.5 | 0.0 |
| Sonnet 5.5 | docs-only (pinright with the security layer off) | 2 | 15 / 16 (94% [81%, 100%]) | 16 / 16 | 0 | 0.117 | 11.4 | 39.8 | 6.1 |
| Sonnet 5.5 | pinright MCP | 2 | 16 / 16 (100% [100%, 100%]) | 16 / 16 | 0 | 0.081 | 8.2 | 24.8 | 2.9 |
| Haiku 5.5 | No docs | 2 | 10 / 16 (63% [25%, 88%]) | 12 / 16 | 4 | 0.004 | 5.3 | 19.9 | 0.0 |
| Haiku 5.5 | pinright MCP | 2 | 16 / 16 (100% [100%, 100%]) | 16 / 16 | 0 | 0.008 | 9.4 | 31.5 | 4.2 |
| Opus 5.5 | No docs | 2 | 12 / 16 (75% [50%, 100%]) | 14 / 16 | 2 | 0.103 | 5.4 | 29.1 | 0.0 |
| Opus 5.5 | pinright MCP | 2 | 16 / 16 (100% [100%, 100%]) | 16 / 16 | 0 | 0.203 | 9.4 | 37.4 | 3.9 |

### API-equivalent cost of the runs (USD at list price, from the transcripts)

| Model | Agent benchmark | Docs benchmark | Total | Runs |
|---|---|---|---|---|
| Sonnet 5.5 | 6.38 | 3.88 | 10.26 | 168 |
| Haiku 5.5 | 0.63 | 0.18 | 0.81 | 152 |
| Opus 5.5 | 15.38 | 4.89 | 20.27 | 152 |
| **All** | 22.39 | 8.95 | **31.34** | 472 |

### pinright check-manifest vs npm audit / pip-audit (same lockfiles, every arm and model)

|  | Lockfiles | Alerts (audit tool) | Alerts (pinright) | Vulnerable packages, mean Jaccard | Identical sets |
|---|---|---|---|---|---|
| npm (npm audit) | 262 | 1260 | 1424 | 0.96 | 235 / 262 |
| PyPI (pip-audit) | 132 | 1121 | 1145 | 1.00 | 132 / 132 |

Flagged by one side only: only pinright: @nuxt/nitro-server (27); only pinright: nuxt (27).

<!-- generated:end -->

**Reading the tables.** "Direct deps with advisories" is counted with deps.dev's advisory keys through
pinright's own deps.dev client, so the 0% in the pinright arms follows from how pinright picks a
version; the whole-tree alert columns come from `npm audit` and `pip-audit`, which do not share that
path, and are the independent measure. The docs benchmark's `[100%, 100%]` is what a task bootstrap
gives when every run passes, not certainty: a Wilson interval for 16 of 16 is [81%, 100%]. In the
concordance table the mean Jaccard counts a clean-against-clean pair as 1: of the 262 npm lockfiles,
183 are clean on both sides, 52 agree on a non-empty set, and the 27 that differ are the nuxt
projects, where pinright also flags `nuxt` and `@nuxt/nitro-server` themselves (their current
release pulls the vulnerable `deepmerge`, `glob` and `minimatch`, so pinright reports the package
that carries them, while `npm audit` reports only the three). Of the 132 PyPI lockfiles, 108 are
clean on both sides and 24 agree on a non-empty set.

**Arms.** No docs: nothing attached. docs-only (pinright with the security layer off): the same server
with `PINRIGHT_ABLATION=docs-only`, which registers only `find-library` and `get-docs`, documents the
registry's latest version when asked without one, and shows no security notice, verdict or recommended
version; docs content, ranking and fencing are the same code. pinright MCP: the full server. Hook only:
the pre-install hook with no MCP server. MCP + hook: both. No pin: no agent, the no-docs agent's
packages installed without a version.

**Retrieval probes** (no agent, same code): the current API in the answer for 24 of 25 questions on the
benchmark tasks and 133 of 154 held-out questions over 56 other libraries (set A 75/81, set B 25/28,
set C 33/45). Identical to the scores recorded at the end of the third docs round on 2026-10-30.

## What changed since v5 (2026-10-29)

- Three models instead of Sonnet alone, and a docs-only ablation arm (agent benchmark for all three
  models, docs benchmark for Sonnet).
- Code under test: the rename to pinright, the hook's policy for what it cannot verify, the notice when
  a same-line fix still pulls vulnerable dependencies, undeclared-import notes, and three rounds of docs
  fixes. v5 ran at `dd570aa`.
- Sonnet, agent benchmark: no docs 678 to 794 alerts (24 manifests against 22; two more days of
  advisories), pinright MCP 6 to 6, MCP + hook 2 to 6. Nuxt now carries 3 alerts per run in every arm,
  the no-pin reference included, against 1 in v5.
- Sonnet, docs benchmark: no docs 12 to 13 of 16, pinright 16 of 16 in both.
- Reports: intervals, per-task min-max across repetitions, cost per arm and per model, and the cost
  column renamed to API-equivalent. `--resume` in the harness now parses transcripts; with Claude Code
  2.1.308 the old text match reran every job, which threw away a first Haiku pass of 96 runs (about
  USD 0.5 API-equivalent, not counted above).

## Caveats

- **One vendor.** Every agent is Claude Code driving a Claude model. Codex and Gemini CLI were not
  installed on the benchmark machine, so we did not run them. The hook supports them; the benchmark
  does not show how they behave.
- **We wrote the tasks**: 12 dependency tasks (8 npm, 4 PyPI) and 8 API-change tasks. They ask for
  exact pins and name the libraries, which favors a tool that answers version questions.
- **Small n.** 24 runs per arm and model in the agent benchmark, 16 in the docs benchmark. Two
  repetitions cannot separate 100% from 90%. The intervals above quantify only task-to-task variation.
- **One day of advisory data.** Alerts are what npm audit, pip-audit and deps.dev reported on
  2026-11-01. A version clean today can carry advisories tomorrow, and the no-docs numbers grow as
  advisories land.
- **No shell.** Agents had only Write and Read. They could not run `npm install`, read a lockfile they
  did not write, or test their code, so the hook only saw manifest writes. Real sessions with a shell
  will differ.
- **The models know most of the docs tasks.** Without docs they already wrote the current API of
  Next 16, Tailwind 4, Zod 4, Express 5 and Pydantic 2; the docs benchmark separates arms mainly on AI
  SDK 7, LangChain 1 and, for Haiku, ESLint 10.
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
# agent benchmark, per model (sonnet, haiku, opus)
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp v6-sonnet-2026-11-01
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp v6-sonnet-2026-11-01 --arms docs-only --resume
npx tsx bench/agents/make-latest.ts v6-sonnet-2026-11-01 && npx tsx bench/agents/score.ts v6-sonnet-2026-11-01
# docs benchmark, per model; docs-only for Sonnet
GITHUB_TOKEN=... npx tsx bench/docs/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp docs-v6-sonnet-2026-11-01
GITHUB_TOKEN=... npx tsx bench/docs/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp docs-v6-sonnet-2026-11-01 --arms docs-only --resume
npx tsx bench/docs/score.ts docs-v6-sonnet-2026-11-01
# reports
npx tsx bench/agents/report.ts v6-sonnet-2026-11-01 v6-haiku-2026-11-01 v6-opus-2026-11-01
npx tsx bench/docs/report.ts docs-v6-sonnet-2026-11-01 docs-v6-haiku-2026-11-01 docs-v6-opus-2026-11-01
npx tsx bench/summary.ts --agents v6-sonnet-2026-11-01,v6-haiku-2026-11-01,v6-opus-2026-11-01 \
  --docs docs-v6-sonnet-2026-11-01,docs-v6-haiku-2026-11-01,docs-v6-opus-2026-11-01
GITHUB_TOKEN=... npx tsx bench/docs/retrieval.ts
GITHUB_TOKEN=... npx tsx bench/docs/probe-heldout.ts --set all
```
