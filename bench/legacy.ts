/* eslint-disable @typescript-eslint/no-explicit-any -- scores.json is read untyped */
/**
 * Runs recorded before the project was renamed to pinright use its working name
 * in arm ids (`safectx`, `safectx+hook`), arm directories, MCP tool names, the
 * whole-tree score field and the hook's block message. These helpers read them
 * as the current names so old runs still score, render and replay.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const OLD = 'safectx';
const NEW = 'pinright';

/** `safectx` -> `pinright`, `safectx+hook` -> `pinright+hook`; other ids unchanged. */
export function canonicalArm(arm: string): string {
  return arm === OLD || arm.startsWith(`${OLD}+`) ? NEW + arm.slice(OLD.length) : arm;
}

/** The arm's directory in a run: the current id, or the old one if only that exists. */
export function armDir(runDir: string, arm: string): string {
  const dir = join(runDir, arm);
  if (existsSync(dir) || !arm.startsWith(NEW)) return dir;
  const old = join(runDir, OLD + arm.slice(NEW.length));
  return existsSync(old) ? old : dir;
}

/** MCP tool names as recorded (`safectx__get-docs`) under the current server key. */
export const canonicalTool = (tool: string) => tool.replace(new RegExp(`^${OLD}__`), `${NEW}__`);

/** The hook's block message, in either name. */
export const HOOK_BLOCKED = new RegExp(`(?:${NEW}|${OLD}) blocked`);

/** Scores read from disk with arm ids, tool names and the whole-tree field under the current names. */
export function canonicalScores<T extends { arm: string }>(scores: T[]): T[] {
  return scores.map((s) => {
    const out: any = { ...s, arm: canonicalArm(s.arm) };
    if (out.tree && OLD in out.tree && !(NEW in out.tree)) {
      const { [OLD]: ours, ...rest } = out.tree;
      out.tree = { ...rest, [NEW]: ours };
    }
    if (Array.isArray(out.calls)) out.calls = out.calls.map((c: any) => ({ ...c, tool: canonicalTool(String(c.tool)) }));
    return out as T;
  });
}
