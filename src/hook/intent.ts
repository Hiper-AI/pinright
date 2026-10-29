/**
 * What an agent is about to add: dependency intents extracted from a shell
 * command (npm install, pip install, cargo add, go get, npx...) or from the new
 * content of a manifest it is writing. Only additions and version changes count,
 * so editing an old project does not re-litigate dependencies it already had.
 */
import path from 'node:path';
import { type Ecosystem } from '../ecosystems.js';
import { normalizePypiName, parseFile, detectKind } from '../tree/lockfiles.js';

export interface DepIntent {
  ecosystem: Ecosystem;
  name: string;
  /** Exact version, a range, or undefined for "whatever is newest". */
  spec?: string;
  /** Where it came from, for the message: the command or the file. */
  source: string;
  /** npx / uvx / pipx run: the package is executed, not just installed. */
  executes?: boolean;
  /** An unchanged line of the manifest: not judged, only used to check version compatibility. */
  contextOnly?: boolean;
}

/** Split a command line into simple commands and tokens, honoring quotes. */
export function splitCommands(cmd: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let tok = '';
  let quote: string | undefined;
  const push = () => {
    if (tok) cur.push(tok);
    tok = '';
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else tok += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === ' ' || c === '\t') push();
    else if (c === '\n' || c === ';' || c === '|' || c === '&') {
      push();
      if (cur.length) out.push(cur);
      cur = [];
    } else tok += c;
  }
  push();
  if (cur.length) out.push(cur);
  return out;
}

const SKIP_SPEC = /^(\.{0,2}\/|[a-z]:\\|file:|link:|git\+|git:|https?:|github:|gitlab:|bitbucket:|workspace:)|\.(tgz|tar\.gz|whl|zip)$/i;

/** "@scope/name@^1.2" -> ["@scope/name", "^1.2"]; "name" -> ["name", undefined] */
export function splitNpmSpec(spec: string): [string, string | undefined] {
  const at = spec.lastIndexOf('@');
  if (at > 0) return [spec.slice(0, at), spec.slice(at + 1) || undefined];
  return [spec, undefined];
}

/** "requests[socks]==2.31.0" -> ["requests", "==2.31.0"] */
export function splitPySpec(spec: string): [string, string | undefined] | undefined {
  const m = spec.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]*\])?\s*(.*)$/);
  if (!m) return undefined;
  return [normalizePypiName(m[1]), m[2].split(';')[0].trim() || undefined];
}

/** Options that take a value in each tool, so the value is not mistaken for a package. */
const VALUE_FLAGS = new Set([
  '-r', '--requirement', '-c', '--constraint', '-i', '--index-url', '--extra-index-url', '-t', '--target', '-e', '--editable',
  '--registry', '--prefix', '-C', '--cwd', '--dir', '--filter', '-w', '--workspace', '--python', '-p', '--group',
  '--vers', '--version', '-v', '--features', '-F', '--source', '--rev', '--branch', '--tag', '--package',
]);

function positional(args: string[]): { positional: string[]; flags: Map<string, string> } {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      const [k, v] = a.split('=');
      if (v !== undefined) flags.set(k, v);
      else if (VALUE_FLAGS.has(k)) flags.set(k, args[++i] ?? '');
      else flags.set(k, '');
    } else pos.push(a);
  }
  return { positional: pos, flags };
}

