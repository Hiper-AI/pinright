/**
 * `pinright doctor`: is this machine set up to give honest answers? Node, each
 * upstream (with its latency), the cache, GitHub auth, which agents have pinright
 * wired, and the team policy file. It only reads: client configs are never
 * written, and a token is never printed (only where it comes from).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { cacheStats } from './cache.js';
import { config } from './config.js';
import { paint } from './cliHelp.js';
import { GITHUB_API, ghCliLoggedIn, ghCliOptIn, githubJson } from './github.js';
import { USER_AGENT } from './http.js';
import { PKG_NAME, PKG_VERSION, SERVER_KEY } from './pkg.js';
import { CLIENTS, type Ctx } from './clients/registry.js';
import { hasLegacyEntry, legacySibling, OLD_NAME } from './clients/legacy.js';
import { loadTeamConfig } from './teamConfig.js';

export type Status = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  name: string;
  status: Status;
  detail: string;
  ms?: number;
}

export interface ClientWiring {
  client: string;
  file: string;
  scope: 'project' | 'user';
  mcp: boolean;
  /** Undefined where the client has no hook pinright can use. */
  hook?: boolean;
  /** Files that still hold entries written under the project's old name (clients/legacy.ts). */
  legacy?: string[];
}

export interface DoctorReport {
  version: string;
  ok: boolean;
  checks: Check[];
  clients: ClientWiring[];
}

const ENGINES = '>=20.9.0';
const PROBE_TIMEOUT_MS = 5_000;

export function nodeCheck(version = process.version): Check {
  const ok = semver.satisfies(version, ENGINES);
  return { name: 'node', status: ok ? 'ok' : 'fail', detail: `Node ${version}${ok ? '' : `; pinright needs ${ENGINES}`}` };
}

interface Probe {
  name: string;
  /** What pinright loses without it. */
  role: string;
  url: string;
  method?: 'GET' | 'HEAD' | 'POST';
  body?: unknown;
  /** The verdict cannot be given without it. */
  core?: boolean;
}

export function probes(): Probe[] {
  return [
    { name: 'deps.dev', role: 'versions and advisories (the verdict)', url: `${config.depsDevBaseUrl}/v3/systems/npm/packages/left-pad`, core: true },
    {
      name: 'osv.dev',
      role: 'advisory details and malware reports (the verdict)',
      url: `${config.osvBaseUrl}/v1/query`,
      method: 'POST',
      body: { package: { name: 'left-pad', ecosystem: 'npm' }, version: '1.3.0' },
      core: true,
    },
    { name: 'registry.npmjs.org', role: 'install scripts, provenance, publisher (npm)', url: 'https://registry.npmjs.org/-/ping' },
    { name: 'pypi.org', role: 'PyPI files and metadata', url: 'https://pypi.org/pypi/idna/json', method: 'HEAD' },
    { name: 'repo.packagist.org', role: 'Composer versions and advisories', url: 'https://repo.packagist.org/p2/monolog/monolog.json', method: 'HEAD' },
    { name: 'data.jsdelivr.com', role: 'repository file listings for get-docs', url: 'https://data.jsdelivr.com/v1/packages/npm/left-pad' },
    { name: 'cdn.jsdelivr.net', role: 'package and repository files for get-docs', url: 'https://cdn.jsdelivr.net/npm/left-pad@1.3.0/package.json', method: 'HEAD' },
  ];
}

