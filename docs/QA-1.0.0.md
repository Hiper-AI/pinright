# QA of pinright 1.0.0, before the launch

End-to-end pass on 2026-11-01, on branch `feat/qa` (from `lanzamiento`), as a new user on Windows 11 with
Git Bash, Node 24.20, npm 11.19 and Claude Code 2.1.308. The tarball came from `npm pack` and went into a
temporary npm prefix. Every pinright run had `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and the
cache in a temporary directory. The `claude` runs kept the real profile only for the login (see
[Limits of this pass](#limits-of-this-pass)); before and after the runs the maintainer's
`~/.claude/settings.json`, `~/.claude.json` MCP servers, `~/.cursor`, `~/.codex` and `~/.gemini` files
hashed the same.

## Scenario matrix

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | `--help`, `--version`, `<cmd> --help`, typo suggestions | pass | `check` took a flag as the version: fixed (B9) |
| 1 | `init` claude, cursor, vscode, codex, gemini, windsurf, `--print`, `--user`, second run | pass | Idempotent, backups written, broken JSON stops it. Windsurf writes user files (R4) |
| 1 | `init` over an existing JSONC `.mcp.json` and settings | pass with a note | Comments and other keys kept; a one-line entry next to pinright gets reformatted (R3) |
| 1 | `doctor` online, `--offline`, `--json`, offline network, GitHub rate-limited | pass | Hook timing measures `node`, not the `npx` command `init` writes (R2) |
| 1 | `check` in 8 ecosystems: clean, vulnerable, typo, nonexistent, with and without version | pass after fixes | B1, B3, B4, B6, B8 |
| 1 | `audit` on package-lock, pnpm-lock, yarn.lock, requirements, poetry.lock, uv.lock, Cargo.lock, go.mod/go.sum, pom.xml, composer.lock, Gemfile.lock, packages.lock.json, workflow | pass after fixes | B1 (Go supply-chain warning), B2, B4 |
| 1 | `audit --json`, `--sarif` (14 files against the SARIF 2.1.0 schema), `--fail-on`, bad input | pass | All SARIF valid, relative URIs, fingerprints present |
| 1 | `upgrade` (npm, PyPI ranges, unknown package), `cache path/prune/clear` | pass | |
| 2 | MCP over stdio with the `.mcp.json` from `init` (launched as `cmd /c npx -y pinright`) | pass after fixes | 19 calls, every `untrusted-data` block balanced; B5, B11 |
| 2 | MCP errors: unknown ecosystem, unknown package, missing file | pass after fix | B5 |
| 3 | 13 Claude Code sessions (sonnet, headless, Bash and PowerShell allowed) | pass | Table below |
| 4 | Action: push, PR that loosens `.pinright.json`, `fail-on: none`, bad `fail-on`, unreachable base | pass after fix | Base policy used and the change flagged; B10 |
| 5 | deps.dev refused, OSV 503, upstream that never answers, no network, GitHub 403 rate limit | pass after fix | No silent "ok" left; B12. CLI crash text under OSV 503 (U5) |
| - | Everyday commands through the hook (45 commands) | pass after fix | `npx tsc` without typescript was denied as "a typo of tsx": B7 |
| - | Hook output per agent format (claude, cursor, copilot, codex, gemini, windsurf) | pass | Windsurf exits 2 by design (R7) |

### Agent sessions

Each project got `pinright init claude` and nothing else. The runs used the `.mcp.json` and
`.claude/settings.json` that `init` wrote, plus a QA guard hook that logged every call and would have
denied `expresss`/`reqeusts` had pinright let them through (it never had to).

| Prompt | Hook | MCP calls | Time / cost | Final state |
|---|---|---|---|---|
| Add JWT auth to an Express app | silent | check-packages | 30 s, $0.07 | jsonwebtoken 9.0.3, app loads |
| FastAPI + SQLAlchemy 2 with a venv | silent | check-packages, get-docs x2 (failed validation, B11) | 62 s, $0.09 | installs, `import main` works |
| Upgrade Next 15 to 16 and build | silent | check-packages, upgrade-guide | 82 s, $0.10 | next 16.4.3, `middleware.ts` renamed to `proxy.ts`, build passes |
| GitHub Actions CI workflow | note: pin actions to a SHA | none | 20 s, $0.06 | agent pinned both actions to SHAs |
| Rust CLI with clap | silent | none | 52 s, $0.06 | `cargo build` passes |
| Install lodash 4.17.20 (Bash) | deny, 4.18.1 offered | check-packages | 20 s, $0.05 | nothing installed, agent asked the user |
| Install lodash 4.17.20 (PowerShell tool) | deny | none | 12 s, $0.04 | same |
| `npm install expresss` | not reached | check-package | 8 s, $0.04 | agent refused, asked for `express` |
| Fix a vulnerable lockfile | silent | check-manifest x2 | 27 s, $0.07 | 47 alerts to 0, `pinright audit` clean |
| pnpm workspace, add express | deny on `npx pnpm@9.15.0` (25 advisories) | check-packages | 45 s, $0.08 | manifests written, no install (U3) |
| uv project with httpx and pydantic | silent | check-packages | 34 s, $0.04 | `uv run` imports both |
| Run `npx tsc --noEmit` and `npm test`, fix | silent (typescript installed) | none | 49 s, $0.07 | both pass |
| Run pytest in a venv, fix | silent | none | 15 s, $0.04 | 1 passed |

Every message from the hook led to the expected next step: the agent used the version offered, or
stopped and asked when the user had demanded the flagged one. One false positive came up in a session:
the import note in the pnpm run fired because the agent wrote `index.js` before `package.json`; the
agent read it as stale, correctly.

## Bugs

| ID | Severity | What | Repro | Status |
|---|---|---|---|---|
| B1 | High | Go: every pinned version read as "never published". The hook denied `go get gin@v1.12.0` and offered `v1.12.0` in the same message; `gin@v1.6.0` showed no advisories; `audit` warned that gin v1.6.0 was unpublished | `pinright check go github.com/gin-gonic/gin@v1.6.0` | Fixed, 1dd2c97 (lanzamiento fixed the same case in `assessRequested`, 99eeac6; the "v" now lives in `getVersion` for every caller) |
| B2 | Medium | `audit` proposed an override across a major with no warning (`overrides zod 4.6.6` under `@shadcn/ui`, which needs 3.x); "1 alerts" | `pinright audit` on a lock with zod 3.25.76 via @shadcn/ui | Fixed, b6a9d71 |
| B3 | Low | PYSEC advisories: commit hash listed as a fixed version, duplicate versions, empty title | `pinright check pypi fastapi==0.95.0`, `cargo time@0.1.43` | Fixed, e85d822 and b7665fb |
| B4 | Medium | A package whose releases are all deprecated (left-pad, request) came out as "no recent stable version is free of known advisories", or "@1.3.0 has 0 known advisories" with a version; `check-packages` said VULNERABLE | `pinright check npm left-pad` | Fixed, c85b935 |
| B5 | Low | `check-manifest` on a missing path returned a raw `ENOENT ... stat` | MCP `check-manifest { path: "nope" }` | Fixed, 418d124 |
| B6 | Low | A version that was never published got "No 99.x release is free of known advisories" and "call upgrade-guide from 99.0.0" | `pinright check npm react@99.0.0` | Fixed, d7c674a |
| B7 | High | Hook false positive: `npx tsc --noEmit` without typescript installed was denied as "a typo of tsx", `npx ng` as "a typo of pg", with "Use the real package name" | hook on `npx tsc --noEmit` in a project without node_modules | Fixed, 0302373: the deny now explains the bin and how to install typescript (or `@angular/cli`) |
| B8 | Low | A typosquat that exists ended with "Recommended version: 0.0.0 (latest). License: ISC" | `pinright check npm expresss` | Fixed, ce2c55c |
| B9 | Low | `check` read flags as arguments: `check npm lodash --json` said "version --json ... is not in the registry" (exit 1) | as shown | Fixed, eff9dfd |
| B10 | Medium | Action: a policy denial, which fails the step at any `fail-on`, sat at row 48 of 51, outside the 20 rows of the summary and the 10 annotations | Action on a PR with `deny: axios` and 50 advisories | Fixed, 8f78137 (bundle in 13c3989) |
| B11 | Medium | `get-docs` required `libraryId` and `query`; an agent called it as it had called `check-packages` (`{ ecosystem, name, version }`) and got two validation errors, then wrote code without docs | FastAPI session | Fixed, 705d5e1: `name` + `ecosystem` accepted, `query` optional |
| B12 | Medium | With OSV down, a deprecated version passed the hook with a deprecation note only, no "could not be verified", whatever `onError` said | `OSV_BASE_URL=http://127.0.0.1:<503>`, hook on `npm i left-pad` | Fixed, db160a8 |

