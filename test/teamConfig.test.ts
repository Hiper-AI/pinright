/**
 * The team policy file: parsing (comments allowed, typos rejected), where it is
 * found, precedence against env, and the rules it adds.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  belowThreshold, checkLicenses, denyEntry, findConfigFile, isAllowed, loadTeamConfig, parseTeamConfig, policyFindings, resolvePolicy,
  STARTER_CONFIG, stripJsonComments,
} from '../src/teamConfig.js';

const tmp: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'safectx-cfg-'));
  tmp.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('parsing', () => {
  it('accepts comments and trailing commas, and keeps // inside strings', () => {
    const src = '{\n  // note\n  "deny": [{ "name": "a", "reason": "see http://x/y" },],\n  /* block */ "allow": ["@acme/*"],\n}';
    expect(JSON.parse(stripJsonComments(src))).toEqual({ deny: [{ name: 'a', reason: 'see http://x/y' }], allow: ['@acme/*'] });
  });

  it('the starter file written by init is valid', () => {
    const r = parseTeamConfig(STARTER_CONFIG);
    expect(r.error).toBeUndefined();
    expect(r.config?.licenses?.deny).toContain('AGPL-*');
  });

  it('rejects unknown keys and bad values with the path of each problem', () => {
    const typo = parseTeamConfig('{ "alow": ["x"] }');
    expect(typo.error).toMatch(/does not match the safectx schema/);
    expect(typo.error).toMatch(/alow/);
    const bad = parseTeamConfig('{ "severityThreshold": "severe", "cooldownDays": -1 }');
    expect(bad.error).toMatch(/severityThreshold/);
    expect(bad.error).toMatch(/cooldownDays/);
    expect(parseTeamConfig('{ "deny": [ }').error).toMatch(/not valid JSON/);
  });
});

