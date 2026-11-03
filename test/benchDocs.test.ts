import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callArgs, npmMajor, npmVersion, projectFromFiles, pypiMajor, pypiVersion, runChecks, stripJsComments, stripPyComments, versionAtLeast } from '../bench/docs/checks.js';
import { ALL_TASKS, taskSet } from '../bench/docs/sets.js';
import { tailwindCssTests } from '../bench/docs/smoke.js';
import { TASKS } from '../bench/docs/tasks.js';
import { wilson } from '../bench/stats.js';

const FIXTURES = join(import.meta.dirname, '..', 'bench', 'docs', 'fixtures');

function fixture(task: string): Record<string, string> {
  const root = join(FIXTURES, task);
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p).replace(/\\/g, '/')] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

const task = (id: string) => ALL_TASKS.find((t) => t.id === id)!;
/** The ids of the checks a project fails. */
function failing(id: string, files: Record<string, string>): string[] {
  return runChecks(projectFromFiles(files), task(id).checks).filter((c) => !c.pass).map((c) => c.id).sort();
}
/** A fixture with some files replaced or removed. */
function variant(id: string, patch: Record<string, string | null>): Record<string, string> {
  const f = fixture(id);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete f[k];
    else f[k] = v;
  }
  return f;
}

describe('docs benchmark: helpers', () => {
  it('strips JS comments but keeps strings, URLs and template literals', () => {
    const src = "const u = 'http://x.dev/a'; // revalidateTag('a')\n/* middleware */ const t = `a // b`;";
    const s = stripJsComments(src);
    expect(s).toContain("'http://x.dev/a'");
    expect(s).toContain('`a // b`');
    expect(s).not.toContain('revalidateTag');
    expect(s).not.toContain('middleware');
  });

  it('strips Python comments but keeps strings with #', () => {
    const s = stripPyComments('x = "a # b"  # .dict()\n# @validator("x")\ny = 1');
    expect(s).toContain('"a # b"');
    expect(s).not.toContain('.dict()');
    expect(s).not.toContain('@validator');
  });

  it('splits call arguments at top-level commas only', () => {
    expect(callArgs("revalidateTag(`team-${id}`, 'max'); revalidateTag(tag(a, b))", 'revalidateTag')).toEqual([["`team-${id}`", "'max'"], ['tag(a, b)']]);
    expect(callArgs('z.record(z.string(), z.string()); x.z.record(a)', 'z.record')).toEqual([['z.string()', 'z.string()']]);
    expect(callArgs("s.min(8, { error: 'x, y' })", '.min')).toEqual([['8', "{ error: 'x, y' }"]]);
  });

  it('reads pinned majors from package.json and requirements.txt', () => {
    const p = projectFromFiles({ 'package.json': '{"dependencies":{"next":"16.4.3"},"devDependencies":{"zod":"^4.1.0"}}', 'requirements.txt': 'pydantic==2.14.2\nLangChain[openai]>=1.0\nrequests\n' });
    expect(npmMajor(p, 'next')).toBe(16);
    expect(npmMajor(p, 'zod')).toBe(4);
    expect(npmMajor(p, 'ai')).toBeUndefined();
    expect(pypiMajor(p, 'pydantic')).toBe(2);
    expect(pypiMajor(p, 'langchain')).toBe(1);
    expect(pypiMajor(p, 'requests')).toBeUndefined();
  });

  it('reads full pinned versions and compares them with a minimum', () => {
    const p = projectFromFiles({ 'package.json': '{"dependencies":{"hono":"4.13.16","zod":"4.5.0-canary.20260817T190646"}}', 'requirements.txt': 'langchain[mcp]==1.4.8\npandas==3.1.0rc0\n' });
    expect(npmVersion(p, 'hono')).toBe('4.13.16');
    expect(pypiVersion(p, 'langchain')).toBe('1.4.8');
    expect(versionAtLeast('4.13.16', '4.13.13')).toBe(true);
    expect(versionAtLeast('4.13.12', '4.13.13')).toBe(false);
    expect(versionAtLeast('0.162.0', '0.142.0')).toBe(true);
    expect(versionAtLeast('1.4', '1.4.0')).toBe(true);
    expect(versionAtLeast(npmVersion(p, 'zod'), '4.5.0')).toBe(false);
    expect(versionAtLeast(pypiVersion(p, 'pandas'), '3.1.0')).toBe(false);
    expect(versionAtLeast(undefined, '1.0.0')).toBe(false);
  });

  it('computes Wilson intervals', () => {
    const [lo, hi] = wilson(16, 16);
    expect(lo).toBeCloseTo(0.806, 3);
    expect(hi).toBe(1);
    const [lo0, hi0] = wilson(0, 16);
    expect(lo0).toBe(0);
    expect(hi0).toBeCloseTo(0.194, 3);
  });
});

