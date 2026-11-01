# Agent benchmark: what a coding agent pins, with and without pinright

Run v6, 2026-11-01, on three models: Sonnet 5.5, Haiku 5.5 and Opus 5.5. The one-page summary
with every caveat is [RESULTS-v6.md](RESULTS-v6.md).

Each run is Claude Code in headless mode (`claude -p`, version 2.1.308) with Write and Read as its
only built-in tools: no shell, no web. Every arm gets the same prompt, which asks for exact pinned
versions. The arms differ in what we attach:

- **No docs**: nothing. The agent pins from memory.
- **docs-only (pinright with the security layer off)**: an ablation. The same pinright server with
  `PINRIGHT_ABLATION=docs-only`: it registers only `find-library` and `get-docs`, `get-docs` without
  a version documents the registry's latest version, and no answer carries a security notice, a
  verdict or a recommended version. Docs content, ranking and untrusted-data fencing are the same
  code. The arm shows what version-accurate docs do on their own.
- **pinright MCP**: the full server.
- **pinright hook only**: no MCP server; the pre-install hook checks every Write of a manifest.
- **pinright MCP + hook**: both.
- **No pin (reference)**: no agent. The packages the no-docs agent chose, installed without a version.

Whole-tree alerts come from `npm audit` (lockfile resolved with `--package-lock-only`) and
`pip-audit` (over `uv pip compile` output). Neither shares code or data path with pinright, and both
read the advisory data Dependabot alerts on. "Build" means a real `npm install` plus `npm run build`,
`tsc --noEmit` or an import check for JavaScript, and for Python `uv pip install` plus executing
every top-level import of the generated files. We leave out as inconclusive the builds that fail only
because a native binary needs an install script (we never run one).

Cost is the API-equivalent at list price that Claude Code reports in each transcript
(`total_cost_usd`). The runs used a Claude subscription, not an API key, so nobody paid that amount.

<!-- generated:start -->
Runs: `v6-sonnet-2026-11-01` (Sonnet 5.5, 2 repetition(s)), `v6-haiku-2026-11-01` (Haiku 5.5, 2 repetition(s)), `v6-opus-2026-11-01` (Opus 5.5, 2 repetition(s)). 12 tasks per arm (8 npm, 4 PyPI). Intervals in brackets are 95% cluster-bootstrap intervals that resample tasks; with 12 tasks they are wide, and two arms whose intervals overlap are not shown to differ.

## Sonnet 5.5 (`claude-sonnet-5-5`, run `v6-sonnet-2026-11-01`, 2 repetition(s))

