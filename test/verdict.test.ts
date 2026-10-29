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

  it('without download data it does not guess', async () => {
    expect((await checkPackage('npm', 'expresss', undefined, { risk: false })).report.verdict).toBe('ok');
  });
});
