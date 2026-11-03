# Hook false positives on public commands: measured

Run on 2026-11-01 with `bench/fp/collect.ts` and `bench/fp/replay.ts` against `lanzamiento` (1.0.0 RC)
as the baseline and `feat/fp` after the fixes. The decisions used live deps.dev, OSV, the npm registry
and PyPI on that day, with a warm cache.

## Corpus

Public sources only, read-only. 180 repositories: the most-starred ones per language in GitHub search
(TypeScript 28, Python 26, Rust 22, JavaScript 16, Go 15, Kotlin 15, C# 15, Java 14, PHP 14, Ruby 14,
one Blade) plus a list of monorepos and toolchains (next.js, nx, turborepo, babel, react, angular,
astro, pnpm, vite, uv, ruff, pydantic, fastapi, django, cargo, tokio, kubernetes, spring-boot,
laravel, symfony, rails, aspnetcore, deno, bun, biome, playwright, storybook and others). 174 had
something to extract.

| Source | Entries | Distinct | What an entry is |
|---|---|---|---|
| GitHub Actions `run:` steps | 14,040 | 9,038 | the whole step, as an agent would send a multi-line Bash call, run in the step's `working-directory` |
| package.json scripts | 6,588 | 2,276 | `npm run <script>` and `npm install` per package.json; the hook follows the script body |
| README / CONTRIBUTING shell blocks | 2,146 | 1,945 | one line each, prompts stripped: what agents copy |
| Dockerfile `RUN` | 1,171 | 996 | the instruction, heredoc bodies included |
| Makefile / justfile | 711 | 511 | `make <target>` / `just <recipe>`; the hook follows the recipe |
| Manifest writes | 421 | 412 | the current manifest written over the version before its last commit (package.json, requirements, pyproject.toml, Cargo.toml, go.mod, pom.xml, build.gradle(.kts), composer.json, Gemfile, Pipfile) |
| **Total** | **25,077** | **14,902** | |

Every command runs with its repository checkout as `cwd`: the hook reads the real requirement files
behind `-r`, the scripts behind `npm run`, the recipes behind `make`. `node_modules/.bin` gets an empty
file for each bin the declared npm dependencies expose (read from jsDelivr), as `npm ci` would leave
it, so `npx tsc` reads as the local compiler. 1,741 entries carry GitHub's `${{ }}` templating, which
an agent never types; the rates below are given with and without them.

To reproduce: `GITHUB_TOKEN=... npx tsx bench/fp/collect.ts <dir>`, then
`npm run build && npx tsx bench/fp/replay.ts <dir> --decide 800`. The corpus stays outside the repository.

## Rates

"Blocked or asked" is the share of all entries where the real CLI (`pinright hook claude`, default
policy, no `.pinright.json`) answered `deny` or `ask`. Every distinct intent set went through the
CLI (690 before, 671 after), so no entry is extrapolated.

| | Baseline | After the fixes |
|---|---|---|
| Parser: entries with something to check | 5.8% | 5.3% |
| Parser: unverifiable (asks without a lookup) | 1.80% | 1.29% |
| **Blocked or asked, all entries** | **2.22%** (130 deny, 427 ask) | **1.44%** (55 deny, 306 ask) |
| Blocked or asked, without `${{ }}` | 1.92% | 1.16% |
| Denied, without `${{ }}` | 0.42% (99) | 0.13% (30) |

Per source, without `${{ }}` (blocked or asked):

| Source | Baseline | After |
|---|---|---|
| package.json scripts | 0.27% | 0.06% |
| README lines | 0.98% | 0.61% |
| Makefile targets | 5.34% | 0.42% |
| Actions steps | 2.29% | 1.54% |
| Dockerfiles | 4.78% | 4.36% |
| Manifest writes | 7.60% | 2.61% |

### On top of the second security review (R1–R13)

