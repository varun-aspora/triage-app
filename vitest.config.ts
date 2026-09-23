import { defineConfig } from 'vitest/config';

// Contract tests and eval files run on Node under Vitest (D18, D42). Unit
// tests (*.test.ts) belong to bun test and are not included here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/contract/**/*.contract.ts', '**/*.eval.ts'],
    setupFiles: ['test/support/vitest-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
