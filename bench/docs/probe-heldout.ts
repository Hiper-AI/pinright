/**
 * Held-out retrieval probe: questions about popular libraries that are not in the docs benchmark,
 * so a change tuned on the 25-question probe (retrieval.ts) can be checked against libraries it never
 * saw. Each probe expects strings of the API current at the pinned version, checked against the
 * official docs or changelog linked in `source`.
 *
 * Set A was written and scored before any tuning; its misses guided some of the changes in this
 * branch. Set B was written at the same time and scored only before and after, never looked at in
 * between: it is the honest number.
 *
 * Set C was written later (2026-10-30), over libraries in neither A nor B, and is scored only at the
 * start and at the end of the third round of fixes.
 *
 *   GITHUB_TOKEN=... npx tsx bench/docs/probe-heldout.ts [--set a|b|c|all] [--only lib1,lib2] [--show] [--json out.json]
 */
import { writeFileSync } from 'node:fs';
import { runProbe, type Probe, type ProbeResult } from './retrieval.js';

export interface HeldoutProbe extends Probe {
  /** Official docs or changelog the expected strings were checked against. */
  source: string;
}

const npm = (task: string, name: string, version: string, query: string, expect: RegExp[], source: string): HeldoutProbe => ({ task, ecosystem: 'npm', name, version, query, expect, source });
const pypi = (task: string, name: string, version: string, query: string, expect: RegExp[], source: string): HeldoutProbe => ({ task, ecosystem: 'pypi', name, version, query, expect, source });

