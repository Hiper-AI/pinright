<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Hiper-AI/pinright/main/assets/cover-dark.png">
  <img alt="pinright: version-accurate docs and a dependency check for coding agents. The hook answer for npm install lodash@4.17.20: pinright blocked this dependency change; lodash 4.17.20 has 5 known advisories; use 4.x release 4.18.1." src="https://raw.githubusercontent.com/Hiper-AI/pinright/main/assets/cover.png">
</picture>

# pinright

**Version-accurate docs and a dependency check for coding agents.** Your agent pins library
versions from memory, and about 40% of those pins carry a known advisory. pinright gives it the
docs for the exact version it installs and a verdict on every dependency it adds, before the
install runs. MCP server, pre-install hook, CLI and GitHub Action, all local.

[![npm](https://img.shields.io/npm/v/pinright?label=npm)](https://www.npmjs.com/package/pinright)
[![CI](https://github.com/Hiper-AI/pinright/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Hiper-AI/pinright/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Hiper-AI/pinright/blob/main/LICENSE)
[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=pinright&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInBpbnJpZ2h0Il19)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_pinright-0098FF?style=flat-square)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522pinright%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522pinright%2522%255D%257D)

## Install

Node 20.9 or newer. One line, then restart the agent:

```bash
npm i -g pinright && pinright init --user   # just you, every project; the hook starts in about 0.2 s
npx -y pinright init                        # your team: writes project files you commit
```

`init` wires the MCP server, the pre-install hook where the client has one, and a starter
`.pinright.json`. 16 clients; six have a hook: Claude Code, Cursor, VS Code (GitHub Copilot),
OpenAI Codex, Gemini CLI and Windsurf. The Cursor and VS Code buttons above add the MCP server
only. [Every client, scopes and `pinright doctor`](https://github.com/Hiper-AI/pinright/blob/main/docs/install.md).

## Without pinright, with pinright

**Without.** The agent runs `npm install lodash@4.17.20`. It installs. The lockfile now carries
five advisories, two of them high, and nobody is told.

**With.** The hook answers before the command runs, and the agent reads this:

```
pinright blocked this dependency change:
- lodash@4.17.20 (npm) has 5 known advisories (CVE-2021-23337, CVE-2026-4800, CVE-2020-28500, HIGH). Use 4.x release 4.18.1: npm install lodash@4.18.1
Change the version (or the name) and try again. check-package and get-docs from the pinright MCP server explain each case.
```

The agent retries with `4.18.1`, on the same release line. When it asks first, `check-package`
and `get-docs` give it the same verdict with the full advisory list, the version to pin, and the
docs for that version. Real output of `pinright hook claude`, 2026-11-01.

## Measured

Claude Code with three models wrote 12 projects that ask for pinned versions, 2 runs per cell, on
the 1.0.0 code. We audited each project with `npm audit` or `pip-audit`, which share no code with
pinright.

| | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
|---|---|---|---|
| Whole-tree alerts per project, no docs → pinright MCP | 31.9 → 0.3 | 30.5 → 0.3 | 29.8 → 0.3 |
| Direct dependencies pinned with a known advisory | 40% → 0% | 42% → 0% | 40% → 0% |
| Docs tasks that used the current API, no docs → pinright | 13 of 16 → 16 of 16 | 14 of 16 → 16 of 16 | 9 of 16 → 16 of 16 |

The 0.3 left is nuxt, whose current release pulls packages with no fix published; installing
with no version at all gets the same 0.3. Docs alone, with the verdict off, already took alerts
down to 0.3 to 3.5 per project. One vendor's models, tasks we wrote, no shell, two days of advisory
data, and small n: intervals overlap between the pinright arms. In a second run with a shell, the
agents looked versions up with `npm view` or `pip index` before pinning, and every arm, with or
without pinright, ended at the same 6 alerts per model. The hook, replayed over 25,077
commands from 180 public repositories, blocked or asked on 1.46%. Replayed over a month of our
own agent sessions (154,402 distinct tool calls), it misread 10 of them.
[Results and caveats](https://github.com/Hiper-AI/pinright/blob/main/bench/RESULTS-v7.md) ·
[technical report](https://github.com/Hiper-AI/pinright/blob/main/paper/kit/pinright-report.md) ·
[reproduce it](https://github.com/Hiper-AI/pinright/blob/main/bench/RESULTS-v7.md#reproduce)

## Ask your agent

- "Add zod and pin a version with no known advisories."
- "Show me the docs for the version of next this project has installed."
- "Audit package-lock.json and tell me what to upgrade, on the same release lines."
- "What changed between express 4 and 5 before I move?"

## Tools

| Tool | What it does |
|---|---|
| `check-packages` | The verdict for up to 50 packages in one call: version to pin, short reason, full notice only where it matters |
| `check-package` | One package in depth: advisories with CVE and fix, deprecation, license, lookalike names, policy violations |
| `get-docs` | Docs from the published package and its repo at the release tag, for the version you name or the one installed |
| `find-library` | Library name to registry package (`next.js` to `npm:next`), with the safe version |
| `upgrade-guide` | What changes between two versions: breaking changes, renamed APIs, advisories the move fixes |
| `check-manifest` | Whole-tree audit of a lockfile or manifest, with SARIF; the GitHub Action runs it in CI |

Ecosystems: npm, PyPI, Cargo, Go, Maven and Gradle, NuGet, RubyGems, Composer, GitHub Actions.
Verdicts never say `ok` when a source did not answer. A committed `.pinright.json` sets allow and
deny lists, license rules, severity threshold and what to do when a source is down.
[How it works](https://github.com/Hiper-AI/pinright/blob/main/docs/how-it-works.md) ·
[the hook](https://github.com/Hiper-AI/pinright/blob/main/docs/hook.md) ·
[team policy](https://github.com/Hiper-AI/pinright/blob/main/docs/policy.md) ·
[CLI](https://github.com/Hiper-AI/pinright/blob/main/docs/cli.md) ·
[GitHub Action](https://github.com/Hiper-AI/pinright/blob/main/docs/action.md)

## Privacy and limits

No account, no telemetry. pinright sends package names and versions to deps.dev, OSV, the
registries, jsDelivr and GitHub, never your code;
[SECURITY.md](https://github.com/Hiper-AI/pinright/blob/main/SECURITY.md#what-it-sends-over-the-network-and-to-whom)
lists each host. The hook reads commands and files statically: it is a guardrail, not a sandbox,
and the [threat model](https://github.com/Hiper-AI/pinright/blob/main/docs/HOOK-THREAT-MODEL.md)
lists what gets past it. When a source is down the built-in default lets the install through;
the starter policy asks instead.

## More

[Install](https://github.com/Hiper-AI/pinright/blob/main/docs/install.md) ·
[prompt injection](https://github.com/Hiper-AI/pinright/blob/main/docs/prompt-injection.md) ·
[benchmark](https://github.com/Hiper-AI/pinright/blob/main/docs/benchmark.md) ·
[security review](https://github.com/Hiper-AI/pinright/blob/main/docs/SECURITY-REVIEW.md) ·
[changelog](https://github.com/Hiper-AI/pinright/blob/main/CHANGELOG.md) ·
[contributing](https://github.com/Hiper-AI/pinright/blob/main/CONTRIBUTING.md) ·
[release runbook](https://github.com/Hiper-AI/pinright/blob/main/docs/RELEASE.md)

The report we value most is a false positive: a command the hook blocked, or a package it
flagged, that should have passed. Open an issue with the template and paste the command and the
output of `npx pinright doctor --json`. Report a vulnerability in pinright privately, as
[SECURITY.md](https://github.com/Hiper-AI/pinright/blob/main/SECURITY.md) describes.

MIT. Built by [Hiper AI](https://hiperai.com) ([opensource@hiperai.com](mailto:opensource@hiperai.com)).
Site: [pinright.dev](https://pinright.dev). Everyone taking part follows the
[Code of Conduct](https://github.com/Hiper-AI/pinright/blob/main/CODE_OF_CONDUCT.md).
