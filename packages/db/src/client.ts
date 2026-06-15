/**
 * client.ts — Database client factories.
 *
 * createProdClient(): uses postgres-js (drizzle-orm/postgres-js) with the
 *   DATABASE_URL env var. THROWS at startup if DATABASE_URL is unset —
 *   never silently connects to a wrong/default DB.
 *
 * createTestClient(): spins up a PGlite in-memory instance (no Postgres
 *   server required). Used by vitest; applies the REAL migration SQL so
 *   tests validate the actual artifact.
 *
 * DbClient: the shared type alias for callers that accept either client.
 *
 * SECURITY NOTE: the production app must connect as a NON-SUPERUSER role
 * (e.g. `app_user`) so that FORCE ROW LEVEL SECURITY is not bypassed.
 * See README for the full GUC contract.
 */
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import postgres from 'postgres';
import * as schema from './schema/index.js';

// ─── Production client ───────────────────────────────────────────────────────

/**
 * Creates the production Drizzle client.
 *
 * FIX 3: after connecting, asserts that the role is NOT a superuser.
 * FORCE ROW LEVEL SECURITY only protects non-superuser roles; a superuser
 * connection silently bypasses RLS. The production app MUST connect as the
 * non-superuser aeroops_app role (or equivalent). This check throws hard at
 * startup so a misconfigured deployment fails immediately rather than silently
 * exposing cross-tenant data.
 *
 * This check is prod-only. createTestClient uses PGlite which runs as postgres
 * (superuser) intentionally and calls setTestAppRole() after setup.
 */
export async function createProdClient() {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      '[createProdClient] DATABASE_URL environment variable is not set. ' +
        'Set it in .env (see .env.example) — never hardcode connection strings.',
    );
  }
  const pgClient = postgres(url);
  const db = drizzlePg(pgClient, { schema });

  // Assert non-superuser: FORCE ROW LEVEL SECURITY only binds non-superusers.
  // A superuser or table-owner connection bypasses RLS unconditionally in Postgres.
  // FIX 3: fail fast at startup if the connecting role is a superuser.
  const result = await pgClient<[{ is_superuser: string }]>`
    select current_setting('is_superuser') as is_superuser
  `;
  const isSuperuser = result[0]?.is_superuser;
  if (isSuperuser === 'on') {
    throw new Error(
      '[createProdClient] FATAL: connected as a superuser role. ' +
        'Production must connect as the non-superuser aeroops_app role ' +
        '(or equivalent) so that FORCE ROW LEVEL SECURITY is enforced. ' +
        'Superusers bypass RLS unconditionally — this is a security misconfiguration.',
    );
  }

  return db;
}

// ─── Test client (PGlite — in-process Postgres, no Docker required) ─────────

export type PgliteTestClient = ReturnType<typeof drizzlePglite<typeof schema>>;

/**
 * Creates a fresh in-memory PGlite Drizzle client.
 * Call `applyMigration(client, sql)` after creation to initialise the schema.
 *
 * IMPORTANT: PGlite runs as superuser/owner which BYPASSES RLS unless
 * FORCE ROW LEVEL SECURITY is set on every tenant table. The migration
 * sets FORCE on all tenant tables — that's why tests apply the real
 * migration file rather than a hand-rolled CREATE TABLE script.
 */
export async function createTestClient(): Promise<{
  db: PgliteTestClient;
  pglite: PGlite;
}> {
  // pgcrypto must be passed as an extension so PGlite loads its WASM bundle.
  // This enables gen_random_uuid() which every table PK uses.
  const pglite = await PGlite.create({ extensions: { pgcrypto } });
  const db = drizzlePglite(pglite, { schema });
  return { db, pglite };
}

/**
 * Applies one or more migration SQL strings to a test client (runs as superuser).
 * Pass either a single SQL string (backwards-compatible) or an ordered array of
 * SQL strings (applied in the order given, matching the numeric filename order
 * of migrations/0000_…sql, migrations/0001_…sql, etc.).
 *
 * The strings must be the raw contents of the generated migration files so that
 * tests validate the real artifact — not a hand-rolled CREATE TABLE script.
 *
 * After calling this, you should:
 *   1. Seed any test data (still as superuser / postgres role)
 *   2. Call setTestAppRole() to drop to aeroops_app for RLS enforcement
 */
export async function applyMigrationSql(
  client: { pglite: PGlite },
  sql: string | string[],
): Promise<void> {
  const migrations = Array.isArray(sql) ? sql : [sql];
  for (const migration of migrations) {
    await client.pglite.exec(migration);
  }
}

/**
 * Drops the PGlite connection to the non-superuser 'aeroops_app' role.
 *
 * Call this AFTER seeding test data (which must be done as superuser).
 * All queries after this point will have RLS enforced.
 *
 * This simulates the production constraint: the application tier MUST connect
 * as a non-superuser role. Superusers bypass RLS unconditionally in Postgres;
 * FORCE ROW LEVEL SECURITY does NOT override the superuser exemption (it only
 * overrides the table-owner exemption for non-superuser owners).
 */
export async function setTestAppRole(client: { pglite: PGlite }): Promise<void> {
  await client.pglite.exec(`SET ROLE aeroops_app`);
}

/**
 * Executes raw SQL on a PGlite instance.
 * Useful in tests for set_config, ROLLBACK, and inspection queries that
 * fall outside Drizzle's typed query surface.
 */
export async function execRaw(
  client: { pglite: PGlite },
  sql: string,
): Promise<unknown> {
  return client.pglite.exec(sql);
}

// ─── Shared type ─────────────────────────────────────────────────────────────

/**
 * ProdClient — the resolved (non-Promise) type of the production Drizzle client.
 * createProdClient is async (FIX 3: it runs a superuser check at startup), so
 * we unwrap the Promise to get the usable client type.
 */
export type ProdClient = Awaited<ReturnType<typeof createProdClient>>;

/**
 * DbClient — union type accepted by repository functions and helpers.
 * Pass either the prod or test client; both expose the same typed
 * `.query.*` and `.insert()/.select()` surface.
 */
export type DbClient = ProdClient | PgliteTestClient;
