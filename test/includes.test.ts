import { describe, expect, it, vi } from 'vitest';

process.env.SAFECTX_NO_CACHE = '1';

const files = new Map<string, string>();
vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return {
    ...actual,
    getText: vi.fn(async (url: string) => {
      const v = files.get(url);
      if (v === undefined) throw new actual.HttpError(404, url);
      return v;
    }),
  };
});

const { expandIncludes, includeCandidates, snippetSection } = await import('../src/docs/includes.js');

const PAGE = 'https://cdn.jsdelivr.net/gh/fastapi/fastapi@0.162.0/docs/en/docs/advanced/events.md';
const ROOT = 'https://cdn.jsdelivr.net/gh/fastapi/fastapi@0.162.0/';

describe('include directives', () => {
  it('candidates: relative to the page, then to each folder above it, never outside the repo', () => {
    expect(includeCandidates(PAGE, '../../docs_src/events/tutorial003_py310.py')).toEqual([
      `${ROOT}docs/en/docs_src/events/tutorial003_py310.py`,
      `${ROOT}docs/docs_src/events/tutorial003_py310.py`,
      `${ROOT}docs_src/events/tutorial003_py310.py`,
    ]);
    expect(includeCandidates('https://example.com/llms/page.md', 'x.py')).toEqual([]);
    expect(includeCandidates(PAGE, 'https://evil.example/x.py')).toEqual([]);
  });

  it('replaces FastAPI, snippet, literalinclude and VitePress directives with the fenced file', async () => {
    files.set(`${ROOT}docs_src/events/tutorial003_py310.py`, 'from contextlib import asynccontextmanager\n\n@asynccontextmanager\nasync def lifespan(app):\n    yield\n');
    files.set(`${ROOT}docs/en/docs/advanced/snip.ts`, 'export const a = 1;\n');
    const text = [
      'We create an async function `lifespan()`:',
      '',
      '{* ../../docs_src/events/tutorial003_py310.py hl[16,19] *}',
      '',
      '--8<-- "snip.ts"',
      '',
      '.. literalinclude:: missing.py',
    ].join('\n');
    const prepared: string[] = [];
    const r = await expandIncludes(text, PAGE, { budget: 5000, prepare: (code, src) => (prepared.push(src), code) });
    expect(r.text).toContain('```python\nfrom contextlib import asynccontextmanager');
    expect(r.text).toContain('```ts\nexport const a = 1;\n```');
    expect(r.text).toContain('.. literalinclude:: missing.py');
    expect(r.added).toBeGreaterThan(0);
    // Every included file goes through the same normalization as the docs.
    expect(prepared).toEqual(['tutorial003_py310.py', 'snip.ts']);
  });

  it('mkdocs macros and snippet paths found by their ending in the docs code, cut to their section, shown once', async () => {
    const page = 'https://raw.githubusercontent.com/pola-rs/polars/HEAD/docs/source/user-guide/expressions/aggregation.md';
    const code = 'https://raw.githubusercontent.com/pola-rs/polars/HEAD/docs/source/src/python/user-guide/expressions/aggregation.py';
    files.set(code, ['# --8<-- [start:setup]', 'import polars as pl', '# --8<-- [end:setup]', '', '# --8<-- [start:basic]', 'q = df.group_by("a").agg(pl.len())', '# --8<-- [end:basic]'].join('\n'));
    const listing = [{ path: 'docs/source/src/python/user-guide/expressions/aggregation.py', url: code }];
    const findFile = (suffix: string) => listing.find((f) => f.path.endsWith(`/${suffix}`))?.url;
    const text = [
      "{{code_block('user-guide/expressions/aggregation','basic',['group_by'])}}",
      '',
      '```python exec="on" result="text"',
      '--8<-- "python/user-guide/expressions/aggregation.py:basic"',
      '```',
      '',
      '```python exec="on"',
      '--8<-- "python/user-guide/expressions/aggregation.py:setup"',
      '```',
      '',
      "{{code_block('user-guide/expressions/missing','x')}}",
    ].join('\n');
    const r = await expandIncludes(text, page, { budget: 5000, prepare: (c) => c, findFile, exts: ['py'] });
    // The macro becomes a fenced block with the section only.
    expect(r.text).toContain('```python\nq = df.group_by("a").agg(pl.len())\n```');
    expect(r.text).not.toContain('[start:basic]');
    // The same section again stays a directive; inside a code block, another section is the code alone.
    expect(r.text).toContain('--8<-- "python/user-guide/expressions/aggregation.py:basic"');
    expect(r.text).toContain('```python exec="on"\nimport polars as pl\n```');
    // A macro whose file is not in the repo stays as written.
    expect(r.text).toContain("{{code_block('user-guide/expressions/missing','x')}}");
  });

  it('snippet sections: the lines between the markers, none without them', () => {
    expect(snippetSection('a\n# [start:x]\nb\n# [start:y]\nc\n# [end:y]\n# [end:x]\nd', 'x')).toBe('b\nc');
    expect(snippetSection('a\nb', 'x')).toBeUndefined();
  });

  it('respects the budget and the line cap', async () => {
    files.set(`${ROOT}docs_src/big.py`, Array.from({ length: 200 }, (_, i) => `line_${i} = ${i}`).join('\n'));
    const r = await expandIncludes('{* ../../docs_src/big.py *}', PAGE, { budget: 5000, prepare: (c) => c, maxLines: 10 });
    expect(r.text.split('\n').filter((l) => l.startsWith('line_'))).toHaveLength(10);
    expect(r.text).toContain('\n...\n```');
    const none = await expandIncludes('{* ../../docs_src/big.py *}', PAGE, { budget: 0, prepare: (c) => c });
    expect(none.text).toBe('{* ../../docs_src/big.py *}');
  });
});
