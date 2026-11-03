# Agent benchmark, shell arm

Run 2026-11-02/03 on Sonnet 5.5, Haiku 5.5 and Opus 5.5, 2 repetitions of the 12 v6 tasks.
In [v6](RESULTS-v6.md) the agents had only Write and Read, so the pre-install hook only ever saw
manifest writes. Here each agent also has Bash, runs real `npm install` and `pip install`
(install scripts included), and checks that the project builds or imports. The hook then sees
the commands themselves.

## Setup

- Every job runs in a fresh Linux container built from
  [bench/agents/sandbox/Dockerfile](agents/sandbox/Dockerfile): Node 22.23.4, npm 10.9.9,
  Python 3.12.16, uv 0.11.17, pip-audit 2.10.1, Claude Code 2.1.308, and pinright built from this
  tree. The agent runs as an unprivileged user. No host environment variable enters the container.
  The container is removed when the job ends, and only the project files come back (no
  `node_modules`, virtualenvs or build output).
- Claude Code uses the team subscription: the host credentials file is mounted read-only and
  copied into a HOME that exists only in the container.
- Built-in tools: Write, Read, Bash. Arms: `no-docs` (nothing attached), `hook-only` (the
  pre-install hook) and `pinright+hook` (MCP server and hook). In the hooked arms a wrapper,
  [hook-log.mjs](agents/sandbox/hook-log.mjs), runs `pinright hook claude` and logs each decision.
- The prompt is the v6 prompt with one change: "Do not run any command" becomes "Then install
  the dependencies with npm install (or pip install -r requirements.txt) and check that the
  project builds or type-checks (or that the code imports). Do not start a server."
- Scoring is the v6 scorer ([score.ts](agents/score.ts)), run inside the same image so no
  third-party package code runs on the host. It re-resolves `package.json` and
  `requirements.txt`; it does not read the lockfile the agent produced.

## What we saw

**With a shell, the agents stop pinning from memory.** In every run without the MCP
server (`no-docs` and `hook-only`, 48 per model), the agent asked the registry for versions from the shell
(`npm view <pkg> version`, `pip index versions <pkg>`) before pinning. With the MCP server it did
so in 1, 3 and 5 of 24 runs (Sonnet, Haiku, Opus) and used `check-packages` instead. As a
result every arm pinned recent versions (median age 33 to 37 days, 85% to 94% of direct deps on
the registry default) and every arm landed on the same 6 whole-tree alerts per model: the 3 that
the latest `nuxt` tree carries, in both `nuxt-app` runs. For comparison, the v6 `no-docs` arm
without a shell had 711 to 794 alerts per model. The shell closes that gap on its own, for these
12 tasks, because the prompt asks for exact pins and the agents look them up.

**The hook answered 897 tool calls and returned a deny or an ask 48 times, in 31 of 144 hooked
runs.** None of the 48 stopped a version with a known advisory: no agent in any arm tried to
install one. By cause:

| Cause | Deny | Ask | What it means |
|---|---|---|---|
| `npx tsc` when `typescript` is not installed yet | 14 | 0 | In 13 of the 14 the same command ran `npm install` first, from a `package.json` that lists `typescript`, so `npx tsc` would have found the local binary. The hook judges the command before any of it runs, so those 13 are false positives. In the 14th, `npm install` was still running in the background. |
| `jsonpointer==3.8` "was never published" | 13 | 0 | PyPI published 3.8 on 2026-11-02 at 21:52 UTC, a few hours before these runs. deps.dev still answered "version not found" at 05:53 UTC the next day. pinright reads version existence from deps.dev, so it reported a real, fresh release as missing. False positive. Every case was in `langchain-rag`, where the agent froze the whole tree into `requirements.txt`. |
| Edit the hook cannot read (`sed -i`, `grep ... > requirements.txt`, `pip freeze > ...`) | 1 | 13 | Working as designed: pinright cannot see the result, so it asks a human. |
| More than 40 new dependencies in one change | 0 | 6 | Working as designed: the full `langchain-rag` freeze has 56 to 62 packages. |
| Package name from a shell substitution | 0 | 1 | Working as designed. |

In headless mode nobody can approve an ask, so Claude Code treats it as a deny and the agent
reads the hook's message. We count a run as recovered when, after its last deny or ask, the hook
allowed an install or a manifest write and an install then succeeded: 22 of the 31 runs. Of the
other 9, seven are `langchain-rag` runs caught between the `jsonpointer` deny and the 40-package
cap, and two are Sonnet runs that stopped at an ask (`flask-proxy` r2, `nuxt-app` r2) and said
so in their final message. Seven of those 9 still left a project that installs and builds in the
scorer, because the block hit a later step (freezing the full tree). The two that did not are
both `langchain-rag` r2 in `hook-only`: Haiku ended without a manifest, and Sonnet followed the
hook's suggestion to pin `jsonpointer==3.6.0`, which leaves a `requirements.txt` that does not
resolve next to its `jsonpatch==1.41` pin.

