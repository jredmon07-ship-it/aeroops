/**
 * list-dispatch.ts — reads for the dispatch board (DISPATCH-3a, ADR-0007 §6).
 *
 * getDispatchForReservation — returns the latest non-voided ticket per
 * reservation, RLS-scoped, in a single parameterized query.
 * Backs the dispatch board's badge/status overlay (§3.4).
 *
 * GUARANTEES:
 *   - authz first: requireCapability('dispatch:access').
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - one `reservation_id = ANY(...)` query — no N+1.
 *   - 'voided' tickets excluded (they are tombstones; the board shows
 *     'none' when only voided tickets exist for a reservation).
 *   - returns Map<reservationId, DispatchTicketView | null>:
 *       - key present → a non-voided ticket was found (open or closed).
 *       - value null  → no non-voided ticket exists for that reservationId.
 *   - "latest" = highest created_at among non-voided rows for the reservation.
 *
 * TWO CALLING FORMS:
 *   getDispatchForReservation(session, input)        — app code.
 *   getDispatchForReservationWithDb(db, session, in) — tests.
 */
import { z } from 'zod';
import { asc, eq, sql } from 'drizzle-orm';
import { membership, appUser } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { MembershipRole } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toDispatchTicketView } from './internal.js';
import type { DispatchTicketView } from './types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schema ─────────────────────────────────────────────────────────────

const getDispatchForReservationInputSchema = z.object({
  reservationIds: z
    .array(z.string().regex(UUID_RE, { message: 'reservationIds must be UUIDs' }))
    .min(1, { message: 'At least one reservationId is required' }),
});

export type GetDispatchForReservationInput = z.infer<
  typeof getDispatchForReservationInputSchema
>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getDispatchForReservationImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<Map<string, DispatchTicketView | null>> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'dispatch:access');

  // 2. VALIDATE input.
  const parsed = getDispatchForReservationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[dispatch] invalid getDispatchForReservation input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { reservationIds } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Build a parameterized uuid[] for `= ANY(ARRAY[...])`.
    const idList = sql.join(
      reservationIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );

    // Single query: latest non-voided ticket per reservation using DISTINCT ON.
    // DISTINCT ON (reservation_id) ORDER BY reservation_id, created_at DESC
    // picks the most-recently-created non-voided ticket per reservation.
    // RLS is enforced by the GUC set inside withSessionOrgContextWithDb.
    const result = await tx.execute(sql`
      SELECT DISTINCT ON (reservation_id)
        id,
        org_id            AS "orgId",
        reservation_id    AS "reservationId",
        resource_id       AS "resourceId",
        pilot_user_id     AS "pilotUserId",
        status,
        hobbs_out         AS "hobbsOut",
        tach_out          AS "tachOut",
        hobbs_in          AS "hobbsIn",
        tach_in           AS "tachIn",
        flight_time_hours AS "flightTimeHours",
        notes,
        opened_by         AS "openedBy",
        opened_at         AS "openedAt",
        closed_by         AS "closedBy",
        closed_at         AS "closedAt",
        created_at        AS "createdAt",
        updated_at        AS "updatedAt"
      FROM dispatch_ticket
      WHERE reservation_id = ANY(ARRAY[${idList}])
        AND status <> 'voided'
      ORDER BY reservation_id, created_at DESC
    `);

    const rows = (result.rows ?? result) as unknown as Array<{
      id: string;
      orgId: string;
      reservationId: string;
      resourceId: string;
      pilotUserId: string;
      status: string;
      hobbsOut: string | number;
      tachOut: string | number;
      hobbsIn: string | number | null;
      tachIn: string | number | null;
      flightTimeHours: string | number | null;
      notes: string | null;
      openedBy: string;
      openedAt: Date | string;
      closedBy: string | null;
      closedAt: Date | string | null;
      createdAt: Date | string;
      updatedAt: Date | string;
    }>;

    // Build map — one entry per input reservationId.
    const map = new Map<string, DispatchTicketView | null>();
    for (const id of reservationIds) {
      map.set(id, null);
    }
    for (const row of rows) {
      map.set(row.reservationId, toDispatchTicketView(row));
    }
    return map;
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * getDispatchForReservation — return the latest non-voided ticket per
 * reservation, as a Map<reservationId, DispatchTicketView | null>.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param input   - { reservationIds: string[] }.
 * @returns Map<string, DispatchTicketView | null>.
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function getDispatchForReservation(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<Map<string, DispatchTicketView | null>> {
  const db = await getDb();
  return _getDispatchForReservationImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** getDispatchForReservationWithDb — test form; inject a pglite client. */
export async function getDispatchForReservationWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<Map<string, DispatchTicketView | null>> {
  return _getDispatchForReservationImpl(db, session, input);
}

// ─── listDispatchPilots ───────────────────────────────────────────────────────
//
// The dispatch check-out dialog needs a pilot picker, but the existing
// listOrgMembers gates on `schedule:manage_resources` — which a CFI (a primary
// dispatch role) does NOT have. This read is gated on `dispatch:access` so any
// dispatch role can populate the picker. Any org member may be the pilot (a
// renter/student flies; the composite-FK on dispatch_ticket.pilot_user_id is the
// structural backstop). RLS-scoped; never crosses orgs.

/** Pilot row for the dispatch check-out picker. */
export interface DispatchPilotRow {
  userId: string;
  /** appUser.fullName when present, else appUser.email (fullName is nullable). */
  displayName: string;
  email: string;
  role: MembershipRole;
}

async function _listDispatchPilotsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<DispatchPilotRow[]> {
  // AUTHZ FIRST — the dispatch read gate (not the resource-admin gate).
  requireCapability(session, 'dispatch:access');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const rows = await tx
      .select({
        userId: membership.userId,
        fullName: appUser.fullName,
        email: appUser.email,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(appUser, eq(membership.userId, appUser.id))
      .orderBy(asc(appUser.fullName), asc(appUser.email));

    return rows.map((r) => ({
      userId: r.userId,
      displayName: r.fullName ?? r.email,
      email: r.email,
      role: r.role as MembershipRole,
    }));
  });
}

/**
 * listDispatchPilots — org members eligible to be selected as a dispatch pilot,
 * gated on `dispatch:access` (so CFIs can populate the check-out picker).
 *
 * @throws UnauthenticatedError | ForbiddenError.
 */
export async function listDispatchPilots(
  session: AppSession | null | undefined,
): Promise<DispatchPilotRow[]> {
  const db = await getDb();
  return _listDispatchPilotsImpl(db, session);
}

/** listDispatchPilotsWithDb — test form; inject a pglite client. */
export async function listDispatchPilotsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<DispatchPilotRow[]> {
  return _listDispatchPilotsImpl(db, session);
}
