# Design brief: pinright launch kit

For Claude Design. Everything referenced here is in this folder (`paper/kit/`).

## What pinright is

An open-source tool (MIT) by Hiper AI. It checks the dependencies a coding agent adds (known
advisories, malware records, lookalike names, packages that do not exist) and gives the agent docs
for the exact version it installs. It ships as one npm package: an MCP server, a CLI, a pre-install
hook for six coding agents and a GitHub Action. Launch: Tuesday 2026-11-03, version 1.0.0.
Repository: github.com/Hiper-AI/pinright. Site: pinright.dev.

## Audience

1. Developers who use coding agents (Claude Code, Cursor, Copilot, Codex, Gemini CLI, Windsurf).
2. Security engineers responsible for what those agents install.
3. People building AI tooling and MCP servers, who will read the method and the threat model.

They read code and benchmarks. They distrust marketing claims and check numbers.

## Tone

Plain and technical. Short sentences, concrete numbers, the limits stated next to the results. No
hype words, no exclamation marks, no fear-based framing. Show the terminal and the data. The voice
is an engineer explaining what they measured.

## Key messages, ranked

1. Coding agents pin dependency versions from memory, and 40% to 42% of those pins carried a known
   advisory in our test.
2. Pointing the agent at current versions removes most of that exposure; pinright's verdict removes
   the rest and catches what "latest" misses (older pins for compatibility, pre-releases, lookalike
   and nonexistent names).
3. The hook works even when the agent never asks: it reads install commands and manifest writes
   before they run, and tells the agent which version to use.
4. Docs come from the package at the version you install, so the agent writes the current API.
5. Local, open source, no account, no telemetry; every number is reproducible from the repository.

## The five numbers to show

| # | Number | Wording | Source |
|---|---|---|---|
| 1 | 40% to 42% | of direct dependencies pinned without tools had a known advisory (three models) | `data/agents_by_model_arm.csv`, `bench/AGENTS.md` |
| 2 | ~30 to 0.3 | whole-tree alerts per project, no tools vs the pinright MCP server (0.3 = the same as installing with no version) | `data/agents_by_model_arm.csv` (`alerts_per_project_mean`), figure a |
| 3 | 48 / 21 / 6 to 6 / 6 / 6 | alerts over 24 projects per model, docs for the latest release only vs the full verdict (Sonnet / Haiku / Opus) | same CSV, `docs-only` and `pinright` rows |
| 4 | 16 of 16 | docs-benchmark runs that wrote the current API with pinright, for each model (10 to 13 of 16 without) | `data/docs_by_model_arm.csv`, figure c |
| 5 | 1.46% | of 25,077 public commands the hook blocked or asked about, mostly on purpose | `data/fp_by_source.csv`, figure e |

Each number needs its qualifier on the same surface: "Claude Code, three models, 12 tasks we wrote,
2026-11-01". Never show number 1 or 2 without number 3 nearby, because the honest story is that
current versions do most of the work.

## Figures and visuals

| File | Intended use |
|---|---|
| `figures/fig-a-alerts-per-project` | Headline chart: blog hero, report Figure 3, landing benchmark section |
| `figures/fig-b-direct-deps-with-advisories` | Support for the 40% stat; pairs with fig a |
| `figures/fig-c-docs-current-api` | Docs claim: blog, report Figure 4 |
| `figures/fig-d-retrieval-probes` | Docs quality without an agent; technical readers |
| `figures/fig-e-hook-false-positives` | "Will it get in my way?": blog, FAQ, Show HN replies |
| `figures/fig-f-hook-latency` | "Will it slow my agent down?": FAQ, docs |
| `figures/fig-g-architecture` | How it works: landing, report Figure 1, slides |
| `figures/fig-h-what-the-agent-sees` | The product moment: social card, landing hero, report Figure 2 |
| `visuals/cli/pinright-doctor` | Install and setup step |
| `visuals/cli/pinright-check-lodash` | CLI for people, same verdict the agent gets |
| `visuals/cli/pinright-audit-sarif`, `pinright-sarif-summary` | CI and code-scanning story |
| `visuals/landing/*` | Current landing (desktop and mobile, EN and ES), for reference; its numbers are the older v5 ones, see `claims.md` section 2 |

Every figure comes as SVG and 2x PNG, light (`<id>`) and dark (`<id>-dark`), with a caption in
`figures/<id>.caption.md` and alt text in `copy/alt-text.md`. The charts are generated from the CSVs
by `make-figures.ts`; if you restyle them, keep the values, the intervals and the source line.

Chart conventions to keep: one color per arm in every chart (no docs and no pin in gray, docs-only
orange, MCP blue, hook only green, MCP + hook amber), intervals drawn wherever the data has them, a
zero baseline, labels in ink colors.

## Brand constraints

- Maker: Hiper AI. "pinright by Hiper AI" or "Open source · MIT · by Hiper AI".
- Wordmark: **pinright**, always lowercase, also at the start of a sentence and in titles.
- Product parts keep their names: MCP server, CLI, hook (pre-install hook), GitHub Action.
- Monospace for commands and package names (`npx pinright init`, `lodash@4.17.20`).
- The install command to show: `npx pinright init`.

## What must not be said

- Absolute claims: "blocks every vulnerable package", "prevents supply-chain attacks", "safe",
  "secure by default", "never", "always", "guaranteed", "zero risk".
- "certified", "compliant", "100% protection" or any compliance language. "16 of 16" is a measured
  result, not "100% accurate".
- Comparisons with, or names of, other docs services, MCP servers, scanners or vendors.
- That docs tools "don't change versions": our own ablation shows that docs for the current release
  remove most alerts.
- That the hook is a sandbox or contains a compromised agent. It reads commands; it is a guardrail
  and a speed bump.
- That the prompt-injection detector stops injections. It caught 20% to 40% of new phrasings.
- Results generalized beyond what was measured: one vendor's models, one day of advisory data, tasks
  we wrote, new projects only.