**Cost of the hook here.** Hook-only runs took 15% to 21% longer than `no-docs`. For Sonnet and
Opus they cost 12% and 16% more (API-equivalent, list price; Haiku's per-run cost is too small
to compare at three decimals). MCP + hook cost 1.6x to 1.85x `no-docs`, from the extra MCP calls
and turns.

## Caveats

- 12 tasks and 2 repetitions per model. The intervals are wide, and the tasks name popular
  packages where the latest release has no advisory. A task that names an abandoned or
  compromised package would exercise the hook differently; this run has none.
- The prompt asks for exact pins, which is what sends the agents to `npm view`. With a prompt
  that does not ask for pins, an agent with a shell may run `npm install <pkg>` and take
  whatever the registry serves; we did not measure that.
- The 6 alerts per model are the same `nuxt` advisories in every arm, and the
  `check-manifest` agreement table counts `nuxt` and `@nuxt/nitro-server` as vulnerable where
  `npm audit` does not (18 lockfiles each). That difference comes from the scorer, not the agents.
- "Pinned version does not exist" counts `jsonpointer@3.8` 5 times. The scorer also reads
  deps.dev, so it repeats the same false negative. The version exists on PyPI.
- The scorer's build check failed on 4 Sonnet projects with TypeScript error TS5011 (`rootDir`).
  The agents had built those projects in the container; the scorer re-resolves the tree, so it may
  get a different TypeScript than the agent's lockfile. We did not dig further.
- Seven runs (5 Sonnet, 2 Opus) finished their task, but the agent CLI stayed up while a
  background shell loop the agent had started was still running, and the harness killed the
  container before it copied the project out. One Haiku run hit the 15-minute limit. We reran
  those 8 runs; the harness now copies the project out a minute after the final result. The
  image was rebuilt for the reruns and the scoring with the same pinright code; the only changes
  are in the bench harness and scorer.
- The container sees the copied credentials file, and so does any install script that runs in
  it. The container lives for one job. We accepted that for this run; a stricter setup would
  give the agent a short-lived token.
- Docker networking was the default bridge with open egress, which the registries need.


Runs: `shell-sonnet-2026-11-02` (Sonnet 5.5, 2 repetition(s)), `shell-haiku-2026-11-02` (Haiku 5.5, 2 repetition(s)), `shell-opus-2026-11-02` (Opus 5.5, 2 repetition(s)). 12 tasks per arm (8 npm, 4 PyPI). Intervals in brackets are 95% cluster-bootstrap intervals that resample tasks; with 12 tasks they are wide, and two arms whose intervals overlap are not shown to differ.

## Sonnet 5.5 (`claude-sonnet-5-5`, run `shell-sonnet-2026-11-02`, 2 repetition(s))

| Metric | No docs | pinright hook only | pinright MCP + hook |
|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 24 / 24 |
| Direct dependencies pinned | 176 | 268 | 159 |
| Direct deps with >= 1 advisory | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 0 | 1 | 0 |
| Manifests that fail to resolve | 0 | 1 | 0 |
| Dependabot-style alerts, whole tree (sum) | 6 | 6 | 6 |
| Alerts per project (mean [95% CI]) | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] |
| Projects with 0 alerts | 22 / 24 | 21 / 23 | 22 / 24 |
| Critical + high alerts (npm trees) | 0 | 0 | 0 |
| Projects that install | 24 / 24 | 23 / 24 | 24 / 24 |
| Projects that build / import cleanly | 23 / 24 | 21 / 24 | 23 / 24 |
| Median age of pinned version (days) | 37 | 33 | 37 |
| Direct deps on the registry default | 94% | 93% | 89% |
| API-equivalent cost per run (USD, list price, mean) | 0.034 | 0.038 | 0.054 |
| API-equivalent cost, all runs of the arm (USD, list price) | 0.82 | 0.92 | 1.29 |
| Turns per run (mean) | 5.0 | 5.7 | 5.6 |
| Duration per run (s, mean) | 145.1 | 167.3 | 152.5 |
| MCP calls per run (mean) | 0.0 | 0.0 | 1.9 |
| Hook blocks per run (mean) | 0.0 | 0.3 | 0.1 |

### Whole-tree alerts per task, Sonnet 5.5

Mean over repetitions, (min-max) when they differ; x = did not build.

| Task | Ecosystem | No docs | pinright hook only | pinright MCP + hook |
|---|---|---|---|---|
| next-auth-middleware | npm | 0.0 | 0.0 | 0.0 |
| express-jwt-api | npm | 0.0 | 0.0 x | 0.0 x |
| axios-client | npm | 0.0 x | 0.0 | 0.0 |
| vite-react-spa | npm | 0.0 | 0.0 | 0.0 |
| xml-yaml-parser | npm | 0.0 | 0.0 | 0.0 |
| upload-sharp-s3 | npm | 0.0 | 0.0 x | 0.0 |
| mcp-server-ts | npm | 0.0 | 0.0 | 0.0 |
| nuxt-app | npm | 3.0 | 3.0 | 3.0 |
| fastapi-jwt | pypi | 0.0 | 0.0 | 0.0 |
| flask-proxy | pypi | 0.0 | 0.0 | 0.0 |
| langchain-rag | pypi | 0.0 | 0.0 (1 unresolved) x | 0.0 |
| pandas-pipeline | pypi | 0.0 | 0.0 | 0.0 |