Rebased onto `lanzamiento` at 35c33a4 and replayed again: **1.46%** blocked or asked (55 deny, 311 ask),
**1.18%** without `${{ }}`, denials unchanged at 0.13%. The 0.02-point difference comes from two
review fixes, both kept:

- R8 (`git checkout`/`restore` of a manifest asks): 5 entries, such as symfony's
  `git checkout composer.json` and poetry's `git checkout -- pyproject.toml poetry.lock`. The content
  comes from another commit, which the hook cannot read. An agent that undoes its own edit to a
  manifest this way will be asked once.
- R5 (`npx @scope/x` matches the package in `node_modules`, not a bin of the same name): 9 entries of
  `npx @biomejs/biome` and `npx @deepseek-ai/dsh` now get a lookup and pass. The corpus only creates
  `node_modules/.bin`, not the package folders, so in a real checkout these stay local.

## False positives found and fixed

Counts are corpus entries the baseline blocked or asked about and the fixed hook allows. Each fix has a
regression test in `test/hookRealWorld.test.ts` (verdict-level ones in `test/verdict.test.ts`,
`test/typosquat.test.ts` and `test/policy.test.ts`).

| Root cause | Entries | Example | Commit |
|---|---|---|---|
| `"$X" -m module` read `-m` as an install verb; a known program in a variable folder (`$VCPKG_ROOT/vcpkg install`) read as an unknown program | 62 | `${RUNNER_TEMP}/venv/bin/python -m twine check`, `$PYTHON -m pytest` | 5bc28f2, f2d747c |
| Make variables (`$(PYTHON)`, `$(MAKE)`) read as command substitutions; then long `$(MAKE)` chains hit the nesting limit | 43 | `make test` in nodejs/node, gin, yt-dlp | d407204, 29ef681 |
| Go: pinned versions looked up without their `v` (every Go pin read as never published); `go install module/cmd/tool` looked up the package path; `@<commit>` read as a release | 25 | `go install github.com/google/go-licenses/v2@v2.0.1`, `go install .../xcaddy/cmd/xcaddy@latest` | 6461b81, 1b90b07, 42e42c2 |
| A path read as a package or as unknown: `sdk/python` (no `./`), `./${tarball}`, `/dist/${PKG}-*.whl` | 17 | `uv pip install -e sdk/python` looked up "sdk" on PyPI | e501f9d |
| Options after the command parsed as npx/uv options | 16 + 14 | `npx http-server -c-1 -p 5000` installed a package named "5000"; `uv run mkdocs build -f mkdocs.yml` | 6eff725 |
| Install-conflict check on npm/Cargo (which nest a second copy) and on ranges | 11 | `typescript 7.0.2 does not satisfy @typescript/typescript6's ^6`, `numpy<2 scipy` | 53205c2, 4463e8f |
| Lookalike check on real packages | 6 | `unicorn` (570k/week) as "uvicorn", `xterm` as "xtend", `kenlm` as "aenum" | a249b7f, 87ca494 |
| `pip install --group tests` read "tests" as a package | 3 | fastapi | 8727281 |
| `--ignore-scripts` still followed lifecycle scripts | 2 | `pnpm install --frozen-lockfile --ignore-scripts` | 210e2ee |
| Smaller ones | 4 | `bun install --filter <workspace>` (8139413), `uvx ruff@0.15.0` (1824bb9), `--find-links dist/` (127180c), `npm config set //registry.npmjs.org/:_authToken` (08433e4) | |
| PowerShell `foreach ($x in ...)` headers | parser level | `foreach ($path in @(...))` read as `npm in` from a variable | e6664d3, 8a2aad5 |
| Shell-computed versions denied as "never published" | parser level | `echo "x==$(cat V)" > requirements.txt`, `--hash sha256:...` with a space | da55b3d, 1881260 |
| `pip freeze > requirements.txt` asked | parser level | ComfyUI | ad9552a |

The "14" in the options row are `npm run start` scripts that run `npx http-server -p 5000`; the diff
script files them under "other" because the command line itself is `npm run`.

