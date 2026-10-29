/* eslint-disable @typescript-eslint/no-explicit-any -- JSON printed by the smoke scripts */
/**
 * Runtime smoke tests: does the project behave as asked, not only build?
 * Each one runs in the build directory (dependencies installed, build done)
 * and reports a list of named tests. Scripts in smoke/ run inside the agent's
 * project with its own dependency versions.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { type BuildScore, run, venvPython } from '../agents/buildcheck.js';

export interface SmokeTest { name: string; pass: boolean; got?: string; error?: string }
export interface SmokeResult {
  ran: boolean;
  pass: boolean;
  tests: SmokeTest[];
  /** Deprecation warnings emitted at runtime (Pydantic, LangChain). */
  deprecations?: string[];
  error?: string;
}

const HERE = resolve(import.meta.dirname);
const ROOT = resolve(HERE, '..', '..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function result(tests: SmokeTest[], deprecations?: string[]): SmokeResult {
  return { ran: true, pass: tests.length > 0 && tests.every((t) => t.pass), tests, deprecations };
}

/** Runs a script that prints one JSON line {tests, deprecations?} as its last line. */
async function jsonScript(cmd: string, dir: string, env: Record<string, string> = {}): Promise<SmokeResult> {
  const r = await run(cmd, dir, 180_000, env);
  const line = r.out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
  if (!line) return { ran: true, pass: false, tests: [], error: (r.err || r.out).trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300) };
  const j = JSON.parse(line);
  return result(j.tests ?? [], j.deprecations);
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

/** Kills a server and its children, and waits until they are gone (Windows keeps the directory locked until then). */
async function killTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  const closed = new Promise((r) => child.once('close', r));
  if (process.platform === 'win32') {
    await new Promise((r) => spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).once('close', r));
  } else process.kill(-child.pid, 'SIGKILL');
  await Promise.race([closed, new Promise((r) => setTimeout(r, 10_000))]);
  await new Promise((r) => setTimeout(r, 1000));
}

