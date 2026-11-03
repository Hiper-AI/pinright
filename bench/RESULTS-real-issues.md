# pinright agent benchmark: tasks taken from public GitHub issues

The main agent benchmark ([RESULTS-v7.md](RESULTS-v7.md), and v6 before it) uses 12 tasks we wrote. A reader can fairly
ask whether we picked them to favor pinright. This set tests that with 12 tasks we did not write:
each prompt is the body of a public GitHub issue that asks for an example or a new piece of code,
picked by the rule below. The harness, arms, scorer and statistics are the v6 ones.

Run on 2026-11-02 and 2026-11-03 with Claude Code 2.1.308 in headless mode, driving Sonnet 5.5,
Opus 5.5 and Haiku 5.5, against pinright at commit `8efc4f0` (the 1.0.0 release code; only `bench/`
differs on this branch). Three arms, two repetitions: no docs, the pinright MCP server, and the MCP
server plus the pre-install hook. 216 agent runs, all of which finished. Per-model details, per-task
tables and every failed build: [AGENTS-real-issues.md](AGENTS-real-issues.md). Rescored on
2026-11-03 with the v7 scorer fixes (see caveats).

**Headline.** Without docs, 25% to 29% of the direct dependencies each model pinned carried a known
advisory, and the projects totaled 514 to 600 whole-tree alerts per model. With
the pinright MCP server, no model pinned a direct dependency with an advisory, and each model's 24
projects totaled 114 to 116 alerts. 112 of those come from one task, `stirrup-gdpval`, where the
current `stirrup` release (0.2.1) pulls `moviepy` 2.2.1, which caps `pillow` below 12.0, and the
fixes for the 56 `pillow` 11.3.0 alerts shipped in 13.0.0 (see caveats); the no-pin reference has
the same 56 alerts there. On the other 11 tasks
the MCP arm totaled 2 to 4 alerts per model, against 375 to 484 without docs. The MCP arm also built
more projects: 54 of 72 against 34 of 72 without docs, most failures in both arms being incomplete
projects (no root layout in a Next.js app, `process` used without `@types/node`). With 12 tasks and
two repetitions the intervals are wide, and on the full set the no-docs and MCP intervals of alerts
per project overlap for every model, because `stirrup-gdpval` adds 56 alerts to each MCP project of
that task.

## Selection rule

We fixed the rule before running any agent on these tasks and applied it once, on 2026-11-02.

1. **Search.** Two GitHub issue searches, run with the GitHub CLI on 2026-11-02:

   ```bash
   gh search issues '"example" in:title' --language TypeScript --created 2025-01-01..2026-09-30 --sort reactions --order desc --limit 100
   gh search issues '"example" in:title' --language Python     --created 2025-01-01..2026-09-30 --sort reactions --order desc --limit 100
   ```

   The TypeScript list supplies the npm tasks and the Python list the PyPI tasks. The raw output of
   both searches is committed in [agents/real-issues/](agents/real-issues/), because reaction counts
   change and a later search returns a different order.
2. **Walk each list in order** and keep an issue only if all of these hold, judged from its title
   and body:
   - **I1, asks for code.** It asks for runnable code (an example, a demo, a starter, an integration
     of the repository's library with a named tool) and says what the code should do beyond "an
     example" or "a demo". Bug reports about an existing example, documentation wording, data or
     config files, questions about a paper, and changes inside the library's own code fail I1.
   - **I2, one registry.** The requested code is in the list's language family (JavaScript or
     TypeScript for npm, Python for PyPI), and an agent can write it from scratch in an empty
     directory with dependencies from that one registry. The libraries it names are installable from
     that registry.
   - **I3, no special hardware or native build.** It needs no GPU, no model training or fine-tuning,
     and no mobile or desktop native build.
   - **I4, one per repository.** The first qualifying issue of a repository is kept.
3. **Stop** after 6 issues per list.
4. **Prompt.** The issue body, trimmed only of greetings, sign-offs, images, empty template sections
   and offers to open a PR, inside a fixed frame that names the repository (with its GitHub
   description) and the issue title, followed by the v6 pinning rules and the v6 docs hint:

   ```text
   Build a minimal, standalone project in the current directory that does what this GitHub issue asks for.

   Repository: <owner/repo> (<GitHub description>)
   Issue #<n>: <title>

   <issue body, trimmed>

   Write a package.json with EXACT pinned versions (no ^ or ~) for every dependency, plus the source file(s). Do not run any command. Keep the code short.
   ```

   (PyPI tasks get the v6 `requirements.txt` rule instead.) The trimmed bodies are in
   [agents/real-issues/](agents/real-issues/) and the cuts per issue in
   [agents/tasks-real-issues.ts](agents/tasks-real-issues.ts).

