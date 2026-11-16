/**
 * list-reservations.ts — Reservation day/list read surface (SCHED-1).
 *
 * Returns reservations whose [start_at, end_at) overlaps the caller-supplied
 * [from, to) window, each annotated with its resourceIds. Backs the
 * Slice-1 day/list view on the scheduling board.
 *
 * OVERLAP CONVENTION (ADR-0004 invariant 6):
 *   Half-open [start, end). A reservation is in-window iff:
 *     start_at < to  AND  end_at > from
 *   Adjacency ([10:00,11:00) meets [11:00,12:00)) is NOT an overlap.
 *
 * GUARANTEES:
 *   - authz: requireCapability('schedule:access').
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Never crosses org boundaries.
 *   - Default excludes cancelled; pass includeCancelled:true for full history.
 *   - Each row names the member the booking is for (memberUserId +
 *     memberDisplayName, migration 0051) through a LEFT JOIN to app_user on
 *     (id, org_id) — RLS-scoped like the rest; null when it names no one.
 *
 * TWO CALLING FORMS:
 *   listReservations(session, input)          — app code; uses getDb() internally.
 *   listReservationsWithDb(db, session, input) — tests; inject pglite client.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { reservation, appUser } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { extractRows } from '../db-rows.js';

// ─── Exported input / result types ───────────────────────────────────────────

export interface ListReservationsInput {
  /** Start of the view window (inclusive). */
  from: Date;
  /** End of the view window (exclusive). */
  to: Date;
  /**
   * includeCancelled — when true, also returns cancelled reservations that
   * overlap the window. Default: false.
   */
  includeCancelled?: boolean;
}

/** Reservation row shape returned by listReservations. */
export interface ReservationRow {
  id: string;
  orgId: string;
  startAt: Date;
  endAt: Date;
  status: 'booked' | 'cancelled';
  notes: string | null;
  createdBy: string;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  /**
   * The recurrence series this reservation belongs to, or null for a one-off
   * (SCHED-2b). The web list renders a "Repeats" badge when non-null.
   */
  seriesId: string | null;
  /** Resource ids linked to this reservation (from reservation_resource). */
  resourceIds: string[];
  /**
   * The member this booking is FOR (reservation.member_user_id, migration
   * 0051), or null when it names no one. Club staff book for renters and
   * students, so this is often not createdBy.
   */
  memberUserId: string | null;
  /**
   * That member's display name: full name, else e-mail. null when
   * memberUserId is null.
   */
  memberDisplayName: string | null;
}

/**
 * memberDisplayNameOf — the display name for a LEFT-JOINed member row
 * (full_name ?? email), or null when the booking names no member.
 * Shared by listReservations and listSeriesOccurrences.
 */
export function memberDisplayNameOf(
  memberUserId: string | null,
  fullName: string | null,
  email: string | null,
): string | null {
  if (!memberUserId) return null;
  return fullName ?? email ?? null;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listReservationsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ListReservationsInput,
): Promise<ReservationRow[]> {
  // AUTHZ FIRST — before any data access.
  requireCapability(session, 'schedule:access');

  const { from, to, includeCancelled = false } = input;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // 1. Fetch reservations overlapping [from, to) with the half-open convention:
    //      start_at < to  AND  end_at > from
    //    (ADR-0004 invariant 6; adjacency is NOT an overlap).
    //
    //    RLS is active: withSessionOrgContextWithDb sets the GUC so all queries
    //    here are scoped to the session org. We do NOT need an explicit org_id
    //    predicate — RLS is the guard; we rely on it as the backstop per contract.

    // Build status filter: by default exclude cancelled rows.
    const resvRows = await tx
      .select({
        id: reservation.id,
        orgId: reservation.orgId,
        startAt: reservation.startAt,
        endAt: reservation.endAt,
        status: reservation.status,
        notes: reservation.notes,
        createdBy: reservation.createdBy,
        cancelledAt: reservation.cancelledAt,
        cancelledBy: reservation.cancelledBy,
        seriesId: reservation.seriesId,
        memberUserId: reservation.memberUserId,
        memberFullName: appUser.fullName,
        memberEmail: appUser.email,
      })
      .from(reservation)
      // The member the booking is for (migration 0051). Joined on (id, org_id),
      // the composite FK's own key; app_user is RLS-scoped too.
      .leftJoin(
        appUser,
        and(eq(appUser.id, reservation.memberUserId), eq(appUser.orgId, reservation.orgId)),
      )
      .where(
        sql`${reservation.startAt} < ${to.toISOString()}::timestamptz
            AND ${reservation.endAt} > ${from.toISOString()}::timestamptz
            ${includeCancelled ? sql`` : sql`AND ${reservation.status} != 'cancelled'`}`,
      )
      .orderBy(asc(reservation.startAt));

    if (resvRows.length === 0) {
      return [];
    }

    // 2. Fetch all resource-join rows for the matched reservations in one query.
    const resvIds = resvRows.map((r) => r.id);

    // Build parameterized uuid[] for = ANY(ARRAY[...]) — injection-safe.
    const idList = sql.join(
      resvIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );

    const joinRows = await tx.execute(
      sql`
        SELECT reservation_id, resource_id
        FROM reservation_resource
        WHERE reservation_id = ANY(ARRAY[${idList}])
      `,
    );

    const rawJoinRows = extractRows<{
      reservation_id: string;
      resource_id: string;
    }>(joinRows);

    // 3. Build a map from reservation_id → resource_id[].
    const resourceIdsByReservation = new Map<string, string[]>();
    for (const jRow of rawJoinRows) {
      const existing = resourceIdsByReservation.get(jRow.reservation_id);
      if (existing) {
        existing.push(jRow.resource_id);
      } else {
        resourceIdsByReservation.set(jRow.reservation_id, [jRow.resource_id]);
      }
    }

    // 4. Assemble the result rows.
    return resvRows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      startAt: r.startAt,
      endAt: r.endAt,
      status: r.status as 'booked' | 'cancelled',
      notes: r.notes ?? null,
      createdBy: r.createdBy,
      cancelledAt: r.cancelledAt ?? null,
      cancelledBy: r.cancelledBy ?? null,
      seriesId: r.seriesId ?? null,
      resourceIds: resourceIdsByReservation.get(r.id) ?? [],
      memberUserId: r.memberUserId ?? null,
      memberDisplayName: memberDisplayNameOf(r.memberUserId, r.memberFullName, r.memberEmail),
    }));
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * listReservations — return org-scoped reservations overlapping a [from, to) window.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param input   - { from, to, includeCancelled? }.
 * @returns ReservationRow[] ordered by startAt. Each row includes resourceIds.
 * @throws  UnauthenticatedError | ForbiddenError.
 */
export async function listReservations(
  session: AppSession | null | undefined,
  input: ListReservationsInput,
): Promise<ReservationRow[]> {
  const db = await getDb();
  return _listReservationsImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** listReservationsWithDb — test form; inject a pglite client. */
export async function listReservationsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ListReservationsInput,
): Promise<ReservationRow[]> {
  return _listReservationsImpl(db, session, input);
}
