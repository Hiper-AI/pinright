# pinright: version-accurate library docs and a supply-chain verdict for coding agents

**Hiper AI** (opensource@hiperai.com)

Technical report, version 1.0.0, 2026-11-03. Code: <https://github.com/Hiper-AI/pinright> (MIT). Site:
<https://pinright.dev>. This report has not been peer reviewed. It describes pinright 1.0.0. The
benchmarks ran on 2026-11-01 against a pre-release commit (`b2fcfe2`) plus a benchmark-only ablation
flag; 28 files under `src/` changed between that commit and 1.0.0, from the second security review
and the false-positive replay (Section 6). Section 5 lists every run.

## Abstract

Coding agents pick dependency versions from what their model saw in training, and those versions
often carry advisories published since. We measured this with Claude Code driving three models
(Sonnet 5.5, Haiku 5.5, Opus 5.5) on 12 tasks we wrote (8 npm, 4 PyPI), two runs each, scored with
`npm audit` and `pip-audit`. Without tools, 40% to 42% of the direct dependencies each model pinned
had a known advisory, and projects averaged 30 to 33 whole-tree alerts. We built pinright, an
MIT-licensed MCP server, CLI, pre-install hook and GitHub Action that gives the agent a verdict on
each dependency (OSV and deps.dev advisories, malware records, lookalike names, registry existence,
supply-chain signals) and docs taken from the package at the version it will install. An ablation
shows where the gain comes from. pinright with its security layer off, which documents the
registry's latest release, already cut alerts to 48, 21 and 6 over 24 projects per model: steering
the agent to current versions removes most of the exposure. The full server brought each model to 6
alerts and 0 vulnerable direct pins; the 6 come from one nuxt dependency with no fixed release, which
an unpinned install also gets. The hook alone, for agents that never call the tool, left 10 to 14.
With pinright's docs, all three models wrote the current API of eight recently changed libraries in
16 of 16 runs, against 10 to 13 without docs. Replaying 25,077 public commands through the hook as
released, 1.46% were blocked or asked about. These results come from one vendor's models, one day of
advisory data, tasks we wrote, two repetitions whose intervals overlap between the pinright arms,
and a pre-release build of the code.

## 1. Problem

### 1.1 Agents pin from memory

When a coding agent writes `package.json` or `requirements.txt`, it has to pick a version for each
dependency. Unless a tool tells it otherwise, it picks one it remembers. Training data stops at a
cutoff and over-represents versions that stayed popular for a long time, so the agent tends to pin a
release from a year or two before the model shipped. Many of those releases have advisories
published since.

Our v6 agent benchmark (Section 5.1) measured the effect for three models. With no tools attached,
each model pinned 157 direct dependencies over 24 projects, and 63 to 66 of them (40% to 42%) had at
least one advisory in OSV. The median pinned version was 583 to 747 days old. Examples from the
transcripts: `axios@1.7.9` (33 advisories), `pillow@11.0.0` (86), `pyjwt@2.10.1` (32),
`next@15.5.4` (35). The resolved trees produced 711 to 794 alerts per model, 164 to 190 of them
critical or high in the npm projects. Four of 72 projects came out clean.

The package choices were fine. The same packages installed without a version (the *no pin*
reference arm) produced 3 alerts over 12 projects, all in the dependencies of the current `nuxt`
release, which have no fixed version yet.

### 1.2 What changes the version

If the versions are the problem, any tool that moves the agent to current releases should help, and
our ablation (Section 5.2) shows that it does. pinright with its security layer switched off
documents the registry's latest release when asked without a version. Agents using it asked for the
latest release package by package and pinned it, and whole-tree alerts fell by 94% to 99% from the
no-docs arm.

That leaves cases a docs tool does not handle. An agent has reasons to pin an older version: a peer
range (`next-auth` 4 wants `next` 15), an existing lockfile, a pre-release it read about. Without a
verdict it cannot tell a vulnerable old release from a clean one, and in our runs Sonnet pinned
`next@15.5.4` (35 advisories) and Haiku a `next-auth` beta with advisories. A docs tool also says
nothing about lookalike names, packages that do not exist, or malware, and it helps only when the
agent calls it. pinright adds those pieces: a verdict on the version being pinned, a fix on the same
release line, refusal of malicious, lookalike and nonexistent names, and a hook that runs whether or
not the agent asked. We did not benchmark any third-party docs service and make no claim about how
one behaves.

### 1.3 Related work

pinright combines pieces that exist separately.

- **Advisory data.** OSV aggregates advisories across ecosystems, including the GitHub Advisory
  Database and malicious-package records (`MAL-*`). deps.dev mirrors OSV and adds version lists,
  licenses, resolved dependency graphs and OpenSSF Scorecard results. pinright is a client of both and
  adds no advisory data of its own.
- **Dependency scanners** such as `npm audit`, `pip-audit` and OSV-Scanner audit a lockfile after the
  fact; Dependabot and Renovate open pull requests to move vulnerable or outdated dependencies. They
  act after a dependency entered the repository. pinright acts while the agent chooses it, and also
  ships a scanner (`pinright audit`) for CI.
- **Install-time guards.** Proxy registries and package firewalls block known-bad packages for every
  client of a registry. They see the package request, not the agent's intent, and return no
  recommended version or docs to the agent. Our threat model recommends running one next to pinright.
- **Package hallucination.** Spracklen et al. ("We Have a Package for You!", USENIX Security 2025)
  measured code-generating models inventing package names that attackers can register. pinright's
  lookalike and registry-existence checks target that pattern. In the v6 runs no arm pinned a package
  or version that does not exist.
- **Provenance.** npm provenance attestations (Sigstore) tie a tarball to the workflow that built it.
  pinright reads them as a signal and publishes its own releases with them.

## 2. Overview

pinright is a TypeScript program for Node 20.9 or newer, published as one npm package with four
direct runtime dependencies. It runs in four modes:

