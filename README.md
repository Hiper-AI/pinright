# pinright

Version-accurate docs and a dependency check for coding agents.

<!-- The CI badge shows "repo not found" while the repository is private, and the npm badge
     "package not found" until the first publish. Both turn real on launch day; nothing to change. -->
[![npm](https://img.shields.io/npm/v/pinright?label=npm)](https://www.npmjs.com/package/pinright)
[![CI](https://github.com/Hiper-AI/pinright/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Hiper-AI/pinright/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Hiper-AI/pinright/blob/main/LICENSE)

Coding agents pin library versions from memory, and those versions often carry known
vulnerabilities: in our benchmark, about 40% of the direct dependencies that three Claude models
pinned on their own had a published advisory. pinright gives the agent docs for the exact version
it installs and a verdict on every dependency it adds, before the install runs. It ships as an MCP
server, a pre-install hook, a CLI and a GitHub Action, and runs on your machine.

## Install

Node 20.9 or newer. Pick one:

```bash
# Just you, in every project: the hook starts in about 0.2 s
npm i -g pinright && pinright init --user

# Your team: writes project files that you commit
npx -y pinright init
```

`init` wires the MCP server, the pre-install hook where the client has one, and a starter
`.pinright.json`. Name a client to set up only that one: `pinright init cursor` (or `codex`,
`cline`, ...). Restart the agent afterwards; `pinright doctor` shows what is wired and what answers.

pinright supports 16 clients. Six of them have a hook: Claude Code, Cursor, VS Code (GitHub
Copilot), OpenAI Codex, Gemini CLI and Windsurf. The others get the MCP tools. See
[every client, install links and scope rules](https://github.com/Hiper-AI/pinright/blob/main/docs/install.md).

## Benchmark

We ran Claude Code with three models on 12 coding tasks that ask for pinned versions (8 npm, 4 PyPI),
24 projects per arm and model, and audited each generated project with `npm audit` or `pip-audit`,
which share no code with pinright.

| Whole-tree alerts per project (direct deps with an advisory) | Sonnet 5.5 | Haiku 5.5 | Opus 5.5 |
|---|---|---|---|
| No docs | 33.1 (42%) | 29.6 (40%) | 29.9 (41%) |
| docs-only (pinright with the security layer off) | 2.0 (1%) | 0.9 (2%) | 0.3 (0%) |
| pinright MCP | 0.3 (0%) | 0.3 (0%) | 0.3 (0%) |
| pinright hook only | 0.6 (0%) | 0.4 (0%) | 0.6 (0%) |
| pinright MCP + hook | 0.3 (0%) | 0.3 (0%) | 0.3 (0%) |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Hiper-AI/pinright/main/paper/kit/figures/fig-a-alerts-per-project-dark.png">
  <img alt="Whole-tree alerts per project by arm and model: about 30 without docs, 0.3 with the pinright MCP server for each model" src="https://raw.githubusercontent.com/Hiper-AI/pinright/main/paper/kit/figures/fig-a-alerts-per-project.png">
</picture>

- **Docs.** On eight tasks whose library changed its API in the current major, every model wrote the
  current API in 16 of 16 runs with pinright, against 10 to 13 of 16 without docs.
- **Hook.** Replayed over 25,077 commands and file writes from 180 public repositories, the hook
  blocked or asked on 1.46% of them. It denied 0.13% of the entries without GitHub `${{ }}`
  templating.

The 0.3 alerts left per project in the MCP arms come from nuxt's dependencies, which have no fixed
release yet. The docs-only arm shows that docs for the current release remove most alerts on their
own; the verdict closes the rest. Caveats: every agent ran one vendor's models, we wrote the tasks, n is small, and
the advisory data is from one day (run v6, 2026-11-01).
Read the [full results](https://github.com/Hiper-AI/pinright/blob/main/docs/benchmark.md),
the [data and caveats](https://github.com/Hiper-AI/pinright/blob/main/bench/RESULTS-v6.md), the
technical report ([PDF](https://pinright.dev/report.pdf),
[Markdown](https://github.com/Hiper-AI/pinright/blob/main/paper/kit/pinright-report.md)), and
[how to reproduce it](https://github.com/Hiper-AI/pinright/blob/main/bench/RESULTS-v6.md#reproduce).

## What the agent sees

When the agent runs `npm install lodash@4.17.20`, the hook answers and the command does not run:

```
pinright blocked this dependency change:
- lodash@4.17.20 (npm) has 5 known advisories (CVE-2021-23337, CVE-2026-4800, CVE-2020-28500, HIGH). Use 4.x release 4.18.1: npm install lodash@4.18.1
Change the version (or the name) and try again. check-package and get-docs from the pinright MCP server explain each case.
```

When it asks first, `check-package` gives the same verdict as `pinright check npm lodash@4.17.20`:

```
SECURITY NOTICE: lodash (npm)@4.17.20 has 5 known advisories.
  - GHSA-35jh-r3h4-6jhm (CVE-2021-23337) [HIGH]: Command Injection in lodash fixed in 4.17.21
  - GHSA-r5fr-rjxr-66jc (CVE-2026-4800) [HIGH]: lodash vulnerable to Code Injection via `_.template` imports key names fixed in 4.18.0
  - ...
Recommended within 4.x: 4.18.1 (same release line, no API break expected). Upgrade: npm install lodash@4.18.1
```

## What it does

- **Docs at the exact version**, from the published package, its source repository at the release
  tag and the project's `llms.txt`, with no index service in between.
  [Where the docs come from](https://github.com/Hiper-AI/pinright/blob/main/docs/how-it-works.md#where-the-docs-come-from)
- **A verdict per dependency**: known advisories, malware records, deprecation, lookalike names, and
  the newest version without advisories, on the release line you already use when there is one.
  [How the safe version is chosen](https://github.com/Hiper-AI/pinright/blob/main/docs/how-it-works.md#how-the-safe-version-is-chosen)
- **A whole-tree audit** of lockfiles and manifests (npm, PyPI, Cargo, Go, Maven, NuGet, RubyGems,
  Composer, GitHub Actions), with SARIF output and a GitHub Action for code scanning.
  [CLI](https://github.com/Hiper-AI/pinright/blob/main/docs/cli.md) · [GitHub Action](https://github.com/Hiper-AI/pinright/blob/main/docs/action.md)
- **A pre-install hook** that reads install commands and manifest writes and blocks the bad change
  even when the agent never asked. [The hook](https://github.com/Hiper-AI/pinright/blob/main/docs/hook.md)
- **Team policy** in a committed `.pinright.json`: allow and deny lists, license rules, severity
  threshold, and what to do when a source is down.
  [Team policy](https://github.com/Hiper-AI/pinright/blob/main/docs/policy.md)

## Privacy

pinright runs locally, needs no account and sends no telemetry. It calls public registries,
advisory databases (deps.dev, OSV) and the docs sites of the packages you ask about;
[SECURITY.md](https://github.com/Hiper-AI/pinright/blob/main/SECURITY.md#what-it-sends-over-the-network-and-to-whom)
lists each host and what it receives.

## Documentation

- [Install](https://github.com/Hiper-AI/pinright/blob/main/docs/install.md): every client, install links, launchers and scopes
- [The hook](https://github.com/Hiper-AI/pinright/blob/main/docs/hook.md): what it reads and blocks, when a source is down, latency
- [How it works](https://github.com/Hiper-AI/pinright/blob/main/docs/how-it-works.md): MCP tools, safe versions, supply-chain signals, docs sources, upgrade guides, ecosystems
- [Team policy](https://github.com/Hiper-AI/pinright/blob/main/docs/policy.md): `.pinright.json`
- [CLI and configuration](https://github.com/Hiper-AI/pinright/blob/main/docs/cli.md): commands, exit codes, cache, environment variables, GitHub rate limit
- [GitHub Action and CI](https://github.com/Hiper-AI/pinright/blob/main/docs/action.md)
- [Prompt injection](https://github.com/Hiper-AI/pinright/blob/main/docs/prompt-injection.md): how third-party text reaches the agent
- [Benchmark](https://github.com/Hiper-AI/pinright/blob/main/docs/benchmark.md)
- [Hook threat model](https://github.com/Hiper-AI/pinright/blob/main/docs/HOOK-THREAT-MODEL.md) and [security review](https://github.com/Hiper-AI/pinright/blob/main/docs/SECURITY-REVIEW.md)
- [Changelog](https://github.com/Hiper-AI/pinright/blob/main/CHANGELOG.md); for maintainers, the
  [release runbook](https://github.com/Hiper-AI/pinright/blob/main/docs/RELEASE.md) and the
  [1.0.0 QA notes](https://github.com/Hiper-AI/pinright/blob/main/docs/QA-1.0.0.md)

## Contributing

The report we value most is a false positive: a command the hook blocked, or a package it flagged,
that should have passed. Open an issue with the template and paste the command and the output of
`npx pinright doctor --json`.
[CONTRIBUTING.md](https://github.com/Hiper-AI/pinright/blob/main/CONTRIBUTING.md) covers setup,
tests and adding an ecosystem or a client.

## Security

Report a vulnerability in pinright privately, as
[SECURITY.md](https://github.com/Hiper-AI/pinright/blob/main/SECURITY.md) describes. Please do not
open a public issue for it.

## License

MIT. Built by [Hiper AI](https://hiperai.com) ([opensource@hiperai.com](mailto:opensource@hiperai.com)).
Site: [pinright.dev](https://pinright.dev). Everyone taking part follows the
[Code of Conduct](https://github.com/Hiper-AI/pinright/blob/main/CODE_OF_CONDUCT.md).