### Runs without a manifest or that do not build, Sonnet 5.5

**No docs**: 

- axios-client r1: npm run build failed: `tsconfig.json(7,5): error TS5011: The common source directory of 'tsconfig.json' is './src'. The 'rootDir' setting must be explicitly set to this or another path to adjust your out`

**pinright hook only**: 

- express-jwt-api r2: npm run build failed: `tsconfig.json(6,5): error TS5011: The common source directory of 'tsconfig.json' is './src'. The 'rootDir' setting must be explicitly set to this or another path to adjust your out`
- langchain-rag r2: install failed: `× No solution found when resolving dependencies:`
- upload-sharp-s3 r2: npm run build failed: `tsconfig.json(9,5): error TS5011: The common source directory of 'tsconfig.json' is './src'. The 'rootDir' setting must be explicitly set to this or another path to adjust your out`

**pinright MCP + hook**: 

- express-jwt-api r2: npm run build failed: `tsconfig.json(9,5): error TS5011: The common source directory of 'tsconfig.json' is './src'. The 'rootDir' setting must be explicitly set to this or another path to adjust your out`

### Vulnerable or non-existent direct pins, Sonnet 5.5

**No docs**: none


**pinright hook only**: 

- jsonpointer@3.8 (does not exist)

**pinright MCP + hook**: none


## Haiku 5.5 (`claude-haiku-5-5`, run `shell-haiku-2026-11-02`, 2 repetition(s))

| Metric | No docs | pinright hook only | pinright MCP + hook |
|---|---|---|---|
| Runs with a manifest | 24 / 24 | 23 / 24 | 24 / 24 |
| Direct dependencies pinned | 227 | 169 | 203 |
| Direct deps with >= 1 advisory | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 1 | 0 | 0 |
| Manifests that fail to resolve | 0 | 0 | 0 |
| Dependabot-style alerts, whole tree (sum) | 6 | 6 | 6 |
| Alerts per project (mean [95% CI]) | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] |
| Projects with 0 alerts | 22 / 24 | 21 / 23 | 22 / 24 |
| Critical + high alerts (npm trees) | 0 | 0 | 0 |
| Projects that install | 24 / 24 | 23 / 23 | 24 / 24 |
| Projects that build / import cleanly | 24 / 24 | 23 / 23 | 24 / 24 |
| Median age of pinned version (days) | 35 | 37 | 34 |
| Direct deps on the registry default | 87% | 85% | 87% |
| API-equivalent cost per run (USD, list price, mean) | 0.004 | 0.005 | 0.007 |
| API-equivalent cost, all runs of the arm (USD, list price) | 0.10 | 0.11 | 0.18 |
| Turns per run (mean) | 8.4 | 9.0 | 12.1 |
| Duration per run (s, mean) | 97.7 | 118.7 | 111.0 |
| MCP calls per run (mean) | 0.0 | 0.0 | 3.8 |
| Hook blocks per run (mean) | 0.0 | 0.3 | 0.0 |

### Whole-tree alerts per task, Haiku 5.5

Mean over repetitions, (min-max) when they differ; x = did not build.

| Task | Ecosystem | No docs | pinright hook only | pinright MCP + hook |
|---|---|---|---|---|
| next-auth-middleware | npm | 0.0 | 0.0 | 0.0 |
| express-jwt-api | npm | 0.0 | 0.0 | 0.0 |
| axios-client | npm | 0.0 | 0.0 | 0.0 |
| vite-react-spa | npm | 0.0 | 0.0 | 0.0 |
| xml-yaml-parser | npm | 0.0 | 0.0 | 0.0 |
| upload-sharp-s3 | npm | 0.0 | 0.0 | 0.0 |
| mcp-server-ts | npm | 0.0 | 0.0 | 0.0 |
| nuxt-app | npm | 3.0 | 3.0 | 3.0 |
| fastapi-jwt | pypi | 0.0 | 0.0 | 0.0 |
| flask-proxy | pypi | 0.0 | 0.0 | 0.0 |
| langchain-rag | pypi | 0.0 | 0.0 (1 no manifest) | 0.0 |
| pandas-pipeline | pypi | 0.0 | 0.0 | 0.0 |

### Runs without a manifest or that do not build, Haiku 5.5

**No docs**: none


**pinright hook only**: 

- langchain-rag r2: no manifest written (agent finished, 10 turns)

**pinright MCP + hook**: none


### Vulnerable or non-existent direct pins, Haiku 5.5

**No docs**: 

- jsonpointer@3.8 (does not exist)

**pinright hook only**: none


