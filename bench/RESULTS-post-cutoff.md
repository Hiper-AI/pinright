# Docs benchmark, post-cutoff set: APIs released after August 2026

Run on 2026-11-02 and 2026-11-03 from the `bench/docs-post-cutoff` branch (the release branch plus
this set), with Claude Code in headless mode driving Sonnet 5.5, Opus 5.5 and Haiku 5.5: two
repetitions of eight tasks per arm. Method and the v6 set: [DOCS.md](DOCS.md).

**Why this set.** In the v6 set the models wrote the current API of five of the eight libraries with
no docs at all, so those tasks could not tell whether docs helped. Vendors do not publish training
cutoffs. We assumed the Claude 5.5 models may know anything released before about July 2026, and
picked eight APIs whose first release on the registry is dated 2026-08-01 or later. Asked without
docs, Opus and Sonnet said as much ("My knowledge ends in June 2026, and the FastAPI releases I know
of have no built-in OpenTelemetry"). In 7 of the 48 no-docs runs the agent wrote no files and
explained that it could not check the API.

**Result.** Without docs the agent wrote the post-cutoff API in 2 of 48 runs (Sonnet 2, Opus 0, Haiku
0). With pinright it did in 46 of 48 (16, 15 and 15 of 16), and with the docs-only ablation in 45 of 48
(14, 16 and 15). The two docs arms share the docs code and do not differ at this sample size. Both
no-docs passes are Sonnet on pandas 3.1, where it guessed `DataFrame.select` and `filter(pd.col(...))`.
The GitHub issues that proposed them date from April and May 2025 (pandas GH 61317, GH 61522), so a
model can have seen the design before the release.

## The eight tasks and where each API first shipped

Publish times come from the npm `time` field and from the PyPI upload time of the first file (UTC).
"Newest release without it" is the release we checked for the API and did not find it: by its exported
entry points on npm, or by installing it with `uv` and importing it.

| Task | API the check requires | First release with it | Published (UTC) | First stable | Newest release without it | Source |
|---|---|---|---|---|---|---|
| `msw3-node` | `graphql` from `msw/graphql`, `graphql.link(url)`, `listen({ onUnhandledFrame })` | msw 3.0.0 | 2026-09-28 15:45 | same | 2.15.0: no `./graphql` export, `onUnhandledRequest` | [release](https://github.com/mswjs/msw/releases/tag/v3.0.0) |
| `hono-mount` | `mount()` from `hono/mount` on `app.all('/legacy/*')` | hono 4.13.13 | 2026-10-04 03:53 | same | 4.13.12: no `./mount` export | [release](https://github.com/honojs/hono/releases/tag/v4.13.13) |
| `dotenv18-run` | `dotenv run -f .env.local -- node server.js` | dotenv 18.0.0 | 2026-09-17 21:18 | same | 17.4.2: no `bin` | [changelog](https://github.com/motdotla/dotenv/blob/master/CHANGELOG.md) |
| `zod-compile` | `z.compile(schema)` or `import 'zod/compile'` | zod 4.5.0-canary.20260817T190646 | 2026-08-17 22:37 | 4.5.0, 2026-08-28 | 4.4.3 and the earlier 4.5.0 canaries: no `./compile` export | [release](https://github.com/colinhacks/zod/releases/tag/v4.5.0) |
| `polars2-bins` | `bin_intervals(..., right_closed=True)`, `bin_quantiles()` | polars 2.0.0rc1 | 2026-09-02 11:42 | 2.0.0, 2026-10-06 | 1.44.1 (2026-08-26): no `bin_intervals` | [upgrade guide](https://github.com/pola-rs/polars/blob/main/docs/source/releases/upgrade/2.md) |
| `fastapi-telemetry` | `FastAPI(telemetry={...})` with `exclude` and `metrics` off | fastapi 0.142.0 | 2026-09-29 17:56 | same | 0.141.1: no `telemetry` parameter | [release](https://github.com/fastapi/fastapi/releases/tag/0.142.0) |
| `pandas31-select` | `DataFrame.select(...)`, `DataFrame.filter(cond=...)` | pandas 3.1.0rc0 | 2026-09-30 13:55 | 3.1.0, 2026-10-22 | 3.0.5: no `select`, no `cond` | [what's new](https://pandas.pydata.org/docs/whatsnew/v3.1.0.html) |
| `langchain14-mcp` | `from langchain.mcp import MCPAdapter` with a `Path` target | langchain 1.4.0a1 | 2026-08-27 22:20 | 1.4.0, 2026-09-03 | 1.3.14: no `langchain.mcp` | [release](https://github.com/langchain-ai/langchain/releases/tag/langchain%3D%3D1.4.0) |

The prompts name the library and the major ("use the newest Hono 4.x release") and describe the
behavior, not the API: "attach the handler with the way this Hono version provides for mounting an
application built with another framework". Each task also sets a minimum version (`majors[].min`, the
first stable release above), so a run that pins an older release counts as a version miss even when
its code is right. Every task has a reference project in `bench/docs/fixtures/` that scores works and
current, and an old-API variant that loses what it should (`npx tsx bench/docs/selftest.ts --set
post-cutoff`).

## Results

The first table sums up the three models. It gives two intervals: the Wilson interval counts every run
as independent, and the cluster bootstrap resamples tasks. Neither fits two repetitions of eight tasks
well; read both as wide.

<!-- generated:start -->
Runs: `docs-post-sonnet-2026-11-02` (Sonnet 5.5, 2 repetition(s), 48 runs scored), `docs-post-opus-2026-11-02` (Opus 5.5, 2 repetition(s), 48 runs scored), `docs-post-haiku-2026-11-02` (Haiku 5.5, 2 repetition(s), 48 runs scored). 8 tasks per arm (set `post-cutoff`). Brackets: 95% cluster-bootstrap interval of the rate, resampling tasks; with 8 tasks it is wide. The Wilson column treats every run as independent, which repetitions of one task are not, so it is narrower than it should be.

| Model | Arm | Current API, runs | 95% Wilson | 95% task bootstrap | Works (install + build) | Pinned a version with the API | Required checks all present | Runs using a removed API | Runs using a deprecated API | API-equivalent cost / run (USD, list price) | Docs calls / run |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | No docs | **2 / 16** | 13% [3%, 36%] | [0%, 38%] | 9 / 16 | 8 / 16 | 3 / 16 | 4 | 5 | 0.034 | 0.0 |
| Sonnet 5.5 | docs-only (pinright with the security layer off) | **14 / 16** | 88% [64%, 97%] | [63%, 100%] | 16 / 16 | 16 / 16 | 14 / 16 | 0 | 0 | 0.089 | 2.5 |
| Sonnet 5.5 | pinright | **16 / 16** | 100% [81%, 100%] | [100%, 100%] | 16 / 16 | 16 / 16 | 16 / 16 | 0 | 0 | 0.080 | 1.8 |
| Opus 5.5 | No docs | **0 / 16** | 0% [0%, 19%] | [0%, 0%] | 8 / 16 | 10 / 16 | 0 / 16 | 4 | 4 | 0.078 | 0.0 |
| Opus 5.5 | docs-only (pinright with the security layer off) | **16 / 16** | 100% [81%, 100%] | [100%, 100%] | 16 / 16 | 16 / 16 | 16 / 16 | 0 | 0 | 0.292 | 6.9 |
| Opus 5.5 | pinright | **15 / 16** | 94% [72%, 99%] | [81%, 100%] | 15 / 16 | 16 / 16 | 16 / 16 | 1 | 0 | 0.216 | 2.4 |
| Haiku 5.5 | No docs | **0 / 16** | 0% [0%, 19%] | [0%, 0%] | 12 / 16 | 8 / 16 | 0 / 16 | 5 | 4 | 0.003 | 0.0 |
| Haiku 5.5 | docs-only (pinright with the security layer off) | **15 / 16** | 94% [72%, 99%] | [81%, 100%] | 15 / 16 | 16 / 16 | 16 / 16 | 0 | 0 | 0.010 | 4.6 |
| Haiku 5.5 | pinright | **15 / 16** | 94% [72%, 99%] | [81%, 100%] | 16 / 16 | 16 / 16 | 15 / 16 | 0 | 0 | 0.008 | 2.4 |

### Sonnet 5.5 (`claude-sonnet-5-5`, run `docs-post-sonnet-2026-11-02`)

| Metric | No docs | docs-only (pinright with the security layer off) | pinright |
|---|---|---|---|
| **Current API** (works, right major, every check passes) | **2 / 16** (13% [0%, 38%]) | **14 / 16** (88% [63%, 100%]) | **16 / 16** (100% [100%, 100%]) |
| Works (installs, builds, smoke test passes) | 9 / 16 | 16 / 16 | 16 / 16 |
| Installs | 12 / 16 | 16 / 16 | 16 / 16 |
| Builds / type-checks / imports | 9 / 16 | 16 / 16 | 16 / 16 |
| Pinned the asked major, at or above the first release with the API | 8 / 16 | 16 / 16 | 16 / 16 |
| All required new-API checks present | 3 / 16 | 14 / 16 | 16 / 16 |
| Runs using a removed API | 4 | 0 | 0 |
| Runs using a deprecated API | 5 | 0 | 0 |
| API checks passed (all kinds) | 41% | 97% | 100% |
| API-equivalent cost per run (USD, list price, mean) | 0.034 | 0.089 | 0.080 |
| API-equivalent cost, all runs of the arm (USD, list price) | 0.55 | 1.43 | 1.27 |
| Turns per run (mean) | 3.6 | 7.0 | 7.2 |
| Duration per run (s, mean) | 20.0 | 38.2 | 34.1 |
| MCP calls per run (mean) | 0.0 | 3.0 | 3.2 |
| Docs calls per run (mean) | 0.0 | 2.5 | 1.8 |
| Docs returned per run (k chars, mean) | 0.0 | 27.6 | 21.0 |

#### Per task, Sonnet 5.5

Each cell: runs with the current API / runs that work (build + smoke test) / runs that build, out of the repetitions. Failed checks follow, with how many runs failed each (r = required missing, x = removed API used, d = deprecated API used, v = wrong major pinned).

| Task | No docs | docs-only (pinright with the security layer off) | pinright |
|---|---|---|---|
| msw3-node (Mock Service Worker 3) | **0** / 0 / 0 of 2<br>r:graphql-subpath x2, r:on-unhandled-frame x2, x:graphql-root x2, x:on-unhandled-request x2, x:graphql-bare-query | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| hono-mount (Hono 4.13) | **0** / 2 / 2 of 2<br>r:mount-middleware x2, d:app-mount x2, v:hono@4.10.0 x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| dotenv18-run (dotenv 18) | **0** / 2 / 2 of 2<br>r:dotenv-run x2, x:preload-args x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| zod-compile (Zod 4.5) | **0** / 0 / 0 of 2<br>r:z-compile, v:, v:zod@4.3.6 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| polars2-bins (Polars 2) | **0** / 2 / 2 of 2<br>r:bin-intervals x2, r:bin-quantiles x2, d:cut-qcut x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| fastapi-telemetry (FastAPI 0.142+) | **0** / 1 / 1 of 2<br>r:telemetry-param x2, r:telemetry-exclude x2, r:telemetry-metrics-off x2, v:, v:fastapi@0.115.12 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| pandas31-select (pandas 3.1) | **2** / 2 / 2 of 2 | **0** / 2 / 2 of 2<br>r:filter-cond x2 | **2** / 2 / 2 of 2 |
| langchain14-mcp (LangChain 1.4) | **0** / 0 / 0 of 2<br>r:langchain-mcp x2, d:adapters-package, v:langchain@1.0.0, r:create-agent, v: | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |

#### Runs that do not work, Sonnet 5.5

**No docs**: 

- fastapi-telemetry r1: `install failed: no manifest`
- langchain14-mcp r1: `install failed: × No solution found when resolving dependencies:`
- langchain14-mcp r2: `install failed: no manifest`
- msw3-node r1: `npm run build failed: src/mocks/handlers.ts(1,10): error TS2305: Module '"msw"' has no exported member 'graphql'.`
- msw3-node r2: `npm run build failed: src/mocks/handlers.ts(1,10): error TS2305: Module '"msw"' has no exported member 'graphql'.`
- zod-compile r1: `install failed: no manifest`
- zod-compile r2: `npm run build failed: src/events.ts(15,60): error TS2339: Property 'compile' does not exist on type 'typeof import("C:/Users/Juan Mandelbaum/AppData/Local/Temp/sctx-build-E4VLck/node_modules/zod/index")'.`

**docs-only (pinright with the security layer off)**: none


**pinright**: none


#### Docs tool usage, Sonnet 5.5

| Arm | Calls by tool (total over all runs) | get-docs answers with no matching docs |
|---|---|---|
| docs-only (pinright with the security layer off) | pinright__get-docs 40, pinright__find-library 8 | 0 |
| pinright | pinright__check-packages 21, pinright__get-docs 25, pinright__upgrade-guide 4, pinright__check-package 1 | 0 |

### Opus 5.5 (`claude-opus-5-5`, run `docs-post-opus-2026-11-02`)

| Metric | No docs | docs-only (pinright with the security layer off) | pinright |
|---|---|---|---|
| **Current API** (works, right major, every check passes) | **0 / 16** (0% [0%, 0%]) | **16 / 16** (100% [100%, 100%]) | **15 / 16** (94% [81%, 100%]) |
| Works (installs, builds, smoke test passes) | 8 / 16 | 16 / 16 | 15 / 16 |
| Installs | 12 / 16 | 16 / 16 | 16 / 16 |
| Builds / type-checks / imports | 8 / 16 | 16 / 16 | 15 / 16 |
| Pinned the asked major, at or above the first release with the API | 10 / 16 | 16 / 16 | 16 / 16 |
| All required new-API checks present | 0 / 16 | 16 / 16 | 16 / 16 |
| Runs using a removed API | 4 | 0 | 1 |
| Runs using a deprecated API | 4 | 0 | 0 |
| API checks passed (all kinds) | 41% | 100% | 98% |
| API-equivalent cost per run (USD, list price, mean) | 0.078 | 0.292 | 0.216 |
| API-equivalent cost, all runs of the arm (USD, list price) | 1.24 | 4.67 | 3.46 |
| Turns per run (mean) | 3.7 | 11.4 | 8.2 |
| Duration per run (s, mean) | 31.6 | 65.6 | 55.0 |
| MCP calls per run (mean) | 0.0 | 7.4 | 4.2 |
| Docs calls per run (mean) | 0.0 | 6.9 | 2.4 |
| Docs returned per run (k chars, mean) | 0.0 | 46.6 | 30.7 |

#### Per task, Opus 5.5

Each cell: runs with the current API / runs that work (build + smoke test) / runs that build, out of the repetitions. Failed checks follow, with how many runs failed each (r = required missing, x = removed API used, d = deprecated API used, v = wrong major pinned).

| Task | No docs | docs-only (pinright with the security layer off) | pinright |
|---|---|---|---|
| msw3-node (Mock Service Worker 3) | **0** / 0 / 0 of 2<br>r:graphql-subpath x2, r:on-unhandled-frame x2, x:graphql-root x2, x:on-unhandled-request x2 | **2** / 2 / 2 of 2 | **1** / 1 / 1 of 2<br>x:graphql-bare-query |
| hono-mount (Hono 4.13) | **0** / 2 / 2 of 2<br>r:mount-middleware x2, d:app-mount x2, v:hono@4.10.4 x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| dotenv18-run (dotenv 18) | **0** / 2 / 2 of 2<br>r:dotenv-run x2, x:preload-args x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| zod-compile (Zod 4.5) | **0** / 0 / 0 of 2<br>r:z-compile x2, v: x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| polars2-bins (Polars 2) | **0** / 2 / 2 of 2<br>r:bin-intervals x2, r:bin-quantiles x2, d:cut-qcut x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| fastapi-telemetry (FastAPI 0.142+) | **0** / 0 / 0 of 2<br>r:telemetry-param x2, r:telemetry-exclude x2, r:telemetry-metrics-off x2, v: x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| pandas31-select (pandas 3.1) | **0** / 2 / 2 of 2<br>r:filter-cond x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| langchain14-mcp (LangChain 1.4) | **0** / 0 / 0 of 2<br>r:langchain-mcp x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |

#### Runs that do not work, Opus 5.5

**No docs**: 

- fastapi-telemetry r1: `install failed: no manifest`
- fastapi-telemetry r2: `install failed: no manifest`
- langchain14-mcp r1: `import check failed: from langchain.mcp import MultiServerMCPClient -> ModuleNotFoundError: No module named 'fastmcp'`
- langchain14-mcp r2: `import check failed: from langchain.mcp import MultiServerMCPClient -> ModuleNotFoundError: No module named 'fastmcp'`
- msw3-node r1: `npm run build failed: src/mocks/handlers.ts(1,10): error TS2305: Module '"msw"' has no exported member 'graphql'.`
- msw3-node r2: `npm run build failed: src/mocks/handlers.ts(1,10): error TS2305: Module '"msw"' has no exported member 'graphql'.`
- zod-compile r1: `install failed: no manifest`
- zod-compile r2: `install failed: no manifest`

**docs-only (pinright with the security layer off)**: none


**pinright**: 

- msw3-node r1: `npm run build failed: src/mocks/handlers.ts(10,11): error TS2339: Property 'query' does not exist on type '{ link(url: Path): GraphQLLink; }'.`

#### Docs tool usage, Opus 5.5

| Arm | Calls by tool (total over all runs) | get-docs answers with no matching docs |
|---|---|---|
| docs-only (pinright with the security layer off) | pinright__get-docs 110, pinright__find-library 8 | 2 |
| pinright | pinright__check-packages 21, pinright__get-docs 35, pinright__check-manifest 3, pinright__check-package 5, pinright__upgrade-guide 3 | 0 |

### Haiku 5.5 (`claude-haiku-5-5`, run `docs-post-haiku-2026-11-02`)

| Metric | No docs | docs-only (pinright with the security layer off) | pinright |
|---|---|---|---|
| **Current API** (works, right major, every check passes) | **0 / 16** (0% [0%, 0%]) | **15 / 16** (94% [81%, 100%]) | **15 / 16** (94% [81%, 100%]) |
| Works (installs, builds, smoke test passes) | 12 / 16 | 15 / 16 | 16 / 16 |
| Installs | 15 / 16 | 16 / 16 | 16 / 16 |
| Builds / type-checks / imports | 12 / 16 | 15 / 16 | 16 / 16 |
| Pinned the asked major, at or above the first release with the API | 8 / 16 | 16 / 16 | 16 / 16 |
| All required new-API checks present | 0 / 16 | 16 / 16 | 15 / 16 |
| Runs using a removed API | 5 | 0 | 0 |
| Runs using a deprecated API | 4 | 0 | 0 |
| API checks passed (all kinds) | 38% | 100% | 98% |
| API-equivalent cost per run (USD, list price, mean) | 0.003 | 0.010 | 0.008 |
| API-equivalent cost, all runs of the arm (USD, list price) | 0.05 | 0.16 | 0.13 |
| Turns per run (mean) | 4.1 | 11.1 | 8.4 |
| Duration per run (s, mean) | 30.5 | 60.4 | 55.3 |
| MCP calls per run (mean) | 0.0 | 6.9 | 4.4 |
| Docs calls per run (mean) | 0.0 | 4.6 | 2.4 |
| Docs returned per run (k chars, mean) | 0.0 | 47.0 | 34.1 |

#### Per task, Haiku 5.5

Each cell: runs with the current API / runs that work (build + smoke test) / runs that build, out of the repetitions. Failed checks follow, with how many runs failed each (r = required missing, x = removed API used, d = deprecated API used, v = wrong major pinned).

| Task | No docs | docs-only (pinright with the security layer off) | pinright |
|---|---|---|---|
| msw3-node (Mock Service Worker 3) | **0** / 0 / 0 of 2<br>r:graphql-subpath x2, r:on-unhandled-frame x2, x:graphql-root x2, x:on-unhandled-request x2, x:graphql-bare-query | **1** / 1 / 1 of 2 | **2** / 2 / 2 of 2 |
| hono-mount (Hono 4.13) | **0** / 2 / 2 of 2<br>r:mount-middleware x2, d:app-mount x2, v:hono@4.9.2, v:hono@4.9.7 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| dotenv18-run (dotenv 18) | **0** / 2 / 2 of 2<br>r:dotenv-run x2, x:preload-args x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| zod-compile (Zod 4.5) | **0** / 2 / 2 of 2<br>r:z-compile x2, v:zod@4.1.12 x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| polars2-bins (Polars 2) | **0** / 2 / 2 of 2<br>r:bin-intervals x2, r:bin-quantiles x2, d:cut-qcut x2, x:join-nulls | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| fastapi-telemetry (FastAPI 0.142+) | **0** / 2 / 2 of 2<br>r:telemetry-param x2, r:telemetry-exclude x2, r:telemetry-metrics-off x2, v:fastapi@0.115.12, v:fastapi@0.115.6 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| pandas31-select (pandas 3.1) | **0** / 2 / 2 of 2<br>r:filter-cond x2 | **2** / 2 / 2 of 2 | **1** / 2 / 2 of 2<br>r:filter-cond |
| langchain14-mcp (LangChain 1.4) | **0** / 0 / 0 of 2<br>r:langchain-mcp x2, v:langchain@1.0.3, v:langchain@1.0.8 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |

#### Runs that do not work, Haiku 5.5

**No docs**: 

- langchain14-mcp r1: `import check failed: from langchain.agents import create_agent -> ImportError: cannot import name 'ExecutionInfo' from 'langgraph.runtime'`
- langchain14-mcp r2: `install failed: × No solution found when resolving dependencies:`
- msw3-node r1: `npm run build failed: src/mocks/handlers.ts(1,10): error TS2305: Module '"msw"' has no exported member 'graphql'.`
- msw3-node r2: `npm run build failed: src/mocks/handlers.ts(1,10): error TS2305: Module '"msw"' has no exported member 'graphql'.`

**docs-only (pinright with the security layer off)**: 

- msw3-node r1: `npm run build failed: ../../../../../Juan Mandelbaum/AppData/Local/Temp/sctx-build-NKxigf/node_modules/@mswjs/interceptors/lib/node/index.d.ts(26,46): error TS2552: Cannot find name 'AllowSharedBufferSource'. Did you mea`

**pinright**: none


#### Docs tool usage, Haiku 5.5

| Arm | Calls by tool (total over all runs) | get-docs answers with no matching docs |
|---|---|---|
| docs-only (pinright with the security layer off) | pinright__find-library 37, pinright__get-docs 73 | 2 |
| pinright | pinright__check-packages 20, pinright__get-docs 38, pinright__check-package 6, pinright__check-manifest 3, pinright__find-library 3, pinright__upgrade-guide 1 | 0 |

<!-- generated:end -->

## Where the runs fail

- **No docs.** The agent fell back on what it knew: `graphql` from `msw` (a type error on msw 3),
  `app.mount()` on an older Hono, `node -r dotenv/config ... dotenv_config_path=.env.local` (dotenv 18
  ignores that argument and loads `.env`), `cut` and `qcut` on Polars 2, a boolean mask in brackets on
  pandas, and `langchain_mcp_adapters` or a guessed name under `langchain.mcp`. Pins often predate the
  release with the API: hono 4.9 and 4.10, zod 4.1 and 4.3, fastapi 0.115, langchain 1.0.
- **With docs, 5 misses in 96 runs.** Opus with pinright once wrote `graphql.query()` on msw 3, where
  only `graphql.link(url).query()` exists. pinright's msw answers show the new import paths but not that
  change, and the agent did not ask about it. Sonnet docs-only (twice) and Haiku pinright (once) passed
  the mask to `DataFrame.filter` positionally or as `items=`: pandas 3.1 then selects labels and
  returns no rows, and only `cond=` filters. Haiku docs-only once wrote a tsconfig without the DOM types
  that `@mswjs/interceptors` needs.

## Caveats

- We wrote the eight tasks. Two repetitions, three models from one vendor, one harness. At this size
  the docs-only and pinright arms cannot be told apart.
- "First shipped" means first on the registry. A design can be public earlier, in an issue or a pull
  request; the pandas passes without docs show that a model can know a proposal before its release.
- The checks are static (regular expressions over the agent's files) plus install and build: `tsc
  --noEmit` for the npm tasks, an import check for the PyPI tasks. This set has no runtime smoke test,
  so a run can pass with code that type-checks and still behaves wrong in a way the checks miss.
- For `fastapi-telemetry` and `langchain14-mcp` the "deprecated" checks flag the separate packages
  (`opentelemetry-instrumentation-fastapi`, `langchain-mcp-adapters`) that the prompt rules out.
  Upstream has not deprecated those packages.
- In the first scoring pass one Sonnet pinright run of `langchain14-mcp` failed its import check with
  no import error recorded, only LangChain's beta warning on stderr. Rescoring the same files passed,
  and the table uses the rescore. We did not rescore other runs: each of their failures names a real
  error.
- Cost is Claude Code's API-equivalent at list price (`total_cost_usd`); the runs used the team's
  Claude subscription. Over the 48 runs of each model: USD 3.25 Sonnet, 9.38 Opus, 0.34 Haiku.
- The runs shared the subscription with another benchmark, at concurrency 2. No run hit a rate limit.

## Reproduce

```bash
npm ci && npm run build
npx tsx bench/docs/selftest.ts --set post-cutoff     # reference and old-API projects
export GITHUB_TOKEN=...
for m in sonnet opus haiku; do
  npx tsx bench/docs/run.ts --set post-cutoff --model claude-$m-5-5 --reps 2 --concurrency 2 --stamp docs-post-$m-2026-11-02
  npx tsx bench/docs/run.ts --model claude-$m-5-5 --reps 2 --concurrency 2 --stamp docs-post-$m-2026-11-02 --arms docs-only --resume
  npx tsx bench/docs/score.ts docs-post-$m-2026-11-02 --concurrency 2
done
npx tsx bench/docs/report.ts docs-post-sonnet-2026-11-02 docs-post-opus-2026-11-02 docs-post-haiku-2026-11-02
```

`--resume` reuses the set saved in the run's `config.json`. The report writes the generated part of
this file.