/** Reachable means any HTTP answer below 500: a 404 still proves the host is up. */
export async function probe(p: Probe, fetchImpl: typeof fetch = fetch): Promise<Check> {
  const t0 = performance.now();
  try {
    const res = await fetchImpl(p.url, {
      method: p.method ?? 'GET',
      headers: { 'user-agent': USER_AGENT, ...(p.body ? { 'content-type': 'application/json' } : {}) },
      body: p.body ? JSON.stringify(p.body) : undefined,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const ms = Math.round(performance.now() - t0);
    await res.body?.cancel().catch(() => {});
    if (res.status >= 500) return { name: p.name, status: p.core ? 'fail' : 'warn', ms, detail: `HTTP ${res.status}; without it: ${p.role}` };
    return { name: p.name, status: 'ok', ms, detail: p.role };
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    const e = err as { name?: string; cause?: { code?: string } };
    const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? `no answer within ${PROBE_TIMEOUT_MS / 1000} s` : (e.cause?.code ?? (err as Error).message);
    return { name: p.name, status: p.core ? 'fail' : 'warn', ms, detail: `unreachable (${why}); without it: ${p.role}` };
  }
}

export function cacheCheck(dir = config.cacheDir): Check {
  if (config.cacheDisabled) return { name: 'cache', status: 'warn', detail: `disabled (PINRIGHT_NO_CACHE=1): every check goes to the network` };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probeFile = path.join(dir, `.doctor-${process.pid}`);
    fs.writeFileSync(probeFile, 'ok');
    fs.rmSync(probeFile, { force: true });
  } catch (err) {
    return { name: 'cache', status: 'fail', detail: `${dir} is not writable (${(err as Error).message}); set PINRIGHT_CACHE_DIR` };
  }
  const s = cacheStats(dir);
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const over = s.bytes > config.cacheMaxBytes;
  return {
    name: 'cache',
    status: over ? 'warn' : 'ok',
    detail: `${dir}: ${s.files} entries, ${mb(s.bytes)} (cap ${mb(config.cacheMaxBytes)}${over ? '; run "pinright cache prune"' : ''})`,
  };
}

/** Where the GitHub token comes from, and what is left of the hourly budget. Never the token itself. */
export async function githubCheck(offline: boolean): Promise<Check> {
  const env = process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : process.env.GH_TOKEN ? 'GH_TOKEN' : undefined;
  let mode: string;
  if (env) mode = `token from ${env}`;
  else if (ghCliOptIn()) mode = ghCliLoggedIn() ? 'token from the GitHub CLI login (PINRIGHT_GH_CLI=1)' : 'PINRIGHT_GH_CLI=1, but the GitHub CLI is not logged in: anonymous';
  else mode = `anonymous (60 requests an hour per IP)${ghCliLoggedIn() ? '; the GitHub CLI is logged in, opt in with PINRIGHT_GH_CLI=1 or "pinright init --gh-cli"' : ''}`;
  if (offline) return { name: 'github', status: 'skip', detail: mode };
  const t0 = performance.now();
  try {
    // /rate_limit itself does not count against the budget.
    const r = await githubJson<{ resources?: { core?: { limit: number; remaining: number; reset: number } } }>('/rate_limit', { what: 'the rate limit' });
    const core = r.resources?.core;
    const ms = Math.round(performance.now() - t0);
    if (!core) return { name: 'github', status: 'ok', ms, detail: mode };
    const reset = new Date(core.reset * 1000).toISOString().slice(11, 16);
    const low = core.remaining < Math.min(10, core.limit / 10);
    return { name: 'github', status: low ? 'warn' : 'ok', ms, detail: `${mode}; ${core.remaining}/${core.limit} API requests left until ${reset} UTC` };
  } catch (err) {
    return { name: 'github', status: 'warn', ms: Math.round(performance.now() - t0), detail: `${mode}; ${GITHUB_API} did not answer (${(err as Error).message})` };
  }
}

export function policyCheck(cwd = process.cwd()): Check {
  const team = loadTeamConfig(cwd);
  if (!team.file) return { name: '.pinright.json', status: 'ok', detail: 'none found from here up; built-in defaults apply ("pinright init" writes a starter)' };
  if (team.error) return { name: '.pinright.json', status: 'fail', detail: `${team.error} The hook denies dependency changes until it is fixed.` };
  return { name: '.pinright.json', status: 'ok', detail: `${team.file} is valid` };
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Whether a config file names pinright: the server key, the package, or a local checkout's cli.js. */
const namesUs = (text: string) => text.includes(SERVER_KEY) || text.includes(PKG_NAME) || /dist[\\/]+cli\.js/.test(text);

function shown(file: string, cwd: string, home: string): string {
  const rel = path.relative(cwd, file);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  const fromHome = path.relative(home, file);
  return !fromHome.startsWith('..') && !path.isAbsolute(fromHome) ? `~/${fromHome.replace(/\\/g, '/')}` : file;
}

/**
 * Which agents have pinright configured, per client and scope, from the same
 * registry `init` writes with (src/clients/registry.ts): the MCP config files
 * and the hook file of each client that is installed or present in the project.
 * Only reads, and only the client's own config paths.
 */
export function clientWiring(cwd = process.cwd(), home = os.homedir(), platform = process.platform, env: Record<string, string | undefined> = process.env): ClientWiring[] {
  const ctx: Ctx = { cwd, home, platform, env };
  const launch = { command: 'npx', args: ['-y', PKG_NAME] };
  const out: ClientWiring[] = [];
  for (const c of CLIENTS) {
    const scopes = [...new Set([...c.mcpScopes, ...(c.hook?.scopes ?? [])])];
    for (const scope of scopes) {
      let mcpFiles: string[] = [];
      let hookFile: string | undefined;
      try {
        mcpFiles = c.mcpScopes.includes(scope) && c.mcp ? c.mcp(scope, ctx, launch, () => undefined).map((w) => w.file) : [];
        hookFile = c.hook?.scopes.includes(scope) ? c.hook.write(scope, ctx, '').file : undefined;
      } catch {
        continue; // a client whose paths cannot be worked out here
      }
      const ours = [...mcpFiles, ...(hookFile ? [hookFile] : [])];
      const files = ours.filter((f, k, all) => all.indexOf(f) === k && fs.existsSync(f));
      const oldFiles = ours.map((f) => legacySibling(f, SERVER_KEY)).filter((f): f is string => Boolean(f && fs.existsSync(f)));
      if (!files.length && !oldFiles.length) continue;
      const legacy = [...files.filter((f) => hasLegacyEntry(readText(f) ?? '')), ...oldFiles].map((f) => shown(f, cwd, home));
      const mcp = mcpFiles.some((f) => namesUs(readText(f) ?? ''));
      const hookText = hookFile ? (readText(hookFile) ?? '') : '';
      const hook = c.hook?.scopes.includes(scope) ? namesUs(hookText) && new RegExp(`\\bhook\\s+${c.hook.agent}\\b`).test(hookText) : undefined;
      out.push({ client: c.title, file: files.map((f) => shown(f, cwd, home)).join(', '), scope, mcp, ...(hook === undefined ? {} : { hook }), ...(legacy.length ? { legacy } : {}) });
    }
  }
  return out;
}

/** How long `pinright hook claude` takes for a command that installs nothing: the cost of every agent command. */
export function hookStartup(cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js')): Promise<Check> {
  return new Promise((resolve) => {
    if (!fs.existsSync(cli)) {
      resolve({ name: 'hook startup', status: 'skip', detail: 'not built (dist/cli.js missing)' });
      return;
    }
    const t0 = performance.now();
    const child = spawn(process.execPath, [cli, 'hook', 'claude'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.on('error', () => resolve({ name: 'hook startup', status: 'warn', detail: 'could not start node' }));
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Math.round(performance.now() - t0);
      resolve({
        name: 'hook startup',
        status: code === 0 && ms < 1500 ? 'ok' : 'warn',
        ms,
        detail: `"npm test" through the Claude Code hook, node start included${code === 0 ? '' : `; exited ${code}`}`,
      });
    });
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: os.tmpdir() }));
  });
}

