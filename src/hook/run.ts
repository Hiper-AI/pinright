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

/** Tool input from either agent -> dependency intents. Unknown tools yield nothing. */
export function intentsFromToolInput(toolName: string, input: Record<string, any>, cwd: string): DepIntent[] {
  const command = input.command ?? input.cmd;
  if (typeof command === 'string') return fromCommand(command, cwd, readIfExists);

  const file = input.file_path ?? input.path ?? input.target_file ?? input.filePath;
  if (typeof file !== 'string' || !isWatchedFile(file)) return [];
  const abs = path.resolve(cwd, file);
  const old = readIfExists(abs);
  let next: string | undefined;
  if (typeof input.content === 'string') next = input.content;
  else if (typeof input.contents === 'string') next = input.contents;
  else if (Array.isArray(input.edits)) next = old !== undefined ? applyEdits(old, input.edits) : undefined;
  else if (typeof input.old_string === 'string') next = old !== undefined ? applyEdits(old, [input]) : undefined;
  else if (typeof input.code_edit === 'string' && !/\.\.\. existing code/i.test(input.code_edit)) next = input.code_edit;
  if (next === undefined) return [];
  void toolName;
  return fromFileWrite(abs, next, old);
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
async function decideWithin(intents: DepIntent[], ms: number, cwd: string): Promise<HookDecision> {
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
  const timeout = new Promise<HookDecision>((resolve) =>
    setTimeout(() => {
      resolve({ action: policy.onError, problems: [], warnings: ['safectx: verification timed out; dependencies not checked.'], checked: 0 });
    }, ms).unref(),
  );
  return Promise.race([decide(intents, policy), timeout]);
}

const DEADLINE_MS = Number(process.env.SAFECTX_HOOK_TIMEOUT_MS ?? 45_000);

export async function runClaudeHook(): Promise<number> {
  const input = JSON.parse((await readStdin()) || '{}');
  const cwd = input.cwd ?? process.cwd();
  const intents = intentsFromToolInput(input.tool_name ?? '', input.tool_input ?? {}, cwd);
  if (!intents.length) return 0; // not a dependency change: say nothing
  const d = await decideWithin(intents, DEADLINE_MS, cwd);
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
  // Cursor treats invalid output as a block, so always answer.
  if (!intents.length) {
    process.stdout.write(JSON.stringify({ permission: 'allow' }));
    return 0;
  }
  const d = await decideWithin(intents, DEADLINE_MS, cwd);
  const msg = agentMessage(d);
  process.stdout.write(
    JSON.stringify({
      permission: d.action,
      ...(msg ? { agent_message: msg, user_message: d.action === 'allow' ? undefined : `safectx: ${d.problems[0] ?? 'dependency check'}` } : {}),
    }),
  );
  return 0;
}
