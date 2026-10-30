/**
 * Retrieval probe, no agent in the loop: asks pinright's get-docs pipeline
 * (src/docs getDocs) the questions an agent asks for each task, including the
 * ones phrased with the old API's words, and checks whether the answer shows
 * the current API. The agent runs mix docs quality with what the model already
 * knows; this isolates the docs.
 *
 *   GITHUB_TOKEN=... npx tsx bench/docs/retrieval.ts [--only task1,task2] [--show]
 */
import { getDocs } from '../../src/docs/index.js';
import { type Ecosystem } from '../../src/ecosystems.js';

/** Strings that only the current major's docs contain, per task. */
export const MARKERS: Record<string, RegExp[]> = {
  'next16-proxy': [/proxy\.(ts|js)/, /export (default )?(async )?function proxy/, /await cookies\(\)/, /revalidateTag\([^)]*,/],
  'tailwind4-vite': [/@import ["']tailwindcss["']/, /@theme/, /@utility/, /@custom-variant/, /@tailwindcss\/vite/],
  'zod4-schema': [/z\.email\(\)/, /strictObject/, /prettifyError|treeifyError/, /z\.record\(z\.string\(\),/, /\berror:/],
  'ai-sdk7-chat': [/isStepCount/, /createUIMessageStreamResponse/, /toUIMessageStream\(/, /instructions:/, /inputSchema/, /sendMessage/],
  'express5-api': [/\*splat|\{\*\w+\}/, /\{\.:\w+\}|\{\/:\w+\}/],
  'eslint10-flat': [/eslint\.config\.(js|mjs|ts)/, /defineConfig/, /globalIgnores|ignores:/],
  'pydantic2-models': [/field_validator/, /model_validator/, /ConfigDict/, /from_attributes/, /pattern=/, /model_dump/],
  'langchain1-agent': [/create_agent/, /system_prompt/],
};

export interface Probe {
  task: string;
  ecosystem: Ecosystem;
  name: string;
  version: string;
  query: string;
  /** Every pattern must appear in the returned docs. */
  expect: RegExp[];
}

export const PROBES: Probe[] = [
  { task: 'next16-proxy', ecosystem: 'npm', name: 'next', version: '16.4.3', query: 'protect /dashboard routes with middleware, redirect to /login when the session cookie is missing', expect: [/proxy\.(ts|js)/, /export (default )?(async )?function proxy/] },
  { task: 'next16-proxy', ecosystem: 'npm', name: 'next', version: '16.4.3', query: 'read a cookie and the dynamic route params in a server component page', expect: [/await cookies\(\)/, /await params/] },
  { task: 'next16-proxy', ecosystem: 'npm', name: 'next', version: '16.4.3', query: 'revalidateTag with stale-while-revalidate in a server action', expect: [/revalidateTag\([^)]*,\s*['"]max['"]\)/] },
  { task: 'tailwind4-vite', ecosystem: 'npm', name: 'tailwindcss', version: '4.3.3', query: 'install Tailwind with Vite', expect: [/@tailwindcss\/vite/, /@import ["']tailwindcss["']/] },
  { task: 'tailwind4-vite', ecosystem: 'npm', name: 'tailwindcss', version: '4.3.3', query: 'add a custom brand color and font family to the theme config', expect: [/@theme/, /--color-/] },
  { task: 'tailwind4-vite', ecosystem: 'npm', name: 'tailwindcss', version: '4.3.3', query: 'add a custom utility class that works with variants', expect: [/@utility/] },
  { task: 'tailwind4-vite', ecosystem: 'npm', name: 'tailwindcss', version: '4.3.3', query: 'dark mode toggled manually with a dark class (darkMode class)', expect: [/@custom-variant dark/] },
  { task: 'zod4-schema', ecosystem: 'npm', name: 'zod', version: '4.6.7', query: 'validate an email string', expect: [/z\.email\(\)/] },
  { task: 'zod4-schema', ecosystem: 'npm', name: 'zod', version: '4.6.7', query: 'custom error message for min length', expect: [/\berror:\s*["'`]|\.min\(\s*\d+\s*,\s*["']/] },
  { task: 'zod4-schema', ecosystem: 'npm', name: 'zod', version: '4.6.7', query: 'format validation errors into a readable string with paths', expect: [/prettifyError/] },
  { task: 'zod4-schema', ecosystem: 'npm', name: 'zod', version: '4.6.7', query: 'reject unknown keys in an object; enum from a TypeScript enum; record of strings', expect: [/strictObject/, /z\.enum\(/, /z\.record\(z\.string\(\),/] },
  { task: 'ai-sdk7-chat', ecosystem: 'npm', name: 'ai', version: '7.0.157', query: 'Next.js route handler: streamText with tools, multi-step stopWhen, system prompt, stream the response to useChat', expect: [/isStepCount/, /createUIMessageStreamResponse|toUIMessageStream\(/, /instructions:/] },
  { task: 'ai-sdk7-chat', ecosystem: 'npm', name: 'ai', version: '7.0.157', query: 'define a tool with a zod input schema and execute', expect: [/inputSchema/] },
  { task: 'ai-sdk7-chat', ecosystem: 'npm', name: '@ai-sdk/react', version: '4.0.161', query: 'useChat send a message from a form and render message parts', expect: [/sendMessage/, /parts/] },
  { task: 'express5-api', ecosystem: 'npm', name: 'express', version: '5.3.0', query: 'wildcard catch-all route path', expect: [/\*splat|\{\*\w+\}/] },
  { task: 'express5-api', ecosystem: 'npm', name: 'express', version: '5.3.0', query: 'optional route parameter (file extension)', expect: [/\{\.:\w+\}|\{\/?:\w+\}/] },
  { task: 'express5-api', ecosystem: 'npm', name: 'express', version: '5.3.0', query: 'errors thrown in async route handlers and error handling middleware', expect: [/reject|promise/i, /next\(err/] },
  { task: 'eslint10-flat', ecosystem: 'npm', name: 'eslint', version: '10.13.0', query: 'configuration file: ignore a folder and set rules for specific files', expect: [/eslint\.config\.(js|mjs)/, /globalIgnores|ignores:/, /files:/] },
  { task: 'eslint10-flat', ecosystem: 'npm', name: 'typescript-eslint', version: '8.72.1', query: 'set up typescript-eslint recommended config', expect: [/defineConfig|tseslint\.config/, /configs\.recommended/] },
  { task: 'pydantic2-models', ecosystem: 'pypi', name: 'pydantic', version: '2.14.2', query: 'validator on a single field to normalize a value', expect: [/@field_validator/] },
  { task: 'pydantic2-models', ecosystem: 'pypi', name: 'pydantic', version: '2.14.2', query: 'model config: forbid extra fields, immutable model, build from ORM objects', expect: [/ConfigDict/, /from_attributes/, /frozen/] },
  { task: 'pydantic2-models', ecosystem: 'pypi', name: 'pydantic', version: '2.14.2', query: 'regex constraint on a string field', expect: [/pattern\s*=/] },
  { task: 'pydantic2-models', ecosystem: 'pypi', name: 'pydantic', version: '2.14.2', query: 'validator on the whole model comparing two fields', expect: [/@model_validator/] },
  { task: 'langchain1-agent', ecosystem: 'pypi', name: 'langchain', version: '1.4.7', query: 'create a tool-calling agent with tools and a system prompt', expect: [/create_agent/, /system_prompt/] },
  { task: 'langchain1-agent', ecosystem: 'pypi', name: 'langchain', version: '1.4.7', query: 'define a tool with the @tool decorator', expect: [/@tool/, /from langchain\.tools import tool|from langchain_core\.tools import tool/] },
];

export interface ProbeResult { probe: Probe; pass: boolean; missing: string[]; chars: number; via: string; sources: string[]; text: string }

export async function runProbe(probe: Probe): Promise<ProbeResult> {
  const d = await getDocs({ ecosystem: probe.ecosystem, name: probe.name, version: probe.version, query: probe.query });
  const missing = probe.expect.filter((re) => !re.test(d.text)).map(String);
  const sources = [...d.text.matchAll(/^### .*\[([^\]]+)\]$/gm)].map((m) => m[1]);
  return { probe, pass: !missing.length, missing, chars: d.text.length, via: d.via, sources, text: d.text };
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bench/docs/retrieval.ts');
if (isMain) {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? (args[args.indexOf('--only') + 1] ?? '').split(',') : [];
  const results: ProbeResult[] = [];
  for (const p of PROBES.filter((x) => !only.length || only.includes(x.task))) {
    const r = await runProbe(p);
    results.push(r);
    console.log(`${r.pass ? 'OK  ' : 'MISS'} ${p.task} ${p.name}@${p.version} "${p.query}" ${r.chars} chars${r.missing.length ? ` missing ${r.missing.join(' ')}` : ''}`);
    console.log(`     sections: ${[...new Set(r.sources)].join(' | ').slice(0, 400)}`);
    if (args.includes('--show') && !r.pass) console.log(r.text.slice(0, 3000));
  }
  console.log(`${results.filter((r) => r.pass).length} / ${results.length} probes answered with the current API`);
}
