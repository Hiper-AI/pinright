/**
 * The Action's policy source on pull requests: the base commit's .pinright.json,
 * never the one the PR brings (security review, residual risk 1). A temp git repo
 * plays the checkout; the event payload is a fake one.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitIn, selectPolicySource } from '../src/action/policySource.js';
import { loadPolicy } from '../src/auditRun.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo whose base commit has `base` as .pinright.json (none if undefined), checked out at a PR commit with `head`. */
function repo(base: string | undefined, head: string | undefined, sub = ''): { dir: string; sha: string } {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pinright-pr-')));
  tmp.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const file = path.join(dir, sub, '.pinright.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  if (base !== undefined) fs.writeFileSync(file, base);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const sha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'pr');
  if (head === undefined) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, head);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'pr');
  return { dir, sha };
}

const prEnv = { GITHUB_EVENT_NAME: 'pull_request' };
const event = (sha: string, ref = 'main') => ({ pull_request: { base: { sha, ref } } });

describe('the Action reads the policy from the base commit on pull requests', { timeout: 60_000 }, () => {
  it('a PR that adds "allow": ["*"] still runs under the base policy, and the reviewers get a notice', () => {
    const { dir, sha } = repo('{ "deny": ["left-pad"] }', '{ "allow": ["*"], "deny": [] }');
    const s = selectPolicySource({ workspace: dir, target: dir, env: prEnv, event: event(sha) });
    expect(s.error).toBeUndefined();
    expect(s.kind).toBe('base');
    expect(s.text).toBe('{ "deny": ["left-pad"] }');
    expect(s.label).toBe(`.pinright.json at base ${sha.slice(0, 7)}`);
    expect(s.notices).toEqual(["This pull request changes .pinright.json. pinright used the base branch's version; review the policy change before merging."]);
    // The policy the audit then uses is the base one, whatever the tree holds.
    const { policy } = loadPolicy(dir, undefined, { text: s.text, label: s.label as string });
    expect(policy.deny.map((d) => d.name)).toEqual(['left-pad']);
    expect(policy.allow).toEqual([]);
    expect(loadPolicy(dir).policy.allow).toEqual(['*']);
  });

  it('pull_request_target too; an unchanged policy gives no notice', () => {
    const { dir, sha } = repo('{ "deny": ["x"] }', '{ "deny": ["x"] }');
    const s = selectPolicySource({ workspace: dir, target: dir, env: { GITHUB_EVENT_NAME: 'pull_request_target' }, event: event(sha) });
    expect(s).toMatchObject({ kind: 'base', text: '{ "deny": ["x"] }', notices: [] });
  });

  it('a PR that adds a policy where the base had none: no policy for this run, and a notice', () => {
    const { dir, sha } = repo(undefined, '{ "allow": ["*"] }');
    const s = selectPolicySource({ workspace: dir, target: dir, env: prEnv, event: event(sha) });
    expect(s.kind).toBe('base');
    expect(s.text).toBeUndefined();
    expect(s.notices[0]).toMatch(/adds \.pinright\.json\. pinright ran without a team policy/);
    expect(loadPolicy(dir, undefined, { text: undefined, label: 'x' }).policy.allow).toEqual([]);
  });

  it('a PR that deletes the policy: the base one applies', () => {
    const { dir, sha } = repo('{ "deny": ["x"] }', undefined);
    const s = selectPolicySource({ workspace: dir, target: dir, env: prEnv, event: event(sha) });
    expect(s.text).toBe('{ "deny": ["x"] }');
    expect(s.notices[0]).toMatch(/deletes \.pinright\.json/);
  });

  it('the nearest policy above the audited path, in the base tree; a nearer one the PR adds is reported', () => {
    const { dir, sha } = repo('{ "deny": ["root"] }', '{ "deny": ["root"] }');
    fs.mkdirSync(path.join(dir, 'packages', 'web'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages', 'web', '.pinright.json'), '{ "allow": ["*"] }');
    const s = selectPolicySource({ workspace: dir, target: path.join(dir, 'packages', 'web'), env: prEnv, event: event(sha) });
    expect(s.text).toBe('{ "deny": ["root"] }');
    expect(s.notices[0]).toMatch(/adds packages\/web\/\.pinright\.json, which would replace \.pinright\.json/);
  });

  it('a policy in a subdirectory of the base is found from a file target there', () => {
    const { dir, sha } = repo('{ "deny": ["sub"] }', '{ "deny": [] }', 'app');
    fs.writeFileSync(path.join(dir, 'app', 'package-lock.json'), '{}');
    const s = selectPolicySource({ workspace: dir, target: path.join(dir, 'app', 'package-lock.json'), env: prEnv, event: event(sha) });
    expect(s.label).toMatch(/^app\/\.pinright\.json at base /);
    expect(s.notices[0]).toMatch(/changes app\/\.pinright\.json/);
  });

  it('a base commit that is not in the checkout and cannot be fetched fails closed with how to fix the checkout', () => {
    const { dir } = repo('{}', '{}');
    const s = selectPolicySource({ workspace: dir, target: dir, env: prEnv, event: event('0123456789abcdef0123456789abcdef01234567') });
    expect(s.error).toMatch(/base commit 0123456789ab is not in this checkout and could not be fetched/);
    expect(s.error).toMatch(/fetch-depth: 0/);
    expect(s.error).toMatch(/config:/);
  });

  it('without a SHA in the payload, the base branch from GITHUB_BASE_REF is used (fetched when missing)', () => {
    const { dir } = repo('{ "deny": ["x"] }', '{}');
    // The checkout has no origin/main; fetching it from a remote that is the repo itself works.
    git(dir, 'remote', 'add', 'origin', dir);
    const s = selectPolicySource({ workspace: dir, target: dir, env: { ...prEnv, GITHUB_BASE_REF: 'main' }, event: {} });
    expect(s.error).toBeUndefined();
    expect(s.text).toBe('{ "deny": ["x"] }');
    expect(s.label).toBe('.pinright.json at base main');
  });

  it('a base commit missing from a shallow checkout is fetched', () => {
    const { dir: upstream, sha } = repo('{ "deny": ["x"] }', '{}');
    git(upstream, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
    const clone = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pinright-clone-')));
    tmp.push(clone);
    git(clone, 'clone', '-q', '--depth=1', '--branch', 'pr', `file://${upstream.split(path.sep).join('/')}`, '.');
    expect(gitIn(clone)(['cat-file', '-e', `${sha}^{commit}`]).code).not.toBe(0);
    const s = selectPolicySource({ workspace: clone, target: clone, env: prEnv, event: event(sha) });
    expect(s.error).toBeUndefined();
    expect(s.text).toBe('{ "deny": ["x"] }');
  });

  it('a malformed base SHA or branch never reaches git as an option', () => {
    const { dir } = repo('{}', '{}');
    const s = selectPolicySource({ workspace: dir, target: dir, env: { ...prEnv, GITHUB_BASE_REF: '--upload-pack=evil' }, event: { pull_request: { base: { sha: '--output=x' } } } });
    expect(s.error).toMatch(/names no base commit or branch/);
  });

  it('the config input wins, and other events read the tree as before', () => {
    const { dir, sha } = repo('{ "deny": ["x"] }', '{}');
    expect(selectPolicySource({ configInput: 'policy/.pinright.json', workspace: dir, target: dir, env: prEnv, event: event(sha) })).toEqual({
      kind: 'input', file: path.join(dir, 'policy', '.pinright.json'), notices: [],
    });
    expect(selectPolicySource({ workspace: dir, target: dir, env: { GITHUB_EVENT_NAME: 'push' } })).toEqual({ kind: 'tree', notices: [] });
  });

  it('reads the event payload from GITHUB_EVENT_PATH', () => {
    const { dir, sha } = repo('{ "deny": ["x"] }', '{}');
    const ev = path.join(dir, '..', `${path.basename(dir)}-event.json`);
    tmp.push(ev);
    fs.writeFileSync(ev, JSON.stringify(event(sha)));
    const s = selectPolicySource({ workspace: dir, target: dir, env: { ...prEnv, GITHUB_EVENT_PATH: ev } });
    expect(s.text).toBe('{ "deny": ["x"] }');
  });
});
