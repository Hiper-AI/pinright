/**
 * Entries written before the project was renamed to pinright, under its working
 * name. It was never published, so only the maintainer's machines have them:
 * `init` replaces them instead of adding a second entry, `doctor` lists them.
 */
import path from 'node:path';

export const OLD_NAME = 'safectx';

function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (v && typeof v === 'object') return Object.values(v).flatMap(strings);
  return [];
}

/** `safectx hook <agent>`, or `node ".../safectx/dist/cli.js" hook <agent>` from a checkout. */
const oldHookCommand = (s: string) =>
  new RegExp(`\\b${OLD_NAME}(@\\S*)?\\s+hook\\b`).test(s) || (s.includes(OLD_NAME) && /cli\.js"?\s+hook\b/.test(s));

/** A hook list entry (any shape) that runs the old hook. */
export const isLegacyHook = (entry: unknown): boolean => strings(entry).some(oldHookCommand);

/** An MCP entry's env with the old variable prefix moved to the new one (`SAFECTX_GH_CLI` -> `PINRIGHT_GH_CLI`). */
export function renameEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return env;
  const prefix = `${OLD_NAME.toUpperCase()}_`;
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k.startsWith(prefix) ? `PINRIGHT_${k.slice(prefix.length)}` : k, v]));
}

/** Raw config text that still holds an old entry: a server keyed by the old name or the old hook. */
export function hasLegacyEntry(text: string): boolean {
  const key = new RegExp(`(?:"${OLD_NAME}"\\s*:|\\[\\s*mcp_servers\\.${OLD_NAME}\\s*[\\].])`);
  return key.test(text) || text.split(/\r?\n/).some((line) => oldHookCommand(line.replace(/\\(["\\])/g, '$1')));
}

/** A file the old `init` owned outright, next to ours: `.github/hooks/safectx.json` for `.github/hooks/pinright.json`. */
export function legacySibling(file: string, serverKey: string): string | undefined {
  const base = path.basename(file);
  return base.startsWith(`${serverKey}.`) ? path.join(path.dirname(file), OLD_NAME + base.slice(serverKey.length)) : undefined;
}
