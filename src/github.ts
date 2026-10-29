/**
 * The GitHub REST API, the one upstream with a hard hourly budget: 60 requests
 * an hour per IP without a token, 5,000 with one. Repo listings and files come
 * from jsDelivr first (docs/sources.ts) and tags from the git protocol
 * (actions/github.ts); what still needs the API goes through here, which
 *   - adds a token when there is one: GITHUB_TOKEN, GH_TOKEN or, only with
 *     SAFECTX_GH_CLI=1, the GitHub CLI's login (`gh auth token`, read once on
 *     first need);
 *   - sends it only to the API origin over HTTPS: never to a log, a cache key,
 *     an error message or tool output;
 *   - stops calling once GitHub says the budget is spent, until it resets (the
 *     stop is shared with other safectx processes through the cache), and
 *     records what was skipped so the answer can say so (trackGitHub).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, spawnSync } from 'node:child_process';
import { cacheGet, cacheSet } from './cache.js';
import { getJson, getText, HttpError } from './http.js';

export const GITHUB_API = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');

// ------------------------------------------------------------------ token ---

/** Opt-in: the CLI's token usually carries the user's full scopes (repo, workflow), more than reading public repos needs. */
export function ghCliOptIn(): boolean {
  return process.env.SAFECTX_GH_CLI === '1';
}

/** Whether a token is configured; the CLI's counts once opted in, although it is only read on first use. */
export function githubAuthConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ghCliOptIn());
}

let cliToken: Promise<string | undefined> | undefined;

function readGhCli(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['auth', 'token', '--hostname', 'github.com'],
      { timeout: 5000, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
      // Whatever goes wrong (no gh, not logged in), anonymous; the output is never logged.
      (err, stdout) => {
        const token = err ? '' : String(stdout).trim();
        resolve(/^[A-Za-z0-9_]{20,255}$/.test(token) ? token : undefined);
      },
    );
  });
}

async function githubToken(): Promise<string | undefined> {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  if (!ghCliOptIn()) return undefined;
  cliToken ??= readGhCli();
  return cliToken;
}

