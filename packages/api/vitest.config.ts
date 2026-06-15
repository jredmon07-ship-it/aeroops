import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // PGlite + argon2 can be slow on first run; 60 s is ample.
    testTimeout: 60000,
  },
});
