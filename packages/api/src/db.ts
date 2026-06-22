/**
 * db.ts — Memoized async production DB accessor for @aeroops/api.
 *
 * INVARIANT: apps/web must never import from @aeroops/db directly.
 *   All access to the production Drizzle client goes through this module.
 *   @aeroops/api is the only package that imports @aeroops/db in the app layer.
 *
 * WHY ASYNC + MEMOIZED:
 *   createProdClient() is async because it runs a superuser-check query at
 *   startup (FORCE ROW LEVEL SECURITY safety net). We cannot construct it
 *   synchronously at module load time. Instead, getDb() caches the in-flight
 *   Promise so that concurrent callers share a single connection attempt —
 *   the client is created exactly once per process lifecycle.
 *
 * CONCURRENT CALLER SAFETY:
 *   The promise itself is cached (not just the resolved value), so if two
 *   async functions call getDb() before the first resolves, they both
 *   await the same Promise and never double-connect.
 *
 * USAGE (inside @aeroops/api internals only):
 *
 *   import { getDb } from '../db.js';
 *   const db = await getDb();
 *
 * USAGE (apps/web — via re-export from @aeroops/api):
 *
 *   import { getDb } from '@aeroops/api';
 *   // Rarely needed: prefer withSessionOrgContext which calls getDb internally.
 */
import { createProdClient } from '@aeroops/db';
// NOTE: getDemoDb (./demo/bootstrap.js) is imported DYNAMICALLY inside getDb(),
// not statically here. The demo bootstrap pulls in the in-process PGlite (WASM)
// database; a static import would drag it into the production server bundle's
// EAGER module graph and crash every route with "Cannot find module
// '@electric-sql/pglite'" on Vercel. The demo path is only reached when
// AEROOPS_DEMO=1 (the `pnpm demo` launcher), so it loads lazily there.

/**
 * Db — the resolved production Drizzle client type.
 *
 * Derived directly from createProdClient's return type so it stays in sync
 * with @aeroops/db without needing an additional export from that package.
 * Re-exported so apps/web can type local variables without importing @aeroops/db.
 */
export type Db = Awaited<ReturnType<typeof createProdClient>>;

/**
 * Cached Promise for the production Drizzle client.
 *
 * We cache the Promise (not the resolved value) so concurrent callers
 * during startup all await the same connection attempt. If createProdClient
 * throws, the Promise rejects and subsequent callers re-throw as well.
 * There is no retry logic: a misconfigured deployment should fail fast
 * (consistent with createProdClient's own fail-fast contract).
 */
let _dbPromise: Promise<Db> | null = null;

/**
 * getDb — returns the memoized production Drizzle client.
 *
 * On first call: invokes createProdClient(), caches the Promise, and returns it.
 * On subsequent calls: returns the same cached Promise (resolved immediately
 *   on the microtask queue after the first call completes).
 *
 * Never call this in @aeroops/db — it is an @aeroops/api-level accessor.
 * Never call this in test code — inject the PgliteTestClient directly into
 *   the logic functions (resolveOrgBySlug, verifyCredential, etc.) instead.
 *
 * @returns The production ProdClient (Drizzle + postgres-js).
 * @throws  If DATABASE_URL is unset or the connecting role is a superuser.
 */
export function getDb(): Promise<Db> {
  // DEMO MODE: serve the in-process PGlite client (migrations + seed in memory)
  // instead of connecting to a real Postgres. Strictly gated on AEROOPS_DEMO=1,
  // which only the `pnpm demo` launcher sets — the production path is untouched.
  if (process.env['AEROOPS_DEMO'] === '1') {
    // Dynamic import keeps the demo/PGlite code OUT of the production bundle's
    // eager graph (see the import-block note above).
    return import('./demo/bootstrap.js').then((m) => m.getDemoDb());
  }
  if (_dbPromise === null) {
    _dbPromise = createProdClient();
  }
  return _dbPromise;
}
