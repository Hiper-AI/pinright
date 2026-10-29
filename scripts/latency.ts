/**
 * Hook and CLI latency against the real upstreams. Run after `npm run build`:
 *   npx tsx scripts/latency.ts [--runs=N] [--only=<case,...>] [--token] [--json] [--cli=<other dist/cli.js>]
 * Each case spawns `node dist/cli.js hook claude` with a Claude Code PreToolUse
 * payload, the way the agent does. "cold" gets an empty cache dir per run,
 * "warm" shares one primed by a first run. GITHUB_TOKEN is dropped from the env
 * unless --token is given. Not part of `npm test` (it needs the network).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
// --cli=<path to another build's cli.js> to compare against it under the same conditions.
const cli = flag('cli') ?? path.join(root, 'dist', 'cli.js');
const RUNS = Number(flag('runs') ?? 5);
const only = flag('only')?.split(',');
const withToken = args.includes('--token');

const REQUIREMENTS = [
  'requests==2.32.3', 'flask==3.0.3', 'django==5.1.4', 'numpy==2.1.3', 'pandas==2.2.3', 'sqlalchemy==2.0.36',
  'pydantic==2.10.3', 'fastapi==0.115.6', 'uvicorn==0.32.1', 'celery==5.4.0', 'redis==5.2.1', 'boto3==1.35.80',
  'pytest==8.3.4', 'httpx==0.28.1', 'jinja2==3.1.4',
].join('\n');

const NPM_DEPS: Record<string, string> = {
  express: '^4.21.2', react: '^18.3.1', 'react-dom': '^18.3.1', lodash: '^4.17.21', axios: '^1.7.9', zod: '^3.24.1',
  next: '^14.2.20', typescript: '^5.7.2', vite: '^5.4.11', vitest: '^2.1.8', eslint: '^9.17.0', prettier: '^3.4.2',
  dayjs: '^1.11.13', uuid: '^11.0.3', dotenv: '^16.4.7', cors: '^2.8.5', 'body-parser': '^1.20.3', jsonwebtoken: '^9.0.2',
  bcrypt: '^5.1.1', mongoose: '^8.9.0', pg: '^8.13.1', redis: '^4.7.0', winston: '^3.17.0', commander: '^12.1.0',
  chalk: '^5.3.0', semver: '^7.6.3', yaml: '^2.6.1', ws: '^8.18.0', 'node-fetch': '^3.3.2', rxjs: '^7.8.1',
};

const WORKFLOW = `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - uses: actions/cache@v4
      - run: npm ci && npm test
`;

interface Case {
  name: string;
  input: (dir: string) => Record<string, unknown>;
}

const write = (file: string, content: string) => (dir: string) => ({
  tool_name: 'Write',
  cwd: dir,
  tool_input: { file_path: path.join(dir, file), content },
});
const bash = (command: string) => (dir: string) => ({ tool_name: 'Bash', cwd: dir, tool_input: { command } });

const CASES: Case[] = [
  { name: 'npm test (non-install)', input: bash('npm test') },
  { name: 'npm i express', input: bash('npm i express') },
  { name: 'requirements.txt, 15 pins', input: write('requirements.txt', `${REQUIREMENTS}\n`) },
  { name: 'package.json, 30 deps', input: write('package.json', `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: NPM_DEPS }, null, 2)}\n`) },
  { name: 'workflow, 3 actions', input: write('.github/workflows/ci.yml', WORKFLOW) },
];

function env(cacheDir: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, SAFECTX_CACHE_DIR: cacheDir };
  if (!withToken) {
    delete e.GITHUB_TOKEN;
    delete e.GH_TOKEN;
    delete e.SAFECTX_GH_CLI;
  }
  return e;
}

function runOnce(argv: string[], stdin: string | undefined, cacheDir: string, cwd: string): Promise<{ ms: number; out: string }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env: env(cacheDir), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', () => resolve({ ms: performance.now() - t0, out }));
    child.stdin.end(stdin ?? '');
  });
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/** A fresh repo-like project: the .git keeps the import check from reading the (often huge) temp dir above it. */
function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safectx-lat-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
  return dir;
}

const rows: { case: string; mode: string; p50: number; p95: number; action: string }[] = [];

async function measure(label: string, argv: string[], input: ((dir: string) => Record<string, unknown>) | undefined) {
  for (const mode of ['cold', 'warm'] as const) {
    const times: number[] = [];
    const warmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'safectx-cache-'));
    let last = '';
    if (mode === 'warm') {
      const dir = project();
      await runOnce(argv, input ? JSON.stringify(input(dir)) : undefined, warmCache, dir);
    }
    for (let i = 0; i < RUNS; i++) {
      const dir = project();
      const cache = mode === 'cold' ? fs.mkdtempSync(path.join(os.tmpdir(), 'safectx-cache-')) : warmCache;
      const r = await runOnce(argv, input ? JSON.stringify(input(dir)) : undefined, cache, dir);
      times.push(r.ms);
      last = r.out;
    }
    let action = '-';
    try {
      const o = JSON.parse(last);
      action = o.hookSpecificOutput?.permissionDecision ?? (o.hookSpecificOutput?.additionalContext ? 'allow+notes' : 'allow');
    } catch {
      action = last ? 'text' : 'allow (silent)';
    }
    rows.push({ case: label, mode, p50: Math.round(pct(times, 50)), p95: Math.round(pct(times, 95)), action });
    console.error(`${label} [${mode}] p50 ${Math.round(pct(times, 50))} ms, p95 ${Math.round(pct(times, 95))} ms (${action})`);
  }
}

if (!only || only.includes('startup')) await measure('--version (startup)', ['--version'], undefined);
for (const c of CASES) {
  if (only && !only.some((o) => c.name.startsWith(o))) continue;
  await measure(c.name, ['hook', 'claude'], c.input);
}

if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else {
  console.log(`\n| case | mode | p50 ms | p95 ms | decision |\n|---|---|---|---|---|`);
  for (const r of rows) console.log(`| ${r.case} | ${r.mode} | ${r.p50} | ${r.p95} | ${r.action} |`);
  console.log(`\n${RUNS} runs per cell, GITHUB_TOKEN ${withToken ? 'set' : 'unset'}, node ${process.version}, ${os.platform()}`);
}
