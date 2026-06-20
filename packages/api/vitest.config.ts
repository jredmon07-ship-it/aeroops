import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // PGlite + argon2 can be slow on first run; 60 s is ample.
    testTimeout: 60000,
    // Per-file beforeAll/afterAll setup (apply ~14 migrations to a fresh PGlite +
    // seed) can exceed the 10 s hook default under full-suite parallelism — match
    // testTimeout so the heavy setup hooks don't flake the suite (and CI).
    hookTimeout: 60000,
  },
});
