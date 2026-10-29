# Agent benchmark: no docs vs Context7 vs safectx

Run `full-2026-10-29`, model `claude-sonnet-5-5`, 2 repetition(s) of 12 tasks per arm. Each run is Claude Code in headless mode with only Write and Read as built-in tools (no shell, no web); the arms differ only in the MCP server. The prompt is identical in every arm and asks for exact pinned versions.

The "No pin" column has no agent: it takes the packages the no-docs agent chose and installs them without a version. Whole-tree alerts come from `npm audit` (over a lockfile resolved with `--package-lock-only`) and from `pip-audit` (over `uv pip compile` output). Neither tool shares code or a data path with safectx, and both read the GitHub Advisory Database / PyPI advisories that Dependabot alerts on. Direct-dependency advisories and CVSS come from deps.dev.

| Metric | Agent, no docs | Agent + Context7 | Agent + safectx | No pin (`npm install x`) |
|---|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 24 / 24 | 12 / 12 |
| Direct dependencies pinned | 158 | 137 | 127 | 79 |
| Direct deps with >= 1 advisory | 66 (42%) | 56 (41%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 38 (24%) | 33 (24%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 0 | 0 | 0 | 0 |
| Deprecated direct deps | 2 | 0 | 0 | 0 |
| Manifests that fail to resolve | 0 | 0 | 0 | 0 |
| Dependabot-style alerts, whole tree (sum) | 763 | 632 | 2 | 1 |
| Alerts per project (mean) | 31.8 | 26.3 | 0.1 | 0.1 |
| Projects with 0 alerts | 0 / 24 | 2 / 24 | 22 / 24 | 11 / 12 |
| Critical + high alerts (npm trees) | 186 | 143 | 0 | 0 |
| Median age of pinned version (days) | 740 | 478 | 27 | 27 |
| Direct deps on the registry default | 11% | 18% | 87% | 100% |
| Cost per run (USD, mean) | 0.03 | 0.06 | 0.05 | n/a |
| Turns per run (mean) | 4.0 | 7.8 | 10.2 | n/a |
| Duration per run (s, mean) | 13.5 | 21.5 | 22.8 | n/a |
| MCP calls per run (mean) | 0.0 | 3.8 | 6.1 | n/a |

## Whole-tree alerts per task (mean over repetitions)

| Task | Ecosystem | Agent, no docs | Agent + Context7 | Agent + safectx | No pin (`npm install x`) |
|---|---|---|---|---|---|
| next-auth-middleware | npm | 51.5 | 48.0 | 0.0 | 0.0 |
| express-jwt-api | npm | 8.0 | 0.0 | 0.0 | 0.0 |
| axios-client | npm | 35.0 | 35.5 | 0.0 | 0.0 |
| vite-react-spa | npm | 25.0 | 21.5 | 0.0 | 0.0 |
| xml-yaml-parser | npm | 5.0 | 4.0 | 0.0 | 0.0 |
| upload-sharp-s3 | npm | 27.5 | 14.5 | 0.0 | 0.0 |
| mcp-server-ts | npm | 9.0 | 5.0 | 0.0 | 0.0 |
| nuxt-app | npm | 38.0 | 24.0 | 1.0 | 1.0 |
| fastapi-jwt | pypi | 35.0 | 32.0 | 0.0 | 0.0 |
| flask-proxy | pypi | 17.0 | 10.0 | 0.0 | 0.0 |
| langchain-rag | pypi | 69.5 | 68.0 | 0.0 | 0.0 |
| pandas-pipeline | pypi | 61.0 | 53.5 | 0.0 | 0.0 |

## Vulnerable or non-existent direct pins, by arm

**Agent, no docs**: 

- idna@3.10 (2 advisories, CVSS 5.3; default 3.20.0) x4
- click@8.1.7 (1 advisories; default 8.5.0) x3
- axios@1.7.9 (33 advisories, CVSS 8.7; default 1.21.0) x2
- form-data@4.0.1 (2 advisories, CVSS 7.5; default 4.0.6) x2
- starlette@0.38.6 (14 advisories, CVSS 7.5; default 1.10.0) x2
- anyio@4.6.0 (4 advisories; default 4.15.1) x2
- h11@0.14.0 (2 advisories, CVSS 9.1; default 0.16.0) x2
- python-multipart@0.0.9 (16 advisories, CVSS 8.6; default 0.0.32) x2
- pyjwt@2.9.0 (32 advisories, CVSS 9.1; default 2.15.1) x2
- urllib3@2.2.3 (16 advisories, CVSS 7.5; default 2.8.0) x2
- urllib3@2.5.0 (12 advisories, CVSS 7.5; default 2.8.0) x2
- langchain@0.3.27 (4 advisories, CVSS 7.1; default 1.4.7) x2
- zod@3.25.76 (1 advisories, CVSS 7.5; default 4.6.7) x2
- next-auth@5.0.0-beta.25 (5 advisories, CVSS 7.5; default 4.24.15) x2
- multer@2.0.2 (9 advisories, CVSS 7.5; default 2.5.0) x2
- sharp@0.34.3 (3 advisories; default 0.35.5) x2
- vite@6.3.5 (12 advisories; default 8.3.5) x2
- js-yaml@4.1.0 (5 advisories, CVSS 7.5; default 5.5.0) x2
- flask@3.0.3 (2 advisories, CVSS 4.3; default 3.1.3)
- werkzeug@3.0.6 (8 advisories, CVSS 5.3; default 3.1.9)
- jinja2@3.1.4 (6 advisories, CVSS 8.8; default 3.1.6)
- requests@2.32.3 (4 advisories, CVSS 5.5; default 2.34.2)
- certifi@2024.8.30 (2 advisories; default 2026.10.23)
- flask@3.1.1 (2 advisories, CVSS 4.3; default 3.1.3)
- werkzeug@3.1.3 (8 advisories, CVSS 5.3; default 3.1.9)
- click@8.2.1 (1 advisories; default 8.5.0)
- requests@2.32.4 (2 advisories, CVSS 5.5; default 2.34.2)
- certifi@2025.6.15 (2 advisories; default 2026.10.23)
- langchain-openai@0.3.28 (2 advisories, CVSS 3.1; default 1.7.3)
- langchain-core@0.3.72 (12 advisories, CVSS 9.3; default 1.7.1)
- langchain-text-splitters@0.3.9 (2 advisories, CVSS 6.5; default 1.1.3)
- pypdf@5.9.0 (108 advisories, CVSS 6.5; default 6.21.4)
- langchain-openai@0.3.35 (2 advisories, CVSS 3.1; default 1.7.3)
- langchain-core@0.3.78 (12 advisories, CVSS 9.3; default 1.7.1)
- langchain-text-splitters@0.3.11 (2 advisories, CVSS 6.5; default 1.1.3)
- pypdf@6.1.1 (106 advisories, CVSS 6.5; default 6.21.4)
- @modelcontextprotocol/sdk@1.17.4 (8 advisories, CVSS 7.5; default 1.32.2)
- @modelcontextprotocol/sdk@1.17.0 (8 advisories, CVSS 7.5; default 1.32.2)
- next@15.1.0 (35 advisories, CVSS 10; default 16.4.3)
- next@15.1.6 (36 advisories, CVSS 10; default 16.4.3)
- nuxt@3.13.2 (17 advisories, CVSS 8.1; default 4.6.3)
- nuxt@4.1.2 (17 advisories, CVSS 8.1; default 4.6.3)
- pillow@11.0.0 (86 advisories, CVSS 9.8; default 13.0.0)
- pillow@11.3.0 (93 advisories, CVSS 9.8; default 13.0.0)
- react-router@7.6.0 (13 advisories, CVSS 8.2; default 8.5.1)

**Agent + Context7**: 

- idna@3.10 (2 advisories, CVSS 5.3; default 3.20.0) x3
- urllib3@2.5.0 (12 advisories, CVSS 7.5; default 2.8.0) x3
- python-multipart@0.0.20 (14 advisories, CVSS 8.6; default 0.0.32) x2
- pyjwt@2.10.1 (32 advisories, CVSS 9.1; default 2.15.1) x2
- click@8.1.8 (1 advisories; default 8.5.0) x2
- flask@3.1.2 (2 advisories, CVSS 4.3; default 3.1.3) x2
- certifi@2025.8.3 (2 advisories; default 2026.10.23) x2
- langchain@0.3.27 (4 advisories, CVSS 7.1; default 1.4.7) x2
- langchain-openai@0.3.35 (2 advisories, CVSS 3.1; default 1.7.3) x2
- langchain-core@0.3.79 (12 advisories, CVSS 9.3; default 1.7.1) x2
- langchain-text-splitters@0.3.11 (2 advisories, CVSS 6.5; default 1.1.3) x2
- next@15.1.11 (32 advisories, CVSS 9.1; default 16.4.3) x2
- next-auth@5.0.0-beta.25 (5 advisories, CVSS 7.5; default 4.24.15) x2
- axios@1.13.2 (35 advisories, CVSS 8.7; default 1.21.0)
- form-data@4.0.4 (1 advisories, CVSS 7.5; default 4.0.6)
- axios@1.7.9 (33 advisories, CVSS 8.7; default 1.21.0)
- form-data@4.0.1 (2 advisories, CVSS 7.5; default 4.0.6)
- starlette@0.41.3 (14 advisories, CVSS 7.5; default 1.10.0)
- anyio@4.8.0 (4 advisories; default 4.15.1)
- h11@0.14.0 (2 advisories, CVSS 9.1; default 0.16.0)
- click@8.2.1 (1 advisories; default 8.5.0)
- urllib3@2.7.0 (6 advisories; default 2.8.0)
- werkzeug@3.1.3 (8 advisories, CVSS 5.3; default 3.1.9)
- requests@2.32.5 (2 advisories, CVSS 5.5; default 2.34.2)
- pypdf@6.1.3 (102 advisories, CVSS 6.5; default 6.21.4)
- pypdf@6.1.1 (106 advisories, CVSS 6.5; default 6.21.4)
- zod@4.3.6 (1 advisories, CVSS 7.5; default 4.6.7)
- @modelcontextprotocol/sdk@1.17.0 (8 advisories, CVSS 7.5; default 1.32.2)
- zod@3.25.76 (1 advisories, CVSS 7.5; default 4.6.7)
- nuxt@4.1.3 (17 advisories, CVSS 8.1; default 4.6.3)
- nuxt@4.1.0 (17 advisories, CVSS 8.1; default 4.6.3)
- pillow@12.3.0 (59 advisories, CVSS 9.8; default 13.0.0)
- pillow@11.3.0 (93 advisories, CVSS 9.8; default 13.0.0)
- multer@2.4.0 (1 advisories, CVSS 7.5; default 2.5.0)
- multer@2.0.2 (9 advisories, CVSS 7.5; default 2.5.0)
- sharp@0.34.3 (3 advisories; default 0.35.5)
- react-router@7.9.4 (13 advisories, CVSS 8.2; default 8.5.1)
- vite@7.3.5 (5 advisories; default 8.3.5)
- vite@7.1.5 (11 advisories; default 8.3.5)
- js-yaml@5.2.0 (3 advisories, CVSS 7.5; default 5.5.0)
- js-yaml@4.1.0 (5 advisories, CVSS 7.5; default 5.5.0)

**Agent + safectx**: none


## Reproduce

```bash
npm run build
npx tsx bench/agents/run.ts --model sonnet --reps 2 --stamp <stamp>
npx tsx bench/agents/make-latest.ts <stamp>
npx tsx bench/agents/score.ts <stamp>
npx tsx bench/agents/report.ts <stamp>
```
