/**
 * @aeroops/db — public surface.
 *
 * Re-exports:
 *   - schema (tables, enum, inferred types)
 *   - client factories (createProdClient, createTestClient, applyMigrationSql)
 *   - org-context helpers (withOrgContext, withPlatformAdminContext — the
 *     sanctioned public API; bare set/clear primitives are NOT exported here
 *     because they are session-scoped and can leak context on pooled connections)
 *   - seed utility (seedTwoOrgs)
 *
 * FIX 6: setOrgContext, clearOrgContext, setPlatformAdminContext are intentionally
 * NOT exported from this index. They are TEST/ADVANCED-INTERNAL use only.
 * Import them directly from './org-context.js' in test files if needed.
 * The sanctioned application API is withOrgContext / withPlatformAdminContext.
 */

// Schema
export * from './schema/index.js';

// Client factories
export {
  createProdClient,
  applyMigrationSql,
  setTestAppRole,
  execRaw,
} from './client.js';
export type { DbClient, PgliteTestClient } from './client.js';

// createTestClient is a LAZY wrapper around ./testing.ts, which STATICALLY imports
// the @electric-sql/pglite WASM module. Re-exporting it via a dynamic import keeps
// pglite out of the STATIC graph of @aeroops/db's production consumers (api/web) —
// the static chain barrel → client → createTestClient → pglite leaked the WASM
// module into Vercel serverless functions ("Cannot find module '@electric-sql/pglite'"
// 500s on every route). ./testing.ts is loaded ONLY when createTestClient is
// actually called (vitest / the AEROOPS_DEMO bootstrap). Signature is unchanged for
// the 56 callers (they already `await createTestClient()`).
export async function createTestClient(): Promise<
  Awaited<ReturnType<typeof import('./testing.js').createTestClient>>
> {
  const m = await import('./testing.js');
  return m.createTestClient();
}

// Org-context helpers — sanctioned public API only (transaction-scoped wrappers)
export {
  withOrgContext,
  withPlatformAdminContext,
} from './org-context.js';
export type { OrgContextOpts, AnyDb } from './org-context.js';

// Seed
export { seedTwoOrgs, seedAuthCredential, seedUserWithoutMembership } from './seed.js';
export type { SeedResult } from './seed.js';
