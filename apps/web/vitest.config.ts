import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * vitest.config.ts — Unit-test config for apps/web pure helpers.
 *
 * Covers:
 *   - lib/nav.ts           (filterNavForSession — no DOM, no Next.js)
 *   - lib/auth-errors.ts   (mapAuthErrorToResponse — no DOM, no Next.js)
 *   - schedule/board/_utils/board-layout.ts   (pure layout math — Slice 2c)
 *   - schedule/new/_components/__tests__/    (twilight indicator — Slice 4a)
 *   - schedule/auto/_components/__tests__/   (auto-schedule utils — Slice 4b)
 *   - training/__tests__/                    (training display helpers — Slice T1.3)
 *   - (shell)/__tests__/                     (command palette helpers — Slice S1.2)
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
    // Pure-helper tests: lib helpers + board layout utils (Slice 2c).
    // Next.js page/layout tests deferred to Slice 0.4.
    include: [
      'lib/__tests__/**/*.test.ts',
      'app/o/\\[slug\\]/\\(shell\\)/schedule/board/_utils/**/*.test.ts',
      // Slice 4a — twilight indicator display-logic tests (pure, no DOM/Next.js).
      'app/o/\\[slug\\]/\\(shell\\)/schedule/new/_components/__tests__/**/*.test.ts',
      // Slice 4b — auto-schedule UI helper tests (pure, no DOM/Next.js).
      'app/o/\\[slug\\]/\\(shell\\)/schedule/auto/_components/__tests__/**/*.test.ts',
      // Slice T1.3 — training display helper tests (pure, no DOM/Next.js).
      'app/o/\\[slug\\]/\\(shell\\)/training/__tests__/**/*.test.ts',
      // Slice M1.3 — work-order display helper tests (pure, no DOM/Next.js).
      'app/o/\\[slug\\]/\\(shell\\)/maintenance/__tests__/**/*.test.ts',
      // Slice R1.2 — operational reports display helper tests (pure, no DOM/Next.js).
      'app/o/\\[slug\\]/\\(shell\\)/reporting/reports/_components/__tests__/**/*.test.ts',
      // Slice S1.2 — command palette helper tests (pure, no DOM/Next.js).
      'app/o/\\[slug\\]/\\(shell\\)/__tests__/**/*.test.ts',
    ],
  },
});
