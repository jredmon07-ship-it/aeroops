/**
 * Drizzle Kit configuration.
 *
 * DATABASE_URL must be set in .env (never hardcoded).
 * See .env.example for the format.
 *
 * To generate migrations (human reviews before applying):
 *   pnpm --filter @aeroops/db generate
 *
 * To apply (human-gated — never auto-apply in CI):
 *   pnpm --filter @aeroops/db migrate
 */
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const url = process.env['DATABASE_URL'];
if (!url) {
  throw new Error(
    '[drizzle.config] DATABASE_URL is not set. ' +
      'Copy .env.example to .env and fill in the value.',
  );
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
});
