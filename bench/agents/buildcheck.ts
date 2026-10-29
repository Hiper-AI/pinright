/* eslint-disable @typescript-eslint/no-explicit-any -- package.json of agent output is untyped */
/**
 * Does the project an agent wrote actually install and build against the
 * versions it pinned? This is the guard against "secure but broken": a
 * recommendation that jumps a major can leave code written for the old API.
 *
 *   npm : real `npm install --ignore-scripts`, then `npm run build` when there is a
 *         build script, `tsc --noEmit` for TypeScript, or an import check for JS
 *         (every named import from a package must exist).
 *   pypi: `uv venv` + `uv pip install -r`, byte-compile, then run every top-level
 *         import statement of the project's files (local modules skipped).
 * Install scripts never run: these are packages chosen by an agent.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';

export interface BuildScore {
  installed: boolean;
  /** undefined when there was nothing to build (no source files). */
  built?: boolean;
  /** The build failed for a reason unrelated to the pinned versions (native binary that needs an install script). */
  inconclusive?: boolean;
  step: string;
  error?: string;
}

export function run(cmd: string, cwd: string, timeoutMs = 600_000, env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, env: { ...process.env, ...env }, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

function sourceFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === '.venv' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.includes(extname(e))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const NATIVE = /Could not load the "?sharp|native module|\.node['"]? was compiled|prebuild|node-gyp|bindings file|Cannot find module '@img\//i;

function firstError(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /error|cannot|not found|failed|missing|is not exported|has no exported member|does not provide an export/i.test(l)) ?? lines[0] ?? '';
  return hit.slice(0, 240);
}

/** ESM named imports and CJS destructured requires of bare package specifiers. */
export function importChecks(source: string): { esm: string[]; cjs: string[] } {
  const esm: string[] = [];
  const cjs: string[] = [];
  const bare = (s: string) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:') && !s.startsWith('@/') && !s.startsWith('~');
  for (const m of source.matchAll(/^\s*import\s+(?!type\b)([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    if (bare(m[2])) esm.push(`import ${m[1].replace(/\s+/g, ' ')} from '${m[2]}';`);
  }
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) if (bare(m[1])) esm.push(`import '${m[1]}';`);
  for (const m of source.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!bare(m[2])) continue;
    if (m[1].startsWith('{')) {
      const names = m[1].slice(1, -1).split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean);
      cjs.push(`{ const m = require('${m[2]}'); for (const n of ${JSON.stringify(names)}) if (m[n] === undefined) throw new Error("'" + n + "' is not exported by ${m[2]}"); }`);
    } else cjs.push(`require('${m[2]}');`);
  }
  return { esm: [...new Set(esm)], cjs: [...new Set(cjs)] };
}

