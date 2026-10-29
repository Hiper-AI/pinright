/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON from registries, lockfiles and agent hooks, read defensively */
/**
 * Hook entry points. Each agent sends a different JSON on stdin and expects a
 * different answer on stdout:
 *   Claude Code PreToolUse  -> { hookSpecificOutput: { permissionDecision, ... } }
 *   Cursor beforeShellExecution / preToolUse -> { permission, user_message, agent_message }
 * Both run the same extraction and policy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { applyCooldownDays } from '../config.js';
import { loadTeamConfig, resolvePolicy } from '../teamConfig.js';
import { agentMessage, decide, type HookDecision } from './policy.js';
import { type DepIntent, fromCommand, fromFileWrite, isWatchedFile } from './intent.js';
import { decideActions } from '../actions/check.js';
import { type ActionUse, changedUses, isWorkflowFile } from '../actions/workflow.js';

function readIfExists(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** The file content after an Edit/MultiEdit, computed from the file on disk. */
function applyEdits(original: string, edits: { old_string?: string; new_string?: string; replace_all?: boolean }[]): string {
  let s = original;
  for (const e of edits) {
    if (e.old_string === undefined || e.new_string === undefined) continue;
    s = e.replace_all ? s.split(e.old_string).join(e.new_string) : s.replace(e.old_string, e.new_string);
  }
  return s;
}

/** The file a write/edit tool targets, with its content before and after, when `accept` wants it. */
function fileChange(input: Record<string, any>, cwd: string, accept: (file: string) => boolean): { abs: string; old?: string; next: string } | undefined {
  const file = input.file_path ?? input.path ?? input.target_file ?? input.filePath;
  if (typeof file !== 'string' || !accept(file)) return undefined;
  const abs = path.resolve(cwd, file);
  const old = readIfExists(abs);
  let next: string | undefined;
  if (typeof input.content === 'string') next = input.content;
  else if (typeof input.contents === 'string') next = input.contents;
  else if (Array.isArray(input.edits)) next = old !== undefined ? applyEdits(old, input.edits) : undefined;
  else if (typeof input.old_string === 'string') next = old !== undefined ? applyEdits(old, [input]) : undefined;
  else if (typeof input.code_edit === 'string' && !/\.\.\. existing code/i.test(input.code_edit)) next = input.code_edit;
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

/** Tool input from either agent -> dependency intents. Unknown tools yield nothing. */
export function intentsFromToolInput(toolName: string, input: Record<string, any>, cwd: string): DepIntent[] {
  const command = input.command ?? input.cmd;
  if (typeof command === 'string') return fromCommand(command, cwd, readIfExists);
  const change = fileChange(input, cwd, isWatchedFile);
  if (!change) return [];
  void toolName;
  return fromFileWrite(change.abs, change.next, change.old, gradleSiblings(change.abs));
}

/** New or changed `uses:` lines in a workflow or action.yml being written. */
export function actionUsesFromToolInput(input: Record<string, any>, cwd: string): ActionUse[] {
  if (typeof (input.command ?? input.cmd) === 'string') return [];
  const change = fileChange(input, cwd, isWorkflowFile);
  return change ? changedUses(change.next, change.old, change.abs) : [];
}

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
  const timeout = new Promise<HookDecision>((resolve) =>
    setTimeout(() => {
      resolve({ action: policy.onError, problems: [], warnings: ['safectx: verification timed out; dependencies not checked.'], checked: 0 });
    }, ms).unref(),
  );
  const both = async () => {
    const [deps, actions] = await Promise.all([
      intents.length ? decide(intents, policy) : undefined,
      uses.length ? decideActions(uses) : undefined,
    ]);
    return deps && actions ? merge(deps, actions) : ((deps ?? actions) as HookDecision);
  };
  return Promise.race([both(), timeout]);
}

const DEADLINE_MS = Number(process.env.SAFECTX_HOOK_TIMEOUT_MS ?? 45_000);

export async function runClaudeHook(): Promise<number> {
  const input = JSON.parse((await readStdin()) || '{}');
  const cwd = input.cwd ?? process.cwd();
  const intents = intentsFromToolInput(input.tool_name ?? '', input.tool_input ?? {}, cwd);
  const uses = actionUsesFromToolInput(input.tool_input ?? {}, cwd);
  if (!intents.length && !uses.length) return 0; // not a dependency change: say nothing
  const d = await decideWithin(intents, uses, DEADLINE_MS, cwd);
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
  // Cursor treats invalid output as a block, so always answer.
  if (!intents.length && !uses.length) {
    process.stdout.write(JSON.stringify({ permission: 'allow' }));
    return 0;
  }
  const d = await decideWithin(intents, uses, DEADLINE_MS, cwd);
  const msg = agentMessage(d);
  process.stdout.write(
    JSON.stringify({
      permission: d.action,
      ...(msg ? { agent_message: msg, user_message: d.action === 'allow' ? undefined : `safectx: ${d.problems[0] ?? 'dependency check'}` } : {}),
    }),
  );
  return 0;
}
