/**
 * The first ten minutes: help text, typo suggestions, colors only where wanted,
 * the cache cap, and doctor's read-only view of the setup. All offline.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { closest, colorEnabled, COMMANDS, commandHelp, didYouMean, mainHelp, paint, unknownCommand, unknownFlag } from '../src/cliHelp.js';
import { cacheStats, clearCache, pruneCache } from '../src/cache.js';
import { cacheCheck, clientWiring, formatDoctor, launcherCheck, mcpLauncherIn, nodeCheck, policyCheck, probe, type DoctorReport } from '../src/doctor.js';
import { launcherOf } from '../src/launch.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pinright-ux-'));

describe('help and typos', () => {
  it('suggests the command a typo meant', () => {
    expect(didYouMean('chek')).toBe('check');
    expect(didYouMean('audti')).toBe('audit');
    expect(didYouMean('doc')).toBe('doctor');
    expect(didYouMean('upgarde')).toBe('upgrade');
    expect(didYouMean('mcp')).toBe('serve');
    expect(didYouMean('deploy')).toBeUndefined();
    expect(unknownCommand('chek')).toBe('pinright: unknown command "chek". Did you mean "pinright check"?\nRun "pinright --help" for the list of commands.');
  });

  it('suggests the flag a typo meant', () => {
    expect(unknownFlag('jsno', ['fail-on', 'json', 'sarif'])).toBe('unknown option --jsno; did you mean --json?');
    expect(unknownFlag('fail', ['fail-on', 'json'])).toBe('unknown option --fail; did you mean --fail-on?');
    expect(unknownFlag('xyz', ['json'])).toBe('unknown option --xyz');
    expect(closest('srif', ['sarif', 'json'])).toBe('sarif');
  });

  it('check rejects a flag instead of reading it as the version or the ecosystem', () => {
    // Found in QA: "check npm lodash --json" answered "version --json of lodash is not in the registry".
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'check', ...args], {
        encoding: 'utf8',
        env: { ...process.env, PINRIGHT_NO_CACHE: '1', DEPSDEV_BASE_URL: 'http://127.0.0.1:9', OSV_BASE_URL: 'http://127.0.0.1:9' },
      });
    for (const args of [['npm', 'lodash', '--json'], ['--bogus', 'npm', 'lodash']]) {
      const res = run(...args);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/^pinright check: unknown option --(json|bogus)\nusage: pinright check/);
      expect(res.stdout).toBe('');
    }
  });

  it('has help for every command, and the main help lists them all with the exit codes', () => {
    const main = mainHelp('9.9.9');
    for (const name of Object.keys(COMMANDS)) {
      expect(main).toContain(`  ${name}`);
      expect(commandHelp(name)).toContain(`Usage: ${COMMANDS[name].usage}`);
    }
    expect(main).toMatch(/Exit codes:\n {2}0 .*\n {2}1 /);
    expect(main).toContain('npm i -g pinright && pinright init');
    expect(main).toContain('npx -y pinright init');
    // No escape codes unless asked for.
    expect(main).not.toContain('\x1b[');
    expect(mainHelp('9.9.9', true)).toContain('\x1b[1m');
  });

  it('colors only on a terminal, never with NO_COLOR or TERM=dumb, FORCE_COLOR wins over a pipe', () => {
    expect(colorEnabled({ isTTY: true }, {})).toBe(true);
    expect(colorEnabled({ isTTY: false }, {})).toBe(false);
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '' })).toBe(true); // the spec: empty means unset
    expect(colorEnabled({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
    expect(colorEnabled({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
    expect(colorEnabled({ isTTY: true }, { FORCE_COLOR: '1', NO_COLOR: '1' })).toBe(false);
    expect(paint(false).red('x')).toBe('x');
  });
});

describe('cache cap', () => {
  function entry(dir: string, name: string, expiresAt: number, bytes: number, mtime: number) {
    const shard = path.join(dir, name.slice(0, 2));
    fs.mkdirSync(shard, { recursive: true });
    const file = path.join(shard, `${name.padEnd(64, '0')}.json`);
    fs.writeFileSync(file, JSON.stringify({ expiresAt, value: 'x'.repeat(bytes) }));
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
    return file;
  }

  it('drops expired entries and stale temp files first, then the oldest until it fits', () => {
    const dir = tmp();
    const now = Date.now();
    const expired = entry(dir, 'aa01', now - 1, 100, now - 5_000);
    const old = entry(dir, 'bb01', now + 3600_000, 1000, now - 4_000);
    const mid = entry(dir, 'cc01', now + 3600_000, 1000, now - 3_000);
    const fresh = entry(dir, 'dd01', now + 3600_000, 1000, now - 1_000);
    const tmpFile = path.join(dir, 'aa', `${'aa02'.padEnd(64, '0')}.json.123.0123456789ab.tmp`);
    fs.writeFileSync(tmpFile, '{');
    fs.utimesSync(tmpFile, (now - 2 * 3600_000) / 1000, (now - 2 * 3600_000) / 1000);
    const before = cacheStats(dir);
    expect(before.files).toBe(5);
    const r = pruneCache(2_100, now, dir);
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(tmpFile)).toBe(false);
    expect(fs.existsSync(old)).toBe(false); // oldest live entry goes to fit the cap
    expect(fs.existsSync(mid)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(r.removed).toBe(3);
    expect(r.remaining.files).toBe(2);
    expect(r.remaining.bytes).toBeLessThanOrEqual(2_100);
  });

  it('touches only the files the cache writes, also when PINRIGHT_CACHE_DIR names a busy folder (review 2)', () => {
    const dir = tmp();
    const now = Date.now();
    const own = entry(dir, 'ab01', now - 1, 10, now - 5_000);
    // A project, or ~/.cache, used as the cache dir by mistake: its files are not entries.
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {};');
    fs.mkdirSync(path.join(dir, 'ab'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ab', 'notes.txt'), 'mine');
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'id_ed25519'), 'secret');
    fs.symlinkSync(outside, path.join(dir, 'cd'), 'junction');
    expect(cacheStats(dir).files).toBe(1);
    pruneCache(0, now, dir);
    expect(fs.existsSync(own)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'src', 'index.ts'), 'utf8')).toBe('export {};');
    expect(fs.readFileSync(path.join(dir, 'ab', 'notes.txt'), 'utf8')).toBe('mine');
    expect(fs.readFileSync(path.join(outside, 'id_ed25519'), 'utf8')).toBe('secret');
    entry(dir, 'ab02', now + 3600_000, 10, now);
    expect(clearCache(dir)).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'src', 'index.ts'), 'utf8')).toBe('export {};');
    expect(fs.readFileSync(path.join(dir, 'ab', 'notes.txt'), 'utf8')).toBe('mine');
    expect(fs.readFileSync(path.join(outside, 'id_ed25519'), 'utf8')).toBe('secret');
  });

  it('an empty or missing cache dir is fine', () => {
    const dir = path.join(tmp(), 'nope');
    expect(cacheStats(dir)).toEqual({ dir, files: 0, bytes: 0 });
    expect(pruneCache(10, Date.now(), dir).removed).toBe(0);
  });
});

describe('doctor', () => {
  it('checks the Node version against engines', () => {
    expect(nodeCheck('v22.11.0').status).toBe('ok');
    expect(nodeCheck('v18.20.0')).toMatchObject({ status: 'fail', detail: 'Node v18.20.0; pinright needs >=20.9.0' });
  });

  it('a probe is ok for any answer below 500, fails a core source on 5xx or no answer, and only warns for others', async () => {
    const ok = await probe({ name: 'deps.dev', role: 'r', url: 'https://x.test/', core: true }, (async () => new Response(null, { status: 404 })) as typeof fetch);
    expect(ok.status).toBe('ok');
    expect(typeof ok.ms).toBe('number');
    const down = await probe({ name: 'osv.dev', role: 'the verdict', url: 'https://x.test/', core: true }, (async () => new Response(null, { status: 503 })) as typeof fetch);
    expect(down).toMatchObject({ status: 'fail', detail: 'HTTP 503; without it: the verdict' });
    const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const off = await probe({ name: 'cdn.jsdelivr.net', role: 'docs', url: 'https://x.test/' }, (async () => {
      throw dns;
    }) as typeof fetch);
    expect(off).toMatchObject({ status: 'warn', detail: 'unreachable (ENOTFOUND); without it: docs' });
  });

  it('reports a writable cache with its size, and a policy file that does not parse', () => {
    const dir = tmp();
    expect(cacheCheck(dir)).toMatchObject({ status: 'ok' });
    expect(cacheCheck(dir).detail).toMatch(/: 0 entries, 0\.0 MB \(cap \d+\.\d MB\)$/);
    const proj = tmp();
    expect(policyCheck(proj).status).toBe('ok');
    fs.writeFileSync(path.join(proj, '.pinright.json'), '{ "onError": "maybe" }');
    expect(policyCheck(proj)).toMatchObject({ name: '.pinright.json', status: 'fail' });
    fs.writeFileSync(path.join(proj, '.pinright.json'), '{ "onError": "deny" }');
    expect(policyCheck(proj)).toMatchObject({ status: 'ok' });
  });

  it('finds which agents have pinright and whether the hook is wired, from the client registry, reading only', () => {
    const proj = tmp();
    const home = tmp();
    fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { pinright: { command: 'npx', args: ['-y', 'pinright'] } } }));
    fs.mkdirSync(path.join(proj, '.claude'));
    const settings = { hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'npx -y pinright hook claude' }] }] } };
    fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify(settings));
    fs.mkdirSync(path.join(home, '.cursor'));
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.pinright]\ncommand = "npx"\n');
    const before = fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8');
    const w = clientWiring(proj, home);
    expect(w).toEqual([
      { client: 'Claude Code', file: `.mcp.json, ${path.join('.claude', 'settings.json')}`, scope: 'project', mcp: true, hook: true, hookLauncher: 'npx', hookCommand: 'npx -y pinright hook claude', mcpLauncher: 'npx' },
      { client: 'Cursor', file: '~/.cursor/mcp.json', scope: 'user', mcp: false, hook: false },
      { client: 'OpenAI Codex', file: '~/.codex/config.toml', scope: 'user', mcp: true, hook: false, mcpLauncher: 'npx' },
    ]);
    expect(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8')).toBe(before);
  });

  it('tells which launcher each client uses, and warns about the hook going through npx', async () => {
    expect(launcherOf('npx -y pinright hook claude')).toBe('npx');
    expect(launcherOf('pinright hook claude')).toBe('global');
    expect(launcherOf('"C:/x/pinright/dist/cli.js" hook claude')).toBe('node');
    expect(mcpLauncherIn(JSON.stringify({ mcpServers: { other: { command: 'npx' }, pinright: { command: 'pinright', args: [] } } }))).toBe('global');
    expect(mcpLauncherIn('[mcp_servers.pinright]\ncommand = "pinright"\nargs = []\n')).toBe('global');
    const wired = (hookLauncher: 'npx' | 'global', scope: 'project' | 'user' = 'project') => [{ client: 'Claude Code', file: '.mcp.json', scope, mcp: true, hook: true, hookLauncher, hookCommand: `${hookLauncher === 'npx' ? 'npx -y ' : ''}pinright hook claude` }];
    const direct = { name: 'hook startup', status: 'ok' as const, detail: '', ms: 150 };
    const g = { bin: '/usr/bin/pinright', packageDir: '/usr/lib/node_modules/pinright', version: '1.0.0' };
    const viaNpx = await launcherCheck(wired('npx'), direct, { offline: true, global: null });
    expect(viaNpx.status).toBe('warn');
    // A project hook through npx: a user-level hook would run beside it, so the advice is --bin for the team.
    expect(viaNpx.detail).toMatch(/Claude Code \(project\) start the hook through npx .*would not make this project faster .*pinright init --bin/);
    expect((await launcherCheck(wired('npx', 'user'), direct, { offline: true, global: g })).detail).toMatch(/"pinright init <client> --user" again switches your user files/);
    // Different hooks in the user and the project file: both run in this project.
    const both = [...wired('global', 'user'), ...wired('npx')];
    expect((await launcherCheck(both, direct, { offline: true, global: g })).detail).toMatch(/a user hook and a different project hook both run in this project/);
    expect((await launcherCheck(wired('global'), direct, { offline: true, global: g })).status).toBe('ok');
    // The binary the config names is not on this PATH: the agent could not start the hook.
    expect((await launcherCheck(wired('global'), direct, { offline: true, global: null })).detail).toMatch(/no global install is on this PATH/);
  });

  it.skipIf(process.platform === 'win32')('a repo whose .mcp.json is a FIFO does not hang doctor (security review, round 2)', () => {
    const proj = tmp();
    const home = tmp();
    const fifo = spawnSync('mkfifo', [path.join(proj, '.mcp.json')]);
    if (fifo.status !== 0) return;
    // Before the fix this read blocked forever: nobody writes to the FIFO.
    expect(clientWiring(proj, home)).toEqual([{ client: 'Claude Code', file: '.mcp.json', scope: 'project', mcp: false, hook: false }]);
  });

  it('formats a report that names what failed and why it matters, without colors by default', () => {
    const r: DoctorReport = {
      version: '1.0.0',
      ok: false,
      checks: [
        { name: 'node', status: 'ok', detail: 'Node v22.11.0' },
        { name: 'osv.dev', status: 'fail', ms: 5000, detail: 'unreachable (no answer within 5 s); without it: the verdict' },
      ],
      clients: [{ client: 'Cursor', file: '.cursor/', scope: 'project', mcp: true, hook: false }],
    };
    const out = formatDoctor(r);
    expect(out).toContain('  FAIL  osv.dev   5000 ms  unreachable (no answer within 5 s); without it: the verdict');
    expect(out).toContain('Cursor (project: .cursor/): MCP server, no hook');
    expect(out).toContain('No pre-install hook is wired');
    expect(out).toMatch(/every verdict is "unknown" and the hook follows its onError policy/);
    expect(out).not.toContain('\x1b[');
  });
});
