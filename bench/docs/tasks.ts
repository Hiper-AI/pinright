/**
 * Tasks for the docs benchmark: each one only comes out right with the API of
 * the library's current major. The prompt names the major (so the test is the
 * API, not the version number) but never the new API itself. Each task cites
 * where its "current API" comes from; the checks were written from those pages
 * and the published type definitions, not from memory.
 */
import { type ApiCheck, CSS, callArgs, fileExists, filesMatching, has, SRC_JS, SRC_PY } from './checks.js';

export interface DocsTask {
  id: string;
  library: string;
  ecosystem: 'npm' | 'pypi';
  prompt: string;
  /** Packages whose pinned major must match; with `min`, the pinned version must also be at least that one (the first release with the API). */
  majors: { name: string; major: number; min?: string }[];
  /** Official pages the checks were written from. */
  sources: string[];
  checks: ApiCheck[];
  /** Runtime smoke test id in smoke.ts. */
  smoke?: string;
  /** Post-cutoff set: where the API first shipped, from the registry's publish time. */
  evidence?: TaskEvidence;
}

export interface TaskEvidence {
  package: string;
  /** First release (stable or prerelease) that ships the API. */
  firstVersion: string;
  /** Its publish time on the registry (npm `time`, PyPI upload time), UTC. */
  published: string;
  /** First stable release with the API, when firstVersion is a prerelease. */
  firstStable?: { version: string; published: string };
  /** Newest release before it, checked not to have the API, and how. */
  lastWithout: string;
  changelog: string;
}

export const NPM_RULES =
  'Write a package.json with EXACT pinned versions (no ^ or ~) for every dependency, plus the source file(s). ' +
  'Do not run any command.';
export const PY_RULES =
  'Write a requirements.txt with EXACT pinned versions (name==version) for every dependency, plus the source file(s). ' +
  'Do not run any command.';

export const DOCS_HINT =
  'If you have documentation tools available, use them to check the current API of each library before writing code.';

