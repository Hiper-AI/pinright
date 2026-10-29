/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON from registries, lockfiles and agent hooks, read defensively */
/**
 * Hook entry points. Each agent sends a different JSON on stdin and expects a
 * different answer on stdout:
 *   Claude Code PreToolUse  -> { hookSpecificOutput: { permissionDecision, ... } }
 *   Cursor beforeShellExecution / preToolUse -> { permission, user_message, agent_message }
 * Both run the same extraction and policy.
 */
import path from 'node:path';
import { applyCooldownDays } from '../config.js';
import { readProjectFile } from '../projectFile.js';
import { loadTeamConfig, resolvePolicy } from '../teamConfig.js';
import { agentMessage, decide, type HookDecision, timeoutDecision } from './policy.js';
import { type DepIntent, fromCommand, fromFileWrite, isGuardedFile } from './intent.js';
import { lifecycleIntents } from './command.js';
import { unverifiable } from './spec.js';
import { decideActions } from '../actions/check.js';
import { stripInvisible } from '../untrusted/index.js';
import { type ActionUse, changedUses, isWorkflowFile } from '../actions/workflow.js';
import { languageOf, undeclaredImportNotes } from './imports.js';

function readIfExists(p: string): string | undefined {
  try {
    // The agent's own file, links included; but never a FIFO or device, and bounded.
    return readProjectFile(p, { allowOutside: true });
  } catch {
    return undefined;
  }
}

/** The file content after an Edit/MultiEdit, computed from the file on disk. */
function applyEdits(original: string, edits: { old_string?: string; new_string?: string; replace_all?: boolean }[]): string {
  let s = original;
  for (const e of edits) {
    if (e.old_string === undefined || e.new_string === undefined) continue;
    // A function replacer: a string one would expand $&, $' and $` in new_string, and the hook would
    // judge a different file from the one the tool writes.
    const next = e.new_string;
    s = e.replace_all ? s.split(e.old_string).join(next) : s.replace(e.old_string, () => next);
  }
  return s;
}

/**
 * The file a write/edit tool targets, with its content before and after, when `accept` wants it.
 * `opaque` set: the tool writes the file but its result cannot be computed (a lazy Cursor edit).
 */
function fileChange(input: Record<string, any>, cwd: string, accept: (file: string) => boolean): { abs: string; old?: string; next: string; opaque?: boolean } | undefined {
  const file = input.file_path ?? input.path ?? input.target_file ?? input.filePath ?? input.notebook_path;
  if (typeof file !== 'string' || !accept(file)) return undefined;
  const abs = path.resolve(cwd, file);
  const old = readIfExists(abs);
  let next: string | undefined;
  if (typeof input.content === 'string') next = input.content;
  else if (typeof input.contents === 'string') next = input.contents;
  else if (Array.isArray(input.edits)) next = old !== undefined ? applyEdits(old, input.edits) : undefined;
  else if (typeof input.old_string === 'string') next = old !== undefined ? applyEdits(old, [input]) : undefined;
  else if (typeof input.code_edit === 'string' && !/\.\.\. existing code/i.test(input.code_edit)) next = input.code_edit;
  else if (typeof input.code_edit === 'string') return { abs, old, next: '', opaque: true };
  return next === undefined ? undefined : { abs, old, next };
}