describe('docs benchmark: task sets', () => {
  it('keeps the v6 set as it was and adds eight post-cutoff tasks with unique ids', () => {
    expect(taskSet('v6')).toBe(TASKS);
    expect(taskSet('post-cutoff')).toHaveLength(8);
    expect(new Set(ALL_TASKS.map((t) => t.id)).size).toBe(ALL_TASKS.length);
  });

  it('every post-cutoff API first shipped on or after 2026-08-01', () => {
    for (const t of taskSet('post-cutoff')) {
      expect(t.evidence, t.id).toBeDefined();
      expect(t.evidence!.published >= '2026-08-01', t.id).toBe(true);
      expect(t.majors.every((m) => m.min), t.id).toBe(true);
    }
  });
});

describe('docs benchmark: every reference solution passes every check', () => {
  for (const t of ALL_TASKS) {
    it(t.id, () => expect(failing(t.id, fixture(t.id))).toEqual([]));
  }
});

describe('docs benchmark: old APIs are caught, current ones are not', () => {
  it('next16: middleware.ts, sync cookies and params, one-argument revalidateTag', () => {
    const f = variant('next16-proxy', {
      'proxy.ts': null,
      'middleware.ts': "import { NextResponse } from 'next/server';\n// proxy.ts is the new name\nexport function middleware(req) { return NextResponse.next(); }\n",
      'app/dashboard/[team]/page.tsx': "import { cookies } from 'next/headers';\nexport default function Page({ params }: { params: { team: string } }) {\n  const theme = cookies().get('theme');\n  return <h1>Team: {params.team}</h1>;\n}\n",
      'app/dashboard/[team]/actions.ts': "'use server';\nimport { revalidateTag } from 'next/cache';\nexport async function refreshTeam(team: string) { revalidateTag(`team-${team}`); }\n",
    });
    expect(failing('next16-proxy', f)).toEqual(['middleware-file', 'proxy-file', 'revalidateTag-1arg', 'sync-cookies', 'sync-params']);
  });

  it('next16: awaited cookies and destructured Promise params are fine; await cookies().get is not', () => {
    const page = (body: string) => variant('next16-proxy', { 'app/dashboard/[team]/page.tsx': body });
    expect(failing('next16-proxy', page("export default async function P({ params }: PageProps<'/dashboard/[team]'>) { const c = await cookies(); const { team } = await params; return c.get('theme') && team; }"))).toEqual([]);
    expect(failing('next16-proxy', page('export default async function P() { const t = await cookies().get("theme"); return t; }'))).toEqual(['sync-cookies']);
    expect(failing('next16-proxy', variant('next16-proxy', { 'src/proxy.ts': 'export default function proxy() {}', 'proxy.ts': null }))).toEqual([]);
  });

  it('tailwind4: v3 directives, PostCSS plugin, JS config, @layer utilities and opacity utilities', () => {
    const f = variant('tailwind4-vite', {
      'src/index.css': '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n@layer utilities { .content-auto { content-visibility: auto; } }\n',
      'postcss.config.js': 'export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n',
      'tailwind.config.js': "export default { content: ['./src/**/*.tsx'], darkMode: 'class' };\n",
      'src/App.tsx': '<div className="bg-black bg-opacity-50" />',
      'package.json': '{"devDependencies":{"tailwindcss":"4.3.3"}}',
    });
    expect(failing('tailwind4-vite', f)).toEqual([
      'css-import', 'dark-variant', 'js-config', 'layer-utilities', 'opacity-utilities', 'postcss-tailwindcss', 'tailwind-directives', 'theme-block', 'utility-at-rule', 'v4-plugin',
    ]);
  });

  it('tailwind4: @tailwindcss/postcss is not the removed PostCSS plugin', () => {
    const f = variant('tailwind4-vite', { 'postcss.config.mjs': 'export default { plugins: { "@tailwindcss/postcss": {} } };\n' });
    expect(failing('tailwind4-vite', f)).toEqual([]);
  });

  it('zod4: v3 idioms', () => {
    const f = variant('zod4-schema', {
      'src/signup.ts': "import { z } from 'zod';\nexport const S = z.object({ email: z.string().email({ message: 'bad' }), role: z.nativeEnum(Role), tags: z.record(z.string()), n: z.number({ required_error: 'x' }) }).strict();\nexport const v = (r) => r.error.flatten();\n",
    });
    expect(failing('zod4-schema', f)).toEqual(['format-flatten', 'message-param', 'native-enum', 'record-1arg', 'strict-method', 'string-email', 'v3-error-params', 'z-email']);
  });

  it('zod4: a result object with a message key is not the deprecated message param', () => {
    const src = fixture('zod4-schema')['src/signup.ts'].replace('message: z.prettifyError(r.error)', 'message: z.prettifyError(r.error), detail: { message: "x" }');
    expect(failing('zod4-schema', variant('zod4-schema', { 'src/signup.ts': src }))).toEqual([]);
  });

  it('ai-sdk7: v4/v5 idioms', () => {
    const f = variant('ai-sdk7-chat', {
      'app/api/chat/route.ts': "import { streamText, tool, stepCountIs } from 'ai';\nexport async function POST(req) {\n  const r = streamText({ model, system: 'x', maxSteps: 5, stopWhen: stepCountIs(5), tools: { w: tool({ parameters: z.object({}) }) } });\n  return r.toDataStreamResponse();\n}\n",
      'app/page.tsx': "'use client';\nimport { useChat } from 'ai/react';\nexport default function P() { const { messages, input, handleSubmit } = useChat(); return messages.map((m) => m.content); }\n",
    });
    expect(failing('ai-sdk7-chat', f)).toEqual([
      'input-schema', 'instructions', 'is-step-count', 'max-steps', 'message-content', 'send-message', 'step-count-is', 'tool-parameters', 'ui-stream-response', 'v4-streaming', 'v4-usechat',
    ]);
  });

  it('ai-sdk7: a component input state next to useChat is not useChat().input (seen in a real run)', () => {
    const page = "'use client';\nexport default function Page() {\n  const [input, setInput] = useState('');\n  const { messages, sendMessage } = useChat({\n    transport: new DefaultChatTransport({ api: '/api/chat' }),\n  });\n  return messages.map((message) => message.parts.map((p) => p.text));\n}\n";
    expect(failing('ai-sdk7-chat', variant('ai-sdk7-chat', { 'app/page.tsx': page }))).toEqual(['send-message']);
    const old = "const { messages, input: text, handleInputChange } = useChat<UIMessage>({ api: '/api/chat' });";
    expect(failing('ai-sdk7-chat', variant('ai-sdk7-chat', { 'app/page.tsx': `${fixture('ai-sdk7-chat')['app/page.tsx']}\n${old}` }))).toEqual(['v4-usechat']);
  });

  it('ai-sdk7: a form handler named handleSubmit is not useChat().handleSubmit', () => {
    const page = fixture('ai-sdk7-chat')['app/page.tsx'].replace('<form\n', '<form data-x={handleSubmit}\n').replace("  const [text, setText] = useState('');", "  const [text, setText] = useState('');\n  const handleSubmit = () => sendMessage({ text });");
    expect(failing('ai-sdk7-chat', variant('ai-sdk7-chat', { 'app/page.tsx': page }))).toEqual([]);
  });

  it('express5: unnamed wildcards, optional params and removed response signatures', () => {
    const f = variant('express5-api', {
      'app.js': "import express from 'express';\nconst app = express();\napp.get('/files/*', (req, res) => res.json({ path: req.params[0] }, 200));\napp.get('/docs/:name.:ext?', (req, res) => res.send(404));\napp.del('/x', (req, res) => res.redirect('back'));\nexport default app;\n",
    });
    expect(failing('express5-api', f)).toEqual(['bare-wildcard', 'json-status', 'named-wildcard', 'optional-param', 'removed-methods']);
  });

  it('express5: {*splat} and braces are current syntax', () => {
    const src = fixture('express5-api')['app.js'].replace("'/files/*splat'", "'/files/{*rest}'");
    expect(failing('express5-api', variant('express5-api', { 'app.js': src }))).toEqual([]);
  });

  it('eslint10: eslintrc, eslintignore, --ext and tseslint.config()', () => {
    const f = variant('eslint10-flat', {
      'eslint.config.js': null,
      'eslint.config.mjs': "import tseslint from 'typescript-eslint';\nexport default tseslint.config({ rules: {} });\n",
      '.eslintrc.json': '{}',
      '.eslintignore': 'dist',
      'package.json': '{"scripts":{"lint":"eslint --ext .ts ."},"devDependencies":{"eslint":"10.13.0"}}',
    });
    expect(failing('eslint10-flat', f)).toEqual(['eslintignore', 'eslintrc', 'ext-flag', 'tseslint-config']);
  });

  it('pydantic2: v1 API', () => {
    const f = variant('pydantic2-models', {
      'models.py': 'from pydantic import BaseModel, Field, validator, root_validator\n\nclass User(BaseModel):\n    username: str = Field(regex="^a$")\n    tags: list = Field(min_items=1)\n\n    class Config:\n        orm_mode = True\n\n    @validator("email")\n    def v(cls, x):\n        return x\n\n    @root_validator\n    def r(cls, v):\n        return v\n\ndef f(u):\n    return u.dict(), u.json(), User.parse_obj({}), User.from_orm(u)\n',
    });
    expect(failing('pydantic2-models', f)).toEqual(['class-config', 'field-validator', 'model-config', 'model-dump', 'model-validator', 'v1-field-args', 'v1-methods', 'v1-validators']);
  });

  it('pydantic2: a json() call in a comment or a string does not count', () => {
    const src = fixture('pydantic2-models')['models.py'] + '\n# old: user.json()\nNOTE = "use .dict() in v1"\n';
    expect(failing('pydantic2-models', variant('pydantic2-models', { 'models.py': src }))).toEqual(['v1-methods']);
    const clean = fixture('pydantic2-models')['models.py'] + '\n# old: user.json()\n';
    expect(failing('pydantic2-models', variant('pydantic2-models', { 'models.py': clean }))).toEqual([]);
  });

  it('langchain1: legacy agents, prompt= and langgraph prebuilt', () => {
    const f = variant('langchain1-agent', {
      'agent.py': 'from langchain.agents import AgentExecutor, create_tool_calling_agent\nfrom langchain.chat_models import ChatOpenAI\nfrom langgraph.prebuilt import create_react_agent\nfrom langchain_classic.chains import LLMChain\n\ndef build_agent():\n    return create_react_agent(model, tools, prompt="x")\n',
    });
    expect(failing('langchain1-agent', f)).toEqual(['classic', 'create-agent', 'legacy-agents', 'prebuilt-react', 'system-prompt']);
    const prompt = fixture('langchain1-agent')['agent.py'].replace('system_prompt="You', 'prompt="You');
    expect(failing('langchain1-agent', variant('langchain1-agent', { 'agent.py': prompt }))).toEqual(['prompt-kwarg', 'system-prompt']);
  });
});

