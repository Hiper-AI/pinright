import { describe, expect, it } from 'vitest';
import {
  applicableRenames, currentGuides, declaredIn, expandQuery, renamesFromGuide, renamesFromPython, renamesFromTypes, renamesNote,
} from '../src/docs/renames.js';

const DTS = `type CallSettings = {
  /**
   * Instructions to include in the prompt.
   *
   * @deprecated Use \`instructions\` instead.
   */
  system?: Instructions;
  /**
   * @deprecated Will be removed in the next major.
   */
  experimental_old?: boolean;
  /** @deprecated use {@link isStepCount} */
};
/**
 * Stops after n steps.
 * @deprecated Renamed to \`isStepCount\`.
 * @param n steps
 */
export declare function stepCountIs(n: number): StopCondition;
/** @deprecated Use with caution. */
export declare const risky: number;
`;

describe('renames read from the package', () => {
  it('type definitions: @deprecated paired with the declaration it documents, only when it names a replacement', () => {
    expect(renamesFromTypes(DTS, 'index.d.ts')).toEqual([
      { from: 'system', to: 'instructions', source: 'index.d.ts' },
      { from: 'stepCountIs', to: 'isStepCount', source: 'index.d.ts' },
    ]);
  });

  it('python: a deprecated def names its replacement in the decorator or the docstring', () => {
    const api = [
      '# module fastapi.applications',
      'class FastAPI:',
      '    @deprecated("on_event is deprecated, use lifespan event handlers instead.")',
      '    def on_event(self, event_type: str): ...',
      '    def get(self, path: str):',
      '        """Use `api_route` for more options."""',
      'def parse_obj(obj):',
      '    """Deprecated. Use `model_validate` instead."""',
    ].join('\n');
    expect(renamesFromPython(api, 'fastapi/applications.py').map((r) => `${r.from}->${r.to}`)).toEqual(['on_event->lifespan', 'parse_obj->model_validate']);
  });

  it('declaredIn: a replacement counts only when the API declares it', () => {
    const api = 'class FastAPI:\n    def __init__(self, lifespan: Lifespan | None = None): ...\nExtra: TypeAlias = Literal["allow"]';
    expect(declaredIn(api, 'lifespan')).toBe(true);
    expect(declaredIn(api, 'literal')).toBe(false);
    expect(declaredIn('  instructions?: Instructions;', 'instructions')).toBe(true);
    expect(declaredIn('export declare function isStepCount(n: number): StopCondition;', 'isStepCount')).toBe(true);
  });

  it('migration guides: arrows, "renamed to", "replaced by", "use X instead of Y", never keywords or prose', () => {
    const md = [
      '| `system` → `instructions` |',
      '`stepCountIs` has been renamed to `isStepCount`.',
      'Replace `toDataStreamResponse()` with `toUIMessageStreamResponse()`.',
      'Use `z.strictObject` instead of `z.object().strict()`.',
      '`cacheTime` is now `gcTime`.',
      '`let` → `var` in compiled output.',
      'The `options` argument → see the guide below.',
    ].join('\n');
    expect(renamesFromGuide(md, 'migration-guide-7-0.mdx').map((r) => `${r.from}->${r.to}`)).toEqual([
      'system->instructions', 'stepCountIs->isStepCount', 'toDataStreamResponse->toUIMessageStreamResponse', 'cacheTime->gcTime',
    ]);
  });

  it('currentGuides: the guide of the current major, else an unnumbered one; never an older changelog', () => {
    const files = [
      { path: 'content/docs/08-migration-guides/26-migration-guide-7-0.mdx' },
      { path: 'content/docs/08-migration-guides/27-migration-guide-6-0.mdx' },
      { path: 'CHANGELOG-pre-7.md' },
      { path: 'docs/guide.md' },
    ];
    expect(currentGuides(files, '7.0.157').map((f) => f.path)).toEqual(['content/docs/08-migration-guides/26-migration-guide-7-0.mdx']);
    expect(currentGuides([{ path: 'docs/01-app/02-guides/upgrading/version-16.mdx' }, { path: 'docs/upgrading/version-15.mdx' }], '16.4.3')).toHaveLength(1);
    expect(currentGuides([{ path: 'packages/docs/content/v4/changelog.mdx' }], '4.6.7')).toHaveLength(1);
    expect(currentGuides([{ path: 'docs/migration.md' }, { path: 'CHANGELOG.md' }], '2.14.2').map((f) => f.path)).toEqual(['docs/migration.md']);
    expect(currentGuides([{ path: 'docs/migration.md' }], '0.45.4')).toEqual([]);
  });
});

describe('renames applied to a question', () => {
  const renames = [
    { from: 'system', to: 'instructions', source: 'index.d.ts' },
    { from: 'responses', to: 'calls', source: 'index.d.ts' },
    { from: 'on_event', to: 'lifespan', source: 'applications.py' },
    { from: 'stepCountIs', to: 'isStepCount', source: 'index.d.ts' },
  ];

  it('only renames whose old name the question uses as written, not ones it already has', () => {
    const q = 'route handler: multi-step stopWhen, system prompt, stream the response to useChat';
    expect(applicableRenames(renames, q).map((r) => r.from)).toEqual(['system']);
    expect(applicableRenames(renames, 'stop the loop with stepCountIs(5)').map((r) => r.from)).toEqual(['stepCountIs']);
    expect(applicableRenames(renames, 'stop after five steps')).toEqual([]);
    expect(applicableRenames(renames, 'system prompt via instructions')).toEqual([]);
  });

  it('expandQuery puts the new name next to the old one, so its topic searches for both', () => {
    expect(expandQuery('tools, system prompt, stream', [renames[0]])).toBe('tools, system instructions prompt, stream');
    expect(expandQuery('run code on startup (on_event)', [renames[2]])).toBe('run code on startup (on_event lifespan)');
  });

  it('renamesNote lists identifiers and the file each came from', () => {
    expect(renamesNote('ai', '7.0.0', [renames[0]])).toBe(
      "Renamed or deprecated in ai@7.0.0, per the package's own files: `system` -> `instructions` (index.d.ts). The docs below were also searched for the new names.",
    );
    expect(renamesNote('ai', '7.0.0', [])).toBeUndefined();
  });
});
