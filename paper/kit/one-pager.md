# pinright, in one page

**What it is.** An open-source tool (MIT, by Hiper AI) that checks the dependencies a coding agent
adds and gives it docs for the version it installs. One npm package, four ways to run it: an MCP
server, a CLI, a pre-install hook for Claude Code, Cursor, VS Code with Copilot, Codex, Gemini CLI and
Windsurf, and a GitHub Action. It runs on your machine, needs no account and sends no telemetry.

```bash
npx pinright init      # wires the MCP server and the hook into the agents the project uses
npx pinright doctor    # shows what answers and what is wired
```

**The problem.** Agents pin versions from memory. In our benchmark (Claude Code, three models, 12
tasks we wrote, two runs each, audited with `npm audit` and `pip-audit`), 40% to 42% of the direct
dependencies each model pinned without tools had a known advisory, and projects averaged 30 to 33
alerts across their dependency trees. The same packages installed without a version had almost none.
The version was the problem, not the library.

**What fixes it.** Moving the agent to current versions removes most of the exposure. pinright with
its security layer switched off, documenting each package's latest release, already cut alerts from
711 to 794 per model to 48, 21 and 6. The security layer removes the rest and covers what docs
cannot:

- a verdict on the exact version: OSV and deps.dev advisories, malware records, deprecation, names
  one typo from a popular package, names that do not exist;
- the fix on the same release line first, so an upgrade keeps the API;
- a hook that checks install commands and manifest writes even when the agent never asked.

With the full server, every model ended at 6 alerts over 24 projects, all in nuxt dependencies that
have no fixed release, and 0 vulnerable direct pins. The hook alone left 10 to 14.

**Docs that match the version.** Docs come from the package itself at that version (README, type
definitions, the Python API from the wheel), its repository at the release tag, and the project's
`llms.txt`. With them, all three models wrote the current API of eight recently changed libraries
(Next.js 16, AI SDK 7, Zod 4, LangChain 1 and others) in 16 of 16 runs, against 10 to 13 without.

**Measured cost.** About 2 to 4 more agent turns per run, and 1.5 to 2 times the API-equivalent cost of a
run without tools. The hook adds about 120 ms to a command that installs nothing, about 360 ms to an
install with a warm cache. On 25,077 public commands from 180 repositories, it blocked or asked about
1.44%, most of them on purpose (versions in variables, git sources, other registries).

**What it does not do.** It reads commands; it does not sandbox anything. A script that calls `pip`
itself, `curl | sh` or an obfuscated command gets past the hook. Its prompt-injection detector caught
20% to 40% of attack phrasings written after its rules were frozen, so treat it as a tripwire. Keep a
proxy registry and a sandbox. pinright knows published advisories only.

**How far to trust the numbers.** One model vendor, one day of advisory data (2026-11-01), two
repetitions, tasks we wrote. Every number, the raw-data CSVs and the scripts that regenerate them are
in the repository.

Code: github.com/Hiper-AI/pinright · Site: pinright.dev · Technical report: `paper/kit/pinright-report.pdf`
