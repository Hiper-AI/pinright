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
agent --MCP--> safectx --> registry + jsDelivr     package files at the exact version (npm)
                       --> PyPI files              wheel/sdist at the exact version (Python API)
                       --> GitHub (raw, tree API)  repo docs at the release tag
                       --> project site            llms.txt / llms-full.txt
                       --> api.deps.dev            versions, advisories, licenses, dependency graphs
                       --> api.osv.dev             CVE details, fixed versions, malware (MAL-*)
                       --> packagist.org           Composer versions and advisories
                       --> api.github.com          commits and tags behind GitHub Actions refs
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
It also writes a commented starter [`.safectx.json`](#team-policy-safectxjson) when the project has
none (`--no-config` skips it); it never overwrites an existing one.

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
| `resolve-library-id` | Library name to registry package (`next.js` to `npm:next`, `pytorch` to `pypi:torch`), ranked by repo stars, with the safe version and a verdict. Hits the project already depends on carry `installedVersion` and `installedIn`. Suggests the real name for a misspelled one. |
| `query-docs` | Sections that answer the question, from the package at a given version. Without a version it documents the one installed in the project, or the safe one when the project does not use the package; with a vulnerable one it documents the same-line fix. Context7 ids (`/vercel/next.js`) work too. |
| `upgrade-guide` | What changes between two versions: breaking changes, removed or renamed APIs, config and default changes, packages that split off, deprecations, and the advisories the move fixes. Without `to` it targets the recommended version. |
| `check-packages` | The verdict for up to 50 packages in one call: one table row each (verdict, version to pin, short reason), and the full notice only for the ones that need attention. The cheap way to vet a dependency list. |
| `check-package` | The verdict for one package: advisories with CVE, severity and fixed versions, deprecation, license, safe version on the same line and overall, typosquat lookalikes, and team policy violations. Without a version it checks the installed one. |
| `check-manifest` | Whole-tree audit of `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements*.txt`, `poetry.lock`, `uv.lock`, `pdm.lock`, `Cargo.lock`, `go.mod`, `Gemfile.lock`, `packages.lock.json`, or a bare `package.json` / `pyproject.toml` / `Cargo.toml` resolved through deps.dev. Also Maven, Gradle, Composer and GitHub Actions files (see [Ecosystems](#ecosystems)). Each finding comes with its chain and fix. |

Verdicts: `ok`, `vulnerable`, `malicious`, `deprecated`, `possible-typosquat`, `unknown-package`,
`unknown`. `unknown` means a data source did not answer; safectx never says `ok` when it could not check.

## The hook

`safectx hook claude` (a `PreToolUse` hook on `Bash|Write|Edit|MultiEdit`) and `safectx hook cursor`
(`beforeShellExecution` and `preToolUse`) read what the agent is about to do:

- installs: `npm`/`pnpm`/`yarn`/`bun add|install`, `npx`/`pnpm dlx`/`bunx`, `pip install` (also `-r file`),
  `uv add`/`uv pip install`, `uvx`, `pipx`, `poetry add`, `pdm add`, `cargo add|install`, `go get|install`,
  `gem install`, `bundle add`, `dotnet add package`, `composer require`, `composer create-project`;
- writes to `package.json`, `requirements*.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`,
  `build.gradle`, `build.gradle.kts`, `gradle/libs.versions.toml`, `composer.json`: only
  dependencies that are new or changed version count, so editing an old project does not re-open
  every old dependency;
- writes to `.github/workflows/*.yml` and `action.yml`: new or re-pointed `uses:` lines.

It blocks malware, typosquats, packages or versions that do not exist, versions with known advisories
when a clean one exists, deprecated versions with a maintained successor, and dependencies whose
transitive tree has advisories that a same-line upgrade clears. When a vulnerable pin is itself a
dependency of another pinned package, it points at the parent upgrade, so the fix still installs.
It also blocks a manifest whose pinned versions contradict each other (a pin outside the range its
parent requires), because that install would fail. When no clean version exists at all, it asks a
human for high and critical advisories and lets the rest through with a note, so the work does not stop
on a moderate finding nobody can fix yet. It also blocks two supply-chain patterns (see below): a
package first published less than 14 days ago that runs install scripts, and a release that adds install
scripts and comes from a publisher the previous releases never had. Everything else passes, with notes
for the agent.

The team policy in `.safectx.json` (next section) sets the same knobs for the whole repo. The hook
reads the nearest one walking up from its working directory to the repository root. These variables
override the file:

| Variable | Default | Meaning |
|---|---|---|
| `SAFECTX_ALLOW` | none | Comma list of names that skip the hook, `*` wildcard (`@acme/*`). Added to the file's `allow`. For private packages. |
| `SAFECTX_HOOK_ON_ERROR` | `allow` | What to do when deps.dev or OSV cannot be reached: `allow`, `ask` or `deny`. |
| `SAFECTX_HOOK_NO_FIX` | `severity` | When no clean version exists: `severity` asks for high/critical and allows the rest; or `allow`, `ask`, `deny` for all. |
| `SAFECTX_HOOK_COOLDOWN` | `warn` | `enforce` blocks an unpinned install whose newest version is inside the cooldown window. |
| `SAFECTX_HOOK_TIMEOUT_MS` | `45000` | Deadline for the whole check; on timeout it behaves as `SAFECTX_HOOK_ON_ERROR`. |
| `SAFECTX_HOOK_RISK` | `enforce` | Supply-chain signals: `enforce` blocks the two patterns above, `warn` only notes them, `off` ignores them. |
| `SAFECTX_SEVERITY_THRESHOLD` | `low` | Advisories below this severity (`low`, `moderate`, `high`, `critical`) become notes instead of blocks. |
| `SAFECTX_ACTIONS_PIN` | `warn` | `enforce` blocks a GitHub Action referenced by a tag or branch instead of a commit SHA. |

## Supply-chain signals

OSV marks a malicious release (`MAL-*`) days after the attack. The release's behavior shows earlier, so
for the version you would install (the one you pass, or the latest), safectx also reports a `risk`
section with signals at three levels: `info`, `warn` and `high`.

| Signal | Source | Level |
|---|---|---|
| Install scripts (`preinstall`, `install`, `postinstall`, implicit `node-gyp`) | npm version document | `info`; `warn` when the previous releases had none; `high` when the package is brand new, or when the scripts arrive with a new publisher |
| Provenance dropped: earlier releases had an npm provenance attestation, this one has none | npm version document | `warn`, `high` with a new publisher |
| Publisher change: the account that published this recent release published none of the previous ones | npm `_npmUser` | `warn`; `info` when that account was already a maintainer or the release has provenance |
| Young package, with weekly downloads | deps.dev first publish date, npm downloads API, pypistats.org | `warn` when young and under the download threshold, `info` otherwise |
| OpenSSF Scorecard below the threshold, or a dangerous workflow, with the notable failing checks | deps.dev project | `info` only |

Install scripts, provenance and publisher come from npm only; Scorecard and age cover every ecosystem
deps.dev knows, and downloads cover npm and PyPI. safectx reads the version documents of the requested
release and up to 5 earlier ones (a few KB each), never the full packument. Missing data produces no
signal, and the notice lists sources that did not answer under "Not verified". Signals never change
the verdict.

| Variable | Default | Meaning |
|---|---|---|
| `SAFECTX_RISK_NEW_PACKAGE_DAYS` | `14` | A package younger than this with install scripts is `high` (blocked by the hook). |
| `SAFECTX_RISK_RECENT_DAYS` | `30` | Window for "young package" and for flagging a publisher change. |
| `SAFECTX_RISK_LOW_DOWNLOADS` | `100` | Weekly downloads under this, on a young package, is a `warn`. |
| `SAFECTX_RISK_SCORECARD_LOW` | `4` | Scorecard under this is noted. |
| `SAFECTX_RISK_HISTORY` | `5` | Earlier releases compared for scripts, provenance and publisher. |

Typosquat lookalikes are checked against about 3,600 npm and 3,000 PyPI names, regenerated by
`npx tsx scripts/popular.ts` from pinned public rankings (see the header of `src/data/popular.ts`).

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

## Project detection

Agents rarely say which version the project uses, and docs for a newer version produce code against
APIs the project does not have. safectx reads the project's dependency files by itself:

- **Where.** The roots the MCP client announces (and re-reads them on `roots/list_changed`). Without
  them, `SAFECTX_PROJECT_DIR` (several directories separated by the OS path delimiter), else the working
  directory: Claude Code and Cursor launch stdio servers inside the project. When that directory has
  no dependency files, the nearest parent that has them, up to the repository root. Subprojects up to
  three levels down count too (monorepos), skipping `node_modules`, build output and hidden folders.
- **What.** One file per ecosystem and directory, lockfile first: the exact version from the lockfile;
  for npm without a lockfile, the version in `node_modules`; an exact pin in a manifest; else the
  version the manifest's range resolves to today, and the answer says so.
- **How it is used.** `query-docs` and `check-package` without a version use the installed one and say
  so in one line, then apply the same checks as for an explicit version: a vulnerable installed
  version gets the same-line fix and docs for it. An explicit version always wins.

```
query-docs { libraryId: "npm:next", query: "middleware" }

Using next 15.1.0, installed in this project (package-lock.json).
SECURITY NOTICE: next (npm)@15.1.0 has 36 known advisories.
...
These docs are for 15.5.28, the version to move to, not 15.1.0.
```

When a monorepo has several versions of the package, the line lists the others. safectx reads only
dependency files, keeps them parsed in memory and re-reads one when its modification time changes.

## Team policy (`.safectx.json`)

A `.safectx.json` at the project root, committed with the code, gives every developer and every agent
the same rules. It is JSON with `//` comments allowed. Every key is optional:

```jsonc
{
  "allow": ["@acme/*"],                       // skip every check (private packages); "*" is a wildcard
  "deny": [
    "left-pad",                               // any ecosystem
    { "name": "request", "ecosystem": "npm", "reason": "unmaintained; use undici" }
  ],
  "licenses": {
    "deny": ["AGPL-*", "SSPL-*"],             // SPDX ids, "*" wildcard
    "allow": ["MIT", "Apache-2.0", "BSD-*", "ISC"]  // when set, anything else is denied
  },
  "severityThreshold": "high",                // low | moderate | high | critical
  "cooldownDays": 7,                          // minimum age of a recommended version
  "cooldown": "enforce",                      // warn | enforce
  "noFix": "severity",                        // severity | allow | ask | deny
  "onError": "ask",                           // allow | ask | deny
  "actionsPin": "warn"                        // off | warn | enforce (GitHub Actions pinned to a SHA)
}
```

| Key | Hook | MCP tools |
|---|---|---|
| `allow` | Listed names pass without a check. `allow` wins over `deny`. | No policy findings for them. |
| `deny` | Denied with the reason, before any lookup. Only new or changed lines of a manifest count. | `POLICY:` line in `check-package` and `query-docs`; every match in the tree in `check-manifest`. |
| `licenses` | A version whose license expression has no acceptable alternative is denied (`MIT OR AGPL-3.0` passes a deny on `AGPL-*`). A missing or non-SPDX license is a note. | Same, for the version checked; direct dependencies in `check-manifest`. |
| `severityThreshold` | When every advisory of a version is rated below it, the hook allows with a note. Unrated advisories and malware always count. Applies to transitive findings too. | Not applied: the tools report every advisory. |
| `cooldownDays`, `cooldown` | As `SAFECTX_COOLDOWN_DAYS` and `SAFECTX_HOOK_COOLDOWN`. | `cooldownDays` changes the recommended version. |
| `noFix`, `onError` | As `SAFECTX_HOOK_NO_FIX` and `SAFECTX_HOOK_ON_ERROR`. | |

Precedence is built-in defaults, then the file, then environment variables. Lists merge
(`SAFECTX_ALLOW` adds to `allow`); single values from the environment replace the file's.

A file that is not valid JSON, or has an unknown key or a wrong value, does not count as "no policy":
the hook denies every dependency change with the error until someone fixes the file, and the MCP tools
start their answer with `POLICY ERROR`. Editing `.safectx.json` itself is not a dependency change, so
the agent can fix it.

## Ecosystems

| Ecosystem | Hook: commands | Hook: file writes | `check-manifest` / `audit` | Versions and advisories |
|---|---|---|---|---|
| npm | `npm`/`pnpm`/`yarn`/`bun`, `npx`, `pnpm dlx` | `package.json` | `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `package.json` | deps.dev + OSV |
| PyPI | `pip`, `uv`, `uvx`, `pipx`, `poetry`, `pdm` | `requirements*.txt`, `pyproject.toml` | `requirements*.txt`, `poetry.lock`, `uv.lock`, `pdm.lock`, `pyproject.toml` | deps.dev + OSV |
| Cargo | `cargo add\|install` | `Cargo.toml` | `Cargo.lock`, `Cargo.toml` | deps.dev + OSV |
| Go | `go get\|install` | `go.mod` | `go.mod` | deps.dev + OSV (no graphs) |
| RubyGems | `gem install`, `bundle add` | | `Gemfile.lock` | deps.dev + OSV (no graphs) |
| NuGet | `dotnet add package` | | `packages.lock.json` | deps.dev + OSV (no graphs) |
| Maven / Gradle | | `pom.xml`, `build.gradle`, `build.gradle.kts`, `gradle/libs.versions.toml` | `gradle.lockfile`, or the build files resolved through deps.dev | deps.dev + OSV |
| Composer | `composer require`, `create-project` | `composer.json` | `composer.lock`, `composer.json` | Packagist + OSV + Packagist advisories |
| GitHub Actions | | `.github/workflows/*.yml`, `action.yml` | a workflow, `action.yml`, `.github/workflows`, or the project root | OSV + GitHub API |

**Maven and Gradle.** In `pom.xml`, `${...}` versions resolve from `<properties>` and `project.version`
in the same file. In Gradle scripts, safectx reads `"g:a:v"` and map notation, `$var` from simple
assignments and `gradle.properties`, and `libs.*` references to the version catalog. A dependency
without a version (managed by a parent POM, a BOM or a platform) or with a computed one is skipped:
checking some other version would be a guess. Without `gradle.lockfile`, deps.dev resolves the tree of
each direct dependency.

**Composer.** deps.dev does not index Packagist, so versions come from `repo.packagist.org/p2` and
advisories from two sources: OSV (`Packagist`) and Packagist's security advisories API, which also
carries FriendsOfPHP records. A version is clean only when both agree. Constraints (`^`, `~`, `*`,
ranges, `|`/`||`) resolve the way Composer does. Packagist has no dependency graphs, so the transitive
check needs `composer.lock`. Dev branches (`dev-main`) are not releases and are never recommended.
An abandoned package shows as deprecated, with its replacement.

**GitHub Actions.** For every `uses: owner/repo[/path]@ref` (local `./` actions and `docker://` images
are skipped), safectx resolves the ref to its commit and its most specific tag (`v4` to `v4.2.2`) and
checks the OSV `GitHub Actions` advisories for that release. OSV cannot compare versions for this
ecosystem, so safectx reads the affected ranges itself. A compromised or vulnerable action
(`tj-actions/changed-files`, GHSA-mrrh-fwg8-r2c3) is blocked, with the fixed release pinned to its
SHA. A tag or branch ref gets a warning with the same release pinned to its SHA and the version as a
comment; `SAFECTX_ACTIONS_PIN=enforce` blocks it. A branch, or a SHA that matches no recent tag, has
no known version: when the action has advisories, the result is "unverified", never clean.
`GITHUB_TOKEN` or `GH_TOKEN` raises GitHub's limit from 60 requests an hour; each action costs two to
four requests, cached for an hour, because tags can move.

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
   For PyPI, the wheel (or sdist) of that version, read as text and never imported: signatures and
   docstrings of public functions, classes and methods (`__all__` respected; private modules,
   tests and vendored code skipped), `.pyi` stubs, and the typeshed `types-<name>` package for
   signatures when the distribution ships no types. The answer also names the import name when it
   differs from the package name (`yaml` for `pyyaml`).
2. The source repository at the release tag (`v1.2.3`, `1.2.3`, `name@1.2.3`, `name==1.2.3`...):
   `docs/` folders, guides, migration notes. Translations are skipped.
3. The project's `llms-full.txt` or `llms.txt`, which describe the current site and may be newer
   than the version you use; sections from it are labeled as such. Packages whose docs live in
   another repo or site (LangChain, LangGraph, PyYAML, Streamlit, Selenium) are mapped to it in
   `src/data/docsRepos.ts`. For LangChain's split packages, the answer lists the sibling packages
   the question needs that are not dependencies (`langchain-text-splitters`, `langchain-community`).
4. Context7, only when the three above return nothing relevant. `SAFECTX_CONTEXT7=off` disables it.

Sections are ranked locally with BM25 against the question, and the answer is capped at about
2,500 tokens (`tokens` argument, or `SAFECTX_DOCS_BUDGET` in characters).

## CLI

```bash
npx safectx check npm axios@1.7.9          # exit 1 if not ok
npx safectx audit . --fail-on=high         # whole-tree audit for CI, exit 1 on findings
npx safectx audit package-lock.json --json
npx safectx upgrade npm zod 3.25.76 4.6.7  # what changes between two versions
npx safectx audit .github/workflows        # GitHub Actions: advisories and SHA pinning
npx safectx check composer guzzlehttp/guzzle:7.4.0
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SAFECTX_COOLDOWN_DAYS` | `3` | Minimum age of a version to be recommended. |
| `SAFECTX_MAX_CANDIDATES` | `12` | Versions inspected, newest first, before giving up on a safe one. |
| `SAFECTX_CONTEXT7` | `fallback` | `off` never calls Context7. |
| `CONTEXT7_API_KEY` | none | Raises Context7's rate limit when it is used. |
| `GITHUB_TOKEN` / `GH_TOKEN` | none | Raises GitHub's rate limit for repo docs and the Actions check. Read-only use. |
| `SAFECTX_DOCS_BUDGET` | `10000` | Characters of docs per answer. |
| `SAFECTX_CACHE_DIR` | OS cache dir `/safectx` | Disk cache (docs 7 days, advisories 24 h). |
| `SAFECTX_NO_CACHE` | unset | `1` disables the cache. |
| `SAFECTX_TIMEOUT_MS` | `15000` | Per-request timeout. |
| `SAFECTX_PROJECT_DIR` | working directory | Project to read installed versions and `.safectx.json` from, when the client does not announce roots. |

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
