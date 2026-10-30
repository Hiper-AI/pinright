/**
 * What the hook extracts and how it reads a package spec, shared by the command
 * reader (command.ts) and the file reader (writes.ts).
 */
import { type Ecosystem } from '../ecosystems.js';
import { normalizePypiName } from '../tree/lockfiles.js';
import { DYNAMIC } from './shell.js';

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
  /**
   * Not looked up: a git or URL source, a registry switch, a command or a file the hook cannot read.
   * The policy's `unverifiable` decides it; `note` only informs, and `guard` (a change to the hook's
   * own configuration) always asks a human.
   */
  unverifiable?: { reason: string; level?: 'note' | 'guard' };
}

export function unverifiable(ecosystem: Ecosystem, name: string, reason: string, source: string, level?: 'note' | 'guard'): DepIntent {
  return { ecosystem, name, source, unverifiable: { reason, ...(level ? { level } : {}) } };
}

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
  return [normalizePypiName(m[1]), m[2].split(';')[0].replace(/\s--\S+.*$/, '').trim() || undefined];
}

/** Local code: a path, a workspace or catalog reference. Nothing to look up and nothing remote. */
const LOCAL = /^(\.{1,2}([\\/]|$)|[\\/]|~[\\/]|[a-z]:[\\/]|file:|link:|portal:|workspace:|catalog:|patch:)/i;
/** Fetched from somewhere that is not the registry: pinright cannot vouch for it. */
const REMOTE = /^(git\+|git:|git@|ssh:|https?:|ftp:|github:|gitlab:|bitbucket:|gist:|svn\+|hg\+|bzr\+)/i;
const ARCHIVE = /\.(tgz|tar\.gz|tar\.bz2|tar\.xz|whl|zip|gem|crate|egg)$/i;

export const isDynamic = (s: string) => s.includes(DYNAMIC) || /\$[{A-Za-z_@*0-9]/.test(s) || s.includes('%');

export type SpecKind =
  | { kind: 'package'; name: string; spec?: string }
  | { kind: 'local' }
  | { kind: 'remote'; what: string }
  | { kind: 'dynamic' }
  | { kind: 'jsr'; name: string };

/** One npm-style argument: "x@1", "@s/x", "alias@npm:real@1", "github:u/r", "./dir", "$PKG". */
export function npmSpecKind(s: string): SpecKind {
  if (isDynamic(s)) return { kind: 'dynamic' };
  if (LOCAL.test(s)) return { kind: 'local' };
  if (REMOTE.test(s)) return { kind: 'remote', what: s };
  if (ARCHIVE.test(s)) return { kind: 'local' };
  if (/^npm:/i.test(s)) return npmSpecKind(s.slice(4));
  if (/^jsr:/i.test(s)) return { kind: 'jsr', name: s.slice(4) };
  // "user/repo" without a scope is a GitHub shorthand, not a registry package.
  const alias = s.match(/^(@?[^@]+)@((?:npm|jsr):.+)$/i);
  if (alias) return npmSpecKind(alias[2]);
  if (!s.startsWith('@') && s.includes('/')) {
    // "user/repo" without a scope is a GitHub shorthand, not a registry package; so is "name@user/repo".
    return { kind: 'remote', what: s };
  }
  const at = s.indexOf('@', 1);
  if (at > 0 && /[:/]/.test(s.slice(at + 1)) && !/^[\^~<>=*\d]/.test(s.slice(at + 1))) {
    const rest = s.slice(at + 1);
    if (LOCAL.test(rest)) return { kind: 'local' };
    return { kind: 'remote', what: s };
  }
  const [name, spec] = splitNpmSpec(s);
  if (spec) {
    // "alias@npm:real@1.0.0" installs real@1.0.0 under another name.
    if (/^npm:/i.test(spec)) return npmSpecKind(spec.slice(4));
    if (/^jsr:/i.test(spec)) return { kind: 'jsr', name: spec.slice(4) };
    if (LOCAL.test(spec)) return { kind: 'local' };
    if (REMOTE.test(spec) || (!spec.startsWith('@') && /^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec))) return { kind: 'remote', what: s };
  }
  return { kind: 'package', name, spec };
}

/** A version value in package.json: "^1.2", "npm:real@1", "github:u/r", "file:../x". */
export function npmValueKind(name: string, value: string): SpecKind {
  if (typeof value !== 'string') return { kind: 'local' };
  if (/^npm:/i.test(value)) return npmSpecKind(value.slice(4));
  if (/^jsr:/i.test(value)) return { kind: 'jsr', name: value.slice(4) };
  if (LOCAL.test(value)) return { kind: 'local' };
  if (REMOTE.test(value) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(value)) return { kind: 'remote', what: `${name}: ${value}` };
  if (value.startsWith('$')) return { kind: 'local' }; // "$foo" in overrides points at the direct dependency
  return { kind: 'package', name, spec: value || undefined };
}

/** One pip-style argument: "x==1", "x[extra]>=2", "x @ https://...", "git+https://...", "./dir". */
export function pySpecKind(s: string): SpecKind {
  if (isDynamic(s)) return { kind: 'dynamic' };
  if (s === '.' || LOCAL.test(s)) return { kind: 'local' };
  if (REMOTE.test(s) || /^[A-Za-z0-9][A-Za-z0-9_.-]*(\[[^\]]*\])?\s*@\s*\S/.test(s)) return { kind: 'remote', what: s };
  if (ARCHIVE.test(s)) return { kind: 'local' };
  const p = splitPySpec(s);
  return p ? { kind: 'package', name: p[0], spec: p[1] } : { kind: 'local' };
}

/** The public registries pinright checks against. Any other index or registry is a switch it cannot vouch for. */
const DEFAULT_REGISTRY =
  /^(https?:\/\/)?(registry\.npmjs\.(org|com)|registry\.yarnpkg\.com|pypi\.org|pypi\.python\.org|files\.pythonhosted\.org|(index\.)?rubygems\.org|api\.nuget\.org|www\.nuget\.org|(repo\.)?packagist\.org|proxy\.golang\.org|sum\.golang\.org|(index\.)?crates\.io|static\.crates\.io|github\.com\/rust-lang\/crates\.io-index|jsr\.io|deno\.land|repo1?\.maven\.org|repo\.maven\.apache\.org)([/:?#]|$)/i;

export function isCustomRegistry(url: string | undefined): boolean {
  if (!url) return false;
  const u = url.trim().replace(/^["']|["']$/g, '');
  if (!u || u === 'direct' || u === 'off') return false;
  return !u.split(/[,|]/).every((part) => DEFAULT_REGISTRY.test(part.trim()) || part.trim() === 'direct' || part.trim() === 'off');
}

/** Hosts of the URLs in a text that are not a default registry. */
export function customHosts(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:git\+)?(?:https?|ssh|git):\/\/[^\s"',)\]]+/g)) {
    const url = m[0].replace(/^git\+/, '');
    if (DEFAULT_REGISTRY.test(url)) continue;
    try {
      out.add(new URL(url).host);
    } catch {
      out.add(url.slice(0, 60));
    }
  }
  return [...out];
}
