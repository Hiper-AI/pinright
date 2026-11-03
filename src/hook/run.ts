/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON from registries, lockfiles and agent hooks, read defensively */
/**
 * Hook entry points. Each agent sends a different JSON on stdin and expects a
 * different answer on stdout:
 *   Claude Code PreToolUse  -> { hookSpecificOutput: { permissionDecision, ... } }
 *   Cursor beforeShellExecution / preToolUse -> { permission, user_message, agent_message }
 *   Codex PreToolUse         -> Claude's shape, without "ask"; apply_patch carries a patch
 *   Gemini CLI BeforeTool    -> { decision: "deny", reason }
 *   VS Code / Copilot        -> permissionDecision at the top level and in hookSpecificOutput
 *   Windsurf pre_run_command / pre_write_code -> exit 2 with the reason on stderr
 * All run the same extraction and policy.
 *
 * The hook runs before every shell command and file write the agent makes, so
 * the common case (`npm test`, editing a README) must cost little more than
 * reading stdin. The whole extraction (shell parser, command and write readers)
 * is loaded up front, so nothing is called "not an install" without it; the
 * policy, the registries and the team config are imported only when there is a
 * dependency change to judge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { applyCooldownDays } from '../config.js';
import { readProjectFile } from '../projectFile.js';
import type { Policy } from '../teamConfig.js';
import type { HookDecision } from './policy.js';
import { type DepIntent, fromCommand, fromFileWrite, isGuardedFile } from './intent.js';
import { lifecycleIntents } from './command.js';
import { unverifiable } from './spec.js';
import { stripInvisible } from '../untrusted/normalize.js';
import { type ActionUse, changedUses, isWorkflowFile } from '../actions/workflow.js';
import { languageOf } from './languages.js';
import { parseApplyPatch } from './applyPatch.js';
import { hookTimeoutMs } from './late.js';

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
 * The file the OS will actually write. On Windows `package.json::$DATA` is package.json and
 * `PACKAG~1.JSO` its 8.3 short name; a link (`x -> package.json`) writes its target everywhere.
 * Judging the name the agent typed would let any of these past the manifest and policy checks.
 */
export function writtenPath(abs: string, platform: NodeJS.Platform = process.platform): string {
  let p = abs;
  if (platform === 'win32') {
    // A stream suffix on the last segment (the drive's colon is in the first one).
    const at = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    const colon = p.indexOf(':', at + 1);
    if (colon > at) p = p.slice(0, colon);
  }
  // Path rules of the platform being judged, so a Windows path stays one when read elsewhere.
  const P = platform === 'win32' ? path.win32 : path.posix;
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return P.join(fs.realpathSync.native(P.dirname(p)), P.basename(p));
    } catch {
      return p;
    }
  }
}

/**
 * The file a write/edit tool targets, with its content before and after, when `accept` wants it.
 * `opaque` set: the tool writes the file but its result cannot be computed (a lazy Cursor edit).
 */
function fileChange(input: Record<string, any>, cwd: string, accept: (file: string) => boolean): { abs: string; old?: string; next: string; opaque?: boolean } | undefined {
  const raw = input.file_path ?? input.path ?? input.target_file ?? input.filePath ?? input.notebook_path;
  if (typeof raw !== 'string') return undefined;
  const abs = writtenPath(path.resolve(cwd, raw));
  if (!accept(abs)) return undefined;
  const old = readIfExists(abs);
  let next: string | undefined;
  if (typeof input.move_from === 'string') {
    // Codex `*** Move to:`: the source, edited, becomes this file.
    const src = readIfExists(path.resolve(cwd, input.move_from));
    next = src === undefined ? undefined : applyEdits(src, Array.isArray(input.edits) ? input.edits : []);
    return next === undefined ? { abs, old, next: '', opaque: true } : { abs, old, next };
  }
  if (typeof input.content === 'string') next = input.content;
  else if (typeof input.contents === 'string') next = input.contents;
  else if (Array.isArray(input.edits)) {
    // A new file arrives as edits with nothing to replace (Windsurf, a Codex "Add File").
    const created = input.edits.every((e: any) => !e?.old_string) ? input.edits.map((e: any) => e?.new_string ?? '').join('') : undefined;
    next = old !== undefined ? applyEdits(old, input.edits) : created;
  }
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
    return [unverifiable('npm', 'hook', `pinright could not read this change (${(err as Error).message}).`, what.slice(0, 200))];
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
  const notes = import('./imports.js').then(({ undeclaredImportNotes }) => undeclaredImportNotes(change.abs, change.next, change.old));
  return Promise.race([notes.catch(() => []), timeout]);
}

