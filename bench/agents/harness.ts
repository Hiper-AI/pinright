/**
 * Runs Claude Code headless, one job per (arm, task, repetition), with only
 * Write and Read as built-in tools and the arm's MCP servers. Shared by the
 * agent benchmark (run.ts) and the docs benchmark (bench/docs/run.ts).
 * Each run writes <runDir>/<arm>/<task>-r<rep>/{work/,transcript.jsonl,meta.json}.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Job { arm: string; taskId: string; rep: number; prompt: string }

export interface HarnessOptions {
  runDir: string;
  model: string;
  concurrency: number;
  /** MCP config per arm ({ mcpServers: {...} }). */
  mcp: Record<string, object>;
  /** Extra environment per arm; spawned MCP servers inherit it. */
  env?: (arm: string) => Record<string, string>;
  /** Settings file contents per arm (hooks), passed with --settings. */
  settings?: (arm: string) => object | undefined;
  maxTurns?: number;
  timeoutMs?: number;
}

/**
 * Extra arms from the command line: `--mcp-arm name=path/to/mcp.json` (repeatable),
 * where the file is a Claude Code MCP config ({ "mcpServers": { ... } }). Lets any
 * docs server be compared without the benchmark shipping its config.
 */
export function extraArms(args: string[]): Record<string, object> {
  const out: Record<string, object> = {};
  args.forEach((a, i) => {
    if (a !== '--mcp-arm') return;
    const m = (args[i + 1] ?? '').match(/^([\w.+-]+)=(.+)$/);
    if (!m) throw new Error('--mcp-arm expects name=path/to/mcp.json');
    out[m[1]] = JSON.parse(readFileSync(m[2], 'utf8'));
  });
  return out;
}

export function runPath(runDir: string, arm: string, taskId: string, rep: number): string {
  return join(runDir, arm, `${taskId}-r${rep}`);
}

/**
 * Does the transcript end in a successful result? Parsed, not matched as text: newer Claude Code
 * versions put other keys between "type" and "subtype", and a text match then reran every job.
 */
export function succeeded(transcript: string): boolean {
  return transcript.split('\n').some((l) => {
    if (!l.includes('"result"')) return false;
    try {
      const j = JSON.parse(l);
      return j.type === 'result' && j.subtype === 'success';
    } catch {
      return false;
    }
  });
}

/** Every (rep, task, arm) job; with resume, skips runs whose transcript ends in a successful result. */
export function planJobs(
  tasks: { id: string; prompt: string }[],
  arms: string[],
  reps: number,
  opts: { runDir: string; resume: boolean; suffix?: string },
): Job[] {
  const jobs: Job[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const t of tasks) {
      for (const arm of arms) {
        if (opts.resume) {
          const dir = runPath(opts.runDir, arm, t.id, rep);
          const tr = join(dir, 'transcript.jsonl');
          if (existsSync(tr) && succeeded(readFileSync(tr, 'utf8'))) continue;
          rmSync(dir, { recursive: true, force: true });
        }
        jobs.push({ arm, taskId: t.id, rep, prompt: opts.suffix ? `${t.prompt}\n\n${opts.suffix}` : t.prompt });
      }
    }
  }
  return jobs;
}

function runOne(job: Job, o: HarnessOptions): Promise<number> {
  const dir = runPath(o.runDir, job.arm, job.taskId, job.rep);
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  const mcpPath = join(dir, 'mcp.json');
  writeFileSync(mcpPath, JSON.stringify(o.mcp[job.arm], null, 2));
  // Every server of the arm's config is allowed, whatever its name.
  const servers = Object.keys((o.mcp[job.arm] as { mcpServers?: Record<string, unknown> }).mcpServers ?? {});
  const allowed = ['Write', 'Read', ...servers.map((s) => `mcp__${s}`)];
  const cliArgs = [
    '-p', job.prompt,
    '--model', o.model,
    '--output-format', 'stream-json', '--verbose',
    '--tools', 'Write,Read',
    '--allowedTools', ...allowed,
    '--permission-mode', 'acceptEdits',
    '--strict-mcp-config', '--mcp-config', mcpPath,
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--max-turns', String(o.maxTurns ?? 40),
  ];
  const settings = o.settings?.(job.arm);
  if (settings) {
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    cliArgs.push('--settings', settingsPath);
  }
  const out = createWriteStream(join(dir, 'transcript.jsonl'));
  const err = createWriteStream(join(dir, 'stderr.log'));
  const started = Date.now();
  return new Promise((res) => {
    const env = { ...process.env, PINRIGHT_NO_CACHE: '', ...(o.env?.(job.arm) ?? {}) };
    const child = spawn('claude', cliArgs, { cwd: work, env, windowsHide: true });
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 15 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...job, prompt: undefined, model: o.model, exitCode: code, wallMs: Date.now() - started }, null, 2));
      console.log(`${job.arm.padEnd(12)} ${job.taskId}-r${job.rep} exit=${code} ${Math.round((Date.now() - started) / 1000)}s`);
      res(code ?? -1);
    });
  });
}

export async function runJobs(jobs: Job[], o: HarnessOptions): Promise<void> {
  console.log(`${jobs.length} runs -> ${o.runDir}`);
  let next = 0;
  await Promise.all(Array.from({ length: o.concurrency }, async () => {
    while (next < jobs.length) await runOne(jobs[next++], o);
  }));
  console.log('done');
}