export async function npmBuild(work: string): Promise<BuildScore> {
  const tmp = mkdtempSync(join(tmpdir(), 'sctx-build-'));
  try {
    cpSync(work, tmp, { recursive: true, filter: (s) => !/[\\/]node_modules([\\/]|$)/.test(s) });
    let r = await run('npm install --ignore-scripts --no-audit --no-fund', tmp);
    if (r.code !== 0) r = await run('npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps', tmp);
    if (r.code !== 0) return { installed: false, step: 'npm install', error: firstError(r.err) };

    const pkg = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8')) as any;
    const env = { NEXT_TELEMETRY_DISABLED: '1', NUXT_TELEMETRY_DISABLED: '1', CI: '1', AUTH_SECRET: 'bench-secret-not-real', NEXTAUTH_SECRET: 'bench-secret-not-real' };
    const ts = sourceFiles(tmp, ['.ts', '.tsx', '.mts', '.cts']).filter((f) => !f.endsWith('.d.ts'));
    const js = sourceFiles(tmp, ['.js', '.mjs', '.cjs', '.jsx']);
    if (!ts.length && !js.length) return { installed: true, step: 'none' };

    let step: string;
    if (pkg.scripts?.build) {
      step = 'npm run build';
      r = await run(step, tmp, 900_000, env);
    } else if (ts.length) {
      const hasTs = existsSync(join(tmp, 'node_modules', 'typescript'));
      const tsc = hasTs ? 'npx tsc' : 'npx -y -p typescript tsc';
      step = existsSync(join(tmp, 'tsconfig.json'))
        ? `${tsc} --noEmit -p .`
        : `${tsc} --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --esModuleInterop ${ts.map((f) => `"${relative(tmp, f)}"`).join(' ')}`;
      r = await run(step, tmp, 600_000);
    } else {
      step = 'import check';
      const checks = js.map((f) => importChecks(readFileSync(f, 'utf8')));
      const esm = [...new Set(checks.flatMap((c) => c.esm))];
      const cjs = [...new Set(checks.flatMap((c) => c.cjs))];
      for (const f of js) {
        const c = await run(`node --check "${f}"`, tmp, 60_000);
        if (c.code !== 0) return { installed: true, built: false, step: 'node --check', error: firstError(c.err) };
      }
      writeFileSync(join(tmp, '__check.mjs'), esm.join('\n') + '\n');
      writeFileSync(join(tmp, '__check.cjs'), cjs.join('\n') + '\n');
      r = await run('node __check.mjs && node __check.cjs', tmp, 120_000);
    }
    if (r.code === 0) return { installed: true, built: true, step };
    const error = firstError(`${r.err}\n${r.out}`);
    return { installed: true, built: false, step, error, inconclusive: NATIVE.test(`${r.err}\n${r.out}`) || undefined };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Top-level import statements, multi-line parentheses joined. */
export function pythonImports(source: string): string[] {
  const out: string[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/^(import|from)\s+\S/.test(l)) continue;
    let stmt = l;
    while (stmt.includes('(') && !stmt.includes(')') && i + 1 < lines.length) stmt += ' ' + lines[++i].trim();
    while (stmt.trimEnd().endsWith('\\') && i + 1 < lines.length) stmt = stmt.trimEnd().slice(0, -1) + ' ' + lines[++i].trim();
    out.push(stmt.replace(/#.*$/, '').trim());
  }
  return out;
}

export async function pypiBuild(work: string): Promise<BuildScore> {
  const tmp = mkdtempSync(join(tmpdir(), 'sctx-pybuild-'));
  try {
    cpSync(work, tmp, { recursive: true });
    const py = process.platform === 'win32' ? join(tmp, '.venv', 'Scripts', 'python.exe') : join(tmp, '.venv', 'bin', 'python');
    let r = await run('uv venv .venv --python 3.12 --quiet', tmp);
    if (r.code !== 0) return { installed: false, step: 'uv venv', error: firstError(r.err) };
    r = await run(`uv pip install -r requirements.txt --python "${py}" --quiet`, tmp, 900_000);
    if (r.code !== 0) return { installed: false, step: 'uv pip install', error: firstError(r.err) };

    const files = sourceFiles(tmp, ['.py']);
    if (!files.length) return { installed: true, step: 'none' };
    const local = new Set(readdirSync(tmp).map((e) => e.replace(/\.py$/, '')));
    const stmts = [...new Set(files.flatMap((f) => pythonImports(readFileSync(f, 'utf8'))))].filter((s) => {
      const mod = s.match(/^(?:from|import)\s+([A-Za-z_][\w]*)/)?.[1];
      return mod && !local.has(mod) && mod !== '__future__';
    });
    const script = [
      'import sys, traceback',
      'bad = []',
      ...stmts.map((s) => `try:\n    ${s}\nexcept Exception as e:\n    bad.append(${JSON.stringify(s)} + " -> " + type(e).__name__ + ": " + str(e)[:200])`),
      'print("\\n".join(bad))',
      'sys.exit(1 if bad else 0)',
    ].join('\n');
    writeFileSync(join(tmp, '__check.py'), script);
    // Only the project's own files: compileall over "." would also walk .venv.
    r = await run(`"${py}" -m py_compile ${files.map((f) => `"${f}"`).join(' ')}`, tmp, 120_000);
    if (r.code !== 0) return { installed: true, built: false, step: 'py_compile', error: firstError(`${r.out}\n${r.err}`) };
    r = await run(`"${py}" __check.py`, tmp, 300_000);
    if (r.code === 0) return { installed: true, built: true, step: 'import check' };
    return { installed: true, built: false, step: 'import check', error: (r.out.split(/\r?\n/).find(Boolean) ?? firstError(r.err)).slice(0, 240) };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}
