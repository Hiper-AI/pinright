/**
 * Parsers run on text a stranger controls (lockfiles and manifests of a cloned
 * repo, changelogs and docs of a published package). Each input below made a
 * regex backtrack for seconds to hours before the fix (security review F9);
 * now each must finish well inside the budget.
 */
import { describe, expect, it } from 'vitest';
import { fixedFromConstraint, satisfiesComposer } from '../src/composer/constraint.js';
import { isComposerName } from '../src/composer/packagist.js';
import { chunkMarkdown } from '../src/docs/retrieve.js';
import { pyStatements } from '../src/docs/pyapi.js';
import { parseChangelog, tidy } from '../src/upgrade/changelog.js';
import { cleanMdx } from '../src/upgrade/index.js';
import { parseFile } from '../src/tree/lockfiles.js';

const BUDGET_MS = 1500;

function fast(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

describe('no catastrophic backtracking on hostile text', () => {
  it('Composer package names (was exponential: 30 characters took minutes)', () => {
    expect(fast(() => isComposerName(`${'a'.repeat(5000)}!`))).toBeLessThan(BUDGET_MS);
    expect(fast(() => isComposerName(`vendor/${'a-'.repeat(5000)}!`))).toBeLessThan(BUDGET_MS);
    // Same language as Composer's own pattern.
    for (const ok of ['symfony/console', 'a/b', 'my.vendor/my--pkg', 'v_1/p.k-g']) expect(isComposerName(ok)).toBe(true);
    for (const bad of ['Symfony/console', 'a//b', 'a/-b', 'a/b-', 'a_-b/c', 'a/b---c', 'a', '/b']) expect(isComposerName(bad)).toBe(false);
  });

  it('build.gradle full of blank lines (was cubic)', () => {
    const gradle = `${'\n'.repeat(50_000)}dependencies { implementation 'a:b:1.0' }\n`;
    expect(fast(() => parseFile('build.gradle', gradle))).toBeLessThan(BUDGET_MS);
    const vars = parseFile('build.gradle', "val okhttpVersion = \"4.12.0\"\ndependencies { implementation \"com.squareup.okhttp3:okhttp:$okhttpVersion\" }\n");
    expect(vars.declared?.[0]).toMatchObject({ name: 'com.squareup.okhttp3:okhttp', spec: '4.12.0' });
  });

  it('Composer constraints with long whitespace runs', () => {
    const c = `${' '.repeat(200_000)}x`;
    expect(fast(() => satisfiesComposer('1.0.0', c))).toBeLessThan(BUDGET_MS);
    expect(fast(() => fixedFromConstraint(c))).toBeLessThan(BUDGET_MS);
    expect(satisfiesComposer('1.2.0', '^1.0 || ^2.0')).toBe(true);
    expect(fixedFromConstraint('>=1.0,<1.2.3 | >=2.0,<2.0.1')).toEqual(['1.2.3', '2.0.1']);
  });

  it('changelogs, docs and MDX from a package', () => {
    const ws = ' '.repeat(200_000);
    expect(fast(() => parseChangelog(`## 1.0.0${ws}x\n- item\n`))).toBeLessThan(BUDGET_MS);
    expect(fast(() => tidy(`fix${'\n'.repeat(200_000)}x`))).toBeLessThan(BUDGET_MS);
    expect(fast(() => tidy(`fix${ws}x`))).toBeLessThan(BUDGET_MS);
    expect(fast(() => chunkMarkdown(`# Title${ws}x {#${'{#'.repeat(50_000)}\n\ntext\n`))).toBeLessThan(BUDGET_MS);
    expect(fast(() => cleanMdx('\n'.repeat(200_000)))).toBeLessThan(BUDGET_MS);
    expect(fast(() => pyStatements(`from x import (a${ws}b)\n`))).toBeLessThan(BUDGET_MS);
    expect(tidy('Fix the parser by @someone in #12')).toBe('Fix the parser');
    expect(chunkMarkdown('# Install { #install }\n\ntext\n')[0].title).toBe('Install');
  });
});
