# Changelog

All notable changes to pinright are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-03

First public release. Earlier versions were never published to npm.

### MCP server

- `get-docs`: sections that answer a question, taken from the package at a given version (the
  published README, docs and type definitions, the source repository at its release tag, and the
  project's `llms.txt`). Without a version it documents the one installed in the project; for a
  vulnerable version it documents the same-line fix and says so first.
- `upgrade-guide`: breaking changes, removed or renamed APIs, config and default changes and the
  advisories fixed between two versions.
- `check-package` and `check-packages` (up to 50 at once): verdict with known advisories (OSV and
  deps.dev), malware records, deprecation, license, lookalike names, versions that do not exist,
  and the newest version without known advisories, preferring the release line already in use.
- `check-manifest`: whole-tree audit of lockfiles and manifests for npm, PyPI, Cargo, Go, Maven,
  Gradle, NuGet, RubyGems, Composer and GitHub Actions, with the chain and fix for each finding.
- `find-library`: library name to registry package, with the safe version and a verdict.
- Third-party text (docs, changelogs, release notes) arrives inside `untrusted-data` blocks that
  name their source.

### Pre-install hook

- `pinright hook <agent>` for Claude Code, Cursor, VS Code (GitHub Copilot), OpenAI Codex, Gemini
  CLI and Windsurf. It reads install commands, writes to manifests and workflow files, and Codex
  patches, and blocks or asks before the change runs.
- Notes for imports that are new in a write and missing from the project's manifests.
- Supply-chain patterns: a package first published less than 14 days ago that runs install
  scripts, and a release that adds install scripts from a publisher the earlier releases never had.

### CLI, policy and CI

- `pinright init` wires the MCP server, the hook where the client has one, and a starter
  `.pinright.json`, for 16 clients (for JetBrains AI Assistant it prints the JSON to paste). It
  keeps other entries, comments and indentation and backs up each file it changes. Project files
  get the portable `npx -y pinright`; user files get the global `pinright` binary when one is on
  PATH, so the hook starts in about 0.2 s instead of about 1 s. `--bin` and `--npx` choose one
  launcher everywhere. `init` does not add a second, different pinright hook next to an existing
  one, and `doctor` shows which launcher each client uses.
- `pinright doctor`, `check`, `audit` (text, JSON, SARIF), `upgrade` and `cache`.
- Team policy in `.pinright.json`: allow and deny lists, license rules, severity threshold,
  cooldown, and what to do when a source is down or a change cannot be verified.
- GitHub Action (`action.yml`) that runs `pinright audit`, writes a job summary, annotates the
  pull request and uploads SARIF to code scanning.
- Claude Desktop extension (`.mcpb`) built by `npm run build:mcpb`.

### Found in the launch benchmarks

These came out of the benchmark and replay runs before the release (see `bench/RESULTS-v7.md`).
The v7 benchmark ran on the code before them.

- A version that deps.dev has not indexed yet is no longer reported as "never published". deps.dev
  indexes new releases with a delay of hours: `jsonpointer==3.8` (PyPI) was still missing there
  eight hours after its upload, and the hook blocked it and suggested an older version. A deps.dev
  404 is now confirmed against the registry (npm, PyPI, crates.io, RubyGems) first. A version the
  registry publishes gets an "unverified" verdict that says deps.dev has no data for it yet, with
  advisories and malware records from osv.dev alone; the hook follows `onError` for it, as for any
  check that cannot complete. A whole package the registry publishes but deps.dev has never seen
  asks a human instead of being denied as nonexistent. When the registry cannot be reached, or for
  ecosystems without a registry client (Go, Maven, NuGet), deps.dev's answer stands.
- The hook and `check-manifest` no longer recommend a version that another dependency in the same
  manifest forbids. `stirrup` 0.2.1 pulls `moviepy` 2.2.1, which requires `pillow<12.0`; the fix for
  `pillow` 11.3.0 is 13.0.0, and agents that followed "consider an override" wrote a
  `requirements.txt` that does not resolve. The message now names the range and the package that sets
  it, recommends the newest clean release inside the range when there is one, and says whether a newer
  release of that package accepts the fix. npm peer ranges are checked the same way when the fix moves
  to a new major. A pin outside a range deeper in another pin's tree gets a note.
- The hook reads a few more real command shapes without a false alarm: `xargs npx <bin>`, a
  PowerShell assignment such as `$o = npx vitest run`, `Set-Content package.json ... -Encoding`, and
  `Push-Location`. A PowerShell assignment whose right side is an install (`$out = npm install x`)
  is now checked; before, it went through unread.
- `npx <bin>` after a bare `npm install`, `npm ci`, `pnpm install` or `yarn` in the same command runs
  the local bin when the folder's `package.json` lists the package that provides it, instead of
  being checked as a registry download. A version spec, `-p`, another folder, a command that could
  remove `node_modules` in between, or a production-only install keeps the check.
- `get-docs` says when a question asks for a member its object no longer declares (for example
  `graphql.query` on msw 3, where `graphql` only has `link`) and shows the current declaration first.
  `upgrade-guide` reports exports that moved to a new entry point, with the members they lost, and
  keeps nested changelog bullets with their parent.

[Unreleased]: https://github.com/Hiper-AI/pinright/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Hiper-AI/pinright/releases/tag/v1.0.0
