# Contributing to pinright

Thanks for taking the time. The most useful thing you can send us is a **false positive**: a
command or file the hook blocked, or a verdict that flagged a package, when it should not have.
Every one of those costs someone an approval click, and it is the fastest way for us to find a
wrong rule. A **false negative** (a bad package that got through) is the second most useful.

Security problems in pinright itself go through private vulnerability reporting, not issues.
See [SECURITY.md](SECURITY.md).

## Reporting a false positive or false negative

Open an issue with the matching template. We need three things to reproduce it:

1. **The exact command or file.** Copy the command the agent ran, or the manifest or workflow it
   wrote (the relevant lines are enough). Shell quoting matters to the hook, so paste it as is.
2. **The client** (Claude Code, Cursor, Codex, ...) and the pinright version (`npx pinright --version`).
3. **The output of `npx pinright doctor --json`**, run in the same project. It shows the Node
   version, which upstreams answered, the policy file in effect and how each client is wired. It
   contains no tokens, but it does show local paths (the cache directory, config files), which
   can include your user name. Edit them out if you prefer.

For a verdict you can also run the check yourself and paste the result:

```bash
npx pinright check npm lodash@4.17.20
npx pinright audit path/to/package-lock.json
```

## Development setup

You need Node 20.9 or newer (CI runs 20, 22 and 24) and git.

```bash
git clone https://github.com/Hiper-AI/pinright.git
cd pinright
npm ci --ignore-scripts
npm run build
npm test
```

The tree needs no install scripts; CI installs with `--ignore-scripts` and so should you.

| Command | What it does |
|---|---|
| `npm test` | Unit tests (vitest), offline, with recorded fixtures under `test/fixtures/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src` and `test` |
| `npm run build` | Compiles to `dist/` |
| `npx tsx scripts/e2e.ts .` | Drives the built server over stdio with a real MCP client (needs network) |
| `npx tsx scripts/docs.ts npm next 16.4.3 "middleware"` | What `get-docs` returns for one question |
| `npm run smoke:clients` | Starts the packed tarball from the config `init` writes for each client |
| `npx tsx scripts/audit.ts package-lock.json` | Whole-tree audit of one file |
| `npx tsx scripts/upgrade.ts npm next 15.5.28 16.4.3 "middleware"` | What `upgrade-guide` returns |
| `npm run bench:agents` | Agent benchmark, see [bench/agents/](bench/agents/) and [docs/benchmark.md](docs/benchmark.md) |
| `npm pack --ignore-scripts --json > pack.json && node scripts/check-pack.mjs pack.json` | What would ship in the tarball |
| `npm run dist:artifacts` | Regenerates `server.json`, the `.mcpb` manifest and the generated blocks in `docs/install.md` |
| `npm run build:mcpb` | Claude Desktop extension into `build/mcpb/` (not published) |
| `npm run bundle:action` | Rebuilds `action-dist/` after a change under `src/` that the Action uses |

A pull request needs `npm run typecheck`, `npm run lint` and `npm test` green. If you touched
`src/clients/` or `package.json`, run `npm run dist:artifacts` too: a test fails while
`server.json` or the generated blocks in `docs/install.md` are stale. If you touched code the GitHub Action
bundles, run `npm run bundle:action` and commit `action-dist/`.

### Testing the hook by hand

The hook reads the agent's hook JSON on stdin and prints its decision. To see what it does with a
command, without wiring a client:

```bash
npm run build
echo '{"tool_name":"Bash","tool_input":{"command":"npm install lodash@4.17.20"},"cwd":"."}' | node dist/cli.js hook claude
```

Each client sends a different shape; the tests in `test/hookAgents.test.ts` have one example per
client.

## Where things live

| Path | What |
|---|---|
| `src/hook/` | The pre-install hook: shell parsing (`command.ts`, `shell.ts`), file writes (`writes.ts`), patches (`applyPatch.ts`), imports (`imports.ts`), policy (`policy.ts`) |
| `src/verdict.ts`, `src/risk/`, `src/typosquat.ts` | The verdict for one package |
| `src/tree/` | Lockfile and manifest parsing, whole-tree audit |
| `src/docs/`, `src/upgrade/` | Docs retrieval and upgrade guides |
| `src/clients/` | What `init` writes for each client |
| `src/untrusted/` | The wrapper around third-party text (see [docs/prompt-injection.md](docs/prompt-injection.md)) |
| `src/safeFetch.ts` | The guard for URLs that come from package metadata |
| `docs/HOOK-THREAT-MODEL.md` | What the hook covers and the bypasses we tried |

## Adding an ecosystem

An ecosystem needs a verdict, a manifest reader and, if the hook should see its installs, a
command reader.

1. Add it to `Ecosystem`, `ECOSYSTEMS` and the deps.dev and OSV name maps in `src/ecosystems.ts`.
   If deps.dev does not index it, list it in `NO_DEPS_DEV` and add a version source the way
   `src/composer/` does for Packagist.
2. Lockfile and manifest parsing: a case in `parseFile` (`src/tree/lockfiles.ts`) and in the audit
   switch in `src/tree/audit.ts`, plus discovery in `src/tree/discover.ts`.
3. Hook: the install commands in `src/hook/command.ts` (`manager`) and manifest writes in
   `src/hook/writes.ts`. Only new or changed dependencies should count.
4. Tests with recorded fixtures: no test may reach the network. Look at `test/composer.test.ts`
   for a complete example.
5. Docs: the "Ecosystems" table in [docs/how-it-works.md](docs/how-it-works.md#ecosystems), and the network table in SECURITY.md if a new host is called.

## Adding a client

Clients live in `CLIENTS` in `src/clients/registry.ts`. Each entry says where the client keeps its
MCP servers and, if it has hooks, how to register ours.

1. Use only paths and shapes from the client's own documentation and put the URLs in `docs`.
   A client whose user-level file is undocumented gets the project file only.
2. If the client has pre-tool hooks, add a `HookAgent` in `src/hook/run.ts` that reads its input
   and writes its answer format. A client without an "ask" answer has to deny with the reason.
3. `init` must keep other entries, comments and indentation, and write a `.pinright.bak` first;
   `src/clients/edit.ts` does that for JSON, JSONC and TOML.
4. Tests in `test/clients.test.ts` (files written) and `test/hookAgents.test.ts` (hook answers).
5. `npm run dist:artifacts` regenerates the client block in `docs/install.md`. Add the client to the
   "Clients" table there by hand.

## Pull requests

- One change per pull request, with a test that fails without it.
- Keep claims in docs to what the code does. pinright checks known advisories and the signals
  the docs list; avoid "secure", "guaranteed" and "100%".
- Pull requests from forks do not run CI automatically: the runner is shared with other projects.
  A maintainer reviews the change and pushes it to a branch here to run CI.
- By contributing you agree that your contribution is licensed under the MIT license of this
  repository.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
