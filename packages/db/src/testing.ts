/**
 * testing.ts — PGlite (in-process WASM Postgres) test/demo client factory.
 *
 * ISOLATION (deploy-critical): this file statically imports @electric-sql/pglite
 * (a WASM module). It MUST NEVER be in the static import graph of the production
 * server — Vercel serverless functions can't resolve the WASM bundle, which
 * 500s every route with "Cannot find module '@electric-sql/pglite'". The
 * @aeroops/db barrel therefore re-exports createTestClient as a LAZY wrapper
 * (dynamic import of this file), and the production db client (createProdClient
 * in client.ts) has no reference to it. This file is loaded ONLY when a test or
 * the demo (AEROOPS_DEMO=1) actually calls createTestClient.
 */
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import * as schema from './schema/index.js';
import type { PgliteTestClient } from './client.js';

/**
 * Creates a fresh in-memory PGlite Drizzle client.
 * Call `applyMigrationSql(client, sql)` (from client.ts) after creation.
 *
 * pgcrypto enables gen_random_uuid() (every table PK uses it); btree_gist
 * provides the GiST operator class for the EXCLUDE constraint on
 * reservation_resource (ADR-0004).
 */
export async function createTestClient(): Promise<{
  db: PgliteTestClient;
  pglite: PGlite;
}> {
  const pglite = await PGlite.create({ extensions: { pgcrypto, btree_gist } });
  const db = drizzlePglite(pglite, { schema });
  return { db, pglite };
}
