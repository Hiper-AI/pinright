// Runs the pinright pre-install hook (`pinright hook claude`) and appends one line per call to
// $PINRIGHT_HOOK_LOG: the tool, its command or file, and the decision the hook returned.
// Used only by the sandboxed shell arm; the hook's own stdin, stdout and exit code pass through.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const cli = process.env.PINRIGHT_CLI ?? '/opt/pinright/dist/cli.js';
const log = process.env.PINRIGHT_HOOK_LOG;

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = Buffer.concat(chunks);
const started = Date.now();

const child = spawn(process.execPath, [cli, 'hook', 'claude'], { stdio: ['pipe', 'pipe', 'pipe'] });
const out = [];
const err = [];
child.stdout.on('data', (c) => out.push(c));
child.stderr.on('data', (c) => err.push(c));
child.stdin.end(input);
const code = await new Promise((res) => child.on('close', (c) => res(c ?? 1)));
const stdout = Buffer.concat(out).toString('utf8');
const stderr = Buffer.concat(err).toString('utf8');

if (log) {
  let tool;
  let target;
  try {
    const j = JSON.parse(input.toString('utf8'));
    tool = j.tool_name;
    const ti = j.tool_input ?? {};
    target = typeof ti.command === 'string' ? ti.command : ti.file_path;
  } catch {
    // Logged as is: the hook reports bad input itself.
  }
  let decision = code === 0 ? 'allow' : 'error';
  let reason;
  let context = false;
  try {
    const o = stdout ? JSON.parse(stdout) : {};
    const h = o.hookSpecificOutput ?? {};
    if (h.permissionDecision) decision = h.permissionDecision;
    reason = h.permissionDecisionReason;
    context = Boolean(h.additionalContext);
  } catch {
    decision = 'unparsed';
  }
  const line = { at: new Date(started).toISOString(), ms: Date.now() - started, tool, target, decision, context, exitCode: code, reason, stderr: stderr || undefined };
  try {
    appendFileSync(log, `${JSON.stringify(line)}\n`);
  } catch {
    // A missing log never changes the hook's answer.
  }
}
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = code;
