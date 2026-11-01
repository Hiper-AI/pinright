/**
 * Where the Action reads the team policy from. On a pull request the PR controls
 * its own tree, `.pinright.json` included: an "allow": ["*"] there would skip the
 * checks for the very change under review. So on pull_request and
 * pull_request_target events the policy comes from the base commit, and a PR that
 * changes it gets a notice for the reviewers. An explicit `config:` input wins.
 *
 * git runs with fixed arguments and no shell; the base SHA and branch name come
 * from the event and are validated before they reach it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from '../teamStarter.js';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Git = (args: string[]) => GitResult;

export interface PolicySource {
  /** input: the `config:` path; base: the base commit's file; tree: the nearest file in the checkout (not a PR). */
  kind: 'input' | 'base' | 'tree';
  /** For `input`, the path to read. */
  file?: string;
  /** For `base`: the policy text, and the name shown in messages ("ci/.pinright.json at base 1a2b3c4"). Undefined text: the base has no policy. */
  text?: string;
  label?: string;
  /** Lines for the reviewers (`::notice`). */
  notices: string[];
  /** Set when the base policy cannot be read: the run fails closed. */
  error?: string;
}

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// A branch name as git accepts it, minus anything an argument parser could read as an option.
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,250}$/;

export function gitIn(cwd: string): Git {
  return (args) => {
    // No prompt: without stored credentials a fetch from a private repo fails instead of waiting for a password.
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 2_000_000, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') };
  };
}

function readEvent(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  try {
    return env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}

/** The base commit to read, fetched if the checkout does not have it. */
function baseCommit(git: Git, sha: string | undefined, branch: string | undefined): { rev?: string; error?: string } {
  const has = (rev: string) => git(['cat-file', '-e', `${rev}^{commit}`]).code === 0;
  if (sha) {
    if (has(sha)) return { rev: sha };
    // actions/checkout fetches one commit by default; the base is one targeted fetch away.
    git(['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', 'origin', sha]);
    if (has(sha)) return { rev: sha };
  } else if (branch) {
    const ref = `refs/remotes/origin/${branch}`;
    if (!has(ref)) git(['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', 'origin', `+refs/heads/${branch}:${ref}`]);
    if (has(ref)) return { rev: ref };
  }
  const what = sha ? `the base commit ${sha.slice(0, 12)}` : `the base branch ${branch ?? '(unknown)'}`;
  return {
    error:
      `pinright reads the team policy from the pull request's base, and ${what} is not in this checkout and could not be fetched. ` +
      'Check out with actions/checkout and "fetch-depth: 0", or keep its default "persist-credentials: true" so pinright can fetch that one commit, or pass "config:" with a policy file the PR cannot change.',
  };
}

/**
 * The policy source for this run. `target` and `workspace` are absolute; the nearest
 * .pinright.json walking up from `target` to the repository root counts, as in the hook.
 */
export function selectPolicySource(opts: { configInput?: string; workspace: string; target: string; env: NodeJS.ProcessEnv; git?: Git; event?: Record<string, unknown> }): PolicySource {
  const { env, workspace } = opts;
  if (opts.configInput) return { kind: 'input', file: path.resolve(workspace, opts.configInput), notices: [] };
  if (!PR_EVENTS.has(env.GITHUB_EVENT_NAME ?? '')) return { kind: 'tree', notices: [] };
  const git = opts.git ?? gitIn(workspace);
  const event = opts.event ?? readEvent(env);
  const pr = (event?.pull_request ?? {}) as { base?: { sha?: unknown; ref?: unknown } };
  const rawSha = typeof pr.base?.sha === 'string' ? pr.base.sha.toLowerCase() : undefined;
  const rawBranch = typeof pr.base?.ref === 'string' ? pr.base.ref : env.GITHUB_BASE_REF;
  const sha = rawSha && SHA.test(rawSha) ? rawSha : undefined;
  const branch = rawBranch && BRANCH.test(rawBranch) ? rawBranch : undefined;
  const fail = (error: string): PolicySource => ({ kind: 'base', notices: [], error });
  if (!sha && !branch) return fail('pinright reads the team policy from the pull request\'s base, but the event names no base commit or branch. Pass "config:" with a policy file the PR cannot change.');

  const top = git(['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return fail(`pinright reads the team policy from the pull request's base, but ${workspace} is not a git checkout (${top.stderr.trim().slice(0, 200)}). Check out the repository with actions/checkout, or pass "config:".`);
  // Real paths on both sides: git prints long names where the runner's temp path may be a short (8.3) one or a link.
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const root = real(top.stdout.trim());
  const base = baseCommit(git, sha, branch);
  if (!base.rev) return fail(base.error as string);

  // Candidate files from the target's directory up to the repository root, nearest first.
  let dir = real(fs.existsSync(opts.target) && !fs.statSync(opts.target).isDirectory() ? path.dirname(opts.target) : opts.target);
  const candidates: string[] = [];
  for (;;) {
    const rel = path.relative(root, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) break;
    candidates.push(rel ? `${rel.split(path.sep).join('/')}/${CONFIG_FILE}` : CONFIG_FILE);
    if (!rel) break;
    dir = path.dirname(dir);
  }
  const short = base.rev.startsWith('refs/') ? branch : base.rev.slice(0, 7);
  const inTree = (rel: string) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return undefined;
    }
  };
  const notices: string[] = [];
  // A Windows runner may check out with CRLF; that is not a policy change.
  const same = (a: string, b: string) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
  for (const rel of candidates) {
    const shown = git(['show', `${base.rev}:${rel}`]);
    if (shown.code !== 0) {
      // Only a file the base does not have moves on to the next one; a base policy git could not print
      // (too large for the buffer, a timeout) would otherwise be skipped and the run go without it.
      if (git(['cat-file', '-e', `${base.rev}:${rel}`]).code !== 0) continue;
      return fail(`pinright could not read ${rel} at the pull request's base (${(shown.stderr || 'git show failed').trim().slice(0, 200)}). Pass "config:" with a policy file the PR cannot change.`);
    }
    const head = inTree(rel);
    if (head === undefined) notices.push(`This pull request deletes ${rel}. pinright used the base branch's version; the change applies once it is merged.`);
    else if (!same(head, shown.stdout)) notices.push(`This pull request changes ${rel}. pinright used the base branch's version; review the policy change before merging.`);
    // A nearer file the PR adds would take over after the merge.
    for (const nearer of candidates.slice(0, candidates.indexOf(rel))) {
      if (inTree(nearer) !== undefined) notices.push(`This pull request adds ${nearer}, which would replace ${rel} for this path. pinright used ${rel} from the base branch; review the new policy before merging.`);
    }
    return { kind: 'base', text: shown.stdout, label: `${rel} at base ${short}`, notices };
  }
  for (const rel of candidates) {
    if (inTree(rel) !== undefined) notices.push(`This pull request adds ${rel}. pinright ran without a team policy, as on the base branch; review the policy before merging.`);
  }
  return { kind: 'base', notices };
}
