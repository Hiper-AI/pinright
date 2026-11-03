# pinright security review

**Date:** 2026-10-29
**Branch:** `feat/review`, from `integracion` at `dd570aa`
**Reviewer:** a separate AI agent session that did not write the code under review, with findings checked by the author

## Scope

The MCP server (stdio), the CLI, the pre-install hook (except the shell-command parser in `src/hook/intent.ts`, which a separate review covers), the GitHub Action (`action.yml`, `src/action/main.ts`, `action-dist/`), and the repository's workflows and packaging scripts. We also re-checked the earlier hardening instead of assuming it holds: the SSRF guard (`src/safeFetch.ts`), the prompt-injection fencing (`src/untrusted/*`) and GitHub token handling (`src/github.ts`).

The threat model assumes three attackers:

1. **A repository.** You clone it, open it with an agent, or audit its pull request in CI. It controls every file in the tree, symlinks included.
2. **A package publisher.** They control the package name, versions, archives, README, changelog, docs site and registry fields.
3. **A local user on a shared machine or self-hosted runner.** They can write to shared directories.

## Method

- We read every module that touches files, processes, the network, the cache, verdicts or CI output.
- We traced each `catch` and fallback on the verdict path (`advisories/*`, `verdict.ts`, `tree/*`, `actions/*`, `hook/policy.ts`, `auditRun.ts`, `sarif/*`) and asked whether an error or partial answer could produce a pass.
- We ran a ReDoS sweep: a script finds all 759 regex literals in `src/` with the TypeScript scanner and times each one, in a worker with a deadline, on about 900 pathological inputs at two sizes. We rewrote the super-linear ones and re-ran the sweep.
- For Windows process spawning, we planted a `gh.exe` in the working directory and checked whether `spawn('gh')` picks it up. Node's libuv does not search the working directory, so this did not produce a finding.
- Every fix comes with a test that fails before the fix and passes after it.

## Findings

| # | Severity | Area | Finding | Status | Commit |
|---|---|---|---|---|---|
| F1 | High | Action, CLI in CI | Workflow command injection. A lockfile key or an advisory text containing a newline put `::add-mask::`, `::stop-commands::` or forged `::error` lines into the job log. | Fixed | `3239274` |
| F2 | High | MCP, CLI, Action, hook | Dependency files were read through symlinks with no size or type check. A repo could ship `requirements.txt -> ~/.ssh/id_rsa` or `/proc/self/environ`, and fragments then reached tool output, SARIF and deps.dev queries. A link to `/dev/zero` or a FIFO hung or crashed the process. | Fixed | `a60295d` |
| F3 | High | Verdict, hook | Malware passed as "vulnerable" or "unknown". When every recent version had an advisory (a package whose releases all carry `MAL-` records), the headline stayed `vulnerable` and the hook allowed the install. If a source failed during the safe-version scan, the headline was `unknown` and the hook applied `onError` (`allow` by default). | Fixed | `c68a81d`, `534a527` |
| F4 | Medium | Action | Markdown and HTML injection in the job summary. Package names and advisory text could render links or images (for example "[All clear, merge it](https://...)"), and a backtick in a path broke out of its code span. | Fixed | `3239274` |
| F5 | High | Tree audit | Fail-open on rate limits. If OSV returned an error for an advisory's details (429 or 5xx, or more than 400 advisories), the advisory got severity `unknown` and did not count at the default `fail-on: high`, so a CRITICAL passed CI. A short `querybatch` answer also counted as "no advisories". | Fixed | `b215059` |
| F6 | Medium | Actions audit | A `uses:` line whose advisories could not be checked (OSV down, or a branch ref of an action with advisories, such as `tj-actions/changed-files@main`) showed as "unverified" but exited 0. | Fixed | `12f5864` |
| F7 | Medium | Supply checks | `toFindings` ignored a `malicious` verdict. Malware that deps.dev knew about and the OSV batch missed did not block. | Fixed | `10edbb8` |
| F8 | Medium | Docs (PyPI) | Overlapping-entry zip bomb. Thousands of central-directory entries pointing at one 1 MB deflate stream inflated to about 5 GB, so one `get-docs` call on a published wheel crashed the server. | Fixed | `b5497be` |
| F9 | High | Parsers, hook | ReDoS on attacker text. `isComposerName` was exponential: 30 characters took minutes. The `build.gradle` variable regex, ATX headings in changelogs and docs, and the hook's JS import regex were cubic: `import` plus 4k spaces took 45 s, so a repo file could stall the agent's hook until it timed out. The hook does not block an install when it times out. About a dozen more were quadratic on whitespace runs. | Fixed | `e54f701`, `ab379c0` |
| F10 | Medium | Cache | Cache poisoning. The disk cache holds verdict inputs (OSV answers, versions, the GitHub rate-limit stop). Anyone who could write the directory (a shared `PINRIGHT_CACHE_DIR` or `XDG_CACHE_HOME`, or another job on a self-hosted runner) could make a vulnerable package read as clean, with an expiry set centuries ahead. | Fixed | `4dc6a09` |
| F11 | Low | HTTP | `getJson`/`getText` cleared the timeout once headers arrived and had no body cap. A slow or huge body, such as a repo file on `raw.githubusercontent.com`, hung or exhausted the process. | Fixed | `76191f1` |