/** Route strings: the first argument of app.get/post/use/all/route and router.*. */
function routePaths(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\b(?:app|router)\s*\.\s*(?:get|post|put|patch|delete|all|use|route)\s*\(\s*(['"`])([^'"`]*)\1/g)) out.push(m[2]);
  return out;
}

export const someCall = (fn: string, pred: (args: string[]) => boolean, path: RegExp = SRC_JS) => (p: Parameters<ApiCheck['test']>[0]) =>
  filesMatching(p, path).some(([, c]) => callArgs(c, fn).some(pred));

export const TASKS: DocsTask[] = [
  {
    id: 'next16-proxy',
    library: 'Next.js 16',
    ecosystem: 'npm',
    majors: [{ name: 'next', major: 16 }],
    sources: [
      'https://nextjs.org/docs/app/guides/upgrading/version-16',
      'https://nextjs.org/docs/app/api-reference/file-conventions/proxy',
    ],
    smoke: 'next-proxy',
    prompt:
      'Create a minimal Next.js 16 app (App Router, TypeScript); use the newest Next.js 16 release. Requirements:\n' +
      '- Every request to /dashboard and anything under it is checked before it reaches a route: when the `session` cookie is missing, redirect to /login. Use the request-interception file convention of this Next.js version.\n' +
      '- app/dashboard/[team]/page.tsx: a server component that reads the `team` route parameter and the `theme` cookie and renders "Team: <team>" and the theme.\n' +
      '- app/dashboard/[team]/actions.ts: a server action `refreshTeam(team: string)` that revalidates the cache tag `team-<team>` with stale-while-revalidate semantics.\n' +
      '- app/login/page.tsx with a heading, and the root layout.\n' +
      `The package.json needs a "build" script that runs \`next build\`. ${NPM_RULES}`,
    checks: [
      {
        id: 'proxy-file',
        kind: 'required',
        desc: 'proxy.ts at the root (or src/) exporting the interceptor',
        test: (p) => filesMatching(p, /^(src\/)?proxy\.(ts|js)$/).some(([, c]) => /export\s+(async\s+)?function\s+proxy\b|export\s+const\s+proxy\b|export\s+default\b/.test(c)),
      },
      { id: 'middleware-file', kind: 'deprecated', desc: 'middleware.ts (renamed to proxy.ts in 16)', test: (p) => fileExists(p, /^(src\/)?middleware\.(ts|js)$/) },
      { id: 'sync-cookies', kind: 'removed', desc: 'cookies()/headers() used without await', test: (p) => has(p, /\b(cookies|headers)\(\)\s*\.\s*(get|getAll|has|set|delete)\b/) },
      { id: 'sync-params', kind: 'removed', desc: 'params typed or destructured as a plain object (a Promise since 15, sync access removed in 16)', test: (p) => has(p, /\bparams\s*\??:\s*\{\s*\w+\s*[:}?]/, /^(src\/)?app\/.*\.(tsx?|jsx?)$/) },
      // The upgrade guide calls it deprecated, but it is a TypeScript error in 16: `next build` fails.
      { id: 'revalidateTag-1arg', kind: 'removed', desc: 'revalidateTag(tag) without a cacheLife profile (type error in 16)', test: someCall('revalidateTag', (a) => a.length === 1) },
    ],
  },
  {
    id: 'tailwind4-vite',
    library: 'Tailwind CSS 4',
    ecosystem: 'npm',
    majors: [{ name: 'tailwindcss', major: 4 }],
    sources: [
      'https://tailwindcss.com/docs/upgrade-guide',
      'https://tailwindcss.com/docs/dark-mode',
      'https://tailwindcss.com/docs/adding-custom-styles',
    ],
    smoke: 'tailwind-css',
    prompt:
      'Create a Vite + React + TypeScript single-page app styled with Tailwind CSS 4; use the newest Tailwind CSS 4 release and a Vite version it supports. Requirements:\n' +
      '- A custom theme color `brand` (#4f46e5) usable as `bg-brand` and `text-brand`, and a custom font family `display` ("Inter", sans-serif) usable as `font-display`.\n' +
      '- A custom utility `content-auto` that sets `content-visibility: auto` and works with variants (e.g. `md:content-auto`).\n' +
      '- Dark mode driven by a `dark` class on <html>, not by the OS preference.\n' +
      '- src/App.tsx uses `bg-brand`, `font-display`, `content-auto`, `dark:bg-gray-900` and a 50% black overlay `bg-black/50`, plus a button that toggles the `dark` class.\n' +
      '- index.html, src/main.tsx, the CSS entry and the Vite config.\n' +
      `The package.json needs a "build" script that runs \`vite build\` (no type-check step). ${NPM_RULES}`,
    checks: [
      { id: 'css-import', kind: 'required', desc: '@import "tailwindcss" in the CSS entry', test: (p) => has(p, /@import\s+(url\()?["']tailwindcss["']/, CSS) },
      { id: 'theme-block', kind: 'required', desc: '@theme block defining --color-brand', test: (p) => has(p, /@theme\b[^{]*\{[^}]*--color-brand\s*:/, CSS) },
      { id: 'utility-at-rule', kind: 'required', desc: '@utility content-auto', test: (p) => has(p, /@utility\s+content-auto\b/, CSS) },
      { id: 'dark-variant', kind: 'required', desc: '@custom-variant dark for class-based dark mode', test: (p) => has(p, /@custom-variant\s+dark\b/, CSS) },
      {
        id: 'v4-plugin',
        kind: 'required',
        desc: '@tailwindcss/vite or @tailwindcss/postcss as the build integration',
        test: (p) => ['@tailwindcss/vite', '@tailwindcss/postcss'].some((n) => p.pkg?.dependencies?.[n] || p.pkg?.devDependencies?.[n]),
      },
      { id: 'tailwind-directives', kind: 'removed', desc: '@tailwind base/components/utilities', test: (p) => has(p, /@tailwind\s+(base|components|utilities)\b/, CSS) },
      { id: 'postcss-tailwindcss', kind: 'removed', desc: '"tailwindcss" used as the PostCSS plugin', test: (p) => has(p, /(^|[\s{,'"])tailwindcss['"]?\s*:|require\(\s*['"]tailwindcss['"]\s*\)/m, /^postcss\.config\.(js|cjs|mjs|ts|json)$/) },
      { id: 'opacity-utilities', kind: 'removed', desc: 'bg-opacity-* utilities', test: (p) => has(p, /\b(bg|text|border)-opacity-\d/, /\.(tsx|jsx|html)$/) },
      { id: 'js-config', kind: 'deprecated', desc: 'tailwind.config.* (not auto-detected in v4)', test: (p) => fileExists(p, /^tailwind\.config\.(js|cjs|mjs|ts)$/) },
      { id: 'layer-utilities', kind: 'deprecated', desc: '@layer utilities for a custom utility', test: (p) => has(p, /@layer\s+utilities\b/, CSS) },
    ],
  },
  {
    id: 'zod4-schema',
    library: 'Zod 4',
    ecosystem: 'npm',
    majors: [{ name: 'zod', major: 4 }],
    sources: ['https://zod.dev/v4/changelog', 'https://zod.dev/error-formatting', 'https://zod.dev/error-customization'],
    smoke: 'zod-signup',
    prompt:
      'Create a TypeScript module `src/signup.ts` with Zod 4 (use the newest Zod 4 release) that exports:\n' +
      '- `Role`, a TypeScript `enum` with members `Admin = "admin"` and `Member = "member"`;\n' +
      '- `SignupSchema`: an object with `email` (a valid email address), `password` (at least 8 characters; on failure the error message must be exactly "Password must be at least 8 characters"), `age` (optional integer >= 13), `role` (one of the `Role` values) and `tags` (a record from string keys to string values). Unknown keys must be rejected.\n' +
      '- `validateSignup(input: unknown)`, returning `{ ok: true, data }` on success or `{ ok: false, message }`, where `message` is one human-readable multi-line string listing every issue with the path of the field it concerns.\n' +
      `Also a tsconfig.json. ${NPM_RULES}`,
    checks: [
      { id: 'z-email', kind: 'required', desc: 'z.email()', test: (p) => has(p, /\bz\.email\s*\(/) },
      { id: 'string-email', kind: 'deprecated', desc: 'z.string().email()', test: (p) => has(p, /\.string\(\s*\)\s*\.email\s*\(/) },
      {
        id: 'message-param',
        kind: 'deprecated',
        desc: '{ message } instead of { error } in a check',
        test: (p) => ['.min', '.max', '.email', 'z.email', '.int', '.regex', '.length', '.refine', '.gte', '.lte'].some((fn) => someCall(fn, (a) => a.some((x) => /^\{[\s\S]*\bmessage\s*:/.test(x)))(p)),
      },
      { id: 'v3-error-params', kind: 'removed', desc: 'required_error / invalid_type_error / errorMap', test: (p) => has(p, /\b(required_error|invalid_type_error|errorMap)\s*:/) },
      { id: 'native-enum', kind: 'deprecated', desc: 'z.nativeEnum()', test: (p) => has(p, /\bz\.nativeEnum\s*\(/) },
      { id: 'strict-method', kind: 'deprecated', desc: '.strict() instead of z.strictObject()', test: (p) => has(p, /\.strict\(\s*\)/) },
      { id: 'record-1arg', kind: 'removed', desc: 'z.record(valueSchema) with one argument', test: someCall('z.record', (a) => a.length === 1) },
      { id: 'format-flatten', kind: 'deprecated', desc: 'error.format() / error.flatten()', test: (p) => has(p, /\.(format|flatten)\(\s*\)/) },
    ],
  },
  {
    id: 'ai-sdk7-chat',
    library: 'AI SDK 7',
    ecosystem: 'npm',
    majors: [{ name: 'ai', major: 7 }],
    sources: [
      'https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0',
      'https://ai-sdk.dev/docs/getting-started/nextjs-app-router',
      'https://www.npmjs.com/package/ai (ai@7 dist/index.d.ts: `system` @deprecated "Use `instructions` instead", `stepCountIs` is an alias of `isStepCount`)',
    ],
    prompt:
      'Create a minimal Next.js (App Router, TypeScript) chat app with the Vercel AI SDK 7 (the `ai` package: use the newest 7.x release and the matching @ai-sdk/* packages) and OpenAI through @ai-sdk/openai. Requirements:\n' +
      '- app/api/chat/route.ts receives the chat messages from the client, streams a reply from `gpt-4o-mini` with the system instructions "You are a terse assistant.", exposes one tool `getWeather` (input: `city`, a string; returns a made-up temperature), lets the model call tools for up to 5 steps, and streams the result back in the format the AI SDK React chat hook expects.\n' +
      "- app/page.tsx: a client component using the AI SDK React chat hook that renders the text parts of each message and has a form with a text input that sends a message.\n" +
      `The package.json needs a "build" script that runs \`next build\`. ${NPM_RULES}`,
    checks: [
      { id: 'instructions', kind: 'required', desc: 'instructions: (system: is deprecated in 7)', test: (p) => has(p, /\binstructions\s*:/, /route\.(ts|js)$/) },
      { id: 'is-step-count', kind: 'required', desc: 'stopWhen: isStepCount(n)', test: (p) => has(p, /\bisStepCount\s*\(/) },
      { id: 'step-count-is', kind: 'deprecated', desc: 'stepCountIs (renamed isStepCount in 7)', test: (p) => has(p, /\bstepCountIs\s*\(/) },
      { id: 'max-steps', kind: 'removed', desc: 'maxSteps', test: (p) => has(p, /\bmaxSteps\s*:/) },
      { id: 'ui-stream-response', kind: 'required', desc: 'createUIMessageStreamResponse + toUIMessageStream', test: (p) => has(p, /\bcreateUIMessageStreamResponse\s*\(/) && has(p, /\btoUIMessageStream\s*\(/) },
      { id: 'result-response-helper', kind: 'deprecated', desc: 'result.toUIMessageStreamResponse() / toTextStreamResponse()', test: (p) => has(p, /\.\s*(toUIMessageStreamResponse|toTextStreamResponse|pipeUIMessageStreamToResponse)\s*\(/) },
      { id: 'v4-streaming', kind: 'removed', desc: 'toDataStreamResponse / StreamingTextResponse / ai/react', test: (p) => has(p, /\b(toDataStreamResponse|StreamingTextResponse|OpenAIStream)\b|from\s+['"]ai\/react['"]/) },
      { id: 'input-schema', kind: 'required', desc: 'tool inputSchema', test: (p) => has(p, /\binputSchema\s*:/) },
      { id: 'tool-parameters', kind: 'removed', desc: 'tool parameters: (v4)', test: someCall('tool', (a) => /\bparameters\s*:/.test(a[0] ?? '')) },
      { id: 'send-message', kind: 'required', desc: 'useChat().sendMessage', test: (p) => has(p, /\bsendMessage\s*\(/) },
      {
        id: 'v4-usechat',
        kind: 'removed',
        desc: 'useChat input/handleSubmit/handleInputChange/append',
        // Only the names destructured from useChat() itself; a component's own `input` state is fine.
        test: (p) => filesMatching(p, SRC_JS).some(([, c]) => [...c.matchAll(/\{([^{}]*)\}\s*=\s*useChat\s*(?:<[^>]*>\s*)?\(/g)].some((m) => /(^|[\s,])(handleSubmit|handleInputChange|append|input)\s*(?=[,:}]|$)/.test(m[1]))),
      },
      { id: 'message-content', kind: 'removed', desc: 'message.content instead of parts', test: (p) => has(p, /\b(m|msg|message)\.content\b/, /\.(tsx|jsx)$/) },
    ],
  },
  {
    id: 'express5-api',
    library: 'Express 5',
    ecosystem: 'npm',
    majors: [{ name: 'express', major: 5 }],
    sources: ['https://expressjs.com/en/guide/migrating-5.html'],
    smoke: 'express-api',
    prompt:
      'Create an Express 5 REST API in JavaScript with ES modules; use the newest Express 5 release. Requirements:\n' +
      '- `app.js` exports the configured `app` as its default export and never calls `listen`; `server.js` imports it and listens on port 3000.\n' +
      '- `GET /files/<any/nested/path>` responds `{ "path": "<any/nested/path>" }` (the nested segments joined with "/").\n' +
      '- `GET /docs/:name` with an optional file extension: `/docs/readme` responds `{ "name": "readme" }` and `/docs/readme.md` responds `{ "name": "readme", "ext": "md" }`.\n' +
      '- `GET /users/:id` is an async handler that awaits a lookup function; the lookup throws for id `boom`, and that error must reach a central error handler that responds 500 with `{ "error": "<message>" }`. No try/catch in the handler.\n' +
      '- `POST /users` parses a JSON body and responds 201 with `{ "id": 1, ...body }`.\n' +
      NPM_RULES,
    checks: [
      { id: 'named-wildcard', kind: 'required', desc: 'named wildcard (/*splat) in a route', test: (p) => filesMatching(p, SRC_JS).some(([, c]) => routePaths(c).some((r) => /\*[A-Za-z_$]/.test(r))) },
      { id: 'bare-wildcard', kind: 'removed', desc: 'unnamed * or (.*) in a route path', test: (p) => filesMatching(p, SRC_JS).some(([, c]) => routePaths(c).some((r) => /\*(?![A-Za-z_$])|\(\.\*\)/.test(r))) },
      { id: 'optional-param', kind: 'removed', desc: ':param? optional syntax', test: (p) => filesMatching(p, SRC_JS).some(([, c]) => routePaths(c).some((r) => /:\w+\?/.test(r))) },
      { id: 'json-status', kind: 'removed', desc: 'res.json(obj, status) / res.send(status)', test: (p) => has(p, /\bres\.(json|jsonp)\([^;]*,\s*\d{3}\s*\)|\bres\.send\(\s*\d{3}\s*\)/) },
      { id: 'removed-methods', kind: 'removed', desc: "app.del / req.param() / res.sendfile / redirect('back')", test: (p) => has(p, /\bapp\.del\s*\(|\breq\.param\s*\(|\bres\.sendfile\s*\(|\b(redirect|location)\(\s*['"]back['"]\s*\)/) },
    ],
  },
  {
    id: 'eslint10-flat',
    library: 'ESLint 10',
    ecosystem: 'npm',
    majors: [{ name: 'eslint', major: 10 }],
    sources: [
      'https://eslint.org/docs/latest/use/migrate-to-10.0.0',
      'https://eslint.org/docs/latest/use/configure/configuration-files',
      'https://typescript-eslint.io/packages/typescript-eslint/#config-deprecated',
    ],
    smoke: 'eslint-config',
    prompt:
      'Set up ESLint 10 (use the newest ESLint 10 release) for a small TypeScript Node project with typescript-eslint. Requirements:\n' +
      '- Lint the `.ts` files with the recommended rules of ESLint and of typescript-eslint.\n' +
      '- `no-console` is a warning everywhere except files under `scripts/`, where it is off.\n' +
      '- The `dist/` folder is ignored.\n' +
      '- A "lint" script in package.json that runs ESLint on the project.\n' +
      `Write the ESLint config, package.json, tsconfig.json, \`src/index.ts\` (a small exported function) and \`scripts/build.ts\` (logs a message with console.log). ${NPM_RULES}`,
    checks: [
      { id: 'flat-config', kind: 'required', desc: 'eslint.config.* at the root', test: (p) => fileExists(p, /^eslint\.config\.(js|mjs|cjs|ts|mts|cts)$/) },
      { id: 'eslintrc', kind: 'removed', desc: '.eslintrc* (unsupported in 10)', test: (p) => fileExists(p, /^\.eslintrc(\.(js|cjs|json|ya?ml))?$/) || Boolean((p.pkg as { eslintConfig?: unknown } | undefined)?.eslintConfig) },
      { id: 'eslintignore', kind: 'removed', desc: '.eslintignore (ignored by flat config)', test: (p) => fileExists(p, /^\.eslintignore$/) },
      { id: 'ext-flag', kind: 'removed', desc: 'eslint --ext / ESLINT_USE_FLAT_CONFIG in scripts', test: (p) => Object.values(p.pkg?.scripts ?? {}).some((s) => /--ext\b|ESLINT_USE_FLAT_CONFIG/.test(s)) },
      { id: 'tseslint-config', kind: 'deprecated', desc: 'tseslint.config() (deprecated for defineConfig)', test: (p) => has(p, /\b(tseslint|tsEslint|typescriptEslint)\.config\s*\(/) },
    ],
  },
  {
    id: 'pydantic2-models',
    library: 'Pydantic 2',
    ecosystem: 'pypi',
    majors: [{ name: 'pydantic', major: 2 }],
    sources: ['https://pydantic.dev/docs/validation/latest/get-started/migration/'],
    smoke: 'pydantic-models',
    prompt:
      'Create `models.py` with Pydantic 2 (use the newest Pydantic 2 release). Requirements:\n' +
      '- `User`: `id: int`; `username`, 3 to 20 characters of lowercase letters, digits or underscores, enforced by a regular-expression constraint on the field; `email: str`, lowercased by a validator on that field; `tags: list[str]` with at least one item; and an optional `nickname`. Extra keys are rejected, instances are immutable, and a User can be built from any object with matching attributes (e.g. an ORM row).\n' +
      '- `Booking`: `start: datetime` and `end: datetime`, with a validator on the whole model that rejects `end <= start`.\n' +
      '- Functions `parse_user(data: dict) -> User`, `user_to_dict(user: User) -> dict`, `user_to_json(user: User) -> str` and `user_from_obj(obj) -> User`.\n' +
      PY_RULES,
    checks: [
      { id: 'field-validator', kind: 'required', desc: '@field_validator', test: (p) => has(p, /@field_validator\s*\(/, SRC_PY) },
      { id: 'model-validator', kind: 'required', desc: '@model_validator', test: (p) => has(p, /@model_validator\s*\(/, SRC_PY) },
      { id: 'model-config', kind: 'required', desc: 'model_config = ConfigDict(...)', test: (p) => has(p, /\bmodel_config\s*=\s*(ConfigDict\s*\(|\{)/, SRC_PY) },
      { id: 'model-dump', kind: 'required', desc: 'model_dump / model_dump_json / model_validate', test: (p) => has(p, /\.model_dump\s*\(/, SRC_PY) && has(p, /\.model_dump_json\s*\(/, SRC_PY) && has(p, /\.model_validate\s*\(/, SRC_PY) },
      { id: 'v1-validators', kind: 'deprecated', desc: '@validator / @root_validator', test: (p) => has(p, /@(validator|root_validator)\s*\(/, SRC_PY) },
      { id: 'class-config', kind: 'deprecated', desc: 'class Config', test: (p) => has(p, /^\s+class\s+Config\s*[:(]/m, SRC_PY) },
      { id: 'v1-methods', kind: 'deprecated', desc: '.dict() / .json() / parse_obj / from_orm', test: (p) => has(p, /\.(dict|json)\(\s*\)|\.(parse_obj|parse_raw|from_orm)\s*\(/, SRC_PY) },
      { id: 'v1-field-args', kind: 'removed', desc: 'regex= / min_items= / orm_mode / allow_mutation', test: (p) => has(p, /\b(regex|min_items|max_items|allow_mutation)\s*=|\borm_mode\b/, SRC_PY) },
    ],
  },
  {
    id: 'langchain1-agent',
    library: 'LangChain 1',
    ecosystem: 'pypi',
    majors: [{ name: 'langchain', major: 1 }],
    sources: ['https://docs.langchain.com/oss/python/migrate/langchain-v1', 'https://docs.langchain.com/oss/python/langchain/agents'],
    smoke: 'langchain-agent',
    prompt:
      'Create `agent.py` with LangChain 1 (use the newest `langchain` 1.x release and the matching provider package) that builds a tool-calling agent on OpenAI `gpt-4o-mini`. Requirements:\n' +
      '- Two tools: `get_weather(city: str) -> str` (made-up data) and `add(a: int, b: int) -> int`.\n' +
      '- The system prompt "You are a helpful assistant."\n' +
      '- `build_agent()` returns the agent, and `ask(question: str) -> str` runs it and returns the final answer text. Building the agent must not call the network.\n' +
      PY_RULES,
    checks: [
      { id: 'create-agent', kind: 'required', desc: 'from langchain.agents import create_agent', test: (p) => has(p, /from\s+langchain\.agents\s+import\s+[^\n]*\bcreate_agent\b|from\s+langchain\.agents\s+import\s*\([^)]*\bcreate_agent\b/, SRC_PY) },
      { id: 'system-prompt', kind: 'required', desc: 'create_agent(..., system_prompt=...)', test: someCall('create_agent', (a) => a.some((x) => /^system_prompt\s*=/.test(x)), SRC_PY) },
      { id: 'prompt-kwarg', kind: 'removed', desc: 'create_agent(prompt=...) (renamed system_prompt)', test: someCall('create_agent', (a) => a.some((x) => /^prompt\s*=/.test(x)), SRC_PY) },
      {
        id: 'legacy-agents',
        kind: 'removed',
        desc: 'initialize_agent / AgentExecutor / create_*_agent / chains from langchain (moved to langchain-classic)',
        test: (p) => has(p, /from\s+langchain\.(agents|chains)\s+import\s+[^\n]*\b(initialize_agent|AgentExecutor|AgentType|create_tool_calling_agent|create_openai_tools_agent|create_openai_functions_agent|create_react_agent|LLMChain)\b|from\s+langchain\.(chat_models|llms)\s+import\s+[^\n]*\b(ChatOpenAI|OpenAI)\b/, SRC_PY),
      },
      { id: 'classic', kind: 'deprecated', desc: 'langchain_classic (legacy APIs)', test: (p) => has(p, /\blangchain_classic\b/, SRC_PY) },
      { id: 'prebuilt-react', kind: 'deprecated', desc: 'langgraph.prebuilt.create_react_agent', test: (p) => has(p, /from\s+langgraph\.prebuilt\s+import\s+[^\n]*\bcreate_react_agent\b/, SRC_PY) },
    ],
  },
];