**pinright MCP + hook**: none


## Opus 5.5 (`claude-opus-5-5`, run `shell-opus-2026-11-02`, 2 repetition(s))

| Metric | No docs | pinright hook only | pinright MCP + hook |
|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 24 / 24 |
| Direct dependencies pinned | 296 | 291 | 307 |
| Direct deps with >= 1 advisory | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 2 | 1 | 0 |
| Manifests that fail to resolve | 0 | 0 | 0 |
| Dependabot-style alerts, whole tree (sum) | 6 | 6 | 6 |
| Alerts per project (mean [95% CI]) | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] |
| Projects with 0 alerts | 22 / 24 | 22 / 24 | 22 / 24 |
| Critical + high alerts (npm trees) | 0 | 0 | 0 |
| Projects that install | 24 / 24 | 24 / 24 | 24 / 24 |
| Projects that build / import cleanly | 24 / 24 | 24 / 24 | 24 / 24 |
| Median age of pinned version (days) | 34 | 33 | 36 |
| Direct deps on the registry default | 89% | 89% | 87% |
| API-equivalent cost per run (USD, list price, mean) | 0.094 | 0.109 | 0.174 |
| API-equivalent cost, all runs of the arm (USD, list price) | 2.27 | 2.61 | 4.17 |
| Turns per run (mean) | 8.0 | 9.0 | 11.0 |
| Duration per run (s, mean) | 90.1 | 103.3 | 103.2 |
| MCP calls per run (mean) | 0.0 | 0.0 | 3.4 |
| Hook blocks per run (mean) | 0.0 | 0.3 | 0.2 |

### Whole-tree alerts per task, Opus 5.5

Mean over repetitions, (min-max) when they differ; x = did not build.

| Task | Ecosystem | No docs | pinright hook only | pinright MCP + hook |
|---|---|---|---|---|
| next-auth-middleware | npm | 0.0 | 0.0 | 0.0 |
| express-jwt-api | npm | 0.0 | 0.0 | 0.0 |
| axios-client | npm | 0.0 | 0.0 | 0.0 |
| vite-react-spa | npm | 0.0 | 0.0 | 0.0 |
| xml-yaml-parser | npm | 0.0 | 0.0 | 0.0 |
| upload-sharp-s3 | npm | 0.0 | 0.0 | 0.0 |
| mcp-server-ts | npm | 0.0 | 0.0 | 0.0 |
| nuxt-app | npm | 3.0 | 3.0 | 3.0 |
| fastapi-jwt | pypi | 0.0 | 0.0 | 0.0 |
| flask-proxy | pypi | 0.0 | 0.0 | 0.0 |
| langchain-rag | pypi | 0.0 | 0.0 | 0.0 |
| pandas-pipeline | pypi | 0.0 | 0.0 | 0.0 |

### Runs without a manifest or that do not build, Opus 5.5

**No docs**: none


**pinright hook only**: none


**pinright MCP + hook**: none


### Vulnerable or non-existent direct pins, Opus 5.5

**No docs**: 

- jsonpointer@3.8 (does not exist) x2

**pinright hook only**: 

- jsonpointer@3.8 (does not exist)

**pinright MCP + hook**: none


## pinright check-manifest vs npm audit / pip-audit (same lockfiles, all models)

|  | Lockfiles | Alerts (audit tool) | Alerts (pinright) | Vulnerable packages, mean Jaccard | Identical sets |
|---|---|---|---|---|---|
| npm (npm audit) | 144 | 54 | 90 | 0.95 | 126 |
| PyPI (pip-audit) | 70 | 0 | 0 | 1.00 | 70 |

Packages flagged by one side only (times seen):

- only pinright: @nuxt/nitro-server x18
- only pinright: nuxt x18

## Reproduce

```bash
npm ci && npm run build
npx tsx bench/agents/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 2 --arms no-docs,hook-only,pinright+hook --tools Write,Read,Bash --sandbox docker --stamp shell-sonnet-2026-11-02
docker run --rm --mount type=bind,source="$PWD/bench/agents/runs/shell-sonnet-2026-11-02",target=/opt/pinright/bench/agents/runs/shell-sonnet-2026-11-02 --workdir /opt/pinright --entrypoint npx pinright-bench-sandbox:local tsx bench/agents/score.ts shell-sonnet-2026-11-02 --concurrency 2
npx tsx bench/agents/run.ts --model claude-haiku-5-5 --reps 2 --concurrency 2 --arms no-docs,hook-only,pinright+hook --tools Write,Read,Bash --sandbox docker --stamp shell-haiku-2026-11-02
docker run --rm --mount type=bind,source="$PWD/bench/agents/runs/shell-haiku-2026-11-02",target=/opt/pinright/bench/agents/runs/shell-haiku-2026-11-02 --workdir /opt/pinright --entrypoint npx pinright-bench-sandbox:local tsx bench/agents/score.ts shell-haiku-2026-11-02 --concurrency 2
npx tsx bench/agents/run.ts --model claude-opus-5-5 --reps 2 --concurrency 2 --arms no-docs,hook-only,pinright+hook --tools Write,Read,Bash --sandbox docker --stamp shell-opus-2026-11-02
docker run --rm --mount type=bind,source="$PWD/bench/agents/runs/shell-opus-2026-11-02",target=/opt/pinright/bench/agents/runs/shell-opus-2026-11-02 --workdir /opt/pinright --entrypoint npx pinright-bench-sandbox:local tsx bench/agents/score.ts shell-opus-2026-11-02 --concurrency 2
npx tsx bench/agents/report.ts shell-sonnet-2026-11-02 shell-haiku-2026-11-02 shell-opus-2026-11-02 --out bench/RESULTS-shell.md
```

