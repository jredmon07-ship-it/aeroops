/**
 * get-my-reservations.ts — Portal self-scoped reservations read (Slice P1.1).
 *
 * getMyReservations — returns the CALLER'S OWN upcoming booked reservations,
 * where the caller is either the booker (created_by) or the dispatched pilot
 * (non-voided dispatch_ticket.pilot_user_id), with a derived role chip.
 *
 * SELF-SCOPING (the load-bearing requirement): the subject is ALWAYS
 * session.userId from the verified JWT. There is NO row-identifying input.
 * The predicate is hardwired to created_by = me OR dispatched-pilot = me — a
 * portal user can NEVER read another member's reservations.
 *
 * GUARANTEES:
 *   - requireCapability('portal:access') FIRST.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Reads NOT audited (read-only). NO money.
 *
 * TWO CALLING FORMS:
 *   getMyReservations(session)          — app code; uses getDb() internally.
 *   getMyReservationsWithDb(db, session) — tests; inject pglite client.
 */

import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { MyReservationRow } from './types.js';
import { readMyReservations } from './internal.js';

async function _getMyReservationsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MyReservationRow[]> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'portal:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-SCOPED: sess.userId only — never a caller-supplied id.
    return readMyReservations(tx, sess.userId);
  });
}

export async function getMyReservations(
  session: AppSession | null | undefined,
): Promise<MyReservationRow[]> {
  const db = await getDb();
  return _getMyReservationsImpl(db, session);
}

export async function getMyReservationsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MyReservationRow[]> {
  return _getMyReservationsImpl(db, session);
}
