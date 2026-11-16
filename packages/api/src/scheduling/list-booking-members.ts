/**
 * list-booking-members.ts — the "Booked for" picker on New Reservation
 * (reservation.member_user_id, migration 0051).
 *
 * Returns the ACTIVE members of the session org — a membership row joined to
 * an app_user whose roster status is 'active' — which is exactly the set
 * createReservation / createSeries accept as memberUserId (loadActiveMember).
 *
 * GUARANTEES:
 *   - authz: requireCapability('schedule:create_reservation') — the create's
 *     own gate, so every role that can book (a CFI included, who lacks the
 *     resource-admin gate listOrgMembers uses) can fill the picker.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop),
 *     with explicit org predicates on both tables. Never crosses orgs.
 *   - Read-only; no audit row.
 *
 * TWO CALLING FORMS:
 *   listBookingMembers(session)          — app code; uses getDb() internally.
 *   listBookingMembersWithDb(db, session) — tests; inject pglite client.
 */
import { and, asc, eq } from 'drizzle-orm';
import { membership, appUser } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { MembershipRole } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';

/** One active member a booking can be made for. */
export interface BookingMemberRow {
  /** app_user id — the value passed as memberUserId. */
  userId: string;
  /** Full name when set, otherwise e-mail. */
  displayName: string;
  role: MembershipRole;
}

async function _listBookingMembersImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<BookingMemberRow[]> {
  // AUTHZ FIRST — before any data access.
  requireCapability(session, 'schedule:create_reservation');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const rows = await tx
      .select({
        userId: membership.userId,
        fullName: appUser.fullName,
        email: appUser.email,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(appUser, eq(membership.userId, appUser.id))
      .where(
        and(
          eq(membership.orgId, sess.orgId),
          eq(appUser.orgId, sess.orgId),
          eq(appUser.status, 'active'),
        ),
      )
      .orderBy(asc(appUser.fullName), asc(appUser.email));

    return rows.map((r) => ({
      userId: r.userId,
      displayName: r.fullName ?? r.email,
      role: r.role as MembershipRole,
    }));
  });
}

/**
 * listBookingMembers — the active members of the session org, for the
 * "Booked for" picker.
 *
 * @throws UnauthenticatedError | ForbiddenError.
 */
export async function listBookingMembers(
  session: AppSession | null | undefined,
): Promise<BookingMemberRow[]> {
  const db = await getDb();
  return _listBookingMembersImpl(db, session);
}

/** listBookingMembersWithDb — test form; inject a pglite client. */
export async function listBookingMembersWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<BookingMemberRow[]> {
  return _listBookingMembersImpl(db, session);
}
