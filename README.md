# safectx

Up-to-date library docs for your coding agent, with the version that has no known
vulnerabilities.

Context7 tells the agent how to use a library. safectx adds what Context7 does not know:
whether the version the agent is about to install has a CVE, is deprecated, is malware, or
is a typo of a real package. Same two tool names as Context7, so `use context7` prompts keep
working. One extra tool, `check-package`, for the moment before `npm install`.

```
agent --MCP--> safectx --> context7.com      docs (your own key, optional)
                      --> api.deps.dev       versions, advisories, licenses
                      --> api.osv.dev        CVE details, fixed versions, malware records
                      --> npm / PyPI / ...   does the package exist at all
```

## Install

Claude Code:

```bash
claude mcp add safectx -- npx -y safectx
```

Cursor, VS Code, Windsurf and any other MCP client (`mcp.json`):

```json
{
  "mcpServers": {
    "safectx": {
      "command": "npx",
      "args": ["-y", "safectx"],
      "env": { "CONTEXT7_API_KEY": "optional, raises the Context7 rate limit" }
    }
  }
}
```

A free Context7 key (1,000 calls a month) comes from <https://context7.com/dashboard>. Without
one the docs still work, at Context7's anonymous rate limit. deps.dev and OSV need no key.

## What the agent sees

Ask for docs on a pinned version with a known hole:

```
query-docs { libraryId: "/vercel/next.js/v15.1.8", query: "middleware redirect" }
```

```
SECURITY NOTICE: next (npm)@15.1.8 has 36 known advisories.
  - GHSA-f82v-jwr5-mffw (CVE-2025-29927) [CRITICAL]: Authorization Bypass in Next.js Middleware fixed in 15.2.3, ...
  - ...
Recommended version: 16.4.3 (latest). Upgrade: npm install next@16.4.3
License: MIT
Verified against deps.dev + osv.dev on 2026-10-29.
Docs source: /vercel/next.js/v15.1.8

### Next.js Middleware Basic Redirect Example
...
```

The docs you asked for still come back. The agent decides; the notice is there so it decides
with the facts.

Ask about a name that does not exist:

```
check-package { name: "reqeusts", ecosystem: "python" }
```

```
SECURITY NOTICE: "reqeusts" looks like a typo of the popular package "requests" and does not
exist in the registry. Confirm the name before installing.
```

## Tools

| Tool | What it does |
|---|---|
| `resolve-library-id` | Same as Context7, plus for the top matches: the registry package, the newest version with no known advisory (`safeVersion`), the latest version and a `verdict`. |
| `query-docs` | Context7 docs. With no version in the id, serves the docs of the safe version when Context7 has it indexed. With a vulnerable or deprecated version pinned, prepends a `SECURITY NOTICE`. Accepts `packageName` and `ecosystem` when the repo name is not the package name. |
| `check-package` | The verdict alone: advisories with CVE ids, severity and fixed versions, deprecation, license, safe version, typosquat lookalikes. For npm, PyPI, crates.io, Go, Maven, NuGet and RubyGems. |

Verdicts: `ok`, `vulnerable`, `malicious`, `deprecated`, `possible-typosquat`, `unknown-package`,
`unknown`. The last one means a data source did not answer. safectx never says `ok` when it
could not check.

## How "safe version" is chosen

The newest version that is stable (no `rc`, `beta`, `canary`), not deprecated by its maintainers,
has no advisory in deps.dev (which mirrors OSV and the GitHub Advisory Database), and was published
at least 3 days ago. The cooldown is there because compromised releases are usually pulled within
days; set `SAFECTX_COOLDOWN_DAYS=0` to disable it. Only advisories against the package itself count,
not those of its dependencies: that is what the agent is about to install.

## Mapping a Context7 id to a package

A Context7 id is a GitHub repo, not a package. safectx tries the repo name in each registry and
keeps a match only when deps.dev confirms that package's source repository is that repo. When
nothing verifies, the docs come back with a notice and no verdict; pass `packageName` and
`ecosystem` to `query-docs`, or call `check-package`. `npm run coverage:ecosystem` measures the
hit rate over the benchmark set.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CONTEXT7_API_KEY` | none | Raises Context7 rate limits. |
| `SAFECTX_COOLDOWN_DAYS` | `3` | Minimum age of a version to be recommended. |
| `SAFECTX_MAX_CANDIDATES` | `12` | Versions inspected, newest first, before giving up on a safe one. |
| `SAFECTX_CACHE_DIR` | OS cache dir `/safectx` | Where responses are cached (docs 7 days, advisories 24 h). |
| `SAFECTX_NO_CACHE` | unset | `1` disables the cache. |
| `SAFECTX_TIMEOUT_MS` | `15000` | Per-request timeout. |

No telemetry. Every request goes from your machine to the upstream APIs and nowhere else.

## Development

```bash
npm install
npm test                  # offline unit tests with fixtures
npm run build && npx tsx scripts/e2e.ts   # drive the server over stdio with a real MCP client
npx tsx scripts/smoke.ts  # live calls against the real APIs
npm run bench             # Context7 vs safectx over ~95 libraries, writes bench/RESULTS.md
```

## License

MIT. Built by [Hiper AI](https://hiperai.com).