describe('finding the file', () => {
  it('walks up from a subfolder and stops at the repo root', () => {
    const repo = tempDir();
    fs.mkdirSync(path.join(repo, '.git'));
    fs.mkdirSync(path.join(repo, 'packages', 'web'), { recursive: true });
    expect(findConfigFile(path.join(repo, 'packages', 'web'))).toBeUndefined();
    fs.writeFileSync(path.join(repo, '.safectx.json'), '{}');
    expect(findConfigFile(path.join(repo, 'packages', 'web'))).toBe(path.join(repo, '.safectx.json'));
  });

  it('does not cross the repo root into a parent folder', () => {
    const outer = tempDir();
    fs.writeFileSync(path.join(outer, '.safectx.json'), '{ "deny": ["x"] }');
    const repo = path.join(outer, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    expect(findConfigFile(repo)).toBeUndefined();
  });

  it('reloads the file when it changes', () => {
    const repo = tempDir();
    fs.mkdirSync(path.join(repo, '.git'));
    const f = path.join(repo, '.safectx.json');
    fs.writeFileSync(f, '{ "deny": ["a"] }');
    expect(loadTeamConfig(repo).config?.deny).toEqual(['a']);
    fs.writeFileSync(f, '{ "deny": ["a", "b"] }');
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(loadTeamConfig(repo).config?.deny).toEqual(['a', 'b']);
    fs.writeFileSync(f, '{ broken');
    fs.utimesSync(f, new Date(), new Date(Date.now() + 10000));
    expect(loadTeamConfig(repo).error).toMatch(/not valid JSON/);
  });
});

describe('precedence: defaults < file < env', () => {
  it('uses defaults with nothing set', () => {
    const p = resolvePolicy(undefined, {});
    expect(p).toMatchObject({ allow: [], deny: [], severityThreshold: 'low', noFix: 'severity', onError: 'allow', cooldown: 'warn' });
    expect(p.cooldownDays).toBeUndefined();
  });

  it('file over defaults, env over file; SAFECTX_ALLOW adds to the file list', () => {
    const cfg = { allow: ['@acme/*'], onError: 'deny' as const, noFix: 'ask' as const, cooldown: 'enforce' as const, cooldownDays: 7, severityThreshold: 'high' as const };
    expect(resolvePolicy(cfg, {})).toMatchObject({ onError: 'deny', noFix: 'ask', cooldown: 'enforce', cooldownDays: 7, severityThreshold: 'high' });
    const env = { SAFECTX_ALLOW: 'internal-*', SAFECTX_HOOK_ON_ERROR: 'ask', SAFECTX_HOOK_NO_FIX: 'deny', SAFECTX_HOOK_COOLDOWN: 'warn', SAFECTX_COOLDOWN_DAYS: '1', SAFECTX_SEVERITY_THRESHOLD: 'moderate' };
    const p = resolvePolicy(cfg, env);
    expect(p).toMatchObject({ onError: 'ask', noFix: 'deny', cooldown: 'warn', cooldownDays: 1, severityThreshold: 'moderate' });
    expect(p.allow).toEqual(['@acme/*', 'internal-*']);
  });

  it('ignores invalid env values instead of guessing', () => {
    expect(resolvePolicy({ onError: 'deny' }, { SAFECTX_HOOK_ON_ERROR: 'maybe' }).onError).toBe('deny');
  });
});

describe('rules', () => {
  const p = resolvePolicy(
    {
      allow: ['@acme/*'],
      deny: ['left-pad', { name: 'request', ecosystem: 'npm', reason: 'unmaintained; use undici' }, { name: 'PyYAML', ecosystem: 'pypi' }],
      licenses: { deny: ['AGPL-*', 'GPL-3.0*'] },
    },
    {},
    '/repo/.safectx.json',
  );

  it('matches names with globs, per ecosystem, with PyPI normalization', () => {
    expect(isAllowed(p, 'npm', '@acme/ui')).toBe(true);
    expect(isAllowed(p, 'npm', '@other/ui')).toBe(false);
    expect(denyEntry(p, 'npm', 'request')?.reason).toMatch(/undici/);
    expect(denyEntry(p, 'pypi', 'request')).toBeUndefined();
    expect(denyEntry(p, 'pypi', 'pyyaml')).toBeDefined();
    expect(denyEntry(p, 'cargo', 'left-pad')).toBeDefined();
  });

  it('licenses: denied only when every alternative is denied; unknown is a note', () => {
    expect(checkLicenses(p, ['MIT']).action).toBe('ok');
    expect(checkLicenses(p, ['AGPL-3.0-only'])).toMatchObject({ action: 'deny' });
    expect(checkLicenses(p, ['AGPL-3.0-only OR MIT']).action).toBe('ok');
    expect(checkLicenses(p, ['MIT AND GPL-3.0-or-later']).action).toBe('deny');
    expect(checkLicenses(p, ['(MIT OR AGPL-3.0) AND GPL-3.0']).action).toBe('deny');
    expect(checkLicenses(p, []).action).toBe('note');
    expect(checkLicenses(p, ['non-standard']).action).toBe('note');
  });

  it('licenses: an allow list denies anything outside it', () => {
    const only = resolvePolicy({ licenses: { allow: ['MIT', 'Apache-2.0', 'BSD-*'] } }, {});
    expect(checkLicenses(only, ['BSD-3-Clause']).action).toBe('ok');
    expect(checkLicenses(only, ['MPL-2.0']).action).toBe('deny');
    expect(checkLicenses(only, ['MPL-2.0 OR Apache-2.0']).action).toBe('ok');
    expect(checkLicenses(resolvePolicy(undefined, {}), ['AGPL-3.0']).action).toBe('ok'); // no rules, no opinion
  });

  it('severity threshold: below it is a note; unrated always counts', () => {
    const high = resolvePolicy({ severityThreshold: 'high' }, {});
    expect(belowThreshold(high, [{ severity: 'MODERATE' }, { severity: 'LOW' }])).toBe(true);
    expect(belowThreshold(high, [{ severity: 'MODERATE' }, { severity: 'HIGH' }])).toBe(false);
    expect(belowThreshold(high, [{ severity: 'MODERATE' }, {}])).toBe(false);
    expect(belowThreshold(high, [{ cvss3Score: 5.3 }])).toBe(true);
    expect(belowThreshold(resolvePolicy(undefined, {}), [{ severity: 'LOW' }])).toBe(false);
  });

  it('policyFindings lists deny and license problems for the tools, nothing for allowed names', () => {
    expect(policyFindings(p, 'npm', 'request', ['Apache-2.0'])).toEqual(['request: denied by the project policy (.safectx.json): unmaintained; use undici']);
    expect(policyFindings(p, 'npm', 'x', ['AGPL-3.0'])[0]).toMatch(/license AGPL-3.0 is not allowed/);
    expect(policyFindings(p, 'npm', 'x', undefined, false)).toEqual([]);
    expect(policyFindings(p, 'npm', '@acme/ui', ['AGPL-3.0'])).toEqual([]);
  });
});