### Fix details

- **F1:** The Action and the CLI (under `GITHUB_ACTIONS=true`) print reports between `::stop-commands::<random token>` and `::<token>::`. A report that contains the token gets it replaced. The error lines strip newlines. The annotations already escaped `%`, CR, LF, `:` and `,`, and a test now covers them.
- **F2:** `src/projectFile.ts` resolves links and requires the real path to stay inside the project directory. It also requires a regular file and caps reads at 32 MB, read through a bounded file descriptor because `/proc` files report size 0. Errors name the file and never quote its content. The hook reads the file the agent is editing with `allowOutside` (links allowed) but still refuses devices and FIFOs.
- **F3:** In `assessPackage`, `malicious` and `unknown-package` for the requested version now override any package-wide headline. As defence in depth, `judge` in the hook checks the requested version's verdict first.
- **F5:** `TreeAudit.unverifiedAlerts` counts the affected alerts and adds a note, and `auditExitCode` fails at any threshold except `none`. Advisories that OSV leaves unrated on purpose still pass `fail-on: high`, as before. `queryBatch` throws when the result count differs from the query count.
- **F6:** `ActionReport.advisoriesUnknown` marks these cases and `actionsAuditFails` fails on them. A GitHub hiccup for an action with no OSV advisories does not mark it.
- **F8:** `readZip` and `readTar` stop at `maxTotalOutBytes` (64 MB by default). A stored entry larger than the cap is skipped, not truncated.
- **F9:** Each regex keeps the same language in a linear form: anchoring on `[ \t]` instead of `\s` in multiline patterns, `(?<!\s)` before leading whitespace runs, and a separator-required form of the Composer name pattern. Closing `#` sequences are stripped by a loop. `test/redos.test.ts` holds inputs of 50k to 200k characters to a 1.5 s budget and checks that ordinary inputs still parse.
- **F10:** On POSIX, `cacheDirTrusted` requires the cache root to be a real directory owned by the user with no group or other write bits. Otherwise caching turns off. Entries that claim more than 366 days are ignored. Temp files open with `O_EXCL`, mode 0600 and a random name. Keys use SHA-256. The GitHub rate-limit stop read from disk is capped at 2 hours. The Action points `PINRIGHT_CACHE_DIR` at `runner.temp`, so each job gets its own cache.

## Checked, no finding

- **SSRF guard.** It allows https only on the default port and rejects credentials in URLs. It handles literal IPs after WHATWG normalisation, IPv4-mapped, NAT64 and 6to4 addresses, and ULA and link-local ranges. It vets addresses inside the socket's `lookup`, which defeats DNS rebinding, and re-checks every redirect hop. The rebinding gap behind an HTTP proxy is documented in SECURITY.md.
- **GitHub token.** The token goes only to the API origin over https. A path such as `@evil.com/` changes the origin and loses the token. `HttpError` messages carry the URL, not headers. `gh auth token` is opt-in, and pinright validates its output and never logs it.
- **Fencing.** Each response gets a fresh 32-bit block id, and pinright rewrites `<untrusted-data` and `</untrusted-data` inside content, in code blocks too. It also rewrites spoofed `SECURITY NOTICE` and `pinright:` lines.
- **Process spawning.** pinright spawns only `gh`, with fixed arguments. Node does not resolve `gh` from the working directory on Windows.
- **Workflows.** Actions are pinned to SHAs, permissions are minimal, and every job runs on a fresh GitHub-hosted runner (since 2026-11-03; before, CI used a self-hosted runner that skipped fork PRs). Publishing runs with OIDC and an environment approval, checks the tarball's SHA-256 against the verified one, and installs with `--ignore-scripts`. `check-pack.mjs` restricts the tarball's contents.
- **MCP inputs.** `check-manifest` reads from disk only file names that `detectKind` recognises, now through `readProjectFile`. Batch sizes and docs and upgrade budgets are capped.

