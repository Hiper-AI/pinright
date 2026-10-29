# Docs benchmark: do safectx's docs get the new API right?

[AGENTS.md](AGENTS.md) measures what an agent installs. This benchmark measures what it writes: eight
tasks that only come out right with the API of a library's current major, run by Claude Code in
headless mode with and without safectx. We install, build and smoke-test each project at runtime, and
check it for the current API, for APIs the major removed and for deprecated ones.

The runs predate a rename: the docs tool, `get-docs` now, was called `query-docs` then.

Short version: with safectx the agent wrote the current API in 16 of 16 runs; without docs, in 12 of 16.
One library explains most of the gap, AI SDK 7 (released 2026-06-25); two more runs broke on version
pins. Sonnet 5.5 already knows Next 16, Tailwind 4, Zod 4, Express 5, ESLint 10, Pydantic 2 and
LangChain 1, so on those tasks the agent runs cannot tell good docs from bad ones. The
[retrieval probe](#retrieval-probe-safectxs-docs-without-the-agent) takes the model out of the loop:
safectx's answers showed the current API for 16 of 25 typical questions before the first round of
fixes, 20 after it and 24 after the second. A [held-out probe](#held-out-probe-and-the-second-round-of-fixes)
of 109 questions over 41 other libraries went from 75 to 88; its untouched set B, from 22 to 25 of 28.

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

| Arm | Calls by tool (total over all runs) | get-docs answers with no matching docs |
|---|---|---|
| safectx | safectx__check-packages 20, safectx__get-docs 32, safectx__check-package 3, safectx__check-manifest 1 | 2 |

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

**Rename hints.** An agent asks with the names it learned; the docs answer with the new ones. safectx
now reads the renames a version announces from the package itself: `@deprecated Use \`instructions\`
instead.` on the `system` option of `ai`'s entry `.d.ts`, `@deprecated("on_event is deprecated, use
lifespan ...")` on FastAPI's `on_event`, "`cacheTime` → `gcTime`" in TanStack Query's v5 migration
guide. The replacement has to be declared in the API ("use literal values instead" names nothing).
When a question uses an old name as written, the new one joins the question next to it, and the answer
opens with a fenced line: "Renamed or deprecated in ai@7.0.157, per the package's own files: `system`
-> `instructions` (dist/index.d.ts)". Over the 106 probe questions, it fired three times, all right:
AI SDK `system`, TanStack `cacheTime`, FastAPI `on_event`. No library has a hand-written entry.

**Remaining misses in set A (18), by cause:**
- Docs that live only on a site safectx cannot read (7): Supabase (3), Astro's content collections, actions and server islands (docs in
  `withastro/docs`, no llms.txt found from `astro.build`), Stripe's checkout sessions. A mapping in
  `docsRepos.ts` would fix each, but adding one per held-out library would be tuning to the probe.
- Examples in a format safectx does not expand (2): Polars' `{{code_block(...)}}` macros pull its code from
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
GITHUB_TOKEN=... npx tsx bench/docs/retrieval.ts
GITHUB_TOKEN=... npx tsx bench/docs/probe-heldout.ts --set a   # or b, all; --show for the sections of each miss
GITHUB_TOKEN=... npx tsx bench/docs/replay.ts <stamp>
npx tsx bench/docs/calls.ts <stamp> <task> safectx  # what each docs call returned
```