Each fix has a regression test that fails without it. The SHAs are those of `feat/qa2`, where the
fixes sit on top of `lanzamiento` f7387ec (see [Second pass](#second-pass-on-lanzamiento-f7387ec)).

## README mismatches

- **R1. Install before the publish.** Expected and harmless: `npx -y pinright` 404s until Tuesday. The
  maintainer's own pinright hook blocked `npx -y pinright --version` as "no such package" during this
  pass, which is what it should do.
- **R2. Latency.** The table says a command that installs nothing costs 121 ms (p50). That is
  `node dist/cli.js hook claude`. `init` wires `npx -y pinright hook claude`, which measured 1.2 s p50
  and 2.0 s max per shell command on this machine, with pinright installed globally (`pinright hook
  claude` directly: 168 ms). `doctor` reports "hook startup 198 ms" for the same reason. On Windows the
  agent pays about a second before every Bash, Write and Edit. *Fixed in 1315c7c and 104b76b (U1).*
- **R3. "Other servers ... and indentation stay as you left them."** Content and comments stay, but a
  one-line `"other": { ... }` next to the new entry comes back expanded over several lines
  (jsonc-parser formats whole lines around the insertion). *README wording fixed, 104b76b.*
- **R4. Windsurf.** `init windsurf` without `--user` writes both the server and the hook to the user
  files (`%APPDATA%\devin\mcp_config.json`, `~\.codeium\windsurf\hooks.json`) and no `.pinright.json`,
  although the table lists a project hook file `.devin/hooks.json`. The output says what it wrote, but a
  user reading "in this project" will not expect user-level changes. *init now says "user scope ... these
  files apply to every project" (e109509); README in 104b76b. Behavior unchanged.*
- **R5. Cache directory.** On Windows, `XDG_CACHE_HOME` wins over `%LOCALAPPDATA%` when set (Git Bash
  setups sometimes set it). The README names only `%LOCALAPPDATA%\pinright`. *README fixed, 104b76b.*
- **R6. "Every ... check/audit/upgrade run ends with a NOTE when an upstream failed."** `audit` with OSV
  answering 503 and `upgrade` with no network stop with `[pinright] fatal: HTTP 503 from .../v1/querybatch`
  and exit 1, the code the table reserves for findings. It fails closed, but CI cannot tell "findings"
  from "could not run" (the Action uses 3 for that). *README now names the two cases, 104b76b; the exit
  code is still U5.*
- **R7. "`pinright hook` always exits 0."** `hook windsurf` exits 2 to block, as the hook table says;
  the CLI section should say "except Windsurf". *Already fixed on `lanzamiento`.*

## UX notes and recommendations

- **U1. The npx cost of the hook (R2).** Done in the second pass: see
  [Hook launcher](#hook-launcher-u1-r2).
- **U2. Field names differ across tools.** `check-package` and `check-packages` take `name`,
  `upgrade-guide` takes `package` or `libraryId`, `get-docs` took only `libraryId` and `packageName`.
  B11 fixes the case that failed; aligning on `name` + `ecosystem` everywhere would remove the guesswork.
- **U3. Executed package managers.** The hook denied `npx pnpm@9.15.0` in a workspace whose
  `packageManager` pins that version, and the agent stopped. The advice (move to pnpm 10.x) is correct,
  but it is a repo-wide decision. Consider `ask` instead of `deny` for package managers named in
  `packageManager`, or a note that tells the agent to ask the user.
- **U4. No per-version allow.** When the user insists on lodash 4.17.20, the only escape is
  `"allow": ["lodash"]`, which skips every check for lodash from then on. An entry such as
  `"lodash@4.17.20"` (or an acknowledged advisory list) would fit that request better.
- **U5. Fatal errors in the CLI** (R6): print `pinright audit could not run: osv.dev did not answer (HTTP
  503). Nothing was verified.` and consider a distinct exit code, as the Action has.
- **U6. Fix commands per tool.** `audit` of `uv.lock` and `poetry.lock` suggests `pip install
  "fastapi==0.162.0"`; `uv add` and `poetry add` would match the project.
- **U7. "no fix released" for Go modules** whose fix is a pseudo-version (`golang.org/x/sys` before its
  first tag). Any tagged release fixes it; the text tells the agent there is nothing to do.
- **U8. Summary severity.** The Action table shows the CVSS bucket ("high") next to a message that says
  "Severity: moderate" (the GitHub rating) for the same advisory.
- **U9. Cooldown notes on `npx <tool>`.** `npx eslint .` without eslint installed gets "the newest
  version 10.14.0 is younger than the 3-day cooldown; pin 10.13.0". Correct, but noisy for a lint run.
- **U10. Offline lookalikes.** With deps.dev down, `npm i is-odd is-even` asks a human because the names
  sit one edit from `is-obj` and `isexe`. Documented behavior; mention it in the troubleshooting text.
- **U11. Partial print on a parse error.** When one client file does not parse, `init` prints the full
  plan for the other clients ("would update") and then the error. Printing only the error would read
  more clearly.

## Blockers for Tuesday

None open. B1 (Go pins always denied) and B7 (`npx tsc` denied as a typo) would have hit users in the
first hour; B1 was also fixed on `lanzamiento`, B7 only here. U1 (a second of hook latency per tool
call on Windows) is fixed for user-level setups (`npm i -g pinright && pinright init --user`). Projects
that commit their files keep npx and its second per call, by decision: those files have to work on
every teammate's machine.

## Second pass on lanzamiento f7387ec

`feat/qa2` starts from `lanzamiento` f7387ec, which brought the second security review (R1 to R13),
30 false-positive fixes from the public-corpus replay, the v6 benchmark with
`PINRIGHT_ABLATION=docs-only` and the paper kit.

**Re-applying the 16 commits.** Every commit applied without a textual conflict. Three needed a
decision:

- B1: `lanzamiento` had fixed the same Go bug in `assessRequested` (99eeac6). This branch keeps one
  place for it, `getVersion`, which also covers the other per-version lookups (the supply-chain check
  in `audit` still warned that gin v1.6.0 was unpublished), and `assessRequested` passes the plain
  version again (1dd2c97). The test from 99eeac6 still passes.
- B10 and the two bundle commits: the source changes went in alone and `action-dist/index.mjs` was
  regenerated once at the end (13c3989), so no stale bundle sits between commits.
- B11: the docs-only ablation server in `src/mcp.ts` registers its own `get-docs` with the old
  schema. It stays as it was, so the v6 benchmark's docs-only arm keeps measuring what it measured.

### Hook launcher (U1, R2)

Measured on Windows 11, Node 24.20, npm 11.19: 7 runs after a warm-up, the Claude Code hook on
`npm test`.

| Launcher | p50 / p95 |
|---|---|
| `pinright hook claude` (global install) | 157 / 182 ms |
| `npx -y pinright hook claude`, global install present | 949 / 1,317 ms |
| `npx -y pinright@1 hook claude`, global install present | skips the global install and asks the registry (404 before the publish) |
| `npx -y semver` from npx's cache, no global install | 1,069 / 1,113 ms, revalidates the packument on every call |
| `npx -y semver@7` (major pinned) | 1,287 / 1,382 ms, revalidates and adds an advisories request |
| `npx -y semver@7.8.0` (exact) | 1,048 / 1,164 ms, revalidates too |
| `node -e 0` | 84 / 119 ms |

Pinning the major does not avoid npx's registry lookup and costs 0.2 s more, so the npx fallback stays
unpinned. What changed (1315c7c, then 9c932e6 after the fail-safe decision):

- `findGlobalInstall` accepts a pinright on PATH only when its `package.json` names this package and
  its bin, with the same major. It skips `node_modules/.bin` and npx's `_npx` cache, which npm puts on
  PATH while `npx pinright init` runs.
- Project files (the ones a team commits) get `npx -y pinright` by default, even with a global install.
  User files (`--user`, and clients that only have user files) get `pinright` when the global install
  is there. `--bin` puts the binary in project files and says that teammates without it lose the
  hook; `--npx` writes npx everywhere; `--dev` is unchanged. `init` prints the launcher of each file
  and why.
- `doctor` shows the launcher of each client's server and hook, warns when a hook goes through npx
  with the cost measured on the spot (884 to 923 ms here, against 134 to 140 ms for the binary), and
  warns when a config names `pinright` but no global install is on PATH.
- `pinright --help` and the README offer two ways in: `npm i -g pinright && pinright init --user` for
  you, `npx -y pinright init` committed for the team (407f791); the latency section says what each
  table measures (104b76b); `smoke:clients` covers the project default, `--bin` and `--user` with a
  global install (9c932e6).
- A real Claude Code session on Windows with `"command": "pinright"` and `pinright hook claude`
  connected the server and blocked lodash 4.17.20 as before.

### Two hooks for one client

Claude Code 2.1.308 merges the hooks of every settings source. Measured with a logging hook in the
project's `.claude/settings.json` and another in a `--settings` file (a separate source, standing in
for `~/.claude/settings.json`, which this pass does not touch), one Bash call:

| Commands | Hook runs |
|---|---|
| identical in both files | 1 (merged) |
| different (`proj` and `user`) | 2, started 6 ms apart, so in parallel |

A user hook `pinright hook claude` next to a committed project hook `npx -y pinright hook claude` is
the second case: both run, every tool call is checked twice and waits for the npx one, so the user
hook gives no speed in that project. `init` now avoids creating that pair (9c932e6):

- `init --user` leaves the hook out of the user file while the current project has a different
  pinright hook, and says to run it from a folder without a project hook for the other projects. The
  user's MCP entry is still written.
- `init` in a project whose user file already has a different pinright hook writes the project hook
  (the team needs it) and notes the double check.
- `doctor` warns when both files have different pinright hooks, and no longer suggests `--user` to
  speed up a project that commits its hook; it suggests `--bin` for teams that install pinright
  everywhere.

The user and project hooks of Cursor, Codex and Gemini CLI were not measured; `init` and `doctor` apply
the same rule to them.

## Limits of this pass

- The `claude` runs used the real `USERPROFILE` because Claude Code keeps its login there; with a
  temporary profile it answers "Not logged in". `--setting-sources project`, `--strict-mcp-config` and
  `--settings` kept the user's hooks and MCP servers out, but the user's global `CLAUDE.md` still loaded
  (the agent answered in Spanish to English prompts). pinright, npm, pip, uv, cargo and go ran with
  temporary caches, prefixes and homes, and `PIP_REQUIRE_VIRTUALENV=1`.
- Cursor, VS Code, Codex, Gemini CLI and Windsurf were not run as agents; their hook formats were
  checked by feeding `pinright hook <agent>` their input shapes.
- GitHub's rate limit was simulated with `GITHUB_API_URL` pointing at a local server answering 403 with
  `x-ratelimit-remaining: 0`, so the real anonymous budget of this machine stayed untouched (another
  benchmark was running).
- The fixture lockfiles are real (generated by npm, pnpm, yarn, uv, poetry, cargo and go); `pom.xml`,
  `composer.lock`, `Gemfile.lock` and `packages.lock.json` were written by hand in the real formats.
