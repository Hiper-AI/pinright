import { describe, expect, it } from 'vitest';
import { chunkFile, chunkMarkdown, chunkTypes, coverPaths, notUserDocs, rank, rankPaths, select, singular, tidy, tokenize, type DocFile } from '../src/docs/retrieve.js';
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

describe('tidy', () => {
  it('drops the repeated heading, images, comments, JSX tags and relative link targets, never inside code', () => {
    const md = '## Matcher\n\n<!-- hidden -->\n![diagram](/img/a.png)\n<Tabs>\nSee [Middleware](/docs/middleware) and [spec](https://x.dev/spec).\n</Tabs>\n\n\n\n```js\n// [keep](/this) <Tabs>\n## not a heading\n```';
    expect(tidy(md)).toBe('See Middleware and [spec](https://x.dev/spec).\n\n```js\n// [keep](/this) <Tabs>\n## not a heading\n```');
  });

  it('applies to markdown chunks only, and drops chunks left empty', () => {
    const md = chunkFile(file('a.md', '# Title\n![x](/x.png)\n## Usage\nrun it'));
    expect(md.map((c) => [c.title, c.text])).toEqual([['Title > Usage', 'run it']]);
    const types = chunkFile(file('i.d.ts', '/** [a](/b) */\nexport declare function f(): void;', 'types'));
    expect(types[0].text).toContain('[a](/b)');
  });
});

describe('ranking', () => {
  it('tokenizes camelCase and drops stop words', () => {
    expect(tokenize('How to use NextResponse.redirect in middleware')).toEqual(['next', 'response', 'redirect', 'middleware']);
  });

  it('plurals match their singular on both sides (errors / error.md, guard / guards.md)', () => {
    expect(['errors', 'guards', 'queries', 'matches', 'classes', 'cookies', 'cookie', 'class', 'status', 'redis', 'aws'].map(singular)).toEqual(
      ['error', 'guard', 'query', 'match', 'class', 'cooky', 'cooky', 'class', 'status', 'redis', 'aws'],
    );
    expect(rankPaths([{ path: 'docs/tutorial/handling-errors.md' }, { path: 'docs/tutorial/body.md' }], 'return a 404 error')[0].path).toBe('docs/tutorial/handling-errors.md');
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

  it('rankPaths: in a large tree a rare term outweighs common ones (Next 16: middleware.mdx vs *Redirect/*Routes pages)', () => {
    const filler = Array.from({ length: 60 }, (_, i) => ({ path: `docs/config/${i % 2 ? 'skip-redirect' : 'typed-routes'}-${i}.mdx` }));
    const files = [...filler, { path: 'docs/01-app/03-api-reference/03-file-conventions/middleware.mdx' }];
    const r = rankPaths(files, 'protect routes with middleware and redirect to login');
    expect(r[0].path).toMatch(/middleware\.mdx$/);
    // Small lists keep the flat weight: two hits beat one.
    expect(rankPaths([{ path: 'a/redirect-routes.md' }, { path: 'a/middleware.md' }], 'middleware redirect routes')[0].path).toBe('a/redirect-routes.md');
  });

  it('coverPaths covers every matched query term before taking more of the same', () => {
    const extra = Array.from({ length: 12 }, (_, i) => ({ path: `docs/api/pydantic_extra_types_${i}.md` }));
    const files = [...extra, { path: 'docs/concepts/config.md' }, { path: 'docs/concepts/validators.md' }];
    const ranked = rankPaths(files, 'ConfigDict extra forbid, validators, config');
    const picked = coverPaths(ranked.filter((f) => f.score > 0), 4).map((f) => f.path);
    expect(picked).toContain('docs/concepts/config.md');
    expect(picked).toContain('docs/concepts/validators.md');
    expect(picked.filter((p) => p.includes('extra_types'))).toHaveLength(2);
  });

  it('notUserDocs: contributor and agent notes, evals, plans and example apps are not user docs', () => {
    for (const p of [
      'astro/.agents/skills/astro-developer/SKILL.md', 'docs/plans/agent-native/004-skill-connection-config.md', 'packages/core/auth-js/AGENTS.md',
      'evals/proxy/PROMPT.md', 'examples/blog/src/content/blog/first-post.md', 'compiler/packages/babel-plugin-react-compiler/docs/passes/02-enterSSA.md',
      'docs/TESTING.md', 'docs/JSR_PUBLISHING.md', 'hono/docs/MAINTAINING.md', 'packages/realtime-js/migrations/httpsend.md', 'docs/en/docs/_llm-test.md',
    ]) expect(notUserDocs(p), p).toBe(true);
    for (const p of ['docs/01-app/03-api-reference/03-file-conventions/proxy.mdx', 'docs/topics/migrations.txt', 'docs/en/docs/advanced/events.md', 'docs/guide/templates.md']) {
      expect(notUserDocs(p), p).toBe(false);
    }
    // Error-message pages count when the question is about an error.
    expect(notUserDocs('errors/no-cache.mdx', 'set up caching')).toBe(true);
    expect(notUserDocs('errors/no-cache.mdx', 'fix the no-cache error')).toBe(false);
  });

  it('select skips near-duplicate sections (the same step in several framework guides)', () => {
    const step = 'Modify your route file to include the stopWhen condition so the model can call tools for several steps before answering the user question with the final result';
    const a = { file: file('nextjs.mdx', ''), title: 'Next.js > Multi-step', text: `${step} in app/api/chat/route.ts`, score: 3 };
    const b = { file: file('nuxt.mdx', ''), title: 'Nuxt > Multi-step', text: `${step} in server/api/chat.ts`, score: 2.9 };
    const c = { file: file('reference.mdx', ''), title: 'streamText > instructions', text: 'instructions: the system prompt given to the model before the messages', score: 1 };
    expect(select([a, b, c], 10_000).map((x) => x.file.label)).toEqual(['nextjs.mdx', 'reference.mdx']);
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

  it('parses consecutive entries without descriptions, one per line (react.dev)', () => {
    const idx = [
      '#### Managing State',
      '- [Managing State](https://react.dev/learn/managing-state.md)',
      '- [useActionState](https://react.dev/reference/react/useActionState.md)',
      '- [use](https://react.dev/reference/react/use.md)',
    ].join('\n');
    expect(parseLlmsIndex(idx, 'https://react.dev/').map((e) => [e.title, e.description])).toEqual([['Managing State', ''], ['useActionState', ''], ['use', '']]);
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
