/**
 * Security review, round 2: an exception in the hook's decision (a bug, a registry answer
 * nobody expected) used to reject the race and crash the process with exit 1, which Claude
 * Code and Cursor read as "proceed". It must end in a human looking instead.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/hook/policy.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/hook/policy.js')>();
  return {
    ...real,
    decide: async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'name')");
    },
  };
});

const { decideWithin } = await import('../src/hook/run.js');
const { resolvePolicy } = await import('../src/teamConfig.js');

const intent = { ecosystem: 'npm' as const, name: 'quuxfixture', spec: '1.1.0', source: 'npm i quuxfixture@1.1.0' };

describe('a crash inside the decision', () => {
  it('asks with onError allow, and the deadline does not have to run out first', async () => {
    const t0 = Date.now();
    const d = await decideWithin([intent], [], 10_000, process.cwd(), resolvePolicy({ onError: 'allow' }, {}));
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(d.action).toBe('ask');
    expect(d.problems[0]).toMatch(/could not finish checking this change \(Cannot read properties/);
  });

  it('keeps what is known offline: a denied package stays denied', async () => {
    const d = await decideWithin([intent], [], 10_000, process.cwd(), resolvePolicy({ deny: ['quuxfixture'] }, {}));
    expect(d.action).toBe('deny');
  });

  it('denies with onError deny', async () => {
    const d = await decideWithin([intent], [], 10_000, process.cwd(), resolvePolicy({ onError: 'deny' }, {}));
    expect(d.action).toBe('deny');
  });
});
