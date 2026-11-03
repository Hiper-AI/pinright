# The pre-install hook

Once `pinright init` has wired the hook ([Install](install.md)) and you have restarted the agent,
every install command and every write to a manifest or workflow goes through the hook first. When
the agent runs
`npm install lodash@4.17.20`, it gets this back and the command does not run:

```
pinright blocked this dependency change:
- lodash@4.17.20 (npm) has 5 known advisories (CVE-2021-23337, CVE-2026-4800, CVE-2020-28500, HIGH). Use 4.x release 4.18.1: npm install lodash@4.18.1
Change the version (or the name) and try again. check-package and get-docs from the pinright MCP server explain each case.
```

The agent reads the reason and usually retries with the version it names. Commands that install
nothing pass without a network call; a check of one package takes a few seconds the first time
and well under a second once cached (see [Latency](#latency)).

To let one package through (a private one, say), add it to `"allow"` in `.pinright.json`. To turn
the hook off, delete the pinright entry from the client's hook file (Claude Code: `hooks.PreToolUse`
in `.claude/settings.json`; Cursor: `.cursor/hooks.json`; the others under [Clients](install.md#clients)); the
MCP tools keep working. When deps.dev or OSV cannot be reached, the starter `.pinright.json` that
`init` writes has the hook ask you (`"onError": "ask"`). Without a policy file the hook allows the
change and tells the agent it was not verified (see [When a source is down](#when-a-source-is-down)).

## What it reads

`pinright hook <agent>` reads what the agent is about to do, in each agent's hook format:

| Agent | Command | Events `init` registers | How it blocks |
|---|---|---|---|
| Claude Code | `hook claude` | `PreToolUse` on `Bash\|PowerShell\|Write\|Edit\|MultiEdit\|NotebookEdit` | `permissionDecision` deny or ask |
| Cursor | `hook cursor` | `beforeShellExecution`, `preToolUse` | `permission` deny or ask |
| VS Code / Copilot | `hook copilot` | `PreToolUse` in `.github/hooks/pinright.json` | `permissionDecision` deny or ask |
| OpenAI Codex | `hook codex` | `PreToolUse` on `Bash\|apply_patch` | `permissionDecision` deny |
| Gemini CLI | `hook gemini` | `BeforeTool` on `run_shell_command\|write_file\|replace` | `decision` deny |
| Windsurf | `hook windsurf` | `pre_run_command`, `pre_write_code` | exit code 2, reason on stderr |

Codex, Gemini CLI and Windsurf have no "ask a human" answer, so where Claude Code would ask,
pinright denies there and says why. For Codex `apply_patch`, the hook reads each added or updated
file out of the patch. What it checks:

- installs: `npm`/`pnpm`/`yarn`/`bun add|install`, `npx`/`pnpm dlx`/`bunx`, `pip install` (also `-r file`),
  `uv add`/`uv pip install`, `uvx`, `pipx`, `poetry add`, `pdm add`, `cargo add|install`, `go get|install`,
  `gem install`, `bundle add`, `dotnet add package`, `composer require`, `composer create-project`;
- writes to `package.json`, `requirements*.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`,
  `build.gradle`, `build.gradle.kts`, `gradle/libs.versions.toml`, `composer.json`: only
  dependencies that are new or changed version count, so editing an old project does not re-open
  every old dependency;
- writes to `.github/workflows/*.yml` and `action.yml`: new or re-pointed `uses:` lines.

The command reader follows what a command runs: `bash -c`, `eval`, `$(…)`, `cmd /c`, `powershell
-Command`, wrappers like `sudo`, `env` and `xargs`, aliases and variables set in the same line, and
scripts run by name (`npm run`, lifecycle scripts, `make`, `just`, `sh script.sh`). Shell writes to a
manifest (`echo >>`, `tee`, `cat <<EOF >`, `cp`) are read like a Write, and notebook cells with
`!pip install` like a command. Lockfiles, registry settings (`.npmrc`, `pip.conf`, `--index-url`) and
`overrides`/`resolutions` count too.

`npx <bin>` runs the project's own bin when `node_modules/.bin` has it. The hook reads the whole line
before any of it runs, so in `npm install && npx tsc` the bin does not exist yet. The hook still treats
that `npx` as local when four things hold. An earlier command on the line ran `npm install`, `npm ci`,
`pnpm install` or `yarn` with no package names, no options that change what gets linked, and no
wrapper. The `package.json` in that folder lists the bin's package under `dependencies` or
`devDependencies`: a package with the bin's name, or `typescript` for `tsc` and `tsserver`
(`@angular/cli`, `@biomejs/biome`, `@playwright/test` and `@nestjs/cli` for theirs). `npx` runs in the
same folder with no version or `-p`. Between the two, only `&&`, `;`, a newline or a pipe into a
filter (`| tail`) join the commands, and none of them can remove the bin or leave the folder unknown.
A `||`, a background `&`, a subshell, `rm -rf node_modules`, `cd "$X"` or `popd` brings the check
back. If the install fails, `npx` downloads the package after all, as it would if you typed it.

What the hook cannot check (a package name in a variable, a git or URL source, another registry, a
manifest rewritten by `sed -i`) is *unverifiable*: it asks by default (`PINRIGHT_HOOK_UNVERIFIABLE`).
Changes to `.pinright.json` or to the hook's entry in the agent settings always ask a human. The hook is
a guardrail, not a sandbox: [HOOK-THREAT-MODEL.md](HOOK-THREAT-MODEL.md) lists what it covers,
what it does not, and each bypass we tried. After upgrading, run `pinright init` again to pick up the
new matcher.

It blocks malware, typosquats, packages or versions that do not exist, versions with known advisories
when a clean one exists, deprecated versions with a maintained successor, and dependencies whose
transitive tree has advisories that a same-line upgrade clears. When a vulnerable pin is itself a
dependency of another pinned package, it points at the parent upgrade, so the fix still installs.
It also blocks a manifest whose pinned versions contradict each other (a pin outside the range its
parent requires), because that install would fail. When no clean version exists at all, it asks a
human for high and critical advisories and lets the rest through with a note, so the work does not stop
on a moderate finding nobody can fix yet. It also blocks two supply-chain patterns (see [Supply-chain signals](how-it-works.md#supply-chain-signals)): a
package first published less than 14 days ago that runs install scripts, and a release that adds install
scripts and comes from a publisher the previous releases never had. Everything else passes, with notes
for the agent.

**Undeclared imports.** An agent can pin every dependency it lists and still import one it never
listed: in the benchmark, the hook-only agent wrote `from langchain_text_splitters import ...` without
`langchain-text-splitters` in `requirements.txt`, and the import failed. When the agent writes a Python
or JS/TS source file, the hook compares the imports that are new in that write with the manifests above
it (`requirements*.txt`, `pyproject.toml`, `setup.py`/`setup.cfg`/`Pipfile`, `package.json`, including
the ones of an enclosing workspace); when it writes `requirements*.txt`, `pyproject.toml` or
`package.json`, it compares the project's source files with the new content. Each missing package comes
back as a note with the newest clean version to pin, checked like any other dependency. It never blocks.
Python import names go through a curated map to distribution names (`yaml` is PyYAML, `PIL` is pillow,
`sklearn` is scikit-learn, LangChain's split packages, ...) and PEP 503 normalization otherwise.
Left alone: the standard library and Node builtins, relative imports, aliases (`@/`, `~/`, `#`, `$lib`,
`tsconfig` paths), project-local modules and workspace packages, imports guarded by `try`/`if`
(optional dependencies), and names the registry does not know. A package that is only pulled in by
another one still gets the note: it works today by accident. `PINRIGHT_IMPORTS_TIMEOUT_MS` (15000) bounds
the check.

The team policy in `.pinright.json` ([Team policy](policy.md)) sets the same knobs for the whole repo. The hook
reads the nearest one walking up from its working directory to the repository root. These variables
override the file:

| Variable | Default | Meaning |
|---|---|---|
| `PINRIGHT_ALLOW` | none | Comma list of names that skip the hook, `*` wildcard (`@acme/*`). Added to the file's `allow`. For private packages. |
| `PINRIGHT_HOOK_ON_ERROR` | `allow` (`ask` in the starter `.pinright.json`) | What to do when deps.dev or OSV cannot be reached: `allow`, `ask` or `deny`. A name one edit away from a popular package asks even with `allow`. |
| `PINRIGHT_HOOK_UNVERIFIABLE` | `ask` | What pinright cannot check (git or URL sources, another registry, a command or file it cannot read): `allow`, `ask` or `deny`. |
| `PINRIGHT_HOOK_NO_FIX` | `severity` | When no clean version exists: `severity` asks for high/critical and allows the rest; or `allow`, `ask`, `deny` for all. |
| `PINRIGHT_HOOK_COOLDOWN` | `warn` | `enforce` blocks an unpinned install whose newest version is inside the cooldown window. |
| `PINRIGHT_HOOK_TIMEOUT_MS` | `45000` | Deadline for the whole check, counted from the hook's start. On timeout the hook asks a human, whatever `onError` says (a stricter `deny` still denies); Codex, Gemini CLI and Windsurf have no ask and get a deny with the reason. Keep it below the hook timeout in the agent's settings (60 s as `init` writes it): past that, the agent lets the change through. |
| `PINRIGHT_HOOK_RISK` | `enforce` | Supply-chain signals: `enforce` blocks the two patterns above, `warn` only notes them, `off` ignores them. |
| `PINRIGHT_SEVERITY_THRESHOLD` | `low` | Advisories below this severity (`low`, `moderate`, `high`, `critical`) become notes instead of blocks. |
| `PINRIGHT_ACTIONS_PIN` | `warn` | `enforce` blocks a GitHub Action referenced by a tag or branch instead of a commit SHA. |

## When a source is down

pinright says "ok" only when deps.dev and OSV both answered. If either one fails, the verdict is
`unknown` and names the host and the cause (`api.osv.dev unreachable (DNS lookup failed)`,
`HTTP 503`, `no answer within 15 s`). With OSV down, a version that deps.dev already flags stays
`vulnerable`; one deps.dev calls clean becomes `unknown`, because deps.dev mirrors OSV hours late
and malware reports reach OSV first.

The hook then applies `onError` and says so. With the default `allow`, the agent gets a note
ending in `Allowed unverified (onError: allow)`. With `ask` or `deny`, the reason heads the block
message: `... could not be verified (...). The project's onError policy is "deny" for checks that
cannot complete.` The same goes for transitive dependencies it could not check and for GitHub
Actions refs it could not resolve (reported as unverified, never as "does not exist").

A check that outlives `PINRIGHT_HOOK_TIMEOUT_MS` (45 s) is different. The agents give the hook 60 s
and then run the tool anyway, so pinright answers first and asks you, even with `onError: allow`:
`pinright could not finish checking left-pad in time (45 s, PINRIGHT_HOOK_TIMEOUT_MS); a human should
approve it, or retry once deps.dev and OSV answer.` The deny list, unverifiable sources and lookalike
names still decide as usual, since they need no network.

| What fails | Verdict / tool answer | Hook (`onError: allow` / `deny`) |
|---|---|---|
| No network, DNS failure | `unknown`: "deps.dev did not answer (api.deps.dev unreachable (DNS lookup failed))" | allow with the note / deny with the reason |
| deps.dev 5xx | `unknown`, with the HTTP status | same |
| OSV down, deps.dev up | deps.dev's advisories still count; otherwise `unknown` ("osv.dev did not answer ...; unverified") | same for the unverified ones |
| deps.dev has not indexed a fresh release yet (404 there, published on npm, PyPI, crates.io or RubyGems) | `unknown`: "version 3.8 of jsonpointer is published on pypi.org (...), but deps.dev has no data for it yet ..."; advisories and malware from osv.dev alone. A whole package deps.dev has never seen but the registry publishes is `unknown` too | the version: allow with the note / deny with the reason. The package: ask (deny with `onError: deny`), since it is hours old. If the registry also answers 404 it is "never published"; if the registry does not answer, deps.dev's 404 stands |
| A host that never answers | timeout after `PINRIGHT_TIMEOUT_MS`; later calls to that host fail at once for 30 s | ask by `PINRIGHT_HOOK_TIMEOUT_MS` at the latest |
| GitHub rate limit | the answer ends with what it is missing and when the limit resets | Actions refs: unverified, `onError` decides |
| jsDelivr 5xx (docs) | fewer docs, and a closing NOTE naming the hosts that failed | not involved |

Every MCP answer and every `check`/`audit`/`upgrade` run ends with a `NOTE: some sources did not
answer: ...` line when an upstream failed while it ran, including failures the tool worked around.
Two cases stop instead: `audit` when OSV does not answer its batch query, and `upgrade` when deps.dev
does not answer. They print `[pinright] fatal: ...` with the host and exit 1, the same code as
findings, so nothing passes; the GitHub Action reports them as exit code 3.
`check-packages` answers within `PINRIGHT_BATCH_TIMEOUT_MS`: packages still pending get an
`ERROR, not checked` row. `pinright doctor` shows which upstreams answer from your machine.

## Latency

The hook runs before every shell command and every manifest or workflow write, so the agent waits
on it. The table below times the hook itself, run as `node dist/cli.js hook claude`, which is what
the global `pinright` binary runs. The launcher in the agent's config adds its own start-up on top
(Windows 11, Node 24.20, npm 11.19, 7 runs after a warm-up, the hook on `npm test`, 2026-11-01):

| Launcher in the agent config | p50 / p95 per hook call |
|---|---|
| `pinright hook claude` (global install: what `init --user` or `--bin` writes) | 157 / 182 ms |
| `npx -y pinright hook claude` (what project files get), with the global install present | 949 / 1,317 ms |
| `npx -y <package>` from npx's cache, no global install (measured with `semver`; npx revalidates the package with the registry on each call) | 1,069 / 1,113 ms |
| the same pinned to its major (`semver@7`), which adds an advisories request | 1,287 / 1,382 ms |
| `node -e 0`, for reference | 84 / 119 ms |

The budget for the hook itself:

| Case | Budget | Measured p50 / p95 |
|---|---|---|
| A command that installs nothing (`npm test`) | under 150 ms above Node's own start | 121 / 177 ms, with `node -e 0` at 88 ms |
| One install, warm cache (`npm i express`) | under 1 s | 358 / 372 ms |
| One install, cold cache | under 5 s | 2.4 / 3.7 s |
| A 15-line `requirements.txt`, warm / cold | under 1 s / under 5 s | 1.0 / 1.5 s and 4.6 / 5.6 s |
| A `package.json` with 30 new dependencies, warm / cold | under 1.5 s / bounded by `PINRIGHT_HOOK_TIMEOUT_MS` | 1.2 / 1.5 s and 10.9 / 15.2 s |
| A workflow with 3 `uses:` lines, warm / cold | under 1 s / under 5 s | 392 / 436 ms and 1.5 / 2.0 s |

Measured with `scripts/latency.ts` (5 runs per cell, Windows, Node 24, no `GITHUB_TOKEN`; with a
token the numbers stay in the same range) against the live services, so the cold column moves with
their load. A new 30-dependency manifest makes about 600 requests the first time: the verdict, the
dependency graph and the supply-chain signals of each package. The hook checks only the lines a
write adds or changes, so editing an existing manifest costs what the changed lines cost.

How it stays there: the hook loads only the command parser until it finds a dependency change; it
fetches the verdict, the dependency graph and the risk signals of a package side by side; it probes
candidate versions a few at a time, newest first; and it skips a host that failed to connect or timed
out for 30 seconds instead of paying one timeout per lookup. `scripts/mcp-latency.ts` measures the
MCP tools the same way.
