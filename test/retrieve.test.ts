import { describe, expect, it } from 'vitest';
import { asksSignature, isGenerated, isRst, chunkFile, chunkMarkdown, chunkTypes, coverPaths, notUserDocs, olderMajorPath, rank, rankPaths, select, singular, tidy, tokenize, topics, topicsFirst, identifiers, nameMatch, trimSection, type DocFile } from '../src/docs/retrieve.js';
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

  it('small sections under one heading join, each with its heading; big ones and flagged ones stay apart', () => {
    const md = '## Objects\nUse z.object.\n### `z.strictObject`\nThrows on unknown keys.\n### `z.looseObject`\nPasses unknown keys through.\n## Records\nz.record(z.string(), z.number())\n';
    const chunks = chunkFile(file('api.mdx', md));
    expect(chunks.map((c) => c.title)).toEqual(['Objects', 'Records']);
    expect(chunks[0].text).toBe('Use z.object.\n\n#### `z.strictObject`\nThrows on unknown keys.\n\n#### `z.looseObject`\nPasses unknown keys through.');
    const flagged = chunkFile(file('api.mdx', md), (t) => !t.includes('unknown keys through'));
    expect(flagged.map((c) => c.title)).toEqual(['Objects', 'Objects > `z.looseObject`', 'Records']);
    const long = `## A\n${'x '.repeat(500)}\n### B\n${'y '.repeat(500)}\n`;
    expect(chunkFile(file('a.md', long)).map((c) => c.title)).toEqual(['A', 'A > B']);
  });

  it('isRst: .rst, and .txt under docs/ (Django), never a README', () => {
    expect(isRst('https://cdn.jsdelivr.net/gh/django/django@6.1.2/docs/topics/tasks.txt')).toBe(true);
    expect(isRst('docs/ref/models/constraints.txt')).toBe(true);
    expect(isRst('README.rst')).toBe(true);
    expect(isRst('docs/README.txt')).toBe(false);
    expect(isRst('notes.txt')).toBe(false);
    expect(chunkFile(file('docs/topics/tasks.txt', 'Tasks\n=====\n\nintro\n\nDefining tasks\n--------------\n\nUse ``@task``.\n'), undefined).map((c) => c.title)).toEqual(['Tasks']);
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

  it('olderMajorPath: copies of an older major the package still ships', () => {
    expect(olderMajorPath('v3/types.d.ts', '4.6.7')).toBe(true);
    expect(olderMajorPath('packages/docs-v3/ERROR_HANDLING.md', '4.6.7')).toBe(true);
    expect(olderMajorPath('docs/1.x/guide.md', '2.0.0')).toBe(true);
    expect(olderMajorPath('src/legacy/index.md', '1.0.0')).toBe(true);
    expect(olderMajorPath('packages/docs/content/v4/changelog.mdx', '4.6.7')).toBe(false);
    expect(olderMajorPath('v4/index.d.ts', '4.6.7')).toBe(false);
    expect(olderMajorPath('docs/api/v2-endpoints.md', '4.6.7')).toBe(false);
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

  it('topics: a question that asks several things splits into its topics; a single question does not', () => {
    expect(topics('reject unknown keys in an object; enum from a TypeScript enum; record of strings')).toEqual([
      'reject unknown keys in an object', 'enum from a TypeScript enum', 'record of strings',
    ]);
    expect(topics('ConfigDict frozen extra forbid, field_validator, model_validator mode after, Field pattern')).toHaveLength(4);
    expect(topics('Next.js route handler: streamText with tools, multi-step stopWhen, system prompt')).toEqual([
      'Next.js route handler', 'streamText with tools', 'multi-step stopWhen', 'system prompt',
    ]);
    expect(topics('protect /dashboard routes with middleware')).toEqual([]);
    expect(topics('z.email, z.strictObject')).toEqual(['z.email', 'z.strictObject']);
  });

  it('select gives each topic its best section before filling by overall score', () => {
    // The enum and record docs share many words with the whole question; strictObject's section few.
    const enumDoc = 'z.enum accepts a TypeScript enum. Enum values, enum from a native enum, enum options, record of enum keys. '.repeat(6);
    const recordDoc = 'z.record(z.string(), z.number()) a record of strings to numbers. Record keys from an enum. '.repeat(6);
    const strictDoc = `z.strictObject throws on unknown keys. ${'Lorem ipsum dolor sit amet. '.repeat(20)}`;
    const chunks = [
      { file: file('enum.md', ''), title: 'Enums', text: enumDoc, score: 0 },
      { file: file('record.md', ''), title: 'Records', text: recordDoc, score: 0 },
      { file: file('strict.md', ''), title: 'Strict objects', text: strictDoc, score: 0 },
    ];
    const q = 'reject unknown keys in an object; enum from a TypeScript enum; record of strings';
    const budget = 2 * (enumDoc.length + 100);
    expect(select(rank(chunks, q), budget).map((c) => c.title)).toEqual(['Enums', 'Records']);
    expect(select(rank(chunks, q, topics(q)), budget).map((c) => c.title)).toEqual(['Strict objects', 'Enums']);
  });

  it('identifiers and nameMatch: the API name as written beats words shared with its siblings', () => {
    expect(identifiers('z.email, z.record key value, field_validator, Field pattern=, @tool, ConfigDict, strictObject, plain words')).toEqual([
      'z.email', 'z.record', 'field_validator', 'pattern=', '@tool', 'ConfigDict', 'strictObject',
    ]);
    expect(nameMatch('const s = z.record(z.string(), z.number());', ['z.record'])).toBe(2);
    expect(nameMatch('z.partialRecord(z.enum(["a"]), z.number())', ['z.record'])).toBe(1);
    expect(nameMatch('name: str = Field(pattern=r"^a")', ['pattern='])).toBe(2);
    expect(nameMatch('the pattern of the field', ['pattern='])).toBe(1);
    const rec = { file: file('api.mdx', ''), title: 'Records', text: 'Record schemas: z.record(z.string(), z.number()) validates a record.', score: 0 };
    const partial = { file: file('api.mdx', ''), title: 'Partial records', text: 'Partial record schemas: z.partialRecord validates a partial record.', score: 0 };
    expect(rank([partial, rec], 'z.record')[0].title).toBe('Records');
  });

  it('trimSection cuts at a blank line outside code blocks and says so', () => {
    const text = `${'Intro sentence. '.repeat(20)}\n\n\`\`\`ts\n${'code();\n'.repeat(30)}\`\`\`\n\n${'More prose. '.repeat(40)}`;
    const cut = trimSection(text, 600)!;
    expect(cut.endsWith('[...]')).toBe(true);
    expect((cut.match(/```/g) ?? []).length % 2).toBe(0);
    expect(trimSection(text, 50)).toBeUndefined();
    expect(trimSection('short', 100)).toBe('short');
  });

  it('a long best section of a topic is cut to its share instead of losing to a worse one', () => {
    const long = { file: file('a.md', ''), title: 'Records', text: `z.record(z.string(), z.number())\n\n${`${'Records map keys to values. '.repeat(10)}\n\n`.repeat(12)}`, score: 0 };
    const other = { file: file('b.md', ''), title: 'Enums', text: 'z.enum(["a", "b"]) builds an enum.', score: 0 };
    const q = 'z.record of strings; z.enum';
    const picked = select(rank([long, other], q, topics(q)), 2000);
    expect(picked.map((c) => c.title)).toEqual(['Records', 'Enums']);
    expect(picked[0].text).toContain('z.record(z.string()');
    expect(picked[0].origin).toBe(long);
  });

  it('topicsFirst takes the best item of each topic, then the overall ranking, without repeats', () => {
    expect(topicsFirst(['a', 'b', 'c', 'd'], [['c', 'a'], ['a'], []], 3, (x) => x)).toEqual(['c', 'a', 'b']);
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

describe('generated SDK types', () => {
  it('a file that says it was generated, in its first lines', () => {
    expect(isGenerated('# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.\n\nclass X: ...')).toBe(true);
    expect(isGenerated('// Code generated by protoc-gen-go. DO NOT EDIT.\npackage x')).toBe(true);
    expect(isGenerated('/** @generated */\nexport type A = 1;')).toBe(true);
    expect(isGenerated('# Guide\nThis page explains how the client is generated.')).toBe(false);
    expect(isGenerated(`${'x'.repeat(700)} auto-generated`)).toBe(false);
  });

  it('how-to questions demote them; signature questions keep them', () => {
    expect(asksSignature('structured output parsed into a pydantic model')).toBe(false);
    expect(asksSignature('send a system prompt')).toBe(false);
    expect(asksSignature('what are the parameters of messages.create')).toBe(true);
    expect(asksSignature('return type of responses.parse')).toBe(true);
    expect(asksSignature('fields of the Message type')).toBe(true);
  });
});

describe('docs paths', () => {
  it('Sphinx .txt pages under docs/, but not the pip and spelling files next to them', async () => {
    const { isDocPath } = await import('../src/docs/sources.js');
    expect(isDocPath('docs/ref/models/constraints.txt')).toBe(true);
    expect(isDocPath('docs/topics/db/models.txt')).toBe(true);
    expect(isDocPath('docs/requirements.txt')).toBe(false);
    expect(isDocPath('docs/source/constraints.txt')).toBe(false);
    expect(isDocPath('docs/spelling_wordlist.txt')).toBe(false);
    expect(isDocPath('src/notes.txt')).toBe(false);
  });
});

describe('a whole site in one file', () => {
  it('llms-full.txt: the per-file cap counts each page, so four pages can each give their best section', () => {
    const pages = ['A', 'B', 'C', 'D'].map((p) => `# Page ${p}\n## Connection url ${p}\nSet the connection url for page ${p} in the config.\n`).join('\n');
    const site: DocFile = { ...file('llms-full.txt', pages), multiPage: true };
    const q = 'connection url config';
    expect(select(rank(chunkFile(site), q), 10_000)).toHaveLength(4);
    expect(select(rank(chunkFile({ ...site, multiPage: false }), q), 10_000)).toHaveLength(3);
  });
});
