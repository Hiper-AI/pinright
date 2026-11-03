import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseApplyPatch } from '../src/hook/applyPatch.js';
import { evaluateHook, hookAnswer, hookInputs, intentsFromToolInput, writtenPath } from '../src/hook/run.js';
import type { HookDecision } from '../src/hook/policy.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinright-hook-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// The dependencies the hook judges; unchanged lines that ride along for range checks are left out.
const deps = (inputs: Record<string, unknown>[], cwd: string) =>
  inputs
    .flatMap((i) => intentsFromToolInput('', i, cwd))
    .filter((i) => !i.contextOnly)
    .map((i) => `${i.ecosystem}:${i.name}${i.spec ? ` ${i.spec}` : ''}`);

describe('each agent stdin -> the same tool inputs', () => {
  it('Claude Code and Codex Bash: tool_input.command', () => {
    for (const agent of ['claude', 'codex'] as const) {
      const { inputs, cwd } = hookInputs(agent, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm i axios@1.7.9' } });
      expect(cwd).toBe(dir);
      expect(deps(inputs, cwd)).toEqual(['npm:axios 1.7.9']);
    }
  });

  it('Cursor beforeShellExecution: command at the top level, workspace root as cwd', () => {
    const { inputs, cwd } = hookInputs('cursor', { command: 'pip install requests==2.31.0', workspace_roots: [dir] });
    expect(cwd).toBe(dir);
    expect(deps(inputs, cwd)).toEqual(['pypi:requests ==2.31.0']);
  });

  it('Gemini CLI: run_shell_command in a subdirectory, write_file and replace', () => {
    fs.mkdirSync(path.join(dir, 'web'));
    const shell = hookInputs('gemini', { cwd: dir, tool_name: 'run_shell_command', tool_input: { command: 'pnpm add zod@3.25.76', directory: 'web' } });
    expect(shell.cwd).toBe(path.join(dir, 'web'));
    expect(deps(shell.inputs, shell.cwd)).toEqual(['npm:zod 3.25.76']);
    const written = hookInputs('gemini', { cwd: dir, tool_name: 'write_file', tool_input: { file_path: 'requirements.txt', content: 'flask==3.0.0\n' } });
    expect(deps(written.inputs, written.cwd)).toEqual(['pypi:flask ==3.0.0']);
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask==3.0.0\n');
    const replaced = hookInputs('gemini', { cwd: dir, tool_name: 'replace', tool_input: { file_path: 'requirements.txt', old_string: 'flask==3.0.0', new_string: 'flask==3.0.0\nhttpx==0.27.0' } });
    expect(deps(replaced.inputs, replaced.cwd)).toContain('pypi:httpx ==0.27.0');
  });

  it('VS Code / Copilot: snake_case (PreToolUse) or camelCase with toolArgs as a JSON string', () => {
    const snake = hookInputs('copilot', { cwd: dir, tool_name: 'runInTerminal', tool_input: { command: 'cargo add serde@1.0.200' } });
    expect(deps(snake.inputs, snake.cwd)).toEqual(['cargo:serde 1.0.200']);
    const camel = hookInputs('copilot', { cwd: dir, toolName: 'bash', toolArgs: JSON.stringify({ command: 'gem install rails -v 7.1.0' }) });
    expect(deps(camel.inputs, camel.cwd)).toEqual(['rubygems:rails 7.1.0']);
  });

  it('Windsurf: tool_info.command_line, and pre_write_code edits (a new file too)', () => {
    const run = hookInputs('windsurf', { agent_action_name: 'pre_run_command', tool_info: { command_line: 'npm install lodash@4.17.20', cwd: dir } });
    expect(run.cwd).toBe(dir);
    expect(deps(run.inputs, run.cwd)).toEqual(['npm:lodash 4.17.20']);
    const file = path.join(dir, 'requirements.txt');
    const created = hookInputs('windsurf', { agent_action_name: 'pre_write_code', tool_info: { file_path: file, edits: [{ old_string: '', new_string: 'django==4.2.0\n' }] } });
    expect(deps(created.inputs, dir)).toEqual(['pypi:django ==4.2.0']);
    fs.writeFileSync(file, 'django==4.2.0\n');
    const edited = hookInputs('windsurf', { agent_action_name: 'pre_write_code', tool_info: { file_path: file, edits: [{ old_string: 'django==4.2.0', new_string: 'django==5.0.0' }] } });
    expect(deps(edited.inputs, dir)).toEqual(['pypi:django ==5.0.0']);
  });

  it('Codex apply_patch: every added or updated file is a write', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { zod: '3.22.0' } }, null, 2));
    const patch = [
      '*** Begin Patch',
      '*** Add File: requirements.txt',
      '+requests==2.31.0',
      '*** Update File: package.json',
      '@@',
      ' {',
      '   "dependencies": {',
      '-    "zod": "3.22.0"',
      '+    "zod": "3.25.76"',
      '   }',
      '*** Delete File: old.txt',
      '*** End Patch',
    ].join('\n');
    const { inputs, cwd } = hookInputs('codex', { cwd: dir, tool_name: 'apply_patch', tool_input: { command: patch } });
    expect(inputs.map((i) => i.file_path)).toEqual(['requirements.txt', 'package.json', 'old.txt']);
    expect(deps(inputs, cwd)).toEqual(['pypi:requests ==2.31.0', 'npm:zod 3.25.76']);
  });

  it('Codex apply_patch: Move to onto a manifest, and deleting the policy (security review, round 2)', () => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'flask==3.0.0\n');
    const moved = ['*** Begin Patch', '*** Update File: notes.txt', '*** Move to: requirements.txt', '@@', ' flask==3.0.0', '+reqeusts==2.31.0', '*** End Patch'].join('\n');
    const m = hookInputs('codex', { cwd: dir, tool_name: 'apply_patch', tool_input: { command: moved } });
    expect(deps(m.inputs, m.cwd)).toEqual(['pypi:flask ==3.0.0', 'pypi:reqeusts ==2.31.0']);
    // A pure rename, no hunk: the source's content lands in the manifest.
    const renamed = ['*** Begin Patch', '*** Update File: notes.txt', '*** Move to: requirements.txt', '*** End Patch'].join('\n');
    const r = hookInputs('codex', { cwd: dir, tool_name: 'apply_patch', tool_input: { command: renamed } });
    expect(deps(r.inputs, r.cwd)).toEqual(['pypi:flask ==3.0.0']);
    fs.writeFileSync(path.join(dir, '.pinright.json'), '{"deny":["expresss"]}');
    const del = hookInputs('codex', { cwd: dir, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Delete File: .pinright.json\n*** End Patch' } });
    expect(del.inputs.flatMap((i) => intentsFromToolInput('', i, del.cwd)).map((i) => i.unverifiable?.level)).toEqual(['guard']);
    const away = hookInputs('codex', { cwd: dir, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: .pinright.json\n*** Move to: old.json\n*** End Patch' } });
    expect(away.inputs.flatMap((i) => intentsFromToolInput('', i, away.cwd)).map((i) => i.unverifiable?.level)).toEqual(['guard']);
  });
});

