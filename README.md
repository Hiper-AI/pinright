# safectx

Library docs for your coding agent that match the version it installs, plus the checks that
keep a vulnerable, deprecated, malicious or misspelled package out of your project.

Coding agents pin versions from memory, or from whatever version a docs service indexed. Both are
often months old and carry known vulnerabilities. safectx gives the agent:

- **Docs for a specific version**, taken from the package itself: the README, docs and type
  definitions published at that version, the source repository at its release tag, and the
  project's `llms.txt`. No index service in between. Context7 is an optional fallback.
- **A verdict before every dependency**: known advisories (CVE/GHSA), malware records, deprecation,
  typosquat lookalikes, and the newest clean version, preferring one on the release line the
  project already uses so the upgrade does not break the API.
- **A whole-tree audit**: every package in a lockfile, direct and transitive, the way Dependabot
  sees it, with the fix for each finding.
- **A pre-install hook** for Claude Code and Cursor that blocks the bad change even when the agent
  never asked.

```
agent --MCP--> safectx --> registry + jsDelivr     package files at the exact version
                       --> GitHub (raw, tree API)  repo docs at the release tag
                       --> project site            llms.txt / llms-full.txt
                       --> api.deps.dev            versions, advisories, licenses, dependency graphs
                       --> api.osv.dev             CVE details, fixed versions, malware (MAL-*)
                       --> context7.com            only when the above came back thin (optional)
```

## Install

Claude Code, MCP server and hook in the current project:

```bash
npx -y safectx init claude
```

Cursor:

```bash
npx -y safectx init cursor
```

`init` writes `.mcp.json` and `.claude/settings.json` (or `.cursor/mcp.json` and
`.cursor/hooks.json`), keeping what is already there. `--no-hook` or `--no-mcp` installs one half.

Any other MCP client:

```json
{ "mcpServers": { "safectx": { "command": "npx", "args": ["-y", "safectx"] } } }
```

No key is required. A `GITHUB_TOKEN` raises GitHub's limit for repo docs (60 requests an hour
without one; each package version costs one request and is cached for a week).

## What the agent sees

Docs for a version with known holes come back with the notice first, and for the version to move to:

```
query-docs { libraryId: "npm:next@15.1.0", query: "protect routes with middleware" }

SECURITY NOTICE: next (npm)@15.1.0 has 36 known advisories.
  - GHSA-f82v-jwr5-mffw (CVE-2025-29927) [CRITICAL]: Authorization Bypass in Next.js Middleware fixed in 13.5.9, 14.2.25, 15.2.3
  - ...
Recommended within 15.x: 15.5.28 (same release line, no API break expected). Upgrade: npm install next@15.5.28
Newest safe overall: 16.4.3 (a different major: read its migration guide before switching).
These docs are for 15.5.28, the version to move to, not 15.1.0.

Docs for next@15.5.28 (npm): The React Framework.
### How to implement authentication in Next.js > Authorization > Optimistic checks with Middleware (Optional)
Source: next.js/docs/01-app/02-guides/authentication.mdx@v15.5.28 (next@15.5.28) https://raw.githubusercontent.com/vercel/next.js/v15.5.28/docs/01-app/02-guides/authentication.mdx
```

The hook, when the agent writes a manifest or runs an install:

```
safectx blocked this dependency change:
- jsonwebtoken@8.5.1 (npm) has 3 known advisories (CVE-2022-23539, ...). No clean release on this line;
  the fix needs a new major, 9.0.3: npm install jsonwebtoken@9.0.3
- starlette==0.38.6 (pypi) has 7 known advisories (...). It comes in through fastapi: upgrade fastapi to
  0.162.0 (new major), which pulls starlette 1.10.0 with no known advisories, and pin starlette to that
  version or drop the pin.
- express@4.21.2 (npm) pulls dependencies with known advisories (path-to-regexp@0.1.12, qs@6.13.0).
  npm install express@4.22.3 pulls fixed versions on the same release line.
```

## Tools

| Tool | What it does |
|---|---|
| `resolve-library-id` | Library name to registry package (`next.js` to `npm:next`, `pytorch` to `pypi:torch`), ranked by repo stars, with the safe version and a verdict. Suggests the real name for a misspelled one. |
| `query-docs` | Sections that answer the question, from the package at a given version. Without a version it documents the safe one; with a vulnerable one it documents the same-line fix. Context7 ids (`/vercel/next.js`) work too. |
| `check-package` | The verdict for one package: advisories with CVE, severity and fixed versions, deprecation, license, safe version on the same line and overall, typosquat lookalikes. |
| `upgrade-guide` | What changes between two versions: breaking changes, removed or renamed APIs, config and default changes, packages that split off, deprecations, and the advisories the move fixes. Without `to` it targets the recommended version. |
| `check-manifest` | Whole-tree audit of `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements*.txt`, `poetry.lock`, `uv.lock`, `pdm.lock`, `Cargo.lock`, `go.mod`, `Gemfile.lock`, `packages.lock.json`, or a bare `package.json` / `pyproject.toml` / `Cargo.toml` resolved through deps.dev. Each finding comes with its chain and fix. |