/** What a Gradle build script reads from other files: the version catalog and gradle.properties, up to the root project. */
function gradleSiblings(abs: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!/\.gradle(\.kts)?$/i.test(abs)) return out;
  let dir = path.dirname(abs);
  for (let i = 0; i < 4; i++) {
    out['libs.versions.toml'] ??= readIfExists(path.join(dir, 'gradle', 'libs.versions.toml')) as string;
    out['gradle.properties'] ??= readIfExists(path.join(dir, 'gradle.properties')) as string;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Shell lines in notebook source: "!pip install x", "%pip install x", and %%bash / %%sh / %%script cells. */
export function notebookCommands(source: string): string {
  if (/^\s*%%(bash|sh|script\s+(ba)?sh|system)\b/.test(source)) return source.replace(/^\s*%%[^\n]*\n?/, '');
  return source
    .split(/\r?\n/)
    .map((l) => l.trim().match(/^(?:!|%(?=(pip|conda|mamba|uv|npm|sx|system)\b))(.*)$/)?.[2] ?? '')
    .filter(Boolean)
    .join('\n');
}

/** The code cells of an .ipynb written whole. */
function notebookSource(content: string): string {
  try {
    const nb = JSON.parse(content);
    return (nb.cells ?? [])
      .filter((c: any) => c.cell_type === 'code')
      .map((c: any) => notebookCommands(Array.isArray(c.source) ? c.source.join('') : String(c.source ?? '')))
      .join('\n');
  } catch {
    return '';
  }
}

function extract(input: Record<string, any>, cwd: string): DepIntent[] {
  const command = input.command ?? input.cmd;
  if (typeof command === 'string') return fromCommand(command, cwd, readIfExists);
  // NotebookEdit: a cell with "!pip install x" installs when it runs.
  if (typeof input.new_source === 'string') return fromCommand(notebookCommands(input.new_source), path.dirname(path.resolve(cwd, String(input.notebook_path ?? '.'))), readIfExists);
  const nb = fileChange(input, cwd, (f) => /\.ipynb$/i.test(f));
  if (nb) return fromCommand(notebookSource(nb.next), path.dirname(nb.abs), readIfExists);
  const change = fileChange(input, cwd, isGuardedFile);
  if (!change) return [];
  if (change.opaque) return fromFileWrite(change.abs, undefined, change.old);
  const out = fromFileWrite(change.abs, change.next, change.old, gradleSiblings(change.abs));
  if (/(^|[\\/])package\.json$/i.test(change.abs)) out.push(...lifecycleIntents(change.abs, change.next, change.old, readIfExists));
  return out;
}

/** Tool input from either agent -> dependency intents. Unknown tools yield nothing. */
export function intentsFromToolInput(toolName: string, input: Record<string, any>, cwd: string): DepIntent[] {
  void toolName;
  try {
    return extract(input, cwd);
  } catch (err) {
    // A reader bug must not turn into a silent pass: whatever the agent is doing, a human looks at it.
    const what = typeof (input.command ?? input.cmd) === 'string' ? String(input.command ?? input.cmd) : String(input.file_path ?? input.path ?? 'this change');
    return [unverifiable('npm', 'hook', `safectx could not read this change (${(err as Error).message}).`, what.slice(0, 200))];
  }
}

/** New or changed `uses:` lines in a workflow or action.yml being written. */
export function actionUsesFromToolInput(input: Record<string, any>, cwd: string): ActionUse[] {
  if (typeof (input.command ?? input.cmd) === 'string') return [];
  const change = fileChange(input, cwd, isWorkflowFile);
  return change ? changedUses(change.next, change.old, change.abs) : [];
}

/** Imports in the written file (or, for a manifest, in the project) that no manifest declares. Notes only. */
export async function importNotesFromToolInput(input: Record<string, any>, cwd: string, ms = IMPORTS_DEADLINE_MS): Promise<string[]> {
  if (typeof (input.command ?? input.cmd) === 'string') return [];
  const change = fileChange(input, cwd, (f) => Boolean(languageOf(f)));
  if (!change) return [];
  const timeout = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), ms).unref());
  return Promise.race([undeclaredImportNotes(change.abs, change.next, change.old).catch(() => []), timeout]);
}

const IMPORTS_DEADLINE_MS = Number(process.env.SAFECTX_IMPORTS_TIMEOUT_MS ?? 15_000);

