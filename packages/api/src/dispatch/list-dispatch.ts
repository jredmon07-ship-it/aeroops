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
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
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