/** Whether the GitHub CLI is installed and logged in to github.com (exit code only; its output is discarded). */
export function ghCliLoggedIn(): boolean {
  const r = spawnSync('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
  return r.status === 0;
}

/** What `safectx init` tells the user about GitHub auth. It never writes a token anywhere. */
export function githubAuthAdvice(s: { envToken: boolean; ghLoggedIn: boolean; optIn: boolean }): string {
  if (s.optIn && s.ghLoggedIn) {
    return 'GitHub: added SAFECTX_GH_CLI=1 to the MCP entry. safectx asks `gh auth token` for the token the first time it needs the GitHub API; the token itself is not written to any file.';
  }
  if (s.optIn) {
    return 'GitHub: added SAFECTX_GH_CLI=1 to the MCP entry, but the GitHub CLI is not installed or not logged in (`gh auth login`). Until it is, safectx works without a token.';
  }
  if (s.envToken) {
    return 'GitHub: GITHUB_TOKEN/GH_TOKEN is set in this shell. safectx uses it when the agent starts from an environment that has it; it is not written to any file.';
  }
  if (s.ghLoggedIn) {
    return (
      'GitHub: the GitHub CLI is logged in, but safectx does not read its token unless you opt in with `safectx init --gh-cli`. ' +
      "That token carries your account's full scopes; a fine-grained GITHUB_TOKEN with read-only access to public repositories is the narrower choice."
    );
  }
  return (
    'GitHub: no token. safectx works anonymously (repo docs come from jsDelivr and Actions refs from git, so most sessions stay under ' +
    "GitHub's 60 API requests an hour). For 5,000, export GITHUB_TOKEN in the environment that starts your agent; do not put it in .mcp.json."
  );
}

/**
 * The env of safectx's MCP entry: what the user already had, plus or minus
 * SAFECTX_GH_CLI. A token found there is left alone (it is the user's file) but
 * flagged, since a project file is easy to commit.
 */
export function mcpEntryEnv(previous: Record<string, string> | undefined, optIn: boolean): { env?: Record<string, string>; warnings: string[] } {
  const env = { ...(previous ?? {}) };
  if (optIn) env.SAFECTX_GH_CLI = '1';
  else delete env.SAFECTX_GH_CLI;
  const warnings = Object.keys(env)
    .filter((k) => /token|secret|key/i.test(k))
    .map((k) => `${k} is set in this MCP entry: a credential in a project file is easy to commit. Prefer the environment the agent starts with.`);
  return { env: Object.keys(env).length ? env : undefined, warnings };
}

/** The token goes to the API origin over HTTPS and nowhere else. */
function mayAuthenticate(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.origin === new URL(GITHUB_API).origin;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- rate limit ---

const HOUR = 3600_000;
const blocks = new Map<string, number>();
const blockKey = (authenticated: boolean) => `gh:ratelimit:${authenticated ? 'token' : 'anon'}`;

function blockedUntil(authenticated: boolean, now = Date.now()): number | undefined {
  // What another process wrote is believed only within the 2-hour cap limitedUntil applies.
  const shared = Math.min(Number(cacheGet<number>(blockKey(authenticated))) || 0, now + 2 * HOUR);
  const until = Math.max(blocks.get(blockKey(authenticated)) ?? 0, shared);
  return until > now ? until : undefined;
}

function block(authenticated: boolean, until: number): void {
  blocks.set(blockKey(authenticated), until);
  // On disk too: the hook is a new process each time and would spend a request to learn the same thing.
  cacheSet(blockKey(authenticated), until, until - Date.now());
}

/**
 * When GitHub says to stop, until when (ms). Primary limit: 403/429 with
 * x-ratelimit-remaining 0, until x-ratelimit-reset. Secondary limit: retry-after,
 * or a 429 without it (a minute). A 403 without these headers is a permission error.
 */
export function limitedUntil(err: unknown, now = Date.now()): number | undefined {
  if (!(err instanceof HttpError) || (err.status !== 403 && err.status !== 429)) return undefined;
  let until: number | undefined;
  if (err.retryAfterSec !== undefined) until = now + err.retryAfterSec * 1000;
  else if (err.rateLimit?.remaining === 0 && err.rateLimit.resetSec) until = err.rateLimit.resetSec * 1000;
  else if (err.status === 429) until = now + 60_000;
  // A reset in the past (clock skew) still means "not now"; one in the far future is not believed.
  return until === undefined ? undefined : Math.min(Math.max(until, now + 30_000), now + 2 * HOUR);
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

export class GitHubRateLimitError extends HttpError {
  constructor(
    url: string,
    public readonly until: number,
    public readonly authenticated: boolean,
  ) {
    // 429 so callers that already treat 403/429 as "rate limited" keep doing so.
    super(429, url, Math.max(1, Math.ceil((until - Date.now()) / 1000)));
    this.name = 'GitHubRateLimitError';
    this.message = `GitHub API rate limit reached (${authenticated ? 'token' : 'no token'}); safectx stops calling it until ${hhmm(until)} UTC`;
  }
}

// ------------------------------------------------------- what was skipped ---

interface Skipped {
  what: Set<string>;
  until: number;
  authenticated: boolean;
}

const scope = new AsyncLocalStorage<Skipped>();

function note(what: string, until: number, authenticated: boolean): void {
  const s = scope.getStore();
  if (!s) return;
  s.what.add(what);
  s.until = Math.max(s.until, until);
  s.authenticated = authenticated;
}

/** The line a tool answer ends with when the GitHub limit left something out. */
export function githubNotice(what: string[], until: number, authenticated: boolean, now = Date.now()): string {
  const mins = Math.max(1, Math.round((until - now) / 60_000));
  return (
    `NOTE: GitHub's API rate limit was reached (${authenticated ? 'for the configured token' : 'anonymous: 60 requests an hour per IP'}), ` +
    `so this answer is missing: ${what.join('; ')}. safectx makes no GitHub API calls until ${hhmm(until)} UTC (about ${mins} min); ` +
    'the rest of the answer is unaffected.' +
    (authenticated
      ? ''
      : ' For 5,000 requests an hour, start the agent with GITHUB_TOKEN set (a fine-grained token with read-only access to public repositories is enough), or set SAFECTX_GH_CLI=1 to use the GitHub CLI login.')
  );
}

/** Runs one tool call and reports what the GitHub limit made it skip, if anything. */
export async function trackGitHub<T>(fn: () => Promise<T>): Promise<{ value: T; notice?: string }> {
  const skipped: Skipped = { what: new Set(), until: 0, authenticated: false };
  const value = await scope.run(skipped, fn);
  return { value, notice: skipped.what.size ? githubNotice([...skipped.what], skipped.until, skipped.authenticated) : undefined };
}

// ------------------------------------------------------------------- call ---

export interface GitHubCall {
  /** What the answer loses when this call cannot be made, e.g. "GitHub release notes". */
  what: string;
  accept?: string;
}

async function call<T>(path: string, opts: GitHubCall, get: (url: string, headers: Record<string, string>) => Promise<T>): Promise<T> {
  const url = `${GITHUB_API}${path}`;
  const token = mayAuthenticate(url) ? await githubToken() : undefined;
  const authenticated = Boolean(token);
  const until = blockedUntil(authenticated);
  if (until) {
    note(opts.what, until, authenticated);
    throw new GitHubRateLimitError(url, until, authenticated);
  }
  const headers: Record<string, string> = {
    accept: opts.accept ?? 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  try {
    return await get(url, headers);
  } catch (err) {
    const limit = limitedUntil(err);
    if (limit === undefined) throw err;
    block(authenticated, limit);
    note(opts.what, limit, authenticated);
    throw new GitHubRateLimitError(url, limit, authenticated);
  }
}

/** GET a path of the REST API ("/repos/o/r/releases") as JSON. */
export function githubJson<T>(path: string, opts: GitHubCall): Promise<T> {
  return call(path, opts, (url, headers) => getJson<T>(url, { headers }));
}

/** GET a path of the REST API as text (e.g. accept: application/vnd.github.sha). */
export function githubText(path: string, opts: GitHubCall): Promise<string> {
  return call(path, opts, (url, headers) => getText(url, { headers }));
}

/** Tests: forget the limit and the CLI token. */
export function resetGitHubState(): void {
  blocks.clear();
  cliToken = undefined;
}