export const HELDOUT_A: HeldoutProbe[] = [
  npm('react', 'react', '19.3.1', 'show a pending state while a form action runs', [/useActionState/], 'https://react.dev/reference/react/useActionState'),
  npm('react', 'react', '19.3.1', 'read a promise in render and suspend until it resolves', [/\buse\(/, /Suspense/], 'https://react.dev/reference/react/use'),
  npm('react', 'react', '19.3.1', 'optimistic UI update while a mutation is in flight', [/useOptimistic/], 'https://react.dev/reference/react/useOptimistic'),
  npm('react-router', 'react-router', '8.5.1', 'define a route with a loader and read its data in the component', [/loader/, /useLoaderData|loaderData/], 'https://reactrouter.com/start/framework/data-loading'),
  npm('react-router', 'react-router', '8.5.1', 'configure routes in routes.ts (framework mode)', [/@react-router\/dev\/routes/, /route\(/], 'https://reactrouter.com/start/framework/routing'),
  npm('react-router', 'react-router', '8.5.1', 'navigate programmatically after a form submit (useNavigate in onSubmit?)', [/redirect\(/, /action/], 'https://reactrouter.com/start/framework/navigating'),
  npm('tanstack-query', '@tanstack/react-query', '5.105.0', 'fetch data with useQuery and handle loading', [/useQuery\(\{/, /queryKey/, /isPending/], 'https://tanstack.com/query/latest/docs/framework/react/guides/queries'),
  npm('tanstack-query', '@tanstack/react-query', '5.105.0', 'invalidate a query after a mutation succeeds', [/invalidateQueries\(\{\s*queryKey/], 'https://tanstack.com/query/latest/docs/framework/react/guides/invalidations-from-mutations'),
  npm('tanstack-query', '@tanstack/react-query', '5.105.0', 'keep unused data in the cache for 10 minutes (cacheTime)', [/gcTime/], 'https://tanstack.com/query/latest/docs/framework/react/guides/caching'),
  npm('svelte', 'svelte', '5.57.3', 'reactive state and a derived value in a component', [/\$state\(/, /\$derived/], 'https://svelte.dev/docs/svelte/$derived'),
  npm('svelte', 'svelte', '5.57.3', 'receive props in a component (export let)', [/\$props\(\)/], 'https://svelte.dev/docs/svelte/$props'),
  npm('svelte', 'svelte', '5.57.3', 'run a side effect when state changes (like $: reactive statement)', [/\$effect/], 'https://svelte.dev/docs/svelte/$effect'),
  npm('vue', 'vue', '3.5.44', 'two-way binding v-model on a custom component', [/defineModel/], 'https://vuejs.org/guide/components/v-model.html'),
  npm('vue', 'vue', '3.5.44', 'access a template ref in script setup', [/useTemplateRef/], 'https://vuejs.org/guide/essentials/template-refs.html'),
  npm('vue', 'vue', '3.5.44', 'declare props with default values', [/defineProps/, /\}\s*=\s*defineProps|withDefaults|default:/], 'https://vuejs.org/guide/components/props.html'),
  npm('astro', 'astro', '7.4.4', 'define a content collection of markdown blog posts with a schema', [/defineCollection/, /glob\(/], 'https://docs.astro.build/en/guides/content-collections/'),
  npm('astro', 'astro', '7.4.4', 'server action to handle a form', [/defineAction/, /accept:\s*['"]form['"]/], 'https://docs.astro.build/en/guides/actions/'),
  npm('astro', 'astro', '7.4.4', 'render a component on the server after the page (server island)', [/server:defer/], 'https://docs.astro.build/en/guides/server-islands/'),
  npm('angular', '@angular/core', '22.2.4', 'component input as a signal (instead of @Input)', [/input\(|input\.required/], 'https://angular.dev/guide/components/inputs'),
  npm('angular', '@angular/core', '22.2.4', 'derived state from signals', [/computed\(/], 'https://angular.dev/guide/signals'),
  npm('angular', '@angular/core', '22.2.4', 'load async data into a signal from an HTTP request', [/httpResource|resource\(/], 'https://angular.dev/guide/http/http-resource'),
  npm('vite', 'vite', '8.3.5', 'proxy /api requests to a backend in the dev server', [/proxy:/], 'https://vite.dev/config/server-options'),
  npm('vite', 'vite', '8.3.5', 'environment variables exposed to client code', [/import\.meta\.env/, /VITE_/], 'https://vite.dev/guide/env-and-mode'),
  npm('vite', 'vite', '8.3.5', 'configure rollupOptions output manualChunks to split a vendor chunk', [/rolldownOptions/, /codeSplitting/], 'https://vite.dev/guide/migration'),
  npm('vitest', 'vitest', '5.0.5', 'mock a module', [/vi\.mock\(/], 'https://vitest.dev/guide/mocking/modules'),
  npm('vitest', 'vitest', '5.0.5', 'multiple test projects (vitest.workspace file)', [/projects:/], 'https://vitest.dev/guide/projects'),
  npm('vitest', 'vitest', '5.0.5', 'code coverage with v8', [/provider:\s*['"]v8['"]/], 'https://vitest.dev/guide/coverage'),
  npm('playwright', '@playwright/test', '1.64.1', 'click a button by its role and check the text', [/getByRole\(/, /toHaveText|toBeVisible/], 'https://playwright.dev/docs/locators'),
  npm('playwright', '@playwright/test', '1.64.1', 'mock a network request', [/page\.route\(/, /route\.fulfill/], 'https://playwright.dev/docs/mock'),
  npm('playwright', '@playwright/test', '1.64.1', 'reuse authentication state between tests', [/storageState/], 'https://playwright.dev/docs/auth'),
  npm('prisma', 'prisma', '7.10.1', 'configure the database connection url', [/prisma\.config\.ts/, /defineConfig/], 'https://www.prisma.io/docs/orm/reference/prisma-config-reference'),
  npm('prisma', '@prisma/client', '7.10.1', 'instantiate PrismaClient with the Postgres driver adapter', [/PrismaPg|adapter-pg/], 'https://www.prisma.io/docs/orm/overview/databases/postgresql'),
  npm('prisma', '@prisma/client', '7.10.1', 'run several writes in a transaction', [/\$transaction/], 'https://www.prisma.io/docs/orm/prisma-client/queries/transactions'),
  npm('drizzle', 'drizzle-orm', '0.45.4', 'define a postgres table schema', [/pgTable/, /drizzle-orm\/pg-core/], 'https://orm.drizzle.team/docs/sql-schema-declaration'),
  npm('drizzle', 'drizzle-orm', '0.45.4', 'select rows with a where condition', [/eq\(/, /\.where\(/], 'https://orm.drizzle.team/docs/select'),
  npm('drizzle', 'drizzle-orm', '0.45.4', 'drizzle-kit config for migrations', [/defineConfig/, /dialect:/], 'https://orm.drizzle.team/docs/drizzle-config-file'),
  npm('hono', 'hono', '4.13.14', 'validate a JSON body with zod', [/zValidator|sValidator|@hono\/zod-validator|@hono\/standard-validator/, /c\.req\.valid\(/], 'https://hono.dev/docs/guides/validation'),
  npm('hono', 'hono', '4.13.14', 'enable CORS', [/hono\/cors/], 'https://hono.dev/docs/middleware/builtin/cors'),
  npm('hono', 'hono', '4.13.14', 'run the app on Node.js', [/@hono\/node-server/, /serve\(/], 'https://hono.dev/docs/getting-started/nodejs'),
  npm('fastify', 'fastify', '5.12.7', 'validate the request body with a JSON schema', [/body:/, /type:\s*['"]object['"]/], 'https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/'),
  npm('fastify', 'fastify', '5.12.7', 'start the server on port 3000', [/listen\(\{\s*port/], 'https://fastify.dev/docs/latest/Reference/Server/'),
  npm('fastify', 'fastify', '5.12.7', 'write and register a plugin', [/register\(/], 'https://fastify.dev/docs/latest/Reference/Plugins/'),
  npm('nestjs', '@nestjs/common', '12.3.2', 'protect a route with a guard', [/CanActivate/, /@UseGuards/], 'https://docs.nestjs.com/guards'),
  npm('nestjs', '@nestjs/common', '12.3.2', 'validate request DTOs globally', [/ValidationPipe/, /useGlobalPipes/], 'https://docs.nestjs.com/techniques/validation'),
  npm('nestjs', '@nestjs/common', '12.3.2', 'dependency injection of a service into a controller', [/@Injectable/, /constructor\(\s*private/], 'https://docs.nestjs.com/providers'),
  npm('trpc', '@trpc/server', '11.22.1', 'create a router with a query procedure and zod input', [/initTRPC/, /\.input\(/], 'https://trpc.io/docs/server/procedures'),
  npm('trpc', '@trpc/server', '11.22.1', 'use tRPC with TanStack React Query hooks', [/createTRPCContext|useTRPC/, /queryOptions/], 'https://trpc.io/docs/client/tanstack-react-query/setup'),
  npm('supabase', '@supabase/supabase-js', '2.118.0', 'sign in a user with email and password', [/signInWithPassword/], 'https://supabase.com/docs/reference/javascript/auth-signinwithpassword'),
  npm('supabase', '@supabase/supabase-js', '2.118.0', 'select rows filtered by a column', [/\.from\(/, /\.eq\(/], 'https://supabase.com/docs/reference/javascript/eq'),
  npm('supabase', '@supabase/supabase-js', '2.118.0', 'subscribe to realtime inserts on a table', [/\.channel\(/, /postgres_changes/], 'https://supabase.com/docs/guides/realtime/postgres-changes'),
  npm('stripe', 'stripe', '23.1.0', 'create a checkout session for a subscription', [/checkout\.sessions\.create/, /mode:\s*['"]subscription['"]/], 'https://docs.stripe.com/api/checkout/sessions/create'),
  npm('stripe', 'stripe', '23.1.0', 'verify a webhook signature', [/constructEvent/], 'https://docs.stripe.com/webhooks/signature'),
  npm('anthropic-ts', '@anthropic-ai/sdk', '1.3.0', 'stream a message response', [/messages\.stream|stream:\s*true/], 'https://platform.claude.com/docs/en/build-with-claude/streaming'),
  npm('anthropic-ts', '@anthropic-ai/sdk', '1.3.0', 'define a tool the model can call', [/input_schema/], 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview'),
  npm('anthropic-ts', '@anthropic-ai/sdk', '1.3.0', 'send a system prompt', [/system:|role:\s*['"]system['"]/], 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/system-prompts'),
  pypi('openai-py', 'openai', '3.41.0', 'generate text with the Responses API', [/responses\.create/], 'https://github.com/openai/openai-python/blob/main/README.md'),
  pypi('openai-py', 'openai', '3.41.0', 'structured output parsed into a pydantic model', [/responses\.parse|text_format/], 'https://github.com/openai/openai-python/blob/main/helpers.md'),
  pypi('openai-py', 'openai', '3.41.0', 'stream the response', [/stream=True|responses\.stream/], 'https://github.com/openai/openai-python/blob/main/README.md'),
  pypi('anthropic-py', 'anthropic', '2.3.0', 'send a message with a system prompt', [/messages\.create/, /system=/], 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices'),
  pypi('anthropic-py', 'anthropic', '2.3.0', 'stream a message', [/messages\.stream|stream=True/], 'https://platform.claude.com/docs/en/build-with-claude/streaming'),
  pypi('fastapi', 'fastapi', '0.162.0', 'dependency injection with Annotated', [/Annotated\[/, /Depends\(/], 'https://fastapi.tiangolo.com/tutorial/dependencies/'),
  pypi('fastapi', 'fastapi', '0.162.0', 'run code on startup and shutdown (on_event)', [/lifespan/, /asynccontextmanager/], 'https://fastapi.tiangolo.com/advanced/events/'),
  pypi('fastapi', 'fastapi', '0.162.0', 'return a 404 error', [/HTTPException/], 'https://fastapi.tiangolo.com/tutorial/handling-errors/'),
  pypi('sqlalchemy', 'sqlalchemy', '2.1.6', 'declare a mapped class with type annotations', [/Mapped\[/, /mapped_column/], 'https://docs.sqlalchemy.org/en/21/orm/quickstart.html'),
  pypi('sqlalchemy', 'sqlalchemy', '2.1.6', 'query rows with select (2.0 style)', [/select\(/, /scalars\(|session\.execute/], 'https://docs.sqlalchemy.org/en/21/orm/queryguide/select.html'),
  pypi('sqlalchemy', 'sqlalchemy', '2.1.6', 'async engine and session', [/create_async_engine/, /AsyncSession|async_sessionmaker/], 'https://docs.sqlalchemy.org/en/21/orm/extensions/asyncio.html'),
  pypi('django', 'django', '6.1.2', 'run a background task (tasks framework)', [/django\.tasks|@task/, /\.enqueue\(/], 'https://docs.djangoproject.com/en/6.1/topics/tasks/'),
  pypi('django', 'django', '6.1.2', 'unique constraint across two fields', [/UniqueConstraint/], 'https://docs.djangoproject.com/en/6.1/ref/models/constraints/'),
  pypi('django', 'django', '6.1.2', 'async view', [/async def/], 'https://docs.djangoproject.com/en/6.1/topics/async/'),
  pypi('polars', 'polars', '2.1.0', 'group by and aggregate', [/group_by\(/, /\.agg\(/], 'https://docs.pola.rs/user-guide/expressions/aggregation/'),
  pypi('polars', 'polars', '2.1.0', 'read a large CSV lazily', [/scan_csv/, /\.collect\(/], 'https://docs.pola.rs/user-guide/lazy/using/'),
  pypi('polars', 'polars', '2.1.0', 'add a computed column', [/with_columns/, /pl\.col/], 'https://docs.pola.rs/user-guide/concepts/expressions-and-contexts/'),
  pypi('pytest', 'pytest', '9.2.0', 'parametrize a test with several inputs', [/@pytest\.mark\.parametrize/], 'https://docs.pytest.org/en/stable/how-to/parametrize.html'),
  pypi('pytest', 'pytest', '9.2.0', 'fixture with teardown', [/@pytest\.fixture/, /yield/], 'https://docs.pytest.org/en/stable/how-to/fixtures.html'),
  pypi('pytest', 'pytest', '9.2.0', 'temporary directory in a test', [/tmp_path/], 'https://docs.pytest.org/en/stable/how-to/tmp_path.html'),
  pypi('httpx', 'httpx', '0.28.1', 'async client with a timeout', [/AsyncClient/, /Timeout\(|timeout=/], 'https://www.python-httpx.org/advanced/timeouts/'),
  pypi('httpx', 'httpx', '0.28.1', 'retry failed connections', [/retries=/], 'https://www.python-httpx.org/advanced/transports/'),
  pypi('celery', 'celery', '5.6.3', 'define a task and call it asynchronously', [/@app\.task|shared_task/, /\.delay\(|apply_async/], 'https://docs.celeryq.dev/en/stable/getting-started/first-steps-with-celery.html'),
  pypi('celery', 'celery', '5.6.3', 'run a periodic task every morning', [/beat_schedule/, /crontab/], 'https://docs.celeryq.dev/en/stable/userguide/periodic-tasks.html'),
  pypi('typer', 'typer', '0.27.3', 'CLI command with an option and an argument', [/Annotated\[/, /typer\.Option/], 'https://typer.tiangolo.com/tutorial/options/help/'),
  pypi('typer', 'typer', '0.27.3', 'group subcommands', [/add_typer/], 'https://typer.tiangolo.com/tutorial/subcommands/add-typer/'),
];

export const HELDOUT_B: HeldoutProbe[] = [
  npm('mongoose', 'mongoose', '9.11.4', 'hash the password in a pre save hook and call next() when done', [/pre\(\s*['"]save['"],\s*async function/], 'https://mongoosejs.com/docs/middleware.html'),
  npm('mongoose', 'mongoose', '9.11.4', 'make findOneAndUpdate return the updated document instead of the original (new: true)', [/returnDocument:\s*['"]after['"]/], 'https://mongoosejs.com/docs/tutorials/findoneandupdate.html'),
  npm('mongoose', 'mongoose', '9.11.4', 'what TypeScript type should I use for a query filter object passed to Model.find (FilterQuery)', [/QueryFilter/], 'https://mongoosejs.com/docs/migrating_to_9.html'),
  npm('redux-toolkit', '@reduxjs/toolkit', '2.13.0', 'handle createAsyncThunk pending and fulfilled actions in a slice with the extraReducers object map', [/extraReducers:\s*\(builder\)/, /\.addCase\(/], 'https://redux.js.org/toolkit/api/createSlice'),
  npm('redux-toolkit', '@reduxjs/toolkit', '2.13.0', 'add a custom logger middleware to configureStore while keeping the default middleware', [/getDefaultMiddleware\(\)\s*\.concat\(/], 'https://redux.js.org/toolkit/api/configureStore'),
  npm('zustand', 'zustand', '5.0.16', 'select several values from a store as an object without extra re-renders', [/useShallow\(/], 'https://zustand.docs.pmnd.rs/learn/guides/prevent-rerenders-with-use-shallow'),
  npm('zustand', 'zustand', '5.0.16', 'type a store with TypeScript when calling create', [/create<\w+>\(\)\(/], 'https://zustand.docs.pmnd.rs/learn/guides/beginner-typescript'),
  npm('better-auth', 'better-auth', '1.7.14', 'get the current user session on the server inside a route handler', [/auth\.api\.getSession\(/, /headers/], 'https://www.better-auth.com/docs/concepts/session-management'),
  npm('better-auth', 'better-auth', '1.7.14', 'mount the auth handler in a Next.js App Router route', [/toNextJsHandler\(/, /better-auth\/next-js/], 'https://www.better-auth.com/docs/installation'),
  npm('sveltekit', '@sveltejs/kit', '3.1.0', 'read the current URL and route params in a component (I used the $page store)', [/from\s+['"]\$app\/state['"]/, /page\.url/], 'https://svelte.dev/docs/kit/$app-state'),
  npm('sveltekit', '@sveltejs/kit', '3.1.0', 'handle a form POST on the server, return validation errors, and progressively enhance the form', [/export const actions/, /fail\(/, /use:enhance/], 'https://svelte.dev/docs/kit/form-actions'),
  npm('sveltekit', '@sveltejs/kit', '3.1.0', 'redirect to an external URL from a load function', [/redirect\(/, /external:\s*true/], 'https://svelte.dev/docs/kit/migrating-to-sveltekit-3'),
  npm('jotai', 'jotai', '3.0.1', 'create parameterized atoms per id with atomFamily from jotai/utils', [/['"]jotai-family['"]/], 'https://jotai.org/docs/guides/migrating-to-v3'),
  npm('jotai', 'jotai', '3.0.1', 'read an async atom without Suspense using loadable', [/unwrap\(/, /jotai\/utils/], 'https://jotai.org/docs/utilities/async'),
  pypi('pandas', 'pandas', '3.1.0', 'set a column value for rows matching a condition; df["foo"][df["bar"] > 5] = 100 does nothing / SettingWithCopyWarning', [/\.loc\[/, /chained assignment/i], 'https://pandas.pydata.org/docs/user_guide/migration.html'),
  pypi('pandas', 'pandas', '3.1.0', 'what dtype does pandas infer for a column of strings by default', [/dtype:\s*str\b/], 'https://pandas.pydata.org/docs/whatsnew/v3.0.0.html'),
  pypi('pandas', 'pandas', '3.1.0', 'groupby and compute several aggregations with custom output column names', [/\.agg\(/, /NamedAgg|\w+=\(\s*['"]\w+['"],\s*['"]\w+['"]\s*\)/], 'https://pandas.pydata.org/docs/user_guide/groupby.html'),
  pypi('numpy', 'numpy', '2.5.4', 'numerically integrate samples with np.trapz', [/trapezoid/], 'https://numpy.org/doc/stable/reference/generated/numpy.trapezoid.html'),
  pypi('numpy', 'numpy', '2.5.4', 'test which elements of an array are in another array with np.in1d', [/isin\(/], 'https://numpy.org/doc/stable/reference/generated/numpy.isin.html'),
  pypi('numpy', 'numpy', '2.5.4', 'generate reproducible random numbers (np.random.seed then np.random.rand)', [/default_rng\(/], 'https://numpy.org/doc/stable/reference/random/index.html'),
  pypi('requests', 'requests', '2.34.2', 'automatically retry failed requests with backoff on 502/503/504', [/HTTPAdapter\(max_retries\s*=/, /Retry\(/], 'https://requests.readthedocs.io/en/latest/user/advanced/'),
  pypi('requests', 'requests', '2.34.2', 'POST a JSON body and set a timeout', [/json\s*=/, /timeout\s*=/], 'https://requests.readthedocs.io/en/latest/user/quickstart/'),
  pypi('flask', 'flask', '3.1.3', 'rotate the SECRET_KEY without logging out existing sessions', [/SECRET_KEY_FALLBACKS/], 'https://flask.palletsprojects.com/en/stable/config/'),
  pypi('flask', 'flask', '3.1.3', 'limit request body size and multipart form field size/count', [/MAX_CONTENT_LENGTH/, /MAX_FORM_MEMORY_SIZE|MAX_FORM_PARTS/], 'https://flask.palletsprojects.com/en/stable/config/'),
  pypi('pydantic-settings', 'pydantic-settings', '2.16.2', 'load settings from a .env file (inner class Config with env_file)', [/SettingsConfigDict\(/, /env_file\s*=/], 'https://pydantic.dev/docs/validation/latest/concepts/pydantic_settings/'),
  pypi('pydantic-settings', 'pydantic-settings', '2.16.2', 'populate a nested settings model from environment variables like DB__HOST', [/env_nested_delimiter\s*=\s*['"]__['"]/], 'https://pydantic.dev/docs/validation/latest/concepts/pydantic_settings/'),
  pypi('sqlmodel', 'sqlmodel', '0.0.48', 'query rows with a WHERE filter (session.query(Hero).filter)', [/select\(\w+\)\.where\(/, /session\.exec\(/], 'https://sqlmodel.tiangolo.com/tutorial/where/'),
  pypi('sqlmodel', 'sqlmodel', '0.0.48', 'partially update a row from a FastAPI PATCH body', [/model_dump\(exclude_unset=True\)/, /sqlmodel_update\(/], 'https://sqlmodel.tiangolo.com/tutorial/fastapi/update/'),
];

export const HELDOUT_C: HeldoutProbe[] = [
  npm('nuxt', 'nuxt', '4.6.3', 'where do pages/, components/ and composables/ go in a Nuxt 4 project? I keep them at the project root like in Nuxt 3', [/srcDir/, /app\//], 'https://nuxt.com/docs/4.x/getting-started/upgrade'),
  npm('nuxt', 'nuxt', '4.6.3', 'useFetch: my check data.value === null before the request finishes stopped working; also what replaces dedupe: true', [/undefined/, /['"]cancel['"]/], 'https://nuxt.com/docs/4.x/getting-started/upgrade'),
  npm('nuxt', 'nuxt', '4.6.3', 'expose a public API base URL to the client and override it with an environment variable in production', [/useRuntimeConfig\(/, /NUXT_PUBLIC_/], 'https://nuxt.com/docs/4.x/guide/going-further/runtime-config'),
  npm('solid-start', '@solidjs/start', '2.1.0', 'set the deployment preset in app.config.ts (defineConfig from @solidjs/start/config with server.preset)', [/solidStart\(/, /from\s+['"]nitro\/vite['"]/], 'https://docs.solidjs.com/solid-start/v2/migrating-from-v1'),
  npm('solid-start', '@solidjs/start', '2.1.0', 'read a cookie and the session inside a server function (getCookie and useSession from vinxi/http)', [/@solidjs\/start\/http/], 'https://docs.solidjs.com/solid-start/v2/migrating-from-v1'),
  npm('solid-start', '@solidjs/start', '2.1.0', 'load posts from the database on the server for a route with cache() and createAsync', [/query\(/, /['"]use server['"]/, /createAsync/], 'https://docs.solidjs.com/solid-start/v2/guides/data-fetching'),
  npm('elysia', 'elysia', '1.4.30', 'call my Elysia API type-safely from the frontend with edenTreaty from @elysiajs/eden', [/treaty</, /@elysia\/eden/], 'https://elysiajs.com/eden/treaty/overview'),
  npm('elysia', 'elysia', '1.4.30', 'return 401 Unauthorized with a message from a handler using the error() helper', [/status\(\s*\d{3}/], 'https://elysiajs.com/blog/elysia-14'),
  npm('elysia', 'elysia', '1.4.30', 'auth macro that resolves the current user for the routes that opt in (macro with onBeforeHandle)', [/\.macro\(\{/, /resolve/], 'https://elysiajs.com/patterns/macro'),
  npm('effect', 'effect', '4.1.0', 'define a service with Context.Tag and provide its implementation with a Layer', [/Context\.Service</, /Layer\.effect\(/], 'https://github.com/Effect-TS/effect/blob/main/migration/services.md'),
  npm('effect', 'effect', '4.1.0', 'recover from any failure with Effect.catchAll; recover only from some errors with catchSome', [/Effect\.catch\b(?!All)/, /catchFilter/], 'https://github.com/Effect-TS/effect/blob/main/migration/error-handling.md'),
  npm('effect', 'effect', '4.1.0', 'turn a failing Effect into a value I can inspect (Effect.either, then Either.isLeft)', [/Effect\.result/, /effect\/Result|Result\.(?:succeed|fail)/], 'https://github.com/Effect-TS/effect/blob/main/migration/v3-to-v4.md'),
  npm('effect', 'effect', '4.1.0', 'start a background fiber that outlives its parent (Effect.forkDaemon)', [/forkDetach/], 'https://github.com/Effect-TS/effect/blob/main/migration/forking.md'),
  npm('kysely', 'kysely', '0.29.7', 'run migrations to latest with Migrator and FileMigrationProvider imported from kysely', [/['"]kysely\/migration['"]/, /migrateToLatest\(/], 'https://kysely.dev/docs/migrations'),
  npm('kysely', 'kysely', '0.29.7', 'begin a transaction without the db.transaction().execute callback, set a savepoint and roll back to it on error', [/startTransaction\(\)/, /rollbackToSavepoint\(/], 'https://kysely.dev/docs/examples/transactions/controlled-transaction-w-savepoints'),
  npm('kysely', 'kysely', '0.29.7', 'select users with their pets as a nested JSON array in one Postgres query', [/jsonArrayFrom/, /kysely\/helpers\/postgres/], 'https://kysely.dev/docs/recipes/relations'),
  npm('bullmq', 'bullmq', '6.5.1', 'run a job every day at 3am with the repeat option of queue.add', [/upsertJobScheduler\(/, /pattern:/], 'https://docs.bullmq.io/guide/job-schedulers'),
  npm('bullmq', 'bullmq', '6.5.1', 'ignore duplicate jobs added within 5 seconds (debounce option)', [/deduplication:\s*\{/, /ttl:/], 'https://docs.bullmq.io/guide/jobs/deduplication'),
  npm('bullmq', 'bullmq', '6.5.1', 'get the underlying Redis client of a Queue (queue.client) to run a custom command', [/getBackend\(/], 'https://docs.bullmq.io/changelog'),
  npm('pino', 'pino', '10.4.0', 'pretty print logs in development (prettyPrint: true)', [/transport/, /target:\s*['"]pino-pretty['"]/], 'https://github.com/pinojs/pino/blob/main/docs/pretty.md'),
  npm('pino', 'pino', '10.4.0', 'write logs to a file and to stdout at the same time', [/targets:/, /['"]pino\/file['"]/], 'https://github.com/pinojs/pino/blob/main/docs/transports.md'),
  npm('pino', 'pino', '10.4.0', 'hide the password field and the authorization header from the logs', [/redact:/], 'https://github.com/pinojs/pino/blob/main/docs/redaction.md'),
  pypi('litestar', 'litestar', '2.25.0', 'inject a database session dependency declared with Provide into a route handler (parameter named after the key)', [/Provide\(/, /NamedDependency/], 'https://docs.litestar.dev/latest/usage/dependency-injection.html'),
  pypi('litestar', 'litestar', '2.25.0', 'exclude the password field from the response with a DTO', [/DTOConfig\(/, /exclude=/, /return_dto=/], 'https://docs.litestar.dev/latest/usage/dto/1-abstract-dto.html'),
  pypi('pandera', 'pandera', '0.35.0', 'define a DataFrameModel schema for a pandas DataFrame (import pandera as pa) with month between 1 and 12', [/import pandera\.pandas as pa/, /DataFrameModel/], 'https://pandera.readthedocs.io/en/stable/dataframe_models.html'),
  pypi('pandera', 'pandera', '0.35.0', 'collect every validation error at once instead of stopping at the first', [/lazy=True/, /SchemaErrors/], 'https://pandera.readthedocs.io/en/stable/lazy_validation.html'),
  pypi('pandera', 'pandera', '0.35.0', 'validate a polars LazyFrame; my value checks (in_range) do not seem to run', [/pandera\.polars/, /PANDERA_VALIDATION_DEPTH|SCHEMA_AND_DATA/], 'https://pandera.readthedocs.io/en/stable/polars.html'),
  pypi('duckdb-py', 'duckdb', '2.0.0', 'get query results as an Arrow table with con.execute(query).fetch_arrow_table()', [/to_arrow_table\(\)/, /con\.sql\(/], 'https://github.com/duckdb/duckdb-python/releases/tag/v2.0.0'),
  pypi('duckdb-py', 'duckdb', '2.0.0', 'compare two columns in a relational filter: rel.filter(c("s") == "x") stopped matching rows after upgrading', [/(?:c|col|ColumnExpression)\(\s*["']x["']\s*\)/], 'https://github.com/duckdb/duckdb-python/releases/tag/v2.0.0'),
  pypi('duckdb-py', 'duckdb', '2.0.0', 'list_transform(l, x -> x + 1) in duckdb.sql now fails with a syntax error', [/lambda\s+x\s*:/, /lambda_syntax/], 'https://duckdb.org/docs/2.0/operations_manual/migration'),
  pypi('langgraph', 'langgraph', '1.2.18', 'pause the graph for human approval before a tool runs (interrupt_before / NodeInterrupt) and resume it', [/interrupt\(/, /Command\(\s*resume\s*=/], 'https://docs.langchain.com/oss/python/langgraph/interrupts'),
  pypi('langgraph', 'langgraph', '1.2.18', 'build a ReAct agent with tools using create_react_agent from langgraph.prebuilt', [/\bcreate_agent\b/], 'https://docs.langchain.com/oss/python/releases/langgraph-v1'),
  pypi('langgraph', 'langgraph', '1.2.18', 'pass per-run context like user_id or the LLM provider to nodes (config_schema / config["configurable"])', [/context_schema\s*=/, /Runtime\[/], 'https://docs.langchain.com/oss/python/langgraph/graph-api'),
  pypi('llama-index', 'llama-index-core', '0.14.25', 'set the default LLM and embedding model for everything (ServiceContext.from_defaults)', [/Settings\.llm\s*=/, /Settings\.embed_model/], 'https://developers.llamaindex.ai/python/framework/module_guides/supporting_modules/settings/'),
  pypi('llama-index', 'llama-index-core', '0.14.25', 'create a tool-calling agent with ReActAgent.from_tools(tools, llm=llm) and ask it a question', [/llama_index\.core\.agent\.workflow/, /await agent\.run\(/], 'https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/'),
  pypi('llama-index', 'llama-index-core', '0.14.25', 'save a VectorStoreIndex to disk and load it back later', [/persist\(persist_dir/, /load_index_from_storage/], 'https://developers.llamaindex.ai/python/framework/module_guides/storing/save_load/'),
  pypi('instructor', 'instructor', '1.17.0', 'get a pydantic model back from OpenAI with instructor.patch(OpenAI()) or instructor.from_openai', [/from_provider\(/, /response_model\s*=/], 'https://python.useinstructor.com/'),
  pypi('instructor', 'instructor', '1.17.0', 'stream a partially filled object while the model is still generating', [/create_partial\(/], 'https://python.useinstructor.com/concepts/partial/'),
  pypi('instructor', 'instructor', '1.17.0', 'use instructor with Claude (instructor.from_anthropic(Anthropic()))', [/from_provider\(/, /['"]anthropic\//], 'https://python.useinstructor.com/integrations/anthropic/'),
  pypi('ruff', 'ruff', '0.17.3', 'pyproject.toml: I put select = ["E", "F", "B"] and ignore under [tool.ruff] and ruff warns about it', [/\[tool\.ruff\.lint\]/], 'https://docs.astral.sh/ruff/settings/'),
  pypi('ruff', 'ruff', '0.17.3', 'ignore E402 only in __init__.py files', [/\[tool\.ruff\.lint\.per-file-ignores\]/], 'https://docs.astral.sh/ruff/configuration/'),
  pypi('ruff', 'ruff', '0.17.3', 'make ruff format use single quotes and tabs', [/\[tool\.ruff\.format\]/, /quote-style\s*=\s*["']single["']/], 'https://docs.astral.sh/ruff/formatter/'),
  pypi('uv', 'uv', '0.13.6', 'monorepo with several Python packages that depend on each other', [/\[tool\.uv\.workspace\]/, /workspace\s*=\s*true/], 'https://docs.astral.sh/uv/concepts/projects/workspaces/'),
  pypi('uv', 'uv', '0.13.6', 'add pytest as a dev dependency (tool.uv.dev-dependencies)', [/\[dependency-groups\]/, /uv add --dev/], 'https://docs.astral.sh/uv/concepts/projects/dependencies/'),
  pypi('uv', 'uv', '0.13.6', 'install torch from the PyTorch CPU index without using that index for other packages', [/\[\[tool\.uv\.index\]\]/, /explicit\s*=\s*true/], 'https://docs.astral.sh/uv/guides/integration/pytorch/'),
];

export { npm as heldoutNpm, pypi as heldoutPypi };

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bench/docs/probe-heldout.ts');
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const set = opt('--set') ?? 'a';
  const only = (opt('--only') ?? '').split(',').filter(Boolean);
  const probes = (set === 'b' ? HELDOUT_B : set === 'c' ? HELDOUT_C : set === 'all' ? [...HELDOUT_A, ...HELDOUT_B, ...HELDOUT_C] : HELDOUT_A).filter((p) => !only.length || only.includes(p.task));
  const results: (ProbeResult & { ms: number })[] = [];
  for (const p of probes) {
    const t0 = Date.now();
    const r = { ...(await runProbe(p)), ms: Date.now() - t0 };
    results.push(r);
    console.log(`${r.pass ? 'OK  ' : 'MISS'} ${p.task} ${p.name}@${p.version} "${p.query}" ${r.chars} chars ${r.ms} ms${r.missing.length ? ` missing ${r.missing.join(' ')}` : ''}`);
    if (args.includes('--show') && !r.pass) {
      console.log(`     sections: ${[...new Set(r.sources)].join(' | ').slice(0, 600)}`);
    }
  }
  const pass = results.filter((r) => r.pass).length;
  const chars = results.reduce((a, r) => a + r.chars, 0) / (results.length || 1);
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`${pass} / ${results.length} held-out probes (set ${set}) answered with the current API; mean ${Math.round(chars)} chars, median ${ms[Math.floor(ms.length / 2)] ?? 0} ms, total ${ms.reduce((a, b) => a + b, 0)} ms`);
  const out = opt('--json');
  if (out) writeFileSync(out, JSON.stringify(results.map((r) => ({ task: r.probe.task, name: r.probe.name, query: r.probe.query, pass: r.pass, missing: r.missing, chars: r.chars, ms: r.ms })), null, 2));
}
