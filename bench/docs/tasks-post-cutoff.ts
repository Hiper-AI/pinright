/**
 * The post-cutoff set of the docs benchmark: eight tasks whose right answer
 * depends on an API that first shipped in a release published on or after
 * 2026-08-01, after the likely training cutoff of the models under test. The v6
 * set (tasks.ts) measures whether an agent writes a library's current API; with
 * these, an agent cannot have learned the API from training data, so a pass
 * without docs is unlikely and a pass with docs is evidence the docs were used.
 *
 * Each task records where the API first appears (`evidence`): the first release
 * that ships it, its publish time on the registry, and the newest earlier release
 * that was checked not to have it (by its exported entry points, its .d.ts, or by
 * importing it). `majors[].min` is that first stable release: pinning an older one
 * is a version miss even when the code is right. Checks follow tasks.ts: required
 * means the new API is used, removed/deprecated means an older way was used.
 */
import { callArgs, filesMatching, has, SRC_JS, SRC_PY, type Project } from './checks.js';
import { type DocsTask, NPM_RULES, PY_RULES, someCall } from './tasks.js';

const scripts = (p: Project) => Object.values(p.pkg?.scripts ?? {});

export const POST_CUTOFF_TASKS: DocsTask[] = [
  {
    id: 'msw3-node',
    library: 'Mock Service Worker 3',
    ecosystem: 'npm',
    majors: [{ name: 'msw', major: 3, min: '3.0.0' }],
    sources: [
      'https://github.com/mswjs/msw/releases/tag/v3.0.0',
      'https://www.npmjs.com/package/msw (msw@3 package.json exports ./http and ./graphql; lib/_chunks/shared-options.d.ts: `onUnhandledFrame`; lib/graphql/index.d.ts: `graphql` has only `link(url)`)',
    ],
    evidence: {
      package: 'npm:msw',
      firstVersion: '3.0.0',
      published: '2026-09-28T15:45:58Z',
      lastWithout: '2.15.0 (2026-07-08): no ./graphql or ./http export, the listen option is onUnhandledRequest',
      changelog: 'https://github.com/mswjs/msw/releases/tag/v3.0.0',
    },
    prompt:
      'Create a small TypeScript library with Mock Service Worker 3 for its tests; use the newest msw 3.x release. Requirements:\n' +
      '- `src/api.ts` exports `getUser(id: string)`, which fetches `https://api.example.com/users/<id>` and returns the JSON, and `getRepoStars(owner: string, name: string)`, which POSTs the GraphQL query named `RepoStars` (variables `owner` and `name`) to `https://api.example.com/graphql` and returns `data.repository.stars`.\n' +
      '- `src/mocks/handlers.ts` exports `handlers`: an HTTP handler for `GET https://api.example.com/users/:id` that responds `{ "id": <id>, "name": "Ada" }`, and a GraphQL handler for the `RepoStars` query that responds with 42 stars.\n' +
      '- `src/mocks/server.ts` exports `server`, the msw server for Node.js built from those handlers, and `startMocks()`, which starts it so that any request no handler covers makes the test fail with an error.\n' +
      `Also a tsconfig.json. The package.json needs a "build" script that runs \`tsc --noEmit\`. ${NPM_RULES}`,
    checks: [
      { id: 'graphql-subpath', kind: 'required', desc: "graphql imported from 'msw/graphql'", test: (p) => has(p, /import\s*\{[^}]*\bgraphql\b[^}]*\}\s*from\s*['"]msw\/graphql['"]/) },
      { id: 'on-unhandled-frame', kind: 'required', desc: 'listen({ onUnhandledFrame })', test: (p) => has(p, /\bonUnhandledFrame\s*:/) },
      { id: 'graphql-root', kind: 'removed', desc: "graphql imported from 'msw' (moved to msw/graphql in 3)", test: (p) => has(p, /import\s*\{[^}]*\bgraphql\b[^}]*\}\s*from\s*['"]msw['"]/) },
      { id: 'on-unhandled-request', kind: 'removed', desc: 'onUnhandledRequest (renamed onUnhandledFrame in 3)', test: (p) => has(p, /\bonUnhandledRequest\s*:/) },
      { id: 'graphql-bare-query', kind: 'removed', desc: 'graphql.query() / .mutation() / .operation() (3 keeps only graphql.link(url))', test: (p) => has(p, /\bgraphql\s*\.\s*(query|mutation|operation)\s*\(/) },
    ],
  },
  {
    id: 'hono-mount',
    library: 'Hono 4.13',
    ecosystem: 'npm',
    majors: [{ name: 'hono', major: 4, min: '4.13.13' }],
    sources: [
      'https://github.com/honojs/hono/releases/tag/v4.13.13 ("feat(mount): introduce Mount Middleware and deprecate app.mount")',
      'https://hono.dev/docs/middleware/builtin/mount',
      'https://www.npmjs.com/package/hono (hono@4.13.13 dist/types/middleware/mount/index.d.ts)',
    ],
    evidence: {
      package: 'npm:hono',
      firstVersion: '4.13.13',
      published: '2026-10-04T03:53:48Z',
      lastWithout: '4.13.12 (2026-09-30): no ./mount export',
      changelog: 'https://github.com/honojs/hono/releases/tag/v4.13.13',
    },
    prompt:
      'Create a Hono app in TypeScript; use the newest Hono 4.x release. Requirements:\n' +
      '- `src/legacy.ts` exports `legacyHandler(request: Request): Response`, a plain fetch-style handler (no Hono) that responds with JSON `{ "path": <the pathname of the URL it receives> }`.\n' +
      '- `src/app.ts` default-exports the Hono app: `GET /health` responds `{ "ok": true }`, and every request under `/legacy` is served by `legacyHandler`, which must receive the path with the `/legacy` prefix removed (a request to `/legacy/a/b` reaches it as `/a/b`). Attach the handler with the way this Hono version provides for mounting an application built with another framework, not by calling it from a route handler.\n' +
      `Also a tsconfig.json. The package.json needs a "build" script that runs \`tsc --noEmit\`. ${NPM_RULES}`,
    checks: [
      { id: 'mount-middleware', kind: 'required', desc: "mount() from 'hono/mount'", test: (p) => has(p, /from\s*['"]hono\/mount['"]/) && has(p, /(?<![.\w$])mount\s*\(/) },
      { id: 'app-mount', kind: 'deprecated', desc: 'app.mount(path, handler) (deprecated in 4.13.13)', test: (p) => has(p, /\.\s*mount\s*\(\s*['"`]/) },
    ],
  },
  {
    id: 'dotenv18-run',
    library: 'dotenv 18',
    ecosystem: 'npm',
    majors: [{ name: 'dotenv', major: 18, min: '18.0.0' }],
    sources: [
      'https://github.com/motdotla/dotenv/blob/master/CHANGELOG.md (18.0.0: "Remove preloading. Instead use cli `dotenv run -- your-command`")',
      'https://www.npmjs.com/package/dotenv (README "CLI > run"; dotenv@18 package.json `bin`)',
    ],
    evidence: {
      package: 'npm:dotenv',
      firstVersion: '18.0.0',
      published: '2026-09-17T21:18:40Z',
      lastWithout: '17.4.2 (2026-04-12): no `bin`; preload reads dotenv_config_* arguments (lib/cli-options)',
      changelog: 'https://github.com/motdotla/dotenv/blob/master/CHANGELOG.md',
    },
    prompt:
      'Create a small Node.js HTTP service in JavaScript (ES modules) that uses dotenv 18; use the newest dotenv 18.x release. Requirements:\n' +
      '- `server.js` starts a `node:http` server on `process.env.PORT` that responds to every request with JSON `{ "greeting": <process.env.GREETING> }`.\n' +
      '- The application code must not import or require dotenv. The variables come from the file `.env.local` (not `.env`) and are loaded by the npm `start` script before the process starts, with dotenv itself: not with Node\'s `--env-file` flag and not with another package.\n' +
      '- Also write `.env.local` with `GREETING=hello` and `PORT=3000`.\n' +
      NPM_RULES,
    checks: [
      {
        id: 'dotenv-run',
        kind: 'required',
        desc: 'start script runs `dotenv run -f .env.local -- ...`',
        test: (p) => /\bdotenv\s+run\b[^&|;]*?(?:-f|--file)(?:\s+|=)['"]?\.?\/?\.env\.local\b/.test(p.pkg?.scripts?.start ?? ''),
      },
      { id: 'no-import', kind: 'required', desc: 'the app code does not import dotenv', test: (p) => !has(p, /['"]dotenv(\/config(\.js)?)?['"]/) },
      { id: 'preload-args', kind: 'removed', desc: 'dotenv_config_* preload arguments (no longer read in 18)', test: (p) => scripts(p).some((s) => /\bdotenv_config_\w+=/i.test(s)) },
    ],
  },
  {
    id: 'zod-compile',
    library: 'Zod 4.5',
    ecosystem: 'npm',
    majors: [{ name: 'zod', major: 4, min: '4.5.0' }],
    sources: [
      'https://zod.dev/compile',
      'https://github.com/colinhacks/zod/releases/tag/v4.5.0',
      'https://www.npmjs.com/package/zod (zod@4.5.0 exports ./compile; v4/classic/external.d.ts exports `compile`)',
    ],
    evidence: {
      package: 'npm:zod',
      firstVersion: '4.5.0-canary.20260817T190646',
      published: '2026-08-17T22:37:11Z',
      firstStable: { version: '4.5.0', published: '2026-08-28T18:14:39Z' },
      lastWithout: '4.4.3 and every 4.5.0 canary before 2026-08-17: no ./compile export',
      changelog: 'https://github.com/colinhacks/zod/releases/tag/v4.5.0',
    },
    prompt:
      'Create a TypeScript module `src/events.ts` with Zod 4; use the newest Zod 4.x release. It exports:\n' +
      '- `EventSchema`: an object with `id` (a UUID), `type` (`"click"` or `"view"`), `at` (an ISO 8601 datetime string) and `props` (a record from string keys to string or number values).\n' +
      '- `parseEvents(lines: string[])`, which parses each line as JSON, validates it, and returns the typed events; it throws the Zod error of the first invalid line.\n' +
      '`parseEvents` is a hot path that validates millions of lines: validate with a version of `EventSchema` compiled ahead of time by the schema compilation this Zod version provides, so valid input takes the compiled fast path and errors stay those of the regular parser. Do not write a validator by hand.\n' +
      `Also a tsconfig.json. The package.json needs a "build" script that runs \`tsc --noEmit\`. ${NPM_RULES}`,
    checks: [
      {
        id: 'z-compile',
        kind: 'required',
        desc: "z.compile(schema) or import 'zod/compile'",
        test: (p) =>
          has(p, /\bz\.compile\s*\(/) ||
          has(p, /import\s*['"]zod\/compile['"]/) ||
          filesMatching(p, SRC_JS).some(([, c]) => /import\s*\{[^}]*\bcompile\b[^}]*\}\s*from\s*['"]zod['"]/.test(c) && callArgs(c, 'compile').length > 0),
      },
      { id: 'string-format', kind: 'deprecated', desc: 'z.string().uuid() / .datetime() (top-level z.uuid() / z.iso.datetime() in 4)', test: (p) => has(p, /\.string\(\s*\)\s*\.(uuid|datetime|email)\s*\(/) },
      { id: 'record-1arg', kind: 'removed', desc: 'z.record(valueSchema) with one argument', test: someCall('z.record', (a) => a.length === 1) },
    ],
  },
  {
    id: 'polars2-bins',
    library: 'Polars 2',
    ecosystem: 'pypi',
    majors: [{ name: 'polars', major: 2, min: '2.0.0' }],
    sources: [
      'https://docs.pola.rs/releases/upgrade/2/ (Deprecations: cut()/qcut() in favour of bin_intervals()/bin_quantiles(); with_row_count and join_nulls removed)',
      'https://pypi.org/project/polars/ (polars-2.1.0 wheel: Series.bin_intervals, Expr.bin_quantiles)',
    ],
    evidence: {
      package: 'pypi:polars',
      firstVersion: '2.0.0rc1',
      published: '2026-09-02T11:42:02Z',
      firstStable: { version: '2.0.0', published: '2026-10-06T11:44:04Z' },
      lastWithout: '1.44.1 (2026-08-26): imported, no Series.bin_intervals / Expr.bin_intervals',
      changelog: 'https://github.com/pola-rs/polars/blob/main/docs/source/releases/upgrade/2.md',
    },
    prompt:
      'Create `report.py` with Polars 2; use the newest Polars 2.x release. It defines `age_report(people: pl.DataFrame, cities: pl.DataFrame) -> pl.DataFrame`, where `people` has the columns `name`, `age` (a float: ages can be fractional), `income` and `city_id` (may be null), and `cities` has `city_id` (may be null) and `city`. The result:\n' +
      '- a column `age_group` with the labels "child" for ages up to and including 12, "teen" above 12 up to and including 19, and "adult" above 19, computed with the binning method of this Polars version for explicit breakpoints;\n' +
      '- a column `income_quartile`, the integer index (0 to 3) of the income quartile, computed with the quantile binning method of this Polars version;\n' +
      '- the city name joined from `cities` on `city_id` (left join), where a null `city_id` matches a null `city_id`;\n' +
      '- a first column `row` numbering the rows from 1.\n' +
      'Use the methods current in this Polars version, not deprecated ones.\n' +
      PY_RULES,
    checks: [
      { id: 'bin-intervals', kind: 'required', desc: 'bin_intervals(..., right_closed=True)', test: someCall('.bin_intervals', (a) => a.some((x) => /^right_closed\s*=\s*True$/.test(x)), SRC_PY) },
      { id: 'bin-quantiles', kind: 'required', desc: 'bin_quantiles(...)', test: (p) => has(p, /\.bin_quantiles\s*\(/, SRC_PY) },
      { id: 'cut-qcut', kind: 'deprecated', desc: 'cut() / qcut() (deprecated in 2.0)', test: (p) => has(p, /\.q?cut\s*\(/, SRC_PY) },
      { id: 'with-row-count', kind: 'removed', desc: 'with_row_count (removed in 2.0)', test: (p) => has(p, /\.with_row_count\s*\(/, SRC_PY) },
      { id: 'join-nulls', kind: 'removed', desc: 'join(..., join_nulls=) (removed in 2.0, now nulls_equal)', test: (p) => has(p, /\bjoin_nulls\s*=/, SRC_PY) },
    ],
  },
  {
    id: 'fastapi-telemetry',
    library: 'FastAPI 0.142+',
    ecosystem: 'pypi',
    majors: [{ name: 'fastapi', major: 0, min: '0.142.0' }],
    sources: [
      'https://fastapi.tiangolo.com/advanced/opentelemetry/ (docs/en/docs/advanced/opentelemetry.md at 0.162.0)',
      'https://github.com/fastapi/fastapi/releases/tag/0.142.0',
      'https://pypi.org/project/fastapi/ (fastapi-0.162.0 wheel: fastapi/telemetry/_api.py TelemetryConfig)',
    ],
    evidence: {
      package: 'pypi:fastapi',
      firstVersion: '0.142.0',
      published: '2026-09-29T17:56:37Z',
      lastWithout: '0.141.1 (2026-07-29): imported, FastAPI.__init__ has no telemetry parameter',
      changelog: 'https://github.com/fastapi/fastapi/releases/tag/0.142.0',
    },
    prompt:
      'Create `main.py`, a FastAPI app; use the newest FastAPI release. Requirements:\n' +
      '- `GET /items/{item_id}` (an int) responds `{ "item_id": <id> }` and `GET /health` responds `{ "ok": true }`.\n' +
      '- OpenTelemetry traces of the HTTP requests are printed to the console through a tracer provider with a `BatchSpanProcessor` and a `ConsoleSpanExporter`; requests to `/health` are not recorded, and request metrics are turned off.\n' +
      '- Use the OpenTelemetry support built into this FastAPI version, not a separate instrumentation package.\n' +
      PY_RULES,
    checks: [
      { id: 'telemetry-param', kind: 'required', desc: 'FastAPI(telemetry={...})', test: someCall('FastAPI', (a) => a.some((x) => /^telemetry\s*=/.test(x)), SRC_PY) },
      { id: 'telemetry-exclude', kind: 'required', desc: 'telemetry exclude for /health', test: (p) => has(p, /["']exclude["']\s*:|\bexclude\s*=/, SRC_PY) },
      { id: 'telemetry-metrics-off', kind: 'required', desc: 'telemetry metrics off', test: (p) => has(p, /["']metrics["']\s*:\s*False\b|\bmetrics\s*=\s*False\b/, SRC_PY) },
      {
        id: 'instrumentor',
        kind: 'deprecated',
        desc: 'opentelemetry-instrumentation-fastapi (the prompt asks for the built-in support)',
        test: (p) => has(p, /\bFastAPIInstrumentor\b|opentelemetry\.instrumentation\.fastapi/, SRC_PY),
      },
    ],
  },
  {
    id: 'pandas31-select',
    library: 'pandas 3.1',
    ecosystem: 'pypi',
    majors: [{ name: 'pandas', major: 3, min: '3.1.0' }],
    sources: ['https://pandas.pydata.org/docs/whatsnew/v3.1.0.html (DataFrame.select, filter(cond=...), inplace deprecated)'],
    evidence: {
      package: 'pypi:pandas',
      firstVersion: '3.1.0rc0',
      published: '2026-09-30T13:55:10Z',
      firstStable: { version: '3.1.0', published: '2026-10-22T11:54:48Z' },
      lastWithout: '3.0.5 (2026-07-22): imported, no DataFrame.select, DataFrame.filter has no cond parameter',
      changelog: 'https://pandas.pydata.org/docs/whatsnew/v3.1.0.html',
    },
    prompt:
      'Create `clean.py` with pandas 3; use the newest pandas 3.x release. It defines `adults(df: pd.DataFrame) -> pd.DataFrame`, where `df` has the columns `name`, `age` and `email`, and returns a new DataFrame (the input is never modified in place) with:\n' +
      '- only the rows with `age >= 18`, kept with the boolean-mask filtering that this pandas version adds to `DataFrame.filter`;\n' +
      '- sorted by `age`, with a fresh index from 0;\n' +
      '- exactly the columns `name` and `age_months` (`age * 12`), produced in a single call of the method this pandas version adds for selecting and computing columns from `pd.col()` expressions.\n' +
      PY_RULES,
    checks: [
      { id: 'df-select', kind: 'required', desc: 'DataFrame.select(...)', test: (p) => has(p, /\.select\s*\(/, SRC_PY) },
      {
        id: 'filter-cond',
        kind: 'required',
        desc: 'DataFrame.filter(cond=...) or filter(pd.col(...)) / filter(lambda ...)',
        test: someCall('.filter', (a) => a.some((x) => /^cond\s*=/.test(x)) || /^(pd\.col\s*\(|lambda\b)/.test(a[0] ?? ''), SRC_PY),
      },
      { id: 'inplace', kind: 'deprecated', desc: 'inplace=True (deprecated in 3.1 on drop, sort_values, reset_index and others)', test: (p) => has(p, /\binplace\s*=\s*True\b/, SRC_PY) },
    ],
  },
  {
    id: 'langchain14-mcp',
    library: 'LangChain 1.4',
    ecosystem: 'pypi',
    majors: [{ name: 'langchain', major: 1, min: '1.4.0' }],
    sources: [
      'https://github.com/langchain-ai/langchain/releases/tag/langchain%3D%3D1.4.0 ("langchain.mcp namespace", MCPAdapter)',
      'https://docs.langchain.com/oss/python/langchain/mcp',
      'https://pypi.org/project/langchain/ (langchain-1.4.8 wheel: langchain/mcp/adapter.py)',
    ],
    evidence: {
      package: 'pypi:langchain',
      firstVersion: '1.4.0a1',
      published: '2026-08-27T22:20:49Z',
      firstStable: { version: '1.4.0', published: '2026-09-03T16:59:31Z' },
      lastWithout: '1.3.14 (2026-07-16): imported, no langchain.mcp module',
      changelog: 'https://github.com/langchain-ai/langchain/releases/tag/langchain%3D%3D1.4.0',
    },
    prompt:
      'Create a LangChain 1 agent that uses the tools of a local MCP server; use the newest `langchain` 1.x release and the matching OpenAI provider package. Requirements:\n' +
      '- `weather_server.py`: an MCP server built with FastMCP that runs over stdio and exposes one tool, `get_weather(city: str) -> str` (made-up data).\n' +
      '- `agent.py`: `async def ask(question: str) -> str` launches `weather_server.py` (found next to `agent.py`) as a local subprocess, loads its tools with the MCP integration built into the `langchain` package of this version (not a separate adapter package), builds an agent with `create_agent` on OpenAI `gpt-4o-mini` with those tools, runs it on the question and returns the final answer text.\n' +
      PY_RULES,
    checks: [
      { id: 'langchain-mcp', kind: 'required', desc: 'from langchain.mcp import MCPAdapter', test: (p) => has(p, /from\s+langchain\.mcp(?:\.adapter)?\s+import\s+[^\n]*\bMCPAdapter\b|from\s+langchain\.mcp(?:\.adapter)?\s+import\s*\([^)]*\bMCPAdapter\b/, SRC_PY) },
      { id: 'create-agent', kind: 'required', desc: 'from langchain.agents import create_agent', test: (p) => has(p, /from\s+langchain\.agents\s+import\s+[^\n]*\bcreate_agent\b|from\s+langchain\.agents\s+import\s*\([^)]*\bcreate_agent\b/, SRC_PY) },
      {
        id: 'str-target',
        kind: 'removed',
        desc: 'MCPAdapter("server.py"): a str target must be an http(s) URL (raises)',
        test: someCall('MCPAdapter', (a) => /^[rbf]?['"](?!https?:)/.test(a[0] ?? ''), SRC_PY),
      },
      { id: 'adapters-package', kind: 'deprecated', desc: 'langchain_mcp_adapters (the prompt asks for langchain.mcp)', test: (p) => has(p, /\blangchain_mcp_adapters\b/, SRC_PY) },
    ],
  },
];
