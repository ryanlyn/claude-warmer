import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.{ts,tsx}'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Run tests sequentially so the shared session JSONL isn't interleaved between tests
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
