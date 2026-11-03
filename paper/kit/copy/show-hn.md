# Show HN

## Title

```
Show HN: pinright, version-accurate docs and dependency checks for coding agents
```

## First comment

Hi HN. We build security tooling for teams that use AI at Hiper AI, and we kept seeing the same thing
in agent-written projects: the code was fine, and the dependency versions were a year or two old with
known advisories. The model pins what it saw in training.

We measured it. Claude Code with Sonnet 5.5, Haiku 5.5 and Opus 5.5, 12 tasks we wrote (8 npm, 4
PyPI), two runs each, every project audited afterwards with `npm audit` or `pip-audit`. Without
tools, 40% to 42% of the direct dependencies each model pinned had at least one advisory, and
projects averaged about 30 alerts across their trees. Installing the same packages with no version
gave almost none, so the problem is the version, not the library.

pinright has four parts:

- An MCP server. `check-packages` gives a verdict for a dependency list (OSV + deps.dev advisories,
  malware records, lookalike names, deprecation, names that do not exist) and the version to pin,
  preferring the clean release on the line the project already uses. `get-docs` returns docs taken
  from the package at that version: README and type definitions, the wheel's API for Python, the
  repository at the release tag, and `llms.txt`.
- A pre-install hook for Claude Code, Cursor, VS Code/Copilot, Codex, Gemini CLI and Windsurf. It
  reads install commands and manifest writes before they run and denies a vulnerable pin, with the
  version to use. If it cannot read something (a git URL, a name in a variable), it asks you.
- `pinright audit`, a lockfile audit with SARIF output.
- A GitHub Action around the audit, which reads the policy file from the PR's base commit.

One result surprised us, and we would rather say it first. We ran pinright with its security layer
switched off, serving docs for each package's latest release and nothing else. That alone cut
whole-tree alerts from 715 to 766 per model down to 84, 63 and 6 (Sonnet, Haiku, Opus): most of the gain comes from steering the
agent to current versions. The full server took every model to 6 (all in nuxt dependencies with no
fixed release) and 0 vulnerable direct pins. The security layer catches what "latest" misses: an
agent that picks an older version to fit a peer range, a pre-release with advisories, a lookalike or
nonexistent name, and an agent that never calls the tool (the hook alone left 14).

Things we would like feedback on, because we know they are weak:

- The prompt-injection detector. pinright fences package text and drops passages that address the
  agent. It dropped 4 of 38,381 sections of real docs but caught only 20% to 40% of attack phrasings
  we wrote after freezing its rules. We treat it as a tripwire.
- The hook reads commands statically. `python -c "subprocess.run(['pip', ...])"` and `curl | sh` get
  past it. `docs/HOOK-THREAT-MODEL.md` lists the 57 vectors we tried; the second security review
  lists the reader gaps still open.
- False positives. On 25,077 public CI, script and README commands it blocked or asked about 1.46%,
  mostly on purpose. If it blocks something it should not, please open an issue.
- Our numbers come from one model vendor, two days of advisory data and tasks we wrote.

MIT licensed, no telemetry, no account. `npx pinright init` in a project sets it up. The technical
report, the aggregate CSVs and the benchmark scripts are in the repo; the raw transcripts are not.