Six entries go the other way, from allowed to asked, on purpose. Five are
`cargo install x --version "$V"` (opencode, codex, zed), which used to check the newest version and
pass; they now ask, like `npm i x@$V` always did (da55b3d). And
`poetry run python -m pip install "$WHEEL_DIR"/*.whl` used to be missed entirely; the reader now
follows `poetry run` to the pip install and asks because the wheel path starts with a variable.

One security gap turned up along the way and is closed: `uv pip sync requirements.txt` and `pip-sync`
installed a file's content without any check (9bb197a).

## What still blocks or asks

After the fixes, 361 entries are blocked or asked. By cause:

| Cause | Entries | Kind |
|---|---|---|
| Package or path in a variable (`pip install "$wheel"`, `npm i ${tarballs[0]}`) | 89 | by design |
| Manifest rewritten by a program (`sed -i`, `jq > tmp && mv`, `grep -v > other.txt`) | 63 | by design |
| Version in a variable (`npm i -g pnpm@$PNPM_VERSION`, `cargo install --version "$V"`) | 62 | by design |
| GitHub `${{ }}` templating | 58 | CI only |
| Known advisories (deny 25, ask 7 where no fixed release exists) | 32 | true positive |
| Git or URL source | 26 | by design |
| Another registry or index | 24 | by design |
| Lookalike name (`pyzes`) | 2 | trade-off |
| Unknown package or version (a removed `poetry==1.3.0rc1`, a README `//` comment) | 2 | true positive, corpus artifact |
| Other: 84 requirements in one `pip install -r` (past the 40-per-change limit, pandas), `xargs uv run`, a Go install at a commit | 3 | by design |

- **Asked by design** (the hook cannot see what gets installed): versions and paths in variables
  (`npm i -g pnpm@$PNPM_VERSION`, `pip install "$wheel"`), manifests rewritten by `sed -i`, `jq` or
  `grep -v`, other indexes (PyTorch, NVIDIA, Verdaccio on localhost), git and URL sources
  (`cargo install --git`, `npx github:user/repo`). `docs/HOOK-THREAT-MODEL.md` lists them with the reason
  each one stays.
- **CI templating**: `${{ matrix.x }}` splits into words like `}}` and `matrix.with`, which the hook
  then looks up and denies as unknown packages. An agent never sends these.
- **Corpus artifacts**: a README line with a `//` comment after the command (nx), an ERB template in a
  Rails Dockerfile.
- **Policy, not parsing**: `eslint@^9.33.0` in a package.json edit (monica) is denied because ESLint 9
  is deprecated upstream and 10 exists; that is the documented `deprecated` rule. pandas'
  `pip install -r requirements-dev.txt` lists 84 packages and asks every time, because the hook checks
  40 per change so that padding cannot hide a bad one.
- **Left as a trade-off**: `pyzes` (Intel, 11k downloads a week) is one edit from `pyaes` (1.3M) and
  stays flagged. Downloads alone cannot tell it from a squat at that size.

## True positives

Real findings in public repositories, on 2026-11-01 advisory data. Pins age: most of these were
fine when someone wrote them. They show what the hook does when an agent copies the line today.