describe('the file the OS writes, not the name the agent typed (security review, round 2)', () => {
  it('strips an NTFS stream suffix', () => {
    expect(writtenPath('C:\\p\\package.json::$DATA', 'win32')).toBe('C:\\p\\package.json');
    expect(writtenPath('C:\\p\\.pinright.json:x', 'win32')).toBe('C:\\p\\.pinright.json');
    expect(writtenPath('/p/a:b', 'linux')).toBe('/p/a:b');
  });

  it.runIf(process.platform === 'win32')('package.json::$DATA is a write of package.json', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{}}');
    const write = { file_path: path.join(dir, 'package.json::$DATA'), content: '{"dependencies":{"expresss":"1.0.0"}}' };
    expect(deps([write], dir)).toEqual(['npm:expresss 1.0.0']);
  });

  it('a write through a link to a manifest is a write of that manifest', (t) => {
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask==3.0.0\n');
    try {
      fs.symlinkSync(path.join(dir, 'requirements.txt'), path.join(dir, 'notes.txt'), 'file');
    } catch {
      return t.skip(); // symlinks need a privilege on Windows
    }
    const edit = { file_path: path.join(dir, 'notes.txt'), old_string: 'flask==3.0.0', new_string: 'flask==3.0.0\nreqeusts==2.31.0' };
    expect(deps([edit], dir)).toEqual(['pypi:reqeusts ==2.31.0']);
  });
});

