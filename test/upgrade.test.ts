/**
 * upgrade-guide, offline: version ranges, changelog parsing and classification,
 * the .d.ts export diff, and the size of what the agent gets back.
 */
import { describe, expect, it } from 'vitest';
import { classify, dedupeItems, extractItems, parseChangelog, sectionsInRange, type ChangeItem } from '../src/upgrade/changelog.js';
import { diffExports, ownExports, parseDts, splitTopLevel, typeEntries } from '../src/upgrade/dts.js';
import { cleanMdx, formatApiDiff, formatItems, guideToc, rankItems } from '../src/upgrade/index.js';
import { announcementLink, changelogPathRelevant, guideScore, htmlToMarkdown, majorMarkers } from '../src/upgrade/sources.js';
import { compareVersions, crossesLine, inUpgradeRange, majorsInRange, resolveVersionSpec, toSemver, versionFromTag, versionInHeading } from '../src/upgrade/versions.js';

describe('versions', () => {
  it('maps PEP 440 spellings onto semver', () => {
    expect(toSemver('2.0b3')).toBe('2.0.0-beta.3');
    expect(toSemver('1.0.0rc1')).toBe('1.0.0-rc.1');
    expect(toSemver('v1.2')).toBe('1.2.0');
    expect(toSemver('0.3.27.post1')).toBe('0.3.27');
    expect(toSemver('16.5.0-canary.31')).toBe('16.5.0-canary.31');
    expect(toSemver('not-a-version')).toBeUndefined();
    expect(compareVersions('2.0b3', '2.0')).toBeLessThan(0);
  });

  it('keeps (from, to], with pre-releases only when they open the new line', () => {
    expect(inUpgradeRange('2.0.0', '1.10.26', '2.14.1')).toBe(true);
    expect(inUpgradeRange('1.10.26', '1.10.26', '2.14.1')).toBe(false);
    expect(inUpgradeRange('2.14.2', '1.10.26', '2.14.1')).toBe(false);
    expect(inUpgradeRange('2.0b3', '1.10.26', '2.14.1')).toBe(true);
    expect(inUpgradeRange('2.5.0b1', '1.10.26', '2.14.1')).toBe(false);
    expect(inUpgradeRange('16.0.0-canary.3', '16.0.0-canary.1', '16.0.0-canary.5')).toBe(true);
  });

  it('knows release lines and the majors crossed', () => {
    expect(crossesLine('15.5.28', '16.4.3')).toBe(true);
    expect(crossesLine('0.3.27', '0.3.30')).toBe(false);
    expect(crossesLine('0.3.27', '0.4.0')).toBe(true);
    expect(majorsInRange('5.9.3', '7.0.2')).toEqual([6, 7]);
    expect(majorsInRange('0.3.27', '1.4.7')).toEqual([1]);
  });

  it('finds the version in common heading styles', () => {
    expect(versionInHeading('[1.2.3] - 2024-01-01')).toBe('1.2.3');
    expect(versionInHeading('v2.0b3 (2023-06-16)')).toBe('2.0b3');
    expect(versionInHeading('5.0.0 / 2024-09-10')).toBe('5.0.0');
    expect(versionInHeading('langchain==1.0.0')).toBe('1.0.0');
    expect(versionInHeading('Version 3.1')).toBe('3.1');
    expect(versionInHeading('Breaking changes')).toBeUndefined();
  });

  it('reads tags of this package only', () => {
    expect(versionFromTag('v16.4.3', 'next')).toBe('16.4.3');
    expect(versionFromTag('typescript/v7.0.2', 'typescript')).toBe('7.0.2');
    expect(versionFromTag('langchain==1.4.7', 'langchain')).toBe('1.4.7');
    expect(versionFromTag('langchain-core==1.0.0', 'langchain')).toBeUndefined();
    expect(versionFromTag('@scope/pkg@2.0.0', '@scope/pkg')).toBe('2.0.0');
    expect(versionFromTag('vsix-test/v0.0.0', 'typescript')).toBeUndefined();
  });

  it('resolves a typed version: exact when published, else the newest in the range', () => {
    const all = ['4.21.2', '5.0.0', '5.1.0', '5.2.0-beta.1', '2.0', '2.0.1'];
    expect(resolveVersionSpec('5.x', all)).toBe('5.1.0');
    expect(resolveVersionSpec('2.0', all)).toBe('2.0');
    expect(resolveVersionSpec('v4.21.2', all)).toBe('4.21.2');
    expect(resolveVersionSpec('9.x', all)).toBeUndefined();
  });
});