export async function runDoctor(opts: { offline?: boolean; cwd?: string } = {}): Promise<DoctorReport> {
  const cwd = opts.cwd ?? process.cwd();
  const network = opts.offline
    ? probes().map((p): Check => ({ name: p.name, status: 'skip', detail: '--offline' }))
    : await Promise.all(probes().map((p) => probe(p)));
  const [gh, startup] = await Promise.all([githubCheck(Boolean(opts.offline)), hookStartup()]);
  const checks = [nodeCheck(), ...network, gh, cacheCheck(), policyCheck(cwd), startup];
  const clients = clientWiring(cwd);
  return { version: PKG_VERSION, ok: !checks.some((c) => c.status === 'fail'), checks, clients };
}

export function formatDoctor(r: DoctorReport, color = false): string {
  const p = paint(color);
  const tag: Record<Status, string> = { ok: p.green('ok  '), warn: p.yellow('warn'), fail: p.red('FAIL'), skip: p.dim('skip') };
  const width = Math.max(...r.checks.map((c) => c.name.length));
  const lines = [`pinright ${r.version} doctor`, ''];
  for (const c of r.checks) {
    const ms = c.ms !== undefined ? `${String(c.ms).padStart(5)} ms  ` : '          ';
    lines.push(`  ${tag[c.status]}  ${c.name.padEnd(width)}  ${ms}${c.detail}`);
  }
  lines.push('', 'Agents (read-only; nothing was changed):');
  if (!r.clients.length) lines.push('  no agent config found here or in your home directory. Run "pinright init claude" or "pinright init cursor".');
  for (const w of r.clients) {
    const mcp = w.mcp ? p.green('MCP server') : p.dim('no MCP server');
    const hook = w.hook === undefined ? '' : w.hook ? `, ${p.green('hook wired')}` : `, ${p.yellow('no hook')}`;
    lines.push(`  ${w.client} (${w.scope}: ${w.file}): ${mcp}${hook}`);
    if (w.legacy) lines.push(`    ${p.yellow('old entries')} written under the former name ${OLD_NAME} in ${w.legacy.join(', ')}: run "${PKG_NAME} init" for this client again to replace them`);
  }
  const anyHook = r.clients.some((w) => w.hook);
  if (r.clients.length && !anyHook) lines.push('  No pre-install hook is wired: installs are not checked unless the agent calls the MCP tools.');
  const core = r.checks.some((c) => c.status === 'fail' && (c.name === 'deps.dev' || c.name === 'osv.dev'));
  lines.push(
    '',
    r.ok
      ? 'No blocking problem found.'
      : p.red(`A check failed (FAIL above).${core ? ' Without deps.dev and osv.dev every verdict is "unknown" and the hook follows its onError policy.' : ''}`),
  );
  return lines.join('\n');
}
