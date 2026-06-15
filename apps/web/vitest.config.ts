import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * vitest.config.ts — Slice 0.3 unit-test config for apps/web pure helpers.
 *
 * Tests ONLY the pure, framework-agnostic helpers in apps/web/lib/:
 *   - lib/nav.ts           (filterNavForSession — no DOM, no Next.js)
 *   - lib/auth-errors.ts   (mapAuthErrorToResponse — no DOM, no Next.js)
 *
 * Full Next.js route / browser e2e tests are deferred to Slice 0.4 (CI/CD phase).
 *
 * Module resolution: workspace packages are resolved via their src/index.ts
 * (the "main" field in each package.json points there). Next.js-specific
 * modules (next/navigation, next/link, etc.) are excluded by test file placement
 * — the helpers under test have zero Next.js imports.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Resolve @/ imports (Next.js path alias) to the apps/web root.
      '@': resolve(__dirname),
      // Resolve workspace packages to their TypeScript source (mirrors pnpm symlinks).
      '@aeroops/api': resolve(__dirname, '../../packages/api/src/index.ts'),
      '@aeroops/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@aeroops/db': resolve(__dirname, '../../packages/db/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    // Only run pure-helper tests. Next.js page/layout tests are Slice 0.4.
    include: ['lib/__tests__/**/*.test.ts'],
  },
});