const CHANGELOG = `# Changelog

## [2.1.0] - 2026-05-01
### Features
- Add \`newThing\`
- Remove unused test fixtures

## [2.0.0] - 2026-01-01
### Breaking Changes
- Removed \`oldFn\`; use \`newFn\` instead
- Node 18 is no longer supported

### Deprecations
- \`legacyOption\` is deprecated

## [1.2.0] - 2025-06-01
- Drop support for the \`callback\` argument

## 1.1.0
- Fix a crash
`;

describe('changelog sections', () => {
  it('splits markdown changelogs by version heading and filters the range', () => {
    const s = parseChangelog(CHANGELOG);
    expect(s.map((x) => x.version)).toEqual(['2.1.0', '2.0.0', '1.2.0', '1.1.0']);
    expect(sectionsInRange(s, '1.2.0', '2.1.0').map((x) => x.version)).toEqual(['2.1.0', '2.0.0']);
    expect(s[1].body).toContain('### Deprecations');
  });

  it('reads setext (Express History.md) and RST headings', () => {
    const history = '5.0.0 / 2024-09-10\n==================\n\n  * remove `app.del`\n\n4.21.2 / 2024-11-06\n===================\n\n  * deps: path-to-regexp@0.1.12\n';
    expect(parseChangelog(history).map((x) => x.version)).toEqual(['5.0.0', '4.21.2']);
    const rst = 'Changelog\n=========\n\nv2.0.0\n------\n\n- Removed ``old``\n\nv1.9.0\n------\n\n- Fix\n';
    expect(parseChangelog(rst).map((x) => x.version)).toEqual(['2.0.0', '1.9.0']);
  });

  it('classifies entries by their heading and wording', () => {
    const [v210, v200, v120] = parseChangelog(CHANGELOG);
    const items = [v210, v200, v120].flatMap((s) => extractItems(s, 'CHANGELOG.md', 'u'));
    const by = (t: string) => items.find((i) => i.text.includes(t))?.category;
    expect(by('Removed `oldFn`')).toBe('breaking');
    expect(by('Node 18')).toBe('breaking');
    expect(by('legacyOption')).toBe('deprecation');
    expect(by('newThing')).toBe('other');
    expect(by('unused test fixtures')).toBe('other');
    expect(by('callback')).toBe('breaking');
  });

  it('treats a prose section under a warning heading as one breaking entry, code included', () => {
    const body = '### ⚠️ `z.emoji()` rejects component-only strings\n\nThe pattern now requires a pictograph.\n\n```ts\nz.emoji().parse("123"); // fails\n```\n\n## Commits\n- docs: drop the old section\n- [`f7fd5548`] perf: drop lookaheads';
    const items = extractItems({ version: '4.6.0', title: 'v4.6.0', body }, 'GitHub release v4.6.0', 'u');
    expect(items[0].category).toBe('breaking');
    expect(items[0].text).toMatch(/^⚠️ `z.emoji\(\)` rejects component-only strings: The pattern/);
    expect(items[0].text).toContain('```ts');
    expect(items.slice(1).every((i) => i.category === 'other')).toBe(true);
  });

  it('does not read "non-breaking" as breaking, and spots conventional commits and new packages', () => {
    expect(classify('Several minor changes (considered non-breaking changes) are included')).toBe('other');
    expect(classify('feat(router)!: drop the legacy matcher')).toBe('breaking');
    expect(classify('Text splitters moved to a separate package `langchain-text-splitters`')).toBe('package');
    expect(classify('The `types` option now defaults to []')).toBe('config');
    expect(classify('Revert "Remove `foo`"')).toBe('other');
  });

  it('dedupes the same entry seen in the changelog and the release notes', () => {
    const a: ChangeItem = { category: 'breaking', version: '2.0.0', text: 'Removed `oldFn` [#12](https://x)\n  * detail', source: 'CHANGELOG.md', url: 'u' };
    const b: ChangeItem = { ...a, text: 'Removed `oldFn` #12', source: 'GitHub release v2.0.0' };
    expect(dedupeItems([a, b])).toHaveLength(1);
  });
});