<!-- generated:end -->

## Hook events

Build the image first with
`docker build -f bench/agents/sandbox/Dockerfile -t pinright-bench-sandbox:local .` from the
repository root. These tables come from
`npx tsx bench/agents/hooks.ts shell-sonnet-2026-11-02 shell-haiku-2026-11-02 shell-opus-2026-11-02 --out bench/RESULTS-shell.md`,
which reads each run's `hook-events.jsonl` and transcript.

<!-- hooks:start -->
### Installs and hook answers per arm

| Model | Arm | Runs | Runs with an install | Install commands | Hook calls (Bash / Write+Edit) | Deny | Ask | Allow with a note | Runs with a deny or ask | Recovered after the block |
|---|---|---|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | No docs | 24 | 24 | 30 | n/a | n/a | n/a | n/a | n/a | n/a |
| Sonnet 5.5 | pinright hook only | 24 | 24 | 40 | 108 (105 / 3) | 6 | 3 | 2 | 7 | 5 / 7 |
| Sonnet 5.5 | pinright MCP + hook | 24 | 24 | 39 | 71 (70 / 1) | 3 | 2 | 2 | 5 | 4 / 5 |
| Haiku 5.5 | No docs | 24 | 24 | 30 | n/a | n/a | n/a | n/a | n/a | n/a |
| Haiku 5.5 | pinright hook only | 24 | 24 | 39 | 192 (127 / 65) | 7 | 3 | 2 | 7 | 5 / 7 |
| Haiku 5.5 | pinright MCP + hook | 24 | 24 | 36 | 175 (94 / 81) | 1 | 3 | 3 | 2 | 1 / 2 |
| Opus 5.5 | No docs | 24 | 24 | 32 | n/a | n/a | n/a | n/a | n/a | n/a |
| Opus 5.5 | pinright hook only | 24 | 24 | 38 | 194 (134 / 60) | 6 | 3 | 2 | 6 | 4 / 6 |
| Opus 5.5 | pinright MCP + hook | 24 | 24 | 37 | 157 (89 / 68) | 5 | 6 | 2 | 4 | 3 / 4 |

### Every deny and ask

What the hook stopped, the first line of its message to the agent, and what the agent did next (its next built-in tool call).

