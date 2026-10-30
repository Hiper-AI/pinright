import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SAFECTX_NO_CACHE = '1';

const repos = new Map<string, { homepage?: string | null; default_branch: string; archived?: boolean } | 'limit'>();
const asked: string[] = [];
vi.mock('../src/github.js', async () => {
  const { HttpError } = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return {
    githubJson: vi.fn(async (path: string) => {
      asked.push(path);
      const r = repos.get(path.replace(/^\/repos\//, ''));
      if (r === 'limit') throw new HttpError(403, path);
      if (!r) throw new HttpError(404, path);
      return r;
    }),
  };
});

const { discoverSiteRepo, packageSite, readmeDocsLink, sameSite, siteHost, siteRepoCandidates } = await import('../src/docs/discover.js');
import type { PackageMeta } from '../src/registry.js';

const meta = (name: string, owner: string, repo: string, extra: Partial<PackageMeta> = {}): PackageMeta =>
  ({ ecosystem: 'npm', name, version: '1.0.0', repo: { owner, repo }, ...extra }) as PackageMeta;

beforeEach(() => {
  repos.clear();
  asked.length = 0;
});

describe('docs site discovery', () => {
  it('compares sites by host, ignoring www. and docs.', () => {
    expect(siteHost('https://docs.astro.build/en/')).toBe('astro.build');
    expect(sameSite('https://docs.astro.build/', 'https://astro.build')).toBe(true);
    expect(sameSite('https://www.supabase.com', 'https://supabase.com/docs')).toBe(true);
    expect(sameSite('https://learn.example.com', 'https://example.com')).toBe(true);
    expect(sameSite('https://foo.github.io', 'https://bar.github.io')).toBe(false);
    expect(sameSite(undefined, 'https://astro.build')).toBe(false);
  });

  it('candidates: the org docs repo, <name>-docs, <name>.dev, the site host, and the org monorepo docs folder', () => {
    expect(siteRepoCandidates(meta('astro', 'withastro', 'astro'), 'https://astro.build')).toEqual([
      { repo: 'docs' }, { repo: 'astro-docs' }, { repo: 'astro.dev' }, { repo: 'astro.build' }, { repo: 'withastro', paths: ['apps/docs/', 'docs/'] },
    ]);
    // The package's own repo is read already; as the org monorepo only its docs folder counts.
    expect(siteRepoCandidates(meta('@acme/docs', 'acme', 'docs'), 'https://acme.dev').map((c) => c.repo)).not.toContain('docs');
  });

  it('takes the candidate whose GitHub homepage is the same site, at its default branch', async () => {
    repos.set('withastro/docs', { homepage: 'https://docs.astro.build/', default_branch: 'main' });
    repos.set('withastro/withastro', { homepage: 'https://withastro.org', default_branch: 'main' });
    expect(await discoverSiteRepo(meta('astro', 'withastro', 'astro'), 'https://astro.build')).toEqual({ owner: 'withastro', repo: 'docs', branch: 'main', paths: undefined });
  });

  it('a docs repo of the org that declares another site, or is archived, is never read', async () => {
    repos.set('acme/docs', { homepage: 'https://internal-wiki.example', default_branch: 'main' });
    repos.set('acme/widget-docs', { homepage: 'https://acme.dev', default_branch: 'main', archived: true });
    expect(await discoverSiteRepo(meta('widget', 'acme', 'widget'), 'https://acme.dev')).toBeUndefined();
  });

  it('the org monorepo counts with its docs folders only', async () => {
    repos.set('supabase/supabase', { homepage: 'https://supabase.com', default_branch: 'master' });
    expect(await discoverSiteRepo(meta('@supabase/supabase-js', 'supabase', 'supabase-js'), 'https://supabase.com')).toEqual({
      owner: 'supabase', repo: 'supabase', branch: 'master', paths: ['apps/docs/', 'docs/'],
    });
  });

  it('llms.txt bases: a docs URL keeps its folder first; a bare homepage tries its docs subdomain and /docs before the origin', async () => {
    const { llmsBases } = await import('../src/docs/sources.js');
    expect(llmsBases('https://stripe.com')).toEqual(['https://docs.stripe.com', 'https://stripe.com/docs', 'https://stripe.com']);
    expect(llmsBases('https://www.supabase.com/')).toEqual(['https://docs.supabase.com', 'https://www.supabase.com/docs', 'https://www.supabase.com']);
    expect(llmsBases('https://docs.pola.rs/api/python/stable/reference/index.html')).toEqual(['https://docs.pola.rs/api/python/stable/reference', 'https://docs.pola.rs']);
    expect(llmsBases('https://docs.astro.build/')).toEqual(['https://docs.astro.build']);
    expect(llmsBases('not a url')).toEqual([]);
  });

  it('a README names its docs site under a Documentation heading or on a line about the docs', () => {
    const readme = [
      '# Claude SDK for Python',
      '[![PyPI version](https://img.shields.io/pypi/v/anthropic.svg)](https://pypi.org/project/anthropic/)',
      'Access to the [Claude API](https://docs.anthropic.com/en/api/) from Python.',
      '## Documentation',
      'Tool helpers are in [tools.md](tools.md); source on [GitHub](https://github.com/anthropics/x).',
      'Full documentation is available at **[platform.claude.com/docs](https://platform.claude.com/docs/en/api/sdks/python)**.',
    ].join('\n');
    expect(readmeDocsLink(readme)).toBe('https://platform.claude.com/docs/en/api/sdks/python');
    expect(readmeDocsLink('Read the [docs](https://x.readthedocs.io/en/latest/) [![Docs](https://readthedocs.org/badge.svg)](https://x.readthedocs.io)')).toBe('https://x.readthedocs.io/en/latest/');
    expect(readmeDocsLink('[![npm](https://img.shields.io/npm/v/x.svg)](https://npmjs.org/package/x) docs')).toBeUndefined();
    expect(readmeDocsLink(`## Documentation\n${'x'.repeat(100_000)}](https://`)).toBeUndefined();
  });

  it('the site: the docs URL or homepage first, else the homepage the source repo declares', async () => {
    expect(await packageSite(meta('astro', 'withastro', 'astro', { docsUrl: 'https://astro.build/' }))).toEqual({ site: 'https://astro.build/', fromRepo: false });
    expect(asked).toEqual([]);
    repos.set('supabase/supabase-js', { homepage: 'https://supabase.com', default_branch: 'master' });
    expect(await packageSite(meta('@supabase/supabase-js', 'supabase', 'supabase-js'))).toEqual({ site: 'https://supabase.com/', fromRepo: true });
    // A repo homepage that is a registry page is no site.
    repos.set('openai/openai-python', { homepage: 'https://pypi.org/project/openai/', default_branch: 'main' });
    expect(await packageSite(meta('openai', 'openai', 'openai-python'))).toBeUndefined();
  });
});