| Mode | Entry point | What it does |
|---|---|---|
| MCP server (stdio) | `npx pinright` | Six tools: `find-library`, `get-docs`, `upgrade-guide`, `check-package`, `check-packages`, `check-manifest` |
| CLI | `pinright check`, `audit`, `upgrade`, `doctor`, `init`, `cache` | The same checks for people and CI; `init` wires the server and hook into agent clients |
| Pre-install hook | `pinright hook <agent>` | Reads the agent's next shell command or file write and denies, asks or allows |
| GitHub Action | `action.yml` at the repository root | Runs `audit`, writes a job summary, annotates the PR and uploads SARIF |

`init` covers 16 clients; for JetBrains AI Assistant it prints the JSON to paste. Six have a hook
interface that pinright wires: Claude Code, Cursor, VS Code with GitHub Copilot (a preview hook API),
OpenAI Codex, Gemini CLI and Windsurf. The others get the MCP server only.

The program sends no telemetry. It talks to public services only: deps.dev, OSV, the package
registries, jsDelivr, GitHub, and the docs site a package's metadata names. Lookups are cached on
disk: advisories and versions for 24 hours, docs for 7 days, file listings of a release tag for a
year. Figure 1 shows how the parts connect.

![Figure 1. Architecture: two entry points, one verdict pipeline, one docs pipeline, a fenced answer.](figures/fig-g-architecture.png)

*Figure 1. The agent calls MCP tools, or the hook runs before its next command or write. Both use the
verdict pipeline; the tools also use the docs pipeline. Answers come back fenced.*

## 3. Design

### 3.1 The verdict

A check takes an ecosystem, a package name and optionally a version. Without a version, pinright
reads the project's lockfile or manifest (Section 3.6) and checks the installed one.

**Sources.** deps.dev supplies the version list, per-version advisories, deprecation, licenses,
dependency graphs and Scorecard. OSV supplies advisory details, fixed versions, severity and malware
records. The npm registry supplies per-version documents for supply-chain signals; the npm downloads
API and pypistats.org supply download counts. Composer has no deps.dev coverage, so pinright reads
`repo.packagist.org` and advisories from OSV and Packagist. GitHub Actions refs resolve through one
git request per repository and OSV's `GitHub Actions` ecosystem.

**Verdicts.** `ok`, `vulnerable`, `malicious`, `deprecated`, `possible-typosquat`,
`unknown-package` and `unknown`. pinright answers `ok` only when both deps.dev and OSV answered. If
either fails, the verdict is `unknown` and names the host and cause. With OSV down, a version
deps.dev already flags stays `vulnerable`, and one deps.dev calls clean becomes `unknown`, because
deps.dev mirrors OSV with a lag of hours and malware reports reach OSV first. A `malicious` or
`unknown-package` result for the requested version overrides any package-wide headline (finding F3,
Section 4.4).

**Safe version.** The newest release that is stable (no pre-release tags, no Go pseudo-versions),
not deprecated, free of advisories in both deps.dev and OSV, and older than a cooldown of 3 days
(`PINRIGHT_COOLDOWN_DAYS`). pinright inspects up to 12 candidates, newest first. Registries usually
pull compromised releases within days; a team can raise the cooldown in `.pinright.json`.

**Release lines.** When the agent asks about a specific version, pinright computes its release line:
the major (`3.x`), or the minor before 1.0 (`0.28.x`). The recommendation follows one order,
used by the notice, the hook, the batch check, audit fixes and the upgrade guide: (1) the newest
clean release on the same line; (2) otherwise the newest clean release on the nearest newer line
that has one, up to four lines ahead, so a Spring 5.3 project is pointed at 6.2.x and not at 7.0;
(3) otherwise the newest clean release overall. When nothing is clean, the report names the least
exposed version. When the recommended major is less than a year old, the notice points the agent at
that version's docs.

**Transitive trees.** For npm, PyPI, Cargo, Maven and Composer, where pinright has resolved graphs, a
clean same-line release can still pull vulnerable dependencies. `next` 15.5.28 pins a `postcss` with
advisories that only Next 16 clears. pinright keeps the same-line recommendation and adds a note
naming the vulnerable pulls and the line that clears them. When a vulnerable pin is a dependency of
another pinned package, the hook points at the parent upgrade, so the fix installs.

**Supply-chain signals.** Advisories lag attacks by days, so pinright also reports signals for the
version the agent would install. They never change the verdict; the hook acts on two of them
(Section 3.3).

| Signal | Source | Level |
|---|---|---|
| Install scripts (`preinstall`, `install`, `postinstall`, implicit `node-gyp`) | npm version document | `info`; `warn` when earlier releases had none; `high` for a package younger than 14 days or scripts that arrive with a new publisher |
| Provenance dropped | npm version document | `warn`; `high` with a new publisher |
| Publisher change (none of the previous five releases came from that account) | npm `_npmUser` | `warn`; `info` if already a maintainer or the release has provenance |
| Young package with low weekly downloads | deps.dev, npm downloads, pypistats.org | `warn` under 100 a week |
| OpenSSF Scorecard below 4, or a dangerous workflow | deps.dev | `info` |
| The package's own text addresses AI agents (Section 4.1) | pinright's cache | `warn` |

**Lookalike names.** A name one edit away (Damerau-Levenshtein, optimal string alignment) from one
of 3,627 popular npm names or 3,001 PyPI names counts as a lookalike; for names of seven or more
characters near the 1,000 most popular, two edits count. A package older than the cooldown with
50,000 or more weekly downloads of its own passes. The list ships with pinright, so this check
works offline. For npm and PyPI, pinright also checks that the name exists in the registry, which
catches hallucinated names.

### 3.2 Docs

`get-docs` takes a library id, a question and an optional version, and returns ranked sections under a
budget of about 2,500 tokens (10,000 characters). If the version is vulnerable, the answer opens with
a security notice and documents the recommended same-line version instead, so docs and pin agree.

**Sources.** pinright calls no docs index. At the exact version it gathers (1) the published package
through jsDelivr: README, bundled docs and `.d.ts` files for npm; for PyPI the wheel or sdist, read
as text and never imported (public signatures and docstrings, `.pyi` stubs, typeshed stubs when the
distribution ships no types; archive readers stop at 64 MB); (2) the source repository at the release
tag through jsDelivr's GitHub mirror, with the GitHub API as fallback for repositories over 50 MB,
skipping translations, contributor and agent notes, eval prompts, example apps and copies of older
majors, and inlining code a page includes from another file; (3) the project's `llms.txt` or
`llms-full.txt`, found from the registry's homepage or docs URL, the homepage the repository
declares, or the README's docs link, and labeled as current-site docs because they may be newer than
the pinned version. A hand-written map covers packages none of these paths find (LangChain, PyYAML,
Tailwind CSS). Every URL that comes from metadata goes through the SSRF guard (Section 4.2).