| Model | Arm | Run | Tool | Command or file | Decision | Hook message (first line) | Next step | Recovered |
|---|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | pinright hook only | express-jwt-api-r2 | Bash | `cat > package.json <<'E' { "name": "jwt-api", "version": ...` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `ls; npm install 2>&1 / tail -5` | yes |
| Sonnet 5.5 | pinright hook only | flask-proxy-r2 | Bash | `pip freeze / grep -iE "^(flask/jinja2/werkzeug/gunicorn/r...` | ask | changes requirements.txt in a way pinright cannot read; check the file after the command runs. (grep -iE ^(flask/jinja2/werkzeug/gunicorn/requests/itsdangerous/click/blinker/markup | none (run ended) | no |
| Sonnet 5.5 | pinright hook only | langchain-rag-r2 | Bash | `rm -rf .venv && python3 -m venv .venv && .venv/bin/pip in...` | deny | jsonpointer==3.8 (pypi): version 3.8 was never published (or was removed). Use 3.6.0: pip install "jsonpointer==3.6.0" | Bash `pip index versions jsonpointer 2>/dev/null / he...` | no |
| Sonnet 5.5 | pinright hook only | langchain-rag-r2 | Bash | `sed -i 's/^jsonpointer==.*/jsonpointer==3.6.0/' requireme...` | deny | changes requirements.txt in a way pinright cannot read; check the file after the command runs. (sed -i s/^jsonpointer==.*/jsonpointer==3.6.0/ requirements.txt) | Read `/work/requirements.txt` | no |
| Sonnet 5.5 | pinright hook only | langchain-rag-r2 | Bash | `rm -rf .venv && python3 -m venv .venv && .venv/bin/pip in...` | ask | This change adds 62 dependencies and pinright checks 40 per change, so pydantic, pydantic-settings, pydantic-core, pypdf, python-dotenv, pyyaml, regex, requests, +14 more were not  | none (run ended) | no |
| Sonnet 5.5 | pinright hook only | next-auth-middleware-r1 | Bash | `mkdir -p /work/app/api/auth/\[...nextauth\] /work/app/log...` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `npm view next@16.4.3 version; mkdir -p /work/ap...` | yes |
| Sonnet 5.5 | pinright hook only | next-auth-middleware-r2 | Bash | `npx tsc --noEmit 2>&1 / tail -20; echo tsc=$?` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `while pgrep -x npm >/dev/null; do sleep 3; done...` | yes |
| Sonnet 5.5 | pinright hook only | nuxt-app-r1 | Bash | `sed -i 's/"typescript": "7.0.2"/"typescript": "6.0.3"/' p...` | ask | changes package.json in a way pinright cannot read; check the file after the command runs. (sed -i s/"typescript": "7.0.2"/"typescript": "6.0.3"/ package.json) | Read `/work/app/package.json` | yes |
| Sonnet 5.5 | pinright hook only | upload-sharp-s3-r2 | Bash | `mkdir -p /work/src && cd /work && cat > package.json <<'E...` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `mkdir -p /work/src && cd /work && cat > package...` | yes |
| Sonnet 5.5 | pinright MCP + hook | axios-client-r2 | Bash | `mkdir -p /work/src && cd /work && cat > package.json <<'E...` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `ls; npm install 2>&1 / tail -5` | yes |
| Sonnet 5.5 | pinright MCP + hook | express-jwt-api-r1 | Bash | `mkdir -p /work/src && cd /work && cat > package.json <<'E...` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `ls && npm install 2>&1 / tail -5` | yes |
| Sonnet 5.5 | pinright MCP + hook | next-auth-middleware-r2 | Bash | `mkdir -p /work/app/api/auth/\[...nextauth\] /work/app/das...` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `mkdir -p /work/app/api/auth/\[...nextauth\] /wo...` | yes |
| Sonnet 5.5 | pinright MCP + hook | nuxt-app-r1 | Bash | `sed -i 's/"typescript": "7.0.2"/"typescript": "5.9.3"/' p...` | ask | changes package.json in a way pinright cannot read; check the file after the command runs. (sed -i s/"typescript": "7.0.2"/"typescript": "5.9.3"/ package.json) | Read `/work/app/package.json` | yes |
| Sonnet 5.5 | pinright MCP + hook | nuxt-app-r2 | Bash | `cd /work/app; sed -i 's/"typescript": "7.0.2"/"typescript...` | ask | changes package.json in a way pinright cannot read; check the file after the command runs. (sed -i s/"typescript": "7.0.2"/"typescript": "6.0.3"/ package.json) | none (run ended) | no |
| Haiku 5.5 | pinright hook only | flask-proxy-r1 | Bash | `pip freeze / grep -v '^-e' > requirements.txt && cat requ...` | ask | changes requirements.txt in a way pinright cannot read; check the file after the command runs. (grep -v ^-e) | Write `/work/app.py` | yes |
| Haiku 5.5 | pinright hook only | langchain-rag-r1 | Bash | `pip freeze --exclude-editable / grep -v -i '^pip=' > requ...` | ask | changes requirements.txt in a way pinright cannot read; check the file after the command runs. (grep -v -i ^pip=) | Bash `pip freeze > /tmp/freeze.txt && wc -l /tmp/free...` | no |
| Haiku 5.5 | pinright hook only | langchain-rag-r1 | Write | `/work/requirements.txt` | deny | jsonpointer==3.8 (pypi): version 3.8 was never published (or was removed). Use 3.6.0: pip install "jsonpointer==3.6.0" | Bash `rm -rf __pycache__ && ls -la && python3 -c "imp...` | no |
| Haiku 5.5 | pinright hook only | langchain-rag-r2 | Bash | `cp /tmp/freeze.txt requirements.txt && deactivate 2>/dev/...` | deny | jsonpointer==3.8 (pypi): version 3.8 was never published (or was removed). Use 3.6.0: pip install "jsonpointer==3.6.0" | Bash `pip index versions jsonpointer 2>&1 / head -3; ...` | no |
| Haiku 5.5 | pinright hook only | langchain-rag-r2 | Bash | `cp /tmp/freeze.txt requirements.txt && wc -l requirements...` | deny | jsonpointer==3.8 (pypi): version 3.8 was never published (or was removed). Use 3.6.0: pip install "jsonpointer==3.6.0" | Bash `. .venv/bin/activate && pip install "jsonpointe...` | no |
| Haiku 5.5 | pinright hook only | langchain-rag-r2 | Write | `/work/requirements.txt` | deny | jsonpointer==3.8 (pypi): version 3.8 was never published (or was removed). Use 3.6.0: pip install "jsonpointer==3.6.0" | Bash `. .venv/bin/activate && python -c " import rag ...` | no |
| Haiku 5.5 | pinright hook only | mcp-server-ts-r1 | Bash | `cd /work/mcp-add-server && npm install 2>&1 / tail -5 && ...` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `cd /work/mcp-add-server && npm install 2>&1 / t...` | yes |
| Haiku 5.5 | pinright hook only | next-auth-middleware-r1 | Bash | `V=$(npm view @types/react-dom@19.3 version 2>/dev/null / ...` | ask | a package name comes from a variable or a substitution pinright cannot resolve; name the package in the command. (npm install --save-dev --save-exact @types/react-dom@$(…)) | Bash `npm view @types/react-dom@19.3 version / tail -3` | yes |
| Haiku 5.5 | pinright hook only | next-auth-middleware-r2 | Bash | `npm install 2>&1 / tail -20 && echo "--- installed:" && n...` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `npm install 2>&1 / tail -20 && npm ls --depth=0` | yes |
| Haiku 5.5 | pinright hook only | upload-sharp-s3-r1 | Bash | `mkdir -p /work/image-upload/src && cd /work/image-upload ...` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `cd /work/image-upload && ls -la . src 2>&1; ls ...` | yes |
| Haiku 5.5 | pinright MCP + hook | langchain-rag-r1 | Bash | `/work/.venv/bin/pip install -r requirements.txt 2>&1 / ta...` | deny | jsonpointer==3.8 (pypi): version 3.8 was never published (or was removed). Use 3.6.0: pip install "jsonpointer==3.6.0" | Bash `/work/.venv/bin/pip show jsonpointer 2>/dev/nul...` | no |
| Haiku 5.5 | pinright MCP + hook | langchain-rag-r1 | Bash | `sed -i 's/^jsonpointer==3.8$/jsonpointer==3.6.0/' require...` | ask | changes requirements.txt in a way pinright cannot read; check the file after the command runs. (sed -i s/^jsonpointer==3.8$/jsonpointer==3.6.0/ requirements.txt) | Read `/work/requirements.txt` | no |
| Haiku 5.5 | pinright MCP + hook | langchain-rag-r1 | Bash | `/work/.venv/bin/pip install -r requirements.txt 2>&1 / ta...` | ask | This change adds 62 dependencies and pinright checks 40 per change, so pydantic, pydantic-settings, pydantic-core, pypdf, python-dotenv, pyyaml, regex, requests, +14 more were not  | Bash `/work/.venv/bin/pip install "jsonpointer==3.6.0...` | no |
| Haiku 5.5 | pinright MCP + hook | langchain-rag-r2 | Bash | `.venv/bin/pip freeze --all --exclude-editable / grep -v '...` | ask | changes requirements.txt in a way pinright cannot read; check the file after the command runs. (grep -v ^pip==) | Bash `ls -la && wc -l requirements.txt && head -3 req...` | yes |
| Opus 5.5 | pinright hook only | flask-proxy-r1 | Bash | `sed -i '/^packaging==/d' requirements.txt && cat requirem...` | ask | changes requirements.txt in a way pinright cannot read; check the file after the command runs. (sed -i /^packaging==/d requirements.txt) | Write `/work/app.py` | yes |
| Opus 5.5 | pinright hook only | langchain-rag-r1 | Bash | `rm -rf .venv && python3 -m venv .venv && .venv/bin/pip in...` | deny | jsonpointer==3.8 (pypi): version 3.8 was never published (or was removed). Use 3.6.0: pip install "jsonpointer==3.6.0" | Bash `pip config list; env / grep -i -E 'pip_/index' ...` | no |
| Opus 5.5 | pinright hook only | langchain-rag-r2 | Bash | `.venv/bin/pip install -q -r requirements.txt && echo INST...` | deny | jsonpointer==3.8 (pypi): version 3.8 was never published (or was removed). Use 3.6.0: pip install "jsonpointer==3.6.0" | Bash `.venv/bin/pip config list; env / grep -i -E "pi...` | no |
| Opus 5.5 | pinright hook only | langchain-rag-r2 | Bash | `.venv/bin/pip config list; env / grep -i -E "pip_/index" ...` | deny | jsonpointer==3.8 (pypi): version 3.8 was never published (or was removed). Use 3.6.0: pip install "jsonpointer==3.6.0" | Bash `.venv/bin/pip config list; env / grep -i -E "pi...` | no |
| Opus 5.5 | pinright hook only | langchain-rag-r2 | Bash | `sed -i -e 's/^jsonpatch==1.41$/jsonpatch==1.40/' -e 's/^j...` | ask | changes requirements.txt in a way pinright cannot read; check the file after the command runs. (sed -i -e s/^jsonpatch==1.41$/jsonpatch==1.40/ -e s/^jsonpointer==3.8$/jsonpointer== | Write `/work/requirements.txt` | no |
| Opus 5.5 | pinright hook only | langchain-rag-r2 | Bash | `.venv/bin/pip install -r requirements.txt / tail -2` | ask | This change adds 62 dependencies and pinright checks 40 per change, so pydantic, pydantic-settings, pydantic-core, pypdf, python-dotenv, pyyaml, regex, requests, +14 more were not  | none (run ended) | no |
| Opus 5.5 | pinright hook only | mcp-server-ts-r1 | Bash | `npm install --save-exact 2>&1 / tail -15 && npx tsc --ver...` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `npm install 2>&1 / tail -15` | yes |
| Opus 5.5 | pinright hook only | upload-sharp-s3-r1 | Bash | `npm install 2>&1 / tail -15 && npx tsc --version && npm r...` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `npm install 2>&1 / tail -15` | yes |
| Opus 5.5 | pinright hook only | upload-sharp-s3-r2 | Bash | `npm install 2>&1 / tail -15 && npx tsc --noEmit && echo T...` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `npm install 2>&1 / tail -15` | yes |
| Opus 5.5 | pinright MCP + hook | fastapi-jwt-r2 | Bash | `{ printf '# Direct dependencies\nfastapi==0.162.0\nuvicor...` | ask | changes requirements.txt in a way pinright cannot read; check the file after the command runs. | Write `/work/requirements.txt` | yes |
| Opus 5.5 | pinright MCP + hook | langchain-rag-r1 | Bash | `python3 -m venv .venv && .venv/bin/pip install -q -r requ...` | deny | jsonpointer==3.8 (pypi): version 3.8 was never published (or was removed). Use 3.6.0: pip install "jsonpointer==3.6.0" | Bash `pip index versions jsonpointer 2>/dev/null / he...` | yes |
| Opus 5.5 | pinright MCP + hook | langchain-rag-r1 | Bash | `pip index versions jsonpointer 2>/dev/null / head -3; pip...` | deny | jsonpointer==3.8 (pypi): version 3.8 was never published (or was removed). Use 3.6.0: pip install "jsonpointer==3.6.0" | Bash `pip config list; env / grep -i -E 'PIP_/INDEX' ...` | yes |
| Opus 5.5 | pinright MCP + hook | langchain-rag-r1 | Bash | `sed -i 's/^jsonpointer==3.8$/jsonpointer==3.6.0/' require...` | ask | changes requirements.txt in a way pinright cannot read; check the file after the command runs. (sed -i s/^jsonpointer==3.8$/jsonpointer==3.6.0/ requirements.txt) | Read `/work/requirements.txt` | yes |
| Opus 5.5 | pinright MCP + hook | langchain-rag-r1 | Bash | `python3 -m venv .venv && .venv/bin/pip install -q -r requ...` | ask | This change adds 62 dependencies and pinright checks 40 per change, so pydantic, pydantic-settings, pydantic-core, pypdf, python-dotenv, pyyaml, regex, requests, +14 more were not  | Bash `python3 -m venv .venv && head -31 requirements....` | yes |
| Opus 5.5 | pinright MCP + hook | langchain-rag-r2 | Bash | `{ cat requirements.txt; echo; echo "# transitive dependen...` | ask | changes requirements.txt in a way pinright cannot read; check the file after the command runs. (mv req.new requirements.txt) | Bash `.venv/bin/pip freeze` | no |
| Opus 5.5 | pinright MCP + hook | langchain-rag-r2 | Write | `/work/requirements.txt` | deny | jsonpointer==3.8 (pypi): version 3.8 was never published (or was removed). Use 3.6.0: pip install "jsonpointer==3.6.0" | Bash `.venv/bin/pip show jsonpointer / grep -E 'Versi...` | no |
| Opus 5.5 | pinright MCP + hook | langchain-rag-r2 | Bash | `.venv/bin/python -c "from importlib.metadata import requi...` | deny | jsonpointer==3.8 (pypi): version 3.8 was never published (or was removed). Use 3.6.0: pip install "jsonpointer==3.6.0" | Bash `.venv/bin/python -c "from importlib.metadata im...` | no |
| Opus 5.5 | pinright MCP + hook | langchain-rag-r2 | Bash | `rm -rf .venv && python3 -m venv .venv && .venv/bin/pip in...` | ask | This change adds 62 dependencies and pinright checks 40 per change, so propcache, pydantic, pydantic-settings, pydantic-core, python-dotenv, pyyaml, regex, requests, +14 more were  | Bash `rm -rf .venv && python3 -m venv .venv && .venv/...` | no |
| Opus 5.5 | pinright MCP + hook | langchain-rag-r2 | Bash | `.venv/bin/pip install -r requirements.txt 2>&1 / grep -vc...` | ask | This change adds 62 dependencies and pinright checks 40 per change, so propcache, pydantic, pydantic-settings, pydantic-core, python-dotenv, pyyaml, regex, requests, +14 more were  | Bash `.venv/bin/pip check; .venv/bin/python -c "impor...` | no |
| Opus 5.5 | pinright MCP + hook | next-auth-middleware-r2 | Bash | `sed -i 's/"incremental": true,/"incremental": true,\n "pa...` | deny | tsc (npm, executed): npx tsc runs the npm package "tsc", not the tsc command of "typescript", which is not installed here. Install it first (npm install -D typescript) and run npx  | Bash `sed -i 's/"incremental": true,/"incremental": t...` | yes |

<!-- hooks:end -->
