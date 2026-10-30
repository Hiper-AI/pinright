# safectx security review

**Date:** 2026-10-29
**Branch:** `feat/review`, from `integracion` at `dd570aa`
**Reviewer:** an internal reviewer who did not write the code under review

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
| F10 | Medium | Cache | Cache poisoning. The disk cache holds verdict inputs (OSV answers, versions, the GitHub rate-limit stop). Anyone who could write the directory (a shared `SAFECTX_CACHE_DIR` or `XDG_CACHE_HOME`, or another job on a self-hosted runner) could make a vulnerable package read as clean, with an expiry set centuries ahead. | Fixed | `4dc6a09` |
| F11 | Low | HTTP | `getJson`/`getText` cleared the timeout once headers arrived and had no body cap. A slow or huge body, such as a repo file on `raw.githubusercontent.com`, hung or exhausted the process. | Fixed | `76191f1` |

### Fix details

- **F1:** The Action and the CLI (under `GITHUB_ACTIONS=true`) print reports between `::stop-commands::<random token>` and `::<token>::`. A report that contains the token gets it replaced. The error lines strip newlines. The annotations already escaped `%`, CR, LF, `:` and `,`, and a test now covers them.
- **F2:** `src/projectFile.ts` resolves links and requires the real path to stay inside the project directory. It also requires a regular file and caps reads at 32 MB, read through a bounded file descriptor because `/proc` files report size 0. Errors name the file and never quote its content. The hook reads the file the agent is editing with `allowOutside` (links allowed) but still refuses devices and FIFOs.
- **F3:** In `assessPackage`, `malicious` and `unknown-package` for the requested version now override any package-wide headline. As defence in depth, `judge` in the hook checks the requested version's verdict first.
- **F5:** `TreeAudit.unverifiedAlerts` counts the affected alerts and adds a note, and `auditExitCode` fails at any threshold except `none`. Advisories that OSV leaves unrated on purpose still pass `fail-on: high`, as before. `queryBatch` throws when the result count differs from the query count.
- **F6:** `ActionReport.advisoriesUnknown` marks these cases and `actionsAuditFails` fails on them. A GitHub hiccup for an action with no OSV advisories does not mark it.
- **F8:** `readZip` and `readTar` stop at `maxTotalOutBytes` (64 MB by default). A stored entry larger than the cap is skipped, not truncated.
- **F9:** Each regex keeps the same language in a linear form: anchoring on `[ \t]` instead of `\s` in multiline patterns, `(?<!\s)` before leading whitespace runs, and a separator-required form of the Composer name pattern. Closing `#` sequences are stripped by a loop. `test/redos.test.ts` holds inputs of 50k to 200k characters to a 1.5 s budget and checks that ordinary inputs still parse.
- **F10:** On POSIX, `cacheDirTrusted` requires the cache root to be a real directory owned by the user with no group or other write bits. Otherwise caching turns off. Entries that claim more than 366 days are ignored. Temp files open with `O_EXCL`, mode 0600 and a random name. Keys use SHA-256. The GitHub rate-limit stop read from disk is capped at 2 hours. The Action points `SAFECTX_CACHE_DIR` at `runner.temp`, so each job gets its own cache.

## Checked, no finding

- **SSRF guard.** It allows https only on the default port and rejects credentials in URLs. It handles literal IPs after WHATWG normalisation, IPv4-mapped, NAT64 and 6to4 addresses, and ULA and link-local ranges. It vets addresses inside the socket's `lookup`, which defeats DNS rebinding, and re-checks every redirect hop. The rebinding gap behind an HTTP proxy is documented in SECURITY.md.
- **GitHub token.** The token goes only to the API origin over https. A path such as `@evil.com/` changes the origin and loses the token. `HttpError` messages carry the URL, not headers. `gh auth token` is opt-in, and safectx validates its output and never logs it.
- **Fencing.** Each response gets a fresh 32-bit block id, and safectx rewrites `<untrusted-data` and `</untrusted-data` inside content, in code blocks too. It also rewrites spoofed `SECURITY NOTICE` and `safectx:` lines.
- **Process spawning.** safectx spawns only `gh`, with fixed arguments. Node does not resolve `gh` from the working directory on Windows.
- **Workflows.** Actions are pinned to SHAs, permissions are minimal, and jobs on the self-hosted `hiperai-ci` runner skip fork PRs. Publishing runs on GitHub-hosted runners with OIDC and an environment approval, checks the tarball's SHA-256 against the verified one, and installs with `--ignore-scripts`. `check-pack.mjs` restricts the tarball's contents.
- **MCP inputs.** `check-manifest` reads from disk only file names that `detectKind` recognises, now through `readProjectFile`. Batch sizes and docs and upgrade budgets are capped.

## Residual risks and recommendations

1. **A pull request controls its own `.safectx.json`.** In CI, a PR can add `allow` entries that skip supply-chain checks for chosen packages, or loosen license rules. Advisory and malware findings still count, and the workflow sets `fail-on`. *Recommendation:* document that teams should pass `config:` pointing at a copy taken from the base branch, or make the Action load the policy from `github.base_ref` on `pull_request` events.
2. **Hook timeouts fail open.** Claude Code and Cursor let a tool call proceed when the hook exceeds its time limit. F9 removed the slow paths we found. The hook still makes network calls, so a slow upstream lets a change through. *Recommendation:* give the hook its own deadline below the agent's timeout, and have it answer `ask` when it runs out. *Update:* done. The 45 s deadline (`SAFECTX_HOOK_TIMEOUT_MS`) counts from the hook's start, module loading included, and answers `ask` whatever `onError` says (`deny` stays `deny`).
3. **A source that fails while the verdict for a vulnerable requested version is pending.** The headline becomes `unknown` and the hook applies `onError` (default `allow`, with a warning). Teams that want this closed should set `onError: "ask"` or `"deny"`. *Update:* the starter `.safectx.json` that `safectx init` writes now sets `"onError": "ask"`; the built-in default stays `allow`.
4. **OSV is the second source on the single-package path.** If OSV does not answer, the verdict for a requested version relies on deps.dev alone. deps.dev mirrors OSV with a lag of hours. This is a documented design choice.
5. **Unescaped package names in jsDelivr URLs** (`docs/sources.ts`, `upgrade/*`). The host is fixed and a publisher already controls their own docs, so we left these alone. A strict npm-name check before building the URL would close it.
6. **`-r` includes in requirements files** let the hook's import scanner read any path a repo names. It reads only package names, compares them against imports, and never prints them, so content does not leak. Even so, it reads outside the repo.
7. **The Actions advisory list stops at 10 OSV pages per action.** No action comes close today.
8. **`src/hook/intent.ts`** (shell command parsing) was out of scope for this review. A separate review covers it.

## Tests

All 551 tests pass (546 pass and 5 are skipped). The skips are symlink tests that need a privilege on Windows, plus one POSIX-only permission test; all of them run on Linux CI. A Windows directory-junction test exercises the same containment logic. `npm run lint`, `npm run build` and `npm run bundle:action` are clean, and `action-dist/index.mjs` was regenerated.
