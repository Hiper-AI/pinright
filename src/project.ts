/**
 * The project the agent is working on. Agents rarely pass the version their
 * project uses, so the server finds it: the roots the MCP client announces,
 * else PINRIGHT_PROJECT_DIR, else the working directory (Claude Code and Cursor
 * launch stdio servers in the project). From each root it reads the dependency
 * files nearby (the root, the nearest parent with one, and subprojects a few
 * levels down for monorepos) and answers "which version of X is installed".
 *
 * Only dependency files are read. Parsed files are cached in memory until
 * their mtime changes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Server } from '@modelcontextprotocol/server';
import { getPackage } from './advisories/depsdev.js';
import { applyCooldownDays } from './config.js';
import { type Ecosystem } from './ecosystems.js';
import { loadTeamConfig, type Policy, resolvePolicy } from './teamConfig.js';
import { normalizePypiName, parseFile, type ParsedTree } from './tree/lockfiles.js';
import { pickVersion } from './tree/resolveManifest.js';
import { readProjectFile } from './projectFile.js';
import { manifestsIn, readSiblings } from './tree/discover.js';

export { manifestsIn, readSiblings };

/** Directories never searched for subprojects: dependencies, build output, VCS and tool state. */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'venv', 'env', '__pycache__', 'coverage', 'bower_components', 'site-packages',
]);
const MAX_DEPTH = 3;
const MAX_DIRS = 40;
const DISCOVERY_TTL_MS = 10_000;

export interface Installed {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** The file it was read from, relative to the project root ("web/package-lock.json"). */
  file: string;
  /** lockfile: exact; node_modules: what is on disk; pin: exact in a manifest; range: what the manifest's range resolves to today. */
  source: 'lockfile' | 'node_modules' | 'pin' | 'range';
  /** The manifest's range, for source "range". */
  spec?: string;
  direct: boolean;
  /** Other versions of the same package elsewhere in the project ("17.0.2 (api/package-lock.json)"). */
  others?: string[];
}

interface DirEntry {
  ecosystem: Ecosystem;
  name: string;
  version?: string;
  spec?: string;
  source: Installed['source'];
  file: string;
  direct: boolean;
}

interface ParsedDir {
  sig: string;
  entries: Map<string, DirEntry>;
}

/** A glob from a .gitignore line as a regex source: `*` and `?` stay within one path segment, `**` crosses them. */
function globSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '\\' && i + 1 < glob.length) out += glob[++i].replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    else if (c === '[' && glob.indexOf(']', i + 2) > i) {
      const end = glob.indexOf(']', i + 2);
      const body = glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
      out += `[${body}]`;
      i = end;
    } else out += c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  }
  return out;
}