describe('.d.ts export diff', () => {
  const before = `
/** Old API. */
export declare function oldFn(a: string): void;
export declare function parse(input: string): Result;
export declare function parse(input: Buffer): Result;
export interface Options {
  strict?: boolean;
  /** gone in 2.0 */
  legacy: number;
  method(x: Map<string, number>, y: number): void;
}
export declare const VERSION: "1.2.0";
declare class Internal { }
export { Internal as Engine };
export * from './extra';
`;
  const after = `
export declare function newFn(a: string, opts?: { strict: boolean }): void;
export declare function parse(input: string): Result;
export declare function parse(input: Buffer): Result;
export interface Options {
  strict?: boolean;
  method(x: Map<string, number>, y: number): void;
}
export declare const VERSION: "2.0.0";
declare class Internal { }
export { Internal as Engine };
`;

  it('splits top-level declarations at braces and semicolons', () => {
    const parts = splitTopLevel('export interface A { b: { c: 1 }; }\nexport type T = { x: 1 };\nexport declare function f(): void;');
    expect(parts).toEqual(['export interface A { b: { c: 1 }; }', 'export type T = { x: 1 };', 'export declare function f(): void;']);
  });

  it('reports removed exports, changed signatures and removed members, not overload order', () => {
    const d = diffExports(ownExports(parseDts(before)), ownExports(parseDts(after)));
    expect(d.removed.map((r) => r.name)).toEqual(['oldFn']);
    expect(d.added).toEqual(['newFn']);
    const opts = d.changed.find((c) => c.name === 'Options');
    expect(opts?.removedMembers).toEqual(['legacy']);
    expect(d.changed.find((c) => c.name === 'VERSION')?.after).toContain('"2.0.0"');
    expect(d.changed.find((c) => c.name === 'parse')).toBeUndefined();
    expect(d.changed.find((c) => c.name === 'Engine')).toBeUndefined();
  });

  it('reads export = namespaces (typescript.d.ts) and export lists', () => {
    const ns = parseDts('declare namespace ts {\n  function createProgram(o: Options): Program;\n  interface Program { emit(): void; }\n}\nexport = ts;');
    const e = ownExports(ns);
    expect([...e.keys()].sort()).toEqual(['Program', 'createProgram']);
    const p = parseDts("export * from './a.js';\nexport { x, y as z } from './b';\nimport * as m from './m';\nexport { m };");
    expect(p.starFrom).toEqual(['./a.js']);
    expect(p.namedFrom).toEqual([{ name: 'x', as: 'x', from: './b' }, { name: 'y', as: 'z', from: './b' }]);
    expect(p.namespaceFrom).toEqual([{ as: 'm', from: './m' }]);
  });

  it('finds the type entry points of a package', () => {
    const files = new Set(['index.d.cts', 'v3/index.d.cts', 'server.d.ts', 'index.d.ts']);
    expect([...typeEntries({ exports: { '.': { types: './index.d.cts' }, './v3': { types: './v3/index.d.cts' }, './package.json': './package.json' } }, files).entries()])
      .toEqual([['.', 'index.d.cts'], ['./v3', 'v3/index.d.cts']]);
    expect([...typeEntries({ types: 'index.d.ts' }, files).keys()]).toEqual(['.', './server']);
  });
});

describe('sources', () => {
  it('scores migration guides by the majors they name', () => {
    expect(guideScore('docs/01-app/02-guides/upgrading/version-16.md', [16])).toBe(3);
    expect(guideScore('docs/01-app/02-guides/upgrading/version-14.md', [16])).toBeUndefined();
    expect(guideScore('docs/upgrading/codemods.md', [16])).toBe(1);
    expect(guideScore('LangChain v1 migration guide /oss/python/migrate/langchain-v1.md', [1])).toBe(3);
    expect(guideScore('docs/api/routing.md', [16])).toBeUndefined();
    expect(majorMarkers('https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/')).toContain(7);
  });

  it('keeps monorepo changelogs that belong to the package', () => {
    expect(changelogPathRelevant('CHANGELOG.md', 'next', undefined, [16])).toBe(true);
    expect(changelogPathRelevant('packages/next/CHANGELOG.md', 'next', undefined, [16])).toBe(true);
    expect(changelogPathRelevant('packages/other/CHANGELOG.md', 'next', undefined, [16])).toBe(false);
    expect(changelogPathRelevant('packages/docs/content/v4/changelog.mdx', 'zod', undefined, [4])).toBe(true);
    expect(changelogPathRelevant('packages/docs-v3/CHANGELOG.md', 'zod', undefined, [4])).toBe(false);
  });

  it('follows a short release body to its announcement, not to code hosts or security posts', () => {
    expect(announcementLink('For release notes, check out the [release announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/).')).toBe(
      'https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/',
    );
    expect(announcementLink('See https://github.com/x/y/pull/1 and https://vercel.com/changelog/summary-of-cve-2026-1')).toBeUndefined();
  });

  it('turns a blog post into markdown with headings, lists and code', () => {
    const md = htmlToMarkdown('<html><body><nav>menu</nav><article><h2 id="x">rootDir now defaults to <code>.</code></h2><p>Set it &amp; forget.</p><ul><li><p>one</p></li></ul><pre><code>{ &quot;rootDir&quot;: &quot;./src&quot; }</code></pre></article><script>evil()</script></body></html>');
    expect(md).toContain('## rootDir now defaults to `.`');
    expect(md).toContain('Set it & forget.');
    expect(md).toContain('- one');
    expect(md).toContain('{ "rootDir": "./src" }');
    expect(md).not.toContain('evil');
    expect(md).not.toContain('menu');
  });
});