## Residual risks and recommendations

1. **A pull request controls its own `.pinright.json`.** In CI, a PR can add `allow` entries that skip supply-chain checks for chosen packages, or loosen license rules. Advisory and malware findings still count, and the workflow sets `fail-on`. *Recommendation:* document that teams should pass `config:` pointing at a copy taken from the base branch, or make the Action load the policy from `github.base_ref` on `pull_request` events. *Update:* done. On `pull_request` and `pull_request_target` the Action reads the policy from the base commit, posts a notice when the PR changes it, and fails closed when the base cannot be read.
2. **Hook timeouts fail open.** Claude Code and Cursor let a tool call proceed when the hook exceeds its time limit. F9 removed the slow paths we found. The hook still makes network calls, so a slow upstream lets a change through. *Recommendation:* give the hook its own deadline below the agent's timeout, and have it answer `ask` when it runs out. *Update:* done. The 45 s deadline (`PINRIGHT_HOOK_TIMEOUT_MS`) counts from the hook's start, module loading included, and answers `ask` whatever `onError` says (`deny` stays `deny`).
3. **A source that fails while the verdict for a vulnerable requested version is pending.** The headline becomes `unknown` and the hook applies `onError` (default `allow`, with a warning). Teams that want this closed should set `onError: "ask"` or `"deny"`. *Update:* the starter `.pinright.json` that `pinright init` writes now sets `"onError": "ask"`; the built-in default stays `allow`.
4. **OSV is the second source on the single-package path.** If OSV does not answer, the verdict for a requested version relies on deps.dev alone. deps.dev mirrors OSV with a lag of hours. This is a documented design choice.
5. **Unescaped package names in jsDelivr URLs** (`docs/sources.ts`, `upgrade/*`). The host is fixed and a publisher already controls their own docs, so we left these alone. A strict npm-name check before building the URL would close it.
6. **`-r` includes in requirements files** let the hook's import scanner read any path a repo names. It reads only package names, compares them against imports, and never prints them, so content does not leak. Even so, it reads outside the repo.
7. **The Actions advisory list stops at 10 OSV pages per action.** No action comes close today.
8. **`src/hook/intent.ts`** (shell command parsing) was out of scope for this review. A separate review covers it.

## Tests

All 551 tests pass (546 pass and 5 are skipped). The skips are symlink tests that need a privilege on Windows, plus one POSIX-only permission test; all of them run on Linux CI. A Windows directory-junction test exercises the same containment logic. `npm run lint`, `npm run build` and `npm run bundle:action` are clean, and `action-dist/index.mjs` was regenerated.

---

# Second round

**Date:** 2026-11-01
**Branch:** `feat/review2`, from `lanzamiento` at `3d1ec39` (the 1.0.0 release candidate)
**Reviewer:** a separate AI agent session that did not write the code under review, with findings checked by the author

## Scope

Everything that changed in `src`, `action.yml`, `.github`, `scripts` and `package.json` since the first round (`e0e5b6d..3d1ec39`, 51 commits, about 7,000 lines), plus a fresh look at the riskiest surfaces:

- multi-client `init` (`src/clients/*`): writes into project and user config folders, backups, migration from the old name;
- the rewritten hook (`src/hook/{shell,spec,command,writes,run,policy,late,imports,applyPatch}.ts`), which the first round left out;
- the Action's base-branch policy (`src/action/policySource.ts`), which runs `git show` and `git fetch` with values from the event;
- docs-site discovery and includes (`src/docs/discover.ts`, `includes.ts`), the process-wide scan memo (`src/untrusted/index.ts`), cache prune and clear, `doctor`, the HTTP changes;
- the release workflow and the launch runbook (`release.yml`, `docs/RELEASE.md`).

The threat model is the first round's: a repository, a package publisher, a local user on a shared machine. For the hook we add the agent itself, talked into an install by a prompt injection.

## Method

- We read the diff and every module it touches that spawns processes, writes or deletes files, fetches URLs or feeds a verdict.
- A second reviewer red-teamed the hook on its own: about 120 commands and writes, each run through `fromCommand`, `fromFileWrite` or `intentsFromToolInput`, counting as a bypass only an empty result (no intent, no unverifiable). On this Windows machine we checked the NTFS cases against the real file system.
- We traced every `catch` between the hook's stdin and its answer, looking for an error that ends in exit 1, which Claude Code and Cursor read as "proceed".
- Every fix has a test that fails without it. New regexes are linear; `test/redos.test.ts` passes.

