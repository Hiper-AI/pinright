# CLI and configuration

## Commands

```bash
npx pinright check npm axios@1.7.9          # exit 1 if not ok
npx pinright audit . --fail-on=high         # whole-tree audit for CI, exit 1 on findings
npx pinright audit package-lock.json --json
npx pinright upgrade npm zod 3.25.76 4.6.7  # what changes between two versions
npx pinright audit .github/workflows        # GitHub Actions: advisories and SHA pinning
npx pinright check composer guzzlehttp/guzzle:7.4.0
npx pinright audit . --fail-on high --sarif pinright.sarif   # SARIF 2.1.0 for code scanning
npx pinright doctor                        # setup check: Node, upstreams, cache, GitHub auth, wiring
npx pinright cache prune                   # drop expired entries, cap the size
npx pinright cache clear                   # delete the disk cache
npx pinright check --help                  # every command has --help
```

`pinright --help` lists the commands, `pinright <command> --help` shows one, `pinright --version`
prints the version. A mistyped command or flag gets a suggestion (`pinright chek` answers
`Did you mean "pinright check"?`) and exit code 2, instead of being ignored. Colors appear
only on a terminal; `NO_COLOR` turns them off and `FORCE_COLOR` turns them on through a pipe.
Run `pinright` with no arguments in a terminal and you get the help; an agent starting it over a
pipe gets the MCP server, and `pinright serve` starts the server either way.

Exit codes, for every command:

| Code | Meaning |
|---|---|
| 0 | Done. `check`: verdict ok. `audit`: nothing at or above `--fail-on`. `doctor`: no check failed. |
| 1 | `check`: the verdict is anything but ok, `unknown` included. `audit`: findings at or above `--fail-on`. `upgrade`: no target version. `doctor`: a check failed. |
| 2 | Usage error: unknown command or flag, missing or bad argument, nothing to audit. |

`pinright hook` puts its decision on stdout and exits 0; for Windsurf it blocks with exit 2 and the
reason on stderr. An error while deciding asks a human. Input that is not JSON exits 1, which Claude
Code and Cursor read as "proceed": the agent application builds that input, not the model (see
[HOOK-THREAT-MODEL.md](HOOK-THREAT-MODEL.md)).

**`pinright doctor`** checks, and only reads: the Node version against `engines`; whether deps.dev,
OSV, the npm registry, PyPI, Packagist and jsDelivr answer, with the time each took (deps.dev and
OSV are the verdict, so those two failing fails the run); the cache directory, writable or not,
with its size; how pinright authenticates to GitHub (`GITHUB_TOKEN`, `GH_TOKEN`, the GitHub CLI
login or anonymous) and how many API requests are left this hour, never the token; which agents
have pinright configured, from the same client list `init` uses (project and user files), and for
those with a hook whether it is wired; how each client starts the server and the hook (the global
`pinright`, npx or a checkout), with a warning and the npx cost measured on the spot when a hook
goes through npx, and when a user hook and a different project hook would both run; the nearest `.pinright.json` and whether it parses; and how long the hook takes
on a command that installs nothing, run directly. `--json` prints the same as JSON, `--offline`
skips the network probes and the npx measurement.

**Cache.** Answers from the registries and advisory databases are kept on disk:
`%LOCALAPPDATA%\pinright` on Windows, `$XDG_CACHE_HOME/pinright` or `~/.cache/pinright` elsewhere
(`XDG_CACHE_HOME` wins on Windows too when it is set), or `PINRIGHT_CACHE_DIR`. `pinright cache path` prints it. Advisories and versions expire after 24
hours, docs after 7 days, file listings of a release tag after a year. An expired entry is deleted
when it is next read. The MCP server and `check`/`audit`/`upgrade` prune once a day: expired entries
first, then the oldest until the cache fits `PINRIGHT_CACHE_MAX_MB` (200). The hook never prunes,
since the agent waits on it. `pinright cache prune` does it now, `pinright cache clear` deletes
everything.

`audit` flags: `--fail-on low|moderate|high|critical|none` (default `low`; `none` reports
and exits 0), `--json`, `--sarif <file>`, `--sarif-root <dir>` (SARIF paths are relative to
it; default is the git repository root), `--config <file>` (a `.pinright.json` other than the
nearest one) and `--no-supply-chain` (skip the per-package checks below).

