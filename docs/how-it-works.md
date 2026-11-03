# How pinright works

pinright runs on your machine. It asks public registries and advisory databases about each package, and nothing else:

```
agent --MCP--> pinright --> registry + jsDelivr     package files at the exact version (npm)
                       --> PyPI files              wheel/sdist at the exact version (Python API)
                       --> jsDelivr (GitHub)       repo docs at the release tag (GitHub API past 50 MB)
                       --> project site            llms.txt / llms-full.txt
                       --> api.deps.dev            versions, advisories, licenses, dependency graphs
                       --> api.osv.dev             CVE details, fixed versions, malware (MAL-*)
                       --> packagist.org           Composer versions and advisories
                       --> github.com (git)        commits and tags behind GitHub Actions refs
```

[SECURITY.md](../SECURITY.md#what-it-sends-over-the-network-and-to-whom) lists each service and what it receives.

## What the agent sees

Docs for a version with known holes come back with the notice first, and for the version to move to:

```
get-docs { libraryId: "npm:next@15.1.0", query: "protect routes with middleware" }

SECURITY NOTICE: next (npm)@15.1.0 has 36 known advisories.
  - GHSA-f82v-jwr5-mffw (CVE-2025-29927) [CRITICAL]: Authorization Bypass in Next.js Middleware fixed in 13.5.9, 14.2.25, 15.2.3
  - ...
Recommended within 15.x: 15.5.28 (same release line, no API break expected). Upgrade: npm install next@15.5.28
Newest safe overall: 16.4.3 (a different major: read its migration guide before switching).
These docs are for 15.5.28, the version to move to, not 15.1.0.

Docs for next@15.5.28 (npm), 5 sections, all from the published package or the repo at its release tag.
<untrusted-data id="9f3c21ab" source="next.js/docs/01-app/02-guides/authentication.mdx@v15.5.28, next@15.5.28">
### How to implement authentication in Next.js > Authorization > Optimistic checks with Middleware (Optional) [...]
...
</untrusted-data id="9f3c21ab">
```

Text from the package (docs, changelogs, release notes) always arrives inside an `untrusted-data` block
that names its source. See [Prompt injection](prompt-injection.md).

The hook, when the agent writes a manifest or runs an install:

```
pinright blocked this dependency change:
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
| `find-library` | Library name to registry package (`next.js` to `npm:next`, `pytorch` to `pypi:torch`), ranked by repo stars, with the safe version and a verdict. Hits the project already depends on carry `installedVersion` and `installedIn`. Suggests the real name for a misspelled one. |
| `get-docs` | Sections that answer the question, from the package at a given version. Without a version it documents the one installed in the project, or the safe one when the project does not use the package; with a vulnerable one it documents the same-line fix. GitHub repo ids (`/vercel/next.js`) work too. |
| `upgrade-guide` | What changes between two versions: breaking changes, removed or renamed APIs, config and default changes, packages that split off, deprecations, and the advisories the move fixes. Without `to` it targets the recommended version. |
| `check-packages` | The verdict for up to 50 packages in one call: one table row each (verdict, version to pin, short reason), and the full notice only for the ones that need attention. The cheap way to vet a dependency list. |
| `check-package` | The verdict for one package: advisories with CVE, severity and fixed versions, deprecation, license, safe version on the same line and overall, typosquat lookalikes, and team policy violations. Without a version it checks the installed one. |
| `check-manifest` | Whole-tree audit of `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements*.txt`, `poetry.lock`, `uv.lock`, `pdm.lock`, `Cargo.lock`, `go.mod`, `Gemfile.lock`, `packages.lock.json`, or a bare `package.json` / `pyproject.toml` / `Cargo.toml` resolved through deps.dev. Also Maven, Gradle, Composer and GitHub Actions files (see [Ecosystems](#ecosystems)). Each finding comes with its chain and fix. |

Verdicts: `ok`, `vulnerable`, `malicious`, `deprecated`, `possible-typosquat`, `unknown-package`,
`unknown`. `unknown` means a data source did not answer; pinright never says `ok` when it could not check.

deps.dev indexes new releases and new packages with a delay of hours. Before any tool calls a package
or version missing, pinright asks the registry (npm, PyPI, crates.io, RubyGems). If the registry
publishes it, the answer is unverified, not missing: `check-package` and the hook give `unknown` and say
deps.dev has no data for it yet, `check-packages` marks the row UNVERIFIED (or adds that note to a row
whose osv.dev advisories make it vulnerable or malware), and `check-manifest` keeps an exact pin of a
manifest in the tree, so osv.dev still checks it, with a note that its dependencies, licenses,
deprecation status and risk signals were not checked. A range on a package deps.dev has never seen
cannot be resolved, so `check-manifest` notes it as unverified and not audited. In `pinright audit` and
the GitHub Action these entries are a `pinright/not-indexed` finding: a note for a fresh version, a
warning for a package deps.dev has never seen, and never a failure on their own.

## How the safe version is chosen

The newest version that is stable (no `rc`, `beta`, `canary`, Go pseudo-versions), not deprecated,
has no advisory in deps.dev (which mirrors OSV and the GitHub Advisory Database), and was published at
least 3 days ago. The cooldown exists because compromised releases are usually pulled within days.

When the project already uses a version, pinright also gives the newest clean version on its release
line (`3.x`, or `0.28.x` before 1.0, where minors break), and says so when only a new major is clean.
In that case it first tries the lines between the project's and the newest one, oldest first: a
Spring 5.3 project is pointed at 6.2.19, still maintained, and not at 7.0, because the jump is
smaller. The order is the same everywhere (notice, hook, `check-packages`, audit fixes, upgrade
guide): same line, then the nearest newer line with a clean release, then the newest clean one.

In a manifest, the hook and `check-manifest` also check that version against the ranges the other
dependencies set on the package: requirements anywhere in the resolved graphs for pip and Composer,
which install one version per name, and, in the hook, peer ranges for npm. When the fix falls outside one, they name
the package that sets the range (`moviepy` 2.2.1, via `stirrup` 0.2.1, requires `pillow<12.0`) and
recommend the newest clean release inside it. If none is clean, they give the least exposed one in
range and say whether a newer release of that package accepts the fix. Graph ranges add no requests;
a conflict adds a version list, one OSV batch, and one version list and graph lookup for the package
that sets the range, all cached. Peer ranges are read only when the fix crosses a major, one lookup per
declared npm package, up to 20. A lockfile without the graph keeps the plain recommendation.
When the recommended version belongs to a major less than a year old, the notice says so and points
the agent to that version's docs: its configuration may differ from what the model learned.

A version counts as clean only when both deps.dev and OSV agree; OSV publishes new advisories hours
before deps.dev mirrors them.

## Supply-chain signals

OSV marks a malicious release (`MAL-*`) days after the attack. The release's behavior shows earlier, so
for the version you would install (the one you pass, or the latest), pinright also reports a `risk`
section with signals at three levels: `info`, `warn` and `high`.

| Signal | Source | Level |
|---|---|---|
| Install scripts (`preinstall`, `install`, `postinstall`, implicit `node-gyp`) | npm version document | `info`; `warn` when the previous releases had none; `high` when the package is brand new, or when the scripts arrive with a new publisher |
| Provenance dropped: earlier releases had an npm provenance attestation, this one has none | npm version document | `warn`, `high` with a new publisher |
| Publisher change: the account that published this recent release published none of the previous ones | npm `_npmUser` | `warn`; `info` when that account was already a maintainer or the release has provenance |
| Young package, with weekly downloads | deps.dev first publish date, npm downloads API, pypistats.org | `warn` when young and under the download threshold, `info` otherwise |
| OpenSSF Scorecard below the threshold, or a dangerous workflow, with the notable failing checks | deps.dev project | `info` only |
| The package's own text gives AI agents instructions: deprecation message, npm description, or docs and changelogs that pinright served earlier for the same version (see [Prompt injection](prompt-injection.md)) | deps.dev, npm version document, pinright's cache | `warn` (the hook passes it on and never blocks on it) |

Install scripts, provenance and publisher come from npm only; Scorecard and age cover every ecosystem
deps.dev knows, and downloads cover npm and PyPI. npm download counts for unscoped packages go out in bulk requests of up to 128 names, so a
large manifest stays under api.npmjs.org's rate limit; scoped packages, which the bulk endpoint
rejects, go three at a time. pinright reads the version documents of the requested
release and up to 5 earlier ones (a few KB each), never the full packument. Missing data produces no
signal, and the notice lists sources that did not answer under "Not verified". Signals never change
the verdict.

| Variable | Default | Meaning |
|---|---|---|
| `PINRIGHT_RISK_NEW_PACKAGE_DAYS` | `14` | A package younger than this with install scripts is `high` (blocked by the hook). |
| `PINRIGHT_RISK_RECENT_DAYS` | `30` | Window for "young package" and for flagging a publisher change. |
| `PINRIGHT_RISK_LOW_DOWNLOADS` | `100` | Weekly downloads under this, on a young package, is a `warn`. |
| `PINRIGHT_RISK_SCORECARD_LOW` | `4` | Scorecard under this is noted. |
| `PINRIGHT_RISK_HISTORY` | `5` | Earlier releases compared for scripts, provenance and publisher. |

Typosquat lookalikes are checked against about 3,600 npm and 3,000 PyPI names, regenerated by
`npx tsx scripts/popular.ts` from pinned public rankings (see the header of `src/data/popular.ts`).

## Where the docs come from

1. The published package at the exact version, through jsDelivr: README, bundled docs, and the
   `.d.ts` type definitions, which are the ground truth of an npm package's API.
   For PyPI, the wheel (or sdist) of that version, read as text and never imported: signatures and
   docstrings of public functions, classes and methods (`__all__` respected; private modules,
   tests and vendored code skipped), `.pyi` stubs, and the typeshed `types-<name>` package for
   signatures when the distribution ships no types. The answer also names the import name when it
   differs from the package name (`yaml` for `pyyaml`).
2. The source repository at the release tag (`v1.2.3`, `1.2.3`, `name@1.2.3`, `name==1.2.3`...):
   `docs/` folders (including Django's reStructuredText `.txt` pages), guides, migration notes.
   pinright skips translations, notes for contributors and coding agents (`AGENTS.md`,
   `.agents/skills`, `docs/plans`), eval prompts, example apps and copies of an older major the
   package still ships (Zod 4's `v3/`). When a page pulls its example from another file
   (`{* docs_src/x.py *}`, `--8<--`, `literalinclude`, `<<<`, or an mkdocs macro such as Polars'
   `{{code_block('user-guide/x', 'section')}}`), the answer shows that file, cut to the named
   snippet section. Generated SDK types (files headed "generated from our OpenAPI spec") rank
   below the README and guides unless the question asks for a signature or a type.
3. The project's `llms-full.txt` or `llms.txt`, which describe the current site and may be newer
   than the version you use; sections from it are labeled as such. The site comes from the
   package's metadata: the registry's homepage or docs URL, the homepage its GitHub repo declares
   (supabase.com for `@supabase/supabase-js`), or the docs link of its README (platform.claude.com
   for the Claude SDKs). pinright looks for the llms.txt in the site's folder, at `docs.<host>` and
   under `/docs`. A site without one is read from the GitHub repo it is built from, at its default
   branch: `<org>/docs`, `<org>/<name>-docs`, `<org>/<name>.dev`, `<org>/<site host>` or the docs
   folder of the org's monorepo, only when GitHub lists that repo's homepage as the same site
   (Astro's docs come from `withastro/docs` this way). Every URL taken from metadata goes through the
   same SSRF guard as llms.txt. Packages whose docs cannot be found that way (LangChain, LangGraph,
   PyYAML, Streamlit, Selenium) are mapped in `src/data/docsRepos.ts`, and so is Tailwind CSS,
   whose site repo is found but whose 200 utility pages need a hand-picked set of guides. For
   LangChain's split packages, the answer lists the sibling packages the question needs that are
   not dependencies (`langchain-text-splitters`, `langchain-community`).

pinright does not call any docs index: everything comes from the sources above, with no account
or key. A GitHub repo id (`/vercel/next.js`) also works and is mapped to the package.

Sections are ranked locally with BM25 against the question, and the answer is capped at about
2,500 tokens (`tokens` argument, or `PINRIGHT_DOCS_BUDGET` in characters). A question that asks
several things at once ("z.email, z.strictObject, z.record") gets the best section for each topic.
API names written as code (`z.record`, `field_validator`, `pattern=`) must match exactly.

If the question uses a name that the version renamed, pinright searches for the new name too and the
answer says so (`system` -> `instructions` in AI SDK 7, `on_event` -> `lifespan` in FastAPI). It reads
the renames from the package itself: `@deprecated` tags in its type definitions, deprecation
decorators and docstrings in its Python API, and the migration guide of its current major.

## Upgrade guides

When pinright recommends a new major, the agent tends to write code and config for the old API from
memory: a `tsconfig.json` without `rootDir` for TypeScript 6+, `middleware.ts` for Next.js 16 where
the file is now `proxy.ts`, an import from `langchain` for text splitters that moved to
`langchain-text-splitters`. `upgrade-guide` gives the agent the changes between the two versions
before it writes anything, and you can run it by hand to fix a Dependabot PR:

```
upgrade-guide { libraryId: "npm:next", from: "15.5.28", to: "16.4.3", query: "middleware" }
npx pinright upgrade npm next 15.5.28 16.4.3 --query="middleware"
npx pinright upgrade pypi pydantic 1.10.x 2.x       # ranges resolve to their newest release
```

pinright recommends the clean release on your line first. Sometimes that release is clean while its
own dependencies are not: next 15.5.28 pins a postcss with advisories that only next 16 clears.
`check-package`, `check-packages` and the hook then add a note and keep the recommendation (npm,
PyPI, Cargo, Maven and Composer, where pinright has resolved graphs):

```
NOTE: next 15.5.28 has no advisories itself, but pulls postcss@8.4.31 (GHSA-6g55-p6wh-862q, ...); next 16.4.3 pulls a fixed one. Staying on 15.x keeps that alert; upgrade-guide from 15.5.28 to 16.4.3 explains the changes.
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
It fits the same budget as `get-docs` (`tokens` argument). Without a `GITHUB_TOKEN` it reads fewer
release pages.

## Project detection

Agents rarely say which version the project uses, and docs for a newer version produce code against
APIs the project does not have. pinright reads the project's dependency files by itself:

- **Where.** The roots the MCP client announces (and re-reads them on `roots/list_changed`). Without
  them, `PINRIGHT_PROJECT_DIR` (several directories separated by the OS path delimiter), else the working
  directory: Claude Code and Cursor launch stdio servers inside the project. When that directory has
  no dependency files, the nearest parent that has them, up to the repository root. Subprojects up to
  three levels down count too (monorepos), skipping `node_modules`, build output and hidden folders.
- **What.** One file per ecosystem and directory, lockfile first: the exact version from the lockfile;
  for npm without a lockfile, the version in `node_modules`; an exact pin in a manifest; else the
  version the manifest's range resolves to today, and the answer says so.
- **How it is used.** `get-docs` and `check-package` without a version use the installed one and say
  so in one line, then apply the same checks as for an explicit version: a vulnerable installed
  version gets the same-line fix and docs for it. An explicit version always wins.

```
get-docs { libraryId: "npm:next", query: "middleware" }

Using next 15.1.0, installed in this project (package-lock.json).
SECURITY NOTICE: next (npm)@15.1.0 has 36 known advisories.
...
These docs are for 15.5.28, the version to move to, not 15.1.0.
```

When a monorepo has several versions of the package, the line lists the others. pinright reads only
dependency files, keeps them parsed in memory and re-reads one when its modification time changes.

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
in the same file. In Gradle scripts, pinright reads `"g:a:v"` and map notation, `$var` from simple
assignments and `gradle.properties`, and `libs.*` references to the version catalog. A dependency
without a version (managed by a parent POM, a BOM or a platform) or with a computed one is skipped:
checking some other version would be a guess. Without `gradle.lockfile`, deps.dev resolves the tree of
each direct dependency.

**Composer.** deps.dev does not index Packagist, so versions come from `repo.packagist.org/p2` and
advisories from two sources: OSV (`Packagist`) and Packagist's security advisories API, which also
carries FriendsOfPHP records. A version is clean only when both agree. Constraints (`^`, `~`, `*`,
ranges, `|`/`||`, `@stable`/`@beta` flags, `self.version`) resolve the way Composer does. deps.dev
resolves no Packagist graphs, so pinright builds them from each release's `require` in Packagist's
metadata: every requirement goes to the newest stable release that satisfies it, skipping platform
packages (`php`, `ext-*`, `lib-*`), virtual packages that only exist as `provide`, and names that a
package already in the graph replaces. That gives Composer the same hook checks as npm and PyPI (a pin
outside its parent's range, the parent upgrade that pulls a fixed dependency, vulnerable transitive
dependencies) and lets `check-manifest` audit a `composer.json` without a lock. Like deps.dev, it
resolves each direct dependency on its own; `composer.lock` is still the exact tree. Dev branches
(`dev-main`) are not releases and are never recommended.
An abandoned package shows as deprecated, with its replacement.

**GitHub Actions.** For every `uses: owner/repo[/path]@ref` (local `./` actions and `docker://` images
are skipped), pinright resolves the ref to its commit and its most specific tag (`v4` to `v4.2.2`) and
checks the OSV `GitHub Actions` advisories for that release. OSV cannot compare versions for this
ecosystem, so pinright reads the affected ranges itself. A compromised or vulnerable action
(`tj-actions/changed-files`, GHSA-mrrh-fwg8-r2c3) is blocked, with the fixed release pinned to its
SHA. A tag or branch ref gets a warning with the same release pinned to its SHA and the version as a
comment; `PINRIGHT_ACTIONS_PIN=enforce` blocks it. A branch, or a SHA that matches no recent tag, has
no known version: when the action has advisories, the result is "unverified", never clean.
pinright reads each action repo's tags and branches with one git request (what `git ls-remote`
does), cached for an hour because tags can move. That request does not count against GitHub's API
limit; the API is the fallback for short SHAs and private repos, and answers "latest release" for a
vulnerable action.
