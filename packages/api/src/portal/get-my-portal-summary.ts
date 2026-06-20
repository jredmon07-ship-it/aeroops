/**
 * get-my-portal-summary.ts — Portal page's single fetch (Slice P1.1).
 *
 * getMyPortalSummary — bundles { account, reservations, training } for the
 * portal page in ONE org context (no N+1, all self-scoped). The granular reads
 * remain exported for testability / future mobile reuse.
 *
 * SELF-SCOPING (the load-bearing requirement): the subject is ALWAYS
 * session.userId. There is NO row-identifying input. requireCapability runs
 * ONCE, then assembleMyPortal runs the three reads inside ONE
 * withSessionOrgContextWithDb.
 *
 * GUARANTEES:
 *   - requireCapability('portal:access') FIRST (once).
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Reads NOT audited (read-only). NO money. [VERIFY-T1-B]/[VERIFY-6-A].
 *
 * TWO CALLING FORMS:
 *   getMyPortalSummary(session)          — app code; uses getDb() internally.
 *   getMyPortalSummaryWithDb(db, session) — tests; inject pglite client.
 */

import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { MyPortalSummary } from './types.js';
import { assembleMyPortal } from './internal.js';

async function _getMyPortalSummaryImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MyPortalSummary> {
  // 1. AUTHZ FIRST (once).
  requireCapability(session, 'portal:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-SCOPED: sess.userId only — never a caller-supplied id.
    return assembleMyPortal(tx, sess.userId);
  });
}

export async function getMyPortalSummary(
  session: AppSession | null | undefined,
): Promise<MyPortalSummary> {
  const db = await getDb();
  return _getMyPortalSummaryImpl(db, session);
}

export async function getMyPortalSummaryWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MyPortalSummary> {
  return _getMyPortalSummaryImpl(db, session);
}
