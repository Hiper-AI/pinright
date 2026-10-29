/**
 * querybatch answers that do not line up with the queries must not read as
 * "no advisories" (security review F5).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SAFECTX_NO_CACHE = '1';

let answer: unknown;
vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return { ...actual, getJson: vi.fn(async () => answer) };
});

const { queryBatch } = await import('../src/advisories/osv.js');
const items = [
  { ecosystem: 'npm' as const, name: 'a', version: '1.0.0' },
  { ecosystem: 'npm' as const, name: 'b', version: '1.0.0' },
];

beforeEach(() => {
  answer = undefined;
});

describe('queryBatch', () => {
  it('maps one result per query', async () => {
    answer = { results: [{ vulns: [{ id: 'GHSA-1' }] }, {}] };
    expect(await queryBatch(items)).toEqual([['GHSA-1'], []]);
  });

  it('throws when OSV returns fewer results than queries', async () => {
    answer = { results: [{}] };
    await expect(queryBatch(items)).rejects.toThrow(/1 results for 2 queries/);
  });

  it('throws when the answer has no results at all', async () => {
    answer = {};
    await expect(queryBatch(items)).rejects.toThrow(/no results/);
  });
});