**Ranking.** pinright splits documents by heading, normalizes each section and scans it for prompt
injection (Section 4.1), then ranks locally with BM25 (k1 = 1.2, b = 0.75). Path hits count by how
rare the matched word is in the tree. A question that asks several things is split on `;`, `,` and
`:`, and each topic gets its best section first. A near-duplicate filter drops sections that share
70% of their words with one already picked. Files that declare themselves generated weigh half for
how-to questions.

**Rename hints.** An agent asks with the names it learned. pinright reads renames from the package
itself (`@deprecated Use X instead` in type definitions, deprecation decorators in Python, the
current major's migration guide). When a question uses an old name, the new one joins the query and
the answer opens with a fenced line such as "Renamed or deprecated in ai@7.0.157, per the package's
own files: `system` -> `instructions`". No library has a hand-written rename entry.

**Upgrade guides.** `upgrade-guide` returns what changes between two versions: changelog sections,
GitHub release notes in the range, migration guides across a major, and for npm a diff of exported
API between the two `.d.ts` sets. Entries are tagged `BREAKING`, `CONFIG/DEFAULT`, `NEW PACKAGE` or
`DEPRECATED`, and the answer opens with the advisories the move fixes.

### 3.3 The hook

The MCP tools help only when the agent calls them. `pinright hook <agent>` runs before each shell
command and file write the agent makes, reads the client's hook payload, and answers in that client's
format. Figure 2 shows the answer for `npm install lodash@4.17.20`.

![Figure 2. The hook's answer to npm install lodash@4.17.20 in Claude Code.](figures/fig-h-what-the-agent-sees.png)

*Figure 2. The hook's real answer (pinright 1.0.0, 2026-11-01). The command does not run; the agent
gets the reason and the version to use.*

**What it reads.** Install commands for npm, pnpm, yarn, bun, npx, pip, uv, uvx, pipx, poetry, pdm,
cargo, go, gem, bundle, dotnet and composer, through what a command runs: `bash -c`, `eval`, `$(...)`,
`cmd /c`, `powershell -Command` and `-EncodedCommand`, wrappers such as `sudo`, `env` and `xargs`,
aliases and variables set on the same line, and scripts run by name (`npm run`, lifecycle scripts,
`make`, `just`, `sh script.sh`), read from disk. Writes to manifests, through the write tool, Codex's
`apply_patch`, a notebook cell or a shell redirect; only dependencies that are new or change version
count. Writes to workflows (new or re-pointed `uses:` lines), registry settings and lockfiles.

**Policy.** The hook denies malware, lookalike names, names or versions that do not exist, versions
with advisories when a clean one exists, deprecated versions with a maintained successor,
dependencies whose transitive tree has advisories that a same-line upgrade clears, manifests whose
pins contradict each other, and two supply-chain patterns: a package younger than 14 days that runs
install scripts, and a release that adds install scripts from a new publisher. With no clean version,
it asks a human for high and critical advisories and lets the rest through with a note.

**Unverifiable means ask.** A package name in an unknown variable, input `xargs` reads from a pipe, a
git or URL source, another registry, or a manifest rewritten with `sed -i` is unverifiable, and the
default policy asks a human. A change to pinright's own configuration always asks. A change that adds
more than 40 dependencies asks too, so padding cannot push a bad package past the check.

**Failure and the deadline.** When deps.dev or OSV cannot answer, the hook applies `onError`. The
built-in default is `allow` with a note, so an offline laptop keeps working; the starter
`.pinright.json` that `init` writes sets `ask`. Lookalike names, the deny list and unverifiable
sources still decide offline. The agents give a hook 60 seconds and then run the tool anyway, so
pinright keeps its own 45-second deadline and asks a human when it runs out. Codex, Gemini CLI and
Windsurf have no "ask" answer, so pinright denies there and gives the reason. The hook answers on
stdout with exit code 0 (Windsurf: exit 2 with the reason on stderr). An exception while deciding
asks a human. Input that is not JSON exits 1, which the agents treat as a non-blocking error; the
agent application builds that JSON, not the model.

**Undeclared imports.** When the agent writes Python or JS/TS source, the hook notes packages it
imports but no manifest declares, with a clean version to pin. It never blocks on this.

### 3.4 Audit, SARIF and the GitHub Action

`pinright audit` reads lockfiles for npm, pnpm, yarn, pip, poetry, uv, pdm, Cargo, Go, RubyGems,
NuGet, Gradle and Composer, or resolves a bare manifest through deps.dev, and reports every advisory
in the tree with its dependency chain and fix. Exit codes are 0 (clean), 1 (findings at or above
`--fail-on`) and 2 (bad input). Malware, lookalikes, policy denials and missing action refs fail the
run at any threshold except `none`; advisories that could not be rated because OSV failed also fail
it (F5). `--sarif` writes SARIF 2.1.0 with one rule per advisory and a `primaryLocationLineHash`
built from rule, file and package without line or version, so code scanning keeps one alert per
advisory and package across lockfile churn.

The Action bundles its own code and installs nothing from npm at run time. On pull requests it reads
`.pinright.json` from the base commit, never from the PR's tree, so a PR cannot loosen its own
review; an unreadable base fails the step. Reports print between `::stop-commands::` markers with a
random token (F1), and each job gets its own cache directory (F10).

### 3.5 Team policy and project detection

A `.pinright.json` at the project root sets the rules for every developer and agent: `allow` and
`deny` lists, license rules (SPDX expressions), a severity threshold, cooldown days and enforcement,
and the `noFix`, `onError`, `unverifiable` and `actionsPin` decisions. A file that does not parse, or
has an unknown key, makes the hook deny every dependency change until someone fixes it.

pinright reads the roots the MCP client announces (or the working directory and its parents up to the
repository root) and takes one dependency file per ecosystem and directory, lockfile first.
`get-docs` and `check-package` without a version use the installed one and say so.

## 4. Security of the tool itself

pinright puts third-party text in front of an agent that can run commands, and it runs in CI with a
token. Three attackers are in scope: a repository (controls every file, symlinks included), a
package publisher (controls names, versions, archives, docs, changelogs, registry fields and the
docs site) and a local user on a shared machine. For the hook we add the agent itself, talked into an
install by a prompt injection.

### 4.1 Prompt injection

A malicious or hijacked package can put instructions in its README, docstrings, changelog or
deprecation message. pinright applies three layers to every piece of third-party text.

1. **Normalize.** Remove what a reader cannot see: Unicode tag characters, zero-width and bidi
   characters, terminal escapes, HTML and markdown comments, hidden elements. The hidden part is
   scanned on its own; hiding instructions counts as an injection.
2. **Detect.** A rule-based scanner scores each section for text aimed at an agent: vocatives,
   overriding orders (also in eight other languages), secrecy toward the user, chat-template and
   tool-call mimicry, credential exfiltration, URLs that interpolate conversation data, and base64
   that decodes to any of those. Matching runs on a folded copy, so lookalike letters do not evade
   it. A *high* score drops the section and says so; a *medium* score keeps it behind a warning.
3. **Fence.** Every third-party block goes out inside `<untrusted-data id="..." source="...">` with a
   random 32-bit id per response. pinright rewrites `untrusted-data` tags and spoofed `SECURITY
   NOTICE` or `pinright:` lines inside content, removes images and strips URLs that interpolate
   data. Short publisher fields become one capped line, and one that reads as an order is withheld.

| Measure (`bench/injection/run.ts`, 2026-10-29) | Result |
|---|---|
| Every section `get-docs` gathered for 32 popular packages (38,381 sections, 45.6 MB) | 4 dropped (0.01%), 26 warned (0.07%), all false positives |
| The `get-docs` answers for those 32 questions; `upgrade-guide` on 6 upgrades | 0 removed, 0 warned |
| Adversarial corpus written with the rules (61 attacks, 41 hard negatives) | 61/61 at the expected level; 0/41 flagged |
| Held-out attacks written after each rules freeze, scored once | 5/20, 6/15, 3/15 flagged; 0/35 benign flagged |

The false positives cluster in documentation about AI tooling. The corpus number is a regression
floor. The held-out numbers are the ones to quote: the detector caught 20% to 40% of new phrasings,
so we treat it as a tripwire. The fence applies to every block, but it depends on the model honoring
it. Instructions phrased as ordinary documentation are indistinguishable from real docs.

### 4.2 SSRF guard

The docs site, the pages its `llms.txt` lists and links in release notes come from the publisher.
pinright fetches them through a separate client that allows https only on the default port, refuses
credentials in URLs, `localhost`, single-label names and internal suffixes, refuses literal addresses
outside public unicast after WHATWG normalization, and vets every resolved address inside the
socket's own `lookup`, which defeats DNS rebinding. It follows at most three redirects by hand,
re-checking each hop, and caps bodies at 10 MB. Behind an HTTP proxy the proxy resolves the name and
pinright cannot pin the address; SECURITY.md documents that gap.

### 4.3 pinright's own supply chain

Four direct runtime dependencies, pinned to exact versions: `@modelcontextprotocol/server`,
`jsonc-parser`, `semver` and `zod`. No install scripts. pinright never executes what it downloads.
The release workflow publishes from GitHub Actions with npm trusted publishing (OIDC, no token) and
provenance, behind an environment that needs a human approval; the `publish` job holds the only
`id-token: write` permission and publishes only a tarball whose SHA-256 matches the verified one.
The repository runs OpenSSF Scorecard once public. At the time of writing the repository is private
and the first release has not happened, so these are plans with code behind them.

### 4.4 Two internal security reviews

Reviewers who did not write the code reviewed pinright twice. Every fix came with a test that fails
without it.

**Round 1 (2026-10-29)** covered the MCP server, CLI, hook (except the shell parser), Action and
packaging, traced every `catch` on the verdict path for fail-open behavior, and timed all 759 regex
literals in `src/` on about 900 pathological inputs. It found 11 issues (5 high, 5 medium, 1 low),
all fixed: workflow command injection (F1), dependency files read through symlinks (F2), malware
reported as merely vulnerable (F3), job-summary injection (F4), fail-open on OSV rate limits (F5),
unverifiable action refs exiting 0 (F6), a deps.dev-only malware verdict ignored (F7), a wheel zip
bomb (F8), ReDoS in parsers and the hook (F9), cache poisoning (F10) and a missing body cap (F11).

**Round 2 (2026-11-01)** covered the 51 commits since (about 7,000 lines), multi-client `init`, the
rewritten hook, the Action's base-branch policy, docs-site discovery and the release workflow. A
second reviewer red-teamed the hook with about 120 commands and writes. It found 13 issues (1 high, 9
medium, 3 low), all fixed. The high one: `init` followed a symlinked backup file planted by a cloned
repository and could write shell into `~/.bashrc` (R1). Hook findings covered exceptions that exited 1
and let the tool run (R3), lines padded past the reader's limits (R4), a scoped `npx` name matched to
a local bin (R5), Codex `apply_patch` moves and deletes (R6), NTFS alternate streams and short names
(R7), git commands that replace manifests (R8) and other clients' hook files (R9). R10 reordered the
launch runbook so the npm name is reserved before the repository goes public.

Open after round 2: the release tarball is built on a persistent self-hosted runner; the second
reviewer confirmed hook reader gaps that need an agent hiding an install on purpose (`n\pm i x`,
PowerShell backtick escapes, `cmd/c` and `^` escapes, unknown value options before the verb, several
unhandled wrappers such as `cross-env` and `pipenv run pip`); malformed hook input exits 1; and the
round-1 residuals (OSV as second source on the single-package path, unescaped names in jsDelivr URLs,
`-r` includes read outside the repository, the 10-page OSV cap for Actions). Both reviews were
internal; an external audit has not happened. `data/security_findings.csv` lists all 24 findings.

### 4.5 What the hook cannot stop

`docs/HOOK-THREAT-MODEL.md` lists 57 vectors with their status before and after hardening, and
`test/hookBypass.test.ts` reproduces each. The hook is a guardrail for an honest agent that makes
mistakes and a speed bump for one a prompt injection has turned. It reads commands and files
statically; it does not sandbox the process or watch the network. Out of scope: installs from inside
a program (`python -c "subprocess.run(['pip', ...])"`), remote scripts (`curl ... | sh` gets a note),
obfuscation beyond what a shell reader resolves, tools the hook is not wired to, manifests it does
not parse (`setup.py`, `environment.yml`, `*.csproj`), registries it does not check (conda, JSR), and
anything after the hook said yes. We recommend pairing it with a proxy registry, `npm ci` or
`pip install --require-hashes` in CI, and an agent sandbox without long-lived credentials.

## 5. Evaluation

### 5.1 Agent benchmark: what the agent installs

**Tasks.** Twelve tasks we wrote, each a short prompt that asks for a small project with named
libraries and exact pinned versions: eight npm (Next.js with Auth.js middleware, Express with JWT, an
axios upload client, Vite with React Router and TanStack Query, an XML/YAML CLI, an upload pipeline
with multer, sharp and S3, a TypeScript MCP server, a Nuxt app) and four PyPI (FastAPI with JWT, a
Flask proxy, a LangChain RAG script, a pandas pipeline). The packages have a history of advisories.

**Arms.** Claude Code 2.1.308 in headless mode with only Write and Read (no shell, no web), the same
prompt in every arm, and one of: nothing attached (*no docs*); *docs-only*, the pinright server with
its security layer off (Section 5.2); the full pinright MCP server; the pinright hook alone; both. A
*no pin* reference arm has no agent: it installs the no-docs agent's packages without versions. Each
model ran every task twice per arm: 24 runs per arm and model, 360 agent runs in all.

**Scoring.** Each manifest is resolved (`npm install --package-lock-only`, `uv pip compile`) and
audited with `npm audit` or `pip-audit`, which share no code with pinright and read the advisory data
Dependabot alerts on; these whole-tree alerts are the independent measure. The share of direct
dependencies with an advisory is counted with deps.dev's advisory keys through pinright's own
client, the same source pinright picks versions from, so a 0% there follows from the design and
should be read as "pinright did what it says", not as an outside check. Each project is then installed for real and built (`npm run
build`, `tsc --noEmit` or an import check; for Python, executing every top-level import). Intervals
are 95% cluster-bootstrap intervals that resample tasks (2,000 resamples, fixed seed).

**Results** (runs `v6-sonnet-2026-11-01`, `v6-haiku-2026-11-01`, `v6-opus-2026-11-01`):

| Model | Arm | Alerts (sum) | Alerts per project [95% CI] | 0-alert projects | Direct deps with advisory [95% CI] | Crit + high (npm) | Builds | Cost per run (USD) | Turns | MCP calls |
|---|---|---|---|---|---|---|---|---|---|---|
| Sonnet | No docs | 794 | 33.1 [21.4, 44.7] | 0/24 | 66/157, 42% [30, 52] | 190 | 24/24 | 0.034 | 4.0 | 0 |
| Sonnet | docs-only | 48 | 2.0 [0.0, 5.8] | 21/24 | 1/120, 1% [0, 3] | 23 | 24/24 | 0.087 | 8.9 | 5.0 |
| Sonnet | MCP | 6 | 0.3 [0.0, 0.8] | 22/24 | 0/130 | 0 | 23/24 | 0.051 | 6.0 | 2.0 |
| Sonnet | Hook only | 14 | 0.6 [0.0, 1.5] | 19/23 | 0/154 | 4 | 23/23 | 0.046 | 5.7 | 0 |
| Sonnet | MCP + hook | 6 | 0.3 [0.0, 0.8] | 22/24 | 0/132 | 0 | 23/24 | 0.048 | 6.0 | 2.1 |
| Haiku | No docs | 711 | 29.6 [17.8, 41.9] | 2/24 | 63/157, 40% [30, 48] | 173 | 23/24 | 0.003 | 4.2 | 0 |
| Haiku | docs-only | 21 | 0.9 [0.0, 2.3] | 20/24 | 2/127, 2% [0, 5] | 11 | 23/24 | 0.009 | 10.0 | 6.1 |
| Haiku | MCP | 6 | 0.3 [0.0, 0.8] | 22/24 | 0/134 | 0 | 22/24 | 0.005 | 7.0 | 2.9 |
| Haiku | Hook only | 10 | 0.4 [0.0, 1.2] | 20/23 | 0/149 | 2 | 22/23 | 0.004 | 5.7 | 0 |
| Haiku | MCP + hook | 6 | 0.3 [0.0, 0.8] | 22/24 | 0/121 | 0 | 24/24 | 0.005 | 6.8 | 2.7 |
| Opus | No docs | 718 | 29.9 [17.9, 43.0] | 2/24 | 65/157, 41% [32, 52] | 164 | 24/24 | 0.080 | 4.0 | 0 |
| Opus | docs-only | 6 | 0.3 [0.0, 0.8] | 22/24 | 0/126 | 0 | 24/24 | 0.204 | 9.5 | 5.5 |
| Opus | MCP | 6 | 0.3 [0.0, 0.8] | 22/24 | 0/135 | 0 | 24/24 | 0.130 | 6.5 | 2.3 |
| Opus | Hook only | 14 | 0.6 [0.0, 1.4] | 20/24 | 0/157 | 4 | 24/24 | 0.101 | 5.4 | 0 |
| Opus | MCP + hook | 6 | 0.3 [0.0, 0.8] | 22/24 | 0/149 | 0 | 24/24 | 0.125 | 6.8 | 2.6 |
| all | No pin (reference) | 3 per model | 0.3 [0.0, 0.8] | 11/12 | 0 | 0 | n/a | n/a | n/a | n/a |

Cost is the API-equivalent at list price that Claude Code reports per transcript; the runs used a
subscription, so nobody paid it. Runs without a manifest (the model wrote files to a mangled path)
count in no alert column: one hook-only run each for Sonnet and Haiku.

![Figure 3. Whole-tree alerts per project by arm and model.](figures/fig-a-alerts-per-project.png)

*Figure 3. Mean whole-tree alerts per project with 95% intervals. Right panel: the same data without
the no-docs arm.*

**What remains.** The 6 alerts in every MCP and MCP + hook arm come from the nuxt task: `nuxt` 4.6.3,
the registry default and the version pinright recommends, pulls `deepmerge`, `glob` and `minimatch`
versions with advisories and no fixed release, 3 alerts per run, which the no-pin reference gets
too. That reference matters for reading the table: on a new project, installing every package with
no version at all lands at the same 0.3 as pinright. pinright's contribution is that the agent pins,
and that the pin lands on a clean version instead of the one the model remembers. The hook-only arm adds 4 alerts (2 high) per next-auth run: the hook let `next` 15.5.28 through,
the clean release on the 15.x line the agent chose, and that release pulls a `postcss` that only
Next 16 clears. pinright notes the pull but keeps the same-line rule. The MCP arms avoid it because
`check-packages` recommends Next 16 up front. Hook-only pins were older (median 333 to 397 days
against 32 to 35 in the MCP arms): a blocked pin moves to the newest clean release on its own line.

**Builds.** In the three pinright arms, 5 of the 214 runs that wrote a manifest did not build. Sonnet's next-auth run 1 in both MCP
arms: pinright recommended Next 16.4.3 and the agent wrote `next-auth` 4 middleware code that Next 16
rejects, without calling `get-docs` or `upgrade-guide`. A Haiku MCP run wrote a route that imports
names its own `auth.ts` does not export. Haiku's mcp-server-ts task failed once in four arms (no
docs, docs-only, MCP, hook only) because the agent wrote `"build": "tsc"` without a `tsconfig.json`.

**Agreement with the reference scanners.** On the same 394 lockfiles, `check-manifest` flagged the
same vulnerable packages as `npm audit` (262 lockfiles, mean Jaccard 0.96, 235 identical sets) and
`pip-audit` (132 lockfiles, Jaccard 1.00). The only differences: `nuxt` and `@nuxt/nitro-server`,
which pinright flagged and `npm audit` did not, 27 times each.

### 5.2 The docs-only ablation

The docs-only arm runs the same server with `PINRIGHT_ABLATION=docs-only`. It registers only
`find-library` and `get-docs`; `get-docs` without a version documents the registry's latest release;
no answer carries a security notice, verdict or recommended version. Docs content, ranking and
fencing are the same code. The arm isolates what version-accurate docs do without the verdict.

Steering alone did most of the work. Agents asked for each package's latest release and pinned it:
90% to 94% of direct dependencies sat on the registry default, against 8% to 13% without docs, and
whole-tree alerts fell from 794 to 48 (Sonnet), 711 to 21 (Haiku) and 718 to 6 (Opus). The security
layer removed the rest: 48 to 6 for Sonnet and 21 to 6 for Haiku. Opus reached 6 without it, so for
Opus on these tasks the verdict added nothing we could measure.

The failures in this arm are version choices with no verdict to correct them. Sonnet pinned `next`
15.5.4 to stay inside `next-auth` 4's peer range; `find-library` showed 16.4.3 as latest, and nothing
said 15.5.4 had 35 advisories (42 alerts, 23 critical or high, in one run). Haiku pinned `next-auth`
5.0.0-beta.31, a beta with advisories, in both runs (7 alerts each). The arm also cost more than the
full server: 8.9 to 10.0 turns and 5.0 to 6.1 MCP calls per run against 6.0 to 7.0 and 2.0 to 2.9,
and 1.6 to 1.8 times the cost per run, because without `check-packages` the agents asked for
"latest" one package at a time.

Every task here starts from an empty directory, which favors "pin the latest". We did not measure
existing projects, where the agent has to keep a major or a lockfile and a "latest" answer no longer
settles the version.

### 5.3 Docs benchmark: what the agent writes

**Tasks.** Eight tasks that come out right only with a library's current major: Next.js 16
(`proxy.ts`, async `cookies()`), Tailwind CSS 4 (`@theme`, `@utility`), Zod 4, AI SDK 7
(`instructions`, `isStepCount`), Express 5 (named wildcards), ESLint 10 (flat config, `defineConfig`),
Pydantic 2 and LangChain 1 (`create_agent`). The prompt names the major but never the new API.

**Scoring.** We wrote checks from each library's migration guide and verified them against the
published type definitions. A run is *current* when it installs, builds, passes a runtime smoke test
(six tasks have one), pins the asked major, uses every required new API and no removed or deprecated
one. A self-test scores a reference solution per task (must pass) and the previous major's version of
it (must fail).

| Model | Arm | Current API [95% CI] | Works | Deprecated API used | Cost per run (USD) | Turns |
|---|---|---|---|---|---|---|
| Sonnet | No docs | 13/16, 81% [56, 100] | 15/16 | 2 | 0.044 | 5.3 |
| Sonnet | docs-only | 15/16, 94% [81, 100] | 16/16 | 0 | 0.117 | 11.4 |
| Sonnet | pinright | 16/16 | 16/16 | 0 | 0.081 | 8.2 |
| Haiku | No docs | 10/16, 63% [25, 88] | 12/16 | 4 | 0.004 | 5.3 |
| Haiku | pinright | 16/16 | 16/16 | 0 | 0.008 | 9.4 |
| Opus | No docs | 12/16, 75% [50, 100] | 14/16 | 2 | 0.103 | 5.4 |
| Opus | pinright | 16/16 | 16/16 | 0 | 0.203 | 9.4 |

![Figure 4. Docs benchmark: runs that wrote the current API.](figures/fig-c-docs-current-api.png)

*Figure 4. Share of runs current, by model and arm, with 95% intervals.*

Two libraries explain most of the gap. AI SDK 7 (released 2026-06-25) reads as newer than what the
models saw, although no cutoff dates are published: without docs, all six runs wrote AI SDK 5/6 code
(`system:`, `stepCountIs`) that still compiles through deprecated aliases. On LangChain 1, five of six
no-docs runs pinned an early 1.x `langchain` (1.0.x or 1.2.0) that does not import against the
`langgraph` the resolver installs; pinright pinned 1.4.7 in every run. That failure is about the
version chosen, which `check-packages` fixes, more than about the docs. Haiku also used the
deprecated `tseslint.config()` in both ESLint runs. The models already knew Next 16, Tailwind 4,
Zod 4, Express 5 and Pydantic 2, so on those tasks this benchmark cannot separate docs from no docs.
The no-docs intervals for Sonnet and Opus overlap 16 of 16; only Haiku's does not. The `[100%, 100%]`
interval in Table 3 is what a task bootstrap returns when every run passes; a Wilson interval for
16 of 16 is [81%, 100%]. The docs-only arm (Sonnet) lost one AI SDK run that kept `system:` although the answer
opened with the rename hint. pinright roughly doubled the cost per run with every model.

### 5.4 Retrieval probes: the docs pipeline without an agent

To measure the docs pipeline apart from the model, we send it questions and check the answer for
strings of the current API. We wrote each held-out set and scored it before changing code, tuned only
on sets we looked at, and scored the untouched sets once at the start and once at the end of a round.
On 2026-11-01 we reran every probe on a cold cache and got the end-of-round scores.

| Set | Questions | Libraries | Role | Before | Release candidate |
|---|---|---|---|---|---|
| Original | 25 | 8 | the benchmark tasks; tuned on | 16 | 24 |
| Held-out A | 81 | 29 | looked at while tuning | 53 | 75 |
| Held-out B | 28 | 12 | untouched since round 2 | 22 | 25 |
| Held-out C | 45 | 15 | untouched, written before round 3 | 28 | 33 |

Sets B and C are the numbers to quote: 25 of 28 and 33 of 45. The misses fall into docs on sites
pinright cannot read, ranking failures where a parameter list outranks a call example, and vocabulary
mismatches ("lazily" against "lazy"). A probe counts markers, not correctness.

### 5.5 Hook false positives on public commands

A hook that runs before every shell command has to stay quiet on ordinary work. We collected 25,077
commands and manifest writes (14,902 distinct) from 180 public repositories: the most-starred per
language plus well-known monorepos and toolchains. Sources: GitHub Actions `run:` steps,
`package.json` scripts, README and CONTRIBUTING shell lines, Dockerfile `RUN` instructions, Makefile
and justfile targets, and manifest writes (each manifest written over its previous commit). Every
entry ran through the real CLI (`pinright hook claude`, default policy, no `.pinright.json`) with its
repository checkout as working directory, on live data with a warm cache, on 2026-11-01.

| Measure | Baseline (1.0.0 RC) | After the fixes |
|---|---|---|
| Blocked or asked, all entries | 2.22% (130 deny, 427 ask) | 1.44% (55 deny, 306 ask) |
| Blocked or asked, without GitHub `${{ }}` templating | 1.92% | 1.16% |
| Denied, without templating | 0.42% | 0.13% |

![Figure 5. Hook false-positive rate by source, before and after fixes.](figures/fig-e-hook-false-positives.png)

*Figure 5. Share of entries blocked or asked, by source, without templating.*

The replay found 13 root causes, fixed with regression tests: Make variables read as command
substitutions (43 entries), `$PYTHON -m module` read as an install verb (62), Go pins looked up
without their `v` (25), options after the command parsed as `npx` or `uv` options (30), and smaller
ones. On top of the second security review the rate was 1.46% (two review fixes ask on purpose). Of
the 361 entries still blocked or asked, most are by design: packages, paths or versions in variables
(151), manifests rewritten by a program (63), git or URL sources (26), other indexes (24); 58 are CI
templating an agent never types, and 32 are known advisories (true positives, such as
`npm install -g pnpm@8` with 26 advisories in a public workflow). The corpus is CI and README
commands, not agent sessions; README lines, the closest to what agents copy, run at 0.61%.

### 5.6 Latency

Measured with `scripts/latency.ts` (5 runs per cell, Windows, Node 24, live services):

| Case | Budget | p50 / p95 |
|---|---|---|
| Command that installs nothing (`npm test`) | under 150 ms above Node's start | 121 / 177 ms (`node -e 0`: 88 ms) |
| One install, warm / cold cache | under 1 s / under 5 s | 358 / 372 ms; 2.4 / 3.7 s |
| 15-line `requirements.txt`, warm / cold | 1 s / 5 s | 1.0 / 1.5 s; 4.6 / 5.6 s |
| `package.json` with 30 new deps, warm / cold | 1.5 s / the 45 s deadline | 1.2 / 1.5 s; 10.9 / 15.2 s |
| Workflow with 3 `uses:` lines, warm / cold | 1 s / 5 s | 392 / 436 ms; 1.5 / 2.0 s |

The 15-line requirements file on a cold cache exceeds its 5 s budget at p95. The hook checks only the
lines a write adds or changes, so later edits cost what the changed lines cost.

## 6. Threats to validity

- **One vendor.** Three models, all from Anthropic and all driven by Claude Code. Codex and Gemini
  CLI were not installed on the benchmark machine. Other agents choose versions and use tools
  differently.
- **We wrote the tasks.** They name libraries with a history of advisories and ask for exact pins,
  which inflates the no-docs numbers against a random project and favors a tool that answers version
  questions. They start from empty directories, which favors "pin the latest" (Section 5.2).
- **Small samples.** Two repetitions of 12 agent tasks and 8 docs tasks per arm and model. The
  intervals quantify task-to-task variation only; two arms whose intervals overlap are not shown to
  differ. The MCP, MCP + hook and docs-only arms for Opus overlap entirely.
- **The ablation is ours.** docs-only is pinright with its security layer off. It shows what
  version-accurate docs that report the current release do; other docs sources may behave
  differently, and we did not test any.
- **One day of advisory data.** Scores depend on OSV and deps.dev on 2026-11-01. The no-docs numbers
  grow as advisories land, and pinright's picks can become vulnerable later.
- **Shared data source.** pinright and the reference scanners read OSV-derived data. The benchmark
  shows that pinright's choices hold up against those scanners, not that the advisory data is
  complete.
- **Agents without a shell.** Runs had only Read and Write, so the hook saw manifest writes, not
  install commands. Its command reader is covered by unit tests and the public-command replay, not by
  the agent benchmark.
- **The models knew most new APIs.** Without docs they wrote the current API for five of eight docs
  tasks; the docs benchmark separates arms mainly on AI SDK 7, LangChain 1 and, for Haiku, ESLint 10.
  docs-only ran on the docs benchmark for Sonnet only.
- **Probes measure markers.** A probe passes when expected strings appear, which says nothing about
  the surrounding text.
- **The false-positive corpus is not agent traffic.** CI scripts use more variables and private
  indexes than an agent in a working copy, so the "by design" asks are over-represented; the replay
  judges each command alone.
- **Injection held-out sets are small** (50 attacks over three sets) and written by the team that
  wrote the rules.
- **The benchmarked build is not the released build.** The runs used commit `b2fcfe2`; 1.0.0 changed
  28 files under `src/` after it (hook readers, `verdict.ts`, `typosquat.ts`, the tree audit). Those
  changes tighten what the hook reads and none changes how a version is chosen, but the numbers have
  not been re-measured on the release.
- **The direct-dependency share is scored through pinright's own deps.dev client.** Only the
  whole-tree alerts from `npm audit` and `pip-audit` are an outside measure (Section 5.1).
- **The no-pin reference ties with pinright.** On these new projects, installing with no version lands
  at the same 0.3 alerts per project. pinright's effect is on the pins agents write.
- **Every prompt asks the agent to use its docs tools** ("If you have documentation tools available,
  use them ..."), in every arm. Sessions without that line may call the tools less often.
- **The false-positive corpus is also the tuning corpus.** The 13 root causes were fixed on the same
  25,077 entries the rate is measured on; there is no held-out set.
- **The concordance score counts clean-against-clean as agreement.** 183 of 262 npm lockfiles and
  108 of 132 PyPI lockfiles are clean on both sides; the 27 that differ are nuxt projects, where
  pinright also flags `nuxt` and `@nuxt/nitro-server` for the vulnerable packages they pull.

## 7. Limitations and future work

- Install-script, provenance and publisher signals cover npm only; PyPI attestations are next.
- The hook reads, it does not contain. Programmatic installs, remote scripts and obfuscated commands
  pass, and round 2 left reader gaps open (Section 4.4). A sandbox or proxy registry remains
  necessary.
- Prompt-injection detection is a tripwire with a measured 20% to 40% catch rate on new phrasings.
- Docs for libraries whose docs live only on sites without `llms.txt` or a findable repository need a
  hand-written mapping.
- No dependency graphs for Go, RubyGems and NuGet; `setup.py`, conda and `*.csproj` are not parsed by
  the hook.
- With OSV down, the single-package path relies on deps.dev, which lags by hours.
- Benchmarks: other vendors' agents, more repetitions, tasks drawn from existing repositories, and a
  docs benchmark with APIs newer than every model under test.

## 8. Availability and reproduction

- Repository: <https://github.com/Hiper-AI/pinright> (public from 2026-11-03). Site: <https://pinright.dev>.
- License: MIT. Install in the project to protect: `npx pinright init`; setup check: `npx pinright doctor`.
- Unit tests at 1.0.0: 983 pass, 10 skipped on Windows (POSIX-only symlink and FIFO tests, which run
  in the Linux CI).
- Data behind every table and figure: the aggregate CSVs in `paper/kit/data/`. The raw agent
  transcripts and scored projects are not published; `npx tsx paper/kit/make-data.ts --bench <dir>`
  rebuilds the CSVs from a run directory, and `npx tsx paper/kit/make-figures.ts` draws the figures.
- To run it: Node 20.9+, the `claude` CLI (2.1.308 here) on an account with the three models, `uv`
  and `uvx`, and a `GITHUB_TOKEN`. A new run reads live advisory data and will differ. Another docs
  server plugs in with `--mcp-arm name=mcp.json`.

```bash
npm ci && npm run build
npm test
# agent benchmark, per model (claude-sonnet-5-5, claude-haiku-5-5, claude-opus-5-5)
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp v6-sonnet-2026-11-01
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp v6-sonnet-2026-11-01 --arms docs-only --resume
npx tsx bench/agents/make-latest.ts v6-sonnet-2026-11-01 && npx tsx bench/agents/score.ts v6-sonnet-2026-11-01 --concurrency 3
# docs benchmark, per model (docs-only for Sonnet)
GITHUB_TOKEN=... npx tsx bench/docs/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp docs-v6-sonnet-2026-11-01
npx tsx bench/docs/score.ts docs-v6-sonnet-2026-11-01 --concurrency 2
# summaries, probes, false positives, injection, latency
npx tsx bench/summary.ts --agents v6-sonnet-2026-11-01,v6-haiku-2026-11-01,v6-opus-2026-11-01 --docs docs-v6-sonnet-2026-11-01,docs-v6-haiku-2026-11-01,docs-v6-opus-2026-11-01
GITHUB_TOKEN=... npx tsx bench/docs/retrieval.ts && GITHUB_TOKEN=... npx tsx bench/docs/probe-heldout.ts --set all
GITHUB_TOKEN=... npx tsx bench/fp/collect.ts <dir> && npx tsx bench/fp/replay.ts <dir> --decide 800
npx tsx bench/injection/run.ts && npx tsx scripts/latency.ts
```

The agent benchmarks need Claude Code and an Anthropic account. Over 472 runs the transcripts report
USD 31.34 of API-equivalent cost at list price. Results move with the live advisory data and the
services' latency.

## References

- OSV: Open Source Vulnerabilities database and schema, <https://osv.dev>.
- deps.dev: Open Source Insights, Google, <https://deps.dev>.
- J. Spracklen, R. Wijewickrama, A. H. M. N. Sakib, A. Maiti, B. Viswanath, M. Jadliwala. "We Have a
  Package for You! A Comprehensive Analysis of Package Hallucinations by Code Generating LLMs."
  USENIX Security 2025.
- OASIS. Static Analysis Results Interchange Format (SARIF) Version 2.1.0.
- S. Robertson, H. Zaragoza. "The Probabilistic Relevance Framework: BM25 and Beyond." Foundations and
  Trends in Information Retrieval, 2009.
- Model Context Protocol specification, <https://modelcontextprotocol.io>.