async function nextProxy(dir: string): Promise<SmokeResult> {
  const port = await freePort();
  const next = join(dir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(process.execPath, [next, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: dir, windowsHide: true, detached: process.platform !== 'win32',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' },
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 60_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      up = await fetch(`${base}/login`, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!up) return { ran: true, pass: false, tests: [], error: `next start did not come up: ${log.slice(-300)}` };
    const tests: SmokeTest[] = [];
    let r = await fetch(`${base}/dashboard/acme`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const loc = r.headers.get('location') ?? '';
    tests.push({ name: 'redirect-without-session', pass: [302, 303, 307, 308].includes(r.status) && Boolean(loc) && new URL(loc, base).pathname === '/login', got: `${r.status} ${loc}` });
    r = await fetch(`${base}/dashboard/acme`, { redirect: 'manual', headers: { cookie: 'session=abc; theme=dark' }, signal: AbortSignal.timeout(15_000) });
    const body = await r.text();
    tests.push({ name: 'page-with-session', pass: r.status === 200 && body.includes('acme'), got: `${r.status} ${body.slice(0, 80)}` });
    r = await fetch(`${base}/login`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    tests.push({ name: 'login-not-intercepted', pass: r.status === 200, got: String(r.status) });
    return result(tests.map((t) => (t.pass ? { name: t.name, pass: true } : t)));
  } finally {
    await killTree(child);
  }
}

function filesUnder(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, ext));
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

/** The built CSS must carry the custom theme, the custom utility and class-based dark mode. */
export function tailwindCssTests(css: string): SmokeTest[] {
  return [
    { name: 'bg-brand', pass: /\.bg-brand\s*\{[^}]*(#4f46e5|var\(--color-brand\)|oklch|rgb)/i.test(css) },
    { name: 'font-display', pass: /\.font-display\s*\{[^}]*(Inter|var\(--font-display\))/.test(css) },
    { name: 'content-auto', pass: /\.content-auto\s*\{[^}]*content-visibility\s*:\s*auto/.test(css) },
    // Class-based: the selector itself carries .dark (flattened or nested); the default wraps it in a prefers-color-scheme query.
    { name: 'dark-class', pass: /\.dark\\:bg-gray-900(?:[^{]*\.dark\b|\s*\{\s*&\s*:\s*(?:where|is)\(\s*\.dark\b)/.test(css) },
    { name: 'bg-black-50', pass: /\.bg-black\\\/50\b/.test(css) },
  ];
}

async function tailwindCss(dir: string): Promise<SmokeResult> {
  const files = filesUnder(join(dir, 'dist'), '.css');
  if (!files.length) return { ran: true, pass: false, tests: [], error: 'no CSS in dist/' };
  return result(tailwindCssTests(files.map((f) => readFileSync(f, 'utf8')).join('\n')));
}

async function eslintConfig(dir: string): Promise<SmokeResult> {
  const eslint = join(dir, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!existsSync(eslint)) return { ran: true, pass: false, tests: [], error: 'eslint not installed' };
  for (const d of ['src', 'scripts', 'dist']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'src', 'probe_bench.ts'), 'export function probe(): number {\n  console.log("probe");\n  return 1;\n}\n');
  writeFileSync(join(dir, 'scripts', 'probe_bench.ts'), 'console.log("probe");\nexport {};\n');
  writeFileSync(join(dir, 'dist', 'probe_bench.js'), 'var unused = 1;\nconsole.log(undefinedVariable);\n');
  const r = await run(`node "${eslint}" -f json src/probe_bench.ts scripts/probe_bench.ts dist/probe_bench.js`, dir, 180_000);
  const tests: SmokeTest[] = [{ name: 'config-loads', pass: r.code === 0 || r.code === 1, got: `exit ${r.code}: ${r.err.slice(0, 200)}` }];
  let results: any[] = [];
  try {
    results = JSON.parse(r.out);
  } catch {
    results = [];
  }
  const of = (f: string) => results.find((x) => String(x.filePath).replace(/\\/g, '/').endsWith(f));
  const src = of('src/probe_bench.ts');
  const scripts = of('scripts/probe_bench.ts');
  const dist = of('dist/probe_bench.js');
  const fatal = (x: any) => (x?.messages ?? []).some((m: any) => m.fatal);
  tests.push({ name: 'parses-ts', pass: Boolean(src) && !fatal(src) && !fatal(scripts), got: JSON.stringify([...(src?.messages ?? []), ...(scripts?.messages ?? [])].filter((m: any) => m.fatal)).slice(0, 200) });
  tests.push({ name: 'no-console-warns-in-src', pass: (src?.messages ?? []).some((m: any) => m.ruleId === 'no-console' && m.severity === 1), got: JSON.stringify(src?.messages ?? []).slice(0, 200) });
  tests.push({ name: 'no-console-off-in-scripts', pass: Boolean(scripts) && !(scripts.messages ?? []).some((m: any) => m.ruleId === 'no-console'), got: JSON.stringify(scripts?.messages ?? []).slice(0, 200) });
  tests.push({ name: 'dist-ignored', pass: !dist || (dist.messages ?? []).every((m: any) => m.ruleId == null && /ignore/i.test(m.message)), got: JSON.stringify(dist?.messages ?? []).slice(0, 200) });
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (pkg.scripts?.lint) {
    const l = await run('npm run lint', dir, 180_000);
    // 0: clean, 1: lint findings; 2 means ESLint itself failed (bad config or flag).
    tests.push({ name: 'lint-script-runs', pass: l.code === 0 || l.code === 1, got: `exit ${l.code}: ${(l.err || l.out).slice(-200)}` });
  } else tests.push({ name: 'lint-script-runs', pass: false, got: 'no lint script' });
  return result(tests.map((t) => (t.pass ? { name: t.name, pass: true } : t)));
}

function withScript(name: string, dir: string): string {
  copyFileSync(join(HERE, 'smoke', name), join(dir, `__smoke_${name}`));
  return `__smoke_${name}`;
}

const SMOKES: Record<string, (dir: string, b: BuildScore) => Promise<SmokeResult>> = {
  'next-proxy': (dir, b) => (b.built ? nextProxy(dir) : Promise.resolve({ ran: false, pass: false, tests: [], error: 'did not build' })),
  'tailwind-css': (dir, b) => (b.built ? tailwindCss(dir) : Promise.resolve({ ran: false, pass: false, tests: [], error: 'did not build' })),
  'eslint-config': (dir) => eslintConfig(dir),
  'zod-signup': (dir) => jsonScript(`node "${TSX}" ${withScript('zod.mts', dir)}`, dir),
  'express-api': (dir) => jsonScript(`node ${withScript('express.mjs', dir)}`, dir),
  'pydantic-models': (dir) => jsonScript(`"${venvPython(dir)}" -I ${withScript('pydantic.py', dir)}`, dir),
  'langchain-agent': (dir) => jsonScript(`"${venvPython(dir)}" -I ${withScript('langchain.py', dir)}`, dir),
};

export async function runSmoke(id: string, dir: string, build: BuildScore): Promise<SmokeResult> {
  const fn = SMOKES[id];
  if (!fn) throw new Error(`unknown smoke test ${id}`);
  return fn(dir, build).catch((e: Error): SmokeResult => ({ ran: false, pass: false, tests: [], error: `harness: ${e.message}` }));
}
