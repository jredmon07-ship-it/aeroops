import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // PGlite spins up once per describe-block (beforeAll) — not once per test.
    // PBT iterations reuse the shared env; no cold-start per fast-check run.
    // 60 s is ample for the whole suite; if a test exceeds it, it's a genuine hang.
    testTimeout: 60000,
  },
});
