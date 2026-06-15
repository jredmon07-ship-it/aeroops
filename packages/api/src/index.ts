/**
 * @aeroops/api — public surface.
 *
 * Exports the auth module (Slice 0.2) and RBAC + dashboard module (Slice 0.3).
 * Additional modules (scheduling, billing, etc.) will be added in later slices.
 *
 * BOUNDARY INVARIANT: apps/web must import from '@aeroops/api' only —
 * never from '@aeroops/db' directly. The production DB client is obtained
 * internally via getDb(); apps/web never instantiates a db client.
 *
 * Exported names and their intended callers:
 *
 *   getDb                        — rare: if apps/web needs the raw client
 *                                  for a use case not covered by the helpers.
 *                                  Prefer withSessionOrgContext instead.
 *   buildAuthConfig              — apps/web/auth.ts: NextAuth(buildAuthConfig())
 *   withSessionOrgContext        — apps/web server actions / route handlers
 *   withSessionOrgContextWithDb  — test code only (inject pglite client)
 *   UnauthenticatedError         — apps/web route handlers (instanceof check)
 *   ForbiddenError               — apps/web route handlers (instanceof check)
 *   requireCapability            — every mutation / protected data fetch (THE gate)
 *   hasCapability                — UI/nav only (never the gate)
 *   getDashboardSummary          — apps/web dashboard server component
 *   getDashboardSummaryWithDb    — test code only (inject pglite client)
 *   resolveOrgBySlug             — exposed for tests; not used in apps/web directly
 *   verifyCredential             — exposed for tests; not used in apps/web directly
 *   hashPassword                 — exposed for seed scripts / tests
 */

// ─── DB accessor ──────────────────────────────────────────────────────────────
export { getDb } from './db.js';
export type { Db } from './db.js';

// ─── Auth ─────────────────────────────────────────────────────────────────────
export {
  buildAuthConfig,
  buildEdgeAuthConfig,
  jwtCallback,
  sessionCallback,
  resolveOrgBySlug,
  verifyCredential,
  hashPassword,
  withSessionOrgContext,
  withSessionOrgContextWithDb,
  UnauthenticatedError,
  getSessionOrg,
  ForbiddenError,
  requireCapability,
  hasCapability,
} from './auth/index.js';

export type {
  AppSession,
  ResolvedOrg,
  VerifiedCredential,
  SessionOrgData,
} from './auth/index.js';

// ─── Dashboard ────────────────────────────────────────────────────────────────
export { getDashboardSummary, getDashboardSummaryWithDb } from './dashboard/get-dashboard-summary.js';
export type { DashboardSummary } from './dashboard/get-dashboard-summary.js';
