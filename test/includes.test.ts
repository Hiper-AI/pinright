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

const { expandIncludes, includeCandidates } = await import('../src/docs/includes.js');

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

  it('respects the budget and the line cap', async () => {
    files.set(`${ROOT}docs_src/big.py`, Array.from({ length: 200 }, (_, i) => `line_${i} = ${i}`).join('\n'));
    const r = await expandIncludes('{* ../../docs_src/big.py *}', PAGE, { budget: 5000, prepare: (c) => c, maxLines: 10 });
    expect(r.text.split('\n').filter((l) => l.startsWith('line_'))).toHaveLength(10);
    expect(r.text).toContain('\n...\n```');
    const none = await expandIncludes('{* ../../docs_src/big.py *}', PAGE, { budget: 0, prepare: (c) => c });
    expect(none.text).toBe('{* ../../docs_src/big.py *}');
  });
});