Applying I1 to I3 takes judgment. The log at the end of this file lists every result we read up to
the last one kept, with the criterion that excluded it, so you can check each call.

## The 12 issues

| Task id | Ecosystem | Rank | Issue | Title | Opened | State (2026-11-02) | Trimmed |
|---|---|---|---|---|---|---|---|
| mcp-hono | npm | 6 | [modelcontextprotocol/typescript-sdk#385](https://github.com/modelcontextprotocol/typescript-sdk/issues/385) | Consider adding Hono examples | 2025-04-22 | closed | screenshot, last paragraph (PR offer) |
| proton-drive-example | npm | 22 | [ProtonDriveApps/sdk#8](https://github.com/ProtonDriveApps/sdk/issues/8) | Example needed | 2025-12-15 | open | greeting, sign-off |
| mastra-deep-research | npm | 29 | [mastra-ai/mastra#2541](https://github.com/mastra-ai/mastra/issues/2541) | Examples: deep research | 2025-02-25 | closed | nothing |
| assistant-ui-mcp-tools | npm | 30 | [assistant-ui/assistant-ui#1833](https://github.com/assistant-ui/assistant-ui/issues/1833) | Example for custom backend tool call update | 2025-04-14 | closed | nothing |
| next-gh-pages | npm | 31 | [nextjs/deploy-github-pages#2](https://github.com/nextjs/deploy-github-pages/issues/2) | Example | 2025-02-15 | open | nothing |
| openapi-fetch-next | npm | 42 | [openapi-ts/openapi-typescript#2242](https://github.com/openapi-ts/openapi-typescript/issues/2242) | Update docs and examples for Next.js | 2025-04-03 | open | "Extra" section (PR checkbox) |
| mcp-remote-oauth | PyPI | 11 | [modelcontextprotocol/python-sdk#618](https://github.com/modelcontextprotocol/python-sdk/issues/618) | Remote MCP Oauth Example | 2025-05-02 | closed | nothing |
| kittentts-streaming | PyPI | 18 | [KittenML/KittenTTS#54](https://github.com/KittenML/KittenTTS/issues/54) | Is there an example of streaming output? | 2025-08-08 | open | nothing |
| openevolve-symreg | PyPI | 29 | [algorithmicsuperintelligence/openevolve#15](https://github.com/algorithmicsuperintelligence/openevolve/issues/15) | Feature Proposal: New Symbolic Regression Example for OpenEvolve | 2025-05-21 | closed | greeting, last three paragraphs (PR offer, follow-up offer, closing line), sign-off |
| pydantic-ai-deep-research | PyPI | 30 | [pydantic/pydantic-ai#901](https://github.com/pydantic/pydantic-ai/issues/901) | deep research example | 2025-02-12 | open | nothing |
| stirrup-gdpval | PyPI | 32 | [ArtificialAnalysis/Stirrup#8](https://github.com/ArtificialAnalysis/Stirrup/issues/8) | ENH: GDPval as an example | 2025-12-19 | open | template checkbox, empty "Alternatives Considered" |
| livekit-ultravox | PyPI | 38 | [livekit/agents#1378](https://github.com/livekit/agents/issues/1378) | Feature Request: Ultravox example | 2025-01-15 | closed | greeting |

Rank is the position in the committed search snapshot. Emoji were removed from three repository
descriptions; the ProtonDriveApps/sdk repository has none, so its frame names only the repository.

## Results

Two repetitions of 12 tasks per arm and model. Brackets are 95% cluster-bootstrap intervals that
resample tasks, seeded so they regenerate identically; two arms whose intervals overlap are not shown
to differ. "Builds" counts projects that install and pass the v6 build or import check. Cost is
Claude Code's API-equivalent at list price (`total_cost_usd`); the runs used a Claude subscription.

<!-- generated:start -->
### Agent security benchmark (12 tasks; whole-tree alerts from npm audit / pip-audit)

| Model | Arm | Reps | Alerts, whole tree (sum) | Alerts per project, mean [95% CI] | Projects with 0 alerts | Direct deps with advisories | Critical + high (npm) | Builds | API-equivalent cost / run (USD, list price) | Turns | Duration (s) | MCP calls |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | No docs | 2 | 562 | 24.4 [11.4, 38.3] | 5 / 23 | 28 / 105 (27%) | 169 | 10 / 24 | 0.040 | 4.1 | 19.3 | 0.0 |
| Sonnet 5.5 | pinright MCP | 2 | 114 | 4.8 [0.0, 14.2] | 20 / 24 | 0 / 106 (0%) | 0 | 18 / 24 | 0.071 | 7.0 | 30.7 | 2.6 |
| Sonnet 5.5 | pinright MCP + hook | 2 | 58 | 2.6 [0.0, 8.9] | 19 / 22 | 0 / 99 (0%) | 0 | 14 / 23 | 0.080 | 7.1 | 40.5 | 2.7 |
| Sonnet 5.5 | No pin (reference) | 1 | 56 | 4.7 [0.0, 14.0] | 11 / 12 | 0 / 56 (0%) | 0 | n/a | n/a | n/a | n/a | n/a |
| Opus 5.5 | No docs | 2 | 600 | 25.0 [12.5, 38.3] | 5 / 24 | 30 / 121 (25%) | 173 | 15 / 24 | 0.156 | 5.0 | 51.0 | 0.0 |
| Opus 5.5 | pinright MCP | 2 | 116 | 4.8 [0.0, 14.3] | 18 / 24 | 0 / 118 (0%) | 2 | 19 / 24 | 0.299 | 9.9 | 78.1 | 4.4 |
| Opus 5.5 | pinright MCP + hook | 2 | 3 | 0.1 [0.0, 0.3] | 19 / 22 | 0 / 123 (0%) | 1 | 18 / 24 | 0.319 | 10.2 | 87.9 | 4.8 |
| Opus 5.5 | No pin (reference) | 1 | 57 | 4.8 [0.0, 14.2] | 10 / 12 | 0 / 63 (0%) | 0 | n/a | n/a | n/a | n/a | n/a |
| Haiku 5.5 | No docs | 2 | 514 | 22.3 [9.5, 36.9] | 5 / 23 | 27 / 92 (29%) | 146 | 9 / 24 | 0.004 | 4.2 | 33.1 | 0.0 |
| Haiku 5.5 | pinright MCP | 2 | 114 | 4.8 [0.0, 14.2] | 20 / 24 | 0 / 103 (0%) | 0 | 17 / 24 | 0.008 | 8.5 | 56.3 | 4.3 |
| Haiku 5.5 | pinright MCP + hook | 2 | 56 | 2.4 [0.0, 8.0] | 22 / 23 | 0 / 102 (0%) | 0 | 14 / 24 | 0.009 | 9.1 | 69.9 | 4.8 |
| Haiku 5.5 | No pin (reference) | 1 | 70 | 5.8 [0.0, 17.4] | 10 / 12 | 0 / 45 (0%) | 0 | n/a | n/a | n/a | n/a | n/a |

"No pin" is not an agent: the no-docs agent's packages, installed without a version, for reference.

### API-equivalent cost of the runs (USD at list price, from the transcripts)

| Model | Agent benchmark | Runs |
|---|---|---|
| Sonnet 5.5 | 4.60 | 72 |
| Opus 5.5 | 18.57 | 72 |
| Haiku 5.5 | 0.51 | 72 |
| **All** | **23.68** | 216 |

### pinright check-manifest vs npm audit / pip-audit (same lockfiles, every arm and model)

|  | Lockfiles | Alerts (audit tool) | Alerts (pinright) | Vulnerable packages, mean Jaccard | Identical sets |
|---|---|---|---|---|---|
| npm (npm audit) | 125 | 1207 | 1287 | 1.00 | 125 / 125 |
| PyPI (pip-audit) | 120 | 1113 | 1147 | 1.00 | 120 / 120 |

<!-- generated:end -->

### Without the stirrup-gdpval task

`stirrup-gdpval` carries the same unfixable `pillow` alerts in every arm (56 or more per project),
so it dominates the sums. Whole-tree alerts summed over the other 11 tasks, resolved projects only:

| Model | No docs | pinright MCP | pinright MCP + hook | No pin (reference, 1 run) |
|---|---|---|---|---|
| Sonnet 5.5 | 446 | 2 | 2 | 0 |
| Opus 5.5 | 484 | 4 | 3 | 1 |
| Haiku 5.5 | 375 | 2 | 0 | 1 |

The remaining MCP-arm alerts are one per run in the tree of `openapi-fetch-next` (Next.js 16.4.3)
and, for Opus, one per run in `mastra-deep-research`; the no-pin reference has the same
`openapi-fetch-next` alert for Opus and Haiku.

## How this set differs from v6

- **The no-docs baseline is lower.** No docs averaged 22 to 25 alerts per project here, against 30
  to 33 in v6 (30 to 32 in v7), and 25% to 29% of its direct pins carried an advisory, against 40% to
  42% in both. Three
  of the twelve issue tasks (`kittentts-streaming`, `openevolve-symreg`, `livekit-ultravox` for
  two models) came out clean or nearly clean without docs.
- **The MCP arm keeps its direct pins clean** (0 of 103 to 118 per model), as in v6. On the 11
  tasks other than `stirrup-gdpval` the whole-tree sums are close to the no-pin reference.
- **More projects fail to build in every arm.** The issue prompts are vaguer than the v6 prompts,
  and agents wrote Next.js apps without a root layout, TypeScript that uses `process` with no
  `@types/node`, and `.jsx` with no bundler. These failures appear in all three arms. Two failures
  track the version: `@protontech/drive-sdk` 0.23.0 (the current release, pinned by both pinright
  arms) fails the check inside its own files in 9 of 12 runs (`dist/internal/uids` not found, or a
  `.ts` import path in `@protontech/crypto`), and no-docs pins of `pydantic-ai`, `mcp` and
  `stirrup` fail to import with the dependency versions that resolve for them today (a missing
  `opentelemetry._events`, a moved `pydantic` internal, an undeclared `rich`).
- **The hook made one task unresolvable.** In `stirrup-gdpval` the hook told the agent that
  `stirrup` 0.2.1 pulls `pillow` 11.3.0 with known advisories. In 4 of 6 runs the agent then pinned
  `pillow==13.0.0` next to `stirrup`, which `moviepy`'s `pillow<12.0` cap makes unsatisfiable, so
  `uv pip compile` fails. Those 4 manifests drop out of the alert columns, which is why MCP + hook
  shows lower sums than MCP alone (Opus: 3 against 116). Read the hook arm's alert numbers with
  that in mind; on the other 11 tasks the hook arm and the MCP arm differ by at most 2 alerts per
  model. One `next-gh-pages` run in the hook arm wrote no manifest.

## Caveats

- **Advisory data date.** Scoring ran on 2026-11-02 and 2026-11-03 with live data: deps.dev for
  the direct pins, `npm audit` and `pip-audit` (OSV and the GitHub Advisory Database) for the whole
  tree. A later rescore of the same manifests will count different alerts as advisories are
  published and fixed.
- **Rescored with the v7 scorer fixes.** The first scoring pass read a failed deps.dev lookup as a
  version that does not exist and an empty `pip-audit` answer as a clean tree, both only in no-docs
  runs. The rescore (2026-11-03, `score.ts` retrying both, and reading the version of a
  `name @ <wheel URL>` requirement from the file name) moved only Sonnet's no-docs arm: 504 to 562
  alerts (one `stirrup-gdpval` audit had come back empty), 24 of 92 to 28 of 105 direct pins with an
  advisory (`hono` 4.7.10, `zod` 3.24.4 and others had scored as nonexistent), and 9 to 10 builds.
  Opus and Haiku kept every count; their direct-pin denominators grew where a lookup had failed
  (Opus 30 of 116 to 30 of 121). The MCP arms did not change. Nonexistent pins went from 15, 5 and
  1 to 2, 0 and 1 (Sonnet, Opus, Haiku); the remaining three are real misses on PyPI.
- **The job folders sat inside the repository.** Until the agent wrote a dependency file,
  pinright's project detection walked up from its folder to the repository's own `package-lock.json`
  and reported those versions as installed (`typescript` 5.9.3, `@types/node` 22.20.5, `zod` 4.6.7,
  `hono` 4.13.14). This hit 8 to 10 of 24 runs per model in each MCP arm, all npm; in nearly all of
  them the agent pinned one of those versions. None carries an advisory, so the direct-pin and alert
  columns are not inflated by it; `typescript` 5.9.3 and `@types/node` 22.20.5 are older than the
  registry default, which lowers the "registry default" share. Fixed after this run (see
  [RESULTS-v7.md](RESULTS-v7.md), Caveats).
- **Small n.** 12 tasks, 2 repetitions, one harness. Six npm tasks and six PyPI tasks cannot stand
  for all of either ecosystem.
- **The rule involved our judgment.** We read the first search results before writing I1 to I3,
  and we decided I1 to I3 for each result by reading it. We did this before running any agent on
  the set, and the selection log lists every decision so you can disagree with a specific one.
  We did not change the rule or the set after seeing results.
- **The search ranks by reactions**, which favors widely used libraries (MCP SDKs, Mastra,
  pydantic-ai, LiveKit). Issues from smaller projects are under-represented.
- **The prompt frame is ours.** The first line and the pinning rules are the same for all 12 tasks
  and match v6; the agent could not open the links in the issues (Write and Read only, no web).
- **Builds are a strict check**, the v6 one: `tsc --noEmit` or `npm run build` for npm, and every
  top-level import for PyPI. A project that fails it may still run under a bundler or with an extra
  type package.
- **pinright's own judgment is part of what we measure.** The MCP arm's 0% direct pins with
  advisories comes from pinright's deps.dev client, the same data the score counts. The whole-tree
  columns come from `npm audit` and `pip-audit`, which share no code with pinright.

## Reproduce

```bash
npm ci && npm run build
export GITHUB_TOKEN=$(gh auth token)
for m in sonnet opus haiku; do
  npx tsx bench/agents/run.ts --set real-issues --model claude-$m-5-5 --reps 2 --concurrency 2 \
    --arms no-docs,pinright+hook,pinright --stamp real-issues-$m
  npx tsx bench/agents/make-latest.ts real-issues-$m
  npx tsx bench/agents/score.ts real-issues-$m --concurrency 3
done
npx tsx bench/summary.ts --agents real-issues-sonnet,real-issues-opus,real-issues-haiku --out bench/RESULTS-real-issues.md
npx tsx bench/agents/report.ts real-issues-sonnet real-issues-opus real-issues-haiku --out bench/AGENTS-real-issues.md
```

Add `--resume` to `run.ts` after a rate-limit failure; it reruns only the jobs without a successful
result.

## Selection log

Every search result we read, in rank order, up to the last issue kept. "Kept" rows are the 12 tasks.

### TypeScript list (npm), ranks 1 to 42

| Rank | Issue | Decision |
|---|---|---|
| 1 | anthropics/claude-code#741 | I1: feature inside the product (LSP integration) |
| 2 | shadcn-ui/ui#9393 | I1: bug report about a docs example |
| 3 | shadcn-ui/ui#9405 | I1: bug report about docs |
| 4 | figma/code-connect#281 | I1: change inside the library |
| 5 | ionic-team/capacitor-assets#634 | I1: asks for example image assets, not code |
| 6 | modelcontextprotocol/typescript-sdk#385 | **kept** (mcp-hono) |
| 7 | vercel/ai#7496 | I2: FastAPI backend plus npm frontend, two registries |
| 8 | nestjs/swagger#3346 | I1: change inside the library |
| 9 | anomalyco/opencode#8549 | I1: bug report |
| 10 | hello-pangea/dnd#974 | I1: broken docs link |
| 11 | angular/components#32729 | I1: docs wording |
| 12 | vercel/ai#7358 | I1: bug report (and I4) |
| 13 | Killzxshot/react-hotbox#2 | I1: says nothing beyond "add examples"; I2: no npm package |
| 14 | saulsharma/react-native-sheet-transitions#4 | I3: React Native mobile build |
| 15 | splitbee/notion-api-worker#94 | I1: bug report |
| 16 | ts-rest/ts-rest#813 | I1: bug report about a docs example |
| 17 | vercel-labs/portless#260 | I1: change inside the tool |
| 18 | blakeblackshear/frigate#16163 | I1: change inside the product |
| 19 | actions/github-script#545 | I1: bug report about a README example |
| 20 | linkwarden/linkwarden#1023 | I1: bug report |
| 21 | anthropics/claude-code-action#526 | I1: bug report |
| 22 | ProtonDriveApps/sdk#8 | **kept** (proton-drive-example) |
| 23 | TanStack/query#10280 | I1: broken docs site |
| 24 | daveyplate/better-auth-tauri#3 | I3: Tauri desktop native build |
| 25 | OpenRouterTeam/typescript-sdk#195 | I1: docs mismatch |
| 26 | mirayavandiepen/mochi-motion#1 | I1: says nothing beyond "a demo page" |
| 27 | saqqdy/eslint-plugin-vitest-globals#32 | I1: README config snippet |
| 28 | software-mansion/react-native-reanimated#7844 | I1: crash report; I3: mobile |
| 29 | mastra-ai/mastra#2541 | **kept** (mastra-deep-research) |
| 30 | assistant-ui/assistant-ui#1833 | **kept** (assistant-ui-mcp-tools) |
| 31 | nextjs/deploy-github-pages#2 | **kept** (next-gh-pages) |
| 32 | shadcn-ui/ui#10065 | I1: bug report |
| 33 | snarktank/ralph#19 | I1: docs wording |
| 34 | expo/expo#35385 | I1: crash report; I3: mobile |
| 35 | vercel/next-learn#1124 | I1: bug in tutorial text |
| 36 | pmndrs/xr#456 | I1: bug report |
| 37 | anthropics/claude-code#1175 | I2: asks for a Python MCP server, outside the TypeScript list's ecosystem |
| 38 | deepgram/deepgram-js-sdk#354 | I1: bug report |
| 39 | payloadcms/payload#10602 | I1: bug report |
| 40 | bloomberg/stricli#51 | I1: docs snippets |
| 41 | juliencrn/usehooks-ts#682 | I1: bug report |
| 42 | openapi-ts/openapi-typescript#2242 | **kept** (openapi-fetch-next) |

### Python list (PyPI), ranks 1 to 38

| Rank | Issue | Decision |
|---|---|---|
| 1 | lllyasviel/FramePack#39 | I1: tutorial post, no request; I3: GPU |
| 2 | sapientinc/HRM#3 | I3: research model, GPU training |
| 3 | PrefectHQ/prefect#18657 | I1: contribution docs |
| 4 | kubeedge/ianvs#230 | I1: restore examples inside the repository |
| 5 | deepseek-ai/EPLB#12 | I1: question about the algorithm; I2: not on PyPI |
| 6 | facebookresearch/sam3#462 | I1: bug report |
| 7 | deepseek-ai/DeepSeek-OCR#43 | I3: fine-tuning |
| 8 | googleapis/python-genai#1590 | I1: bug report |
| 9 | anthropics/skills#100 | I1: license question |
| 10 | nunchux-ai/deepcompressor#92 | I1: question |
| 11 | modelcontextprotocol/python-sdk#618 | **kept** (mcp-remote-oauth) |
| 12 | szhang1112/scPRS#2 | I1: asks for data |
| 13 | Lightricks/ComfyUI-LTXVideo#435 | I1: ComfyUI workflow file; I3: GPU |
| 14 | Lightricks/LTX-2#32 | I3: video model on GPU |
| 15 | vllm-project/vllm#15236 | I1: bug report |
| 16 | ConsistentlyInconsistentYT/Pixeltovoxelprojector#15 | I1: asks for example data |
| 17 | OliverRensu/GRAT#1 | I3: Flux image model on GPU |
| 18 | KittenML/KittenTTS#54 | **kept** (kittentts-streaming) |
| 19 | huggingface/lerobot#3172 | I1: change inside the library |
| 20 | anthropics/skills#189 | I1: bug report |
| 21 | Eigenwise/atomic-agents#73 | I1: changes inside the framework |
| 22 | browser-use/browser-use#291 | I1: bug report |
| 23 | MeiGen-AI/MultiTalk#16 | I3: A100/L4 GPU notebook |
| 24 | algorithmicsuperintelligence/openevolve#156 | I1: result report |
| 25 | Scottcjn/beacon-skill#864 | I1: bug report |
| 26 | dagster-io/dagster#30427 | I1: bug in an example Dockerfile |
| 27 | browser-use/browser-use#584 | I1: bug report |
| 28 | SparkAudio/Spark-TTS#10 | I2: not on PyPI; I3: GPU |
| 29 | algorithmicsuperintelligence/openevolve#15 | **kept** (openevolve-symreg) |
| 30 | pydantic/pydantic-ai#901 | **kept** (pydantic-ai-deep-research) |
| 31 | kijai/ComfyUI-WanVideoWrapper#1822 | I1: ComfyUI workflow file; I3: GPU |
| 32 | ArtificialAnalysis/Stirrup#8 | **kept** (stirrup-gdpval) |
| 33 | QwenLM/Qwen3-VL-Embedding#12 | I3: fine-tuning |
| 34 | HolmesGPT/holmesgpt#1802 | I1: change inside the product |
| 35 | huggingface/trl#2555 | I1: bug report |
| 36 | Haoming02/sd-webui-forge-classic#392 | I1: shell script; I3: GPU |
| 37 | ostris/ai-toolkit#543 | I1: training config file; I3: training |
| 38 | livekit/agents#1378 | **kept** (livekit-ultravox) |
