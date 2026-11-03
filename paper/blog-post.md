# Your coding agent pins versions from memory. We built pinright to check them.

*Juan Pablo Mandelbaum, Hiper AI, 2026-11-03*

Ask a coding agent for a small FastAPI app with JWT login and it writes a `requirements.txt` with
exact versions. Those versions come from the model's training data. They were current a year or two
before the model shipped, and many have advisories published since.

We measured it on the 1.0.0 code. On 2026-11-02 we gave Claude Code 12 tasks we wrote, 8 for npm and 4 for PyPI, each
asking for pinned versions, and ran each one twice with three models: Sonnet 5.5, Haiku 5.5 and Opus
5.5. Then we audited every project with `npm audit` or `pip-audit`, tools that share no code with
ours. With no tools attached, 40% to 42% of the direct dependencies each model pinned had a known
advisory. Across the full dependency trees, projects averaged 30 to 32 alerts of the kind Dependabot
raises. Four of 72 came out clean.

The package choices were fine. When we installed the same packages without a version and let the
registry pick, 12 projects had 3 alerts between them, all in the dependencies of the current `nuxt`
release, which have no fix yet. The version numbers caused the rest.

## What pinright does

pinright is an MCP server, a CLI, a pre-install hook and a GitHub Action, under the MIT license.

**A verdict on each dependency.** Before the agent pins a package, pinright checks that exact version
against OSV and deps.dev: known advisories, malware records, deprecation, names one typo away from a
popular package, and names that do not exist. It recommends a version: the newest clean release on
the line the project already uses, so the upgrade keeps the API, then the nearest newer line, then the
newest. For npm it also flags install scripts in a brand-new package, a release that drops
provenance, and a change of publisher.

**Docs for the version you install.** Docs come from the package itself at that version: its README,
its type definitions or Python API, its repository at the release tag, and the project's `llms.txt`.
If the version the agent asked about has advisories, the answer opens with a notice and documents the
fixed version instead.

**A hook for when the agent does not ask.** For Claude Code, Cursor, VS Code with Copilot, Codex,
Gemini CLI and Windsurf, the hook reads each install command and each manifest write before it runs.
A pin with a clean alternative gets denied, with the version to use. What the hook cannot read, such
as a git URL or a package name in a variable, goes to you for approval.

**An audit for CI.** `pinright audit` checks a whole lockfile and writes SARIF for GitHub code
scanning. On the 394 lockfiles from the benchmark, it flagged the same vulnerable packages as
`npm audit` (mean Jaccard 0.96) and `pip-audit` (1.00).

## The numbers, and what they say

Whole-tree alerts summed over each model's 24 projects:

| | Sonnet 5.5 | Haiku 5.5 | Opus 5.5 |
|---|---|---|---|
| No tools | 766 | 715 | 732 |
| pinright, security layer off (docs only) | 84 | 63 | 6 |
| pinright MCP server | 6 | 6 | 6 |
| pinright hook only | 14 | 14 | 14 |
| MCP server + hook | 6 | 6 | 6 |
| Direct deps with an advisory, no tools / MCP | 40% / 0% | 40% / 0% | 42% / 0% |

We ran pinright with its security layer switched off on purpose, to see where the gain comes from.
In that mode it serves docs for each package's latest release and says nothing about advisories. It
already removed most of the alerts. Exposure drops when the agent pins a current version, and a docs
tool that points at the current release gets it most of the way there.

The security layer handles what is left. With it, every model pinned zero vulnerable direct
dependencies, and the remaining 6 alerts are the nuxt ones that an unpinned install also gets. In the
docs-only runs, Sonnet pinned `next` 15.5.0 (32 advisories) in both of its next-auth runs, and
Haiku pinned `next-auth` betas with advisories in both of its own; nothing told them. Those runs also took more turns
and cost more, because the agents asked for "latest" one package at a time. The hook alone, for
agents that never call the MCP server, left 14 alerts per model: it kept a Next.js app on the clean 15.x
release, which still pulls a vulnerable `postcss`.

Two more runs narrow the claim. When we gave the agents a shell and let them install for real, every
run without the MCP server looked versions up with `npm view` or `pip index versions` before pinning.
Every arm, with pinright or without, ended at the same 6 alerts per model. On these tasks, an agent
with a shell and a prompt that asks for exact pins landed on current versions without pinright. The
other run counted tokens: against the docs-only mode, the full server used 21% to 33% fewer per run.
One `check-packages` call gave the agent its versions, where the docs-only agent read docs for each
package to find them. An agent with no tools at all used fewer tokens than either.

On a second benchmark of eight tasks that need a library's newest major (Next.js 16, AI SDK 7, Zod 4
and others), all three models used the current API in 16 of 16 runs with pinright, against 13, 9 and
14 of 16 without. Most of that gap is AI SDK 7 and LangChain 1; the models already knew most of the
eight APIs. On eight APIs first released after August 2026, the gap was wider: 2 of 48 runs without
docs, 46 of 48 with pinright. Cost per run roughly doubled.

The hook has to stay out of the way. We replayed 25,077 commands from the CI files, scripts and
READMEs of 180 public repositories through it. It blocked or asked about 1.46% of them, most on
purpose (a version in a variable, a git source, another registry) and 32 because of real advisories.
On a month of our own Claude Code sessions, 154,402 distinct tool calls, it misread 10. A command
that installs nothing costs about 120 ms.

## What it does not do

pinright puts text written by package authors in front of your agent, so it fences that text, removes
hidden characters and drops passages that give the agent orders. On real docs it dropped 4 of 38,381
sections. On attacks written after its rules were frozen it caught 20% to 40%. Treat that detector as a
tripwire.

The hook reads commands; it does not sandbox anything. A Python script that calls `pip`, a
`curl | sh`, or an obfuscated command gets past it. `docs/HOOK-THREAT-MODEL.md` lists 57 bypass
vectors and their status, and two internal security reviews (24 findings, all fixed) list what stays
open. Run your agent in a sandbox, and keep a proxy registry if you have one.

The numbers come from one model vendor, two days of advisory data, two repetitions and tasks we wrote.
Our tasks start from empty folders, which favors "pin the latest"; we did not measure existing
projects. The technical report has the method, the intervals and the threats to validity.

## Try it

In a project:

```bash
npx pinright init
```

`init` wires the MCP server and the hook into the agents it finds. Restart your agent, and
`npx pinright doctor` shows what is wired. Code, benchmarks, aggregate CSVs and reproduction scripts
are at [github.com/Hiper-AI/pinright](https://github.com/Hiper-AI/pinright).
