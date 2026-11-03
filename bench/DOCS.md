# Docs benchmark: do pinright's docs get the new API right?

[AGENTS.md](AGENTS.md) measures what an agent installs. This benchmark measures what it writes: eight
tasks that only come out right with the API of a library's current major, run by Claude Code in
headless mode with and without pinright. We install, build and smoke-test each project at runtime, and
check it for the current API, for APIs the major removed and for deprecated ones.

Short version (run v7, 2026-11-02 and 2026-11-03, three models, code of the 1.0.0 release): with
pinright the agent wrote the current API in 16 of 16 runs with each of Sonnet 5.5, Haiku 5.5 and Opus
5.5; without docs, in 13, 9 and 14 of 16. AI SDK 7 (released 2026-06-25) explains most of the gap: it
reads as newer than what the models saw (no cutoff dates are published), and without docs every model
wrote AI SDK 5/6 code. LangChain 1 broke on version pins for Sonnet once and Haiku twice: an early
1.x `langchain` that does not import against the `langgraph` the resolver installs. Haiku also lost
both ESLint 10 runs and one Pydantic run. The models already know Next 16, Tailwind 4, Zod 4 and
Express 5, so on those tasks the agent runs cannot tell good docs from bad ones. The [retrieval probe](#retrieval-probe-pinrights-docs-without-the-agent)
takes the model out of the loop: on the release candidate pinright's answers show the current API for
24 of 25 typical questions and for 133 of 154 held-out questions over 56 other libraries (sets A, B and
C below: 75 of 81, 25 of 28, 33 of 45). We reran every probe on 2026-11-01 and got the scores of the
end of the third round.

All three models also ran a docs-only ablation: the same server with its security layer off
(`PINRIGHT_ABLATION=docs-only`, see [AGENTS.md](AGENTS.md)). It wrote the current API in 16, 15 and 16
of 16 runs (Sonnet, Haiku, Opus), at a higher cost per run than the full server: without
`check-packages` to settle versions, the agent asked `get-docs` for each package's latest version one
call at a time. In v6 only Sonnet ran this arm (15 of 16).

## Setup

- Models `claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-opus-5-5` (passed as `--model`), Claude
  Code 2.1.308, 2 repetitions per task and arm, concurrency 3.
- Built-in tools limited to Write and Read: no shell, no web. Every arm gets the same prompt. It names
  the major ("use the newest Zod 4 release") but never the new API, and asks the agent to check the
  current API with its documentation tools when it has any.
- Arms: `no-docs` (nothing attached), `pinright` (this repo's `dist/cli.js`, local docs only) and
  `docs-only` (pinright with the security layer off). The harness takes any other MCP server as
  an extra arm with `--mcp-arm name=mcp.json`; this repo ships no config for third-party servers.
- Cost is the API-equivalent at list price that Claude Code reports per transcript. The runs used a
  Claude subscription, so nobody paid that amount.
- **Current API**: the project installs, builds or type-checks, passes its runtime smoke test, pins the
  asked major, uses every required new API and no removed or deprecated one. **Works** drops the API
  checks: it installs, builds and passes the smoke test.
- We wrote the checks from each library's migration guide and checked them against the published type
  definitions. `bench/docs/selftest.ts` scores a hand-written reference solution per task (it must come
  out current) and the same project written with the previous major's API (it must lose what it
  should). `test/benchDocs.test.ts` covers the static checks, including two false positives seen in
  real runs.

| Task | Current major | What only the new API gets right | Smoke test | Sources |
|---|---|---|---|---|
| next16-proxy | Next.js 16.4 | `proxy.ts` (not `middleware.ts`), awaited `cookies()` and `params`, `revalidateTag(tag, profile)` | `next start`: redirect without the cookie, page with it | [upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16), [proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy) |
| tailwind4-vite | Tailwind CSS 4.3 | `@import "tailwindcss"`, `@theme`, `@utility`, `@custom-variant dark`, `@tailwindcss/vite` | built CSS has the theme color, the utility and class-based dark mode | [upgrade guide](https://tailwindcss.com/docs/upgrade-guide), [dark mode](https://tailwindcss.com/docs/dark-mode) |
| zod4-schema | Zod 4.6 | `z.email()`, `error` instead of `message`, `z.enum(TsEnum)`, `z.strictObject`, two-argument `z.record` | valid and invalid signups through the agent's module | [changelog](https://zod.dev/v4/changelog), [error formatting](https://zod.dev/error-formatting) |
| ai-sdk7-chat | AI SDK 7.0 | `instructions`, `isStepCount`, `createUIMessageStreamResponse(toUIMessageStream(...))`, `inputSchema`, `sendMessage` | none (needs a model); `next build` type-checks it | [7.0 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0), `ai@7` `.d.ts` |
| express5-api | Express 5.3 | named wildcards (`/*splat`), `{.:ext}` optional segments, async errors reach the error handler | every route over HTTP, including a throwing async handler | [migration guide](https://expressjs.com/en/guide/migrating-5.html) |
| eslint10-flat | ESLint 10.13 | `eslint.config.*`, no `.eslintrc`/`.eslintignore`/`--ext`, `defineConfig` over `tseslint.config()` | ESLint on probe files: `no-console` warns in `src/`, off in `scripts/`, `dist/` ignored | [v10 migration](https://eslint.org/docs/latest/use/migrate-to-10.0.0), [typescript-eslint](https://typescript-eslint.io/packages/typescript-eslint/#config-deprecated) |
| pydantic2-models | Pydantic 2.14 | `field_validator`, `model_validator`, `ConfigDict`, `model_dump*`/`model_validate`, `pattern=` | the agent's models, with deprecation warnings recorded | [migration guide](https://pydantic.dev/docs/validation/latest/get-started/migration/) |
| langchain1-agent | LangChain 1.4 | `from langchain.agents import create_agent`, `system_prompt=` | the agent builds offline and has a tools node | [v1 migration](https://docs.langchain.com/oss/python/migrate/langchain-v1) |

## Results

<!-- generated:start -->
Runs: `docs-v7-sonnet-2026-11-02` (Sonnet 5.5, 2 repetition(s), 48 runs scored), `docs-v7-haiku-2026-11-02` (Haiku 5.5, 2 repetition(s), 48 runs scored), `docs-v7-opus-2026-11-02` (Opus 5.5, 2 repetition(s), 48 runs scored). 8 tasks per arm (set `v6`). Brackets: 95% cluster-bootstrap interval of the rate, resampling tasks; with 8 tasks it is wide.

### Sonnet 5.5 (`claude-sonnet-5-5`, run `docs-v7-sonnet-2026-11-02`)

| Metric | No docs | docs-only (pinright with the security layer off) | pinright |
|---|---|---|---|
| **Current API** (works, right major, every check passes) | **13 / 16** (81% [56%, 100%]) | **16 / 16** (100% [100%, 100%]) | **16 / 16** (100% [100%, 100%]) |
| Works (installs, builds, smoke test passes) | 13 / 16 | 16 / 16 | 16 / 16 |
| Installs | 14 / 16 | 16 / 16 | 16 / 16 |
| Builds / type-checks / imports | 13 / 16 | 16 / 16 | 16 / 16 |
| Smoke test passes (7 tasks with one) | 13 / 14 | 14 / 14 | 14 / 14 |
| Pinned the asked major | 16 / 16 | 16 / 16 | 16 / 16 |
| All required new-API checks present | 14 / 16 | 16 / 16 | 16 / 16 |
| Runs using a removed API | 0 | 0 | 0 |
| Runs using a deprecated API | 2 | 0 | 0 |
| API checks passed (all kinds) | 92% | 100% | 100% |
| API-equivalent cost per run (USD, list price, mean) | 0.044 | 0.120 | 0.084 |
| API-equivalent cost, all runs of the arm (USD, list price) | 0.71 | 1.93 | 1.34 |
| Turns per run (mean) | 5.3 | 11.7 | 8.1 |
| Duration per run (s, mean) | 18.4 | 38.4 | 29.4 |
| MCP calls per run (mean) | 0.0 | 6.4 | 2.9 |
| Docs calls per run (mean) | 0.0 | 5.4 | 1.7 |
| Docs returned per run (k chars, mean) | 0.0 | 34.4 | 19.5 |

#### Per task, Sonnet 5.5

Each cell: runs with the current API / runs that work (build + smoke test) / runs that build, out of the repetitions. Failed checks follow, with how many runs failed each (r = required missing, x = removed API used, d = deprecated API used, v = wrong major pinned).

| Task | No docs | docs-only (pinright with the security layer off) | pinright |
|---|---|---|---|
| next16-proxy (Next.js 16) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| tailwind4-vite (Tailwind CSS 4) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| zod4-schema (Zod 4) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| ai-sdk7-chat (AI SDK 7) | **0** / 0 / 0 of 2<br>r:instructions x2, r:is-step-count x2, d:step-count-is x2, r:ui-stream-response x2, d:result-response-helper x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| express5-api (Express 5) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| eslint10-flat (ESLint 10) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| pydantic2-models (Pydantic 2) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| langchain1-agent (LangChain 1) | **1** / 1 / 1 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |

#### Runs that do not work, Sonnet 5.5

**No docs**: 

- ai-sdk7-chat r1: `install failed: npm warn deprecated next@16.0.0: This version has a security vulnerability. Please upgrade to a patched version. See https://nextjs.org/blog/CVE-2025-66478 for more details.`
- ai-sdk7-chat r2: `install failed: npm warn deprecated next@16.0.1: This version has a security vulnerability. Please upgrade to a patched version. See https://nextjs.org/blog/CVE-2025-66478 for more details.`
- langchain1-agent r2: `import check failed: from langchain.agents import create_agent -> ImportError: cannot import name 'ExecutionInfo' from 'langgraph.runtime'`

**docs-only (pinright with the security layer off)**: none


**pinright**: none


#### Docs tool usage, Sonnet 5.5

| Arm | Calls by tool (total over all runs) | get-docs answers with no matching docs |
|---|---|---|
| docs-only (pinright with the security layer off) | pinright__get-docs 86, pinright__find-library 17 | 4 |
| pinright | pinright__check-packages 19, pinright__get-docs 25, pinright__upgrade-guide 2 | 0 |

### Haiku 5.5 (`claude-haiku-5-5`, run `docs-v7-haiku-2026-11-02`)

| Metric | No docs | docs-only (pinright with the security layer off) | pinright |
|---|---|---|---|
| **Current API** (works, right major, every check passes) | **9 / 16** (56% [25%, 88%]) | **15 / 16** (94% [81%, 100%]) | **16 / 16** (100% [100%, 100%]) |
| Works (installs, builds, smoke test passes) | 9 / 16 | 15 / 16 | 16 / 16 |
| Installs | 14 / 16 | 16 / 16 | 16 / 16 |
| Builds / type-checks / imports | 11 / 16 | 15 / 16 | 16 / 16 |
| Smoke test passes (7 tasks with one) | 9 / 14 | 14 / 14 | 14 / 14 |
| Pinned the asked major | 16 / 16 | 16 / 16 | 16 / 16 |
| All required new-API checks present | 14 / 16 | 16 / 16 | 16 / 16 |
| Runs using a removed API | 0 | 0 | 0 |
| Runs using a deprecated API | 3 | 0 | 0 |
| API checks passed (all kinds) | 91% | 100% | 100% |
| API-equivalent cost per run (USD, list price, mean) | 0.004 | 0.010 | 0.007 |
| API-equivalent cost, all runs of the arm (USD, list price) | 0.06 | 0.16 | 0.12 |
| Turns per run (mean) | 5.6 | 13.4 | 9.1 |
| Duration per run (s, mean) | 20.2 | 37.2 | 30.5 |
| MCP calls per run (mean) | 0.0 | 8.2 | 4.0 |
| Docs calls per run (mean) | 0.0 | 4.5 | 2.1 |
| Docs returned per run (k chars, mean) | 0.0 | 45.4 | 24.8 |

#### Per task, Haiku 5.5

Each cell: runs with the current API / runs that work (build + smoke test) / runs that build, out of the repetitions. Failed checks follow, with how many runs failed each (r = required missing, x = removed API used, d = deprecated API used, v = wrong major pinned).

| Task | No docs | docs-only (pinright with the security layer off) | pinright |
|---|---|---|---|
| next16-proxy (Next.js 16) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| tailwind4-vite (Tailwind CSS 4) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| zod4-schema (Zod 4) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| ai-sdk7-chat (AI SDK 7) | **0** / 0 / 0 of 2<br>r:instructions x2, r:is-step-count x2, d:step-count-is x2, r:ui-stream-response x2, d:result-response-helper x2 | **1** / 1 / 1 of 2 | **2** / 2 / 2 of 2 |
| express5-api (Express 5) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| eslint10-flat (ESLint 10) | **0** / 0 / 2 of 2<br>d:tseslint-config | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| pydantic2-models (Pydantic 2) | **1** / 1 / 1 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| langchain1-agent (LangChain 1) | **0** / 0 / 0 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |

#### Runs that do not work, Haiku 5.5

**No docs**: 

- ai-sdk7-chat r1: `npm run build failed: Failed to compile.`
- ai-sdk7-chat r2: `install failed: npm error code ETARGET`
- eslint10-flat r1: `smoke: config-loads (exit 2: Oops! Something went wrong! :( ESLint: 10.0.0 TypeError: Class extends value undefined is not a constructor or null at Object.<anonymous>; parses-ts ([]); no-console-warns-in-src ([]); no-con`
- eslint10-flat r2: `smoke: config-loads (exit 2: Oops! Something went wrong! :( ESLint: 10.0.0 TypeError: Class extends value undefined is not a constructor or null at Object.<anonymous>; parses-ts ([]); no-console-warns-in-src ([]); no-con`
- langchain1-agent r1: `import check failed: from langchain.agents import create_agent -> ImportError: cannot import name 'ExecutionInfo' from 'langgraph.runtime'`
- langchain1-agent r2: `import check failed: from langchain.agents import create_agent -> TypeError: Reviver.__init__() got an unexpected keyword argument 'allowed_objects'`
- pydantic2-models r1: `install failed: × No solution found when resolving dependencies:`

**docs-only (pinright with the security layer off)**: 

- ai-sdk7-chat r2: `npm run build failed: > Build error occurred`

**pinright**: none


#### Docs tool usage, Haiku 5.5

| Arm | Calls by tool (total over all runs) | get-docs answers with no matching docs |
|---|---|---|
| docs-only (pinright with the security layer off) | pinright__find-library 59, pinright__get-docs 72 | 1 |
| pinright | pinright__check-packages 19, pinright__get-docs 32, pinright__check-package 9, pinright__check-manifest 3, pinright__upgrade-guide 1 | 0 |

### Opus 5.5 (`claude-opus-5-5`, run `docs-v7-opus-2026-11-02`)

| Metric | No docs | docs-only (pinright with the security layer off) | pinright |
|---|---|---|---|
| **Current API** (works, right major, every check passes) | **14 / 16** (88% [63%, 100%]) | **16 / 16** (100% [100%, 100%]) | **16 / 16** (100% [100%, 100%]) |
| Works (installs, builds, smoke test passes) | 16 / 16 | 16 / 16 | 16 / 16 |
| Installs | 16 / 16 | 16 / 16 | 16 / 16 |
| Builds / type-checks / imports | 16 / 16 | 16 / 16 | 16 / 16 |
| Smoke test passes (7 tasks with one) | 14 / 14 | 14 / 14 | 14 / 14 |
| Pinned the asked major | 16 / 16 | 16 / 16 | 16 / 16 |
| All required new-API checks present | 14 / 16 | 16 / 16 | 16 / 16 |
| Runs using a removed API | 0 | 0 | 0 |
| Runs using a deprecated API | 2 | 0 | 0 |
| API checks passed (all kinds) | 92% | 100% | 100% |
| API-equivalent cost per run (USD, list price, mean) | 0.099 | 0.263 | 0.195 |
| API-equivalent cost, all runs of the arm (USD, list price) | 1.58 | 4.20 | 3.13 |
| Turns per run (mean) | 5.4 | 12.4 | 9.3 |
| Duration per run (s, mean) | 30.7 | 47.4 | 41.5 |
| MCP calls per run (mean) | 0.0 | 7.2 | 3.8 |
| Docs calls per run (mean) | 0.0 | 6.4 | 1.9 |
| Docs returned per run (k chars, mean) | 0.0 | 38.1 | 22.6 |

#### Per task, Opus 5.5

Each cell: runs with the current API / runs that work (build + smoke test) / runs that build, out of the repetitions. Failed checks follow, with how many runs failed each (r = required missing, x = removed API used, d = deprecated API used, v = wrong major pinned).

| Task | No docs | docs-only (pinright with the security layer off) | pinright |
|---|---|---|---|
| next16-proxy (Next.js 16) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| tailwind4-vite (Tailwind CSS 4) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| zod4-schema (Zod 4) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| ai-sdk7-chat (AI SDK 7) | **0** / 2 / 2 of 2<br>r:instructions x2, r:is-step-count x2, d:step-count-is x2, r:ui-stream-response x2, d:result-response-helper x2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| express5-api (Express 5) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| eslint10-flat (ESLint 10) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| pydantic2-models (Pydantic 2) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| langchain1-agent (LangChain 1) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |

#### Runs that do not work, Opus 5.5

**No docs**: none


**docs-only (pinright with the security layer off)**: none


**pinright**: none


#### Docs tool usage, Opus 5.5

| Arm | Calls by tool (total over all runs) | get-docs answers with no matching docs |
|---|---|---|
| docs-only (pinright with the security layer off) | pinright__get-docs 102, pinright__find-library 13 | 2 |
| pinright | pinright__check-packages 18, pinright__get-docs 30, pinright__upgrade-guide 1, pinright__check-package 7, pinright__check-manifest 4 | 0 |

<!-- generated:end -->

## Where the runs fail (v7)

**No docs, all three models.**
- **AI SDK 7**: AI SDK 5/6 code in all 6 runs: `system:` instead of `instructions:`, `stepCountIs`
  instead of `isStepCount`, `result.toUIMessageStreamResponse()`. All three still compile in 7 as
  deprecated aliases, so Opus's two runs work but are not current. Sonnet's two runs fail
  `npm install` (Next 16.0.0 and 16.0.1 with `@ai-sdk/react` 4.0.0). Haiku r1 fails `next build`, and
  Haiku r2 pinned `@ai-sdk/openai` and `@ai-sdk/react` 7.0.0, versions that do not exist, so
  `npm install` fails with `ETARGET`.
- **LangChain 1**: 3 of 6 runs fail the import check. Sonnet r2 pinned `langchain` 1.2.0 and Haiku
  pinned 1.0.3 twice, none with a `langgraph` pin; the resolver installs the newest `langgraph`, and
  `from langchain.agents import create_agent` dies with `ImportError: cannot import name
  'ExecutionInfo'` or `TypeError: Reviver.__init__() got an unexpected keyword argument
  'allowed_objects'`. The runs that pinned `langchain` 1.0.0 imported. pinright pinned 1.4.7 in every
  run.
- **ESLint 10, Haiku**: both runs used `tseslint.config()`, deprecated in favor of `defineConfig`, and
  pinned `typescript-eslint` 8.46.0 next to ESLint 10.0.0; its utils extend a class ESLint 10 removed,
  and ESLint crashes loading the config.
- **Pydantic 2, Haiku r1**: the agent pinned `pydantic` 2.12.0 and four of its dependencies by hand,
  and `uv pip install` found no solution for the set. The code itself passed every API check.

**docs-only.** Haiku's AI SDK r2 run fails `next build`. The other 47 runs across the three models were
current.

**pinright.** No run failed with any model.

The v5 diagnosis of the Next.js 16.0.0 pin (proxy never ran under `next start`) did not recur: in v7
the no-docs next16-proxy runs pinned 16.0.1 to 16.1.1 and all passed the smoke test, and pinright
pinned 16.4.3.

In v6 (2026-11-01, pre-release commit `b2fcfe2`) the same set scored 13, 10 and 12 of 16 without docs,
16 of 16 with pinright on every model, and 15 of 16 for Sonnet's docs-only arm.

## Retrieval probe: pinright's docs without the agent

Rerun on 2026-11-01 on the release candidate, cold cache, same questions as the rounds described below
(output in `bench/docs/runs/probes-v6/`, not committed):

| Probe | Questions | Answered with the current API |
|---|---|---|
| Original (the eight tasks) | 25 | 24 |
| Held-out set A (looked at while tuning) | 81 | 75 |
| Held-out set B (untouched since round two) | 28 | 25 |
| Held-out set C (untouched, written before round three) | 45 | 33 |
| All held-out (`--set all`) | 154 | 133 |

The misses are the ones listed at the end of the third round. The rest of this section and the next
ones record how the scores got there, round by round.

`bench/docs/retrieval.ts` sends pinright's docs pipeline 25 questions an agent asks on these tasks, some
phrased with the old API's words ("middleware", "darkMode class"), and checks that the answer shows the
current API. `bench/docs/replay.ts` replays the exact `get-docs` calls the agents made in the run and
counts the task's new-API markers in the answers. On the base code it returns answers of the same
length and with the same markers as the ones recorded in the transcripts.

| | Base (`e644213`) | This branch |
|---|---|---|
| Probe questions answered with the current API | 16 / 25 | 20 / 25 |
| New-API markers in the answers to the agents' own questions (16 runs) | 46 / 66 | 51 / 66 |

Per task, base to branch: Tailwind went from 0 to 3 of 4 probes and from 2 to 10 of 10 replay markers.
Pydantic went from 2 to 3 of 4 probes, but from 10 to 6 of 12 markers on the agents' long multi-topic
question (see below). ESLint gained one marker. The other tasks did not change.

## Diagnosis: where pinright's docs fall short

The pinright arm never lost a task, so this section comes from the transcripts and the probe.

**Tailwind CSS: no docs at all (fixed).** The `tailwindcss` npm package ships a README and type
definitions; tailwindcss.com publishes no `llms.txt` and no `.md` pages; the docs live in the
`tailwindlabs/tailwindcss.com` repo. Every Tailwind query returned the README plus
`default-theme.d.ts`, with nothing about `@theme`, `@utility` or `@custom-variant`. The agents wrote v4
from memory. Fix: `src/data/docsRepos.ts` takes npm entries now, and pinright reads Tailwind from that
repo's `src/docs/`.

**Next.js and ESLint: the right page lost to common words (fixed).** For "protect /dashboard routes
with middleware, redirect to /login...", path ranking counted every query word the same. Dozens of
paths contain "redirect" or "routes" (`skipTrailingSlashRedirect`, `typedRoutes`), so `middleware.mdx`,
the page that says it became `proxy.js`, missed the 8-file cut. ESLint's `configuration-files.md` lost
the same way to `extend/plugins.md`. Fix: path hits count by how rare the word is in the tree. A first
version weighed rarity too hard and pushed `proxy.md` out of a multi-topic question ("proxy.ts;
revalidateTag; async params and cookies()") in favor of `staleTimes`, `errors/*` and `evals/*`. The
committed version uses a milder weight, takes 12 path hits instead of 8, and first picks the files that
cover a query word no earlier pick covers.

**Wrong registry from the agent's own arguments (fixed).** Agents sent `npm:pydantic` with
`ecosystem: "pypi"` and `npm:placeholder` with `packageName: "langchain"`. pinright ignored both
arguments for ids in its own format and answered with the npm packages `pydantic` (no docs found) and
`placeholder` (an 865-character README). Each cost the agent a call. An explicit `ecosystem` or
`packageName` now overrides the id; in the rerun the same kind of call returned 9,730 characters of
LangChain 1 agent docs.

**AI SDK: one step from five framework guides (fixed).** The `ai` package ships its docs, and a
question about a route handler got the multi-step section of the Next.js App Router, Pages Router, Nuxt
and TanStack Start guides: four copies of one example. A near-duplicate filter now drops sections that
share 70% of their words with one already picked. "System prompt" never reached `instructions:`; the
rename hints of the [held-out round](#held-out-probe-and-the-second-round-of-fixes) fixed that.

**Pydantic: API reference outranks the concept pages (mostly fixed).** For a question that names six
features at once, the answer filled with wheel docstrings and missed `field_validator`,
`model_validator` and `pattern=`. With one section per topic, the agents' own question gets 4 of 6
markers (it had 3 of 6 on the first branch, 5 of 6 on the base); `from_attributes` and `pattern=` still
miss there. The single-topic probe "regex constraint on a string field" now finds `pattern=`.

The four probe misses listed here before the held-out round (Tailwind with Vite, Zod's three-topic
question, LangChain `@tool`, Next's `evals/*` and `errors/*`) are covered in the next section; only
Zod's stays open.

## Held-out probe and the second round of fixes

The 25-question probe covers the eight benchmark tasks, and tuning against it overfits. `bench/docs/probe-heldout.ts`
adds 109 questions over 41 libraries outside the benchmark, at their latest stable versions on
2026-10-29. Each question expects strings of the current API, checked against the official docs or
changelog linked next to it (React 19, React Router 8, TanStack Query 5, Svelte 5, Vue 3.5, Astro 7,
Angular 22, Vite 8, Vitest 5, Playwright, Prisma 7, Drizzle, Hono, Fastify 5, NestJS 12, tRPC 11,
Supabase, Stripe, the Anthropic and OpenAI SDKs, FastAPI, SQLAlchemy 2.1, Django 6.1, Polars 2,
pytest 9, httpx, Celery, Typer; set B: Mongoose 9, Redux Toolkit, Zustand 5, Better Auth, SvelteKit 3,
Jotai 3, pandas 3, NumPy 2.5, Requests, Flask 3.1, pydantic-settings, SQLModel).

We wrote both sets and scored them before changing any code. We then read the misses of set A (81
questions) to find what to fix. We scored set B (28 questions) only at the start and at the end and
never looked at its answers in between, so set B is the honest number.

| | Base (`dd570aa`) | This branch |
|---|---|---|
| Original probe (25 questions) | 20 | 24 |
| Held-out set A (81 questions, looked at) | 53 | 63 |
| Held-out set B (28 questions, untouched) | 22 | 25 |
| Replay: new-API markers in the agents' own questions (16 runs) | 51 / 66 | 58 / 66 |
| Mean answer, set A (chars) | 9,795 | 9,800 |
| Replay answers, total chars | 340,333 | 349,281 |
| Set A, cold cache: total / median per question | 256 s / 1.37 s | 231 s / 1.35 s |
| Set A, warm cache: total / median per question | 14.3 s / 147 ms | 27.7 s / 231 ms |

Answers stay the same size. On a cold cache the network dominates and nothing changed. On a warm
cache an answer takes about 100 ms more, spent scanning every section for prompt injection before
merging and reading the deprecations of the package's type definitions (460 KB for `ai`).

What changed, in the order we measured it (original / set A / replay):

| Change | Original | Set A | Replay |
|---|---|---|---|
| Base | 20 | 53 | 51 |
| Contributor and agent notes, evals, example apps rank below user docs (`AGENTS.md`, `.agents/skills`, `docs/plans`, React's compiler passes, Next's `evals/` and `errors/`) | 20 | 53 | 51 |
| `llms.txt` parser bug: a `\s` crossed line breaks and each entry swallowed the next, so react.dev lost `useActionState`, `useOptimistic` and `use`, and LangChain its tools page | 21 | 56 | 51 |
| Plural and singular count as one term ("error" finds `handling-errors.md`) | 22 | 59 | 48 |
| Multi-topic questions: split on `;`, `,`, `:`; each topic gets its best section, llms.txt page and Python module first | 23 | 59 | 59 |
| Rename hints from the package's own files (see below) | 24 | 59 | 59 |
| Older-major copies (`v3/`, `docs-v3/`, `legacy/`) and `blog/` count as upgrade notes; small sibling sections merge; exact API names (`z.record`, `pattern=`) weigh in; a topic's best section is cut to its share | 23 | 60 | 58 |
| Code that a page includes from another file (`{* docs_src/x.py *}`, `--8<--`, `literalinclude`, `<<<`) | 23 | 61 | 58 |
| Django's `docs/**/*.txt` read as reStructuredText; `releases/` folders count as upgrade notes | 23 | 61 | 58 |
| Deep `.d.ts` files whose path names the question (NestJS `use-guards.decorator.d.ts`) | 23 | 63 | 58 |
| The current major's migration guide is a candidate for every question, ranked below the reference | 24 | 63 | 58 |

A phrase bonus (adjacent query words in a section) cost 3 replay markers and fixed nothing; we dropped
it.

**Rename hints.** An agent asks with the names it learned; the docs answer with the new ones. pinright
now reads the renames a version announces from the package itself: `@deprecated Use \`instructions\`
instead.` on the `system` option of `ai`'s entry `.d.ts`, `@deprecated("on_event is deprecated, use
lifespan ...")` on FastAPI's `on_event`, "`cacheTime` → `gcTime`" in TanStack Query's v5 migration
guide. The replacement has to be declared in the API ("use literal values instead" names nothing).
When a question uses an old name as written, the new one joins the question next to it, and the answer
opens with a fenced line: "Renamed or deprecated in ai@7.0.157, per the package's own files: `system`
-> `instructions` (dist/index.d.ts)". Over the 106 probe questions, it fired three times, all right:
AI SDK `system`, TanStack `cacheTime`, FastAPI `on_event`. No library has a hand-written entry.

**Remaining misses in set A (18), by cause:**
- Docs that live only on a site pinright cannot read (7): Supabase (3), Astro's content collections, actions and server islands (docs in
  `withastro/docs`, no llms.txt found from `astro.build`), Stripe's checkout sessions. A mapping in
  `docsRepos.ts` would fix each, but adding one per held-out library would be tuning to the probe.
- Examples in a format pinright does not expand (2): Polars' `{{code_block(...)}}` macros pull its code from
  `docs/source/src/python/`, so `.agg(` and `.collect()` never appear.
- SDKs whose generated API types outnumber the prose (4): OpenAI's `responses.parse`, Anthropic's
  `system=` (Python) and `system:` (TypeScript), Anthropic's `input_schema`. The README shows them, but
  dozens of generated `types/*` modules match the question's words better.
- The question names the old API (1): React Router "useNavigate in onSubmit" gets the `useNavigate`
  page; React Router 8 never deprecated it, so no rename hint applies.
- Ranking (4): Prisma's `defineConfig` (the config page loses to the connection-URL pages), NestJS
  `ValidationPipe` ("validate" against "validation") and constructor injection, Django's
  `UniqueConstraint` (the field-options page outranks `constraints.txt`).

The one miss left in the original probe is Zod's three-topic question: "reject unknown keys" matches a
CSP section that "rejects new Function" better than the `z.strictObject` section, which says "throws
on unknown keys".

**Set B misses after (3):** pandas 3's default `str` dtype, Flask's `SECRET_KEY_FALLBACKS`, and
SQLModel's partial update (`sqlmodel_update`), which passed on the base. Set B gained Jotai 3 (2),
pydantic-settings' `env_nested_delimiter` and SQLModel's `select().where()`.

## Third round: docs sites found from metadata, set C

Before changing code we wrote set C: 45 questions over 15 libraries outside sets A and B and the
benchmark (Nuxt 4, SolidStart 2, Elysia, Effect 4, Kysely, BullMQ 6, Pino 10, Litestar, Pandera,
DuckDB 2, LangGraph, LlamaIndex, Instructor, Ruff, uv), with expected strings checked against the
docs or changelog linked next to each. We scored it on main and again at the end, and read none of
its answers in between. We tuned on set A's misses only.

| | Main (`d2f082a`) | This branch |
|---|---|---|
| Original probe (25 questions) | 24 | 24 |
| Held-out set A (81, looked at) | 63 | 75 |
| Held-out set B (28, untouched since round two) | 25 | 25 |
| Held-out set C (45, untouched) | 28 | 33 |
| Replay: new-API markers (16 runs) | 58 / 66 | 58 / 66 |
| Mean answer, set A (chars) | 9,800 | 10,270 |
| Replay answers, total chars | 349,451 | 356,007 |
| Set A, cold cache: total / median per question | 666 s / 4.7 s | 345 s / 3.0 s |
| Set A, warm cache: total / median per question | 83.9 s / 624 ms | 102.1 s / 601 ms |
| Set C, warm cache: total / median per question | 28.1 s / 343 ms | 33.3 s / 484 ms |

Cold timings swing with the network: main ran first, on a cold jsDelivr. The warm total grew 22% on
set A. Two libraries account for all of it: NestJS (0.1 s to 6.8 s over three questions) and Prisma
(6 s to 26 s) now read the `llms-full.txt` of their `docs.` subdomain, a whole site that pinright
splits into sections on every question. Without those two, set A's warm total is 75 s. Answers grew
5% on set A and 2% on the replay.

Steps, in the order we committed them (scores on one shared warm cache):

| Change | Original | Set A | Set B | Replay |
|---|---|---|---|---|
| Main | 24 | 63 | 25 | 58 |
| Docs site found from metadata (`65f5c16`) | 24 | 71 | 25 | 58 |
| mkdocs macros and snippet sections (`6510ce0`) | 24 | 72 | 25 | 58 |
| Generated SDK types rank below the prose (`a2a2751`) | 24 | 73 | 25 | 58 |
| Sphinx `constraints.txt` pages kept (`42ac4d4`) | 24 | 74 | 25 | 58 |
| `llms-full.txt`: the per-file cap counts pages (`52a29d5`) | 24 | 75 | 25 | 58 |

**Docs sites found from metadata.** Supabase, Stripe and Astro keep their docs outside the package
and its repo. pinright used to read the registry's homepage and stop there. It now takes the site from
the registry's docs URL or homepage; when that points to GitHub or a registry, from the homepage the
source repo declares (supabase/supabase-js lists supabase.com); and without either, from the link in
the README's Documentation section (platform.claude.com for the Claude SDKs). It looks for llms.txt
in the site's folder, then at `docs.<host>` and under `/docs` (stripe.com's llms.txt lists product
pages; docs.stripe.com's lists the docs). A site with no llms.txt is read from the repo it is built
from: pinright asks GitHub about `<org>/docs`, `<org>/<name>-docs`, `<org>/<name>.dev`, `<org>/<site
host>` and the docs folders of `<org>/<org>`, and reads a candidate only when GitHub lists its homepage
as the same site. Astro's docs come from `withastro/docs` and NestJS's from `nestjs/docs.nestjs.com`
this way. It asks only when the package and its repo carry fewer than five docs pages, and caches
the answers. Every URL taken from metadata goes through `getUntrustedText`. A site found through the
repo or the README covers a product family, so its llms.txt pages rank with the package name too.
This step fixed Astro (3), Supabase (2), NestJS (2) and the Anthropic TypeScript SDK's tool
definition. We added no entry to `docsRepos.ts`.

**mkdocs macros.** Polars writes `{{code_block('user-guide/expressions/aggregation','basic',[...])}}`,
which its macro turns into `--8<-- "python/user-guide/expressions/aggregation.py:basic"` under
`docs/source/src/`. The repo listing now keeps the example code under `docs/` folders. A directive
whose path does not resolve from the page's folders is looked up by its ending in that code; a macro
path gets the ecosystem's extension (`.py` for PyPI); `:basic` keeps the lines between
`[start:basic]` and `[end:basic]`. Polars runs the same snippet in a second block, which stays as is.

**Generated SDK types.** OpenAI's and Anthropic's wheels ship hundreds of modules headed "File
generated from our OpenAPI spec by Stainless". A file that says it was generated now weighs half
for a how-to question and full weight when the question asks about a signature, a type or its fields.
OpenAI's `responses.parse` now comes from `helpers.md`.

**Ranking misses.** Django's `constraints.txt` never reached the ranking: the filter for pip files
in `docs/` dropped every `.txt` whose name contained "constraints". It now drops them only in
`docs/` or one folder down. Prisma's `defineConfig` page ranked fourth inside `llms-full.txt`, and the
cap of three sections per file stopped there; in `llms-full.txt` the cap now counts each page.
NestJS's `ValidationPipe` and constructor injection passed in the first step, once pinright read
docs.nestjs.com.

**Remaining misses in set A (6):**
- Anthropic `system=` (Python) and `system:` (TypeScript): neither the SDK repo nor
  platform.claude.com's llms.txt has a page that shows a system prompt in code; the prompting guide
  that does ranks below "Mid-conversation system messages".
- Stripe's checkout session: pinright reads the right API reference page, but the section it picks
  lists parameters, not the `stripe.checkout.sessions.create` call.
- Supabase `.eq()`: `llms/js.txt` has it, in a section that ranks below the `select()` one.
- Polars "read a large CSV lazily": "lazily" does not match "lazy", and the lazy API page loses to
  `io/csv.md`.
- React Router "useNavigate in onSubmit", as before.

The original probe's miss (Zod's "reject unknown keys") is unchanged: the `z.strictObject` section
says "throws on unknown keys" and shares no other word with the question.

**Set B** did not move (25). **Set C** went from 28 to 33: Elysia 0 to 3 and SolidStart 0 to 2, with no
new misses. Its 12 misses after: Nuxt 4's `srcDir`, SolidStart's `"use server"`, Effect 4's
`Effect.result` and `forkDetach`, BullMQ's `deduplication`, Pino's `redact`, Pandera's validation
depth, DuckDB 2 (3), LlamaIndex's `agent.run`, uv workspaces.

## Before and after on the agents (v5, Sonnet only)

We reran the five tasks the fixes touch on the pinright arm (`docs-v1-fix`, 10 runs): 10 of 10 current,
as before. Cost per run USD 0.084 against 0.081, 9.0 turns against 9.7. Tailwind runs now get `@theme`,
`@utility` and `@custom-variant` from the docs (5 of 5 markers, from 1 of 5); Pydantic runs still get
3 of 6.

## Post-cutoff set (2026-11-02)

The v6 tasks cannot separate "the docs helped" from "the model already knew": five of the eight came
out right without docs. A second set of eight tasks (`--set post-cutoff`,
[tasks-post-cutoff.ts](docs/tasks-post-cutoff.ts)) asks for APIs whose first release on npm or PyPI
is dated 2026-08-01 or later: msw 3 (`msw/graphql`, `onUnhandledFrame`), Hono 4.13.13's `mount()`
middleware, dotenv 18's `dotenv run`, Zod 4.5's `z.compile`, Polars 2's `bin_intervals` and
`bin_quantiles`, FastAPI 0.142's `telemetry=`, pandas 3.1's `DataFrame.select` and `filter(cond=)`, and
LangChain 1.4's `langchain.mcp.MCPAdapter`. Each task records the first release with the API, its
registry publish time and the newest release we checked without it, and sets that first release as a
minimum version. Same harness, arms and scoring as v6, with no runtime smoke tests.

Without docs the three models wrote the new API in 2 of 48 runs, both on the pandas task. With
pinright they did in 46 of 48, and with the docs-only ablation in 45 of 48. Per-model tables, the
evidence for each API, failures and caveats: [RESULTS-post-cutoff.md](RESULTS-post-cutoff.md).

## Limits

- Three models from one vendor, all driven by Claude Code; one day; 16 runs per arm and model; tasks
  we wrote. Two repetitions cannot separate 100% from 90%: the brackets in the tables are wide on
  purpose.
- The models knew most of the v6 APIs without help. The post-cutoff set uses APIs newer than the
  models, and each model release will make those stale too.
- The AI SDK task has no runtime smoke test (it needs a model); `next build` type-checks it.
- The pinright arm costs more: about twice the API-equivalent cost and 3 to 4 more turns per run than
  no docs, with every model.

## Reproduce

```bash
npm ci && npm run build
npx tsx bench/docs/selftest.ts                      # scorer against reference and old-API projects
GITHUB_TOKEN=... npx tsx bench/docs/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp docs-v7-sonnet-2026-11-02
GITHUB_TOKEN=... npx tsx bench/docs/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp docs-v7-sonnet-2026-11-02 --arms docs-only --resume
# same for claude-haiku-5-5 and claude-opus-5-5 (stamps docs-v7-haiku-2026-11-02, docs-v7-opus-2026-11-02)
npx tsx bench/docs/score.ts <stamp> --concurrency 2
npx tsx bench/docs/report.ts docs-v7-sonnet-2026-11-02 docs-v7-haiku-2026-11-02 docs-v7-opus-2026-11-02
GITHUB_TOKEN=... npx tsx bench/docs/retrieval.ts
GITHUB_TOKEN=... npx tsx bench/docs/probe-heldout.ts --set a   # or b, c, all; --show for the sections of each miss
GITHUB_TOKEN=... npx tsx bench/docs/replay.ts <stamp>
npx tsx bench/docs/calls.ts <stamp> <task> pinright  # what each docs call returned
```
