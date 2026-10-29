# Agent benchmark: no docs vs safectx

Run `v5-2026-10-29`, model `claude-sonnet-5-5`, 2 repetition(s) of 12 tasks per arm (8 npm, 4 PyPI). Each run is Claude Code in headless mode with only Write and Read as built-in tools (no shell, no web). The prompt is identical in every arm and asks for exact pinned versions. Arms differ only in what is attached: nothing, the safectx MCP server (its docs come from the packages themselves), the safectx pre-install hook alone, or both.

"No pin" has no agent: the packages the no-docs agent chose, installed without a version. Whole-tree alerts come from `npm audit` (lockfile resolved with `--package-lock-only`) and `pip-audit` (over `uv pip compile` output); neither shares code or data path with safectx, and both read the advisory data Dependabot alerts on. "Build" means a real `npm install` plus `npm run build`, `tsc --noEmit` or an import check for JavaScript, and for Python `uv pip install` plus executing every top-level import of the generated files. Builds that fail only because a native binary needs an install script (never run here) are left out as inconclusive.

| Metric | No docs | safectx MCP | safectx hook only | safectx MCP + hook | No pin (reference) |
|---|---|---|---|---|---|
| Runs with a manifest | 22 / 24 | 24 / 24 | 22 / 24 | 24 / 24 | 12 / 12 |
| Direct dependencies pinned | 136 | 129 | 132 | 131 | 76 |
| Direct deps with >= 1 advisory | 56 (41%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 35 (26%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 0 | 0 | 0 | 0 | 0 |
| Manifests that fail to resolve | 0 | 0 | 0 | 0 | 0 |
| Dependabot-style alerts, whole tree (sum) | 678 | 6 | 10 | 2 | 1 |
| Alerts per project (mean) | 30.8 | 0.3 | 0.5 | 0.1 | 0.1 |
| Projects with 0 alerts | 0 / 22 | 21 / 24 | 18 / 22 | 22 / 24 | 11 / 12 |
| Critical + high alerts (npm trees) | 159 | 2 | 4 | 0 | 0 |
| Projects that install | 22 / 22 | 24 / 24 | 22 / 22 | 24 / 24 | n/a |
| Projects that build / import cleanly | 22 / 22 | 24 / 24 | 22 / 22 | 22 / 24 | n/a |
| Median age of pinned version (days) | 695 | 32 | 168 | 35 | 30 |
| Direct deps on the registry default | 10% | 81% | 49% | 80% | 100% |
| Cost per run (USD, mean) | 0.03 | 0.05 | 0.04 | 0.05 | n/a |
| Turns per run (mean) | 4.1 | 6.2 | 5.8 | 6.1 | n/a |
| Duration per run (s, mean) | 13.6 | 18.0 | 26.9 | 20.4 | n/a |
| MCP calls per run (mean) | 0.0 | 2.2 | 0.0 | 2.3 | n/a |
| Hook blocks per run (mean) | 0.0 | 0.0 | 1.1 | 0.0 | n/a |

## Whole-tree alerts per task (mean over repetitions; x = did not build)

| Task | Ecosystem | No docs | safectx MCP | safectx hook only | safectx MCP + hook | No pin (reference) |
|---|---|---|---|---|---|---|
| next-auth-middleware | npm | 52.5 | 2.0 | 4.0 | 0.0 xx | 0.0 |
| express-jwt-api | npm | 8.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| axios-client | npm | 35.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| vite-react-spa | npm | 25.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| xml-yaml-parser | npm | 5.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| upload-sharp-s3 | npm | 20.0 (1 unresolved) | 0.0 | 0.0 | 0.0 | 0.0 |
| mcp-server-ts | npm | 9.0 | 0.0 | 0.0 (1 unresolved) | 0.0 | 0.0 |
| nuxt-app | npm | 23.0 | 1.0 | 1.0 | 1.0 | 1.0 |
| fastapi-jwt | pypi | 34.5 | 0.0 | 0.0 | 0.0 | 0.0 |
| flask-proxy | pypi | 15.0 (1 unresolved) | 0.0 | 0.0 | 0.0 | 0.0 |
| langchain-rag | pypi | 69.5 | 0.0 | 0.0 | 0.0 | 0.0 |
| pandas-pipeline | pypi | 60.0 | 0.0 | 0.0 (1 unresolved) | 0.0 | 0.0 |

## Build failures

**No docs**: none


**safectx MCP**: none


**safectx hook only**: none


**safectx MCP + hook**: 

- next-auth-middleware r1: npm run build failed: `Failed to compile.`
- next-auth-middleware r2: npm run build failed: `> Build error occurred`

## safectx check-manifest vs npm audit / pip-audit (same lockfiles)

| | Lockfiles | Alerts (audit tool) | Alerts (safectx) | Vulnerable packages, mean Jaccard | Identical sets |
|---|---|---|---|---|---|
| npm (npm audit) | 70 | 354 | 368 | 0.93 | 63 |
| PyPI (pip-audit) | 34 | 343 | 350 | 1.00 | 34 |

Packages flagged by one side only (times seen):

- only safectx: @nuxt/nitro-server x7
- only safectx: nuxt x7

## Vulnerable or non-existent direct pins, by arm

**No docs**: 

- idna@3.10 (2 advisories, CVSS 5.3; default 3.20.0) x3
- axios@1.7.9 (33 advisories, CVSS 8.7; default 1.21.0) x2
- form-data@4.0.1 (2 advisories, CVSS 7.5; default 4.0.6) x2
- h11@0.14.0 (2 advisories, CVSS 9.1; default 0.16.0) x2
- click@8.1.8 (1 advisories; default 8.5.0) x2
- langchain@0.3.27 (4 advisories, CVSS 7.1; default 1.4.7) x2
- next-auth@5.0.0-beta.25 (5 advisories, CVSS 7.5; default 4.24.15) x2
- nuxt@3.17.5 (16 advisories, CVSS 8.1; default 4.6.3) x2
- urllib3@2.2.3 (16 advisories, CVSS 7.5; default 2.8.0) x2
- pillow@11.0.0 (86 advisories, CVSS 9.8; default 13.0.0) x2
- vite@6.3.5 (12 advisories; default 8.3.5) x2
- js-yaml@4.1.0 (5 advisories, CVSS 7.5; default 5.5.0) x2
- starlette@0.38.6 (14 advisories, CVSS 7.5; default 1.10.0)
- python-multipart@0.0.9 (16 advisories, CVSS 8.6; default 0.0.32)
- pyjwt@2.9.0 (32 advisories, CVSS 9.1; default 2.15.1)
- anyio@4.6.0 (4 advisories; default 4.15.1)
- click@8.1.7 (1 advisories; default 8.5.0)
- starlette@0.41.3 (14 advisories, CVSS 7.5; default 1.10.0)
- pyjwt@2.10.1 (32 advisories, CVSS 9.1; default 2.15.1)
- python-multipart@0.0.20 (14 advisories, CVSS 8.6; default 0.0.32)

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