describe('docs benchmark, post-cutoff set: the pre-release way is caught', () => {
  it('msw3: graphql from msw and onUnhandledRequest', () => {
    const f = variant('msw3-node', {
      'src/mocks/handlers.ts': "import { graphql, http, HttpResponse } from 'msw';\nexport const handlers = [graphql.query('RepoStars', () => HttpResponse.json({}))];\n",
      'src/mocks/server.ts': "import { setupServer } from 'msw/node';\nexport const server = setupServer();\nexport const startMocks = () => server.listen({ onUnhandledRequest: 'error' });\n",
    });
    expect(failing('msw3-node', f)).toEqual(['graphql-bare-query', 'graphql-root', 'graphql-subpath', 'on-unhandled-frame', 'on-unhandled-request']);
  });

  it('hono: app.mount instead of the mount middleware', () => {
    const f = variant('hono-mount', { 'src/app.ts': "import { Hono } from 'hono';\nconst app = new Hono();\napp.mount('/legacy', legacyHandler);\nexport default app;\n" });
    expect(failing('hono-mount', f)).toEqual(['app-mount', 'mount-middleware']);
  });

  it('dotenv18: preload arguments, dotenv in the app, another loader', () => {
    const pkg = (start: string) => JSON.stringify({ scripts: { start }, dependencies: { dotenv: '18.0.9' } });
    expect(failing('dotenv18-run', variant('dotenv18-run', { 'package.json': pkg('node -r dotenv/config server.js dotenv_config_path=.env.local') }))).toEqual(['dotenv-run', 'preload-args']);
    expect(failing('dotenv18-run', variant('dotenv18-run', { 'package.json': pkg('node --env-file=.env.local server.js') }))).toEqual(['dotenv-run']);
    expect(failing('dotenv18-run', variant('dotenv18-run', { 'package.json': pkg('dotenv run --file=.env.local -- node server.js') }))).toEqual([]);
    const imported = "import 'dotenv/config';\n" + fixture('dotenv18-run')['server.js'];
    expect(failing('dotenv18-run', variant('dotenv18-run', { 'server.js': imported }))).toEqual(['no-import']);
  });

  it('zod: no compilation; named import of compile counts', () => {
    const src = fixture('zod-compile')['src/events.ts'];
    expect(failing('zod-compile', variant('zod-compile', { 'src/events.ts': src.replace('z.compile(EventSchema)', 'EventSchema').replace('z.uuid()', 'z.string().uuid()') }))).toEqual(['string-format', 'z-compile']);
    const named = "import { compile, z } from 'zod';\n" + src.replace("import * as z from 'zod';\n", '').replace('z.compile(', 'compile(');
    expect(failing('zod-compile', variant('zod-compile', { 'src/events.ts': named }))).toEqual([]);
  });

  it('polars2: cut/qcut, with_row_count, join_nulls, left-closed bins', () => {
    const f = variant('polars2-bins', {
      'report.py': 'import polars as pl\n\ndef age_report(people, cities):\n    return people.with_columns(pl.col("age").cut([12, 19], labels=["a", "b", "c"]), pl.col("income").qcut(4)).join(cities, on="city_id", join_nulls=True).with_row_count("row", offset=1)\n',
    });
    expect(failing('polars2-bins', f)).toEqual(['bin-intervals', 'bin-quantiles', 'cut-qcut', 'join-nulls', 'with-row-count']);
    const left = fixture('polars2-bins')['report.py'].replace(', right_closed=True', '');
    expect(failing('polars2-bins', variant('polars2-bins', { 'report.py': left }))).toEqual(['bin-intervals']);
  });

  it('fastapi: the instrumentation package instead of telemetry=', () => {
    const f = variant('fastapi-telemetry', {
      'main.py': 'from fastapi import FastAPI\nfrom opentelemetry.instrumentation.fastapi import FastAPIInstrumentor\napp = FastAPI(title="x", response_model_exclude_none=True)\nFastAPIInstrumentor.instrument_app(app, excluded_urls="health")\n',
    });
    expect(failing('fastapi-telemetry', f)).toEqual(['instrumentor', 'telemetry-exclude', 'telemetry-metrics-off', 'telemetry-param']);
  });

  it('pandas31: boolean indexing, assign and inplace', () => {
    const f = variant('pandas31-select', {
      'clean.py': 'import pandas as pd\n\ndef adults(df):\n    out = df[df["age"] >= 18].copy()\n    out.sort_values("age", inplace=True)\n    return out.assign(age_months=out["age"] * 12)[["name", "age_months"]]\n',
    });
    expect(failing('pandas31-select', f)).toEqual(['df-select', 'filter-cond', 'inplace']);
    const lambdaForm = fixture('pandas31-select')['clean.py'].replace('df.filter(cond=pd.col("age") >= 18)', 'df.filter(lambda d: d["age"] >= 18)');
    expect(failing('pandas31-select', variant('pandas31-select', { 'clean.py': lambdaForm }))).toEqual([]);
  });

  it('langchain14: the separate adapters package and a str target', () => {
    const f = variant('langchain14-mcp', {
      'agent.py': 'from langchain.agents import create_agent\nfrom langchain_mcp_adapters.client import MultiServerMCPClient\n\nasync def ask(q):\n    client = MultiServerMCPClient({"weather": {"command": "python", "args": ["weather_server.py"], "transport": "stdio"}})\n',
    });
    expect(failing('langchain14-mcp', f)).toEqual(['adapters-package', 'langchain-mcp']);
    const str = fixture('langchain14-mcp')['agent.py'].replace('MCPAdapter(SERVER)', 'MCPAdapter("weather_server.py")');
    expect(failing('langchain14-mcp', variant('langchain14-mcp', { 'agent.py': str }))).toEqual(['str-target']);
    const url = fixture('langchain14-mcp')['agent.py'].replace('MCPAdapter(SERVER)', 'MCPAdapter("https://example.com/mcp")');
    expect(failing('langchain14-mcp', variant('langchain14-mcp', { 'agent.py': url }))).toEqual([]);
  });
});

describe('docs benchmark: tailwind CSS smoke', () => {
  it('accepts class-based dark mode, flattened or nested, and rejects the media-query default', () => {
    const base = '.bg-brand{background-color:var(--color-brand)}.font-display{font-family:var(--font-display)}.content-auto{content-visibility:auto}.bg-black\\/50{background-color:#00000080}';
    const pass = (css: string) => tailwindCssTests(css).filter((t) => !t.pass).map((t) => t.name);
    expect(pass(`${base}.dark\\:bg-gray-900:where(.dark,.dark *){background-color:#111}`)).toEqual([]);
    expect(pass(`${base}.dark\\:bg-gray-900 {\n  &:where(.dark, .dark *) {\n    background-color: #111;\n  }\n}`)).toEqual([]);
    expect(pass(`${base}@media (prefers-color-scheme:dark){.dark\\:bg-gray-900{background-color:#111}}`)).toEqual(['dark-class']);
    expect(pass('.bg-brand{color:red}')).toEqual(['bg-brand', 'font-display', 'content-auto', 'dark-class', 'bg-black-50']);
  });
});
