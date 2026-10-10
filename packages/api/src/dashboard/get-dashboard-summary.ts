/**
 * get-dashboard-summary.ts — Phase 0 dashboard data for the authenticated app shell.
 *
 * Returns a minimal summary sufficient to render the empty app shell:
 *   orgName     — display name for the tenant org
 *   orgSlug     — URL slug for the tenant (used in /o/[slug]/* routes)
 *   locationCount — number of locations in the org (a non-zero sanity-check count)
 *
 * All other Hub counts (aircraft, members, etc.) are NOT included here.
 * They will be added by their respective Hub slices.
 *
 * TENANT ISOLATION:
 *   The org_id used for ALL queries comes ONLY from session.orgId (JWT-bound,
 *   tamper-proof). The URL slug is ignored — it is navigation-only. The
 *   withSessionOrgContext/withSessionOrgContextWithDb wrappers set the Postgres
 *   GUC app.current_org_id to session.orgId before any query runs, so RLS
 *   enforces isolation as a backstop even if a caller were to attempt a bypass.
 *
 * TWO CALLING FORMS (mirrors session.ts pattern):
 *   1. App code (apps/web):       getDashboardSummary(session)
 *   2. Test code (pglite harness): getDashboardSummaryWithDb(db, session)
 */
import { eq, count } from 'drizzle-orm';
import { org, location } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';

// ─── Public return type ───────────────────────────────────────────────────────

export interface DashboardSummary {
  /** Human-readable org name (e.g. "Alpha Flight School"). */
  orgName: string;
  /** URL slug for tenant routing (e.g. "alpha"). */
  orgSlug: string;
  /** Count of location rows in the org. Phase 0 only; Hub counts come later. */
  locationCount: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getDashboardSummaryImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<DashboardSummary> {
  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // Query 1: org name + slug scoped to session.orgId via RLS.
    // We query by id=session.orgId — redundant given RLS but explicit about intent.
    const orgRows = await tx
      .select({ name: org.name, slug: org.slug })
      .from(org)
      .where(eq(org.id, sess.orgId))
      .limit(1);

    const orgRow = orgRows[0];
    if (!orgRow) {
      // Should not happen: if the session is valid, the org exists. Guard anyway.
      throw new Error(
        `[getDashboardSummary] Org row not found for orgId=${sess.orgId}. ` +
          'The org may have been deleted after the session was issued.',
      );
    }

    // Query 2: count(location) scoped to session.orgId via RLS.
    const countRows = await tx
      .select({ count: count() })
      .from(location)
      .where(eq(location.orgId, sess.orgId));

    const locationCount = Number(countRows[0]?.count ?? 0);

    return {
      orgName: orgRow.name,
      orgSlug: orgRow.slug,
      locationCount,
    };
  });
}

// ─── App-code form (no db argument — uses getDb() internally) ────────────────

/**
 * getDashboardSummary — fetches dashboard data for the authenticated session's org.
 *
 * Uses the memoized production DB client (getDb()). apps/web never needs to
 * pass a db client.
 *
 * @param session - AppSession from auth(); may be null/undefined (throws UnauthenticatedError).
 * @returns DashboardSummary scoped to session.orgId.
 * @throws UnauthenticatedError if session is null/undefined/incomplete.
 */
export async function getDashboardSummary(
  session: AppSession | null | undefined,
): Promise<DashboardSummary> {
  const db = await getDb();
  return _getDashboardSummaryImpl(db, session);
}

// ─── Test/injectable form (explicit db argument) ──────────────────────────────

/**
 * getDashboardSummaryWithDb — same contract as getDashboardSummary but
 * accepts an explicit db argument for test code that injects a pglite client.
 *
 * Tests MUST use this form so they never trigger getDb() (which requires a
 * real DATABASE_URL and a running Postgres instance).
 *
 * @param db      - The Drizzle database client (pglite test client or prod).
 * @param session - AppSession from auth(); may be null/undefined (throws UnauthenticatedError).
 * @returns DashboardSummary scoped to session.orgId.
 * @throws UnauthenticatedError if session is null/undefined/incomplete.
 */
export async function getDashboardSummaryWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<DashboardSummary> {
  return _getDashboardSummaryImpl(db, session);
}
