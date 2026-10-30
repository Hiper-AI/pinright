/**
 * Parsers run on text a stranger controls (lockfiles and manifests of a cloned
 * repo, changelogs and docs of a published package). Each input below made a
 * regex backtrack for seconds to hours before the fix (security review F9);
 * now each must finish well inside the budget.
 */
import { describe, expect, it } from 'vitest';
import { fixedFromConstraint, satisfiesComposer } from '../src/composer/constraint.js';
import { isComposerName } from '../src/composer/packagist.js';
import { asksSignature, chunkMarkdown, isGenerated } from '../src/docs/retrieve.js';
import { readmeDocsLink } from '../src/docs/discover.js';
import { expandIncludes } from '../src/docs/includes.js';
import { isDocPath, llmsBases } from '../src/docs/sources.js';
import { pyStatements } from '../src/docs/pyapi.js';
import { parseChangelog, tidy } from '../src/upgrade/changelog.js';
import { cleanMdx } from '../src/upgrade/index.js';
import { parseFile } from '../src/tree/lockfiles.js';
import { jsImports } from '../src/hook/imports.js';

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

  it('JS sources the hook scans (was cubic: "import" plus 4k spaces took 45 s)', () => {
    expect(fast(() => jsImports(`import${' '.repeat(100_000)}!`))).toBeLessThan(BUDGET_MS);
    expect(fast(() => jsImports(`import {${' a,'.repeat(30_000)}`))).toBeLessThan(BUDGET_MS);
    const src = `import a, { b as c } from 'left-pad';
export * from "chalk";
import type { T } from 'zod';
import'side-effect';
import {
  x,
  y,
} from 'react';
`;
    expect(jsImports(src).sort()).toEqual(['chalk', 'left-pad', 'react', 'side-effect', 'zod']);
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

  it('docs discovery, includes and generated-file checks (third round)', async () => {
    const ws = ' '.repeat(200_000);
    expect(fast(() => isDocPath(`docs/${'a/'.repeat(50_000)}xrequirements`))).toBeLessThan(BUDGET_MS);
    expect(fast(() => isDocPath(`docs/${'requirements'.repeat(20_000)}.tx`))).toBeLessThan(BUDGET_MS);
    expect(fast(() => readmeDocsLink(`## Documentation\n${'](https://a'.repeat(50_000)}`))).toBeLessThan(BUDGET_MS);
    expect(fast(() => readmeDocsLink(`##${ws}docs${ws}`))).toBeLessThan(BUDGET_MS);
    expect(fast(() => isGenerated('do not '.repeat(100_000)))).toBeLessThan(BUDGET_MS);
    expect(fast(() => asksSignature(`type ${ws}${'of '.repeat(50_000)}`))).toBeLessThan(BUDGET_MS);
    expect(fast(() => llmsBases(`https://a.example/${'docs/'.repeat(20_000)}`))).toBeLessThan(BUDGET_MS);
    const page = 'https://raw.githubusercontent.com/o/r/HEAD/docs/x.md';
    for (const text of [`{{ m('${'a/'.repeat(50_000)}'${ws}`, `{{m(${"'a',".repeat(50_000)}${ws}}`, `--8<-- "${'a'.repeat(100_000)}:${'b'.repeat(100_000)}`]) {
      const t = performance.now();
      await expandIncludes(text, page, { budget: 1000, prepare: (c) => c });
      expect(performance.now() - t).toBeLessThan(BUDGET_MS);
    }
  });
});
