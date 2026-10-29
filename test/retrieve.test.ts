import { describe, expect, it } from 'vitest';
import { chunkMarkdown, chunkTypes, rank, rankPaths, select, tokenize, type DocFile } from '../src/docs/retrieve.js';
import { parseLlmsIndex, tagCandidates } from '../src/docs/sources.js';
import { ecosystemHint, formatLibraryId, nameVariants, parseLibraryRef } from '../src/search.js';

const file = (label: string, content: string, kind: DocFile['kind'] = 'markdown'): DocFile => ({ label, url: `u/${label}`, content, kind, versionAccurate: true });

describe('chunking', () => {
  it('markdown: one chunk per heading with the heading trail, front matter title kept, code fences respected', () => {
    const md = '---\ntitle: Middleware\ndescription: x\n---\nintro\n## Matcher\ntext\n```js\n# not a heading\n```\n### Negative matching\nmore\n## Proxy { #proxy }\nend';
    const chunks = chunkMarkdown(md);
    expect(chunks.map((c) => c.title)).toEqual(['Middleware', 'Middleware > Matcher', 'Middleware > Matcher > Negative matching', 'Middleware > Proxy']);
    expect(chunks[1].text).toContain('# not a heading');
  });

  it('rst headings only for .rst files', () => {
    expect(chunkMarkdown('Advanced\n========\nbody\n\nRetries\n-------\nx', true).map((c) => c.title)).toEqual(['Advanced', 'Advanced > Retries']);
    expect(chunkMarkdown('a: b\n---\nc').length).toBe(1);
  });

  it('type definitions: one chunk per declaration with its doc comment', () => {
    const dts = '/** Creates a server. */\nexport declare function createServer(opts: Opts): Server;\nexport interface Opts {\n  port: number;\n}\n';
    const c = chunkTypes(dts);
    expect(c.map((x) => x.title)).toEqual(['function createServer', 'interface Opts']);
    expect(c[0].text).toContain('Creates a server');
  });
});

describe('ranking', () => {
  it('tokenizes camelCase and drops stop words', () => {
    expect(tokenize('How to use NextResponse.redirect in middleware')).toEqual(['next', 'response', 'redirect', 'middleware']);
  });

  it('BM25 puts the section that answers the question first, and select respects the budget', () => {
    const chunks = [
      ...chunkMarkdown('## Installation\nnpm install x\n## Retries\nUse HTTPAdapter with Retry for backoff.\n```py\nRetry(total=3)\n```').map((p) => ({ file: file('a.md', ''), ...p, score: 0 })),
      ...chunkMarkdown('## Cookies\ncookie jar stuff').map((p) => ({ file: file('b.md', ''), ...p, score: 0 })),
    ];
    const ranked = rank(chunks, 'retry with backoff HTTPAdapter');
    expect(ranked[0].title).toBe('Retries');
    expect(select(ranked, 10_000).map((c) => c.title)).toEqual(['Retries']);
    expect(select(ranked, 10)).toEqual([]);
  });

  it('rankPaths prefers files whose path matches the query', () => {
    const r = rankPaths([{ path: 'docs/cookies.md' }, { path: 'docs/api/middleware.mdx' }, { path: 'docs/a/b/c/middleware.md' }], 'set up middleware');
    expect(r[0].path).toBe('docs/api/middleware.mdx');
  });
});

describe('sources helpers', () => {
  it('release tag spellings, including monorepo and langchain styles', () => {
    expect(tagCandidates('@tanstack/react-query', '5.0.0')).toEqual(
      expect.arrayContaining(['v5.0.0', '5.0.0', '@tanstack/react-query@5.0.0', 'react-query@5.0.0', '@tanstack/react-query==5.0.0']),
    );
  });

  it('parses llms.txt link lists', () => {
    expect(parseLlmsIndex('# X\n- [Routing](/docs/routing.md): how routes work\n* [API](https://x.dev/api)\n', 'https://x.dev/')).toEqual([
      { title: 'Routing', url: 'https://x.dev/docs/routing.md', description: 'how routes work' },
      { title: 'API', url: 'https://x.dev/api', description: '' },
    ]);
  });
});

describe('library ids and search helpers', () => {
  it('round-trips ids, scoped names and versions', () => {
    expect(parseLibraryRef('npm:@scope/pkg@1.2.3')).toEqual({ ecosystem: 'npm', name: '@scope/pkg', version: '1.2.3' });
    expect(parseLibraryRef('pypi:requests')).toEqual({ ecosystem: 'pypi', name: 'requests' });
    expect(parseLibraryRef('go:github.com/gin-gonic/gin@v1.9.0')).toEqual({ ecosystem: 'go', name: 'github.com/gin-gonic/gin', version: '1.9.0' });
    expect(parseLibraryRef('/vercel/next.js')).toBeUndefined();
    expect(formatLibraryId('npm', 'next', '16.4.3')).toBe('npm:next@16.4.3');
  });

  it('name variants and ecosystem hints', () => {
    expect(nameVariants('Chart.js')).toEqual(expect.arrayContaining(['chart.js', 'chart']));
    expect(ecosystemHint('requests python http')).toBe('pypi');
    expect(ecosystemHint('tokio rust')).toBe('cargo');
    expect(ecosystemHint('whatever')).toBeUndefined();
  });
});
