import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Several suites spawn the CLI through tsx or loop over hostile inputs; on a loaded machine
    // or a shared CI runner the 5 s default fails them by time alone. The ReDoS checks keep their
    // own per-input budgets, so a real regression still fails.
    testTimeout: 30_000,
  },
});
