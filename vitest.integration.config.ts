import { defineConfig } from 'vitest/config';

// Integration-tier config. Runs the composed-system tests under
// `tests/integration/` that drive the App through simulated time with
// injected fs, clock, and warmer fakes. Intentionally excluded from the
// default `npm test` run because a few tests advance simulated clocks far
// enough to make the default timer-iteration limits trip otherwise; the
// per-test config below raises those caps.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.{ts,tsx}'],
    // Integration tests stand on their own — skip coverage gates here.
  },
});