| Repository | Where | What the hook said |
|---|---|---|
| deepseek-ai/deepseek-harness | workflow | `pip install uv==0.11.23`: 2 advisories (PYSEC-2026-4321, CRITICAL); fix in 0.13.6 |
| morluto/rea | workflow | `uv==0.12.0` (same advisory), `webpack@5.101.3` (2 LOW, fix 5.112.2) |
| microsoft/playwright | workflow | `npm install -g pnpm@8`: 26 advisories, HIGH; nearest fix 10.34.9 |
| vercel/next.js | workflow | `cargo binstall cargo-nextest@0.9.133`: RUSTSEC-2026-0412, fix 0.9.150 |
| anomalyco/opencode | Dockerfile | `bunx turbo@2.8.13`: 2 MODERATE, fix 2.11.10 |
| n8n-io/n8n | Dockerfile | `pnpm add moment@2.30.1`: CVE-2026-17495, fix 2.31.0 |
| microsoft/Web-Dev-For-Beginners | memory-game/package.json | `next@16.2.3`: 33 advisories incl. CRITICAL; fix 16.4.3 |
| NousResearch/hermes-agent | tests-js/package.json | `zod@4.6.5`: 1 HIGH, fix 4.6.7 |
| excalidraw/excalidraw | dev-docs/package.json | `@excalidraw/excalidraw@0.18.0`: GHSA-39h7-pwv7-rc3x, fix 0.18.1 |
| immich-app/immich | web/package.json | `@futo-org/backups-orchestrator-ui@1.12.1` pulls `minimatch@10.2.6`; 1.11.3 pulls a fixed one |
| macrozheng/mall | pom.xml | `spring-data-commons 3.5.11`: 4 HIGH, fix 3.5.13 |
| shadowsocks/shadowsocks-android | build.gradle.kts | `kotlin-gradle-plugin 2.2.0`: CVE-2026-53914, fix 2.4.21 |
| rustdesk/rustdesk | workflow | `npm install vite@2.8`: 23 advisories, HIGH; nearest fix 6.4.5 |
| psf/requests | workflow | `pip install "urllib3<2"`: 7 advisories, HIGH. The job tests urllib3 1.x on purpose; an agent copying it into a project would not want it |
| psf/requests | workflow | `pip install pip==26.0.1`: 4 MODERATE, fix 26.2.2 |
| chatwoot/chatwoot | workflow | `pip install requests==2.32.3`: CVE-2024-47081 and one more, fix 2.34.2 |
| langchain-ai/langchain | workflow | `npm install --global mermaid@11.16.0`: 5 MODERATE, fix 11.17.2 |
| ruvnet/RuView | workflow | `pip install -r requirements.txt` with `python-jose>=3.3.0`: CRITICAL, no fixed release; asks |
| Comfy-Org/ComfyUI | README | `pip install comfy-cli`: CVE-2026-22777 (HIGH), no fixed release; asks |
| python-poetry/poetry | docs/contributing.md | `pipx install 'poetry==1.3.0rc1'`: PyPI no longer serves that release |

## How far to trust the rate

- These are CI, Docker and README commands, not agent sessions. CI scripts use more variables, more
  private indexes and more release plumbing than an agent does in a working copy, so the "by design"
  asks are over-represented here. An agent's commands are shorter and closer to the README lines,
  where the rate is 0.61%.
- One day of advisory data. A clean pin today can be a true positive tomorrow, and the count of true
  positives moves with OSV.
- The replay judges each command alone. A real session runs `npm ci` first, writes files between
  commands and may hit the cache; the bins and checkouts here approximate that.
- Files the corpus did not download (a `.cargo/ci-config.toml` copied by a workflow, a `.bak` restored
  by `Move-Item`) read as unknown writes and ask; in a real checkout the hook reads them.
- Grouping by intent set means two commands with the same intents share one decision; the message text
  in the per-entry output comes from the first of them.

## Real agent sessions (2026-11-02)

The public corpus above holds CI and README commands. This replay uses what coding agents ran on
the maintainers' own machine: the Claude Code transcripts of one month of work on pinright, its
website and the Hiper AI products (2026-10-02 to 2026-11-02). The owner approved the run. The
transcripts and the corpus built from them stay on that machine. This section gives only counts and
anonymized shapes.

Run with `bench/fp/sessions.ts` (`extract`, then `replay`) on 2026-11-02 and 2026-11-03, against
`release` at 8efc4f0 (baseline) and at 54b8d1d (after the fixes below). Default policy; a project's
own `.pinright.json` applied where one existed. Live deps.dev, OSV and registries.

### Corpus

