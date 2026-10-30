/**
 * Dependencies a write adds, comparing the new content with the file on disk.
 * Only additions and version changes count, so editing an old project does not
 * re-litigate dependencies it already had.
 *
 * Besides the manifests, the hook guards what changes where packages come from
 * (lockfiles, registry and index settings) and its own configuration (the team
 * policy and the agent's hook settings): an agent that rewrites those does not
 * need to run an install for the next one to pull something unchecked.
 */
import path from 'node:path';
import { type Ecosystem } from '../ecosystems.js';
import { normalizePypiName, parseFile, detectKind } from '../tree/lockfiles.js';
import { customHosts, type DepIntent, isCustomRegistry, npmValueKind, pySpecKind, type SpecKind, unverifiable } from './spec.js';

const MANIFEST =
  /(^|[\\/])(package\.json|requirements[^\\/]*\.(txt|in)|[^\\/]*-requirements\.(txt|in)|requirements[\\/][^\\/]+\.(txt|in)|constraints[^\\/]*\.txt|pyproject\.toml|Pipfile|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|libs\.versions\.toml|composer\.json|Gemfile|deno\.jsonc?|pnpm-workspace\.yaml)$/i;
const LOCKFILE =
  /(^|[\\/])(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|packages\.lock\.json|gradle\.lockfile)$/i;
/** Where packages come from, or code that rewrites what gets installed. */
const SOURCES =
  /(^|[\\/])(\.npmrc|\.yarnrc(\.yml)?|bunfig\.toml|pip\.conf|pip\.ini|uv\.toml|\.condarc|\.gemrc|nuget\.config|\.cargo[\\/]config(\.toml)?|\.pnpmfile\.c?js|package\.yaml|package\.json5)$/i;
/** The hook's own configuration. */
const GUARD = /(^|[\\/])(\.pinright\.json|\.claude[\\/]settings(\.local)?\.json|\.cursor[\\/]hooks\.json)$/i;
const VENDORED = /node_modules|[\\/]vendor[\\/]/;
const REQUIREMENTS = /(requirements[^\\/]*|[^\\/]*-requirements|requirements[\\/][^\\/]+)\.(txt|in)$|constraints[^\\/]*\.txt$/i;
const isRequirements = (file: string) => REQUIREMENTS.test(file);

/** A manifest the hook reads dependencies from. */
export function isWatchedFile(file: string): boolean {
  return MANIFEST.test(file) && !VENDORED.test(file);
}

/** Any file whose change the hook looks at: manifests, lockfiles, registry settings, its own configuration. */
export function isGuardedFile(file: string): boolean {
  return GUARD.test(file) || (!VENDORED.test(file) && (MANIFEST.test(file) || LOCKFILE.test(file) || SOURCES.test(file)));
}

function ecosystemOf(file: string): Ecosystem {
  if (/(package\.json5?|package\.yaml|deno\.jsonc?|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc(\.yml)?|bunfig\.toml|\.pnpmfile\.c?js)$/i.test(file)) return 'npm';
  if (/\.gemrc$/i.test(file)) return 'rubygems';
  if (/nuget\.config$/i.test(file)) return 'nuget';
  if (/\.cargo[\\/]config(\.toml)?$/i.test(file)) return 'cargo';
  if (/Cargo\.(toml|lock)$/i.test(file)) return 'cargo';
  if (/go\.(mod|sum)$/i.test(file)) return 'go';
  if (/(pom\.xml|\.gradle(\.kts)?|libs\.versions\.toml|gradle\.lockfile)$/i.test(file)) return 'maven';
  if (/composer\.(json|lock)$/i.test(file)) return 'composer';
  if (/Gemfile(\.lock)?$/i.test(file)) return 'rubygems';
  if (/packages\.lock\.json$/i.test(file)) return 'nuget';
  return 'pypi';
}

