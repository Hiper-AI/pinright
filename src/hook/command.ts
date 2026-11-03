/**
 * Dependency intents in a command line. The shell reader (shell.ts) finds each
 * simple command; this file peels what wraps it (sudo, env, xargs, bash -c,
 * eval, cmd /c, powershell -Command, Start-Process...), follows what it runs by
 * name (npm run, make, just, sh script.sh, package.json lifecycle scripts) and
 * reads the install verbs of each package manager.
 *
 * What it cannot see through (a package name in a variable, arguments from
 * xargs, a manifest rewritten by sed) becomes an `unverifiable` intent, which
 * the policy asks about by default instead of letting it pass unseen.
 */
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { type Ecosystem } from '../ecosystems.js';
import { isPlatformPackage } from '../composer/manifest.js';
import { DYNAMIC, parseShell, type SimpleCommand } from './shell.js';
import { type DepIntent, isCustomRegistry, isDynamic, isLocalLinks, NPM_AUTH_KEY, npmSpecKind, pySpecKind, splitNpmSpec, type SpecKind, unverifiable } from './spec.js';
import { fromFileWrite, isGuardedFile } from './writes.js';

type ReadFile = (p: string) => string | undefined;

interface Ctx {
  cwd: string;
  readFile: ReadFile;
  /** Files written earlier in the same command line. */
  written: Map<string, string>;
  vars: Map<string, string>;
  aliases: Map<string, string[]>;
  out: DepIntent[];
  /** Simple commands read so far, across nesting: a bound on the work a hostile command can cause. */
  budget: { n: number; cut?: boolean };
  /** Files already followed (scripts, requirement files), against loops. */
  followed: Set<string>;
}

const MAX_DEPTH = 6;
const MAX_COMMANDS = 2000;

/**
 * Git Bash and Cygwin paths on Windows: "/c/Hiper AI/x" and "/cygdrive/c/x" are C:\..., which
 * path.resolve would read as C:\c\... Agents running Git Bash on Windows write them all the time.
 */