export function fromCommand(command: string, cwd: string, readFile: (p: string) => string | undefined): DepIntent[] {
  const out: DepIntent[] = [];
  for (let tokens of splitCommands(command)) {
    // Drop env assignments and wrappers: "FOO=1 sudo npm i x".
    while (tokens.length && (/^[A-Z_][A-Z0-9_]*=/.test(tokens[0]) || ['sudo', 'time', 'exec', 'env'].includes(tokens[0]))) tokens = tokens.slice(1);
    if (!tokens.length) continue;
    let [bin, ...rest] = tokens;
    bin = path.basename(bin).replace(/\.(cmd|exe|ps1)$/i, '').toLowerCase();
    const src = tokens.join(' ').slice(0, 200);
    const npm = (specs: string[], executes = false) => {
      for (const s of specs) {
        if (SKIP_SPEC.test(s)) continue;
        // "user/repo" without a scope is a GitHub shorthand, not a registry package.
        if (!s.startsWith('@') && s.includes('/')) continue;
        const [name, spec] = splitNpmSpec(s);
        out.push({ ecosystem: 'npm', name, spec, source: src, executes });
      }
    };
    const py = (specs: string[], executes = false) => {
      for (const s of specs) {
        if (SKIP_SPEC.test(s) || s === '.') continue;
        const p = splitPySpec(s);
        if (p) out.push({ ecosystem: 'pypi', name: p[0], spec: p[1], source: src, executes });
      }
    };
    const reqFile = (file: string | undefined) => {
      if (!file) return;
      const content = readFile(path.resolve(cwd, file));
      if (!content) return;
      for (const line of content.split(/\r?\n/)) {
        const l = line.replace(/#.*/, '').trim();
        if (l && !l.startsWith('-')) py([l]);
      }
    };

    if (bin === 'python' || bin === 'python3' || bin === 'py') {
      if (rest[0] === '-m' && rest[1] === 'pip') [bin, ...rest] = ['pip', ...rest.slice(2)];
      else continue;
    }
    if ((bin === 'uv' && rest[0] === 'pip') || (bin === 'uv' && rest[0] === 'tool' && rest[1] === 'install')) {
      bin = 'pip';
      rest = rest.slice(rest[0] === 'tool' ? 1 : 1);
    }
    if (bin === 'npm' && ['exec', 'x'].includes(rest[0])) [bin, ...rest] = ['npx', ...rest.slice(1)];
    if ((bin === 'pnpm' || bin === 'yarn') && rest[0] === 'dlx') [bin, ...rest] = ['npx', ...rest.slice(1)];

    const { positional: pos, flags } = positional(rest);
    switch (bin) {
      case 'npm':
      case 'pnpm':
      case 'yarn':
      case 'bun':
        if (['install', 'i', 'add', 'in', 'isntall', 'ins', 'inst', 'insta', 'instal'].includes(pos[0] ?? '')) npm(pos.slice(1));
        else if (bin === 'yarn' && pos[0] === 'global' && pos[1] === 'add') npm(pos.slice(2));
        break;
      case 'npx':
      case 'pnpx':
      case 'bunx': {
        const pkg = flags.get('--package') ?? flags.get('-p') ?? pos[0];
        if (pkg) npm([pkg], true);
        break;
      }
      case 'pip':
      case 'pip3':
      case 'pipenv':
        if (pos[0] === 'install') {
          py(pos.slice(1));
          reqFile(flags.get('-r') ?? flags.get('--requirement'));
        }
        break;
      case 'uv':
      case 'poetry':
      case 'pdm':
        if (pos[0] === 'add') py(pos.slice(1));
        break;
      case 'uvx':
      case 'pipx':
        if (bin === 'uvx' && pos[0]) py([pos[0]], true);
        else if (pos[0] === 'run' && pos[1]) py([pos[1]], true);
        else if (pos[0] === 'install' && pos[1]) py([pos[1]]);
        break;
      case 'cargo':
        if (pos[0] === 'add' || pos[0] === 'install') {
          for (const s of pos.slice(1)) {
            const [name, spec] = splitNpmSpec(s);
            out.push({ ecosystem: 'cargo', name, spec: spec ?? flags.get('--vers') ?? flags.get('--version'), source: src, executes: pos[0] === 'install' });
          }
        }
        break;
      case 'go':
        if (pos[0] === 'get' || pos[0] === 'install') {
          for (const s of pos.slice(1)) {
            if (s.startsWith('.') || !s.includes('.')) continue;
            const [mod, spec] = splitNpmSpec(s);
            if (spec === 'none') continue;
            out.push({ ecosystem: 'go', name: mod.replace(/\/\.\.\.$/, ''), spec: spec === 'latest' ? undefined : spec?.replace(/^v/, ''), source: src });
          }
        }
        break;
      case 'gem':
        if (pos[0] === 'install') for (const s of pos.slice(1)) out.push({ ecosystem: 'rubygems', name: s, spec: flags.get('-v') ?? flags.get('--version'), source: src });
        break;
      case 'bundle':
        if (pos[0] === 'add' && pos[1]) out.push({ ecosystem: 'rubygems', name: pos[1], spec: flags.get('--version') ?? flags.get('-v'), source: src });
        break;
      case 'dotnet':
        if (pos[0] === 'add' && pos[1] === 'package' && pos[2]) out.push({ ecosystem: 'nuget', name: pos[2], spec: flags.get('--version') ?? flags.get('-v'), source: src });
        break;
      default:
        break;
    }
  }
  return out;
}

const WATCHED = /(^|[\\/])(package\.json|requirements[^\\/]*\.(txt|in)|pyproject\.toml|Cargo\.toml|go\.mod)$/i;

export function isWatchedFile(file: string): boolean {
  return WATCHED.test(file) && !/node_modules/.test(file);
}

/** Dependencies added or re-versioned by a write, comparing against the file on disk. */
export function fromFileWrite(file: string, newContent: string, oldContent: string | undefined): DepIntent[] {
  if (!isWatchedFile(file) || !detectKind(file)) return [];
  const declared = (content: string | undefined) => {
    if (!content) return new Map<string, string>();
    try {
      const t = parseFile(path.basename(file), content);
      const list = t.declared ?? t.packages.map((p) => ({ name: p.name, spec: p.version }));
      return new Map(list.map((d) => [d.name, d.spec]));
    } catch {
      return new Map<string, string>();
    }
  };
  const before = declared(oldContent);
  const after = declared(newContent);
  const eco = parseFileEcosystem(file);
  const out: DepIntent[] = [];
  const context: DepIntent[] = [];
  for (const [name, spec] of after) {
    if (eco === 'npm' && SKIP_SPEC.test(spec)) continue;
    const intent = { ecosystem: eco, name, spec: spec || undefined, source: path.basename(file) };
    if (before.has(name) && before.get(name) === spec) context.push({ ...intent, contextOnly: true });
    else out.push(intent);
  }
  // Nothing changed: nothing to check. Otherwise the unchanged lines come along as context.
  return out.length ? [...out, ...context] : [];
}

function parseFileEcosystem(file: string): Ecosystem {
  if (/package\.json$/i.test(file)) return 'npm';
  if (/Cargo\.toml$/i.test(file)) return 'cargo';
  if (/go\.mod$/i.test(file)) return 'go';
  return 'pypi';
}
