# Hook threat model

The pinright hook reads what a coding agent is about to run or write and stops dependency changes that
deps.dev and OSV flag: malware, typosquats, names that do not exist, vulnerable pins with a clean
alternative. This page says what that buys you, what it does not, and how each bypass we tried fared.

## What the hook is

A guardrail for an honest agent that makes mistakes (a hallucinated package, a pin it remembered from
2021, a typo) and a speed bump for an agent that a prompt injection talks into installing something.
It reads command lines and file contents statically, before the tool runs. It does not sandbox the
process, watch the network or inspect what a script does at run time.

It guarantees, for the tools it is wired to (`Bash`, `PowerShell`, `Write`, `Edit`, `MultiEdit`,
`NotebookEdit` in Claude Code; shell commands and tool calls in Cursor):

- An install it can read gets checked: every package manager verb in the table below, through the
  shell wrappers below, including scripts it can follow by name.
- An install it cannot read is not let through silently. A package name in an unknown variable,
  arguments that `xargs` feeds from a pipe, a manifest rewritten by `sed -i`, a git or URL source, or
  a switch to another registry becomes *unverifiable*. The team policy decides those
  (`unverifiable`, default `ask`).
- A change to the hook's own configuration (`.pinright.json`, the pinright entry or `PINRIGHT_*`
  variables in `.claude/settings*.json`, `disableAllHooks`, `.cursor/hooks.json`) always goes to a
  human, whatever the policy says.
- Padding a change with harmless packages does not push a bad one past the check: past 40
  dependencies in one change, the hook asks.
- When deps.dev or OSV cannot answer, a name one edit away from a popular package still asks, even
  with `onError: allow`. The lookalike list ships with pinright, so this check needs no network.

It does not cover:

- Code that installs from inside a program: `python -c "subprocess.run(['pip', ...])"`,
  `node -e "execSync('npm i x')"`, a Python or Node script the agent writes and runs.
