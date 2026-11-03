/**
 * Runs Claude Code headless, one job per (arm, task, repetition), with only
 * Write and Read as built-in tools (by default) and the arm's MCP servers. Shared by the
 * agent benchmark (run.ts) and the docs benchmark (bench/docs/run.ts).
 * Each run writes <runDir>/<arm>/<task>-r<rep>/{work/,transcript.jsonl,meta.json}.
 *
 * With a sandbox, each job runs in a fresh Docker container (bench/agents/sandbox/) instead of
 * on the host: the agent may then have Bash and run real installs, install scripts included.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Job { arm: string; taskId: string; rep: number; prompt: string }

export interface Sandbox {
  /** Docker image built from bench/agents/sandbox/Dockerfile. */
  image: string;
  /** Host path of the Claude credentials file, mounted read-only and copied into a container-only HOME. */
  credentials: string;
}

export interface HarnessOptions {
  runDir: string;
  model: string;
  concurrency: number;
  /** MCP config per arm ({ mcpServers: {...} }). With a sandbox, paths in it are container paths. */
  mcp: Record<string, object>;
  /** Extra environment per arm; spawned MCP servers inherit it. */
  env?: (arm: string) => Record<string, string>;
  /** Settings file contents per arm (hooks), passed with --settings. */
  settings?: (arm: string) => object | undefined;
  /** Built-in tools (default Write, Read). */
  tools?: string[];
  /** Run every job in a disposable container instead of on the host. */
  sandbox?: Sandbox;
  maxTurns?: number;
  timeoutMs?: number;
}

/** Built-in tools from `--tools Write,Read,Bash`; Write and Read when absent. */
export function toolsArg(args: string[]): string[] {
  const i = args.indexOf('--tools');
  const tools = (i >= 0 ? args[i + 1] ?? '' : 'Write,Read').split(',').map((t) => t.trim()).filter(Boolean);
  if (!tools.length) throw new Error('--tools expects a comma-separated list, e.g. Write,Read,Bash');
  return tools;
}

/** Container name for a job: Docker allows [a-zA-Z0-9_.-], so the arm's "+" becomes "_". */
export const containerName = (job: Job, runDir: string) =>
  `pinright-bench-${runDir.split(/[\\/]/).pop()}-${job.arm}-${job.taskId}-r${job.rep}`.replace(/[^a-zA-Z0-9_.-]/g, '_');

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
  // Paths the agent's CLI sees: the job directory itself, or its mount point in the container.
  const seen = (file: string) => (o.sandbox ? `/job/${file}` : join(dir, file));
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify(o.mcp[job.arm], null, 2));
  // Every server of the arm's config is allowed, whatever its name.
  const servers = Object.keys((o.mcp[job.arm] as { mcpServers?: Record<string, unknown> }).mcpServers ?? {});
  const tools = o.tools ?? ['Write', 'Read'];
  const allowed = [...tools, ...servers.map((s) => `mcp__${s}`)];
  const cliArgs = [
    '-p', job.prompt,
    '--model', o.model,
    '--output-format', 'stream-json', '--verbose',
    '--tools', tools.join(','),
    '--allowedTools', ...allowed,
    '--permission-mode', 'acceptEdits',
    '--strict-mcp-config', '--mcp-config', seen('mcp.json'),
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--max-turns', String(o.maxTurns ?? 40),
  ];
  const settings = o.settings?.(job.arm);
  if (settings) {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
    cliArgs.push('--settings', seen('settings.json'));
  }
  const out = createWriteStream(join(dir, 'transcript.jsonl'));
  const err = createWriteStream(join(dir, 'stderr.log'));
  const started = Date.now();
  const armEnv = { PINRIGHT_NO_CACHE: '', ...(o.env?.(job.arm) ?? {}) };
  const name = containerName(job, o.runDir);
  return new Promise((res) => {
    let child;
    if (o.sandbox) {
      // Only the arm's variables enter the container, never the host environment (it holds tokens).
      const envArgs = Object.entries({ ...armEnv, PINRIGHT_HOOK_LOG: '/job/hook-events.jsonl' }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const dockerArgs = [
        'run', '--rm', '--name', name, '--label', 'pinright-bench=1',
        '--mount', `type=bind,source=${dir},target=/job`,
        '--mount', `type=bind,source=${o.sandbox.credentials},target=/creds/.credentials.json,readonly`,
        '--memory', '6g', '--cpus', '2',
        ...envArgs,
        o.sandbox.image, ...cliArgs,
      ];
      child = spawn('docker', dockerArgs, { env: process.env, windowsHide: true });
    } else {
      child = spawn('claude', cliArgs, { cwd: work, env: { ...process.env, ...armEnv }, windowsHide: true });
    }
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    // In the sandbox, copy the project out first (the agent's CLI may not answer a signal),
    // then stop the CLI, and kill the container a minute later if it is still up.
    const timers: NodeJS.Timeout[] = [];
    const stopAgent = () => {
      spawnSync('docker', ['exec', name, '/opt/pinright/bench/agents/sandbox/copy-out.sh'], { windowsHide: true, timeout: 120_000 });
      spawnSync('docker', ['exec', name, 'pkill', '-TERM', '-x', 'claude'], { windowsHide: true });
      timers.push(setTimeout(() => {
        spawnSync('docker', ['kill', name], { windowsHide: true });
        child.kill();
      }, 60_000));
    };
    if (o.sandbox) {
      // The CLI stays up after its final result while a background shell the agent started is
      // still running (seen: a `while ...; do sleep 5; done` wait loop); give it a grace period.
      let seenResult = false;
      child.stdout.on('data', (c: Buffer) => {
        if (seenResult || !c.toString('utf8').includes('"type":"result"')) return;
        seenResult = true;
        timers.push(setTimeout(stopAgent, 60_000));
      });
    }
    timers.push(setTimeout(() => (o.sandbox ? stopAgent() : child.kill()), o.timeoutMs ?? (o.sandbox ? 30 : 15) * 60_000));
    child.on('close', (code) => {
      timers.forEach(clearTimeout);
      const run = { tools, sandbox: o.sandbox ? o.sandbox.image : undefined };
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...job, prompt: undefined, model: o.model, ...run, exitCode: code, wallMs: Date.now() - started }, null, 2));
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