## Findings

| # | Severity | Area | Finding | Status | Commit |
|---|---|---|---|---|---|
| R1 | High | `init` | A cloned repo could ship `.claude/settings.json.pinright.bak` as a symlink to `~/.bashrc`. `init` wrote the repo's `settings.json` there as a backup. A JSONC comment line such as `// ; <command>` is valid JSON and runs as shell. A `.claude` junction to another folder made `init` write its edit outside the project. | Fixed | `e19f1ef` |
| R2 | Medium | Cache | The daily prune (MCP server, `check`, `audit`) deleted every file in every subfolder of the cache directory that was not a live entry, and followed links to folders. With `PINRIGHT_CACHE_DIR` set to `.` or `~/.cache`, it deleted other files. `cache clear` ran `rm -rf` on the folder. | Fixed | `9b40043` |
| R3 | Medium | Hook | An exception while deciding (a bug, a registry answer nobody expected) rejected the deadline race. The process exited 1 and the agent ran the tool. | Fixed: asks, or denies when the policy or deny list says so | `8708f1f` |
| R4 | Medium | Hook | Past 2,000 commands the rest of a line went unread with no intent: `true; ` repeated 2,001 times, then `npm i expresss`. Past six levels of nesting, only a text match on install verbs flagged the cut, and it missed `npx x`, `uvx x`, `n''pm i x` and `npm init x`. | Fixed: any cut is unverifiable | `78cda15` |
| R5 | Medium | Hook | `hasLocalBin` stripped the npm scope, so `npx @evil/tsc` in a TypeScript project matched typescript's `tsc` bin and went unchecked. npm looks up a scoped name as a package and downloads it. | Fixed | `78cda15` |
| R6 | Medium | Hook (Codex) | `apply_patch` ignored `*** Delete File:` and wrote `*** Move to:` under the source name. Moving `notes.txt` onto `requirements.txt`, or deleting `.pinright.json`, passed. The shell equivalents (`mv`, `rm`) were already caught. | Fixed | `a7d82f3` |
| R7 | Medium | Hook | Writes to `package.json::$DATA`, to an 8.3 short name (`PACKAG~1.JSO`) or through a link to a manifest skipped the manifest and policy checks. The OS wrote the real file. | Fixed: the hook resolves the path the OS writes | `735b379` |
| R8 | Medium | Hook | `git checkout <ref> -- package.json`, `git restore --source`, `git mv x requirements.txt`, `git rm .pinright.json` and `mv .pinright.json x` passed silently. | Fixed: unverifiable, or always asks for the policy | `f5c5da5` |
| R9 | Medium | Hook | Only the Claude and Cursor hook files counted as hook configuration. An agent could remove pinright from `.gemini/settings.json`, `.codex/hooks.json`, `.devin/hooks.json`, `.codeium/windsurf/hooks.json` or `.github/hooks/pinright.json` with no prompt. `init` writes all of them. | Fixed | `bf507bd` |
| R10 | Medium | Release | The runbook made the repository public (step 3) before it reserved the name on npm (step 5). Anyone watching new repositories could publish `pinright` first, and the README tells readers to run `npx -y pinright`. | Fixed in the runbook: step 5 first | `4abbb9b` |
| R11 | Low | Action | When `git show base:.pinright.json` failed for a reason other than "no such file" (output over 2 MB, a timeout), the Action moved to the next candidate or ran with no policy. | Fixed: fails closed | `d11f66c`, bundle `22cbd02` |
| R12 | Low | `doctor` | `doctor` read client configs with no size or type check. A repo's `.mcp.json` as a FIFO or a link to `/dev/zero` hung it. | Fixed | `a2c1f2c` |
| R13 | Low | Fencing | The process-wide scan memo keyed results by SHA-1 of the text. Two texts with a SHA-1 collision would share the first one's clean scan. Hard to exploit, since collision blocks must survive UTF-8 decoding. | Fixed: SHA-256 (no behavioural test) | `a2c1f2c` |

## Checked, no finding

