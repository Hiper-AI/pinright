# Agent benchmark, real-issues set: per-model details

<!-- generated:start -->
Runs: `real-issues-sonnet` (Sonnet 5.5, 2 repetition(s)), `real-issues-opus` (Opus 5.5, 2 repetition(s)), `real-issues-haiku` (Haiku 5.5, 2 repetition(s)). 12 tasks per arm (6 npm, 6 PyPI). Intervals in brackets are 95% cluster-bootstrap intervals that resample tasks; with 12 tasks they are wide, and two arms whose intervals overlap are not shown to differ.

## Sonnet 5.5 (`claude-sonnet-5-5`, run `real-issues-sonnet`, 2 repetition(s))

| Metric | No docs | pinright MCP | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 23 / 24 | 12 / 12 |
| Direct dependencies pinned | 107 | 106 | 99 | 56 |
| Direct deps with >= 1 advisory | 24 (26%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 18 (20%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 15 | 0 | 0 | 0 |
| Manifests that fail to resolve | 1 | 0 | 1 | 0 |
| Dependabot-style alerts, whole tree (sum) | 504 | 114 | 58 | 56 |
| Alerts per project (mean [95% CI]) | 21.9 [10.5, 33.7] | 4.8 [0.0, 14.2] | 2.6 [0.0, 8.9] | 4.7 [0.0, 14.0] |
| Projects with 0 alerts | 6 / 23 | 20 / 24 | 19 / 22 | 11 / 12 |
| Critical + high alerts (npm trees) | 169 | 0 | 0 | 0 |
| Projects that install | 22 / 24 | 24 / 24 | 22 / 23 | n/a |
| Projects that build / import cleanly | 9 / 24 | 18 / 24 | 14 / 23 | n/a |
| Median age of pinned version (days) | 577 | 21 | 20 | 20 |
| Direct deps on the registry default | 1% | 61% | 69% | 100% |
| API-equivalent cost per run (USD, list price, mean) | 0.040 | 0.071 | 0.080 | n/a |
| API-equivalent cost, all runs of the arm (USD, list price) | 0.96 | 1.72 | 1.93 | n/a |
| Turns per run (mean) | 4.1 | 7.0 | 7.1 | n/a |
| Duration per run (s, mean) | 19.3 | 30.7 | 40.5 | n/a |
| MCP calls per run (mean) | 0.0 | 2.6 | 2.7 | n/a |
| Hook blocks per run (mean) | 0.0 | 0.0 | 0.0 | n/a |

### Whole-tree alerts per task, Sonnet 5.5

Mean over repetitions, (min-max) when they differ; x = did not build.

| Task | Ecosystem | No docs | pinright MCP | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|
| mcp-hono | npm | 54.5 (54.0-55.0) xx | 0.0 | 0.0 | 0.0 |
| proton-drive-example | npm | 1.0 (0.0-2.0) x | 0.0 xx | 0.0 xx | 0.0 |
| mastra-deep-research | npm | 19.5 (19.0-20.0) | 0.0 xx | 0.0 xx | 0.0 |
| assistant-ui-mcp-tools | npm | 51.0 xx | 0.0 | 0.0 xx | 0.0 |
| next-gh-pages | npm | 39.5 (38.0-41.0) | 0.0 | 0.0 (1 no manifest) | 0.0 |
| openapi-fetch-next | npm | 44.5 (44.0-45.0) xx | 1.0 xx | 1.0 xx | 0.0 |
| mcp-remote-oauth | pypi | 6.5 (6.0-7.0) xx | 0.0 | 0.0 | 0.0 |
| kittentts-streaming | pypi | 0.0 | 0.0 | 0.0 | 0.0 |
| openevolve-symreg | pypi | 0.0 | 0.0 | 0.0 | 0.0 |
| pydantic-ai-deep-research | pypi | 6.0 xx | 0.0 | 0.0 | 0.0 |
| stirrup-gdpval | pypi | 29.0 (0.0-58.0) xx | 56.0 | 56.0 (1 unresolved) x | 56.0 |
| livekit-ultravox | pypi | 1.0 (1 unresolved) xx | 0.0 | 0.0 | 0.0 |

### Runs without a manifest or that do not build, Sonnet 5.5

**No docs**: 

- assistant-ui-mcp-tools r1: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "app\api\chat\route.ts" "app\layout.tsx" "app\page.tsx" failed: `app/layout.tsx(3,5): error TS17004: Cannot use JSX unless the '--jsx' flag is provided.`
- assistant-ui-mcp-tools r2: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "app\api\chat\route.ts" "app\layout.tsx" "app\page.tsx" failed: `app/layout.tsx(3,5): error TS17004: Cannot use JSX unless the '--jsx' flag is provided.`
- livekit-ultravox r1: import check failed: `from livekit.plugins import openai, silero -> ModuleNotFoundError: No module named 'httpx'`
- livekit-ultravox r2: install failed: `× No solution found when resolving dependencies:`
- mcp-hono r1: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "server.ts" failed: `server.ts(11,3): error TS2589: Type instantiation is excessively deep and possibly infinite.`
- mcp-hono r2: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "server.ts" failed: `server.ts(10,3): error TS2589: Type instantiation is excessively deep and possibly infinite.`
- mcp-remote-oauth r1: import check failed: `from mcp.server.auth.provider import ( AccessToken, AuthorizationCode, AuthorizationParams, RefreshToken, construct_redirect_uri, ) -> ImportError: cannot import name 'eval_type_ba`
- mcp-remote-oauth r2: import check failed: `from mcp.server.auth.provider import AccessToken, TokenVerifier -> ImportError: cannot import name 'eval_type_backport' from 'pydantic._internal._typing_extra'`
- openapi-fetch-next r1: install failed: `npm warn deprecated next@15.0.3: This version has a security vulnerability. Please upgrade to a patched version. See https://nextjs.org/blog/CVE-2025-66478 for more details.`
- openapi-fetch-next r2: npm run build failed: `⨯ page.tsx doesn't have a root layout. To fix this error, make sure every page has a root layout.`
- proton-drive-example r1: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(19,8): error TS2305: Module '"@protontech/drive-sdk"' has no exported member 'SRPModule'.`
- pydantic-ai-deep-research r1: import check failed: `from pydantic_ai import Agent -> ModuleNotFoundError: No module named 'opentelemetry._events'`
- pydantic-ai-deep-research r2: import check failed: `from pydantic_ai import Agent -> ModuleNotFoundError: No module named 'opentelemetry._events'`
- stirrup-gdpval r1: import check failed: `from stirrup import Agent -> ModuleNotFoundError: No module named 'rich'`
- stirrup-gdpval r2: import check failed: `from stirrup import Agent -> ModuleNotFoundError: No module named 'rich'`

**pinright MCP**: 

- mastra-deep-research r1: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(45,18): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node'.`
- mastra-deep-research r2: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(16,34): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node'.`
- openapi-fetch-next r1: npm run build failed: `> Build error occurred`
- openapi-fetch-next r2: npm run build failed: `> Build error occurred`
- proton-drive-example r1: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\crypto.ts" "src\index.ts" failed: `../../../../../Juan Mandelbaum/AppData/Local/Temp/sctx-build-jsHXpZ/node_modules/@protontech/crypto/src/constants.ts(2,52): error TS5097: An import path can only end with a '.ts' e`
- proton-drive-example r2: import check failed: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module ' imported from`

**pinright MCP + hook**: 

- next-gh-pages r2: no manifest written (agent finished, 11 turns)
- assistant-ui-mcp-tools r1: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "app\api\chat\route.ts" "app\layout.tsx" "app\page.tsx" failed: `app/layout.tsx(3,5): error TS17004: Cannot use JSX unless the '--jsx' flag is provided.`
- assistant-ui-mcp-tools r2: npx -y -p typescript tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "app\api\chat\route.ts" "app\layout.tsx" "app\page.tsx" "app\toolkit.tsx" failed: `app/api/chat/route.ts(20,37): error TS2591: Cannot find name 'process'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node' and then add 'node' to `
- mastra-deep-research r1: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(17,79): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node'.`
- mastra-deep-research r2: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(20,79): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node'.`
- openapi-fetch-next r1: npm run build failed: `> Build error occurred`
- openapi-fetch-next r2: npm run build failed: `> Build error occurred`
- proton-drive-example r1: import check failed: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module ' imported from`
- proton-drive-example r2: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "index.ts" failed: `../../../../../Juan Mandelbaum/AppData/Local/Temp/sctx-build-i6568k/node_modules/@protontech/crypto/src/constants.ts(2,52): error TS5097: An import path can only end with a '.ts' e`
- stirrup-gdpval r2: install failed: `× No solution found when resolving dependencies:`

### Vulnerable or non-existent direct pins, Sonnet 5.5

**No docs**: 

- ai@4.3.16 (1 advisories, CVSS 3.7; default 7.0.162) x2
- next@15.3.3 (36 advisories, CVSS 10; default 16.4.4) x2
- zod@3.25.67 (1 advisories, CVSS 7.5; default 4.6.7) x2
- kittentts@@ (does not exist) x2
- stirrup@0.1.0 (does not exist) x2
- datasets@4.0.0 (does not exist) x2
- python-dotenv@1.1.0 (2 advisories, CVSS 6.6; default 1.2.4)
- livekit-plugins-openai@1.0.0 (does not exist)
- livekit-plugins-silero@1.0.0 (does not exist)
- python-dotenv@1.0.1 (2 advisories, CVSS 6.6; default 1.2.4)
- zod@3.24.2 (1 advisories, CVSS 7.5; default 4.6.7)
- @types/node@22.15.0 (does not exist)
- tsx@4.19.2 (does not exist)
- @hono/node-server@1.14.2 (3 advisories; default 2.1.6)
- @modelcontextprotocol/sdk@1.12.0 (8 advisories, CVSS 7.5; default 1.32.2)
- ... 18 more

**pinright MCP**: none


**pinright MCP + hook**: none


## Opus 5.5 (`claude-opus-5-5`, run `real-issues-opus`, 2 repetition(s))

| Metric | No docs | pinright MCP | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 24 / 24 | 12 / 12 |
| Direct dependencies pinned | 121 | 118 | 123 | 63 |
| Direct deps with >= 1 advisory | 30 (26%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 22 (19%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 5 | 0 | 0 | 0 |
| Manifests that fail to resolve | 0 | 0 | 2 | 0 |
| Dependabot-style alerts, whole tree (sum) | 600 | 116 | 3 | 57 |
| Alerts per project (mean [95% CI]) | 25.0 [12.5, 38.3] | 4.8 [0.0, 14.3] | 0.1 [0.0, 0.3] | 4.8 [0.0, 14.2] |
| Projects with 0 alerts | 5 / 24 | 18 / 24 | 19 / 22 | 10 / 12 |
| Critical + high alerts (npm trees) | 173 | 2 | 1 | 0 |
| Projects that install | 24 / 24 | 24 / 24 | 22 / 24 | n/a |
| Projects that build / import cleanly | 15 / 24 | 19 / 24 | 18 / 24 | n/a |
| Median age of pinned version (days) | 539 | 21 | 21 | 20 |
| Direct deps on the registry default | 0% | 67% | 68% | 100% |
| API-equivalent cost per run (USD, list price, mean) | 0.156 | 0.299 | 0.319 | n/a |
| API-equivalent cost, all runs of the arm (USD, list price) | 3.73 | 7.18 | 7.66 | n/a |
| Turns per run (mean) | 5.0 | 9.9 | 10.2 | n/a |
| Duration per run (s, mean) | 51.0 | 78.1 | 87.9 | n/a |
| MCP calls per run (mean) | 0.0 | 4.4 | 4.8 | n/a |
| Hook blocks per run (mean) | 0.0 | 0.0 | 0.0 | n/a |

### Whole-tree alerts per task, Opus 5.5

Mean over repetitions, (min-max) when they differ; x = did not build.

| Task | Ecosystem | No docs | pinright MCP | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|
| mcp-hono | npm | 55.0 x | 0.0 | 0.0 | 0.0 |
| proton-drive-example | npm | 0.5 (0.0-1.0) | 0.0 xx | 0.0 xx | 0.0 |
| mastra-deep-research | npm | 20.0 | 1.0 xx | 0.5 (0.0-1.0) xx | 0.0 |
| assistant-ui-mcp-tools | npm | 47.5 (44.0-51.0) xx | 0.0 | 0.0 | 0.0 |
| next-gh-pages | npm | 43.5 (43.0-44.0) | 0.0 | 0.0 | 0.0 |
| openapi-fetch-next | npm | 44.0 | 1.0 x | 1.0 | 1.0 |
| mcp-remote-oauth | pypi | 7.0 x | 0.0 | 0.0 | 0.0 |
| kittentts-streaming | pypi | 0.0 | 0.0 | 0.0 | 0.0 |
| openevolve-symreg | pypi | 0.0 | 0.0 | 0.0 | 0.0 |
| pydantic-ai-deep-research | pypi | 3.0 xx | 0.0 | 0.0 | 0.0 |
| stirrup-gdpval | pypi | 58.0 xx | 56.0 | - (2 unresolved) xx | 56.0 |
| livekit-ultravox | pypi | 21.5 (1.0-42.0) x | 0.0 | 0.0 | 0.0 |

### Runs without a manifest or that do not build, Opus 5.5

**No docs**: 

- assistant-ui-mcp-tools r1: npx -y -p typescript tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "server\index.ts" "server\mcp-server.ts" "src\main.tsx" "vite.config.ts" failed: `server/index.ts(4,21): error TS7016: Could not find a declaration file for module 'express'. 'C:/Users/Juan Mandelbaum/AppData/Local/Temp/sctx-build-dMW1ko/node_modules/express/ind`
- assistant-ui-mcp-tools r2: npm run build failed: `Failed to compile.`
- livekit-ultravox r1: import check failed: `from livekit.plugins import deepgram, openai, silero -> ModuleNotFoundError: No module named 'httpx'`
- mcp-hono r1: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\app.ts" "src\node.ts" failed: `src/app.ts(11,3): error TS2589: Type instantiation is excessively deep and possibly infinite.`
- mcp-remote-oauth r1: import check failed: `from mcp.server.auth.provider import AccessToken, TokenVerifier -> ImportError: cannot import name 'eval_type_backport' from 'pydantic._internal._typing_extra'`
- pydantic-ai-deep-research r1: import check failed: `from pydantic_ai import Agent -> ModuleNotFoundError: No module named 'opentelemetry._events'`
- pydantic-ai-deep-research r2: import check failed: `from pydantic_ai import Agent -> ModuleNotFoundError: No module named 'opentelemetry._events'`
- stirrup-gdpval r1: import check failed: `from stirrup import Agent -> ModuleNotFoundError: No module named 'rich'`
- stirrup-gdpval r2: import check failed: `from stirrup import Agent -> ModuleNotFoundError: No module named 'rich'`

**pinright MCP**: 

- mastra-deep-research r1: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(9,17): error TS2351: This expression is not constructable.`
- mastra-deep-research r2: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(8,17): error TS2351: This expression is not constructable.`
- openapi-fetch-next r2: npm run build failed: `Failed to type check.`
- proton-drive-example r1: npx -y -p typescript tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\drive.ts" "src\list.ts" "src\upload.ts" failed: `src/drive.ts(4,41): error TS2591: Cannot find name 'node:crypto'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node' and then add 'node' to the ty`
- proton-drive-example r2: npx -y -p typescript tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\auth.ts" "src\index.ts" failed: `src/auth.ts(2,41): error TS2591: Cannot find name 'node:crypto'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node' and then add 'node' to the typ`

**pinright MCP + hook**: 

- mastra-deep-research r1: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(7,15): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node'.`
- mastra-deep-research r2: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(8,17): error TS2351: This expression is not constructable.`
- proton-drive-example r1: npx -y -p typescript tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\auth.ts" "src\drive.ts" "src\main.ts" failed: `src/auth.ts(3,41): error TS2591: Cannot find name 'node:crypto'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node' and then add 'node' to the typ`
- proton-drive-example r2: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\main.ts" "src\proton.ts" failed: `../../../../../Juan Mandelbaum/AppData/Local/Temp/sctx-build-qQBwtR/node_modules/@protontech/crypto/src/constants.ts(2,52): error TS5097: An import path can only end with a '.ts' e`
- stirrup-gdpval r1: install failed: `× No solution found when resolving dependencies:`
- stirrup-gdpval r2: install failed: `× No solution found when resolving dependencies:`

### Vulnerable or non-existent direct pins, Opus 5.5

**No docs**: 

- next@15.3.3 (36 advisories, CVSS 10; default 16.4.4) x4
- @modelcontextprotocol/sdk@1.17.0 (8 advisories, CVSS 7.5; default 1.32.2) x2
- zod@3.25.76 (1 advisories, CVSS 7.5; default 4.6.7) x2
- ai@4.3.16 (1 advisories, CVSS 3.7; default 7.0.162) x2
- kittentts@@ (does not exist) x2
- zod@3.24.2 (1 advisories, CVSS 7.5; default 4.6.7) x2
- @hono/node-server@1.14.1 (3 advisories, CVSS 7.5; default 2.1.6) x2
- fetch-to-node@2.1.0 (does not exist) x2
- hono@4.7.10 (43 advisories, CVSS 8.2; default 4.13.16) x2
- mcp@1.12.4 (10 advisories, CVSS 7.5; default 2.3.0) x2
- pydantic-ai-slim@1.0.0 (6 advisories, CVSS 8.6; default 2.64.0) x2
- vite@7.1.3 (13 advisories; default 8.3.5)
- python-dotenv@1.0.1 (2 advisories, CVSS 6.6; default 1.2.4)
- aiohttp@3.11.18 (74 advisories, CVSS 9.1; default 3.14.5)
- python-dotenv@1.1.0 (2 advisories, CVSS 6.6; default 1.2.4)
- ... 7 more

**pinright MCP**: none


**pinright MCP + hook**: none


## Haiku 5.5 (`claude-haiku-5-5`, run `real-issues-haiku`, 2 repetition(s))

| Metric | No docs | pinright MCP | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|
| Runs with a manifest | 24 / 24 | 24 / 24 | 24 / 24 | 12 / 12 |
| Direct dependencies pinned | 93 | 103 | 102 | 45 |
| Direct deps with >= 1 advisory | 27 (29%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Direct deps with CVSS >= 7 | 21 (23%) | 0 (0%) | 0 (0%) | 0 (0%) |
| Pinned version or package does not exist | 1 | 0 | 0 | 0 |
| Manifests that fail to resolve | 1 | 0 | 1 | 0 |
| Dependabot-style alerts, whole tree (sum) | 514 | 114 | 56 | 70 |
| Alerts per project (mean [95% CI]) | 22.3 [9.5, 36.9] | 4.8 [0.0, 14.2] | 2.4 [0.0, 8.0] | 5.8 [0.0, 17.4] |
| Projects with 0 alerts | 5 / 23 | 20 / 24 | 22 / 23 | 10 / 12 |
| Critical + high alerts (npm trees) | 146 | 0 | 0 | 0 |
| Projects that install | 23 / 24 | 24 / 24 | 23 / 24 | n/a |
| Projects that build / import cleanly | 9 / 24 | 17 / 24 | 14 / 24 | n/a |
| Median age of pinned version (days) | 452 | 21 | 20 | 20 |
| Direct deps on the registry default | 0% | 67% | 68% | 100% |
| API-equivalent cost per run (USD, list price, mean) | 0.004 | 0.008 | 0.009 | n/a |
| API-equivalent cost, all runs of the arm (USD, list price) | 0.10 | 0.19 | 0.22 | n/a |
| Turns per run (mean) | 4.2 | 8.5 | 9.1 | n/a |
| Duration per run (s, mean) | 33.1 | 56.3 | 69.9 | n/a |
| MCP calls per run (mean) | 0.0 | 4.3 | 4.8 | n/a |
| Hook blocks per run (mean) | 0.0 | 0.0 | 0.0 | n/a |

### Whole-tree alerts per task, Haiku 5.5

Mean over repetitions, (min-max) when they differ; x = did not build.

| Task | Ecosystem | No docs | pinright MCP | pinright MCP + hook | No pin (reference) |
|---|---|---|---|---|---|
| mcp-hono | npm | 52.5 (52.0-53.0) | 0.0 | 0.0 x | 0.0 |
| proton-drive-example | npm | 0.5 (0.0-1.0) | 0.0 xx | 0.0 xx | 0.0 |
| mastra-deep-research | npm | 19.5 (19.0-20.0) x | 0.0 xx | 0.0 xx | 0.0 |
| assistant-ui-mcp-tools | npm | 18.0 (12.0-24.0) xx | 0.0 x | 0.0 xx | 0.0 |
| next-gh-pages | npm | 42.0 | 0.0 | 0.0 | 0.0 |
| openapi-fetch-next | npm | 43.0 xx | 1.0 xx | 0.0 xx | 1.0 |
| mcp-remote-oauth | pypi | 7.0 xx | 0.0 | 0.0 | 0.0 |
| kittentts-streaming | pypi | 0.0 (1 unresolved) xx | 0.0 | 0.0 | 0.0 |
| openevolve-symreg | pypi | 0.0 | 0.0 | 0.0 | 0.0 |
| pydantic-ai-deep-research | pypi | 4.5 (3.0-6.0) xx | 0.0 | 0.0 | 0.0 |
| stirrup-gdpval | pypi | 69.5 (58.0-81.0) xx | 56.0 | 56.0 (1 unresolved) x | 69.0 |
| livekit-ultravox | pypi | 0.5 (0.0-1.0) xx | 0.0 | 0.0 | 0.0 |

### Runs without a manifest or that do not build, Haiku 5.5

**No docs**: 

- assistant-ui-mcp-tools r1: node --check failed: `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".jsx" for`
- assistant-ui-mcp-tools r2: npx -y -p typescript tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "server.ts" "src\main.tsx" "vite.config.ts" failed: `server.ts(1,30): error TS2591: Cannot find name 'node:http'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node' and then add 'node' to the types f`
- kittentts-streaming r1: install failed: `× No solution found when resolving dependencies:`
- kittentts-streaming r2: import check failed: `from kittentts import KittenTTS -> ModuleNotFoundError: No module named 'phonemizer'`
- livekit-ultravox r1: import check failed: `from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli -> ModuleNotFoundError: No module named 'httpx'`
- livekit-ultravox r2: import check failed: `from livekit import agents -> ModuleNotFoundError: No module named 'httpx'`
- mastra-deep-research r1: npx -y -p typescript tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(17,34): error TS2591: Cannot find name 'process'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node' and then add 'node' to the types`
- mcp-remote-oauth r1: import check failed: `from mcp.server.auth.provider import ( AccessToken, AuthorizationCode, AuthorizationParams, OAuthAuthorizationServerProvider, RefreshToken, construct_redirect_uri, ) -> ImportError`
- mcp-remote-oauth r2: import check failed: `from mcp.server.auth.middleware.auth_context import get_access_token -> ImportError: cannot import name 'eval_type_backport' from 'pydantic._internal._typing_extra'`
- openapi-fetch-next r1: npm run build failed: `⨯ page.tsx doesn't have a root layout. To fix this error, make sure every page has a root layout.`
- openapi-fetch-next r2: npm run build failed: `⨯ users/page.tsx doesn't have a root layout. To fix this error, make sure every page has a root layout.`
- pydantic-ai-deep-research r1: import check failed: `from pydantic_ai import Agent -> ModuleNotFoundError: No module named 'opentelemetry._events'`
- pydantic-ai-deep-research r2: import check failed: `from pydantic_ai import Agent, RunContext -> ModuleNotFoundError: No module named 'opentelemetry._events'`
- stirrup-gdpval r1: import check failed: `from stirrup import Agent -> ModuleNotFoundError: No module named 'rich'`
- stirrup-gdpval r2: import check failed: `from stirrup import Agent -> ModuleNotFoundError: No module named 'rich'`

**pinright MCP**: 

- assistant-ui-mcp-tools r2: npm run build failed: `Failed to type check.`
- mastra-deep-research r1: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(27,27): error TS2345: Argument of type '{ name: string; instructions: string; model: "openai/gpt-5.4"; }' is not assignable to parameter of type 'AgentConfig<string, T`
- mastra-deep-research r2: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(24,27): error TS2345: Argument of type '{ name: string; instructions: string; model: "openai/gpt-5.4"; }' is not assignable to parameter of type 'AgentConfig<string, T`
- openapi-fetch-next r1: npm run build failed: `> Build error occurred`
- openapi-fetch-next r2: npm run build failed: `> Build error occurred`
- proton-drive-example r1: import check failed: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module ' imported from`
- proton-drive-example r2: import check failed: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module ' imported from`

**pinright MCP + hook**: 

- assistant-ui-mcp-tools r1: npm run build failed: `> Build error occurred`
- assistant-ui-mcp-tools r2: npx -y -p typescript tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "mcp-server.ts" "server.ts" "src\main.tsx" "vite.config.ts" failed: `server.ts(3,18): error TS2591: Cannot find name 'node:http'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node' and then add 'node' to the types f`
- mastra-deep-research r1: npx -y -p typescript tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(20,34): error TS2591: Cannot find name 'process'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node' and then add 'node' to the types`
- mastra-deep-research r2: npx -y -p typescript tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop "src\index.ts" failed: `src/index.ts(6,15): error TS2591: Cannot find name 'process'. Do you need to install type definitions for node? Try 'npm i --save-dev @types/node' and then add 'node' to the types `
- mcp-hono r2: npm run build failed: `Enable color and formatting in TypeScript's output to make compiler errors easier to read.`
- openapi-fetch-next r1: npm run build failed: `> Build error occurred`
- openapi-fetch-next r2: npm run build failed: `> Build error occurred`
- proton-drive-example r1: import check failed: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module ' imported from`
- proton-drive-example r2: import check failed: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module ' imported from`
- stirrup-gdpval r2: install failed: `× No solution found when resolving dependencies:`

### Vulnerable or non-existent direct pins, Haiku 5.5

**No docs**: 

- zod@3.25.76 (1 advisories, CVSS 7.5; default 4.6.7) x5
- next@15.5.4 (35 advisories, CVSS 10; default 16.4.4) x4
- mcp@1.12.4 (10 advisories, CVSS 7.5; default 2.3.0) x2
- @modelcontextprotocol/sdk@1.12.1 (8 advisories, CVSS 7.5; default 1.32.2)
- vite@6.3.5 (12 advisories; default 8.3.5)
- vite@7.1.12 (10 advisories; default 8.3.5)
- kittentts@0.8.0 (does not exist)
- python-dotenv@1.1.1 (2 advisories, CVSS 6.6; default 1.2.4)
- @hono/node-server@1.19.5 (3 advisories, CVSS 7.5; default 2.1.6)
- @modelcontextprotocol/sdk@1.20.2 (8 advisories, CVSS 7.5; default 1.32.2)
- hono@4.10.4 (40 advisories, CVSS 8.2; default 4.13.16)
- @hono/node-server@1.19.6 (3 advisories, CVSS 7.5; default 2.1.6)
- @modelcontextprotocol/sdk@1.25.1 (8 advisories, CVSS 8.6; default 1.32.2)
- hono@4.11.1 (40 advisories, CVSS 8.2; default 4.13.16)
- openpgp@5.11.2 (1 advisories; default 6.3.2)
- ... 5 more

**pinright MCP**: none


**pinright MCP + hook**: none


## pinright check-manifest vs npm audit / pip-audit (same lockfiles, all models)

|  | Lockfiles | Alerts (audit tool) | Alerts (pinright) | Vulnerable packages, mean Jaccard | Identical sets |
|---|---|---|---|---|---|
| npm (npm audit) | 120 | 1119 | 1199 | 1.00 | 120 |
| PyPI (pip-audit) | 116 | 979 | 1069 | 0.99 | 115 |

Packages flagged by one side only (times seen):

- only pinright: pillow x1
- only pinright: fsspec x1
- only pinright: datasets x1

## Reproduce

```bash
npm ci && npm run build
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-sonnet-5-5 --reps 2 --concurrency 3 --stamp real-issues-sonnet --set real-issues --arms no-docs,pinright,pinright+hook
npx tsx bench/agents/make-latest.ts real-issues-sonnet && npx tsx bench/agents/score.ts real-issues-sonnet --concurrency 3
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-opus-5-5 --reps 2 --concurrency 3 --stamp real-issues-opus --set real-issues --arms no-docs,pinright,pinright+hook
npx tsx bench/agents/make-latest.ts real-issues-opus && npx tsx bench/agents/score.ts real-issues-opus --concurrency 3
GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model claude-haiku-5-5 --reps 2 --concurrency 3 --stamp real-issues-haiku --set real-issues --arms no-docs,pinright,pinright+hook
npx tsx bench/agents/make-latest.ts real-issues-haiku && npx tsx bench/agents/score.ts real-issues-haiku --concurrency 3
npx tsx bench/agents/report.ts real-issues-sonnet real-issues-opus real-issues-haiku --out bench/AGENTS-real-issues.md
```

<!-- generated:end -->
