/**
 * Checks the scorer itself on hand-written projects: each fixture in
 * fixtures/<task>/ is a reference solution and must score works + current;
 * each "old" variant (the same project written with the previous major's API)
 * must lose exactly what it should. Slow: installs and builds every project.
 *
 *   npx tsx bench/docs/selftest.ts [--only t1,t2]
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scoreRun } from './score.js';
import { TASKS } from './tasks.js';

const HERE = resolve(import.meta.dirname);
function readFixture(task: string, file: string): string {
  return readFileSync(join(HERE, 'fixtures', task, file), 'utf8');
}

interface Variant {
  name: string;
  /** file -> [search, replace] pairs; a file mapped to null is deleted, a string replaces its content. */
  edit: Record<string, [string | RegExp, string][] | string | null>;
  expect: { works: boolean; current: boolean };
}

const VARIANTS: Record<string, Variant[]> = {
  'next16-proxy': [
    {
      // Deprecated in 16 but still runs: works, not current.
      name: 'middleware.ts',
      edit: {
        'proxy.ts': null,
        'middleware.ts': readFixture('next16-proxy', 'proxy.ts').replace('function proxy', 'function middleware'),
      },
      expect: { works: true, current: false },
    },
    {
      name: 'revalidateTag(tag) and sync params',
      edit: {
        'app/dashboard/[team]/actions.ts': [[", 'max')", ')']],
        'app/dashboard/[team]/page.tsx': [
          ['{ params }: { params: Promise<{ team: string }> }', '{ params }: { params: { team: string } }'],
          ['const { team } = await params;', 'const { team } = params;'],
        ],
      },
      expect: { works: false, current: false },
    },
  ],
  'tailwind4-vite': [{
    name: 'v3 directives and tailwind.config.js',
    edit: {
      'src/index.css': '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n@layer utilities {\n  .content-auto { content-visibility: auto; }\n}\n',
      'tailwind.config.js': "export default { content: ['./index.html', './src/**/*.tsx'], darkMode: 'class', theme: { extend: { colors: { brand: '#4f46e5' }, fontFamily: { display: ['Inter', 'sans-serif'] } } } };\n",
    },
    expect: { works: false, current: false },
  }],
  'zod4-schema': [{
    name: 'v3 idioms on zod 4',
    edit: {
      'src/signup.ts': [
        ['z.strictObject({', 'z.object({'],
        ['z.email()', 'z.string().email()'],
        ["{ error: 'Password", "{ message: 'Password"],
        ['z.enum(Role)', 'z.nativeEnum(Role)'],
        ['tags: z.record(z.string(), z.string()),\n});', 'tags: z.record(z.string(), z.string()),\n}).strict();'],
      ],
    },
    expect: { works: true, current: false },
  }],
  'ai-sdk7-chat': [{
    name: 'AI SDK 5/6 idioms on 7',
    edit: {
      'app/api/chat/route.ts': [
        ['createUIMessageStreamResponse, isStepCount', 'stepCountIs'],
        [', toUIMessageStream,', ','],
        ["instructions: 'You", "system: 'You"],
        ['isStepCount(5)', 'stepCountIs(5)'],
        ['return createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) });', 'return result.toUIMessageStreamResponse();'],
      ],
    },
    expect: { works: true, current: false },
  }],
  'express5-api': [{
    name: 'Express 4 route syntax',
    edit: {
      'app.js': [
        ["'/files/*splat'", "'/files/*'"],
        ["req.params.splat.join('/')", 'req.params[0]'],
        ["'/docs/:name{.:ext}'", "'/docs/:name.:ext?'"],
      ],
    },
    expect: { works: false, current: false },
  }],
  'eslint10-flat': [{
    name: '.eslintrc + --ext',
    edit: {
      'eslint.config.js': null,
      '.eslintrc.json': JSON.stringify({ root: true, parser: '@typescript-eslint/parser', plugins: ['@typescript-eslint'], extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'], rules: { 'no-console': 'warn' }, ignorePatterns: ['dist/'] }),
      'package.json': [['"eslint ."', '"eslint --ext .ts ."']],
    },
    expect: { works: false, current: false },
  }],
  'pydantic2-models': [{
    name: 'v1 API on pydantic 2',
    edit: {
      'models.py': [
        ['Field(pattern=', 'Field(regex='],
        ['model_config = ConfigDict(extra="forbid", frozen=True, from_attributes=True)', 'class Config:\n        extra = "forbid"\n        frozen = True\n        orm_mode = True'],
      ],
    },
    expect: { works: false, current: false },
  }],
  'langchain1-agent': [{
    name: 'langchain 0.x agent API',
    edit: {
      'agent.py': [
        ['from langchain.agents import create_agent', 'from langchain.agents import AgentType, initialize_agent'],
        ['    return create_agent(\n        model=ChatOpenAI(model="gpt-4o-mini"),\n        tools=[get_weather, add],\n        system_prompt="You are a helpful assistant.",\n    )', '    return initialize_agent([get_weather, add], ChatOpenAI(model="gpt-4o-mini"), agent=AgentType.OPENAI_FUNCTIONS)'],
      ],
    },
    expect: { works: false, current: false },
  }],
};

const args = process.argv.slice(2);
const only = args.includes('--only') ? (args[args.indexOf('--only') + 1] ?? '').split(',') : [];
let bad = 0;
for (const task of TASKS.filter((t) => !only.length || only.includes(t.id))) {
  const cases: (Variant | undefined)[] = [undefined, ...(VARIANTS[task.id] ?? [])];
  for (const v of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'sctx-selftest-'));
    try {
      cpSync(join(HERE, 'fixtures', task.id), dir, { recursive: true });
      for (const [file, e] of Object.entries(v?.edit ?? {})) {
        const p = join(dir, file);
        if (e === null) rmSync(p);
        else if (typeof e === 'string') writeFileSync(p, e);
        else {
          let s = readFileSync(p, 'utf8');
          for (const [a, b] of e) {
            if (!(typeof a === 'string' ? s.includes(a) : a.test(s))) throw new Error(`${task.id}/${v?.name}: "${a}" not found in ${file}`);
            s = s.replace(a, b);
          }
          writeFileSync(p, s);
        }
      }
      const s = await scoreRun(task, dir);
      const want = v?.expect ?? { works: true, current: true };
      const ok = s.works === want.works && s.current === want.current;
      if (!ok) bad++;
      const failed = s.checks.filter((c) => !c.pass).map((c) => `${c.kind}:${c.id}`);
      const smoke = s.smoke ? (s.smoke.pass ? 'ok' : `FAIL ${s.smoke.error ?? ''} ${s.smoke.tests.filter((x) => !x.pass).map((x) => `${x.name}=${x.got ?? x.error ?? ''}`).join('; ')}`) : '-';
      console.log(`${ok ? 'OK  ' : 'BAD '} ${task.id} [${v?.name ?? 'reference'}] works=${s.works} current=${s.current} version=${s.versionOk} build=${s.build?.built ?? s.build?.error} smoke=${smoke.slice(0, 300)} failed=${failed.join(',') || '-'}`);
      if (!s.build?.built && s.build?.error) console.log(`     build: ${s.build.step}: ${s.build.error}`);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}
console.log(bad ? `${bad} unexpected` : 'all as expected');
process.exitCode = bad ? 1 : 0;