| | Count |
|---|---|
| Transcripts | 7,434 (483 sessions, 6,951 subagent runs); 7,310 with at least one tool call |
| Tool calls replayed | 156,977 (Bash 117,892, Edit 18,952, PowerShell 11,241, Write 8,896; no MultiEdit or NotebookEdit calls) |
| Cases after dedup (same tool, input and cwd) | 154,402 |
| Shell commands | 127,037 cases (129,133 calls) |
| Writes to a file the hook reads (manifest, lockfile, workflow, hook settings) | 113 cases |
| Writes to other files (source, docs) | 27,252 cases; a random 400 went through the CLI, all allowed |
| Cases whose cwd no longer exists (replayed in an empty folder) | 35,055 |

A write to a manifest needs the file as it was before the call. The extractor takes it from the same
transcript when an earlier call wrote it (39), from the file on disk (6), from the main checkout or its
git history when the worktree is gone (34), or treats it as a new file (12). For 22 it found nothing
and the edit replays as a no-op.

Every case the reader marks as something to check (6,079 on the baseline, 6,095 after) went through
the real CLI, one process per case, so no decision is extrapolated.

### Rates

| | Baseline (8efc4f0) | After (54b8d1d) |
|---|---|---|
| Allowed | 153,683 cases (99.53%) | 153,693 cases (99.54%) |
| Asked | 92 (0.060%) | 80 (0.052%) |
| Blocked | 627 (0.406%) | 629 (0.407%) |
| Asked or blocked, over 156,977 calls | 729 (0.46%) | 719 (0.46%) |

### Adjudication

Each asked or blocked case was read and sorted by hand, with a script for the 568 cases that share one
shape.

| Verdict | Baseline | After |
|---|---|---|
| True positive: a version with known advisories or a package flagged as malware | 50 | 52 |
| False positive: the hook misread the command | 22 | 10 |
| Asked by design (`docs/HOOK-THREAT-MODEL.md`): a manifest changed by `sed -i`, `cp` or `git checkout` (56), a name, version or path in a variable (17), `git apply` on a manifest (5), a change to the hook settings (1) | 79 | 79 |
| Replay artifact: the folder changed after the session | 568 | 568 |

Without the artifacts, the hook flagged 141 cases after the fixes: 52 true positives, 79 by-design
asks and 10 false positives. The false-positive rate is 10 in 154,402 cases (0.006%), down from 22
(0.014%).

The 568 artifacts are `npx tsc` (and a few `npx jest`, `npx vitest`) denied as "runs the npm package
tsc, not typescript's compiler". In 523 the command ran in a worktree deleted since; reading the
same path in the main checkout finds the local bin and the deny goes away. The other 45 point at a
repository renamed after the session (39), temp folders that no longer exist (5) and one emptied
worktree. During the sessions those folders had `node_modules`, so these say nothing about the hook.

### False positives

| Shape (anonymized) | Cases | Status |
|---|---|---|
| `grep -l <pattern> test/*.jsx \| xargs npx vitest run` asked: "xargs passes npx arguments". The words xargs appends go to vitest, not to npx. | 5 | Fixed, 3f25662. `xargs npx` with no package, an `-I` placeholder in the package, or `xargs npx pnpm add` still ask; a bare `xargs npx` used to pass and now asks |
| PowerShell `$o=npx vitest run <file>` asked: "program from a variable" | 6 | Fixed, 3f25662 and 54b8d1d |
| PowerShell `Set-Content package.json '<json>' -Encoding ascii` asked: "would not parse". `ascii` was appended to the content. | 1 | Fixed, 3f25662. The session was probing `undici@7.30.0`, which has 8 advisories, so the hook now blocks it for that reason |
| `cd` to a folder the hook cannot resolve (`cd "$TMPDIR/x"`, `for d in a b; do cd "$d"`), then `npx <local bin>` blocked as an unknown or unrelated package | 7 | Not fixed, `it.todo`. Treating an unknown folder as having the bin would let `cd $X && npx <anything>` skip the check |
| `npm install <local tarball> && npx <its bin>` in one command blocked: the hook judges the line before the install runs | 1 | Not fixed, `it.todo` |
| A PowerShell `@'...'@` here-string holding a bash test script, read as commands | 1 | Not fixed, `it.todo`: needs to know the shell, which the reader does not get |
| PowerShell `npm init -y *> $null` blocked: `*` read as an initializer (`create-*`) | 1 | Not fixed, `it.todo`, same reason |

