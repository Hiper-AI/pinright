# Hook threat model

The safectx hook reads what a coding agent is about to run or write and stops dependency changes that
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
- A change to the hook's own configuration (`.safectx.json`, the safectx entry or `SAFECTX_*`
  variables in `.claude/settings*.json`, `disableAllHooks`, `.cursor/hooks.json`) always goes to a
  human, whatever the policy says.
- Padding a change with harmless packages does not push a bad one past the check: past 40
  dependencies in one change, the hook asks.
- When deps.dev or OSV cannot answer, a name one edit away from a popular package still asks, even
  with `onError: allow`. The lookalike list ships with safectx, so this check needs no network.

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
| `PowerShell` tool in Claude Code | bypass (not in the matcher) | handled after `safectx init` |
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
| Writing `.safectx.json` (`"allow": ["*"]`), removing the hook from settings, `SAFECTX_ALLOW` in settings `env` | bypass | always asks |
| More than 25 dependencies in one change | bypass (the rest passed with a note) | asks past 40 |
| Registries unreachable or slow (fail-open with `onError: allow`) | bypass | partial: lookalikes, deny list and unverifiable still decide offline |
| A reader crash on a crafted command | fail-open | unverifiable |
| Malformed hook input, hook process crash | fail-open (exit 1) | unchanged: the agent builds the JSON, not the model |
| `python -c`/`node -e` installers, `curl \| sh`, obfuscated commands, MCP tools that run shell | out of scope | out of scope (`curl \| sh` gets a note) |

`test/hookBypass.test.ts` reproduces each row.

## Everyday commands stay silent

The reader runs on every shell command, so false positives cost more than missed corners. These pass
without output and stay in the test suite: `npm test`, `npm run build`, `npm ci`, `pip list`,
`pip freeze > requirements.lock`, `cargo build`, `go test ./...`, `make`, `uv sync`, `pip install -e .`,
`npm i ./packages/local`, `git commit -m "npm i x"`, `grep -rn "npm i" .`. Unverifiable cases need an
install verb or a guarded file, so a variable in an ordinary command does not trigger them.

## Defaults and the trade-offs behind them

| Setting | Default | Trade-off |
|---|---|---|
| `unverifiable` | `ask` | New. A git dependency or a private index asks once per change. Teams that use them set `allow` (or list the names in `allow`); a locked-down repo sets `deny`. |
| `onError` | `allow` | Unchanged. An offline laptop or a deps.dev outage does not stop the work. The cost: on a timeout, only the offline checks run. See the proposal below. |
| `noFix` | `severity` | Unchanged. |
| Per-change limit | 40, then `ask` | Raised from 25. A scaffolded `package.json` with 30 dependencies still gets a full check. |

### Proposal for the default `onError`

For a security tool, `onError: ask` is the safer default: an attacker who can slow the registries
(or a flaky network) cannot turn the hook off. The cost is an approval prompt for every install
while deps.dev or OSV is down. With this round, an outage no longer lets a lookalike name through,
so the remaining exposure is a malicious or vulnerable package with a name nobody would mistake,
installed while the registries do not answer. Recommendation: keep `allow` for the published default,
have `safectx init` write `"onError": "ask"` into the starter `.safectx.json`, and say so in the
README. That decision belongs to the maintainer; this change does not make it.

## Recommendations

- Pair the hook with registry controls you enforce outside the agent: a proxy registry (Artifactory,
  Nexus, Socket, a private npm or PyPI mirror) that blocks malware and typosquats for every client,
  and `npm ci` / `pip install --require-hashes` in CI.
- Run the agent in a container or VM without long-lived credentials. The hook does not limit what an
  allowed package does after install.
- Re-run `safectx init` after upgrading: the matcher for Claude Code now includes `PowerShell` and
  `NotebookEdit`, and existing settings keep the old one.
- Review `.safectx.json` changes in code review like any other policy file.