export function windowsPath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return p;
  const m = /^\/(?:cygdrive\/)?([a-zA-Z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${m[2] ?? '/'}` : p;
}

export function fromCommand(command: string, cwd: string, readFile: ReadFile): DepIntent[] {
  const written = new Map<string, string>();
  const read: ReadFile = (p) => written.get(p) ?? readFile(p);
  const ctx: Ctx = { cwd, readFile: read, written, vars: new Map(), aliases: new Map(), out: [], budget: { n: MAX_COMMANDS }, followed: new Set() };
  walk(command, ctx, 0);
  return ctx.out;
}

/** Package managers and the verbs that add something. Used to tell an opaque install from an opaque anything. */
const MANAGERS = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'pip', 'pip3', 'pipx', 'pipenv', 'uv', 'uvx', 'poetry', 'pdm', 'conda', 'mamba', 'micromamba',
  'cargo', 'go', 'gem', 'bundle', 'composer', 'dotnet', 'deno', 'nuget', 'python', 'python3', 'py', 'corepack',
]);
const INSTALL_VERBS = /^(i|in|ins|inst|insta|instal|install|isnt|isntall|add|a|update|up|upgrade|require|get|dlx|x|exec|create|init|run|tool|global|ci|sync|binstall|package)$/i;

function looksLikeInstall(words: string[]): boolean {
  const bin = binName(words[0] ?? '');
  return (MANAGERS.has(bin) || isDynamic(bin)) && words.slice(1, 4).some((w) => INSTALL_VERBS.test(w));
}

/** The string xargs replaces in its command (-I x, -Ix, -i, --replace), if any. */
function xargsPlaceholder(args: string[]): string | undefined {
  for (let k = 0; k < args.length && args[k].startsWith('-'); k++) {
    if (args[k] === '-I') return args[k + 1];
    if (/^-I./.test(args[k])) return args[k].slice(2);
    if (/^(-i|--replace)$/.test(args[k])) return '{}';
    if (/^--replace=/.test(args[k])) return args[k].slice(10);
  }
  return undefined;
}

/**
 * "xargs npx vitest run": npx already names the package it runs, so the words xargs appends are
 * arguments of vitest, not packages. Not when the package itself comes from xargs (no name yet, or
 * the -I placeholder in it) or when what npx runs installs something (xargs npx pnpm add).
 */
function runnerNamesItsCommand(words: string[], placeholder: string | undefined): boolean {
  if (!/^(npx|pnpx|bunx)$/.test(binName(words[0] ?? ''))) return false;
  const after = skipFlags(words.slice(1), ['-p', '--package', '-c', '--call', '--prefix', '--registry', '--cache', '--userconfig', '--loglevel', '-w', '--workspace']);
  // npx's own options and the package it runs: the placeholder there means xargs picks the package.
  const head = words.slice(1, words.length - after.length + 1);
  if (!after[0] || (placeholder && head.some((w) => w.includes(placeholder)))) return false;
  return !looksLikeInstall(after);
}

function binName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.(cmd|exe|ps1|bat|com)$/i, '').toLowerCase();
}

function walk(src: string, ctx: Ctx, depth: number): void {
  if (depth > MAX_DEPTH || ctx.budget.n <= 0) return cut(src, ctx);
  const parsed = parseShell(src);
  for (const s of parsed.substitutions) walk(s, ctx, depth + 1);
  let prev: SimpleCommand | undefined;
  for (const c of parsed.commands) {
    if (--ctx.budget.n < 0) return cut(src, ctx);
    // PowerShell's "foreach ($p in $list)" header (also "$lines = foreach (...)"): "$p in ..." names the loop variable, it runs nothing
    // (a statement that starts with a variable is an expression in PowerShell). The body is read as usual.
    const opener = prev?.words ?? [];
    const loop = opener.length > 0 && /^(foreach|for)$/i.test(opener[opener.length - 1]) && (opener.length === 1 || opener[opener.length - 2] === '=');
    const header = prev && !prev.pipeNext && loop && /^\$\w+$/.test(c.words[0] ?? '') && /^in$/i.test(c.words[1] ?? '');
    if (!header) simple(c, prev?.pipeNext ? prev : undefined, ctx, depth);
    prev = c;
  }
}

/**
 * Past the depth or command budget the rest is not read, so it cannot be called clean: padding a
 * line with 2,000 `true;` or seven `eval`s must not hide what follows. A text match on install verbs
 * missed `npx x`, `uvx x` and quoted names (`n''pm i x`), so any cut is unverifiable, once per line.
 */
function cut(src: string, ctx: Ctx): void {
  if (ctx.budget.cut) return;
  ctx.budget.cut = true;
  ctx.out.push(unverifiable('npm', 'command', 'the command nests too deep or runs too many commands for pinright to read all of it; run the install directly.', src.slice(0, 200)));
}

/** What a command writes on stdout when we can know it: echo, printf, cat of a heredoc or a file. */
function outputOf(c: SimpleCommand, ctx: Ctx): string | undefined {
  const [w0, ...rest] = c.words;
  const bin = binName(w0 ?? '');
  if (['echo', 'write-output', 'write-host', 'printf'].includes(bin)) {
    const args = rest.filter((a, k) => !(k === 0 && /^-[neE]+$/.test(a)));
    const text = args.join(' ').replace(/\\n/g, '\n');
    return text.endsWith('\n') || bin === 'printf' ? text : `${text}\n`;
  }
  if (bin === 'cat' || bin === 'type' || bin === 'get-content' || bin === 'gc') {
    const files = rest.filter((a) => !a.startsWith('-'));
    if (!files.length) return c.stdin;
    const parts = files.map((f) => ctx.readFile(path.resolve(ctx.cwd, f)));
    return parts.every((p) => p !== undefined) ? parts.join('') : undefined;
  }
  return undefined;
}

function expand(word: string, ctx: Ctx): string {
  return word.replace(/\$\{(\w+)\}|\$(\w+)|\$env:(\w+)/gi, (m, a, b, c) => ctx.vars.get(a ?? b ?? c) ?? m);
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'mksh', 'busybox']);
const KEYWORDS = new Set(['if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', 'time', 'function']);

function simple(c: SimpleCommand, piped: SimpleCommand | undefined, ctx: Ctx, depth: number): void {
  let words = c.words.map((w) => expand(w, ctx));
  const src = words.join(' ').slice(0, 200);
  const stdin = c.stdin ?? (piped ? outputOf(piped, ctx) : c.input ? ctx.readFile(path.resolve(ctx.cwd, c.input)) : undefined);
  const stdinUnknown = Boolean(piped) && stdin === undefined;

  // Assignments: "X=npm" alone sets a variable; "NPM_CONFIG_REGISTRY=... npm i" is env for one command.
  const env: [string, string][] = [];
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) {
    const [k, ...v] = words[0].split('=');
    env.push([k, v.join('=')]);
    words = words.slice(1);
  }
  // PowerShell: $X = "npm", $env:NPM_CONFIG_REGISTRY = "...". With arguments after the first word
  // ($out = npm install x, $o=npx vitest run) the right side is a command that runs, and $X gets its output.
  const glued = words.length >= 2 ? /^\$(\w+)=(.*)$/.exec(words[0]) : null;
  if (glued) words = [`$${glued[1]}`, '=', ...(glued[2] ? [glued[2]] : []), ...words.slice(1)];
  if (words.length >= 3 && /^\$(env:)?\w+$/i.test(words[0]) && words[1] === '=') {
    if (words.length > 3 && !/^\$env:/i.test(words[0])) words = words.slice(2);
    else {
      env.push([words[0].replace(/^\$(env:)?/i, ''), words.slice(2).join(' ')]);
      words = [];
    }
  }
  if (words[0] === 'export' || words[0] === 'set' && words[1]?.includes('=')) {
    for (const w of words.slice(1)) if (w.includes('=')) env.push([w.split('=')[0], w.split('=').slice(1).join('=')]);
    words = [];
  }
  for (const [k, v] of env) {
    if (!words.length) ctx.vars.set(k, v);
    sourceEnv(k, v, src, ctx);
  }

  const exported = environmentExport(c.words);
  for (const w of c.writes) {
    // "pip freeze > requirements.txt": the packages already installed (or locked), not new ones. They are checked
    // when something installs from the file (pip install -r reads it).
    if (exported && REQUIREMENTS_FILE.test(w.file)) continue;
    shellWrite(w.file, outputOf(c, ctx), w.append, ctx, src);
  }
  if (c.input && /^(patch|git)$/.test(binName(words[0] ?? ''))) patchFile(c.input, ctx, src);
  if (!words.length) return;

  // Aliases: alias n=npm, alias n='npm i', Set-Alias n npm.
  const head = binName(words[0]);
  if (/^(cd|pushd|chdir|set-location|sl|push-location)$/.test(head)) {
    const dir = words.slice(1).find((w) => !w.startsWith('-'));
    if (dir && !isDynamic(dir) && dir !== '~') ctx.cwd = path.resolve(ctx.cwd, windowsPath(dir));
    return;
  }
  if (head === 'alias') {
    for (const w of words.slice(1)) {
      const eq = w.indexOf('=');
      if (eq > 0) ctx.aliases.set(w.slice(0, eq), parseShell(w.slice(eq + 1)).commands[0]?.words ?? []);
    }
    return;
  }
  if (head === 'set-alias' || head === 'new-alias' || head === 'sal' || head === 'nal') {
    const pos = words.slice(1).filter((w) => !w.startsWith('-'));
    if (pos.length >= 2) ctx.aliases.set(pos[0], [pos[1]]);
    return;
  }

  // Peel wrappers until the command that runs.
  for (let guard = 0; guard < 12 && words.length; guard++) {
    while (words.length && KEYWORDS.has(words[0])) words = words.slice(1);
    if (!words.length) return;
    const alias = ctx.aliases.get(words[0]);
    if (alias && guard < 4) {
      words = [...alias, ...words.slice(1)];
      continue;
    }
    const bin = binName(words[0]);
    const rest = words.slice(1);
    const peeled = peel(bin, rest, c, stdin, stdinUnknown, ctx, depth, src);
    if (peeled === 'done') return;
    if (peeled) {
      words = peeled;
      continue;
    }
    break;
  }
  if (!words.length) return;
  manager(words, c, ctx, depth, src, stdin);
}

/** Skip leading options of a wrapper; `withValue` lists the ones that take an argument. */
function skipFlags(args: string[], withValue: string[] = []): string[] {
  let k = 0;
  while (k < args.length && args[k].startsWith('-') && args[k] !== '-') {
    if (args[k] === '--') return args.slice(k + 1);
    if (withValue.includes(args[k])) k++;
    k++;
  }
  return args.slice(k);
}

/**
 * One wrapper layer: the words of the command it runs, 'done' when it was handled here
 * (a nested command line walked, a script followed), or undefined when it is not a wrapper.
 */
function peel(bin: string, rest: string[], c: SimpleCommand, stdin: string | undefined, stdinUnknown: boolean, ctx: Ctx, depth: number, src: string): string[] | 'done' | undefined {
  switch (bin) {
    case 'sudo':
    case 'doas':
      return skipFlags(rest, ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir', '--prompt']);
    case 'env': {
      let r = skipFlags(rest, ['-u', '-C', '--unset', '--chdir', '-S', '--split-string']);
      const split = rest.indexOf('-S') >= 0 ? rest.indexOf('-S') : rest.indexOf('--split-string');
      if (split >= 0 && rest[split + 1]) r = [...(parseShell(rest[split + 1]).commands[0]?.words ?? []), ...rest.slice(split + 2)];
      while (r.length && /^[A-Za-z_]\w*=/.test(r[0])) {
        sourceEnv(r[0].split('=')[0], r[0].split('=').slice(1).join('='), src, ctx);
        r = r.slice(1);
      }
      return r;
    }
    case 'nohup':
    case 'builtin':
    case 'chronic':
    case 'unbuffer':
    case 'caffeinate':
    case 'call':
    case 'noglob':
      return rest;
    case 'command':
      if (rest[0] === '-v' || rest[0] === '-V') return 'done';
      return skipFlags(rest);
    case 'exec':
      return skipFlags(rest, ['-a']);
    case 'time':
      return skipFlags(rest, ['-f', '-o', '--format', '--output']);
    case 'nice':
      return skipFlags(rest, ['-n', '--adjustment']);
    case 'ionice':
      return skipFlags(rest, ['-c', '-n', '-p', '--class', '--classdata']);
    case 'stdbuf':
      return skipFlags(rest, ['-i', '-o', '-e']);
    case 'timeout': {
      const r = skipFlags(rest, ['-s', '-k', '--signal', '--kill-after']);
      return r.slice(1);
    }
    case 'watch':
      return skipFlags(rest, ['-n', '-d', '--interval']);
    case 'docker':
    case 'podman': {
      // docker exec [opts] container cmd..., docker compose exec [opts] service cmd...: the install runs in there.
      const r = rest[0] === 'compose' || rest[0] === 'container' ? rest.slice(1) : rest;
      if (r[0] !== 'exec') return 'done';
      const after = skipFlags(r.slice(1), ['-e', '--env', '-w', '--workdir', '-u', '--user', '--env-file', '--detach-keys', '--index']);
      return after.slice(1);
    }
    case 'corepack':
      return rest[0] && /^(npm|pnpm|yarn)(@.*)?$/.test(rest[0]) ? [rest[0].replace(/@.*$/, ''), ...rest.slice(1)] : 'done';
    case 'xargs': {
      const inner = skipFlags(rest, ['-n', '-I', '-i', '-L', '-l', '-P', '-d', '-a', '-E', '-e', '-s', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace']);
      if (!inner.length) return 'done';
      // Arguments come from stdin: known when the pipe starts with echo/printf, opaque otherwise.
      const fed = stdin !== undefined && !stdinUnknown ? stdin.split(/\s+/).filter(Boolean) : undefined;
      if (fed) return [...inner, ...fed];
      const runner = /^(npx|pnpx|bunx)$/.test(binName(inner[0]));
      if ((looksLikeInstall(inner) || runner) && !runnerNamesItsCommand(inner, xargsPlaceholder(rest))) {
        ctx.out.push(unverifiable('npm', binName(inner[0]), `xargs passes ${binName(inner[0])} arguments pinright cannot see; name the packages in the command.`, src));
      }
      return inner;
    }
    case 'eval':
    case 'iex':
    case 'invoke-expression':
      walk(rest.filter((w) => w !== '-Command').join(' '), ctx, depth + 1);
      return 'done';
    case 'source':
    case '.':
      if (rest[0]) followScript(rest[0], ctx, depth, src);
      return 'done';
    case 'cmd': {
      const k = rest.findIndex((w) => /^\/[ck]$/i.test(w));
      if (k >= 0) walk(rest.slice(k + 1).join(' '), ctx, depth + 1);
      return 'done';
    }
    case 'powershell':
    case 'pwsh': {
      for (let k = 0; k < rest.length; k++) {
        const w = rest[k].toLowerCase();
        if (/^-(c|co|com|comm|comma|comman|command)$/.test(w)) {
          walk(rest.slice(k + 1).join(' '), ctx, depth + 1);
          return 'done';
        }
        if (/^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)$/.test(w) && rest[k + 1]) {
          walk(Buffer.from(rest[k + 1], 'base64').toString('utf16le'), ctx, depth + 1);
          return 'done';
        }
        if (/^-(f|fi|fil|file)$/.test(w) && rest[k + 1]) {
          followScript(rest[k + 1], ctx, depth, src);
          return 'done';
        }
        if (/^-(executionpolicy|ep|ex|windowstyle|w|workingdirectory|wd|configurationname|outputformat|of|inputformat|if)$/.test(w)) k++;
        else if (!w.startsWith('-')) {
          // powershell.exe "npm i x": the default parameter is -Command.
          walk(rest.slice(k).join(' '), ctx, depth + 1);
          return 'done';
        }
      }
      if (stdin) walk(stdin, ctx, depth + 1);
      return 'done';
    }
    case 'start-process':
    case 'saps':
    case 'start': {
      let file: string | undefined;
      let args: string[] = [];
      for (let k = 0; k < rest.length; k++) {
        const w = rest[k].toLowerCase();
        if (w === '-filepath' || w === '-file') file = rest[++k];
        else if (w === '-argumentlist' || w === '-args') args = rest[++k]?.split(/[,\s]+/).filter(Boolean) ?? [];
        else if (/^-(workingdirectory|verb|windowstyle|redirectstandard\w+)$/.test(w)) k++;
        else if (w.startsWith('-') || w.startsWith('/')) continue;
        else if (!file) file = rest[k];
        else if (!args.length) args = rest[k].split(/[,\s]+/).filter(Boolean);
      }
      return file ? [file, ...args] : 'done';
    }
    default:
      break;
  }
  if (SHELLS.has(bin)) {
    let args = rest;
    if (bin === 'busybox') return args;
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '--') {
        args = args.slice(k + 1);
        break;
      }
      // -c, -lc, -ec, -xec: the next word is the command line.
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) {
        if (args[k + 1] !== undefined) walk(args[k + 1], ctx, depth + 1);
        return 'done';
      }
      if (a === '-o' || a === '+o' || a === '-O' || a === '+O') k++;
      else if (!a.startsWith('-') && !a.startsWith('+')) {
        followScript(a, ctx, depth, src);
        return 'done';
      }
    }
    // No script and no -c: the shell reads its commands from stdin.
    if (stdin !== undefined) walk(stdin, ctx, depth + 1);
    else if (stdinUnknown && c.words.length) ctx.out.push(unverifiable('npm', bin, `pipes commands from another program into ${bin}; pinright cannot see what they install.`, src, 'note'));
    return 'done';
  }
  return undefined;
}

/** A script run by name: read it from disk and walk it. */
function followScript(file: string, ctx: Ctx, depth: number, src: string): void {
  if (isDynamic(file)) return;
  const abs = path.resolve(ctx.cwd, file);
  if (ctx.followed.has(abs)) return;
  ctx.followed.add(abs);
  const content = ctx.readFile(abs);
  if (content === undefined) return;
  // A Python or Node script is code, not a command list; leave it.
  if (/\.(py|js|mjs|cjs|ts|rb)$/i.test(file)) return;
  void src;
  walk(content, ctx, depth + 1);
}

/** git apply / patch: a diff that touches a guarded file cannot be followed line by line. */
function patchFile(file: string, ctx: Ctx, src: string): void {
  const content = ctx.readFile(path.resolve(ctx.cwd, file));
  if (!content) return;
  for (const m of content.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) {
    if (isGuardedFile(m[1])) ctx.out.push(unverifiable('npm', m[1], `applies a patch to ${m[1]}; pinright cannot check the result before it is applied. Edit the file directly instead.`, src));
  }
}

/** Environment variables that point a package manager at another registry, or turn off checksum checks. */
function sourceEnv(key: string, value: string, src: string, ctx: Ctx): void {
  const k = key.toUpperCase();
  const registry = /^(NPM_CONFIG_REGISTRY|NPM_CONFIG_@.*:REGISTRY|YARN_REGISTRY|YARN_NPM_REGISTRY_SERVER|BUN_CONFIG_REGISTRY|PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|PIP_FIND_LINKS|UV_INDEX_URL|UV_EXTRA_INDEX_URL|UV_DEFAULT_INDEX|UV_INDEX|UV_FIND_LINKS|PDM_PYPI_URL|POETRY_REPOSITORIES_\w+_URL|GOPROXY|CARGO_REGISTRIES_\w+_INDEX|BUNDLE_MIRROR__\w+|COMPOSER_REPO_PACKAGIST)$/.test(k);
  const insecure = /^(GONOSUMDB|GONOSUMCHECK|GOINSECURE|GONOSUMVERIFY|GOSUMDB|PIP_TRUSTED_HOST|NPM_CONFIG_STRICT_SSL|UV_INSECURE_HOST)$/.test(k) || (k === 'GOFLAGS' && /insecure/.test(value));
  if ((registry && isCustomRegistry(value)) || (insecure && value && !(k === 'GOSUMDB' && /^sum\.golang\.org/.test(value)))) {
    const eco: Ecosystem = /^(PIP|UV|PDM|POETRY)_/.test(k) ? 'pypi' : /^GO/.test(k) ? 'go' : /^CARGO/.test(k) ? 'cargo' : /^BUNDLE/.test(k) ? 'rubygems' : /^COMPOSER/.test(k) ? 'composer' : 'npm';
    ctx.out.push(unverifiable(eco, k, `${key}=${value.slice(0, 80)} changes where packages come from or turns off their checks; pinright cannot vouch for that source.`, src));
  }
}

const REQUIREMENTS_FILE = /(^|[\\/])([^\\/]*requirements[^\\/]*|requirements[\\/][^\\/]+|constraints[^\\/]*)\.(txt|in)$/i;

/** pip freeze, uv pip freeze, pip list --format=freeze, uv/poetry/pdm export: a listing of what is installed or locked. */
function environmentExport(words: string[]): boolean {
  let w = words;
  while (w.length && /^[A-Za-z_]\w*=/.test(w[0])) w = w.slice(1);
  const bin = binName(w[0] ?? '');
  const rest = w.slice(1);
  if (/^(python[\d.]*|py|pythonw)$/.test(bin)) {
    const k = rest.indexOf('-m');
    return k >= 0 && environmentExport(rest.slice(k + 1));
  }
  const pos = rest.filter((a) => !a.startsWith('-'));
  if (/^pip[\d.]*$/.test(bin)) return pos[0] === 'freeze' || (pos[0] === 'list' && /--format[= ]freeze/.test(rest.join(' ')));
  if (bin === 'uv') return (pos[0] === 'pip' && pos[1] === 'freeze') || pos[0] === 'export';
  if (bin === 'poetry' || bin === 'pdm') return pos[0] === 'export';
  return false;
}

/** A file written by a redirection, tee, cp, sed -i...: computed when we can, flagged when we cannot. */
function shellWrite(file: string, content: string | undefined, append: boolean, ctx: Ctx, src: string): void {
  if (isDynamic(file) || /^\/dev\//.test(file) || /^(nul|\$null)$/i.test(file)) return;
  const abs = path.resolve(ctx.cwd, file);
  const old = ctx.readFile(abs);
  const next = content === undefined ? undefined : append ? (old ?? '') + content : content;
  // Later commands in the same line read what this one wrote: echo "npm i x" > s.sh && sh s.sh.
  if (next !== undefined) ctx.written.set(abs, next);
  if (!isGuardedFile(abs)) return;
  for (const i of fromFileWrite(abs, next, old)) ctx.out.push({ ...i, source: i.unverifiable ? src : i.source });
  if (/(^|[\\/])package\.json$/i.test(abs)) ctx.out.push(...lifecycleIntents(abs, next, old, ctx.readFile));
}

/**
 * Install-time scripts a package.json write adds or changes (preinstall, install, postinstall, prepare):
 * the next bare `npm install` runs them, whoever types it.
 */
export function lifecycleIntents(file: string, next: string | undefined, old: string | undefined, readFile: ReadFile): DepIntent[] {
  const scripts = (s: string | undefined): Record<string, unknown> => {
    try {
      return (s ? JSON.parse(s)?.scripts : undefined) ?? {};
    } catch {
      return {};
    }
  };
  const before = scripts(old);
  const after = scripts(next);
  const out: DepIntent[] = [];
  for (const name of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
    const body = after[name];
    if (typeof body !== 'string' || body === before[name]) continue;
    for (const i of fromCommand(body, path.dirname(file), readFile)) out.push({ ...i, source: `${path.basename(file)} ${name}: ${body}`.slice(0, 200) });
  }
  return out;
}

/** Commands that write files named in their arguments. */
function fileWriters(bin: string, args: string[], c: SimpleCommand, ctx: Ctx, src: string, stdin: string | undefined): boolean {
  const pos = args.filter((a) => !a.startsWith('-'));
  switch (bin) {
    case 'tee': {
      const append = args.some((a) => a === '-a' || a === '--append');
      for (const f of pos) shellWrite(f, stdin, append, ctx, src);
      return true;
    }
    case 'sed':
    case 'perl':
    case 'ruby':
    case 'awk':
    case 'gawk':
      if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place') || (bin.endsWith('awk') && a === 'inplace'))) for (const f of pos.slice(1)) shellWrite(f, undefined, false, ctx, src);
      return true;
    case 'cp':
    case 'mv':
    case 'copy':
    case 'move':
    case 'copy-item':
    case 'move-item':
    case 'cpi':
    case 'mi':
    case 'ren':
    case 'rename':
    case 'rename-item':
    case 'install':
    case 'rsync':
    case 'ln': {
      const named = (flag: string) => {
        const k = args.findIndex((a) => a.toLowerCase() === flag);
        return k >= 0 ? args[k + 1] : undefined;
      };
      const dst = named('-destination') ?? named('-newname') ?? pos[pos.length - 1];
      const srcFile = named('-path') ?? named('-literalpath') ?? (pos.length >= 2 ? pos[0] : undefined);
      if (dst && pos.length >= 1) {
        // cp evil.json package.json: the new content is the source file's.
        const target = isGuardedFile(path.resolve(ctx.cwd, dst)) ? dst : srcFile && /([\\/]|^\.{1,2})$/.test(dst) ? path.join(dst, path.basename(srcFile)) : undefined;
        if (target) shellWrite(target, srcFile ? ctx.readFile(path.resolve(ctx.cwd, srcFile)) : undefined, false, ctx, src);
      }
      // Moving the policy away removes it, like rm: mv .pinright.json x.
      if (srcFile && /^(mv|move|move-item|mi|ren|rename|rename-item)$/.test(bin) && /(^|[\\/])\.pinright\.json$/i.test(srcFile)) shellWrite(srcFile, '', false, ctx, src);
      return true;
    }
    case 'curl':
    case 'wget':
    case 'invoke-webrequest':
    case 'iwr':
    case 'invoke-restmethod':
    case 'irm': {
      for (let k = 0; k < args.length; k++) {
        if (/^(-o|--output|-O|--output-document|-outfile)$/i.test(args[k]) && args[k + 1]) shellWrite(args[k + 1], undefined, false, ctx, src);
      }
      return true;
    }
    case 'set-content':
    case 'add-content':
    case 'out-file':
    case 'sc':
    case 'ac': {
      let file: string | undefined;
      let value: string | undefined;
      const free: string[] = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k].toLowerCase();
        if (a === '-path' || a === '-filepath' || a === '-literalpath') file = args[++k];
        else if (a === '-value' || a === '-inputobject') value = args[++k];
        // "-Encoding ascii": the parameter's value is not part of the content.
        else if (/^-(encoding|stream|filter|include|exclude|credential|width|delimiter)$/.test(a)) k++;
        else if (a.startsWith('-')) continue;
        else free.push(args[k]);
      }
      file ??= free.shift();
      value ??= free.length ? free.join(' ') : stdin;
      if (file) shellWrite(file, value === undefined ? undefined : `${value}\n`, bin === 'add-content' || bin === 'ac' || args.some((a) => /^-append$/i.test(a)), ctx, src);
      return true;
    }
    case 'rm':
    case 'del':
    case 'erase':
    case 'unlink':
    case 'remove-item':
    case 'ri':
      for (const f of pos) if (/(^|[\\/])\.pinright\.json$/i.test(f)) shellWrite(f, '', false, ctx, src);
      return true;
    case 'truncate':
    case 'dd':
      for (const a of args) {
        const f = a.startsWith('of=') ? a.slice(3) : a;
        if (isGuardedFile(path.resolve(ctx.cwd, f))) shellWrite(f, undefined, false, ctx, src);
      }
      return true;
    case 'patch': {
      const k = args.findIndex((a) => a === '-i' || a === '--input');
      if (k >= 0 && args[k + 1]) patchFile(args[k + 1], ctx, src);
      if (c.input) patchFile(c.input, ctx, src);
      return true;
    }
    default:
      return false;
  }
}

/** Value-taking options per tool, so their value is not read as a package; anything else is a boolean flag. */
const VALUE_FLAGS: Record<string, string[]> = {
  npm: ['--registry', '--prefix', '-C', '--cwd', '-w', '--workspace', '--tag', '--userconfig', '--globalconfig', '--cache', '--omit', '--include', '--install-strategy', '--before', '--loglevel', '--otp', '--scope', '-p', '--package', '-c', '--call'],
  pnpm: ['--registry', '--filter', '-F', '-C', '--dir', '--reporter', '--store-dir', '--config', '--loglevel', '--workspace-concurrency', '--virtual-store-dir', '--allow-build'],
  yarn: ['--registry', '--cwd', '--network-timeout', '--modules-folder', '--cache-folder', '--mutex', '--use-yarnrc', '-p', '--package'],
  bun: ['--registry', '--cwd', '--backend', '--cache-dir', '-c', '--config', '--cpu', '--os', '--filter', '-F'],
  pip: ['-r', '--requirement', '--group', '-c', '--constraint', '-i', '--index-url', '--extra-index-url', '-t', '--target', '-e', '--editable', '--prefix', '--root', '--src', '--python', '--platform', '--python-version', '--implementation', '--abi', '-f', '--find-links', '--cache-dir', '--log', '--trusted-host', '--proxy', '--timeout', '--retries', '--progress-bar', '--upgrade-strategy', '--report', '-C', '--config-settings', '--global-option', '--no-binary', '--only-binary', '--exists-action', '-d', '--dest', '-w', '--wheel-dir'],
  uv: ['-p', '--python', '--group', '--optional', '--extra', '--package', '--directory', '--project', '--index', '--default-index', '--index-url', '--extra-index-url', '-i', '--branch', '--tag', '--rev', '--bounds', '-m', '--marker', '--script', '-r', '--requirements', '--requirement', '-c', '--constraint', '--constraints', '--with', '--with-requirements', '--with-editable', '--from', '-f', '--find-links', '--env-file', '--python-platform', '--index-strategy', '--keyring-provider', '--resolution', '--prerelease', '-w', '--overrides', '--target', '--prefix'],
  poetry: ['-G', '--group', '-E', '--extras', '--source', '--python', '-C', '--directory', '-P', '--project'],
  pdm: ['-G', '--group', '-p', '--project', '-L', '--lockfile', '-v'],
  pipx: ['--spec', '--python', '--index-url', '-i', '--pip-args', '--suffix', '--preinstall'],
  conda: ['-c', '--channel', '-n', '--name', '-p', '--prefix', '--file', '--override-channels'],
  cargo: ['--vers', '--version', '--git', '--branch', '--tag', '--rev', '--path', '--registry', '--index', '-F', '--features', '--package', '-p', '--rename', '--target', '--root', '-j', '--jobs', '--target-dir', '--manifest-path', '-Z', '--config', '--profile', '--bin', '--example'],
  go: ['-modfile', '-C', '-tags', '-o', '-ldflags', '-gcflags', '-mod', '-p', '-exec', '-overlay', '-pgo'],
  gem: ['-v', '--version', '-i', '--install-dir', '-n', '--bindir', '--source', '-s', '-P', '--trust-policy', '--platform', '-g', '--file'],
  bundle: ['-v', '--version', '-g', '--group', '-s', '--source', '--git', '--github', '--branch', '--ref', '--path', '--require'],
  dotnet: ['-v', '--version', '-s', '--source', '-f', '--framework', '--package-directory'],
  composer: ['-d', '--working-dir'],
  make: ['-C', '-f', '--file', '--makefile', '--directory', '-j', '-l', '-o', '-W', '-I', '--justfile', '-d', '--working-directory', '--set'],
  git: ['-C', '-c'],
  deno: ['-c', '--config', '--import-map', '--lock', '-n', '--name', '--root', '--location', '--seed', '--env-file', '--cert'],
};

/**
 * `stop`: true once the positionals so far name a command that gets the rest of the line ("npx tsc -p x",
 * "uv run mkdocs -f y"): what follows are that command's arguments, not options of the package manager.
 */
function parseArgs(args: string[], tool: string, stop?: (pos: string[]) => boolean): { pos: string[]; flags: Map<string, string[]> } {
  const values = new Set(VALUE_FLAGS[tool] ?? []);
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  const put = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      pos.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      const eq = a.indexOf('=');
      if (eq > 0 && a.startsWith('--')) put(a.slice(0, eq), a.slice(eq + 1));
      else if (values.has(a)) put(a, args[++k] ?? '');
      else put(a, '');
    } else {
      pos.push(a);
      if (stop?.(pos)) {
        pos.push(...args.slice(k + 1));
        break;
      }
    }
  }
  return { pos, flags };
}

const first = (flags: Map<string, string[]>, ...names: string[]) => {
  for (const n of names) {
    const v = flags.get(n);
    if (v?.length) return v[0];
  }
  return undefined;
};
const all = (flags: Map<string, string[]>, ...names: string[]) => names.flatMap((n) => flags.get(n) ?? []);

/** The bin a package exposes, for the command after npx: "@scope/create-x@1" -> "create-x". */
function packageBin(spec: string): string {
  const k = npmSpecKind(spec);
  const name = k.kind === 'package' ? k.name : spec;
  return name.replace(/^@[^/]+\//, '');
}

/**
 * Whether npx would run something installed here and fetch nothing: a bin in node_modules/.bin
 * named exactly like the argument ("npx tsc" in a TypeScript project is typescript's compiler,
 * not the "tsc" package), or the package itself in node_modules ("npx @biomejs/biome"). npm looks
 * a scoped name up as a package, never by its bin: "npx @evil/tsc" next to typescript's tsc bin
 * downloads @evil/tsc, so the scope is not stripped here.
 */
function hasLocalBin(ctx: Ctx, spec: string): boolean {
  const k = npmSpecKind(spec);
  const pkg = k.kind === 'package' ? k.name : undefined;
  const bin = /^[\w.-]+$/.test(spec) ? spec : undefined;
  let dir = path.resolve(ctx.cwd);
  for (let i = 0; i < 8; i++) {
    if (bin) for (const f of [bin, `${bin}.cmd`]) if (ctx.readFile(path.join(dir, 'node_modules', '.bin', f)) !== undefined) return true;
    if (pkg && /^(@[\w.-]+\/)?[\w.-]+$/.test(pkg) && ctx.readFile(path.join(dir, 'node_modules', ...pkg.split('/'), 'package.json')) !== undefined) return true;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

function manager(words: string[], c: SimpleCommand, ctx: Ctx, depth: number, src: string, stdin: string | undefined): void {
  let [bin, ...rest] = [binName(words[0]), ...words.slice(1)];
  if (fileWriters(bin, rest, c, ctx, src, stdin)) return;
  const out = ctx.out;
  const flag = (eco: Ecosystem, what: string) => {
    out.push(unverifiable(eco, what, `${what} comes from outside the registry; pinright cannot check it.`, src));
  };
  const dynamic = (eco: Ecosystem) => {
    out.push(unverifiable(eco, 'dynamic', 'a package name comes from a variable or a substitution pinright cannot resolve; name the package in the command.', src));
  };
  const registry = (eco: Ecosystem, url: string | undefined) => {
    if (isCustomRegistry(url)) out.push(unverifiable(eco, url as string, `installs from ${url}, not the public registry; pinright cannot vouch for that source.`, src));
  };
  const npm = (specs: string[], executes = false) => {
    for (const s of specs) push('npm', npmSpecKind(s), executes, s);
  };
  const py = (specs: string[], executes = false) => {
    for (const s of specs) push('pypi', pySpecKind(s), executes, s);
  };
  function push(eco: Ecosystem, k: SpecKind, executes: boolean, raw: string) {
    if (k.kind === 'package') out.push({ ecosystem: eco, name: k.name, spec: k.spec, source: src, ...(executes ? { executes } : {}) });
    else if (k.kind === 'remote') flag(eco, k.what);
    else if (k.kind === 'dynamic') dynamic(eco);
    else if (k.kind === 'jsr') out.push(unverifiable(eco, k.name, `jsr:${k.name} is a JSR package; pinright does not check JSR.`, src, 'note'));
    void raw;
  }
  /** After npx/uvx/dlx: the executed bin gets the rest of the line, which may itself install (npx pnpm add x). */
  const thenRun = (binWord: string, args: string[]) => {
    if (args.length && MANAGERS.has(binName(binWord))) manager([binWord, ...args], { ...c, writes: [] }, ctx, depth, src, undefined);
  };

  // python -m pip, py -3.12 -m pip, python3.12 -m uv...
  if (/^(python[\d.]*|py|pythonw)$/.test(bin)) {
    const k = rest.indexOf('-m');
    if (k < 0 || !rest[k + 1]) return;
    [bin, ...rest] = [rest[k + 1].toLowerCase(), ...rest.slice(k + 2)];
  }
  if (/^pip[\d.]*$/.test(bin)) bin = 'pip';
  if (bin === 'pnpx') bin = 'npx';

  // Script runners: follow what the script runs.
  const scripts = (dir: string, names: string[]) => {
    const abs = path.resolve(ctx.cwd, dir, 'package.json');
    let pj: { scripts?: Record<string, string> } | undefined;
    try {
      pj = JSON.parse(ctx.readFile(abs) ?? 'null') ?? undefined;
    } catch {
      pj = undefined;
    }
    for (const n of names) {
      const body = pj?.scripts?.[n];
      if (typeof body !== 'string') continue;
      const key = `${abs}#${n}`;
      if (ctx.followed.has(key)) continue;
      ctx.followed.add(key);
      walk(body, { ...ctx, cwd: path.dirname(abs) } as Ctx, depth + 1);
    }
  };
  const lifecycle = (dir: string) => scripts(dir, ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']);
  const runScript = (dir: string, name: string | undefined) => {
    if (name) scripts(dir, [`pre${name}`, name, `post${name}`]);
  };

  switch (bin) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const { pos, flags } = parseArgs(rest, bin, (p) => p.length >= 2 && ((bin === 'bun' && p[0] === 'x') || (bin !== 'npm' && p[0] === 'dlx')));
      const dir = first(flags, '--prefix', '-C', '--cwd', '--dir') ?? '.';
      registry('npm', first(flags, '--registry'));
      // --ignore-scripts: the project's lifecycle scripts do not run (--ignore-scripts=false turns them back on).
      const scriptsRun = !(flags.get('--ignore-scripts') ?? []).some((v) => v === '' || v === 'true');
      const lifecycleIf = (d: string) => (scriptsRun ? lifecycle(d) : undefined);
      const verb = pos[0] ?? '';
      const adds = /^(install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|a|update|up|upgrade|udpate)$/;
      if (bin === 'npm' && /^(exec|x)$/.test(verb)) return npx(pos.slice(1), flags);
      if (bin === 'bun' && verb === 'x') return npx(pos.slice(1), flags);
      if (bin !== 'npm' && verb === 'dlx') return npx(pos.slice(1), flags, false);
      if (/^(create|init|innit)$/.test(verb) && !(bin === 'bun' && verb === 'init')) {
        // npm init foo runs create-foo; npm init @s runs @s/create; @s/foo runs @s/create-foo.
        const t = pos[1];
        if (!t || t.startsWith('-')) return;
        const k = npmSpecKind(t);
        if (k.kind !== 'package') return push('npm', k, true, t);
        const name = k.name.startsWith('@') ? (k.name.includes('/') ? k.name.replace(/\/(.+)$/, '/create-$1') : `${k.name}/create`) : `create-${k.name}`;
        out.push({ ecosystem: 'npm', name, spec: k.spec, source: src, executes: true });
        return;
      }
      if (bin === 'yarn' && verb === 'global' && adds.test(pos[1] ?? '')) return npm(pos.slice(2));
      if (bin === 'npm' && verb === 'pkg' && pos[1] === 'set') {
        for (const kv of pos.slice(2)) {
          const m = kv.match(/^(dependencies|devDependencies|optionalDependencies|peerDependencies|overrides)\.(.+?)=(.*)$/);
          if (m) push('npm', npmSpecKindFromValue(m[2], m[3]), false, kv);
        }
        return;
      }
      if ((verb === 'config' && pos[1] === 'set') || (bin === 'npm' && verb === 'set')) {
        const kv = verb === 'set' ? pos.slice(1) : pos.slice(2);
        const [key, value] = kv[0]?.includes('=') ? [kv[0].split('=')[0], kv[0].split('=').slice(1).join('=')] : [kv[0], kv[1]];
        if (key && !NPM_AUTH_KEY.test(key) && /registry|npmScopes|npmRegistryServer|strict-ssl|enableStrictSsl|unsafeHttpWhitelist/i.test(key) && (isCustomRegistry(value) || !/^https?:/.test(value ?? ''))) {
          out.push(unverifiable('npm', key, `sets ${key} to ${value ?? '?'}; packages would come from a source pinright cannot vouch for.`, src));
        }
        return;
      }
      if (adds.test(verb)) {
        const pkgs = pos.slice(1);
        if (pkgs.length) return npm(pkgs);
        // A bare install runs the project's lifecycle scripts.
        if (/^(install|i|in|ins|inst|insta|instal|isnt|isntall)$/.test(verb) || bin === 'yarn' && !verb) lifecycleIf(dir);
        return;
      }
      if (!verb && bin === 'yarn') return lifecycleIf(dir);
      if (verb === 'ci') return lifecycleIf(dir);
      if (/^(run|run-script|rum|urn)$/.test(verb)) return runScript(dir, pos[1]);
      if (bin === 'npm' && /^(start|test|t|tst|stop|restart)$/.test(verb)) return runScript(dir, verb === 't' || verb === 'tst' ? 'test' : verb);
      if (bin === 'pnpm' && verb === 'exec') return thenRun(pos[1] ?? '', pos.slice(2));
      // pnpm <script>, yarn <script>, bun <script>.
      if (bin !== 'npm' && verb && !verb.includes('.')) return runScript(dir, verb);
      return;
    }
    case 'npx':
    case 'bunx': {
      // npx and bunx take options only before the package; the rest goes to the bin (npm docs, "npx vs npm exec").
      const { pos, flags } = parseArgs(rest, 'npm', (p) => p.length >= 1);
      return npx(pos, flags);
    }
    case 'pip':
    case 'pipenv': {
      const { pos, flags } = parseArgs(rest, 'pip');
      if (pos[0] === 'config' && pos[1] === 'set' && /index-url|extra-index-url|find-links|trusted-host/.test(pos[2] ?? '')) {
        out.push(unverifiable('pypi', pos[2], `sets ${pos[2]} to ${pos[3] ?? '?'}; packages would come from a source pinright cannot vouch for.`, src));
        return;
      }
      // uv pip sync installs exactly what the files list, like pip install -r.
      if (pos[0] === 'sync' && bin === 'pip') {
        pipSources(flags, 'pypi');
        for (const f of pos.slice(1)) requirements(f);
        return;
      }
      if (!/^(install|download|wheel)$/.test(pos[0] ?? '') && !(bin === 'pipenv' && pos[0] === 'install')) return;
      pipSources(flags, 'pypi');
      py(pos.slice(1));
      for (const e of all(flags, '-e', '--editable')) if (pySpecKind(e).kind !== 'local') push('pypi', pySpecKind(e), false, e);
      for (const f of all(flags, '-r', '--requirement')) requirements(f);
      return;
    }
    case 'pip-sync': {
      // pip-tools: pip-sync [requirements.txt ...], requirements.txt by default.
      const { pos, flags } = parseArgs(rest, 'pip');
      pipSources(flags, 'pypi');
      for (const f of pos.length ? pos : ['requirements.txt']) requirements(f);
      return;
    }
    case 'uv': {
      if (rest[0] === 'pip') return manager(['pip', ...rest.slice(1)], c, ctx, depth, src, stdin);
      const { pos, flags } = parseArgs(rest, 'uv', (p) => (p[0] === 'run' && p.length >= 2) || (p[0] === 'tool' && p[1] === 'run' && p.length >= 3));
      pipSources(flags, 'uv');
      for (const w of all(flags, '--with')) py(w.split(','));
      for (const f of [...all(flags, '-r', '--requirements', '--requirement', '--with-requirements')]) requirements(f);
      if (pos[0] === 'add') return py(pos.slice(1));
      if (pos[0] === 'tool' && pos[1] === 'install') return py([first(flags, '--from') ?? pos[2]].filter(Boolean).map((t) => uvToolSpec(t as string)), true);
      if (pos[0] === 'tool' && pos[1] === 'run') return uvx(pos.slice(2), flags);
      if (pos[0] === 'run') return thenRun(pos[1] ?? '', pos.slice(2));
      return;
    }
    case 'uvx': {
      const { pos, flags } = parseArgs(rest, 'uv', (p) => p.length >= 1);
      pipSources(flags, 'uv');
      for (const w of all(flags, '--with')) py(w.split(','));
      return uvx(pos, flags);
    }
    case 'poetry':
    case 'pdm': {
      const { pos, flags } = parseArgs(rest, bin, (p) => p[0] === 'run' && p.length >= 2);
      if (pos[0] === 'add') return poetrySpecs(pos.slice(1));
      if (bin === 'poetry' && pos[0] === 'self' && pos[1] === 'add') return poetrySpecs(pos.slice(2), true);
      if (bin === 'poetry' && pos[0] === 'source' && pos[1] === 'add') return registry('pypi', pos[3]);
      if (pos[0] === 'run') return thenRun(pos[1] ?? '', pos.slice(2));
      void flags;
      return;
    }
    case 'pipx': {
      const { pos, flags } = parseArgs(rest, 'pipx', (p) => p[0] === 'run' && p.length >= 2);
      pipSources(flags, 'pipx');
      const spec = first(flags, '--spec');
      if (pos[0] === 'run') return py([spec ?? pos[1]].filter(Boolean) as string[], true);
      if (pos[0] === 'install') return py(pos.slice(1).length ? pos.slice(1) : [spec].filter(Boolean) as string[], true);
      if (pos[0] === 'inject') return py(pos.slice(2));
      return;
    }
    case 'conda':
    case 'mamba':
    case 'micromamba': {
      const { pos, flags } = parseArgs(rest, 'conda');
      if (!/^(install|create|update)$/.test(pos[0] ?? '')) return;
      for (const ch of all(flags, '-c', '--channel')) if (/^https?:/.test(ch) && isCustomRegistry(ch)) registry('pypi', ch);
      for (const s of pos.slice(1)) {
        if (isDynamic(s)) dynamic('pypi');
        else out.push(unverifiable('pypi', s.split(/[=<>]/)[0], `${s} is a conda package; pinright checks PyPI, npm and the other registries, not conda channels.`, src, 'note'));
      }
      return;
    }
    case 'cargo':
    case 'cargo-binstall': {
      const { pos, flags } = parseArgs(rest, 'cargo');
      const verb = bin === 'cargo-binstall' ? 'binstall' : pos[0];
      const pkgs = bin === 'cargo-binstall' ? pos : pos.slice(1);
      if (!/^(add|install|binstall)$/.test(verb ?? '')) return;
      const git = first(flags, '--git');
      if (git) return flag('cargo', `--git ${git}`);
      if (flags.has('--path')) return;
      registry('cargo', first(flags, '--index'));
      if (flags.has('--registry')) out.push(unverifiable('cargo', first(flags, '--registry') ?? '', `installs from the "${first(flags, '--registry')}" registry, not crates.io; pinright cannot vouch for it.`, src));
      for (const s of pkgs) {
        if (isDynamic(s)) {
          dynamic('cargo');
          continue;
        }
        const [name, spec] = splitNpmSpec(s);
        const version = spec ?? first(flags, '--vers', '--version');
        // "--version $V": the version is unknown, like npm's "x@$V".
        if (version && isDynamic(version)) {
          dynamic('cargo');
          continue;
        }
        out.push({ ecosystem: 'cargo', name, spec: version, source: src, ...(verb !== 'add' ? { executes: true } : {}) });
      }
      return;
    }
    case 'go': {
      const { pos, flags } = parseArgs(rest, 'go');
      if (!/^(get|install|run)$/.test(pos[0] ?? '')) return;
      if (pos[0] === 'run' || pos[0] === 'install') {
        // go run ./cmd and go install ./... build local code.
        if (!pos[1] || !pos[1].includes('@')) return;
      }
      void flags;
      for (const s of pos[0] === 'run' ? pos.slice(1, 2) : pos.slice(1)) {
        if (isDynamic(s)) {
          dynamic('go');
          continue;
        }
        if (s.startsWith('.') || !s.split('/')[0].includes('.')) continue;
        const [mod, spec] = splitNpmSpec(s);
        if (spec === 'none') continue;
        // "@177de93b...", "@main": a commit or a branch, not a release deps.dev and OSV list.
        if (spec && !/^(latest|upgrade|patch)$/.test(spec) && !/^v?\d+(\.\d+){0,2}([-+].*)?$/.test(spec)) {
          out.push(unverifiable('go', mod, `${mod}@${spec} is a commit or a branch, not a release; pinright cannot check it.`, src));
          continue;
        }
        out.push({ ecosystem: 'go', name: mod.replace(/\/\.\.\.$/, ''), spec: spec === 'latest' || spec === 'upgrade' || spec === 'patch' ? undefined : spec?.replace(/^v/, ''), source: src, ...(pos[0] !== 'get' ? { executes: true } : {}) });
      }
      return;
    }
    case 'gem': {
      const { pos, flags } = parseArgs(rest, 'gem');
      if (pos[0] === 'sources' && (flags.has('-a') || flags.has('--add'))) return registry('rubygems', pos[1] ?? first(flags, '-a', '--add'));
      if (pos[0] !== 'install' && pos[0] !== 'i' && pos[0] !== 'update') return;
      registry('rubygems', first(flags, '--source', '-s'));
      for (const s of pos.slice(1)) {
        if (isDynamic(s)) dynamic('rubygems');
        else if (!/\.gem$/i.test(s) && !s.includes('/')) {
          const [name, ver] = s.includes(':') ? s.split(':') : [s, undefined];
          out.push({ ecosystem: 'rubygems', name, spec: ver ?? first(flags, '-v', '--version'), source: src });
        }
      }
      return;
    }
    case 'bundle': {
      const { pos, flags } = parseArgs(rest, 'bundle');
      if (pos[0] === 'config' && /mirror/i.test(pos.slice(1).join(' '))) {
        out.push(unverifiable('rubygems', 'mirror', 'sets a gem mirror; pinright cannot vouch for that source.', src));
        return;
      }
      if (pos[0] !== 'add' || !pos[1]) return;
      const remote = first(flags, '--git', '--github');
      if (remote) return flag('rubygems', `${pos[1]} from ${remote}`);
      if (flags.has('--path')) return;
      registry('rubygems', first(flags, '--source', '-s'));
      for (const name of pos.slice(1)) out.push({ ecosystem: 'rubygems', name, spec: first(flags, '--version', '-v'), source: src });
      return;
    }
    case 'dotnet':
    case 'nuget':
    case 'install-package': {
      const { pos, flags } = parseArgs(rest, 'dotnet');
      let name: string | undefined;
      if (bin === 'install-package') name = pos[0] ?? first(flags, '-Id', '-id');
      else if (bin === 'nuget') name = pos[0] === 'install' ? pos[1] : undefined;
      else {
        // dotnet add [project] package X, dotnet package add X.
        const k = pos.indexOf('package');
        if (pos[0] === 'add' && k > 0) name = pos[k + 1];
        else if (pos[0] === 'package' && pos[1] === 'add') name = pos[2];
      }
      if (!name) return;
      registry('nuget', first(flags, '--source', '-s', '-Source'));
      if (isDynamic(name)) return dynamic('nuget');
      out.push({ ecosystem: 'nuget', name, spec: first(flags, '--version', '-v', '-Version'), source: src });
      return;
    }
    case 'composer':
    case 'composer.phar': {
      const { pos } = parseArgs(rest, 'composer');
      const p = pos[0] === 'global' ? pos.slice(1) : pos;
      if (p[0] === 'config' && /^repositories\./.test(p[1] ?? '')) {
        out.push(unverifiable('composer', p[1], `adds the Composer repository ${p.slice(2).join(' ')}; pinright cannot vouch for it.`, src));
        return;
      }
      out.push(...composerIntents(p, src));
      return;
    }
    case 'deno': {
      const { pos, flags } = parseArgs(rest, 'deno');
      const verb = pos[0];
      void flags;
      const specs = (list: string[], executes: boolean) => {
        for (const s of list) {
          if (/^npm:/i.test(s)) npm([s], executes);
          else if (/^jsr:/i.test(s) || (/^@[\w-]+\/[\w-]+/.test(s) && verb === 'add')) push('npm', { kind: 'jsr', name: s.replace(/^jsr:/i, '') }, executes, s);
          else if (isDynamic(s)) dynamic('npm');
        }
      };
      if (verb === 'add') return specs(pos.slice(1), false);
      if (verb === 'install' || verb === 'i') return specs(pos.slice(1), flags.has('-g') || flags.has('--global'));
      if (verb === 'run' || verb === 'x') return specs(pos.slice(1, 2), true);
      return;
    }
    case 'make':
    case 'gmake':
    case 'just': {
      const { pos, flags } = parseArgs(rest, 'make');
      const dir = first(flags, '-C', '--directory', '-d') ?? '.';
      const targets = pos.filter((p) => !p.includes('='));
      if (bin === 'just') return recipes(path.resolve(ctx.cwd, dir), ['justfile', 'Justfile', '.justfile'], targets, /^@?([A-Za-z_][\w-]*)(?:\s+[^:=]*)?:(?!=)/);
      // make VAR=value on the command line overrides the Makefile.
      const given = pos.filter((p) => /^[A-Za-z_][\w.]*=/.test(p)).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)] as [string, string]);
      return recipes(path.resolve(ctx.cwd, dir), [first(flags, '-f', '--file', '--makefile') ?? 'GNUmakefile', 'makefile', 'Makefile'], targets, /^([A-Za-z0-9_./%-][^:=\s]*(?:\s+[^:=\s]+)*)\s*::?(?!=)/, given);
    }
    case 'git': {
      const { pos } = parseArgs(rest, 'git');
      if ((pos[0] === 'apply' || pos[0] === 'am') && pos[1]) patchFile(pos[1], ctx, src);
      // git checkout <ref> -- package.json, git restore --source, git mv x requirements.txt, git rm .pinright.json:
      // the content comes from another commit, which the hook cannot read.
      if (/^(checkout|restore|mv|rm|reset|switch)$/.test(pos[0] ?? '')) {
        for (const f of pos.slice(1)) if (isGuardedFile(path.resolve(ctx.cwd, f))) shellWrite(f, pos[0] === 'rm' ? '' : undefined, false, ctx, src);
      }
      return;
    }
    default: {
      // "$PYTHON -m pytest", "$(VENV)/bin/python -u -m pip install x": only a Python interpreter takes -m <module>,
      // so read it as one; the module decides whether anything is installed.
      const m = words.indexOf('-m');
      if (isDynamic(words[0]) && m > 0 && words[m + 1] && words.slice(1, m).every((w) => w.startsWith('-'))) {
        return manager(['python', ...words.slice(1)], c, ctx, depth, src, stdin);
      }
      // "$VCPKG_ROOT/vcpkg install": the folder is a variable, the program is not.
      if (isDynamic(bin) && looksLikeInstall(words)) {
        out.push(unverifiable('npm', 'dynamic', 'the program to run comes from a variable or a substitution; pinright cannot see what it installs.', src));
      }
      return;
    }
  }

  /** npx, npm exec and bun x run a bin the project already installed ("npx tsc" with typescript); dlx always downloads. */
  function npx(pos: string[], flags: Map<string, string[]>, local = true) {
    const pkgs = all(flags, '-p', '--package');
    for (const script of all(flags, '-c', '--call')) walk(script, ctx, depth + 1);
    if (pkgs.length) {
      npm(pkgs, true);
      return thenRun(pos[0] ?? '', pos.slice(1));
    }
    if (!pos[0]) return;
    // npx --no-install / --no runs only what is installed and fails otherwise: nothing reaches the registry.
    if (local && (flags.has('--no-install') || flags.has('--no'))) return thenRun(pos[0], pos.slice(1));
    // "tsc@5", "@scope/x@1": a pinned version goes through the registry even when a bin is installed.
    const pinned = /^(@[^/@]+\/)?[^@]+@/.test(pos[0]);
    if (local && !pinned && hasLocalBin(ctx, pos[0])) return thenRun(pos[0], pos.slice(1));
    npm([pos[0]], true);
    thenRun(packageBin(pos[0]), pos.slice(1));
  }
  function uvx(pos: string[], flags: Map<string, string[]>) {
    const from = first(flags, '--from');
    if (from) py([uvToolSpec(from)], true);
    else if (pos[0]) py([uvToolSpec(pos[0])], true);
    if (pos[0]) thenRun(pos[0].replace(/[=<>@[].*$/, ''), pos.slice(1));
  }
  function poetrySpecs(list: string[], executes = false) {
    for (const s of list) {
      // poetry and pdm take "name@^1.2" as well as "name>=1.2".
      const k = pySpecKind(s.replace(/^([A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[^\]]*\])?)@(?=[\^~<>=!*\d]|latest)/, '$1'));
      push('pypi', k.kind === 'package' && /^[\^~*\d]/.test(k.spec ?? '') ? { ...k, spec: k.spec } : k, executes, s);
    }
  }
  function pipSources(flags: Map<string, string[]>, _tool: string) {
    for (const u of all(flags, '-i', '--index-url', '--extra-index-url', '--index', '--default-index')) registry('pypi', u);
    for (const u of all(flags, '-f', '--find-links')) if (!isLocalLinks(u)) registry('pypi', u);
    for (const h of all(flags, '--trusted-host')) out.push(unverifiable('pypi', h, `--trusted-host ${h} turns off TLS checks for that host; pinright cannot vouch for it.`, src));
    const pipArgs = first(flags, '--pip-args');
    if (pipArgs) {
      const inner = parseArgs(pipArgs.split(/\s+/), 'pip').flags;
      for (const u of all(inner, '-i', '--index-url', '--extra-index-url')) registry('pypi', u);
    }
  }
  /** pip install -r file, nested -r, and the lines that switch the index or pull from VCS. */
  function requirements(file: string | undefined, from = ctx.cwd, level = 0) {
    if (!file || level > 5) return;
    if (isDynamic(file)) return dynamic('pypi');
    if (/^https?:/.test(file)) return flag('pypi', `-r ${file}`);
    const abs = path.resolve(from, file);
    if (ctx.followed.has(abs)) return;
    ctx.followed.add(abs);
    const content = ctx.readFile(abs);
    if (!content) return;
    for (const line of content.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
      const l = line.replace(/(^|\s)#.*/, '').trim();
      if (!l) continue;
      const opt = l.match(/^(-r|--requirement|-c|--constraint|-e|--editable|-i|--index-url|--extra-index-url|-f|--find-links|--trusted-host)(?:\s+|=)(\S+)/);
      if (opt) {
        if (opt[1] === '-r' || opt[1] === '--requirement') requirements(opt[2], path.dirname(abs), level + 1);
        else if (opt[1] === '-e' || opt[1] === '--editable') {
          if (pySpecKind(opt[2]).kind !== 'local') push('pypi', pySpecKind(opt[2]), false, opt[2]);
        } else if (opt[1] === '--trusted-host') out.push(unverifiable('pypi', opt[2], `${path.basename(abs)}: --trusted-host ${opt[2]} turns off TLS checks for that host.`, src));
        else if (opt[1] !== '-c' && opt[1] !== '--constraint' && !(/^(-f|--find-links)$/.test(opt[1]) && isLocalLinks(opt[2]))) registry('pypi', opt[2]);
        continue;
      }
      if (l.startsWith('-')) continue;
      py([l.replace(/\s+--\S+.*$/, '')]);
    }
  }
  /** make/just: the recipe lines of the requested targets (the first one by default) and what they depend on. */
  function recipes(dir: string, names: string[], targets: string[], ruleRe: RegExp, given?: [string, string][]) {
    let content: string | undefined;
    let file = '';
    for (const n of names) {
      file = path.join(dir, n);
      content = ctx.readFile(file);
      if (content !== undefined) break;
    }
    if (content === undefined) return;
    // Make variables ($(PYTHON), ${PIP}, $(MAKE)) are make's, not the shell's: the ones the Makefile (or the
    // command line) sets are expanded as make would; the rest stay unknown, so an install through one stays
    // unverifiable. justfiles (given undefined) have no such syntax.
    const makeVars = given ? new Map<string, string>([['MAKE', 'make']]) : undefined;
    const expandMake = (s: string, level = 0): string =>
      makeVars
        ? s.replace(/\$\$|\$\(([A-Za-z_][\w.]*)\)|\$\{([A-Za-z_][\w.]*)\}/g, (m, a, b) => {
          if (m === '$$') return '\0';
          const v = makeVars.get(a ?? b);
          return v === undefined || level > 6 ? m : expandMake(v, level + 1);
        })
        : s;
    const rules = new Map<string, { deps: string[]; body: string[] }>();
    let order: string[] = [];
    let current: { deps: string[]; body: string[] } | undefined;
    const lines = content.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
    if (makeVars) {
      for (const raw of lines) {
        const v = /^(?:export\s+|override\s+)*([A-Za-z_][\w.]*)\s*(\?|:{1,3}|\+|!)?=\s*(.*?)\s*$/.exec(raw);
        if (!v || v[2] === '!') continue; // != runs a shell command: its value is unknown
        if (v[2] === '?' && makeVars.has(v[1]) && v[1] !== 'MAKE') continue;
        makeVars.set(v[1], v[2] === '+' && makeVars.has(v[1]) ? `${makeVars.get(v[1])} ${v[3]}` : v[3]);
      }
      for (const [k, v] of given ?? []) makeVars.set(k, v);
    }
    for (const raw of lines) {
      if (/^(\t| {2,})/.test(raw) && current) {
        current.body.push(expandMake(raw.trim().replace(/^[@+-]+/, '')).replace(/\$\$/g, '$').replace(/\0/g, '$'));
        continue;
      }
      const m = raw.match(ruleRe);
      if (m && !/^\s*(export|include|ifeq|ifneq|ifdef|ifndef|else|endif|define|set|alias)\b/.test(raw)) {
        const deps = raw.slice(raw.indexOf(':') + 1).split(/[\s;]+/).filter((d) => d && !d.includes('='));
        current = { deps, body: [] };
        for (const t of m[1].trim().split(/\s+/)) {
          rules.set(t, current);
          if (!t.startsWith('.')) order = [...order, t];
        }
        // make "target: deps ; command" keeps a recipe on the same line.
        const inline = raw.split(';').slice(1).join(';').trim();
        if (inline) current.body.push(inline);
      } else if (!/^\s/.test(raw)) current = undefined;
    }
    const run = (t: string, level: number) => {
      // Each target is read once per command line, also when a recipe runs make again ($(MAKE) other):
      // that bounds the recursion, so a recipe's lines stay at this depth and a long chain of
      // sub-makes (nodejs/node's coverage targets) is read to the end instead of "nests too deep".
      const key = `${file}#${t}`;
      if (ctx.followed.has(key) || level > 8) return;
      ctx.followed.add(key);
      const r = rules.get(t);
      if (!r) return;
      for (const d of r.deps) run(d, level + 1);
      for (const line of r.body) walk(line, { ...ctx, cwd: dir } as Ctx, depth);
    };
    for (const t of targets.length ? targets : order.slice(0, 1)) run(t, 0);
  }
}

