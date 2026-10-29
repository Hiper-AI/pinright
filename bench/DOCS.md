# Docs benchmark: do safectx's docs get the new API right?

[AGENTS.md](AGENTS.md) measures what an agent installs. This benchmark measures what it writes: eight
tasks that only come out right with the API of a library's current major, run by Claude Code in
headless mode with and without safectx. We install, build and smoke-test each project at runtime, and
check it for the current API, for APIs the major removed and for deprecated ones.

Short version: with safectx the agent wrote the current API in 16 of 16 runs; without docs, in 12 of 16.
One library explains most of the gap, AI SDK 7 (released 2026-06-25); two more runs broke on version
pins. Sonnet 5.5 already knows Next 16, Tailwind 4, Zod 4, Express 5, ESLint 10, Pydantic 2 and
LangChain 1, so on those tasks the agent runs cannot tell good docs from bad ones. The
[retrieval probe](#retrieval-probe-safectxs-docs-without-the-agent) takes the model out of the loop:
safectx's answers showed the current API for 16 of 25 typical questions before the fixes in this
branch and for 20 of 25 after.

## Setup

- Model `claude-sonnet-5-5` (`--model sonnet`), 2 repetitions per task and arm, concurrency 2.
- Built-in tools limited to Write and Read: no shell, no web. Every arm gets the same prompt. It names
  the major ("use the newest Zod 4 release") but never the new API, and asks the agent to check the
  current API with its documentation tools when it has any.
- Arms: `no-docs` (nothing attached) and `safectx` (this repo's `dist/cli.js`, local docs only). The
  harness takes any other MCP server as an extra arm with `--mcp-arm name=mcp.json`; this repo ships no
  config for third-party servers.
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
Run `docs-v1`, model `claude-sonnet-5-5`, 2 repetitions of 8 tasks per arm, 32 runs scored.

| Metric | No docs | safectx |
|---|---|---|
| **Current API** (works, right major, every check passes) | **12 / 16** (75%) | **16 / 16** (100%) |
| Works (installs, builds, smoke test passes) | 14 / 16 | 16 / 16 |
| Installs | 16 / 16 | 16 / 16 |
| Builds / type-checks / imports | 15 / 16 | 16 / 16 |
| Smoke test passes (6 tasks with one) | 12 / 14 | 14 / 14 |
| Pinned the asked major | 16 / 16 | 16 / 16 |
| All required new-API checks present | 14 / 16 | 16 / 16 |
| Runs using a removed API | 0 | 0 |
| Runs using a deprecated API | 2 | 0 |
| API checks passed (all kinds) | 92% | 100% |
| Cost per run (USD, mean) | 0.04 | 0.08 |
| Turns per run (mean) | 5.3 | 8.8 |
| Duration per run (s, mean) | 17.1 | 27.6 |
| MCP calls per run (mean) | 0.0 | 3.5 |
| Docs calls per run (mean) | 0.0 | 2.0 |
| Docs returned per run (k chars, mean) | 0.0 | 15.9 |

### Per task

Each cell: runs with the current API / runs that work (build + smoke test) / runs that build, out of the repetitions. Failed checks follow, with how many runs failed each (r = required missing, x = removed API used, d = deprecated API used).

| Task | No docs | safectx |
|---|---|---|
| next16-proxy (Next.js 16) | **1** / 1 / 2 of 2 | **2** / 2 / 2 of 2 |
| tailwind4-vite (Tailwind CSS 4) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| zod4-schema (Zod 4) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| ai-sdk7-chat (AI SDK 7) | **0** / 2 / 2 of 2<br>r:instructions x2, r:is-step-count x2, d:step-count-is x2, r:ui-stream-response x2, d:result-response-helper x2 | **2** / 2 / 2 of 2 |
| express5-api (Express 5) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| eslint10-flat (ESLint 10) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| pydantic2-models (Pydantic 2) | **2** / 2 / 2 of 2 | **2** / 2 / 2 of 2 |
| langchain1-agent (LangChain 1) | **1** / 1 / 1 of 2 | **2** / 2 / 2 of 2 |

### Runs that do not work

**No docs**: 

- langchain1-agent r1: `import check failed: from langchain.agents import create_agent -> ImportError: cannot import name 'ExecutionInfo' from 'langgraph.runtime'`
- next16-proxy r2: `smoke: redirect-without-session (200 )`

**safectx**: none


### Docs tool usage

| Arm | Calls by tool (total over all runs) | query-docs answers with no matching docs |
|---|---|---|
| safectx | safectx__check-packages 20, safectx__query-docs 32, safectx__check-package 3, safectx__check-manifest 1 | 2 |

<!-- generated:end -->

## Where the no-docs runs fail

- **AI SDK 7, both runs**: AI SDK 5/6 code. `system:` instead of `instructions:`, `stepCountIs` instead
  of `isStepCount`, `result.toUIMessageStreamResponse()`. All three still compile in 7 as deprecated
  aliases, so the runs work but are not current.
- **Next.js r2**: pinned `16.0.0`. The code is correct, yet under `next start` the proxy never ran and
  `/dashboard` answered 200 without a session. The same project on 16.0.11 passes. safectx pinned
  16.4.3 in both runs.
- **LangChain r1**: pinned `langchain==1.2.0`, which imports `ExecutionInfo` from a newer `langgraph`
  than the one the resolver installed; `from langchain.agents import create_agent` fails.

## Retrieval probe: safectx's docs without the agent

`bench/docs/retrieval.ts` sends safectx's docs pipeline 25 questions an agent asks on these tasks, some
phrased with the old API's words ("middleware", "darkMode class"), and checks that the answer shows the
current API. `bench/docs/replay.ts` replays the exact `query-docs` calls the agents made in the run and
counts the task's new-API markers in the answers. On the base code it returns answers of the same
length and with the same markers as the ones recorded in the transcripts.

| | Base (`e644213`) | This branch |
|---|---|---|
| Probe questions answered with the current API | 16 / 25 | 20 / 25 |
| New-API markers in the answers to the agents' own questions (16 runs) | 46 / 66 | 51 / 66 |

Per task, base to branch: Tailwind went from 0 to 3 of 4 probes and from 2 to 10 of 10 replay markers.
Pydantic went from 2 to 3 of 4 probes, but from 10 to 6 of 12 markers on the agents' long multi-topic
question (see below). ESLint gained one marker. The other tasks did not change.

## Diagnosis: where safectx's docs fall short

The safectx arm never lost a task, so this section comes from the transcripts and the probe.

**Tailwind CSS: no docs at all (fixed).** The `tailwindcss` npm package ships a README and type
definitions; tailwindcss.com publishes no `llms.txt` and no `.md` pages; the docs live in the
`tailwindlabs/tailwindcss.com` repo. Every Tailwind query returned the README plus
`default-theme.d.ts`, with nothing about `@theme`, `@utility` or `@custom-variant`. The agents wrote v4
from memory. Fix: `src/data/docsRepos.ts` takes npm entries now, and safectx reads Tailwind from that
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
`ecosystem: "pypi"` and `npm:placeholder` with `packageName: "langchain"`. safectx ignored both
arguments for ids in its own format and answered with the npm packages `pydantic` (no docs found) and
`placeholder` (an 865-character README). Each cost the agent a call. An explicit `ecosystem` or
`packageName` now overrides the id; in the rerun the same kind of call returned 9,730 characters of
LangChain 1 agent docs.

**AI SDK: one step from five framework guides (partly fixed).** The `ai` package ships its docs, and a
question about a route handler got the multi-step section of the Next.js App Router, Pages Router, Nuxt
and TanStack Start guides: four copies of one example. A near-duplicate filter now drops sections that
share 70% of their words with one already picked. The probe still misses `instructions:` when the
question says "system prompt". The guides never show one, and the agents reached the reference page
that does (`stream-text.mdx`) only by asking for "instructions" by name.

**Pydantic: API reference outranks the concept pages (open).** For a question that names six features
at once, the answer fills with wheel docstrings (`ValidateJsonHandlerProtocol`,
`TypeAdapter.validate_python`) and misses `field_validator`, `model_validator` and `pattern=`. On the
agents' own question the branch does worse than the base: 3 of 6 markers instead of 5 of 6. Asked one
feature at a time, the probe finds `field_validator`, `model_validator` and `ConfigDict`; `pattern=`
stays missing. The agents wrote correct Pydantic 2 in every run, from memory.

**Remaining probe misses (open):**
- Tailwind install with Vite: the installation pages in the docs repo are TSX, not Markdown, and the
  `@tailwindcss/vite` README is short. The Vite plugin setup appears in the upgrade guide, which
  safectx reads only for upgrade questions.
- Zod "reject unknown keys; enum from a TS enum; record of strings": three topics in one question. The
  answer covers `z.enum` and `z.record` but not `z.strictObject`.
- LangChain `@tool`: path ranking picks the `langchain_decorators` integration page for "decorator".
- Next.js: the Next repo's `evals/*/PROMPT.md` (agent eval prompts) and `errors/*` pages reach the
  candidate list; they are not API docs.

## Before and after on the agents

We reran the five tasks the fixes touch on the safectx arm (`docs-v1-fix`, 10 runs): 10 of 10 current,
as before. Cost per run USD 0.084 against 0.081, 9.0 turns against 9.7. Tailwind runs now get `@theme`,
`@utility` and `@custom-variant` from the docs (5 of 5 markers, from 1 of 5); Pydantic runs still get
3 of 6.

## Limits

- One model, one day, 16 runs per arm, tasks we wrote. Two repetitions cannot separate 100% from 90%.
- The model knew six of the eight new APIs without help. To separate docs sources, a benchmark needs
  APIs newer than the model, and each model release makes the current ones stale.
- The AI SDK task has no runtime smoke test (it needs a model); `next build` type-checks it.
- The safectx arm costs more: USD 0.08 and 8.8 turns per run against 0.04 and 5.3 without docs.

## Reproduce

```bash
npm ci && npm run build
npx tsx bench/docs/selftest.ts                      # scorer against reference and old-API projects
GITHUB_TOKEN=... npx tsx bench/docs/run.ts --reps 2 --concurrency 2 --stamp <stamp>
npx tsx bench/docs/score.ts <stamp> --concurrency 2
npx tsx bench/docs/report.ts <stamp>                # fills the Results section above
SAFECTX_CONTEXT7=off GITHUB_TOKEN=... npx tsx bench/docs/retrieval.ts
SAFECTX_CONTEXT7=off GITHUB_TOKEN=... npx tsx bench/docs/replay.ts <stamp>
npx tsx bench/docs/calls.ts <stamp> <task> safectx  # what each docs call returned
```
