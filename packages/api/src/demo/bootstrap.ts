/**
 * demo/bootstrap.ts — in-process PGlite database for the zero-setup demo.
 *
 * When AEROOPS_DEMO=1, getDb() (db.ts) returns the client produced here instead
 * of the production postgres-js client. This lets the REAL Next.js app run
 * against an in-memory Postgres (PGlite, WASM) with no Docker and no DATABASE_URL:
 *
 *   1. create a fresh PGlite instance (the same factory the test-suite uses),
 *   2. apply every real, human-gated migration SQL file (0000, 0001, …) in order,
 *   3. seed a rich demo dataset through the real write paths (see seed.ts),
 *   4. drop to the non-superuser `aeroops_app` role so RLS is ENFORCED — the
 *      running app exercises the exact tenant-isolation path as production.
 *
 * The migration SQL is read from disk at runtime. The launcher (scripts/demo.mjs)
 * sets AEROOPS_DEMO_MIGRATIONS_DIR to the absolute path of packages/db/migrations
 * so we never have to guess a path relative to a webpack bundle.
 *
 * SINGLETON: the bootstrapped client is cached on globalThis (not a module-local)
 * so that Next.js dev's multiple module registries (route handlers vs. server
 * actions) all share ONE in-memory database within the process. Without this,
 * a write in one bundle would be invisible to a read in another.
 *
 * DEMO-ONLY: nothing here runs on the production path. There is no DATABASE_URL
 * use, no migration is ever applied to a real database, and this file is only
 * reached when AEROOPS_DEMO=1.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestClient, applyMigrationSql, setTestAppRole } from '@aeroops/db';
import type { Db } from '../db.js';
import { seedDemo } from './seed.js';

// eslint-disable-next-line no-var
declare global {
  // eslint-disable-next-line no-var
  var __aeroopsDemoDb: Promise<Db> | undefined;
}

/**
 * Read the up-migrations (0000_…sql … 0005_…sql) in numeric order, excluding
 * the `.down.sql` rollback artifacts. The directory comes from the launcher.
 */
function readMigrations(): string[] {
  const dir = process.env['AEROOPS_DEMO_MIGRATIONS_DIR'];
  if (!dir) {
    throw new Error(
      '[demo] AEROOPS_DEMO_MIGRATIONS_DIR is not set. Run the demo via `pnpm demo` ' +
        '(scripts/demo.mjs sets it to packages/db/migrations).',
    );
  }
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.endsWith('.down.sql'))
    .sort();
  if (files.length === 0) {
    throw new Error(`[demo] no migration .sql files found in ${dir}`);
  }
  return files.map((f) => readFileSync(join(dir, f), 'utf8'));
}

async function bootstrap(): Promise<Db> {
  // eslint-disable-next-line no-console
  console.log('[demo] bootstrapping in-process PGlite database…');
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, readMigrations());
  // Seed as superuser (RLS not yet enforced), exactly like the test seed.
  await seedDemo(db as unknown as Db);
  // Drop to aeroops_app: from here on every query is RLS-enforced, like prod.
  await setTestAppRole({ pglite });
  // eslint-disable-next-line no-console
  console.log('[demo] database ready — log in at /o/alpha/login (see DEMO.md).');
  // The PGlite Drizzle client and the prod client expose the same query surface
  // (both are PgDatabase); the cast lets callers treat it as the prod Db type.
  return db as unknown as Db;
}

/**
 * getDemoDb — returns the singleton demo client, bootstrapping it on first call.
 * The Promise is cached on globalThis so all module instances in the dev process
 * share one in-memory database.
 */
export function getDemoDb(): Promise<Db> {
  if (!globalThis.__aeroopsDemoDb) {
    // Do not cache a rejected bootstrap: if seeding fails, clear the cache so the
    // next request retries from scratch (rather than re-throwing forever).
    const p = bootstrap();
    p.catch(() => {
      if (globalThis.__aeroopsDemoDb === p) globalThis.__aeroopsDemoDb = undefined;
    });
    globalThis.__aeroopsDemoDb = p;
  }
  return globalThis.__aeroopsDemoDb;
}