/** uvx and uv tool take "ruff@0.6.0" and "ruff@latest" for a version; a PEP 508 "name @ url" has a URL after the @. */
function uvToolSpec(s: string): string {
  const m = /^([A-Za-z0-9][\w.-]*(?:\[[^\]]*\])?)@([\w.!+-]+)$/.exec(s);
  return m ? (m[2] === 'latest' ? m[1] : `${m[1]}==${m[2]}`) : s;
}

/** package.json value set by `npm pkg set dependencies.x=1`. */
function npmSpecKindFromValue(name: string, value: string): SpecKind {
  const k = npmSpecKind(`${name}@${value}`);
  return k.kind === 'package' ? { kind: 'package', name, spec: value || undefined } : k;
}

/**
 * composer require vendor/pkg[:constraint] (also "=constraint", or the constraint
 * as the next argument) and composer create-project vendor/pkg [dir] [version].
 */
export function composerIntents(pos: string[], src: string): DepIntent[] {
  const out: DepIntent[] = [];
  if (pos[0] === 'create-project' && pos[1]?.includes('/')) {
    const [name, inline] = pos[1].split(/[:=]/);
    out.push({ ecosystem: 'composer', name: name.toLowerCase(), spec: inline || pos[3], source: src, executes: true });
    return out;
  }
  if (pos[0] !== 'require' && pos[0] !== 'req' && pos[0] !== 'r') return out;
  const args = pos.slice(1);
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (isDynamic(a)) {
      out.push(unverifiable('composer', 'dynamic', 'a package name comes from a variable or a substitution pinright cannot resolve; name the package in the command.', src));
      continue;
    }
    if (!a.includes('/')) continue;
    const [raw, inline] = a.split(/[:= ](.*)/s);
    const name = raw.trim().toLowerCase();
    if (isPlatformPackage(name) || /^(\.{0,2}\/|[a-z]:\\|https?:|git)/i.test(name)) continue;
    let spec = inline?.trim() || undefined;
    if (!spec && args[k + 1] && !args[k + 1].includes('/') && /^[\^~<>=!*v\d]/.test(args[k + 1])) spec = args[++k];
    out.push({ ecosystem: 'composer', name, spec, source: src });
  }
  return out;
}

export { DYNAMIC };