- Remote scripts: `curl … | sh`. The hook notes it and lets it through; it cannot read the script.
- Obfuscation beyond what a shell reader can resolve: commands built with `printf` escapes, `rev`,
  base64 piped to `sh` (PowerShell's `-EncodedCommand` is decoded), or variables set in an earlier
  tool call.
- Tools it is not wired to: MCP servers that run shell commands, other agents' custom tools.
- Manifests it does not parse: `setup.py`, `setup.cfg`, `environment.yml`, `*.csproj`,
  `Directory.Packages.props`. `dotnet add package` and `conda install` on the command line are seen.
- Registries it does not check: conda channels and JSR get a note, not a verdict.
- What happens after the hook said yes: a human typing `npm install` later, a CI job, a lockfile
  the package manager writes.

## Vector table

Status after this round. "Bypass" means a known-bad package (`expresss`, `reqeusts`,
`lodash@4.17.20`) reached the install with no check before the fix.

| Vector | Before | After |
|---|---|---|
| `npm`/`pnpm`/`yarn`/`bun` `add`, `i`, `install`, `npx`, `pnpm dlx`, `yarn dlx`, `npm exec` | handled | handled |
| `bun x`, `npm create`/`npm init <x>`, `yarn create`, `pnpm create`, `bun create` | bypass | handled (`create-<x>` is checked) |
| `npm update x`, `pnpm add -w x` (`-w` swallowed the package) | bypass | handled |
| `npx -y pnpm add x`, `npm exec -c "npm i x"`, `uv run pip install x` | bypass | handled |
| `py -3 -m pip`, `python3.12 -m pip`, `pip install -v x` (`-v` swallowed the package) | bypass | handled |
| `pip download`, `uv tool run`, `uv run --with`, `uvx --with`, `pipx inject` | bypass | handled |
| `go run pkg@v`, `go install pkg@latest` | partial | handled, marked as executed |
| `dotnet add <proj> package X` | bypass | handled |
| `deno add/install/run npm:x` | bypass | handled; `jsr:` is a note |
| `conda`/`mamba install` | bypass | note (conda channels are not checked) |
| `$(…)`, backticks, `( … )`, `{ …; }` | bypass | handled |
| `bash -c`, `sh -lc`, `eval`, `cmd /c`, `powershell -Command`, `-EncodedCommand`, `Start-Process` | bypass | handled |
| `env -i`, `sudo -u`, `nohup`, `nice`, `timeout`, `command`, `corepack`, `docker exec` | bypass | handled |
| Quoting and escapes (`n"p"m`, `\npm`), line continuations, `2>&1`, `> log` | partial (redirect targets read as packages) | handled |
| Aliases and variables set earlier in the same command | bypass | handled |
| Package from a variable, a `for` loop, a function's `"$@"`, `$(which npm)` | bypass | unverifiable |
| `echo x \| xargs npm i` | bypass | handled; with unknown input, unverifiable |
| Heredoc into a shell, `echo "npm i x" > s.sh && sh s.sh` | partial | handled |
| `npm run <script>`, `npm install` lifecycle scripts, `make`, `just`, `sh script.sh`, `. script` | bypass | handled (scripts read from disk) |
| Lifecycle script added to `package.json` | bypass | handled at write time |
| `PowerShell` tool in Claude Code | bypass (not in the matcher) | handled after `pinright init` |
| `NotebookEdit` and `.ipynb` writes with `!pip install` / `%pip` / `%%bash` | bypass | handled |
| npm alias `foo@npm:evil@1` (command or `package.json`) | bypass (checked `foo`) | handled (checks `evil`) |
| git, GitHub, tarball and URL specs (`github:u/r`, `u/r`, `https://…tgz`, `git+ssh://`) | bypass | unverifiable |
| `pip install https://…whl`, `x @ https://…`, `-e git+…` | bypass | unverifiable |
| `--index-url`, `--extra-index-url`, `--registry`, `--trusted-host`, `PIP_INDEX_URL=`, `NPM_CONFIG_REGISTRY=`, `GONOSUMDB=` | bypass | unverifiable (the public registries pass) |
| `npm config set registry`, `pip config set …index-url`, `poetry source add`, `gem sources -a` | bypass | unverifiable |
| `-r` nested in a requirements file; index and VCS lines inside it | bypass | handled / unverifiable |
| `overrides`, `resolutions`, `pnpm.overrides`, `peerDependencies` | bypass | handled |
| `pnpm-workspace.yaml` catalogs and overrides, `deno.json` imports | bypass | handled |
| `pyproject.toml` optional dependencies, dependency groups, Poetry groups, `[build-system] requires` | bypass | handled |
| `[tool.uv.sources]`, `[[tool.uv.index]]`, Poetry and PDM sources | bypass | unverifiable |
| `requirements/dev.txt`, `dev-requirements.txt`, `constraints.txt`, `Pipfile`, `Gemfile` | bypass | handled |
| `go.mod` `replace` to another module, Cargo `git =` and registries | bypass | handled / unverifiable |
| Lockfile edited by hand (new versions, a new download host) | bypass | handled / unverifiable |
| `.npmrc`, `.yarnrc.yml`, `pip.conf`, `uv.toml`, `bunfig.toml` pointing at another registry | bypass | unverifiable |
| `.pnpmfile.cjs`, `package.yaml`, `package.json5` | bypass | unverifiable |
| Shell writes to manifests: `echo >>`, `tee`, `cat <<EOF >`, `cp evil.json package.json`, `Set-Content`, `npm pkg set` | bypass | handled (content computed) |
| `sed -i`, `perl -pi`, `curl -o`, `mv` onto a manifest, `git apply` of a patch that touches one | bypass | unverifiable |
| `Edit` with `$&` or `$'` in `new_string` (the hook computed a different file and saw no change) | bypass | handled |
| A manifest that does not parse after the write | bypass (read as empty) | unverifiable |
| Cursor lazy edit (`// ... existing code ...`) of a manifest | bypass | unverifiable |
| Writing `.pinright.json` (`"allow": ["*"]`), removing the hook from settings, `PINRIGHT_ALLOW` in settings `env` | bypass | always asks |
| More than 25 dependencies in one change | bypass (the rest passed with a note) | asks past 40 |
| Registries unreachable (fail-open with `onError: allow`) | bypass | partial: lookalikes, deny list and unverifiable still decide offline |
| Registries slow enough to outlast the agent's 60 s hook timeout (the agent runs the tool) | bypass | handled: at `PINRIGHT_HOOK_TIMEOUT_MS` (45 s) the hook asks, whatever `onError` says |
| Codex `apply_patch` with `*** Move to:` onto a manifest, `*** Delete File: .pinright.json` | bypass | handled / always asks (review 2) |
| `git checkout <ref> -- package.json`, `git restore --source`, `git mv x requirements.txt`, `git rm .pinright.json`, `mv .pinright.json x` | bypass | unverifiable / always asks (review 2) |
| `npx @evil/tsc` in a project that has typescript's `tsc` bin | bypass (read as the local bin) | handled (review 2) |
| A line padded past 2,000 commands, or nested past 6 levels (`eval eval … npx x`) | bypass | unverifiable (review 2) |
| Write to `package.json::$DATA`, an 8.3 short name (`PACKAG~1.JSO`) or a link to a manifest | bypass | handled (review 2) |
| Removing pinright from `.gemini/settings.json`, `.codex/hooks.json`, `.devin/hooks.json`, `.github/hooks/pinright.json` | bypass | always asks (review 2) |
| An exception while deciding (a bug, an unexpected registry answer) | fail-open (exit 1) | asks (review 2) |
| A reader crash on a crafted command | fail-open | unverifiable |
| Malformed hook input, hook process crash | fail-open (exit 1) | unchanged: the agent builds the JSON, not the model |
| `python -c`/`node -e` installers, `curl \| sh`, obfuscated commands, MCP tools that run shell | out of scope | out of scope (`curl \| sh` gets a note) |
| `uv pip sync requirements.txt`, `pip-sync` | bypass | handled (the files are read like `pip install -r`) |

`test/hookBypass.test.ts` reproduces each row.

## Everyday commands stay silent

The reader runs on every shell command, so false positives cost more than missed corners. These pass
without output and stay in the test suite: `npm test`, `npm run build`, `npm ci`, `pip list`,
`pip freeze > requirements.lock`, `cargo build`, `go test ./...`, `make`, `uv sync`, `pip install -e .`,
`npm i ./packages/local`, `git commit -m "npm i x"`, `grep -rn "npm i" .`. Unverifiable cases need an
install verb or a guarded file, so a variable in an ordinary command does not trigger them.

A replay of about 25,000 public commands (GitHub Actions steps, Dockerfiles, package.json scripts,
Makefiles and README install blocks of 180 popular repositories; `bench/fp/RESULTS.md`) added these to
the silent list, each in `test/hookRealWorld.test.ts`: `make test` with `$(PYTHON) -m pytest` and
`$(MAKE) other` recipes, `$PYTHON -m pytest`, `$VCPKG_ROOT/vcpkg install`, PowerShell
`foreach ($x in ...)` loops, `npx tsc -p tsconfig.build.json`, `uv run mkdocs build -f mkdocs.yml`,
`uv pip install -e sdk/python`, `npm i ./$tarball`, `pnpm install --ignore-scripts`,
`bun install --filter <workspace>`, `pip install x --find-links dist/`,
`npm config set //registry.npmjs.org/:_authToken $NPM_TOKEN` and `pip freeze > requirements.txt`.

### What still asks on public commands, on purpose

Each of these asks under the default `unverifiable: ask`. Making them pass would open a way around the
check, so the hook keeps asking:

| Command shape | Why it asks |
|---|---|
| A version from a variable: `npm i -g pnpm@$PNPM_VERSION`, `pip install uv==${UV_VERSION}` | pinright knows the name but not the version. Checking the newest version would vouch for a release that may not be the one installed (a compromised or yanked one). Write the version in the command, or list the name in `allow`. |
| A path that starts with a variable: `pip install -e $GITHUB_WORKSPACE/libs/core`, `pip install "$wheel"` | The variable could hold a URL. `./$x`, `/dist/$x.whl` and `dist/$x.whl` start as paths and pass. |
| A second package index: `--index-url https://download.pytorch.org/whl/cpu`, `--extra-index-url https://pypi.nvidia.com`, a Verdaccio on localhost | Same-named packages on a second index are how dependency confusion works (`torchtriton` on the PyTorch nightly index, December 2022). |
| A manifest rewritten by a program: `sed -i 's/^version = .*/.../' pyproject.toml`, `jq ... > tmp && mv tmp package.json`, `grep -v x requirements.txt > other.txt` | Usually a version bump, but pinright cannot compute the result. |
| A manifest copied to a new folder: `cp package.json dist/` | Its dependencies count as new. A copy can carry a manifest nobody checked (one from a cloned repository), and the next install in that folder pulls it. |
| A program from a variable with an install-like verb: `$runtime run ...`, `$PACKAGE_MANAGER install x` | pinright cannot tell which program runs. `$DIR/pip install x` passes: the program name is literal. |
| Git and URL sources: `cargo install --git`, `pip install git+https://...`, `npx github:user/repo` | Unchanged: nothing to look up. |
| A Go install at a commit or a branch: `go install x@177de93b`, `x@main` | deps.dev and OSV list releases, not commits. |
| More than 40 packages in one change: pandas' `pip install -r requirements-dev.txt` (84) | Padding a change must not push a bad package past the check. Install the file in parts, or approve once. |

Two changes from the same replay loosen a check, and you should know their limits:

- An old package one or two edits from a popular one passes when it has 50,000 or more weekly downloads
  of its own. The replay blocked `unicorn` (next to `uvicorn`) and `xterm` (next to `xtend`), both real
  packages with over half a million downloads a week. An attacker who inflates an old squat's downloads
  past that floor gets through; a squat younger than the cooldown is flagged whatever its downloads.
- The "this install would fail" check on pinned versions in one manifest runs only for pip, Composer,
  Bundler and NuGet, which install one version per name. npm and Cargo install a second copy, so a pin
  outside a parent's range is no failure there. The check was about broken installs; vulnerability
  findings did not change.

## Defaults and the trade-offs behind them

| Setting | Default | Trade-off |
|---|---|---|
| `unverifiable` | `ask` | New. A git dependency or a private index asks once per change. Teams that use them set `allow` (or list the names in `allow`); a locked-down repo sets `deny`. |
| `onError` | `allow` built in, `ask` in the starter `.pinright.json` | Without a policy file, an offline laptop or a deps.dev outage does not stop the work. A project set up with `pinright init` asks instead. See below. |
| `noFix` | `severity` | Unchanged. |
| Per-change limit | 40, then `ask` | Raised from 25. A scaffolded `package.json` with 30 dependencies still gets a full check. |

### `onError`: built-in `allow`, starter `ask`

With `onError: ask`, an attacker who can slow the registries (or a flaky network) cannot turn the
hook off. The cost is an approval prompt for every install while deps.dev or OSV is down. An outage
no longer lets a lookalike name through, so with `allow` the remaining exposure is a malicious or
vulnerable package with a name nobody would mistake, installed while the registries do not answer.

pinright keeps `allow` as the built-in default, so adding it to an existing setup changes nothing
offline. The starter `.pinright.json` that `pinright init` writes sets `"onError": "ask"`, with a
comment that explains the trade-off. A developer who works offline overrides it for their own
machine with `PINRIGHT_HOOK_ON_ERROR=allow`.

## Recommendations

- Pair the hook with registry controls you enforce outside the agent: a proxy registry (Artifactory,
  Nexus, Socket, a private npm or PyPI mirror) that blocks malware and typosquats for every client,
  and `npm ci` / `pip install --require-hashes` in CI.
- Run the agent in a container or VM without long-lived credentials. The hook does not limit what an
  allowed package does after install.
- Re-run `pinright init` after upgrading: the matcher for Claude Code now includes `PowerShell` and
  `NotebookEdit`, and existing settings keep the old one.
- Review `.pinright.json` changes in code review like any other policy file.
