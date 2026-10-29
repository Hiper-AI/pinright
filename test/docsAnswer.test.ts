/**
 * get-docs end to end with fixture registries: what the answer gathers and how it says it.
 * Upstreams are keyed by URL, as in injection.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SAFECTX_NO_CACHE = '1';
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

const fixtures = new Map<string, unknown>();

vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  const get = (url: string) => {
    const key = [...fixtures.keys()].filter((k) => url.includes(k)).sort((a, b) => b.length - a.length)[0];
    const v = key === undefined ? undefined : fixtures.get(key);
    if (v === undefined) throw new actual.HttpError(404, url);
    return v;
  };
  return {
    ...actual,
    getJson: vi.fn(async (url: string) => get(url)),
    getText: vi.fn(async (url: string) => {
      const v = get(url);
      return typeof v === 'string' ? v : JSON.stringify(v);
    }),
  };
});

const { getDocs } = await import('../src/docs/index.js');

const DTS = [
  'export interface CallSettings {',
  '  /**',
  '   * @deprecated Use `instructions` instead.',
  '   */',
  '  system?: string;',
  '  /** The system prompt and other instructions given to the model. */',
  '  instructions?: string;',
  '}',
  'export declare function streamText(settings: CallSettings): void;',
].join('\n');

function seed() {
  fixtures.set('registry.npmjs.org/lib/2.0.0', { name: 'lib', description: 'a client', types: 'dist/index.d.ts' });
  fixtures.set('data.jsdelivr.com/v1/packages/npm/lib@2.0.0', {
    files: [
      { name: '/README.md', size: 200 },
      { name: '/dist/index.d.ts', size: DTS.length },
      { name: '/dist/decorators/core/use-guards.decorator.d.ts', size: 200 },
      { name: '/dist/decorators/core/controller.decorator.d.ts', size: 200 },
    ],
  });
  fixtures.set('cdn.jsdelivr.net/npm/lib@2.0.0/README.md', '# lib\n\n## Install\n\nnpm install lib\n');
  fixtures.set('cdn.jsdelivr.net/npm/lib@2.0.0/dist/index.d.ts', DTS);
  fixtures.set(
    'cdn.jsdelivr.net/npm/lib@2.0.0/dist/decorators/core/use-guards.decorator.d.ts',
    '/** Binds guards to a controller or route: `@UseGuards(AuthGuard)`. */\nexport declare function UseGuards(...guards: unknown[]): MethodDecorator;\n',
  );
  fixtures.set('cdn.jsdelivr.net/npm/lib@2.0.0/dist/decorators/core/controller.decorator.d.ts', 'export declare function Controller(prefix?: string): ClassDecorator;\n');
}

beforeEach(() => fixtures.clear());

describe('get-docs answer', () => {
  it('reads a deep type definition whose path names the question, not the ones that do not', async () => {
    seed();
    const r = await getDocs({ ecosystem: 'npm', name: 'lib', version: '2.0.0', query: 'protect a route with a guard' });
    expect(r.text).toContain('@UseGuards(AuthGuard)');
    expect(r.sources.map((s) => s.label)).not.toContain('dist/decorators/core/controller.decorator.d.ts');
  });

  it("the current major's migration guide answers setup questions; older guides do not", async () => {
    seed();
    const listing = fixtures.get('data.jsdelivr.com/v1/packages/npm/lib@2.0.0') as { files: { name: string; size: number }[] };
    listing.files.push({ name: '/docs/upgrade-guide-2-0.md', size: 300 }, { name: '/docs/upgrade-guide-1-0.md', size: 300 });
    fixtures.set('cdn.jsdelivr.net/npm/lib@2.0.0/docs/upgrade-guide-2-0.md', '# Upgrading to 2.0\n\n## Using Vite\n\nInstall the plugin: `import lib from "@lib/vite"` and add it to plugins.\n');
    fixtures.set('cdn.jsdelivr.net/npm/lib@2.0.0/docs/upgrade-guide-1-0.md', '# Upgrading to 1.0\n\n## Using Vite\n\nUse the old `lib-vite-legacy` plugin.\n');
    const r = await getDocs({ ecosystem: 'npm', name: 'lib', version: '2.0.0', query: 'install lib with Vite' });
    expect(r.text).toContain('@lib/vite');
    expect(r.text).not.toContain('lib-vite-legacy');
  });

  it('a question in the old name also searches the new one, and says so inside a fence', async () => {
    seed();
    const r = await getDocs({ ecosystem: 'npm', name: 'lib', version: '2.0.0', query: 'streamText with a system prompt' });
    expect(r.text).toMatch(/<untrusted-data id="[0-9a-f]+" source="dist\/index\.d\.ts, lib@2\.0\.0">\nRenamed or deprecated in lib@2\.0\.0, per the package's own files: `system` -> `instructions` \(dist\/index\.d\.ts\)\./);
    expect(r.text).toContain('instructions?: string;');
  });
});