function merge(a: HookDecision, b: HookDecision): HookDecision {
  const rank = { allow: 0, ask: 1, deny: 2 } as const;
  return {
    action: rank[a.action] >= rank[b.action] ? a.action : b.action,
    problems: [...a.problems, ...b.problems],
    warnings: [...a.warnings, ...b.warnings],
    checked: a.checked + b.checked,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The whole check under a deadline: a hook that hangs blocks the agent.
 * The team policy is the .safectx.json nearest to cwd; a broken one denies
 * (fail closed) until it is fixed, since ignoring it would drop its deny list.
 */
async function decideWithin(intents: DepIntent[], uses: ActionUse[], ms: number, cwd: string): Promise<HookDecision> {
  const team = loadTeamConfig(cwd);
  if (team.error) {
    // The fix to the file itself goes to a human, like any other change to the policy.
    if (intents.length && !uses.length && intents.every((i) => i.unverifiable?.level === 'guard')) {
      return { action: 'ask', problems: [`the project policy cannot be read (${team.error}); a human should approve this change to it.`], warnings: [], checked: 0 };
    }
    return {
      action: 'deny',
      problems: [`the project policy cannot be read, so no dependency change is allowed until it is fixed. ${team.error}`],
      warnings: [],
      checked: 0,
    };
  }
  const policy = resolvePolicy(team.config, process.env, team.file);
  applyCooldownDays(policy.cooldownDays);
  // The Actions check reads SAFECTX_ACTIONS_PIN; the hook is a short-lived process, so the policy can set it.
  if (policy.actionsPin && !process.env.SAFECTX_ACTIONS_PIN) process.env.SAFECTX_ACTIONS_PIN = policy.actionsPin;
  // On timeout: what is known without the network (unverifiable sources, the deny list, lookalike names), then onError.
  const timeout = new Promise<HookDecision>((resolve) => setTimeout(() => resolve(timeoutDecision(intents, policy)), ms).unref());
  const both = async () => {
    const [deps, actions] = await Promise.all([
      intents.length ? decide(intents, policy) : undefined,
      uses.length ? decideActions(uses) : undefined,
    ]);
    return deps && actions ? merge(deps, actions) : ((deps ?? actions) as HookDecision);
  };
  return Promise.race([both(), timeout]);
}

function notesOnly(warnings: string[]): HookDecision {
  return { action: 'allow', problems: [], warnings, checked: 0 };
}

const DEADLINE_MS = Number(process.env.SAFECTX_HOOK_TIMEOUT_MS ?? 45_000);

export async function runClaudeHook(): Promise<number> {
  const input = JSON.parse((await readStdin()) || '{}');
  const cwd = input.cwd ?? process.cwd();
  const intents = intentsFromToolInput(input.tool_name ?? '', input.tool_input ?? {}, cwd);
  const uses = actionUsesFromToolInput(input.tool_input ?? {}, cwd);
  const notes = importNotesFromToolInput(input.tool_input ?? {}, cwd);
  if (!intents.length && !uses.length) {
    // Not a dependency change; a source file may still import something nobody declared.
    const imports = await notes;
    if (imports.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: agentMessage(notesOnly(imports)) } }));
    return 0;
  }
  const d = await decideWithin(intents, uses, DEADLINE_MS, cwd);
  d.warnings.push(...(await notes));
  const msg = agentMessage(d);
  if (d.action === 'allow') {
    if (msg) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } }));
    return 0;
  }
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.action, permissionDecisionReason: msg } }),
  );
  return 0;
}

export async function runCursorHook(): Promise<number> {
  const input = JSON.parse((await readStdin()) || '{}');
  const cwd = input.cwd ?? input.workspace_roots?.[0] ?? process.cwd();
  const toolInput = input.command !== undefined ? { command: input.command } : (input.tool_input ?? {});
  const intents = intentsFromToolInput(input.tool_name ?? '', toolInput, cwd);
  const uses = actionUsesFromToolInput(toolInput, cwd);
  const notes = importNotesFromToolInput(toolInput, cwd);
  // Cursor treats invalid output as a block, so always answer.
  if (!intents.length && !uses.length) {
    const imports = await notes;
    process.stdout.write(JSON.stringify({ permission: 'allow', ...(imports.length ? { agent_message: agentMessage(notesOnly(imports)) } : {}) }));
    return 0;
  }
  const d = await decideWithin(intents, uses, DEADLINE_MS, cwd);
  d.warnings.push(...(await notes));
  const msg = agentMessage(d);
  process.stdout.write(
    JSON.stringify({
      permission: d.action,
      ...(msg ? { agent_message: msg, user_message: d.action === 'allow' ? undefined : `safectx: ${stripInvisible(d.problems[0] ?? 'dependency check').text.replace(/\s+/g, ' ').slice(0, 300)}` } : {}),
    }),
  );
  return 0;
}
