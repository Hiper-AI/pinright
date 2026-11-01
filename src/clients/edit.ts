/* eslint-disable @typescript-eslint/no-explicit-any -- client config files are untyped JSON/TOML, read defensively */
/**
 * In-place edits of client config files. Only the keys pinright owns change:
 * other servers, comments (JSONC) and formatting stay as the user left them.
 * A file that does not parse is an error, never an empty object to write over.
 */
import jsonc from 'jsonc-parser';

export class ConfigError extends Error {}

export function parseJsonc(text: string, file: string): Record<string, any> {
  if (!text.trim()) return {};
  const errors: jsonc.ParseError[] = [];
  const value = jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const e = errors[0];
    const line = text.slice(0, e.offset).split('\n').length;
    throw new ConfigError(`${file} does not parse (${jsonc.printParseErrorCode(e.error)} at line ${line}); fix it or move it away, nothing was written`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(`${file} is not a JSON object; nothing was written`);
  return value;
}

/** Indentation and line endings of an existing file, so an edit looks like the rest of it. */
function formatOf(text: string): jsonc.FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([ \t]+)\S/.exec(text)?.[1];
  if (indent?.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indent ? Math.min(indent.length, 8) : 2, eol };
}

/** Sets `value` at `keyPath` (undefined removes it), keeping everything else byte for byte. */
export function setJsonc(text: string | undefined, file: string, keyPath: (string | number)[], value: unknown): string {
  let base = text && text.trim() ? text : '{}\n';
  parseJsonc(base, file);
  const fmt = formatOf(base);
  if (!text?.trim()) base = '{}';
  const edits = jsonc.modify(base, keyPath, value, { formattingOptions: fmt });
  const out = jsonc.applyEdits(base, edits);
  return out.endsWith('\n') ? out : `${out}${fmt.eol}`;
}

export function getAt(obj: any, keyPath: (string | number)[]): any {
  let cur = obj;
  for (const k of keyPath) cur = cur && typeof cur === 'object' ? cur[k] : undefined;
  return cur;
}

// ------------------------------------------------------------------- TOML ---

const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const tomlValue = (v: unknown): string => (Array.isArray(v) ? `[${v.map(tomlValue).join(', ')}]` : JSON.stringify(v));

/** A table and its subtables (`[a.b]`, `[a.b.env]`) as TOML text. Values are strings or string arrays. */
export function tomlTable(name: string[], body: Record<string, unknown>): string {
  const lines = [`[${name.map(tomlKey).join('.')}]`];
  const subs: [string, Record<string, unknown>][] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) subs.push([k, v as Record<string, unknown>]);
    else if (v !== undefined) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  }
  let out = `${lines.join('\n')}\n`;
  for (const [k, v] of subs) out += `\n${tomlTable([...name, k], v)}`;
  return out;
}

const headerRe = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const splitHeader = (h: string) => h.split('.').map((p) => p.trim().replace(/^"(.*)"$/, '$1'));

/**
 * Replaces the table `name` and its subtables in a TOML file (or appends it),
 * leaving every other line and comment alone. Also returns the old table's string
 * values under `env`, so an entry keeps the variables the user set.
 */
export function setTomlTable(text: string | undefined, name: string[], body: Record<string, unknown>): string {
  const lines = (text ?? '').split(/\r?\n/);
  const eol = text?.includes('\r\n') ? '\r\n' : '\n';
  const owned = (header: string) => {
    const parts = splitHeader(header);
    return parts.length >= name.length && name.every((p, i) => parts[i] === p);
  };
  const kept: string[] = [];
  let insertAt = -1;
  let inOwned = false;
  for (const line of lines) {
    const h = headerRe.exec(line);
    if (h) {
      inOwned = owned(h[1]);
      if (inOwned && insertAt < 0) insertAt = kept.length;
    }
    if (!inOwned) kept.push(line);
  }
  // A table we own may also be written inline (`pinright = { ... }` under [mcp_servers]); refuse rather than duplicate it.
  const parent = name.slice(0, -1).join('.');
  let section = '';
  for (const line of kept) {
    const h = headerRe.exec(line);
    if (h) section = splitHeader(h[1]).join('.');
    else if (section === parent && new RegExp(`^\\s*"?${name[name.length - 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*=`).test(line)) {
      throw new ConfigError(`${name.join('.')} is written inline in this file; edit it by hand or remove it first`);
    }
  }
  const block = tomlTable(name, body).trimEnd().split('\n');
  if (insertAt < 0) {
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    const out = kept.length ? [...kept, '', ...block] : block;
    return `${out.join(eol)}${eol}`;
  }
  // Keep a blank line between our table and whatever follows it.
  const after = kept.slice(insertAt);
  const needsGap = after.length && after[0].trim() !== '';
  const out = [...kept.slice(0, insertAt), ...block, ...(needsGap ? [''] : []), ...after];
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return `${out.join(eol)}${eol}`;
}

/** String values of `[name.env]` in a TOML file, the variables an existing entry sets. */
export function tomlEnv(text: string | undefined, name: string[]): Record<string, string> | undefined {
  if (!text) return undefined;
  const want = [...name, 'env'].join('.');
  const env: Record<string, string> = {};
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const h = headerRe.exec(line);
    if (h) {
      section = splitHeader(h[1]).join('.');
      continue;
    }
    if (section !== want) continue;
    const kv = /^\s*"?([A-Za-z0-9_.-]+)"?\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (kv) env[kv[1]] = JSON.parse(`"${kv[2]}"`);
  }
  return Object.keys(env).length ? env : undefined;
}

/** Removes the table `name` and its subtables from a TOML file; the text is unchanged when it has none. */
export function removeTomlTable(text: string | undefined, name: string[]): string | undefined {
  if (!text) return text;
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const kept: string[] = [];
  let inOwned = false;
  let removed = false;
  for (const line of lines) {
    const h = headerRe.exec(line);
    if (h) {
      const parts = splitHeader(h[1]);
      inOwned = parts.length >= name.length && name.every((p, i) => parts[i] === p);
    }
    if (inOwned) removed = true;
    else if (!(removed && line.trim() === '' && kept.length && kept[kept.length - 1].trim() === '')) kept.push(line);
  }
  if (!removed) return text;
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.length ? `${kept.join(eol)}${eol}` : '';
}
