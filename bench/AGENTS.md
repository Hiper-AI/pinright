# Agent benchmark: no docs vs safectx

Run `v4-2026-10-29`, model `claude-sonnet-5-5`, 2 repetition(s) of 12 tasks per arm (8 npm, 4 PyPI). Each run is Claude Code in headless mode with only Write and Read as built-in tools (no shell, no web). The prompt is identical in every arm and asks for exact pinned versions. Arms differ only in what is attached: nothing, the safectx MCP server (its docs come from the packages themselves), the safectx pre-install hook alone, or both.

"No pin" has no agent: the packages the no-docs agent chose, installed without a version. Whole-tree alerts come from `npm audit` (lockfile resolved with `--package-lock-only`) and `pip-audit` (over `uv pip compile` output); neither shares code or data path with safectx, and both read the advisory data Dependabot alerts on. "Build" means a real `npm install` plus `npm run build`, `tsc --noEmit` or an import check for JavaScript, and for Python `uv pip install` plus executing every top-level import of the generated files. Builds that fail only because a native binary needs an install script (never run here) are left out as inconclusive.

| Metric | No docs | safectx MCP | safectx hook only | safectx MCP + hook | No pin (reference) |
|---|---|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | 12 / 12 |
| Direct dependencies pinned | 157 | 133 | 157 | 132 | 78 |
| Direct deps with >= 1 advisory | 64 (41%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 36 (23%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 0 | 0 | 0 | 0 | 0 |
| Manifests that fail to resolve | 0 | 0 | 0 | 0 | 0 |
| Dependabot-style alerts, whole tree (sum) | 749 | 2 | 10 | 2 | 1 |
| Alerts per project (mean) | 31.2 | 0.1 | 0.4 | 0.1 | 0.1 |
| Projects with 0 alerts | 0 / 24 | 22 / 24 | 20 / 24 | 22 / 24 | 11 / 12 |
| Critical + high alerts (npm trees) | 181 | 0 | 4 | 0 | 0 |
| Projects that install | 24 / 24 | 24 / 24 | 24 / 24 | 24 / 24 | n/a |
| Projects that build / import cleanly | 24 / 24 | 23 / 24 | 22 / 24 | 23 / 24 | n/a |
| Median age of pinned version (days) | 720 | 32 | 387 | 34 | 27 |
| Direct deps on the registry default | 10% | 82% | 48% | 79% | 100% |
| Cost per run (USD, mean) | 0.03 | 0.05 | 0.04 | 0.05 | n/a |
| Turns per run (mean) | 3.9 | 6.3 | 5.7 | 6.6 | n/a |
| Duration per run (s, mean) | 13.6 | 17.0 | 25.4 | 20.5 | n/a |
| MCP calls per run (mean) | 0.0 | 2.3 | 0.0 | 2.5 | n/a |
| Hook blocks per run (mean) | 0.0 | 0.0 | 1.2 | 0.0 | n/a |

## Whole-tree alerts per task (mean over repetitions; x = did not build)

| Task | Ecosystem | No docs | safectx MCP | safectx hook only | safectx MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|
| next-auth-middleware | npm | 49.0 | 0.0 x | 4.0 | 0.0 x | 0.0 |
| express-jwt-api | npm | 8.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| axios-client | npm | 35.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| vite-react-spa | npm | 24.5 | 0.0 | 0.0 | 0.0 | 0.0 |
| xml-yaml-parser | npm | 5.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| upload-sharp-s3 | npm | 28.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| mcp-server-ts | npm | 9.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| nuxt-app | npm | 37.5 | 1.0 | 1.0 | 1.0 | 1.0 |
| fastapi-jwt | pypi | 34.5 | 0.0 | 0.0 | 0.0 | 0.0 |
| flask-proxy | pypi | 14.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| langchain-rag | pypi | 70.0 | 0.0 | 0.0 xx | 0.0 | 0.0 |
| pandas-pipeline | pypi | 60.0 | 0.0 | 0.0 | 0.0 | 0.0 |

## Build failures

**No docs**: none


**safectx MCP**: 

- next-auth-middleware r1: npm run build failed: `> Build error occurred`

**safectx hook only**: 

- langchain-rag r1: import check failed: `from langchain_text_splitters import RecursiveCharacterTextSplitter -> ModuleNotFoundError: No module named 'langchain_text_splitters'`
- langchain-rag r2: import check failed: `from langchain_text_splitters import RecursiveCharacterTextSplitter -> ModuleNotFoundError: No module named 'langchain_text_splitters'`

**safectx MCP + hook**: 

- next-auth-middleware r2: npm run build failed: `> Build error occurred`

## safectx check-manifest vs npm audit / pip-audit (same lockfiles)

| | Lockfiles | Alerts (audit tool) | Alerts (safectx) | Vulnerable packages, mean Jaccard | Identical sets |
|---|---|---|---|---|---|
| npm (npm audit) | 72 | 407 | 431 | 0.94 | 65 |
| PyPI (pip-audit) | 36 | 357 | 365 | 1.00 | 36 |

Packages flagged by one side only (times seen):

- only safectx: @nuxt/nitro-server x7
- only safectx: nuxt x7

## Vulnerable or non-existent direct pins, by arm

**No docs**: 

- idna@3.10 (2 advisories, CVSS 5.3; default 3.20.0) x4
- axios@1.7.9 (33 advisories, CVSS 8.7; default 1.21.0) x2
- form-data@4.0.1 (2 advisories, CVSS 7.5; default 4.0.6) x2
- h11@0.14.0 (2 advisories, CVSS 9.1; default 0.16.0) x2
- click@8.1.7 (1 advisories; default 8.5.0) x2
- werkzeug@3.1.3 (8 advisories, CVSS 5.3; default 3.1.9) x2
- requests@2.32.4 (2 advisories, CVSS 5.5; default 2.34.2) x2
- urllib3@2.5.0 (12 advisories, CVSS 7.5; default 2.8.0) x2
- certifi@2025.6.15 (2 advisories; default 2026.10.23) x2
- langchain@0.3.27 (4 advisories, CVSS 7.1; default 1.4.7) x2
- langchain-openai@0.3.28 (2 advisories, CVSS 3.1; default 1.7.3) x2
- langchain-text-splitters@0.3.9 (2 advisories, CVSS 6.5; default 1.1.3) x2
- pypdf@5.9.0 (108 advisories, CVSS 6.5; default 6.21.4) x2
- zod@3.25.76 (1 advisories, CVSS 7.5; default 4.6.7) x2
- next@15.5.7 (34 advisories, CVSS 9; default 16.4.3) x2
- next-auth@5.0.0-beta.25 (5 advisories, CVSS 7.5; default 4.24.15) x2
- urllib3@2.2.3 (16 advisories, CVSS 7.5; default 2.8.0) x2
- pillow@11.0.0 (86 advisories, CVSS 9.8; default 13.0.0) x2
- multer@2.0.2 (9 advisories, CVSS 7.5; default 2.5.0) x2
- sharp@0.34.3 (3 advisories; default 0.35.5) x2

**safectx MCP**: none


**safectx hook only**: none


**safectx MCP + hook**: none


## Reproduce

```bash
npm run build
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model sonnet --reps 2 --stamp <stamp>
npx tsx bench/agents/make-latest.ts <stamp>
npx tsx bench/agents/score.ts <stamp>
npx tsx bench/agents/report.ts <stamp>
```