const IMPORTS_DEADLINE_MS = Number(process.env.PINRIGHT_IMPORTS_TIMEOUT_MS ?? 15_000);

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
 * The whole check under a deadline. The agents give the hook 60 s and then let the change
 * through, so the hook answers first: on its own deadline it asks a human, whatever onError says
 * (see timeoutDecision). The clock starts before the modules load, so a cold start counts too.
 * The policy (modules and .pinright.json, local disk only) loads before the race, so a deadline
 * that runs out early still applies the team's deny list and its unverifiable rule instead of a
 * bare "ask". The team policy is the .pinright.json nearest to cwd; a broken one denies (fail
 * closed) until it is fixed, since ignoring it would drop its deny list.
 */
export async function decideWithin(intents: DepIntent[], uses: ActionUse[], ms: number, cwd: string, given?: Policy): Promise<HookDecision> {
  const t0 = Date.now();
  const actionNames = uses.map((u) => `${u.owner}/${u.repo}${u.path ? `/${u.path}` : ''}@${u.ref}`);
  const [{ loadTeamConfig, resolvePolicy }, { decide, timeoutDecision }, { decideActions }] = await Promise.all([
    import('../teamConfig.js'),
    import('./policy.js'),
    import('../actions/check.js'),
  ]);
  const team = given ? {} : loadTeamConfig(cwd);
  if ('error' in team && team.error) {
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
  const policy = given ?? resolvePolicy('config' in team ? team.config : undefined, process.env, 'file' in team ? team.file : undefined);
  applyCooldownDays(policy.cooldownDays);
  // The Actions check reads PINRIGHT_ACTIONS_PIN; the hook is a short-lived process, so the policy can set it.
  if (policy.actionsPin && !process.env.PINRIGHT_ACTIONS_PIN) process.env.PINRIGHT_ACTIONS_PIN = policy.actionsPin;
  // On timeout: what is known without the network (unverifiable sources, the deny list, lookalike names), then ask.
  const left = Math.max(0, ms - (Date.now() - t0));
  const timeout = new Promise<HookDecision>((resolve) => setTimeout(() => resolve(timeoutDecision(intents, policy, ms, actionNames)), left).unref());
  const check = (async () => {
    const [deps, actions] = await Promise.all([
      intents.length ? decide(intents, policy) : undefined,
      uses.length ? decideActions(uses, policy.onError) : undefined,
    ]);
    return deps && actions ? merge(deps, actions) : ((deps ?? actions) as HookDecision);
  })().catch((err: Error): HookDecision => {
    // A bug or an answer nobody expected must not crash the hook: exit 1 lets the agent proceed.
    const offline = timeoutDecision(intents, policy, ms, actionNames);
    const problem = `pinright could not finish checking this change (${err?.message ?? err}); a human should approve it.`;
    return { ...offline, action: offline.action === 'deny' || policy.onError === 'deny' ? 'deny' : 'ask', problems: [problem, ...offline.problems.filter((p) => !/in time/.test(p))] };
  });
  return Promise.race([check, timeout]);
}

function notesOnly(warnings: string[]): HookDecision {
  return { action: 'allow', problems: [], warnings, checked: 0 };
}

const DEADLINE_MS = hookTimeoutMs();

/** The agents with a pre-tool hook that `pinright hook <agent>` answers. */
export const HOOK_AGENTS = ['claude', 'cursor', 'codex', 'gemini', 'copilot', 'windsurf'] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

export function isHookAgent(s: string | undefined): s is HookAgent {
  return HOOK_AGENTS.includes(s as HookAgent);
}

const asObject = (v: unknown): Record<string, any> => {
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
};

/**
 * Each agent's stdin JSON -> the tool inputs to check (file_path/content/edits or
 * command, the shape the extraction reads) and the directory they are relative to.
 */
export function hookInputs(agent: HookAgent, input: Record<string, any>, fallbackCwd = process.cwd()): { inputs: Record<string, any>[]; cwd: string } {
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : fallbackCwd;
  switch (agent) {
    case 'cursor': {
      const root = input.cwd ?? input.workspace_roots?.[0] ?? fallbackCwd;
      return { inputs: [input.command !== undefined ? { command: input.command } : asObject(input.tool_input)], cwd: root };
    }
    case 'codex': {
      const toolInput = asObject(input.tool_input);
      // apply_patch carries a patch for one or more files; each becomes a file write.
      if (input.tool_name === 'apply_patch') return { inputs: parseApplyPatch(toolInput.command ?? toolInput.input ?? toolInput.patch), cwd };
      return { inputs: [toolInput], cwd };
    }
    case 'gemini': {
      const toolInput = asObject(input.tool_input);
      // run_shell_command may run in a subdirectory of the project.
      const dir = typeof toolInput.directory === 'string' ? path.resolve(cwd, toolInput.directory) : cwd;
      return { inputs: [toolInput], cwd: dir };
    }
    case 'copilot':
      // The PascalCase PreToolUse alias sends tool_name/tool_input; the camelCase event sends toolName/toolArgs (maybe a JSON string).
      return { inputs: [asObject(input.tool_input ?? input.toolArgs)], cwd };
    case 'windsurf': {
      const info = asObject(input.tool_info);
      const dir = typeof info.cwd === 'string' && info.cwd ? info.cwd : cwd;
      if (typeof info.command_line === 'string') return { inputs: [{ command: info.command_line }], cwd: dir };
      return { inputs: [info], cwd: dir };
    }
    default:
      return { inputs: [asObject(input.tool_input)], cwd };
  }
}

/** The decision for a set of tool inputs, and the message for the agent. Not a dependency change -> only notes about undeclared imports. */
export async function evaluateHook(inputs: Record<string, any>[], cwd: string, ms = DEADLINE_MS): Promise<{ d: HookDecision; msg: string }> {
  const started = Date.now();
  const intents = inputs.flatMap((i) => intentsFromToolInput('', i, cwd));
  const uses = inputs.flatMap((i) => actionUsesFromToolInput(i, cwd));
  // The import notes run alongside the check and never outlast the hook's deadline.
  const notes = Promise.all(inputs.map((i) => importNotesFromToolInput(i, cwd, Math.min(IMPORTS_DEADLINE_MS, ms)))).then((all) => all.flat());
  if (!intents.length && !uses.length) {
    // Not a dependency change; a source file may still import something nobody declared.
    const d = notesOnly(await notes);
    return { d, msg: d.warnings.length ? (await import('./policy.js')).agentMessage(d) : '' };
  }
  // Reading the command and the files already took part of the budget.
  const d = await decideWithin(intents, uses, Math.max(0, ms - (Date.now() - started)), cwd);
  d.warnings.push(...(await notes));
  const { agentMessage } = await import('./policy.js');
  return { d, msg: agentMessage(d) };
}

const userLine = (d: HookDecision) => `pinright: ${stripInvisible(d.problems[0] ?? 'dependency check').text.replace(/\s+/g, ' ').slice(0, 300)}`;

/**
 * The answer in each agent's protocol. Agents without an "ask" (Codex, Gemini CLI,
 * Windsurf) get a deny for it: the change waits for a human either way.
 */
export function hookAnswer(agent: HookAgent, d: HookDecision, msg: string): { stdout?: string; stderr?: string; code: number } {
  const json = (o: unknown) => ({ stdout: JSON.stringify(o), code: 0 });
  const blocked = d.action !== 'allow';
  switch (agent) {
    case 'cursor':
      // Cursor treats invalid output as a block, so always answer.
      return json({ permission: d.action, ...(msg ? { agent_message: msg, user_message: blocked ? userLine(d) : undefined } : {}) });
    case 'gemini':
      if (blocked) return json({ decision: 'deny', reason: msg, systemMessage: userLine(d) });
      return msg ? json({ decision: 'allow', hookSpecificOutput: { hookEventName: 'BeforeTool', additionalContext: msg } }) : { code: 0 };
    case 'windsurf':
      // Exit 2 blocks a pre-hook and Cascade reads stderr; stdout goes nowhere the agent sees.
      return blocked ? { stderr: msg, code: 2 } : { code: 0 };
    case 'copilot': {
      // The Copilot harness reads the decision at the top level, VS Code's local harness under hookSpecificOutput.
      if (!blocked) return msg ? json({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } }) : json({});
      const reason = { permissionDecision: d.action, permissionDecisionReason: msg };
      return json({ ...reason, hookSpecificOutput: { hookEventName: 'PreToolUse', ...reason } });
    }
    default: {
      if (!blocked) return msg ? json({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } }) : { code: 0 };
      const action = agent === 'codex' ? 'deny' : d.action;
      return json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: action, permissionDecisionReason: msg } });
    }
  }
}

export async function runHook(agent: HookAgent): Promise<number> {
  const text = (await readStdin()) || '{}';
  try {
    JSON.parse(text);
  } catch {
    // Not silent: exit 1 is a non-blocking error the agent app shows to the user (docs/HOOK-THREAT-MODEL.md).
    process.stderr.write('pinright: the hook input is not JSON; nothing was checked.\n');
    return 1;
  }
  const raw = asObject(text);
  let result: { d: HookDecision; msg: string };
  try {
    const { inputs, cwd } = hookInputs(agent, raw);
    result = await evaluateHook(inputs, cwd);
  } catch (err) {
    // The input was valid JSON, so this is our bug, not the agent's: a human looks instead of a silent pass.
    const d: HookDecision = { action: 'ask', problems: [`pinright could not read this tool call (${(err as Error)?.message ?? err}); a human should approve it.`], warnings: [], checked: 0 };
    result = { d, msg: (await import('./policy.js')).agentMessage(d) };
  }
  const { d, msg } = result;
  const out = hookAnswer(agent, d, msg);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(`${out.stderr}\n`);
  return out.code;
}

export const runClaudeHook = () => runHook('claude');
export const runCursorHook = () => runHook('cursor');
