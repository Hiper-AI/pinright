# Agent benchmark: what a coding agent pins, with and without pinright

Run v7, 2026-11-02 and 2026-11-03, on three models: Sonnet 5.5, Haiku 5.5 and Opus 5.5, with the
code of the 1.0.0 release. The one-page summary with every caveat is [RESULTS-v7.md](RESULTS-v7.md).
The previous run, v6, is in [RESULTS-v6.md](RESULTS-v6.md).

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
Runs: `v7-sonnet-2026-11-02` (Sonnet 5.5, 2 repetition(s)), `v7-haiku-2026-11-02` (Haiku 5.5, 2 repetition(s)), `v7-opus-2026-11-02` (Opus 5.5, 2 repetition(s)). 12 tasks per arm (8 npm, 4 PyPI). Intervals in brackets are 95% cluster-bootstrap intervals that resample tasks; with 12 tasks they are wide, and two arms whose intervals overlap are not shown to differ.

## Sonnet 5.5 (`claude-sonnet-5-5`, run `v7-sonnet-2026-11-02`, 2 repetition(s))

| Metric | No docs | docs-only (pinright with the security layer off) | pinright MCP | pinright hook only | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | 23 / 24 | 12 / 12 |
| Direct dependencies pinned | 164 | 125 | 131 | 160 | 122 | 83 |
| Direct deps with >= 1 advisory | 66 (40%) | 2 (2%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 36 (22%) | 2 (2%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 0 | 0 | 0 | 0 | 0 | 0 |
| Manifests that fail to resolve | 0 | 0 | 0 | 0 | 0 | 0 |
| Dependabot-style alerts, whole tree (sum) | 766 | 84 | 6 | 14 | 6 | 3 |
| Alerts per project (mean [95% CI]) | 31.9 [20.3, 44.7] | 3.5 [0.0, 10.3] | 0.3 [0.0, 0.8] | 0.6 [0.0, 1.4] | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] |
| Projects with 0 alerts | 0 / 24 | 20 / 24 | 22 / 24 | 20 / 24 | 21 / 23 | 11 / 12 |
| Critical + high alerts (npm trees) | 178 | 42 | 0 | 4 | 0 | 0 |
| Projects that install | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | 23 / 23 | n/a |
| Projects that build / import cleanly | 24 / 24 | 24 / 24 | 23 / 24 | 24 / 24 | 22 / 23 | n/a |
| Median age of pinned version (days) | 717 | 36 | 34 | 391 | 35 | 32 |
| Direct deps on the registry default | 10% | 85% | 81% | 49% | 83% | 100% |
| API-equivalent cost per run (USD, list price, mean) | 0.033 | 0.088 | 0.050 | 0.044 | 0.045 | n/a |
| API-equivalent cost, all runs of the arm (USD, list price) | 0.80 | 2.10 | 1.20 | 1.04 | 1.07 | n/a |
| Turns per run (mean) | 4.1 | 9.3 | 5.9 | 5.5 | 5.8 | n/a |
| Duration per run (s, mean) | 14.4 | 34.9 | 21.1 | 27.2 | 19.9 | n/a |
| MCP calls per run (mean) | 0.0 | 5.3 | 1.9 | 0.0 | 1.8 | n/a |
| Hook blocks per run (mean) | 0.0 | 0.0 | 0.0 | 1.1 | 0.0 | n/a |

### Whole-tree alerts per task, Sonnet 5.5

Mean over repetitions, (min-max) when they differ; x = did not build.

| Task | Ecosystem | No docs | docs-only (pinright with the security layer off) | pinright MCP | pinright hook only | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|---|
| next-auth-middleware | npm | 52.0 | 39.0 | 0.0 x | 4.0 | 0.0 x | 0.0 |
| express-jwt-api | npm | 8.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| axios-client | npm | 35.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| vite-react-spa | npm | 24.5 (24.0-25.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| xml-yaml-parser | npm | 5.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| upload-sharp-s3 | npm | 24.0 (20.0-28.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| mcp-server-ts | npm | 9.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| nuxt-app | npm | 35.5 (26.0-45.0) | 3.0 | 3.0 | 3.0 | 3.0 | 3.0 |
| fastapi-jwt | pypi | 34.5 (34.0-35.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| flask-proxy | pypi | 19.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| langchain-rag | pypi | 76.5 (76.0-77.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| pandas-pipeline | pypi | 60.0 | 0.0 | 0.0 | 0.0 | 0.0 (1 no manifest) | 0.0 |

### Runs without a manifest or that do not build, Sonnet 5.5

**No docs**: none


**docs-only (pinright with the security layer off)**: none


**pinright MCP**: 

- next-auth-middleware r2: npm run build failed: `> Build error occurred`

**pinright hook only**: none


**pinright MCP + hook**: 

- pandas-pipeline r1: no manifest written (agent finished, 7 turns)
- next-auth-middleware r2: npm run build failed: `⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.`

### Vulnerable or non-existent direct pins, Sonnet 5.5

**No docs**: 

- idna@3.10 (2 advisories, CVSS 5.3; default 3.20.0) x4
- click@8.1.8 (1 advisories; default 8.5.0) x3
- axios@1.7.9 (33 advisories, CVSS 8.7; default 1.21.0) x2
- form-data@4.0.1 (2 advisories, CVSS 7.5; default 4.0.6) x2
- h11@0.14.0 (2 advisories, CVSS 9.1; default 0.16.0) x2
- flask@3.1.0 (4 advisories, CVSS 4.3; default 3.1.3) x2
- werkzeug@3.1.3 (8 advisories, CVSS 5.3; default 3.1.9) x2
- jinja2@3.1.5 (2 advisories; default 3.1.6) x2
- requests@2.32.3 (4 advisories, CVSS 5.5; default 2.34.2) x2
- certifi@2024.12.14 (2 advisories; default 2026.10.23) x2
- urllib3@2.3.0 (16 advisories, CVSS 7.5; default 2.8.0) x2
- langchain@0.3.27 (4 advisories, CVSS 7.1; default 1.4.8) x2
- zod@3.25.76 (1 advisories, CVSS 7.5; default 4.6.7) x2
- multer@2.0.2 (9 advisories, CVSS 7.5; default 2.5.0) x2
- js-yaml@4.1.0 (5 advisories, CVSS 7.5; default 5.5.0) x2
- ... 29 more

**docs-only (pinright with the security layer off)**: 

- next@15.5.0 (32 advisories, CVSS 10; default 16.4.4) x2

**pinright MCP**: none


**pinright hook only**: none


**pinright MCP + hook**: none


## Haiku 5.5 (`claude-haiku-5-5`, run `v7-haiku-2026-11-02`, 2 repetition(s))

| Metric | No docs | docs-only (pinright with the security layer off) | pinright MCP | pinright hook only | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 24 / 24 | 23 / 24 | 24 / 24 | 12 / 12 |
| Direct dependencies pinned | 157 | 142 | 137 | 148 | 123 | 76 |
| Direct deps with >= 1 advisory | 63 (40%) | 3 (2%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 37 (24%) | 3 (2%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 0 | 0 | 0 | 0 | 0 | 0 |
| Manifests that fail to resolve | 0 | 0 | 0 | 0 | 0 | 0 |
| Dependabot-style alerts, whole tree (sum) | 715 | 63 | 6 | 14 | 6 | 3 |
| Alerts per project (mean [95% CI]) | 29.8 [17.8, 43.5] | 2.6 [0.0, 7.6] | 0.3 [0.0, 0.8] | 0.6 [0.0, 1.5] | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] |
| Projects with 0 alerts | 2 / 24 | 20 / 24 | 22 / 24 | 19 / 23 | 22 / 24 | 11 / 12 |
| Critical + high alerts (npm trees) | 164 | 33 | 0 | 4 | 0 | 0 |
| Projects that install | 24 / 24 | 24 / 24 | 24 / 24 | 23 / 23 | 24 / 24 | n/a |
| Projects that build / import cleanly | 24 / 24 | 22 / 24 | 23 / 24 | 23 / 23 | 23 / 24 | n/a |
| Median age of pinned version (days) | 607 | 39 | 36 | 398 | 34 | 31 |
| Direct deps on the registry default | 11% | 86% | 85% | 49% | 82% | 100% |
| API-equivalent cost per run (USD, list price, mean) | 0.003 | 0.008 | 0.006 | 0.004 | 0.005 | n/a |
| API-equivalent cost, all runs of the arm (USD, list price) | 0.07 | 0.20 | 0.13 | 0.10 | 0.13 | n/a |
| Turns per run (mean) | 4.3 | 11.1 | 7.5 | 5.7 | 7.6 | n/a |
| Duration per run (s, mean) | 16.5 | 28.0 | 22.2 | 26.5 | 23.2 | n/a |
| MCP calls per run (mean) | 0.0 | 7.0 | 3.4 | 0.0 | 3.3 | n/a |
| Hook blocks per run (mean) | 0.0 | 0.0 | 0.0 | 1.1 | 0.0 | n/a |

### Whole-tree alerts per task, Haiku 5.5

Mean over repetitions, (min-max) when they differ; x = did not build.

| Task | Ecosystem | No docs | docs-only (pinright with the security layer off) | pinright MCP | pinright hook only | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|---|
| next-auth-middleware | npm | 50.0 | 28.5 (7.0-50.0) x | 0.0 | 4.0 | 0.0 | 0.0 |
| express-jwt-api | npm | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| axios-client | npm | 35.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| vite-react-spa | npm | 24.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| xml-yaml-parser | npm | 5.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| upload-sharp-s3 | npm | 23.5 (19.0-28.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| mcp-server-ts | npm | 9.0 | 0.0 x | 0.0 x | 0.0 | 0.0 x | 0.0 |
| nuxt-app | npm | 26.0 (25.0-27.0) | 3.0 | 3.0 | 3.0 | 3.0 | 3.0 |
| fastapi-jwt | pypi | 34.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| flask-proxy | pypi | 14.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| langchain-rag | pypi | 77.0 | 0.0 | 0.0 | 0.0 (1 no manifest) | 0.0 | 0.0 |
| pandas-pipeline | pypi | 60.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |

### Runs without a manifest or that do not build, Haiku 5.5

**No docs**: none


**docs-only (pinright with the security layer off)**: 

- mcp-server-ts r2: npm run build failed: `../../../../../Juan Mandelbaum/AppData/Local/Temp/sctx-build-mOolie/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.d.ts(1,36): error TS2307: Cannot find module 'node:`
- next-auth-middleware r2: npm run build failed: `It looks like you're trying to use TypeScript but do not have the required package(s) installed.`

**pinright MCP**: 

- mcp-server-ts r2: npm run build failed: `Enable color and formatting in TypeScript's output to make compiler errors easier to read.`

**pinright hook only**: 

- langchain-rag r1: no manifest written (agent finished, 5 turns)

**pinright MCP + hook**: 

- mcp-server-ts r2: npm run build failed: `Enable color and formatting in TypeScript's output to make compiler errors easier to read.`

### Vulnerable or non-existent direct pins, Haiku 5.5

**No docs**: 

- click@8.1.8 (1 advisories; default 8.5.0) x4
- idna@3.10 (2 advisories, CVSS 5.3; default 3.20.0) x4
- axios@1.7.9 (33 advisories, CVSS 8.7; default 1.21.0) x2
- form-data@4.0.1 (2 advisories, CVSS 7.5; default 4.0.6) x2
- anyio@4.9.0 (4 advisories; default 4.16.0) x2
- h11@0.14.0 (2 advisories, CVSS 9.1; default 0.16.0) x2
- pyjwt@2.10.1 (32 advisories, CVSS 9.1; default 2.15.1) x2
- python-multipart@0.0.20 (14 advisories, CVSS 8.6; default 0.0.33) x2
- starlette@0.46.2 (14 advisories, CVSS 7.5; default 1.10.0) x2
- langchain@0.3.27 (4 advisories, CVSS 7.1; default 1.4.8) x2
- langchain-openai@0.3.28 (2 advisories, CVSS 3.1; default 1.7.3) x2
- pypdf@5.9.0 (115 advisories, CVSS 6.5; default 6.21.4) x2
- zod@3.25.76 (1 advisories, CVSS 7.5; default 4.6.7) x2
- next-auth@5.0.0-beta.25 (5 advisories, CVSS 7.5; default 4.24.15) x2
- urllib3@2.2.3 (16 advisories, CVSS 7.5; default 2.8.0) x2
- ... 22 more

**docs-only (pinright with the security layer off)**: 

- next@15.5.4 (35 advisories, CVSS 10; default 16.4.4)
- next-auth@5.0.0-beta.25 (5 advisories, CVSS 7.5; default 4.24.15)
- next-auth@5.0.0-beta.31 (4 advisories, CVSS 7.5; default 4.24.15)

**pinright MCP**: none


**pinright hook only**: none


**pinright MCP + hook**: none


## Opus 5.5 (`claude-opus-5-5`, run `v7-opus-2026-11-02`, 2 repetition(s))

| Metric | No docs | docs-only (pinright with the security layer off) | pinright MCP | pinright hook only | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | 12 / 12 |
| Direct dependencies pinned | 159 | 126 | 154 | 156 | 149 | 78 |
| Direct deps with >= 1 advisory | 66 (42%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 38 (24%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 0 | 0 | 0 | 0 | 0 | 0 |
| Manifests that fail to resolve | 0 | 0 | 0 | 0 | 0 | 0 |
| Dependabot-style alerts, whole tree (sum) | 732 | 6 | 6 | 14 | 6 | 3 |
| Alerts per project (mean [95% CI]) | 30.5 [18.0, 43.5] | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] | 0.6 [0.0, 1.4] | 0.3 [0.0, 0.8] | 0.3 [0.0, 0.8] |
| Projects with 0 alerts | 2 / 24 | 22 / 24 | 22 / 24 | 20 / 24 | 22 / 24 | 11 / 12 |
| Critical + high alerts (npm trees) | 170 | 0 | 0 | 4 | 0 | 0 |
| Projects that install | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | n/a |
| Projects that build / import cleanly | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | n/a |
| Median age of pinned version (days) | 686 | 32 | 39 | 391 | 36 | 32 |
| Direct deps on the registry default | 11% | 93% | 81% | 50% | 80% | 100% |
| API-equivalent cost per run (USD, list price, mean) | 0.074 | 0.212 | 0.126 | 0.097 | 0.116 | n/a |
| API-equivalent cost, all runs of the arm (USD, list price) | 1.77 | 5.10 | 3.02 | 2.33 | 2.79 | n/a |
| Turns per run (mean) | 4.0 | 9.9 | 6.8 | 5.5 | 6.6 | n/a |
| Duration per run (s, mean) | 23.8 | 39.2 | 32.3 | 37.3 | 31.5 | n/a |
| MCP calls per run (mean) | 0.0 | 5.7 | 2.5 | 0.0 | 2.5 | n/a |
| Hook blocks per run (mean) | 0.0 | 0.0 | 0.0 | 1.0 | 0.0 | n/a |

### Whole-tree alerts per task, Opus 5.5

Mean over repetitions, (min-max) when they differ; x = did not build.

| Task | Ecosystem | No docs | docs-only (pinright with the security layer off) | pinright MCP | pinright hook only | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|---|
| next-auth-middleware | npm | 40.0 (36.0-44.0) | 0.0 | 0.0 | 4.0 | 0.0 | 0.0 |
| express-jwt-api | npm | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| axios-client | npm | 33.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| vite-react-spa | npm | 25.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| xml-yaml-parser | npm | 5.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| upload-sharp-s3 | npm | 19.0 (18.0-20.0) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| mcp-server-ts | npm | 9.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| nuxt-app | npm | 50.0 (45.0-55.0) | 3.0 | 3.0 | 3.0 | 3.0 | 3.0 |
| fastapi-jwt | pypi | 34.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| flask-proxy | pypi | 14.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| langchain-rag | pypi | 77.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| pandas-pipeline | pypi | 60.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |

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
- form-data@4.0.4 (1 advisories, CVSS 7.5; default 4.0.6) x2
- starlette@0.41.3 (14 advisories, CVSS 7.5; default 1.10.0) x2
- anyio@4.7.0 (4 advisories; default 4.16.0) x2
- h11@0.14.0 (2 advisories, CVSS 9.1; default 0.16.0) x2
- python-multipart@0.0.20 (14 advisories, CVSS 8.6; default 0.0.33) x2
- pyjwt@2.10.1 (32 advisories, CVSS 9.1; default 2.15.1) x2
- werkzeug@3.1.3 (8 advisories, CVSS 5.3; default 3.1.9) x2
- urllib3@2.5.0 (12 advisories, CVSS 7.5; default 2.8.0) x2
- langchain@0.3.27 (4 advisories, CVSS 7.1; default 1.4.8) x2
- langchain-core@0.3.72 (12 advisories, CVSS 9.3; default 1.7.4) x2
- langchain-openai@0.3.28 (2 advisories, CVSS 3.1; default 1.7.3) x2
- langchain-text-splitters@0.3.9 (2 advisories, CVSS 6.5; default 1.1.3) x2
- @modelcontextprotocol/sdk@1.17.0 (8 advisories, CVSS 7.5; default 1.32.2) x2
- ... 25 more

**docs-only (pinright with the security layer off)**: none


**pinright MCP**: none


**pinright hook only**: none


**pinright MCP + hook**: none


## pinright check-manifest vs npm audit / pip-audit (same lockfiles, all models)

|  | Lockfiles | Alerts (audit tool) | Alerts (pinright) | Vulnerable packages, mean Jaccard | Identical sets |
|---|---|---|---|---|---|
| npm (npm audit) | 264 | 1333 | 1411 | 0.96 | 236 |
| PyPI (pip-audit) | 130 | 1120 | 1144 | 1.00 | 130 |

Packages flagged by one side only (times seen):

- only pinright: @nuxt/nitro-server x27
- only pinright: nuxt x27
- only pinright: multer x1

## Reproduce

```bash
npm ci && npm run build
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp v7-sonnet-2026-11-02
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp v7-sonnet-2026-11-02 --arms docs-only --resume
npx tsx bench/agents/make-latest.ts v7-sonnet-2026-11-02 && npx tsx bench/agents/score.ts v7-sonnet-2026-11-02 --concurrency 3
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-haiku-5-5 --reps 2 --concurrency 3 --stamp v7-haiku-2026-11-02
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-haiku-5-5 --reps 2 --concurrency 3 --stamp v7-haiku-2026-11-02 --arms docs-only --resume
npx tsx bench/agents/make-latest.ts v7-haiku-2026-11-02 && npx tsx bench/agents/score.ts v7-haiku-2026-11-02 --concurrency 3
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-opus-5-5 --reps 2 --concurrency 3 --stamp v7-opus-2026-11-02
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-opus-5-5 --reps 2 --concurrency 3 --stamp v7-opus-2026-11-02 --arms docs-only --resume
npx tsx bench/agents/make-latest.ts v7-opus-2026-11-02 && npx tsx bench/agents/score.ts v7-opus-2026-11-02 --concurrency 3
npx tsx bench/agents/report.ts v7-sonnet-2026-11-02 v7-haiku-2026-11-02 v7-opus-2026-11-02
```

<!-- generated:end -->

## Failure diagnoses

We read the transcripts and rebuilt each failing project by hand.

**pinright arms: the residual alerts are nuxt's.** All 6 alerts per model in the pinright MCP and
MCP + hook arms come from the nuxt task. `nuxt` 4.6.3, the registry default and the version pinright
recommends, pulls `deepmerge`, `glob` and `minimatch` versions with advisories and no fixed release:
3 alerts per run. The no-pin reference gets the same 3. On these lockfiles pinright's `check-manifest`
also lists `nuxt` and `@nuxt/nitro-server`, which `npm audit` does not (27 times each). The one other
difference is `multer` in one Haiku no-docs upload-sharp-s3 lockfile; we did not diagnose it.

**Hook only: `next` 15.5.28 and `postcss`.** In the next-auth task the hook let `next` 15.5.28
through, the clean release on the 15.x line the agent chose, in all 6 hook-only next-auth runs. It
still pulls a `postcss` with advisories that only Next 16 clears: 4 alerts, 2 of them high, per run.
The MCP arms avoid it because `check-packages` recommends Next 16 up front.

**docs-only: version choices with no verdict.** Sonnet pinned `next` 15.5.0 in both next-auth runs.
Nothing in the arm said 15.5.0 had 32 advisories: 39 alerts per run, 21 of them critical or high.
Haiku pinned `next` 15.5.4 with `next-auth` 5.0.0-beta.25 in r1 (50 alerts) and `next` 16.4.4 with
`next-auth` 5.0.0-beta.31 in r2 (7 alerts, and a build that fails). Both betas carry advisories; the
registry default is 4.24.15. Opus in this arm matched the full server. The arm also costs more:
without `check-packages`, agents asked `get-docs` for the "latest version" of each package one call at
a time (5.3 to 7.0 MCP calls per run against 1.9 to 3.4).

**Builds that fail.**
- Sonnet, next-auth r2, MCP and MCP + hook: pinright recommended Next 16.4.3 (the clean default) and
  the agent wrote `next-auth` 4 code, `export { default } from "next-auth/middleware"`. Next 16 does
  not accept that re-export as a middleware function and the build stops. No advisories, but broken:
  the agent called neither `upgrade-guide` nor `get-docs` for Next 16 middleware. v6 had the same
  failure in r1.
- Haiku, mcp-server-ts r2, MCP and MCP + hook: `"build": "tsc"` with no `tsconfig.json`, so `tsc`
  prints its help and exits 1. The docs-only r2 run has a `tsconfig.json` but no `@types/node`, so
  the SDK's `node:` imports do not type-check.
- Haiku, next-auth r2, docs-only: the project uses TypeScript without listing `typescript`.

**No manifest.** Sonnet MCP + hook pandas r1 wrote its `requirements.txt` to a folder next to the
run directory (the model dropped a path separator, as in v5 and v6). Haiku hook-only langchain r1
wrote `rag.py` and no `requirements.txt`. Both count as runs without a manifest.

**Scoring fixes.** The first scoring pass of v7 had two silent failures, both now caught by
`score.ts`. It marked `next` 15.5.0, `pytz` 2024.2 and `tzdata` 2024.2 as versions that do not exist:
a deps.dev lookup failed and the scorer read the error as a missing version. And `pip-audit` printed
nothing for one Haiku no-docs flask-proxy project, which scored as a clean tree of 0 packages. We
rescored the affected runs (Sonnet next-auth and pandas in three arms, Haiku no-docs flask-proxy).
What changed: Sonnet docs-only counts 2 direct deps with an advisory instead of 0, Sonnet no-docs
counts 66 of 164 instead of 66 of 160, and Haiku no-docs gains 14 alerts (701 to 715).

## What changed since v6

v6 ran on 2026-11-01 at commit `b2fcfe2`, before the 1.0.0 release; 28 files under `src/` changed
between that commit and the release. v7 reran the same 12 tasks, arms, models and repetitions on
2026-11-02 and 2026-11-03 at `8efc4f0`, whose `src/` is the 1.0.0 release (`093175b`). The results
moved little:

| Model | No docs, alerts per project (v6 to v7) | pinright MCP | MCP + hook | docs-only | hook only |
|---|---|---|---|---|---|
| Sonnet 5.5 | 33.1 to 31.9 | 0.25 to 0.25 | 0.25 to 0.26 | 2.0 to 3.5 | 0.61 to 0.58 |
| Haiku 5.5 | 29.6 to 29.8 | 0.25 to 0.25 | 0.25 to 0.25 | 0.88 to 2.6 | 0.43 to 0.61 |
| Opus 5.5 | 29.9 to 30.5 | 0.25 to 0.25 | 0.25 to 0.25 | 0.25 to 0.25 | 0.58 to 0.58 |

The two pinright MCP arms stayed at 0 direct dependencies with an advisory on every model. The
docs-only arm moved most: one next-auth choice per model decides it (see above), so it swings from run
to run.

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