/** The rules of `dir/.gitignore`, each matching a folder path relative to `dir`. */
function gitignoreRules(dir: string): { negate: boolean; re: RegExp }[] {
  let text: string;
  try {
    text = readProjectFile(path.join(dir, '.gitignore'), { root: dir, maxBytes: 1_000_000 });
  } catch {
    return [];
  }
  const rules: { negate: boolean; re: RegExp }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    line = line.replace(/^\\(?=[#!])/, '').replace(/\/+$/, '');
    if (!line) continue;
    // A pattern with a slash is relative to the .gitignore's folder; one without matches at any depth.
    const anchored = line.includes('/');
    line = line.replace(/^\/+/, '');
    try {
      rules.push({ negate, re: new RegExp(`${anchored ? '^' : '(?:^|/)'}${globSource(line)}$`) });
    } catch {
      // a pattern this reader cannot express: skip it
    }
  }
  return rules;
}

/**
 * Does a .gitignore between `base` and `root` (in `base` or a folder under it, above `root`) ignore
 * `root` or one of its parents below `base`? Git's rules: the deeper file and the later line win, and
 * nothing inside an ignored folder can be re-included.
 */
export function ignoredBelow(base: string, root: string): boolean {
  const rel = path.relative(base, root);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  const rules: { negate: boolean; re: RegExp; depth: number }[] = [];
  for (let i = 0; i < parts.length; i++) {
    rules.push(...gitignoreRules(path.join(base, ...parts.slice(0, i))).map((r) => ({ ...r, depth: i })));
    let ignored = false;
    for (const r of rules) if (r.re.test(parts.slice(r.depth, i + 1).join('/'))) ignored = !r.negate;
    if (ignored) return true;
  }
  return false;
}

const keyOf = (eco: Ecosystem, name: string) => `${eco}:${eco === 'pypi' ? normalizePypiName(name) : name}`;

/** What one dependency file says about each package. */
function entriesOf(tree: ParsedTree, file: string, dir: string): DirEntry[] {
  const eco = tree.ecosystem;
  const out: DirEntry[] = [];
  if (tree.kind === 'lockfile') {
    // Direct dependencies first so they win over a transitive copy of the same name.
    const isDirect = (p: (typeof tree.packages)[number]) => Boolean(p.direct) || p.path?.length === 1;
    const sorted = [...tree.packages].sort((a, b) => Number(isDirect(b)) - Number(isDirect(a)));
    for (const p of sorted) out.push({ ecosystem: eco, name: p.name, version: p.version, source: 'lockfile', file, direct: isDirect(p) });
    return out;
  }
  for (const d of tree.declared ?? []) {
    let version: string | undefined;
    let source: DirEntry['source'] = 'range';
    if (eco === 'npm') {
      // No lockfile, but node_modules may still say what is installed.
      try {
        const pj = JSON.parse(readProjectFile(path.join(dir, 'node_modules', d.name, 'package.json'), { root: dir, maxBytes: 1_000_000 }));
        if (typeof pj.version === 'string') {
          version = pj.version;
          source = 'node_modules';
        }
      } catch {
        // not installed
      }
    }
    if (!version) {
      const exact = d.spec.trim().match(/^(?:==|=)?\s*v?(\d+(?:\.\d+)+(?:[-+.][0-9A-Za-z.-]+)?)$/);
      // A bare "1.2" in Cargo.toml is a range; elsewhere an exact version pins.
      if (exact && !(eco === 'cargo' && !d.spec.trim().startsWith('='))) {
        version = exact[1];
        source = 'pin';
      }
    }
    out.push({ ecosystem: eco, name: d.name, version, spec: d.spec, source, file, direct: true });
  }
  return out;
}

export class Project {
  private announced: string[] | undefined;
  private pending: Promise<unknown> | undefined;
  private discovered = new Map<string, { at: number; dirs: string[] }>();
  private parsed = new Map<string, ParsedDir>();

  /** Roots from the MCP client. An empty list falls back to env / cwd. */
  setRoots(dirs: string[]): void {
    this.announced = dirs.length ? dirs.map((d) => path.resolve(d)) : undefined;
    this.discovered.clear();
  }

  /** A roots/list request in flight: lookups wait for it (briefly) so the first call already sees the project. */
  waitFor(p: Promise<unknown>): void {
    this.pending = p.finally(() => {
      if (this.pending === p) this.pending = undefined;
    });
  }

  roots(): string[] {
    if (this.announced) return this.announced;
    const env = process.env.PINRIGHT_PROJECT_DIR;
    if (env) return env.split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
    return [process.cwd()];
  }

  private async ready(): Promise<void> {
    if (!this.pending) return;
    await Promise.race([this.pending.catch(() => undefined), new Promise((r) => setTimeout(r, 2000).unref())]);
  }

  /** The root itself (or its nearest parent with dependency files), then subprojects breadth-first. */
  dirsOf(root: string): string[] {
    const hit = this.discovered.get(root);
    if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.dirs;
    const dirs: string[] = [];
    let base = root;
    if (!manifestsIn(root).length) {
      // Launched from a subfolder: the nearest parent with dependency files, up to the repo root. Not a
      // parent that ignores the folder in its .gitignore (scratch space, generated output, a benchmark's
      // run folders: the folder is not part of that project), and never the home directory itself.
      const home = path.resolve(os.homedir());
      for (let cur = root; ; ) {
        if (manifestsIn(cur).length) {
          if (!ignoredBelow(cur, root)) base = cur;
          break;
        }
        const up = path.dirname(cur);
        if (fs.existsSync(path.join(cur, '.git')) || cur === home || up === home || up === cur) break;
        cur = up;
      }
    }
    const queue: [string, number][] = [[base, 0]];
    if (base !== root) queue.push([root, 0]);
    const seen = new Set<string>();
    while (queue.length && dirs.length < MAX_DIRS) {
      const [dir, depth] = queue.shift() as [string, number];
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (manifestsIn(dir).length) dirs.push(dir);
      if (depth >= MAX_DEPTH) continue;
      let children: fs.Dirent[] = [];
      try {
        children = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const c of children) {
        if (!c.isDirectory() || c.name.startsWith('.') || SKIP_DIRS.has(c.name)) continue;
        queue.push([path.join(dir, c.name), depth + 1]);
      }
    }
    this.discovered.set(root, { at: Date.now(), dirs });
    return dirs;
  }

  private parse(dir: string, root: string): ParsedDir {
    const files = manifestsIn(dir);
    // Siblings count too: yarn.lock and the TOML locks read package.json / pyproject.toml / Cargo.toml.
    const watched = [...new Set([...files, ...['package.json', 'pyproject.toml', 'Cargo.toml'].map((s) => path.join(dir, s))])];
    const sig = watched
      .map((f) => {
        try {
          const s = fs.statSync(f);
          return `${f}:${s.mtimeMs}:${s.size}`;
        } catch {
          return `${f}:-`;
        }
      })
      .join('|');
    const hit = this.parsed.get(dir);
    if (hit && hit.sig === sig) return hit;
    const entries = new Map<string, DirEntry>();
    for (const f of files) {
      const rel = path.relative(root, f).split(path.sep).join('/') || path.basename(f);
      try {
        const tree = parseFile(f, readProjectFile(f), readSiblings(f));
        for (const e of entriesOf(tree, rel, dir)) {
          const k = keyOf(e.ecosystem, e.name);
          if (!entries.has(k)) entries.set(k, e);
        }
      } catch {
        // A malformed file contributes nothing; check-manifest reports parse errors.
      }
    }
    const result = { sig, entries };
    this.parsed.set(dir, result);
    return result;
  }

  /**
   * The team policy of `dir` (a path given to a tool), else of the first root
   * that has a .pinright.json, merged with env. An unreadable file comes back as
   * `error` with the env-only policy, so the tools can say so instead of acting
   * as if there were no policy.
   */
  async policy(dir?: string): Promise<{ policy: Policy; error?: string }> {
    await this.ready();
    const from = dir ? [fs.existsSync(dir) && !fs.statSync(dir).isDirectory() ? path.dirname(dir) : dir] : this.roots();
    for (const root of from) {
      const team = loadTeamConfig(root);
      if (!team.file) continue;
      if (team.error) return { policy: resolvePolicy(undefined, process.env, team.file), error: team.error };
      const policy = resolvePolicy(team.config, process.env, team.file);
      applyCooldownDays(policy.cooldownDays);
      return { policy };
    }
    return { policy: resolvePolicy() };
  }

  /** Every dependency file the project has, for messages and tests. */
  async files(): Promise<string[]> {
    await this.ready();
    return this.roots().flatMap((r) => this.dirsOf(r).flatMap((d) => manifestsIn(d)));
  }

  /**
   * The version of a package the project uses: exact from a lockfile or
   * node_modules, else what the manifest's range resolves to today.
   */
  async installed(eco: Ecosystem, name: string): Promise<Installed | undefined> {
    await this.ready();
    const k = keyOf(eco, name);
    const found: DirEntry[] = [];
    for (const root of this.roots()) {
      for (const dir of this.dirsOf(root)) {
        const e = this.parse(dir, root).entries.get(k);
        if (e) found.push(e);
      }
    }
    if (!found.length) return undefined;
    const resolved: (DirEntry & { version: string })[] = [];
    for (const e of found) {
      let version = e.version;
      if (!version && e.spec !== undefined) {
        const pkg = await getPackage(eco, e.name).catch(() => undefined);
        version = pkg ? pickVersion(eco, e.spec, pkg.versions) : undefined;
      }
      if (version) resolved.push({ ...e, version });
    }
    // Exact sources first; then the order the directories were found in (the root first).
    const rank = { lockfile: 0, node_modules: 0, pin: 1, range: 2 } as const;
    resolved.sort((a, b) => rank[a.source] - rank[b.source] || Number(b.direct) - Number(a.direct));
    const best = resolved[0];
    if (!best) return undefined;
    const others = [...new Set(resolved.filter((e) => e.version !== best.version).map((e) => `${e.version} (${e.file})`))];
    return {
      ecosystem: eco,
      name: best.name,
      version: best.version,
      file: best.file,
      source: best.source,
      spec: best.spec,
      direct: best.direct,
      others: others.length ? others : undefined,
    };
  }
}

/** One line for the agent: which version is being used and why. */
export function describeInstalled(i: Installed): string {
  const others = i.others?.length ? ` Other versions in this project: ${i.others.slice(0, 3).join(', ')}.` : '';
  switch (i.source) {
    case 'range':
      return `Using ${i.name} ${i.version}, what "${i.spec}" in ${i.file} resolves to today (no lockfile).${others}`;
    case 'node_modules':
      return `Using ${i.name} ${i.version}, installed in this project (node_modules; declared in ${i.file}).${others}`;
    default:
      return `Using ${i.name} ${i.version}, ${i.direct ? 'installed' : 'installed as a transitive dependency'} in this project (${i.file}).${others}`;
  }
}

/**
 * Follow the client's roots: ask once the session is initialized and again on
 * roots/list_changed. Clients without the roots capability keep env / cwd.
 */
export function watchRoots(server: Server, project: Project): void {
  const refresh = () => {
    if (!server.getClientCapabilities()?.roots) return;
    const p = server
      .listRoots()
      .then(({ roots }) => project.setRoots(roots.map((r) => r.uri).filter((u) => u.startsWith('file:')).map((u) => fileURLToPath(u))))
      .catch(() => undefined); // a client that announced roots but fails to list them: keep the fallback
    project.waitFor(p);
  };
  const previous = server.oninitialized;
  server.oninitialized = () => {
    previous?.();
    refresh();
  };
  server.setNotificationHandler('notifications/roots/list_changed', async () => refresh());
}
