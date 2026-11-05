# Benchmark

Four measurements, all from run v7 of 2026-11-02 and 2026-11-03 on the 1.0.0 code: what versions an
agent pins, whether it writes the current API of a library, how many tokens and turns it spends
against a docs-only server, and how often the hook gets in the way of ordinary commands. Run v8 of
2026-11-04 adds a [comparison with a docs MCP server](#against-a-docs-mcp-server). The data, per-task tables and failure diagnoses are in [bench/](../bench/); the
technical report ([PDF](https://pinright.dev/report.pdf), [Markdown](../paper/kit/pinright-report.md))
covers method and limits in full.

## Dependencies: does the agent pin vulnerable versions?

Claude Code in headless mode, driving Sonnet 5.5, Haiku 5.5 and Opus 5.5, on 12 coding tasks (8 npm,
4 PyPI) that ask for pinned versions, twice per arm and model. We audit each project with `npm audit`
or `pip-audit`, which share nothing with pinright, and install and build it for real. Run v7;
summary and caveats in [bench/RESULTS-v7.md](../bench/RESULTS-v7.md), full report in
[bench/AGENTS.md](../bench/AGENTS.md):

| Whole-tree alerts, sum over 24 projects (direct deps with an advisory) | Sonnet 5.5 | Haiku 5.5 | Opus 5.5 |
|---|---|---|---|
| No docs | 766 (40%) | 715 (40%) | 732 (42%) |
| docs-only (pinright with the security layer off) | 84 (2%) | 63 (2%) | 6 (0%) |
| pinright MCP | 6 (0%) | 6 (0%) | 6 (0%) |
| pinright hook only | 14 (0%) | 14 (0%) | 14 (0%) |
| pinright MCP + hook | 6 (0%) | 6 (0%) | 6 (0%) |
| Projects that build, pinright MCP | 23/24 | 23/24 | 24/24 |
| API-equivalent cost per run, no docs / pinright MCP (USD, list price) | 0.033 / 0.050 | 0.003 / 0.006 | 0.074 / 0.126 |

The 6 alerts left in the MCP arms are all nuxt's: its current release pulls `deepmerge`, `glob` and
`minimatch` versions with advisories and no fix yet, and installing nuxt without a pin gets the same 3
per project. docs-only is an ablation: the same server with its verdict turned off, documenting each
package's latest release. Steering the agent to current versions that way already removes most of
the alerts. The verdict removes the rest: without it, Sonnet pinned a vulnerable `next` in both of its
next-auth runs and Haiku `next-auth` betas with advisories in both of its own, and the runs took more
turns and cost more. On the same 394 lockfiles, `check-manifest` flagged the same vulnerable packages
as `npm audit` and `pip-audit` (mean Jaccard 0.96 for npm, 1.00 for PyPI).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../paper/kit/figures/fig-a-alerts-per-project-dark.png">
  <img alt="Whole-tree alerts per project by arm and model: about 30 without docs, 0.3 with the pinright MCP server for each model" src="../paper/kit/figures/fig-a-alerts-per-project.png">
</picture>

Mean alerts per project, with 95% cluster-bootstrap intervals that resample tasks
([caption and source](../paper/kit/figures/fig-a-alerts-per-project.caption.md)).

## Docs: does the agent write the current API?

Eight tasks that only come out right with a library's current major (Next.js 16, Tailwind CSS 4,
Zod 4, AI SDK 7, Express 5, ESLint 10, Pydantic 2, LangChain 1), twice per arm and model. Each
project is installed, built, smoke-tested at runtime and checked for new, removed and deprecated
APIs. Report and per-task diagnosis in [bench/DOCS.md](../bench/DOCS.md):

| Current API (works, right major, all checks pass) | Sonnet 5.5 | Haiku 5.5 | Opus 5.5 |
|---|---|---|---|
| No docs | 13 / 16 | 9 / 16 | 14 / 16 |
| docs-only (pinright with the security layer off) | 16 / 16 | 15 / 16 | 16 / 16 |
| pinright | 16 / 16 | 16 / 16 | 16 / 16 |

Without docs every model wrote AI SDK 5/6 code for AI SDK 7, and half the LangChain runs pinned an
early 1.x (1.0.3 or 1.2.0) that fails to import, a version problem more than a docs problem. The
models already knew most of the eight APIs, so the gap rests on a few, and the no-docs intervals
for Sonnet and Opus overlap 16 of 16. A second set of eight APIs released after August 2026
separates the arms more: 2 of 48 runs without docs, 46 of 48 with pinright
([bench/RESULTS-post-cutoff.md](../bench/RESULTS-post-cutoff.md)). Without an agent, pinright's docs
answer 24 of 25 questions on the first set's tasks and 133 of 154 held-out questions over 56 other
libraries with the current API.

## Efficiency: tokens, turns and cost against a docs-only server

Docs MCP servers return documentation for a library; they do not check the version the agent pins,
and they do not see the install. The docs-only arm stands in for that kind of server: it is pinright's
own server with its security layer off (`PINRIGHT_ABLATION=docs-only`), serving docs for the version
asked and no verdict. It is not another product, and other docs servers may behave differently.

Tokens are everything the model processed in a run (uncached input, cache reads and writes, output),
from the usage record Claude Code prices each run from; `bench/tokens.ts` reads them from the
transcripts. Fresh input is uncached input plus cache writes. "Less than docs-only" pairs the two arms
task by task, and its interval resamples tasks. Data: `paper/kit/data/tokens_by_model_arm.csv`.

Agent benchmark (12 tasks, 24 runs per arm and model):

| Model | Arm | Tokens per run, thousands [95% CI] | Less than docs-only, paired [95% CI] | Fresh input (k) | Output (k) | MCP text (k chars) | get-docs calls | Turns | Cost / run (USD) |
|---|---|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | No docs | 15.3 [14.6, 16.1] | - | 4.9 | 1.8 | 0.0 | 0.0 | 4.1 | 0.033 |
| Sonnet 5.5 | Docs-only server | 55.6 [47.2, 63.5] | - | 16.3 | 2.4 | 24.8 | 5.2 | 9.3 | 0.088 |
| Sonnet 5.5 | pinright MCP | 42.2 [37.4, 46.8] | 24% [14, 34] | 8.0 | 2.0 | 5.3 | 0.7 | 5.9 | 0.050 |
| Haiku 5.5 | No docs | 20.8 [19.8, 22.0] | - | 6.2 | 3.8 | 0.0 | 0.0 | 4.3 | 0.003 |
| Haiku 5.5 | Docs-only server | 93.8 [73.5, 114.8] | - | 26.7 | 5.1 | 45.3 | 5.7 | 11.1 | 0.008 |
| Haiku 5.5 | pinright MCP | 74.2 [61.8, 87.8] | 21% [6, 33] | 14.5 | 4.5 | 17.2 | 1.7 | 7.5 | 0.005 |
| Opus 5.5 | No docs | 16.4 [15.3, 18.0] | - | 4.6 | 2.3 | 0.0 | 0.0 | 4.0 | 0.074 |
| Opus 5.5 | Docs-only server | 73.3 [58.8, 88.5] | - | 19.2 | 3.0 | 32.9 | 5.7 | 9.9 | 0.212 |
| Opus 5.5 | pinright MCP | 54.6 [45.2, 65.0] | 26% [11, 37] | 9.8 | 2.5 | 10.4 | 1.3 | 6.8 | 0.126 |

Docs benchmark (8 tasks, 16 runs per arm and model):

| Model | Arm | Tokens per run, thousands [95% CI] | Less than docs-only, paired [95% CI] | Fresh input (k) | Output (k) | MCP text (k chars) | get-docs calls | Turns | Cost / run (USD) |
|---|---|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | No docs | 17.2 [16.3, 18.2] | - | 5.9 | 2.6 | 0.0 | 0.0 | 5.3 | 0.044 |
| Sonnet 5.5 | Docs-only server | 94.0 [63.8, 125.1] | - | 21.5 | 3.4 | 35.0 | 5.4 | 11.7 | 0.120 |
| Sonnet 5.5 | pinright MCP | 62.9 [52.4, 76.7] | 33% [13, 45] | 14.8 | 2.6 | 20.2 | 1.6 | 8.1 | 0.084 |
| Haiku 5.5 | No docs | 23.5 [21.2, 26.2] | - | 7.3 | 4.4 | 0.0 | 0.0 | 5.6 | 0.004 |
| Haiku 5.5 | Docs-only server | 135.1 [95.7, 179.9] | - | 29.2 | 6.7 | 46.9 | 4.5 | 13.4 | 0.010 |
| Haiku 5.5 | pinright MCP | 95.0 [77.2, 113.3] | 30% [4, 46] | 20.1 | 5.6 | 26.1 | 2.0 | 9.1 | 0.007 |
| Opus 5.5 | No docs | 19.0 [17.3, 21.0] | - | 5.7 | 3.2 | 0.0 | 0.0 | 5.4 | 0.099 |
| Opus 5.5 | Docs-only server | 113.2 [78.8, 152.6] | - | 22.8 | 3.8 | 38.6 | 6.4 | 12.4 | 0.263 |
| Opus 5.5 | pinright MCP | 83.9 [67.1, 98.9] | 26% [2, 43] | 16.1 | 3.3 | 23.7 | 1.9 | 9.3 | 0.195 |

Against the docs-only server, pinright used 21% to 33% fewer tokens per run, 3.1 to 4.3 fewer turns and
0.7 to 2.0 `get-docs` calls per run instead of 4.5 to 6.4. The per-arm intervals of tokens overlap for
five of the six model and benchmark pairs; the paired intervals, which compare the same tasks, all stay
above zero. No tools at all used the fewest tokens and cost the least in every cell: the claim is against a
docs server, not against nothing.

**Why pinright reads less.** The transcripts show two different ways to find a version.

- With docs only, the agent used `get-docs` as its version lookup. In the agent benchmark it called it
  once per package, 5.2 to 5.7 times per run, every call before its first file write. 345 of the 398
  calls (87%) named no version, so they returned the latest release's docs, and 299 (75%) put "version"
  or "latest" in the query. One Sonnet run opens with "I'll check the libraries' current versions in
  the docs first." Each call returned 4.8k to 8.0k characters on average.
- With pinright, all 72 agent runs opened with `check-packages` for the whole dependency list (1.0 to
  1.3 calls per run on average, 0.5k to 0.7k characters each), which returns the version to pin. The
  agent then called `get-docs` 0.7 to 1.7 times per run, with a version in 86 of 87 calls; in some runs
  it wrote the code without reading any docs.

The server instructions differ the same way. The full server says to call `check-packages` once with
every dependency, then `get-docs` only for APIs the agent is unsure of. The docs-only server has no
`check-packages`, and every prompt asks the agent to check the libraries before choosing versions
(`DOCS_HINT` in `bench/agents/tasks.ts`), so the agent checked them by reading docs. Fresh input shows
the effect: it about halved in the agent benchmark (16.3k to 8.0k for Sonnet, 26.7k to 14.5k for Haiku,
19.2k to 9.8k for Opus). In the docs benchmark, 47 of 48 pinright runs opened with `check-packages`,
and the docs-only agent made 4.5 to 6.4 `get-docs` calls against 1.6 to 2.0.

## Against a docs MCP server

Run v8, 2026-11-04 (UTC-3), at the 1.0.0 code with Claude Code 2.1.308: the agent and docs benchmarks
above, rerun with a widely used docs MCP server as an extra arm (`--mcp-arm`). It ran locally over stdio,
pinned to one release, with a free API key. We do not ship its config; any server can be run the same
way. Every arm of v8 ran and was scored on the same day, so all of them see the same advisory data.
Two runs per task, arm and model.

Direct dependencies with an advisory, and whole-tree alerts per project (24 projects per cell):

| Task set, model | No tools | Docs MCP server | pinright | Both installed |
|---|---|---|---|---|
| Our 12 tasks, Sonnet 5.5 | 41%, 33.0 | 28%, 16.6 | 0%, 0.3 | 0%, 0.3 |
| Our 12 tasks, Haiku 5.5 | 40%, 29.4 | 31%, 14.7 | 0%, 0.3 | 0%, 0.3 |
| Our 12 tasks, Opus 5.5 | 41%, 32.2 | 35%, 18.6 | 0%, 0.3 | 0%, 0.3 |
| GitHub issues, Sonnet 5.5 | 27%, 24.4 | 15%, 14.7 | 0%, 4.7 | 0%, 4.7 |
| GitHub issues, Haiku 5.5 | 32%, 23.3 | 18%, 11.7 | 0%, 4.7 | 0%, 4.7 |
| GitHub issues, Opus 5.5 | 27%, 27.2 | 21%, 19.0 | 0%, 4.8 | 0%, 4.8 |

Runs that wrote the current API, out of 16:

| Task set, model | No tools | Docs MCP server | pinright |
|---|---|---|---|
| Changed APIs, Sonnet 5.5 | 12 | 13 | 14 |
| Changed APIs, Haiku 5.5 | 10 | 12 | 15 |
| Changed APIs, Opus 5.5 | 12 | 16 | 16 |
| After the training cutoff, Sonnet 5.5 | 0 | 11 | 16 |
| After the training cutoff, Haiku 5.5 | 1 | 13 | 16 |
| After the training cutoff, Opus 5.5 | 0 | n/a | 16 |

Mean tokens per run (everything the model processed, cache reads included):

| Task set, model | No tools | Docs MCP server | pinright | Both installed |
|---|---|---|---|---|
| Our 12 tasks, Sonnet / Haiku / Opus | 15k / 21k / 15k | 53k / 61k / 47k | 43k / 80k / 54k | 53k / 84k / 67k |
| GitHub issues, Sonnet / Haiku / Opus | 16k / 25k / 22k | 50k / 118k / 67k | 71k / 161k / 160k | 75k / 160k / 155k |
| Changed APIs, Sonnet / Haiku / Opus | 17k / 22k / 17k | 53k / 77k / 62k | 70k / 90k / 105k | n/a |
| After the cutoff, Sonnet / Haiku / Opus | 14k / 21k / 15k | 60k / 99k / n/a | 76k / 116k / 133k | n/a |

What the comparison shows, and where it stops:

- The docs MCP server moved agents to newer versions and cut whole-tree alerts by about half. It does
  not check the version the agent pins. Its most common vulnerable pin was `next@16.2.9`
  (20 advisories, 11 runs), the Next.js version it served docs for; `axios@1.13.2` (35 advisories)
  followed in 6 runs.
- With both servers installed, the agent took versions from pinright in nearly every run (6 calls to the
  docs server in 144 runs), and no direct pin carried an advisory.
- pinright matched or beat the docs server on the current API in every cell. With 16 runs per cell the
  intervals overlap, so this is a trend, not a measured difference.
- The docs server used fewer tokens than pinright in most cells: its answers ran 9k to 24k characters
  of tool text per task, pinright's 6k to 41k. pinright used fewer only on our 12 tasks with Sonnet.
- Without a key the server answered most calls with a rate-limit error; we discarded those runs and
  reran the arm with a free key. That key reached its monthly quota during the Opus post-cutoff runs,
  so that cell is missing. In the combined arm the server ran without a key; the agent called it
  6 times in 144 runs.
- `kittentts` installs from a GitHub release wheel, not from PyPI. The docs server's runs pinned it
  that way, correctly; the scorer counts it as a version that does not exist, and the numbers above
  do not count it against any arm.
- One docs server and one release of it, one model vendor, one day of advisory data, tasks we wrote
  or picked, no shell.

## Hook: how often does it get in the way?

We replayed 25,077 commands and file writes (14,902 distinct) from 180 public repositories through
`pinright hook claude` with the default policy: GitHub Actions `run:` steps, package.json scripts,
README and CONTRIBUTING shell lines, Dockerfile `RUN` instructions, Makefile and justfile recipes, and
manifest writes. The hook blocked or asked on 1.46% of them, and denied 0.13% of the entries without
GitHub's `${{ }}` templating. Some of those are true positives, such as a public workflow that
installs `pnpm@8` with 26 advisories. Per-source rates, the root causes we fixed and what still blocks
are in [bench/fp/RESULTS.md](../bench/fp/RESULTS.md).

We also replayed a month of our own Claude Code sessions, 154,402 distinct tool calls. Read by hand,
the hook misread 10 of them after the fixes that replay prompted, against 52 true positives and 79
asks by design ([Real agent sessions](../bench/fp/RESULTS.md#real-agent-sessions-2026-11-02)).

The prompt-injection scanner has its own measurements on real docs and an adversarial corpus: see
[Prompt injection](prompt-injection.md) and
[bench/injection/RESULTS.md](../bench/injection/RESULTS.md). Hook latency is in
[The hook](hook.md#latency).

## Caveats

- Every agent is Claude Code driving a Claude model. The hook supports Codex, Gemini CLI and others;
  this benchmark does not show how they behave.
- We wrote the tasks. They ask for exact pins and name the libraries, which favors a tool that
  answers version questions. A set of 12 tasks taken from public GitHub issues tests this
  ([bench/RESULTS-real-issues.md](../bench/RESULTS-real-issues.md)).
- n is small: 24 runs per arm and model in the agent benchmark, 16 in the docs benchmark.
- The advisory data is from the two days of the run, 2026-11-02 and 2026-11-03. A version clean
  today can carry advisories tomorrow.
- Agents had only Write and Read, no shell, so the hook saw manifest writes and no install commands.
  In a second run with a shell ([bench/RESULTS-shell.md](../bench/RESULTS-shell.md)), the agents
  looked versions up with `npm view` or `pip index versions` before pinning, and every arm, with or
  without pinright, ended at the same 6 alerts per model.

These numbers are not a promise. The share of direct dependencies with an advisory is counted
through pinright's own deps.dev client; the whole-tree alerts from `npm audit` and `pip-audit` are
the independent measure, and installing with no version at all gets the same 0.3. The full list of
caveats is in [bench/RESULTS-v7.md](../bench/RESULTS-v7.md#caveats). The previous run, v6, ran on a
pre-release commit and is kept as [bench/RESULTS-v6.md](../bench/RESULTS-v6.md).

## Reproduce

The commands for every run, model and report, and what you need installed, are in
[bench/RESULTS-v7.md](../bench/RESULTS-v7.md#reproduce). The raw transcripts are not published; only
the aggregate CSVs are. The agent harness lives in
[bench/agents/](../bench/agents/) (`npm run bench:agents`), the docs harness in
[bench/docs/](../bench/docs/) and the hook replay in [bench/fp/](../bench/fp/). The figures and the
CSVs behind the report regenerate with `npx tsx paper/kit/make-data.ts --agents <stamps> --docs
<stamps>` and `npx tsx paper/kit/make-figures.ts`; [paper/kit/claims.md](../paper/kit/claims.md) maps
every number to its source.