Besides the advisories of the whole tree, `audit` checks each direct dependency for a
typosquat name, a package or version the registry does not have, deprecation and the
[supply-chain signals](how-it-works.md#supply-chain-signals), and applies the deny and license rules of
`.pinright.json`. Exit codes: 0 clean, 1 findings, 2 bad input or nothing to audit. At any
`--fail-on` level other than `none`, these findings fail the run whatever their severity:
malware, a typosquat, an install script in a brand-new package or from a new publisher, a
package or license the policy denies, and an action ref that does not exist. A
`.pinright.json` that does not parse fails it even with `none`. A missing version, deprecation
and the other risk signals show up in the report and never fail it. Neither does a package or
version the registry publishes and deps.dev has not indexed yet (it does so with a delay of hours):
it is reported as unverified (`pinright/not-indexed` in SARIF), with osv.dev's advisories for it
counted as usual.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PINRIGHT_COOLDOWN_DAYS` | `3` | Minimum age of a version to be recommended. |
| `PINRIGHT_MAX_CANDIDATES` | `12` | Versions inspected, newest first, before giving up on a safe one. |
| `GITHUB_TOKEN` / `GH_TOKEN` | none | Raises GitHub's API limit from 60 to 5,000 requests an hour. Read-only use; sent only to `api.github.com`. |
| `PINRIGHT_GH_CLI` | unset | `1` uses the GitHub CLI login (`gh auth token`) when no `GITHUB_TOKEN` is set. |
| `PINRIGHT_DEBUG_HTTP` | unset | `1` logs each request (method, URL, status, start offset and duration; never headers) to stderr. |
| `PINRIGHT_DOCS_BUDGET` | `10000` | Characters of docs per answer. |
| `PINRIGHT_CACHE_DIR` | OS cache dir `/pinright` | Disk cache (docs 7 days, advisories 24 h, repo listings at a tag 1 year). |
| `PINRIGHT_NO_CACHE` | unset | `1` disables the cache. |
| `PINRIGHT_CACHE_MAX_MB` | `200` | Size the daily prune brings the cache down to. |
| `PINRIGHT_TIMEOUT_MS` | `15000` | Per-request timeout, body included. A host that times out or refuses is skipped for 30 s. |
| `PINRIGHT_BATCH_TIMEOUT_MS` | `45000` | Deadline for `check-packages`; packages still pending come back as "not checked". The check of the ranges the packages set on each other runs within the same deadline and is skipped when it runs out. |
| `PINRIGHT_PROJECT_DIR` | working directory | Project to read installed versions and `.pinright.json` from, when the client does not announce roots. |

No telemetry. Requests go from your machine to the public APIs listed in [How pinright works](how-it-works.md) and nowhere else. Docs
content is data for the agent; pinright does not execute anything it downloads. [SECURITY.md](../SECURITY.md)
lists each service and what it receives, and how to report a vulnerability. A docs-site URL from
package metadata goes through a guard that refuses loopback, private and cloud-metadata addresses
(see SECURITY.md). Behind a proxy, set
`HTTPS_PROXY` with `NODE_USE_ENV_PROXY=1` (recent Node 22 and 24).

## GitHub rate limit

Without a token, GitHub's API allows 60 requests an hour per IP. pinright spends little of it:

- Repo files at a release tag come from jsDelivr's GitHub mirror (`data.jsdelivr.com` listings,
  `cdn.jsdelivr.net/gh` files), which has no rate limit and keeps a tag forever. pinright caches the
  listing for a year. The API lists only the default branch and repos over jsDelivr's 50 MB limit.
- Actions refs come from one git request per repo, outside the API limit.
- Upgrade guides read GitHub release notes through the API: 3 pages without a token, 10 with one.

Measured on a cold cache, 2026-10-29: docs for 8 popular npm and PyPI packages took 1 API request
(next.js, too large for jsDelivr), down from 9. `upgrade npm next 15.5.0 16.0.0` took 4, down from 6.
Auditing a workflow with 10 actions took 2, down from 23. The hook on a workflow with 3 actions took
none, down from 6.

When GitHub says the budget is spent (403 or 429 with `x-ratelimit-remaining: 0`, or `retry-after`),
pinright stops calling the API until the reset and remembers that in its cache, so a hook process
started a second later does not try again. The answer then ends with a note: what it is missing,
when GitHub resets, and how to add a token.

To raise the limit to 5,000 an hour, use one of these:

- Export `GITHUB_TOKEN` in the environment that starts your agent. A fine-grained token with
  read-only access to public repositories is enough.
- Set `PINRIGHT_GH_CLI=1` (or run `pinright init --gh-cli`) to use your GitHub CLI login. pinright runs
  `gh auth token` once, the first time it needs the API. You have to opt in because that token
  carries your account's full scopes (`repo`, `workflow`), far more than reading public repos needs.

pinright sends the token only to `api.github.com` over HTTPS. It never logs it, never puts it in a
cache key or a tool answer, and `init` never writes it into `.mcp.json` or settings files.
