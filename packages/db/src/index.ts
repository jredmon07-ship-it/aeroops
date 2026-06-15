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
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  execRaw,
} from './client.js';
export type { DbClient, PgliteTestClient } from './client.js';

// Org-context helpers — sanctioned public API only (transaction-scoped wrappers)
export {
  withOrgContext,
  withPlatformAdminContext,
} from './org-context.js';
export type { OrgContextOpts, AnyDb } from './org-context.js';

// Seed
export { seedTwoOrgs, seedAuthCredential, seedUserWithoutMembership } from './seed.js';
export type { SeedResult } from './seed.js';
