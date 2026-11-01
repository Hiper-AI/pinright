/**
 * Lookalike names that are not new: flagged when their audience is a tiny
 * fraction of the original's, left alone when they are real packages.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const downloads = new Map<string, number>();

vi.mock('../src/advisories/resolve.js', async () => {
  const actual = await vi.importActual<typeof import('../src/advisories/resolve.js')>('../src/advisories/resolve.js');
  return {
    ...actual,
    assessPackage: vi.fn(async (eco: string, name: string) => ({ package: name, ecosystem: eco, verdict: 'ok', checkedAt: '', sources: [] })),
  };
});
vi.mock('../src/advisories/depsdev.js', () => ({
  // Both packages have existed for years: the "young package" rule does not apply.
  getPackage: vi.fn(async () => ({ versions: [{ versionKey: { version: '1.0.0' }, publishedAt: '2016-01-01T00:00:00Z' }] })),
}));
vi.mock('../src/risk/sources.js', () => ({
  weeklyDownloads: vi.fn(async (_eco: string, name: string) => downloads.get(name)),
}));

const { checkPackage } = await import('../src/verdict.js');

beforeEach(() => downloads.clear());

describe('old lookalikes', () => {
  it('flags one used by under 1% of the original audience', async () => {
    downloads.set('expresss', 120);
    downloads.set('express', 40_000_000);
    const v = await checkPackage('npm', 'expresss', undefined, { risk: false });
    expect(v.report.verdict).toBe('possible-typosquat');
    expect(v.typo?.lookalikeOf).toBe('express');
    expect(v.report.reason).toContain('120 weekly downloads against 40,000,000');
  });

  it('leaves a real package with a similar name alone', async () => {
    downloads.set('preact', 6_000_000);
    downloads.set('react', 50_000_000);
    expect((await checkPackage('npm', 'preact', undefined, { risk: false })).report.verdict).toBe('ok');
  });

  it('leaves an old package with a large audience of its own alone, even next to a giant', async () => {
    // Found replaying public CI (bench/fp): "unicorn" next to "uvicorn", "xterm" next to "xtend".
    downloads.set('unicorn', 568_055);
    downloads.set('uvicorn', 149_106_925);
    expect((await checkPackage('pypi', 'unicorn', undefined, { risk: false })).report.verdict).toBe('ok');
    downloads.set('xterm', 627_475);
    downloads.set('xtend', 132_848_329);
    expect((await checkPackage('npm', 'xterm', undefined, { risk: false })).report.verdict).toBe('ok');
    // A lookalike with a few thousand downloads next to the same giant is still flagged.
    downloads.set('uvicorm', 4_000);
    expect((await checkPackage('pypi', 'uvicorm', undefined, { risk: false })).report.verdict).toBe('possible-typosquat');
  });

  it('without download data it does not guess', async () => {
    expect((await checkPackage('npm', 'expresss', undefined, { risk: false })).report.verdict).toBe('ok');
  });
});