Verdicts: `ok`, `vulnerable`, `malicious`, `deprecated`, `possible-typosquat`, `unknown-package`,
`unknown`. `unknown` means a data source did not answer; safectx never says `ok` when it could not check.

## The hook

`safectx hook claude` (a `PreToolUse` hook on `Bash|Write|Edit|MultiEdit`) and `safectx hook cursor`
(`beforeShellExecution` and `preToolUse`) read what the agent is about to do:

- installs: `npm`/`pnpm`/`yarn`/`bun add|install`, `npx`/`pnpm dlx`/`bunx`, `pip install` (also `-r file`),
  `uv add`/`uv pip install`, `uvx`, `pipx`, `poetry add`, `pdm add`, `cargo add|install`, `go get|install`,
  `gem install`, `bundle add`, `dotnet add package`;
- writes to `package.json`, `requirements*.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`: only
  dependencies that are new or changed version count, so editing an old project does not re-open
  every old dependency.

It blocks malware, typosquats, packages or versions that do not exist, versions with known advisories
when a clean one exists, deprecated versions with a maintained successor, and dependencies whose
transitive tree has advisories that a same-line upgrade clears. When a vulnerable pin is itself a
dependency of another pinned package, it points at the parent upgrade, so the fix still installs.
It also blocks a manifest whose pinned versions contradict each other (a pin outside the range its
parent requires), because that install would fail. When no clean version exists at all, it asks a
human for high and critical advisories and lets the rest through with a note, so the work does not stop
on a moderate finding nobody can fix yet. Everything else passes, with notes for the agent.

| Variable | Default | Meaning |
|---|---|---|
| `SAFECTX_ALLOW` | none | Comma list of names that skip the hook, `*` suffix allowed (`@acme/*`). For private packages. |
| `SAFECTX_HOOK_ON_ERROR` | `allow` | What to do when deps.dev or OSV cannot be reached: `allow`, `ask` or `deny`. |
| `SAFECTX_HOOK_NO_FIX` | `severity` | When no clean version exists: `severity` asks for high/critical and allows the rest; or `allow`, `ask`, `deny` for all. |
| `SAFECTX_HOOK_COOLDOWN` | `warn` | `enforce` blocks an unpinned install whose newest version is inside the cooldown window. |
| `SAFECTX_HOOK_TIMEOUT_MS` | `45000` | Deadline for the whole check; on timeout it behaves as `SAFECTX_HOOK_ON_ERROR`. |

## Upgrade guides

When safectx recommends a new major, the agent tends to write code and config for the old API from
memory: a `tsconfig.json` without `rootDir` for TypeScript 6+, `middleware.ts` for Next.js 16 where
the file is now `proxy.ts`, an import from `langchain` for text splitters that moved to
`langchain-text-splitters`. `upgrade-guide` gives the agent the changes between the two versions
before it writes anything, and you can run it by hand to fix a Dependabot PR:

```
upgrade-guide { libraryId: "npm:next", from: "15.5.28", to: "16.4.3", query: "middleware" }
npx safectx upgrade npm next 15.5.28 16.4.3 --query="middleware"
npx safectx upgrade pypi pydantic 1.10.x 2.x       # ranges resolve to their newest release
```

It reads, all at the target version and cached:

1. `CHANGELOG`, `HISTORY`, `CHANGES` and `RELEASES` files from the published package and from the repo
   at the release tag, keeping only the sections for versions after `from` up to `to`;
