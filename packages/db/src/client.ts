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
import postgres from 'postgres';
import * as schema from './schema/index.js';
// @electric-sql/pglite (the WASM demo/TEST database) is imported TYPE-ONLY here
// (erased at compile time), so this module has NO runtime reference to it. The
// real PGlite instance is created in ./testing.ts, re-exported from the barrel as
// a LAZY dynamic wrapper — a static reference leaked the WASM module into Vercel
// serverless functions → "Cannot find module '@electric-sql/pglite'" 500s on every
// route. Production uses createProdClient (postgres-js + DATABASE_URL) only.
import type { PGlite } from '@electric-sql/pglite';

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

// ─── Privileged demo-owner client (public-demo reset-on-open ONLY) ──────────

/**
 * Creates the privileged Drizzle client used by the public-demo
 * "reset-on-open" feature to WIPE and RE-SEED a demo tenant.
 *
 * Reads AEROOPS_DEMO_OWNER_URL — the OWNER / DDL-role connection string
 * (e.g. Neon's `neondb_owner`), NOT the RLS-restricted `aeroops_app` role.
 * Resetting a whole tenant is a scoped `DELETE FROM org` (FK-cascade) +
 * control-plane re-inserts, which need elevated rights the runtime app role
 * deliberately does not have. NOTE: this owner role is still a NON-superuser
 * on Neon, so FORCE RLS binds it too — the reset must scope the org GUCs
 * before the wipe (see reset.ts); "owner" does NOT mean "bypasses RLS".
 *
 * Deliberately does NOT run createProdClient()'s non-superuser assertion:
 * this connection is EXPECTED to be privileged. It must therefore ONLY be
 * used by resetDemoTenant (packages/api/src/demo/reset.ts) — never for
 * serving tenant requests. The reset function is itself gated behind
 * AEROOPS_DEMO_RESET_ENABLED + a hard-coded slug allowlist.
 *
 * THROWS if AEROOPS_DEMO_OWNER_URL is unset — a misconfigured reset feature
 * fails loud rather than silently doing nothing.
 */
export function createDemoOwnerClient() {
  const url = process.env['AEROOPS_DEMO_OWNER_URL'];
  if (!url) {
    throw new Error(
      '[createDemoOwnerClient] AEROOPS_DEMO_OWNER_URL is not set. ' +
        'The public-demo reset-on-open feature needs the OWNER/DDL connection ' +
        'string (NOT the aeroops_app role) to wipe and re-seed the demo tenant. ' +
        'Set it ONLY on the demo deployment — see DEPLOY.md.',
    );
  }
  // Small pool: resets are infrequent and mutually excluded by a Postgres
  // advisory lock, so a couple of connections is plenty.
  const pgClient = postgres(url, { max: 2, idle_timeout: 60, connect_timeout: 30 });
  return drizzlePg(pgClient, { schema });
}

// ─── Test client (PGlite — in-process Postgres, no Docker required) ─────────
//
// createTestClient itself lives in ./testing.ts because it STATICALLY imports
// @electric-sql/pglite (WASM). The @aeroops/db barrel re-exports it as a LAZY
// (dynamic) wrapper so that WASM module never enters the production server graph.
// The PgliteTestClient TYPE + the helper functions below stay here: they only
// reference the PGlite type (erased) or call methods on an already-created
// instance — no runtime pglite import.

export type PgliteTestClient = ReturnType<typeof drizzlePglite<typeof schema>>;

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