`Push-Location` now moves the folder like `cd` (3f25662). No case in this corpus depended on it
alone.

### A gap found on the way

PowerShell `$out = npm install x` ran the install and the hook read it as an assignment, so nothing
was checked. 3f25662 reads the right side as a command when it starts with a bare command name. In this
corpus one case changed from allowed to blocked: `npx --yes pnpm@10.4.1 exec vitest`, a pnpm with 25
advisories.

### True positives

Advisory data of 2026-11-03. Several of these were the agent testing pinright itself on purpose (a
demo `package.json` with old axios and lodash, a workflow with a compromised `tj-actions` release);
they count because the hook answered as it should.

| What the agent ran (anonymized) | Cases | What the hook said |
|---|---|---|
| `npx --yes pnpm@10.4.1 install\|check\|test\|dev` in website worktrees (the version the repository pins) | 37 | 25 advisories, HIGH; same-line fix 10.34.9 |
| `npx pnpm@9.15.0 ...` | 1 | 25 advisories, HIGH |
| `npx --prefix <dir> true` in a test loop, meant as the shell's `true` | 1 | `true` on npm is flagged as malware (MAL-2026-10667) |
| `npm i lodash@4.17.20` and a demo `package.json` with `axios@1.7.9` | 4 | 5 and 33 advisories, HIGH |
| A workflow pinned to `tj-actions/changed-files` v35.9.3 | 1 | GHSA-mrrh-fwg8-r2c3 and one more |
| `npx -y md-to-pdf@5.2.4` to render a report | 1 | CVE-2025-65108, CRITICAL; fix 5.2.5 |
| `pip install` of `poetry==2.3.2`, `transformers==4.50.3`, `pypdf==6.21.2`, `python-jose==3.3.0` in scratch venvs and benchmark fixtures | 4 | advisories, HIGH or CRITICAL |
| `npm install -D gh-pages@~6.1.1` | 1 | pulls `minimatch@3.1.5`; 6.3.0 pulls a fixed one |
| A new `package.json` with `zod@^3.23.8` | 1 | CVE-2023-54404, HIGH; fix needs zod 4 |
| `undici@7.30.0` written by `Set-Content` | 1 | 8 advisories, HIGH; fix 7.30.1 |

### Latency

Wall time per call, from spawning `node dist/cli.js hook claude` to its exit, with six calls in
parallel on a laptop that was also running another benchmark. Each call pays a cold Node start.

| Calls | Baseline p50 / p95 | After p50 / p95 |
|---|---|---|
| With something to check (6,079 / 6,095) | 849 / 1,407 ms | 1,466 / 2,385 ms |
| Commands with nothing to check (random 400) | 396 / 600 ms | 960 / 1,541 ms |
| Writes to other files (random 400) | 819 / 1,706 ms | 364 / 890 ms |

The two runs differ more from machine load than from the code: the fixes touch only the command
reader. Read the medians as an upper range for a busy machine.

### How far to trust these numbers

- One user, one month, mostly TypeScript and Rust work driven by long-running agent loops. Another
  team's sessions will differ in which commands repeat.
- The replay runs today's files, not the files of the day of the session. Folders deleted or renamed
  since produce the 568 artifacts above; a `package.json` that changed since can change what
  `npm run x` follows.
- 22 manifest edits replay as no-ops because the file before the edit could not be rebuilt, so writes
  are under-sampled.
- Advisory data moves: a pin that is clean today can be a true positive next week.