2. GitHub release notes for the tags in that range, and the announcement post when a release body only
   links to one (TypeScript's);
3. migration guides when the move crosses a major: files and `llms.txt` pages named after migrating or
   upgrading to that major;
4. for npm, a diff of the exported API in the `.d.ts` files of both versions: removed exports, changed
   signatures, removed members.

Entries come back tagged `BREAKING`, `CONFIG/DEFAULT`, `NEW PACKAGE` or `DEPRECATED`, each with its
version and source. The answer opens with the advisories the move fixes and any that remain at `to`.
It fits the same budget as `query-docs` (`tokens` argument). Without a `GITHUB_TOKEN` it reads fewer
release pages.

## How the safe version is chosen

The newest version that is stable (no `rc`, `beta`, `canary`, Go pseudo-versions), not deprecated,
has no advisory in deps.dev (which mirrors OSV and the GitHub Advisory Database), and was published at
least 3 days ago. The cooldown exists because compromised releases are usually pulled within days.

When the project already uses a version, safectx also gives the newest clean version on its release
line (`3.x`, or `0.28.x` before 1.0, where minors break), and says so when only a new major is clean.
When the recommended version belongs to a major less than a year old, the notice says so and points
the agent to that version's docs: its configuration may differ from what the model learned.

A version counts as clean only when both deps.dev and OSV agree; OSV publishes new advisories hours
before deps.dev mirrors them.

## Where the docs come from

1. The published package at the exact version, through jsDelivr: README, bundled docs, and the
   `.d.ts` type definitions, which are the ground truth of an npm package's API.
2. The source repository at the release tag (`v1.2.3`, `1.2.3`, `name@1.2.3`, `name==1.2.3`...):
   `docs/` folders, guides, migration notes. Translations are skipped.
3. The project's `llms-full.txt` or `llms.txt`, which describe the current site and may be newer
   than the version you use; sections from it are labeled as such.
4. Context7, only when the three above return nothing relevant. `SAFECTX_CONTEXT7=off` disables it.

Sections are ranked locally with BM25 against the question, and the answer is capped at about
5,000 tokens (`tokens` argument, or `SAFECTX_DOCS_BUDGET` in characters).

## CLI

```bash
npx safectx check npm axios@1.7.9          # exit 1 if not ok
npx safectx audit . --fail-on=high         # whole-tree audit for CI, exit 1 on findings
npx safectx audit package-lock.json --json
npx safectx upgrade npm zod 3.25.76 4.6.7  # what changes between two versions
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SAFECTX_COOLDOWN_DAYS` | `3` | Minimum age of a version to be recommended. |
| `SAFECTX_MAX_CANDIDATES` | `12` | Versions inspected, newest first, before giving up on a safe one. |
| `SAFECTX_CONTEXT7` | `fallback` | `off` never calls Context7. |
| `CONTEXT7_API_KEY` | none | Raises Context7's rate limit when it is used. |
| `GITHUB_TOKEN` / `GH_TOKEN` | none | Raises GitHub's rate limit for repo docs. Read-only use. |
| `SAFECTX_DOCS_BUDGET` | `20000` | Characters of docs per answer. |
| `SAFECTX_CACHE_DIR` | OS cache dir `/safectx` | Disk cache (docs 7 days, advisories 24 h). |
| `SAFECTX_NO_CACHE` | unset | `1` disables the cache. |
| `SAFECTX_TIMEOUT_MS` | `15000` | Per-request timeout. |

No telemetry. Requests go from your machine to the public APIs above and nowhere else. Docs
content is data for the agent; safectx does not execute anything it downloads.

## Benchmark

Claude Code (Sonnet 5.5) in headless mode on 12 coding tasks (8 npm, 4 PyPI) that ask for pinned
versions, twice per arm. Each project is then audited with `npm audit` or `pip-audit`, which share
nothing with safectx, and installed and built for real. Run of 2026-10-29, full report in
[bench/AGENTS.md](bench/AGENTS.md):

| | No docs | Context7 | safectx MCP | Hook only | MCP + hook |
|---|---|---|---|---|---|
| Direct deps with a known advisory | 39% | 42% | 0% | 3% | 0% |
| Whole-tree alerts, 24 projects | 714 | 746 | 10 | 14 | 6 |
| Critical + high alerts (npm) | 177 | 184 | 4 | 4 | 2 |
| Projects that install and build | 24 | 24 | 23 | 23 | 24 |
| Cost per run (USD) | 0.03 | 0.04 | 0.07 | 0.04 | 0.07 |

The safectx arms ran with Context7 turned off. On the same 132 lockfiles, `check-manifest` flagged
the same vulnerable packages as `npm audit` and `pip-audit` (mean Jaccard 0.95 for npm, 1.00 for PyPI).
These numbers come from one model, one day and tasks we wrote; they are not a guarantee.

## Development

```bash
npm install
npm test                                   # offline unit tests with fixtures
npm run build && npx tsx scripts/e2e.ts .  # drive the server over stdio with a real MCP client
npx tsx scripts/docs.ts npm next 16.4.3 "middleware"   # what query-docs returns
npx tsx scripts/audit.ts package-lock.json # whole-tree audit
npx tsx scripts/upgrade.ts npm next 15.5.28 16.4.3 "middleware"   # what upgrade-guide returns
npm run bench:agents                       # agent benchmark, see bench/agents/
```

## License

MIT
