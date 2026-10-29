# Agent benchmark: no docs vs Context7 vs safectx

Run `v2-2026-10-29`, model `claude-sonnet-5-5`, 2 repetition(s) of 12 tasks per arm (8 npm, 4 PyPI). Each run is Claude Code in headless mode with only Write and Read as built-in tools (no shell, no web). The prompt is identical in every arm and asks for exact pinned versions. Arms differ only in what is attached: nothing, the Context7 MCP server, the safectx MCP server (with Context7 turned off, so its docs come from the packages themselves), the safectx pre-install hook alone, or both.

"No pin" has no agent: the packages the no-docs agent chose, installed without a version. Whole-tree alerts come from `npm audit` (lockfile resolved with `--package-lock-only`) and `pip-audit` (over `uv pip compile` output); neither shares code or data path with safectx, and both read the advisory data Dependabot alerts on. "Build" means a real `npm install` plus `npm run build`, `tsc --noEmit` or an import check for JavaScript, and for Python `uv pip install` plus executing every top-level import of the generated files. Builds that fail only because a native binary needs an install script (never run here) are left out as inconclusive.

| Metric | No docs | Context7 | safectx MCP | safectx hook only | safectx MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 24 / 24 | 22 / 24 | 22 / 24 | 12 / 12 |
| Direct dependencies pinned | 164 | 146 | 127 | 154 | 121 | 81 |
| Direct deps with >= 1 advisory | 61 (37%) | 59 (40%) | 0 (0%) | 4 (3%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 33 (20%) | 34 (23%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 1 | 0 | 0 | 0 | 0 | 0 |
| Manifests that fail to resolve | 0 | 0 | 0 | 2 | 0 | 0 |
| Dependabot-style alerts, whole tree (sum) | 708 | 697 | 10 | 9 | 4 | 1 |
| Alerts per project (mean) | 29.5 | 29.0 | 0.4 | 0.5 | 0.2 | 0.1 |
| Projects with 0 alerts | 0 / 24 | 0 / 24 | 20 / 24 | 17 / 20 | 21 / 22 | 11 / 12 |
| Critical + high alerts (npm trees) | 159 | 165 | 4 | 4 | 2 | 0 |
| Projects that install | 24 / 24 | 24 / 24 | 24 / 24 | 20 / 22 | 22 / 22 | n/a |
| Projects that build / import cleanly | 24 / 24 | 24 / 24 | 23 / 24 | 19 / 22 | 20 / 22 | n/a |
| Median age of pinned version (days) | 689 | 682 | 29 | 502 | 31 | 29 |
| Direct deps on the registry default | 12% | 10% | 84% | 41% | 86% | 100% |
| Cost per run (USD, mean) | 0.03 | 0.04 | 0.07 | 0.04 | 0.07 | n/a |
| Turns per run (mean) | 4.1 | 6.5 | 10.9 | 5.5 | 10.9 | n/a |
| Duration per run (s, mean) | 13.3 | 16.9 | 21.4 | 22.7 | 22.6 | n/a |
| MCP calls per run (mean) | 0.0 | 2.4 | 6.5 | 0.0 | 6.8 | n/a |
| Hook blocks per run (mean) | 0.0 | 0.0 | 0.0 | 1.1 | 0.1 | n/a |

## Whole-tree alerts per task (mean over repetitions; x = did not build)

| Task | Ecosystem | No docs | Context7 | safectx MCP | safectx hook only | safectx MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|---|
| next-auth-middleware | npm | 51.5 | 52.0 | 4.0 | 4.0 | 2.0 | 0.0 |
| express-jwt-api | npm | 8.0 | 8.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| axios-client | npm | 34.0 | 34.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| vite-react-spa | npm | 24.0 | 21.5 | 0.0 | 0.0 | 0.0 | 0.0 |
| xml-yaml-parser | npm | 4.5 | 4.5 | 0.0 | 0.0 | 0.0 | 0.0 |
| upload-sharp-s3 | npm | 24.0 | 20.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| mcp-server-ts | npm | 9.0 | 9.0 | 0.0 x | 0.0 | 0.0 xx | 0.0 |
| nuxt-app | npm | 23.0 | 23.0 | 1.0 | - (2 unresolved) | - (2 unresolved) | 1.0 |
| fastapi-jwt | pypi | 32.0 | 32.5 | 0.0 | - (2 unresolved) xx | 0.0 | 0.0 |
| flask-proxy | pypi | 14.0 | 14.0 | 0.0 | 0.5 | 0.0 | 0.0 |
| langchain-rag | pypi | 70.0 | 70.0 | 0.0 | 0.0 x | 0.0 | 0.0 |
| pandas-pipeline | pypi | 60.0 | 60.0 | 0.0 | 0.0 | 0.0 | 0.0 |

## Build failures

**No docs**: none


**Context7**: none


**safectx MCP**: 

- mcp-server-ts r2: npm run build failed: `tsconfig.json(6,5): error TS5011: The common source directory of 'tsconfig.json' is './src'. The 'rootDir' setting must be explicitly set to this or another path to adjust your out`

**safectx hook only**: 

- fastapi-jwt r1: install failed: `× No solution found when resolving dependencies:`
- fastapi-jwt r2: install failed: `× No solution found when resolving dependencies:`
- langchain-rag r1: import check failed: `from langchain_text_splitters import RecursiveCharacterTextSplitter -> ModuleNotFoundError: No module named 'langchain_text_splitters'`

**safectx MCP + hook**: 

- mcp-server-ts r1: npm run build failed: `tsconfig.json(6,5): error TS5011: The common source directory of 'tsconfig.json' is './src'. The 'rootDir' setting must be explicitly set to this or another path to adjust your out`
- mcp-server-ts r2: npm run build failed: `tsconfig.json(6,5): error TS5011: The common source directory of 'tsconfig.json' is './src'. The 'rootDir' setting must be explicitly set to this or another path to adjust your out`

## safectx check-manifest vs npm audit / pip-audit (same lockfiles)

| | Lockfiles | Alerts (audit tool) | Alerts (safectx) | Vulnerable packages, mean Jaccard | Identical sets |
|---|---|---|---|---|---|
| npm (npm audit) | 84 | 723 | 729 | 0.98 | 81 |
| PyPI (pip-audit) | 42 | 706 | 723 | 0.98 | 41 |

Packages flagged by one side only (times seen):

- only safectx: @nuxt/nitro-server x3
- only safectx: nuxt x3
- only safectx: idna x1

## Vulnerable or non-existent direct pins, by arm

**No docs**: 

- idna@3.10 (2 advisories, CVSS 5.3; default 3.20.0) x4
- starlette@0.47.2 (12 advisories, CVSS 7.5; default 1.10.0) x2
- python-multipart@0.0.20 (14 advisories, CVSS 8.6; default 0.0.32) x2
- pyjwt@2.10.1 (32 advisories, CVSS 9.1; default 2.15.1) x2
- anyio@4.10.0 (4 advisories; default 4.15.1) x2
- click@8.2.1 (1 advisories; default 8.5.0) x2
- werkzeug@3.1.3 (8 advisories, CVSS 5.3; default 3.1.9) x2
- click@8.1.8 (1 advisories; default 8.5.0) x2
- urllib3@2.5.0 (12 advisories, CVSS 7.5; default 2.8.0) x2
- langchain@0.3.27 (4 advisories, CVSS 7.1; default 1.4.7) x2
- langchain-openai@0.3.28 (2 advisories, CVSS 3.1; default 1.7.3) x2
- langchain-core@0.3.72 (12 advisories, CVSS 9.3; default 1.7.1) x2
- langchain-text-splitters@0.3.9 (2 advisories, CVSS 6.5; default 1.1.3) x2
- pypdf@5.9.0 (108 advisories, CVSS 6.5; default 6.21.4) x2
- zod@3.25.76 (1 advisories, CVSS 7.5; default 4.6.7) x2
- next-auth@5.0.0-beta.25 (5 advisories, CVSS 7.5; default 4.24.15) x2
- urllib3@2.2.3 (16 advisories, CVSS 7.5; default 2.8.0) x2
- pillow@11.0.0 (86 advisories, CVSS 9.8; default 13.0.0) x2
- multer@2.0.2 (9 advisories, CVSS 7.5; default 2.5.0) x2
- sharp@0.34.3 (3 advisories; default 0.35.5) x2

**Context7**: 

- idna@3.10 (2 advisories, CVSS 5.3; default 3.20.0) x3
- werkzeug@3.1.3 (8 advisories, CVSS 5.3; default 3.1.9) x2
- click@8.1.8 (1 advisories; default 8.5.0) x2
- requests@2.32.4 (2 advisories, CVSS 5.5; default 2.34.2) x2
- urllib3@2.5.0 (12 advisories, CVSS 7.5; default 2.8.0) x2
- certifi@2025.6.15 (2 advisories; default 2026.10.23) x2
- langchain@0.3.27 (4 advisories, CVSS 7.1; default 1.4.7) x2
- langchain-core@0.3.72 (12 advisories, CVSS 9.3; default 1.7.1) x2
- langchain-openai@0.3.28 (2 advisories, CVSS 3.1; default 1.7.3) x2
- langchain-text-splitters@0.3.9 (2 advisories, CVSS 6.5; default 1.1.3) x2
- pypdf@5.9.0 (108 advisories, CVSS 6.5; default 6.21.4) x2
- zod@3.25.76 (1 advisories, CVSS 7.5; default 4.6.7) x2
- next-auth@5.0.0-beta.25 (5 advisories, CVSS 7.5; default 4.24.15) x2
- nuxt@3.17.5 (16 advisories, CVSS 8.1; default 4.6.3) x2
- urllib3@2.2.3 (16 advisories, CVSS 7.5; default 2.8.0) x2
- pillow@11.0.0 (86 advisories, CVSS 9.8; default 13.0.0) x2
- multer@2.0.2 (9 advisories, CVSS 7.5; default 2.5.0) x2
- sharp@0.34.3 (3 advisories; default 0.35.5) x2
- axios@1.12.2 (32 advisories, CVSS 8.7; default 1.21.0)
- form-data@4.0.4 (1 advisories, CVSS 7.5; default 4.0.6)

**safectx MCP**: none


**safectx hook only**: 

- idna@3.10 (2 advisories, CVSS 5.3; default 3.20.0) x4

**safectx MCP + hook**: none


## Reproduce

```bash
npm run build
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model sonnet --reps 2 --stamp <stamp>
npx tsx bench/agents/make-latest.ts <stamp>
npx tsx bench/agents/score.ts <stamp>
npx tsx bench/agents/report.ts <stamp>
```