describe('parseApplyPatch', () => {
  it('reads argv form, several hunks, and ignores what is not a patch', () => {
    const files = parseApplyPatch(['apply_patch', '*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n@@ ctx\n k\n-z\n+w\n*** End of File\n*** End Patch\n']);
    expect(files).toEqual([{ file_path: 'a.txt', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'k\nz', new_string: 'k\nw' }] }]);
    expect(parseApplyPatch('echo hi')).toEqual([]);
    expect(parseApplyPatch(undefined)).toEqual([]);
  });
});

describe('each agent gets the answer in its own protocol', () => {
  const deny: HookDecision = { action: 'deny', problems: ['axios@0.21.0 has GHSA-x'], warnings: [], checked: 1 };
  const ask: HookDecision = { action: 'ask', problems: ['lib@1 has a critical advisory and no fix'], warnings: [], checked: 1 };
  const notes: HookDecision = { action: 'allow', problems: [], warnings: ['note'], checked: 1 };
  const clean: HookDecision = { action: 'allow', problems: [], warnings: [], checked: 1 };
  const parse = (s?: string) => (s ? JSON.parse(s) : undefined);

  it('Claude Code: permissionDecision in hookSpecificOutput, ask kept', () => {
    expect(parse(hookAnswer('claude', ask, 'm').stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'm' } });
    expect(parse(hookAnswer('claude', notes, 'n').stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'n' } });
    expect(hookAnswer('claude', clean, '')).toEqual({ code: 0 });
  });

  it('Codex: Claude shape, and "ask" (unsupported there) becomes deny', () => {
    expect(parse(hookAnswer('codex', ask, 'm').stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(hookAnswer('codex', deny, 'm').code).toBe(0);
  });

  it('Cursor: always answers, with a short user_message when blocked', () => {
    expect(parse(hookAnswer('cursor', clean, '').stdout)).toEqual({ permission: 'allow' });
    expect(parse(hookAnswer('cursor', deny, 'm').stdout)).toEqual({ permission: 'deny', agent_message: 'm', user_message: 'pinright: axios@0.21.0 has GHSA-x' });
  });

  it('Gemini CLI: decision deny with the reason; notes as additionalContext', () => {
    expect(parse(hookAnswer('gemini', ask, 'm').stdout)).toMatchObject({ decision: 'deny', reason: 'm' });
    expect(parse(hookAnswer('gemini', notes, 'n').stdout)).toEqual({ decision: 'allow', hookSpecificOutput: { hookEventName: 'BeforeTool', additionalContext: 'n' } });
    expect(hookAnswer('gemini', clean, '')).toEqual({ code: 0 });
  });

  it('VS Code / Copilot: decision at the top level and in hookSpecificOutput; {} for nothing', () => {
    const out = parse(hookAnswer('copilot', deny, 'm').stdout);
    expect(out.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parse(hookAnswer('copilot', clean, '').stdout)).toEqual({});
  });

  it('Windsurf: exit 2 with the reason on stderr blocks; anything else proceeds', () => {
    expect(hookAnswer('windsurf', deny, 'm')).toEqual({ stderr: 'm', code: 2 });
    expect(hookAnswer('windsurf', ask, 'm').code).toBe(2);
    expect(hookAnswer('windsurf', notes, 'n')).toEqual({ code: 0 });
  });
});

describe('evaluateHook', () => {
  it('a change that is not a dependency is allowed without a lookup', async () => {
    const { d, msg } = await evaluateHook([{ command: 'ls -la' }, { file_path: 'notes.txt', content: 'hi' }], dir, 1000);
    expect(d.action).toBe('allow');
    expect(msg).toBe('');
  });
});