| Metric | No docs | docs-only (pinright with the security layer off) | pinright MCP | pinright hook only | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 24 / 24 | 23 / 24 | 24 / 24 | 12 / 12 |
| Direct dependencies pinned | 157 | 120 | 130 | 154 | 132 | 78 |
| Direct deps with >= 1 advisory | 66 (42%) | 1 (1%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 37 (24%) | 1 (1%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 0 | 0 | 0 | 0 | 0 | 0 |
| Manifests that fail to resolve | 0 | 0 | 0 | 0 | 0 | 0 |
| Dependabot-style alerts, whole tree (sum) | 794 | 48 | 6 | 14 | 6 | 3 |
| Alerts per project (mean [95% CI]) | 33.1 [21.4, 44.7] | 2.0 [0.0, 5.8] | 0.3 [0.0, 0.8] | 0.6 [0.0, 1.5] | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] |
| Projects with 0 alerts | 0 / 24 | 21 / 24 | 22 / 24 | 19 / 23 | 22 / 24 | 11 / 12 |
| Critical + high alerts (npm trees) | 190 | 23 | 0 | 4 | 0 | 0 |
| Projects that install | 24 / 24 | 24 / 24 | 24 / 24 | 23 / 23 | 24 / 24 | n/a |
| Projects that build / import cleanly | 24 / 24 | 24 / 24 | 23 / 24 | 23 / 23 | 23 / 24 | n/a |
| Median age of pinned version (days) | 747 | 32 | 34 | 390 | 32 | 30 |
| Direct deps on the registry default | 8% | 94% | 86% | 51% | 86% | 100% |
| API-equivalent cost per run (USD, list price, mean) | 0.034 | 0.087 | 0.051 | 0.046 | 0.048 | n/a |
| API-equivalent cost, all runs of the arm (USD, list price) | 0.81 | 2.09 | 1.23 | 1.10 | 1.15 | n/a |
| Turns per run (mean) | 4.0 | 8.9 | 6.0 | 5.7 | 6.0 | n/a |
| Duration per run (s, mean) | 13.7 | 29.8 | 21.2 | 23.4 | 19.1 | n/a |
| MCP calls per run (mean) | 0.0 | 5.0 | 2.0 | 0.0 | 2.1 | n/a |
| Hook blocks per run (mean) | 0.0 | 0.0 | 0.0 | 1.2 | 0.0 | n/a |

### Whole-tree alerts per task, Sonnet 5.5

Mean over repetitions, (min-max) when they differ; x = did not build.

| Task | Ecosystem | No docs | docs-only (pinright with the security layer off) | pinright MCP | pinright hook only | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|---|
| next-auth-middleware | npm | 52.0 | 21.0 (0.0-42.0) | 0.0 x | 4.0 | 0.0 x | 0.0 |
| express-jwt-api | npm | 8.0 | 0.0 | 0.0 | 0.0 (1 no manifest) | 0.0 | 0.0 |
| axios-client | npm | 35.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| vite-react-spa | npm | 29.0 (25.0-33.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| xml-yaml-parser | npm | 4.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| upload-sharp-s3 | npm | 28.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| mcp-server-ts | npm | 9.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| nuxt-app | npm | 40.5 (26.0-55.0) | 3.0 | 3.0 | 3.0 | 3.0 | 3.0 |
| fastapi-jwt | pypi | 35.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| flask-proxy | pypi | 19.5 (19.0-20.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| langchain-rag | pypi | 77.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| pandas-pipeline | pypi | 60.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |

### Runs without a manifest or that do not build, Sonnet 5.5

**No docs**: none


**docs-only (pinright with the security layer off)**: none


**pinright MCP**: 

- next-auth-middleware r1: npm run build failed: `> Build error occurred`

**pinright hook only**: 

- express-jwt-api r2: no manifest written (agent finished, 4 turns)

**pinright MCP + hook**: 

- next-auth-middleware r1: npm run build failed: `> Build error occurred`

### Vulnerable or non-existent direct pins, Sonnet 5.5

**No docs**: 

- idna@3.10 (2 advisories, CVSS 5.3; default 3.20.0) x4
- click@8.1.7 (1 advisories; default 8.5.0) x3
- urllib3@2.2.3 (16 advisories, CVSS 7.5; default 2.8.0) x3
- axios@1.7.9 (33 advisories, CVSS 8.7; default 1.21.0) x2
- form-data@4.0.1 (2 advisories, CVSS 7.5; default 4.0.6) x2
- starlette@0.38.6 (14 advisories, CVSS 7.5; default 1.10.0) x2
- python-multipart@0.0.9 (16 advisories, CVSS 8.6; default 0.0.33) x2
- pyjwt@2.9.0 (32 advisories, CVSS 9.1; default 2.15.1) x2
- anyio@4.6.0 (4 advisories; default 4.16.0) x2
- h11@0.14.0 (2 advisories, CVSS 9.1; default 0.16.0) x2
- requests@2.32.3 (4 advisories, CVSS 5.5; default 2.34.2) x2
- langchain@0.3.27 (4 advisories, CVSS 7.1; default 1.4.7) x2
- langchain-text-splitters@0.3.9 (2 advisories, CVSS 6.5; default 1.1.3) x2
- pypdf@5.9.0 (115 advisories, CVSS 6.5; default 6.21.4) x2
- zod@3.25.76 (1 advisories, CVSS 7.5; default 4.6.7) x2
- ... 27 more

**docs-only (pinright with the security layer off)**: 

- next@15.5.4 (35 advisories, CVSS 10; default 16.4.3)

**pinright MCP**: none


**pinright hook only**: none


**pinright MCP + hook**: none


## Haiku 5.5 (`claude-haiku-5-5`, run `v6-haiku-2026-11-01`, 2 repetition(s))

| Metric | No docs | docs-only (pinright with the security layer off) | pinright MCP | pinright hook only | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 24 / 24 | 23 / 24 | 24 / 24 | 12 / 12 |
| Direct dependencies pinned | 157 | 127 | 134 | 149 | 121 | 76 |
| Direct deps with >= 1 advisory | 63 (40%) | 2 (2%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 35 (22%) | 2 (2%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 0 | 0 | 0 | 0 | 0 | 0 |
| Manifests that fail to resolve | 0 | 0 | 0 | 0 | 0 | 0 |
| Dependabot-style alerts, whole tree (sum) | 711 | 21 | 6 | 10 | 6 | 3 |
| Alerts per project (mean [95% CI]) | 29.6 [17.8, 41.9] | 0.9 [0.0, 2.3] | 0.3 [0.0, 0.8] | 0.4 [0.0, 1.2] | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] |
| Projects with 0 alerts | 2 / 24 | 20 / 24 | 22 / 24 | 20 / 23 | 22 / 24 | 11 / 12 |
| Critical + high alerts (npm trees) | 173 | 11 | 0 | 2 | 0 | 0 |
| Projects that install | 24 / 24 | 24 / 24 | 24 / 24 | 23 / 23 | 24 / 24 | n/a |
| Projects that build / import cleanly | 23 / 24 | 23 / 24 | 22 / 24 | 22 / 23 | 24 / 24 | n/a |
| Median age of pinned version (days) | 583 | 34 | 32 | 397 | 32 | 30 |
| Direct deps on the registry default | 10% | 90% | 87% | 51% | 88% | 100% |
| API-equivalent cost per run (USD, list price, mean) | 0.003 | 0.009 | 0.005 | 0.004 | 0.005 | n/a |
| API-equivalent cost, all runs of the arm (USD, list price) | 0.07 | 0.21 | 0.13 | 0.10 | 0.12 | n/a |
| Turns per run (mean) | 4.2 | 10.0 | 7.0 | 5.7 | 6.8 | n/a |
| Duration per run (s, mean) | 15.8 | 30.3 | 22.0 | 25.8 | 21.1 | n/a |
| MCP calls per run (mean) | 0.0 | 6.1 | 2.9 | 0.0 | 2.7 | n/a |
| Hook blocks per run (mean) | 0.0 | 0.0 | 0.0 | 1.0 | 0.0 | n/a |

### Whole-tree alerts per task, Haiku 5.5

Mean over repetitions, (min-max) when they differ; x = did not build.

| Task | Ecosystem | No docs | docs-only (pinright with the security layer off) | pinright MCP | pinright hook only | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|---|
| next-auth-middleware | npm | 50.0 | 7.0 | 0.0 x | 4.0 (1 no manifest) | 0.0 | 0.0 |
| express-jwt-api | npm | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| axios-client | npm | 34.0 (33.0-35.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| vite-react-spa | npm | 24.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| xml-yaml-parser | npm | 5.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| upload-sharp-s3 | npm | 25.0 (20.0-30.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| mcp-server-ts | npm | 9.0 x | 0.0 x | 0.0 x | 0.0 x | 0.0 | 0.0 |
| nuxt-app | npm | 27.0 | 3.5 (3.0-4.0) | 3.0 | 3.0 | 3.0 | 3.0 |
| fastapi-jwt | pypi | 33.5 (33.0-34.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| flask-proxy | pypi | 14.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| langchain-rag | pypi | 74.0 (73.0-75.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| pandas-pipeline | pypi | 60.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |

### Runs without a manifest or that do not build, Haiku 5.5

**No docs**: 

- mcp-server-ts r1: npm run build failed: `Enable color and formatting in TypeScript's output to make compiler errors easier to read.`

**docs-only (pinright with the security layer off)**: 

- mcp-server-ts r1: npm run build failed: `Enable color and formatting in TypeScript's output to make compiler errors easier to read.`

**pinright MCP**: 

- mcp-server-ts r2: npm run build failed: `Enable color and formatting in TypeScript's output to make compiler errors easier to read.`
- next-auth-middleware r1: npm run build failed: `> Build error occurred`

**pinright hook only**: 

- next-auth-middleware r2: no manifest written (agent finished, 9 turns)
- mcp-server-ts r2: npm run build failed: `Enable color and formatting in TypeScript's output to make compiler errors easier to read.`

**pinright MCP + hook**: none


### Vulnerable or non-existent direct pins, Haiku 5.5

**No docs**: 

- idna@3.10 (2 advisories, CVSS 5.3; default 3.20.0) x4
- pyjwt@2.10.1 (32 advisories, CVSS 9.1; default 2.15.1) x2
- python-multipart@0.0.20 (14 advisories, CVSS 8.6; default 0.0.33) x2
- certifi@2025.8.3 (2 advisories; default 2026.10.23) x2
- click@8.1.8 (1 advisories; default 8.5.0) x2
- flask@3.1.2 (2 advisories, CVSS 4.3; default 3.1.3) x2
- requests@2.32.5 (2 advisories, CVSS 5.5; default 2.34.2) x2
- urllib3@2.5.0 (12 advisories, CVSS 7.5; default 2.8.0) x2
- werkzeug@3.1.3 (8 advisories, CVSS 5.3; default 3.1.9) x2
- zod@3.25.76 (1 advisories, CVSS 7.5; default 4.6.7) x2
- next@15.5.4 (35 advisories, CVSS 10; default 16.4.3) x2
- nuxt@4.1.3 (17 advisories, CVSS 8.1; default 4.6.3) x2
- pillow@11.0.0 (86 advisories, CVSS 9.8; default 13.0.0) x2
- urllib3@2.2.3 (16 advisories, CVSS 7.5; default 2.8.0) x2
- react-router@7.9.1 (13 advisories, CVSS 8.2; default 8.5.1) x2
- ... 30 more

**docs-only (pinright with the security layer off)**: 

- next-auth@5.0.0-beta.31 (4 advisories, CVSS 7.5; default 4.24.15) x2

**pinright MCP**: none


**pinright hook only**: none


**pinright MCP + hook**: none


## Opus 5.5 (`claude-opus-5-5`, run `v6-opus-2026-11-01`, 2 repetition(s))

| Metric | No docs | docs-only (pinright with the security layer off) | pinright MCP | pinright hook only | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | 12 / 12 |
| Direct dependencies pinned | 157 | 126 | 135 | 157 | 149 | 77 |
| Direct deps with >= 1 advisory | 65 (41%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 37 (24%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 0 | 0 | 0 | 0 | 0 | 0 |
| Manifests that fail to resolve | 0 | 0 | 0 | 0 | 0 | 0 |
| Dependabot-style alerts, whole tree (sum) | 718 | 6 | 6 | 14 | 6 | 3 |
| Alerts per project (mean [95% CI]) | 29.9 [17.9, 43.0] | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] | 0.6 [0.0, 1.4] | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] |
| Projects with 0 alerts | 2 / 24 | 22 / 24 | 22 / 24 | 20 / 24 | 22 / 24 | 11 / 12 |
| Critical + high alerts (npm trees) | 164 | 0 | 0 | 4 | 0 | 0 |
| Projects that install | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | n/a |
| Projects that build / import cleanly | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | n/a |
| Median age of pinned version (days) | 583 | 31 | 32 | 333 | 35 | 30 |
| Direct deps on the registry default | 13% | 91% | 85% | 52% | 84% | 100% |
| API-equivalent cost per run (USD, list price, mean) | 0.080 | 0.204 | 0.130 | 0.101 | 0.125 | n/a |
| API-equivalent cost, all runs of the arm (USD, list price) | 1.93 | 4.90 | 3.12 | 2.43 | 2.99 | n/a |
| Turns per run (mean) | 4.0 | 9.5 | 6.5 | 5.4 | 6.8 | n/a |
| Duration per run (s, mean) | 23.0 | 31.0 | 29.4 | 35.6 | 30.7 | n/a |
| MCP calls per run (mean) | 0.0 | 5.5 | 2.3 | 0.0 | 2.6 | n/a |
| Hook blocks per run (mean) | 0.0 | 0.0 | 0.0 | 1.0 | 0.0 | n/a |

### Whole-tree alerts per task, Opus 5.5

Mean over repetitions, (min-max) when they differ; x = did not build.

| Task | Ecosystem | No docs | docs-only (pinright with the security layer off) | pinright MCP | pinright hook only | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|---|
| next-auth-middleware | npm | 47.5 (44.0-51.0) | 0.0 | 0.0 | 4.0 | 0.0 | 0.0 |
| express-jwt-api | npm | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| axios-client | npm | 33.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| vite-react-spa | npm | 26.0 (25.0-27.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| xml-yaml-parser | npm | 5.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| upload-sharp-s3 | npm | 23.5 (21.0-26.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| mcp-server-ts | npm | 9.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| nuxt-app | npm | 27.5 (27.0-28.0) | 3.0 | 3.0 | 3.0 | 3.0 | 3.0 |
| fastapi-jwt | pypi | 33.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| flask-proxy | pypi | 14.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| langchain-rag | pypi | 79.5 (77.0-82.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| pandas-pipeline | pypi | 61.0 (60.0-62.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |

### Runs without a manifest or that do not build, Opus 5.5

**No docs**: none


**docs-only (pinright with the security layer off)**: none


**pinright MCP**: none


**pinright hook only**: none


**pinright MCP + hook**: none


### Vulnerable or non-existent direct pins, Opus 5.5

**No docs**: 

- idna@3.10 (2 advisories, CVSS 5.3; default 3.20.0) x4
- click@8.1.8 (1 advisories; default 8.5.0) x3
- urllib3@2.5.0 (12 advisories, CVSS 7.5; default 2.8.0) x3
- axios@1.12.2 (32 advisories, CVSS 8.7; default 1.21.0) x2
- form-data@4.0.4 (1 advisories, CVSS 7.5; default 4.0.6) x2
- starlette@0.46.2 (14 advisories, CVSS 7.5; default 1.10.0) x2
- anyio@4.9.0 (4 advisories; default 4.16.0) x2
- python-multipart@0.0.20 (14 advisories, CVSS 8.6; default 0.0.33) x2
- pyjwt@2.10.1 (32 advisories, CVSS 9.1; default 2.15.1) x2
- flask@3.1.1 (2 advisories, CVSS 4.3; default 3.1.3) x2
- werkzeug@3.1.3 (8 advisories, CVSS 5.3; default 3.1.9) x2
- requests@2.32.4 (2 advisories, CVSS 5.5; default 2.34.2) x2
- @modelcontextprotocol/sdk@1.17.0 (8 advisories, CVSS 7.5; default 1.32.2) x2
- zod@3.25.76 (1 advisories, CVSS 7.5; default 4.6.7) x2
- vite@6.3.5 (12 advisories; default 8.3.5) x2
- ... 30 more

**docs-only (pinright with the security layer off)**: none


**pinright MCP**: none


**pinright hook only**: none


**pinright MCP + hook**: none


## pinright check-manifest vs npm audit / pip-audit (same lockfiles, all models)

|  | Lockfiles | Alerts (audit tool) | Alerts (pinright) | Vulnerable packages, mean Jaccard | Identical sets |
|---|---|---|---|---|---|
| npm (npm audit) | 262 | 1260 | 1424 | 0.96 | 235 |
| PyPI (pip-audit) | 132 | 1121 | 1145 | 1.00 | 132 |

Packages flagged by one side only (times seen):

- only pinright: @nuxt/nitro-server x27
- only pinright: nuxt x27

## Reproduce

```bash
npm ci && npm run build
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp v6-sonnet-2026-11-01
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp v6-sonnet-2026-11-01 --arms docs-only --resume
npx tsx bench/agents/make-latest.ts v6-sonnet-2026-11-01 && npx tsx bench/agents/score.ts v6-sonnet-2026-11-01 --concurrency 3
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-haiku-5-5 --reps 2 --concurrency 3 --stamp v6-haiku-2026-11-01
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-haiku-5-5 --reps 2 --concurrency 3 --stamp v6-haiku-2026-11-01 --arms docs-only --resume
npx tsx bench/agents/make-latest.ts v6-haiku-2026-11-01 && npx tsx bench/agents/score.ts v6-haiku-2026-11-01 --concurrency 3
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-opus-5-5 --reps 2 --concurrency 3 --stamp v6-opus-2026-11-01
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-opus-5-5 --reps 2 --concurrency 3 --stamp v6-opus-2026-11-01 --arms docs-only --resume
npx tsx bench/agents/make-latest.ts v6-opus-2026-11-01 && npx tsx bench/agents/score.ts v6-opus-2026-11-01 --concurrency 3
npx tsx bench/agents/report.ts v6-sonnet-2026-11-01 v6-haiku-2026-11-01 v6-opus-2026-11-01
```

<!-- generated:end -->

## Failure diagnoses

We read the transcripts and rebuilt each failing project by hand.

**pinright arms: the residual alerts are nuxt's.** All 6 alerts per model in the pinright MCP and
MCP + hook arms come from the nuxt task. `nuxt` 4.6.3, the registry default and the version pinright
recommends, pulls `deepmerge`, `glob` and `minimatch` versions with advisories and no fixed release:
3 alerts per run. The no-pin reference gets the same 3. On these lockfiles pinright's `check-manifest`
also lists `nuxt` and `@nuxt/nitro-server`, which `npm audit` does not; that is the only disagreement
between the two (see the agreement table).

**Hook only: `next` 15.5.28 and `postcss`.** In the next-auth task the hook let `next` 15.5.28
through, the clean release on the 15.x line the agent chose. It still pulls a `postcss` with
advisories that only Next 16 clears: 4 alerts, 2 of them high, in each of the 5 hook-only next-auth
runs that wrote a manifest. The MCP arms avoid it because `check-packages` recommends Next 16 up front.

**docs-only: version choices with no verdict.** Sonnet r1 of the next-auth task pinned `next` 15.5.4 to
stay inside `next-auth` 4's peer range. `find-library` showed 16.4.3 as latest, and nothing said
15.5.4 had 35 advisories: 42 alerts, 23 of them critical or high. Haiku pinned `next-auth`
5.0.0-beta.31 in both runs, a beta with advisories (the registry default is 4.24.15): 7 alerts each.
One Haiku nuxt run pinned an `@vue/server-renderer` with an advisory. Opus in this arm matched the
full server. The arm also costs more: without `check-packages`, agents asked `get-docs` for the
"latest version" of each package one call at a time (5 to 6 MCP calls per run against 2 to 3).

**Builds that fail in the pinright arms.**
- Sonnet, next-auth r1, MCP and MCP + hook: pinright recommended Next 16.4.3 (the clean default) and
  the agent wrote `next-auth` 4 code, `export { default } from "next-auth/middleware"`. Next 16 does
  not accept that re-export as a middleware function and the build stops. Secure but broken: the
  agent called neither `upgrade-guide` nor `get-docs` for Next 16 middleware.
- Haiku, next-auth r1, MCP: `next-auth` 5 beta with a route file that imports `GET`/`POST` from an
  `auth.ts` that exports `handlers`. A code bug, unrelated to the versions.
- Haiku, mcp-server-ts (no docs r1, MCP r2, hook only r2, docs-only r1): `"build": "tsc"` with no
  `tsconfig.json`, so `tsc` prints its help and exits 1. The same mistake shows up in every arm.

**No manifest.** Sonnet hook-only express r2 and Haiku hook-only next-auth r2 wrote their files to a
folder next to the working directory (the model mangled the path, as in v5). They count as runs
without a manifest.

## What changed since v5

v5 ran Sonnet 5.5 on 2026-10-29 at commit `dd570aa`. v6 runs three models on 2026-11-01 at the
release candidate (`lanzamiento`, `b2fcfe2`) plus the benchmark-only ablation flag. In between came
the rename to pinright, the hook's policy for what it cannot verify, the notice when a same-line fix
still pulls vulnerable dependencies, undeclared-import notes, and three rounds of docs fixes (see
[DOCS.md](DOCS.md)). Sonnet's numbers moved little. No docs went from 678 to 794 alerts: it wrote a
manifest in 24 runs against 22, and two more days of advisories landed. The MCP arm stayed at 6. MCP
+ hook went from 2 to 6, all from nuxt, which now carries 3 alerts per run in every arm, the no-pin
reference included.

The harness changed in one place: `--resume` now parses each transcript's result line. With Claude
Code 2.1.308 the old text match never matched, and a resume pass reran every job. That threw away the
first Haiku pass (96 runs); the Haiku numbers come from the second, complete pass.