- **Action git calls.** `spawnSync('git', args)` with no shell. The base SHA must be 40 or 64 hex characters, and the branch cannot start with `-` or contain `..`, so neither reaches git as an option. `GIT_TERMINAL_PROMPT=0`, `--no-recurse-submodules`. A PR cannot change `.git/config`. Notices and errors go through `escData`, so a path or a branch name cannot inject workflow commands.
- **A PR that turns the target into a link outside the repository** leaves the Action with no policy candidates, so it runs without a policy. The same PR controls which lockfiles that path holds, so this gives it nothing new.
- **SSRF in discovery.** Every URL from metadata, README links and llms.txt goes through `getUntrustedText`. GitHub lookups use the package's own org with names from parsed metadata. jsDelivr refs are URL-encoded.
- **Includes.** Candidates stay on the page's own host (jsDelivr or raw GitHub). A `%2e%2e` in a directive can reach another repo on that host. The publisher already controls the page, so this gains nothing. Included code goes through `prepare` and the response fence.
- **Renames and same-line notes.** Rename hints keep only identifiers of at most 40 characters and sit inside the fence. Tree notes carry names and versions from deps.dev, and `agentMessage` cleans them.
- **Secrets.** `init` writes no token. `mcpEntryEnv` keeps an existing entry's env and warns about credential-looking keys. The legacy migration renames `SAFECTX_*` keys inside the same file. `doctor` prints where a token comes from, never the token. Debug HTTP logs carry no headers.
- **Release workflow.** `permissions: {}` at the top. Only `publish` has `id-token: write`, behind the `npm-publish` environment, and it runs no repository code. The tag guard checks `v<version>` and that the commit is on `origin/main`. Inputs reach shell steps through `env`.

## Residual risks and recommendations

1. **The release tarball was built on a persistent self-hosted runner.** *Closed on 2026-11-03.* `verify` ran on `hiperai-ci`, a VM that also hosted runners for other repositories, so the `publish` job could not tell whether `verify` ran on a clean machine. All jobs, `verify` included, now run on GitHub-hosted `ubuntu-latest`, and the repository's runner registration was removed.
2. **Hook reader gaps the second reviewer confirmed, still open.** Each one installs with no prompt. All need an agent that hides the install on purpose. The threat model calls the hook a speed bump against that.
   - Shell: `n\pm i x` (a backslash kept for Windows paths), PowerShell backtick escapes and `\"`, a heredoc delimiter that needs quote removal (`<<E\OF`), `$X x` where `X="npm i"` (no word splitting), brace expansion `{npm,i,x}`, `$(which npx) x`.
   - cmd.exe: `cmd/c`, `^` escapes, `start /b npm i x`, `cd /d`.
   - Option parsing: an unknown value option before the verb (`npm --cafile ca.pem i x`, `pip --cert c install x`, `uv --cache-dir d add x`). Flags read with the wrong arity (`npm i -p x`, `pdm add -v x`, `uvx -w x`). `pip install -rreqs.txt` and `-r <(…)`.
   - Unhandled verbs and wrappers: `npm it`, `yarn workspace a add x`, `python -mpip`, `pipenv run pip`, `conda run pip`, `cross-env`, `setsid`, `flock`, `find -exec`, `wsl`, `tcsh -c`, `bash --rcfile f -c`.
   - Notebooks: `!{sys.executable} -m pip install x`.
   - Whole-tree git: `git stash pop`, `merge`, `pull`, `cherry-pick`.
   - Edit tools with other parameter names (`filePath`/`oldString`, `old_str`/`new_str`, `file_text`), and `pyproject.toml` with dotted keys or an inline `project` table.

   *Recommendation:* after launch, add each to `test/hookBypass.test.ts` and fix them in that order: the first three bullets matter most. For an agent that hides its installs, the real control is a registry proxy.
3. **A malformed hook input still exits 1** (documented). The agent app builds that JSON, not the model.
4. **The hook deadline starts when `evaluateHook` runs**, after Node starts, the CLI loads and stdin is read. That costs about 0.2 to 0.5 s of the 15 s margin below the agents' 60 s.
5. **`init` follows links for user-scope files** (dotfile managers depend on it), and it skips the project containment check when run from the home directory.
6. **First round's open items 4 to 7** (OSV as second source, jsDelivr names, `-r` includes outside the repo, the OSV page cap) are unchanged.

## Tests

854 tests pass and 9 are skipped (863 in total; the first round had 551). The skips are symlink tests that need a privilege on Windows and POSIX-only tests (FIFO, permission bits); Linux CI runs them. `npm run lint`, `npm run build` and `npm run bundle:action` are clean, and `action-dist/index.mjs` was regenerated.