describe('output budget', () => {
  const item = (i: number, category: ChangeItem['category'] = 'breaking'): ChangeItem => ({
    category, version: `2.${i % 3}.0`, text: `Removed \`api${i}\` ${'x'.repeat(200)}`, source: 'CHANGELOG.md', url: 'u',
  });

  it('formatItems stays within its budget and groups by version, oldest first', () => {
    const items = Array.from({ length: 50 }, (_, i) => item(i));
    const out = formatItems(items, 2000);
    expect(out.used).toBeLessThanOrEqual(2000 + 200);
    expect(out.shown).toBeLessThan(50);
    const versions = out.text.split('\n').filter((l) => !l.startsWith('- ')).map((l) => l.split(',')[0]);
    expect(versions).toEqual([...versions].sort());
    expect(out.text).toContain('- BREAKING: Removed `api0`');
  });

  it('ranks breaking entries and the release that opens the line first', () => {
    const items: ChangeItem[] = [
      { category: 'other', version: '2.3.0', text: 'Faster parsing', source: 's', url: 'u' },
      { category: 'deprecation', version: '2.3.0', text: '`x` is deprecated', source: 's', url: 'u' },
      { category: 'breaking', version: '2.3.0', text: 'Remove `y`', source: 's', url: 'u' },
      { category: 'breaking', version: '2.0.0', text: 'Remove `z`', source: 's', url: 'u' },
    ];
    expect(rankItems(items, '1.9.0').map((i) => i.text)).toEqual(['Remove `z`', 'Remove `y`', '`x` is deprecated', 'Faster parsing']);
    // A query lifts a matching entry above the ones it does not mention, but not above breaking ones.
    const withQuery = rankItems(items, '1.9.0', 'faster parsing').map((i) => i.text);
    expect(withQuery.indexOf('Faster parsing')).toBeLessThan(withQuery.indexOf('`x` is deprecated'));
    expect(withQuery.indexOf('Faster parsing')).toBeGreaterThan(withQuery.indexOf('Remove `z`'));
  });

  it('formatApiDiff truncates long diffs to its budget', () => {
    const removed = Array.from({ length: 300 }, (_, i) => ({ name: `export${i}`, kind: 'function' as const }));
    const changed = Array.from({ length: 40 }, (_, i) => ({ name: `fn${i}`, kind: 'function' as const, before: `function fn${i}(a:string):void`, after: `function fn${i}(a:number):void` }));
    const text = formatApiDiff({ diffs: [{ entry: '.', removed, changed, added: [] }], removedEntries: ['./legacy'], addedEntries: [] }, 1500);
    expect(text.length).toBeLessThanOrEqual(1500 + 30);
    expect(text).toContain('BREAKING: entry points removed: ./legacy');
    expect(text).toContain('root: 300 exports removed, 40 changed');
  });

  it('lists the other sections of a version guide, notable ones first, within a budget', () => {
    const guide = { label: 'upgrading/version-16.md', url: 'https://x/upgrading/version-16.md', versionAccurate: true,
      content: '# Upgrade to 16\n## Turbopack is faster\ntext\n## `middleware` to `proxy`\ntext\n## React 19.2\ntext\n' };
    const toc = guideToc([guide], [], [16], 400);
    expect(toc).toMatch(/Other sections of upgrading\/version-16.md: `middleware` to `proxy`; Turbopack is faster; React 19.2\./);
    expect(guideToc([guide], [], [16], 50).length).toBeLessThanOrEqual(80);
  });

  it('drops MDX comments and bare JSX tags from guides', () => {
    expect(cleanMdx('a\n{/* hidden */}\n<Tabs items={["x"]}>\n<Tab value="x">\ntext\n</Tab>\n</Tabs>\nb')).toBe('a\n\ntext\n\nb');
  });
});