const lines = (s: string | undefined) => (s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
/** Lines of `next` that are not in `old`. */
const addedLines = (next: string, old: string | undefined) => {
  const before = new Set(lines(old));
  return lines(next).filter((l) => !before.has(l));
};

/**
 * Dependencies added or re-versioned by a write. `newContent` undefined means the write
 * happens but its result cannot be computed (sed -i, a download, a copy from an unknown file).
 * `siblings` carries what a build script resolves from other files (libs.versions.toml, gradle.properties).
 */
export function fromFileWrite(file: string, newContent: string | undefined, oldContent: string | undefined, siblings: Record<string, string> = {}): DepIntent[] {
  const base = path.basename(file);
  const eco = ecosystemOf(file);
  if (GUARD.test(file)) return guardChange(file, newContent, oldContent);
  if (!isGuardedFile(file)) return [];
  if (newContent === undefined) return [unverifiable(eco, base, `changes ${base} in a way pinright cannot read; check the file after the command runs.`, base)];
  if (newContent === oldContent) return [];
  if (SOURCES.test(file)) return sourcesChange(file, newContent, oldContent);
  if (LOCKFILE.test(file)) return lockfileChange(file, newContent, oldContent);
  return manifestChange(file, newContent, oldContent, siblings);
}

/** A declared dependency as the hook compares it: name, spec and how the spec reads. */
interface Entry {
  name: string;
  spec: string;
  kind: SpecKind;
}

/** Everything a manifest declares, including the parts the audit parser leaves out. undefined: it does not parse. */
function declared(file: string, content: string | undefined, siblings: Record<string, string>): Entry[] | undefined {
  if (!content) return [];
  const eco = ecosystemOf(file);
  const out: Entry[] = [];
  const add = (name: string, spec: string, kind?: SpecKind) =>
    out.push({ name, spec, kind: kind ?? (eco === 'npm' ? npmValueKind(name, spec) : { kind: 'package', name, spec: spec || undefined }) });
  const base = path.basename(file);
  try {
    if (/^deno\.jsonc?$/i.test(base)) {
      denoImports(content, add);
      return out;
    }
    if (/^pnpm-workspace\.yaml$/i.test(base)) {
      pnpmWorkspace(content, add);
      return out;
    }
    if (/^Gemfile$/i.test(base)) {
      for (const m of content.matchAll(/^\s*gem\s+["']([^"']+)["']([^\n]*)$/gm)) {
        const rest = m[2];
        const remote = rest.match(/\b(git|github|source)\s*:\s*["']([^"']+)["']|:(git|github|source)\s*=>\s*["']([^"']+)["']/);
        const ver = rest.match(/^\s*,\s*["']([^"']+)["']/);
        add(m[1], ver?.[1] ?? '', remote ? { kind: 'remote', what: `${m[1]}: ${remote[2] ?? remote[4]}` } : { kind: 'package', name: m[1], spec: ver?.[1] });
      }
      return out;
    }
    if (/^Pipfile$/i.test(base)) {
      let on = false;
      for (const line of content.split(/\r?\n/)) {
        const h = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (h) {
          on = /^(dev-)?packages$/i.test(h[1].trim()) || /^[\w-]+$/.test(h[1].trim()) && !/^(source|requires|pipenv|scripts)$/i.test(h[1].trim());
          continue;
        }
        const m = on && line.match(/^\s*["']?([A-Za-z0-9][A-Za-z0-9_.-]*)["']?\s*=\s*(.*)$/);
        if (!m) continue;
        const v = m[2].trim();
        const name = normalizePypiName(m[1]);
        if (/\b(git|file|path)\s*=/.test(v)) add(name, v, /\bpath\s*=/.test(v) ? { kind: 'local' } : { kind: 'remote', what: `${name}: ${v}` });
        else {
          const spec = (v.match(/^["']([^"']*)["']/)?.[1] ?? v.match(/version\s*=\s*["']([^"']*)["']/)?.[1] ?? '').replace(/^\*$/, '');
          add(name, spec, { kind: 'package', name, spec: spec || undefined });
        }
      }
      return out;
    }
    const t = parseFile(base, content, siblings);
    // A fully pinned requirements file reads as a lock with bare versions; keep the "==" so adding one
    // unpinned line (which turns it back into a manifest) does not make every old pin look changed.
    const list = t.declared ?? t.packages.map((p) => ({ name: p.name, spec: t.ecosystem === 'pypi' ? `==${p.version}` : p.version }));
    for (const d of list) {
      // pip options after a requirement ("x==1 --hash=sha256:..") are not part of its spec.
      const spec = eco === 'pypi' ? d.spec.replace(/(^|\s)--\S+/g, '').trim() : d.spec;
      // "x @ https://..." and bare URLs ("git+https://...", read as a package named "git") are not registry packages.
      if (eco === 'pypi' && /^[@+:]|:\/\//.test(spec)) add(d.name, spec, { kind: 'remote', what: `${d.name}${spec}`.slice(0, 120) });
      else add(d.name, spec);
    }
    if (/^package\.json$/i.test(base)) packageJsonExtras(content, add);
    if (/^pyproject\.toml$/i.test(base)) pyprojectExtras(content, add);
  } catch {
    return undefined;
  }
  return out;
}

/** peerDependencies (npm 7+ installs them), overrides, resolutions and pnpm.overrides: they pick versions too. */
function packageJsonExtras(content: string, add: (name: string, spec: string) => void) {
  const pj = JSON.parse(content);
  for (const [name, spec] of Object.entries<string>(pj.peerDependencies ?? {})) add(name, spec);
  const overrides = (o: unknown) => {
    if (!o || typeof o !== 'object') return;
    for (const [key, value] of Object.entries(o as Record<string, unknown>)) {
      // "a>b" (pnpm), "**/b" and "a/b" (yarn) and "b@<2" all target b.
      const target = (key.split('>').pop() as string).replace(/^\*\*\//, '');
      const name = target.match(/((?:@[^/]+\/)?[^/@]+)(@[^/]*)?$/)?.[1] ?? target;
      if (typeof value === 'string') {
        if (value && value !== '.' && name) add(name, value);
      } else if (value && typeof value === 'object') {
        const own = (value as Record<string, unknown>)['.'];
        if (typeof own === 'string' && name) add(name, own);
        overrides(value);
      }
    }
  };
  overrides(pj.overrides);
  overrides(pj.resolutions);
  overrides(pj.pnpm?.overrides);
}

/** The arrays the audit parser does not read: optional dependencies, groups, build requirements, uv's dev lists. */
function pyprojectExtras(content: string, add: (name: string, spec: string, kind?: SpecKind) => void) {
  let table = '';
  const arrays: string[] = [];
  let collecting: string[] | undefined;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    const h = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    if (h && !collecting) {
      table = h[1].trim();
      continue;
    }
    if (collecting) {
      collecting.push(line);
      if (/\]\s*,?\s*$/.test(line.replace(/["'][^"']*["']/g, ''))) {
        arrays.push(collecting.join('\n'));
        collecting = undefined;
      }
      continue;
    }
    const kv = line.match(/^\s*["']?([\w.-]+)["']?\s*=\s*(.*)$/);
    if (!kv) continue;
    const wanted =
      table === 'project.optional-dependencies' || table === 'dependency-groups' || (table === 'build-system' && kv[1] === 'requires') ||
      (table === 'tool.uv' && /^(dev|constraint|override)-dependencies$/.test(kv[1])) || (table === 'tool.pdm.dev-dependencies');
    if (wanted && kv[2].trim().startsWith('[')) {
      if (/\]\s*$/.test(kv[2].replace(/["'][^"']*["']/g, ''))) arrays.push(kv[2]);
      else collecting = [kv[2]];
    }
    // Poetry groups and the old dev table: `name = "spec"` or `{ version = "spec" }`.
    if (/^tool\.poetry\.(group\.[\w-]+\.)?(dev-)?dependencies$/.test(table) && table !== 'tool.poetry.dependencies' && kv[1].toLowerCase() !== 'python') {
      const v = kv[2].trim();
      const name = normalizePypiName(kv[1]);
      if (/\b(git|url)\s*=/.test(v)) add(name, v, { kind: 'remote', what: `${name}: ${v}` });
      else if (/\bpath\s*=/.test(v)) add(name, v, { kind: 'local' });
      else {
        const spec = v.match(/^["']([^"']*)["']/)?.[1] ?? v.match(/version\s*=\s*["']([^"']*)["']/)?.[1] ?? '';
        add(name, spec, { kind: 'package', name, spec: spec || undefined });
      }
    }
    // Sources that replace the registry for a package, and extra indexes.
    if (/^tool\.(uv\.sources|poetry\.dependencies)$/.test(table) && /\b(git|url)\s*=/.test(kv[2])) add(normalizePypiName(kv[1]), kv[2], { kind: 'remote', what: `${kv[1]}: ${kv[2].trim()}` });
    if (/^tool\.(uv\.index|poetry\.source|pdm\.source)$/.test(table) && kv[1] === 'url' && isCustomRegistry(kv[2])) add(`index ${kv[2].trim()}`, kv[2], { kind: 'remote', what: `index ${kv[2].trim()}` });
    if (table === 'tool.uv' && /^(index-url|extra-index-url|find-links)$/.test(kv[1]) && isCustomRegistry(kv[2])) add(`index ${kv[2].trim()}`, kv[2], { kind: 'remote', what: `index ${kv[2].trim()}` });
  }
  for (const a of arrays) {
    for (const s of a.matchAll(/["']([^"']+)["']/g)) {
      const k = pySpecKind(s[1]);
      if (k.kind === 'package') add(k.name, k.spec ?? '', k);
      else if (k.kind === 'remote') add(s[1], s[1], k);
    }
  }
}

/** deno.json "imports" (and "scopes"): npm: specifiers are checked; jsr: and URLs are not. */
function denoImports(content: string, add: (name: string, spec: string, kind?: SpecKind) => void) {
  const j = JSON.parse(content.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
  const maps = [j.imports ?? {}, ...Object.values<Record<string, string>>(j.scopes ?? {})];
  for (const m of maps) {
    for (const [key, value] of Object.entries<string>(m)) {
      if (typeof value !== 'string') continue;
      if (/^npm:/i.test(value)) {
        const k = npmValueKind(key, value);
        if (k.kind === 'package') add(k.name, k.spec ?? '', k);
        else add(key, value, k);
      } else if (/^jsr:/i.test(value)) add(key, value, { kind: 'jsr', name: value.slice(4) });
    }
  }
}

/** pnpm-workspace.yaml: `catalog:`, `catalogs:` and `overrides:` pick versions for the whole workspace. */
function pnpmWorkspace(content: string, add: (name: string, spec: string) => void) {
  let section = '';
  for (const line of content.split(/\r?\n/)) {
    const top = line.match(/^([\w-]+)\s*:/);
    if (top) {
      section = top[1];
      continue;
    }
    if (!/^(catalog|catalogs|overrides)$/.test(section)) continue;
    const m = line.match(/^\s+["']?((?:@[\w.-]+\/)?[\w.>@<^~*-]+)["']?\s*:\s*["']?([^"'#\s][^"'#]*?)["']?\s*(#.*)?$/);
    if (m) add(m[1].split('>').pop()?.replace(/(.)@[^@]*$/, '$1') ?? m[1], m[2].trim());
  }
}

function manifestChange(file: string, next: string, old: string | undefined, siblings: Record<string, string>): DepIntent[] {
  const base = path.basename(file);
  const eco = ecosystemOf(file);
  const reqs = isRequirements(file);
  if (!detectKind(file) && !reqs && !/^(Gemfile|Pipfile|deno\.jsonc?|pnpm-workspace\.yaml)$/i.test(base)) return [];
  // dev-requirements.txt, requirements/dev.txt and constraints.txt read like requirements.txt.
  const reader = reqs ? 'requirements.txt' : file;
  const after = declared(reader, next, siblings);
  if (!after) {
    // A manifest that does not parse after the write: the hook cannot see what it declares.
    return next.trim() ? [unverifiable(eco, base, `${base} would not parse after this change, so pinright cannot see what it declares.`, base)] : [];
  }
  const before = declared(reader, old, siblings) ?? [];
  const seen = new Set(before.map((e) => `${e.name}\0${e.spec}`));
  const out: DepIntent[] = [];
  const context: DepIntent[] = [];
  for (const e of after) {
    const unchanged = seen.has(`${e.name}\0${e.spec}`);
    const k = e.kind;
    if (k.kind === 'local' || k.kind === 'dynamic') continue;
    if (unchanged) {
      if (k.kind === 'package') context.push({ ecosystem: eco, name: k.name, spec: k.spec, source: base, contextOnly: true });
      continue;
    }
    if (k.kind === 'remote') out.push(unverifiable(eco, e.name, `${k.what} comes from outside the registry; pinright cannot check it.`, base));
    else if (k.kind === 'jsr') out.push(unverifiable(eco, k.name, `jsr:${k.name} is a JSR package; pinright does not check JSR.`, base, 'note'));
    else out.push({ ecosystem: eco, name: k.name, spec: k.spec || undefined, source: base });
  }
  out.push(...manifestSourceLines(file, next, old));
  // Nothing changed: nothing to check. Otherwise the unchanged lines come along as context.
  return out.length ? [...out, ...context] : [];
}

/** Lines of a manifest that switch the registry or replace a package with another source. */
function manifestSourceLines(file: string, next: string, old: string | undefined): DepIntent[] {
  const base = path.basename(file);
  const eco = ecosystemOf(file);
  const out: DepIntent[] = [];
  const say = (what: string) => out.push(unverifiable(eco, what, `${base}: "${what.slice(0, 120)}" changes where packages come from; pinright cannot check that source.`, base));
  for (const l of addedLines(next, old)) {
    if (isRequirements(file)) {
      const opt = l.match(/^(-i|--index-url|--extra-index-url|-f|--find-links|--trusted-host)[\s=]+(\S+)/);
      if (opt && (opt[1] === '--trusted-host' || isCustomRegistry(opt[2]))) say(l);
      else if (/^(-e|--editable)[\s=]+/.test(l) && pySpecKind(l.replace(/^(-e|--editable)[\s=]+/, '')).kind === 'remote') say(l);
      else if (/^(git\+|https?:|svn\+|hg\+|bzr\+)/i.test(l)) say(l);
    }
    if (eco === 'go' && /=>/.test(l)) {
      // replace a => b v1: the module now comes from b.
      const m = l.replace(/^replace\s+/, '').match(/=>\s*(\S+)\s+(v\S+)/);
      if (m && m[1].includes('.') && !/^\.{0,2}\//.test(m[1])) out.push({ ecosystem: 'go', name: m[1], spec: m[2].replace(/^v/, ''), source: base });
    }
    if (eco === 'cargo' && (/\bgit\s*=\s*["']/.test(l) || (/\bregistry(-index)?\s*=/.test(l) && !/crates-io/.test(l)) || /^\[(patch|source|registries)\b/.test(l))) say(l);
    if (eco === 'rubygems' && /^source\s+["']/.test(l) && isCustomRegistry(l.match(/["']([^"']+)["']/)?.[1])) say(l);
    if (/^Pipfile$/i.test(base) && /^url\s*=/.test(l) && isCustomRegistry(l.split('=')[1])) say(l);
    if (eco === 'composer' && /"(type)"\s*:\s*"(vcs|git|package|artifact|composer)"/.test(l)) say(l);
    if (eco === 'composer' && /"url"\s*:\s*"/.test(l) && isCustomRegistry(l.match(/"url"\s*:\s*"([^"]+)"/)?.[1])) say(l);
    if (eco === 'maven' && /<(repository|pluginRepository)>|<url>|maven\s*\{\s*url|url\s*=?\s*uri\(/.test(l) && customHosts(l).length) say(l);
  }
  return out;
}

/** A lockfile written by hand: new or re-pointed versions are checked, and new download hosts are flagged. */
function lockfileChange(file: string, next: string, old: string | undefined): DepIntent[] {
  const base = path.basename(file);
  const eco = ecosystemOf(file);
  const out: DepIntent[] = [];
  const hosts = new Set(customHosts(old ?? ''));
  for (const h of customHosts(next)) {
    if (!hosts.has(h)) out.push(unverifiable(eco, h, `${base} resolves packages from ${h}, which is not the public registry; pinright cannot check it.`, base));
  }
  if (!detectKind(file)) {
    out.push(unverifiable(eco, base, `${base} was edited by hand; pinright cannot read it. Let the package manager write lockfiles.`, base));
    return out;
  }
  const packages = (content: string | undefined) => {
    if (!content) return [];
    return parseFile(base, content).packages;
  };
  let after;
  let before;
  try {
    after = packages(next);
    before = packages(old);
  } catch {
    out.push(unverifiable(eco, base, `${base} would not parse after this change; pinright cannot see what it pins.`, base));
    return out;
  }
  const seen = new Set(before.map((p) => `${p.name}@${p.version}`));
  for (const p of after) if (!seen.has(`${p.name}@${p.version}`)) out.push({ ecosystem: eco, name: p.name, spec: p.version, source: base });
  return out;
}

/** Registry and index settings, and files that rewrite dependencies at install time. */
function sourcesChange(file: string, next: string, old: string | undefined): DepIntent[] {
  const base = path.basename(file);
  const eco = ecosystemOf(file);
  if (/(\.pnpmfile\.c?js|package\.yaml|package\.json5)$/i.test(base)) {
    return [unverifiable(eco, base, `${base} changes which packages get installed and pinright cannot read it; review it by hand.`, base)];
  }
  const out: DepIntent[] = [];
  for (const l of addedLines(next, old)) {
    if (/^[#;]/.test(l)) continue;
    const setting = /(registry|index|url|source|mirror|npmScopes|npmRegistryServer|trusted-host|find-links|channel|packageExtensions|unsafeHttpWhitelist|strict-ssl|enableStrictSsl|checksum|ignore-scripts)/i.test(l);
    if (setting && (customHosts(l).length || !/https?:/.test(l))) out.push(unverifiable(eco, l.slice(0, 80), `${base}: "${l.slice(0, 120)}" changes where or how packages are fetched; pinright cannot vouch for it.`, base));
  }
  return out;
}

/** The team policy, and the agent settings that run (or carry the environment of) the hook. */
function guardChange(file: string, next: string | undefined, old: string | undefined): DepIntent[] {
  const base = path.basename(file);
  const ask = (what: string) => [unverifiable('npm', base, what, base, 'guard')];
  if (next === old) return [];
  if (/\.pinright\.json$/i.test(file)) return ask(`changes the pinright team policy (${base}); a human should approve policy changes.`);
  if (next === undefined) return old?.includes('pinright') || old?.includes('PINRIGHT') ? ask(`changes ${base}, which runs the pinright hook, in a way pinright cannot read.`) : [];
  const signature = (content: string | undefined) => {
    if (!content) return '';
    const j = JSON.parse(content);
    const parts: string[] = [];
    for (const [event, list] of Object.entries<unknown>(j.hooks ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const el of list) if (/pinright/i.test(JSON.stringify(el))) parts.push(`${event}:${JSON.stringify(el)}`);
    }
    for (const [k, v] of Object.entries<unknown>(j.env ?? {})) if (/^PINRIGHT_/i.test(k)) parts.push(`env:${k}=${String(v)}`);
    if (j.disableAllHooks) parts.push('disableAllHooks');
    return parts.sort().join('\n');
  };
  let changed: boolean;
  try {
    changed = signature(next) !== signature(old);
  } catch {
    changed = /pinright/i.test(old ?? '');
  }
  return changed ? ask(`changes how the pinright hook runs (${base}): its entry, its matcher or its PINRIGHT_* settings. A human should approve that.`) : [];
}
