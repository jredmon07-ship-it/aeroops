/**
 * cancel-reservation.ts — the single sanctioned cancel path (SCHED-1, ADR-0004).
 *
 * Cancelling a reservation:
 *   - sets reservation.status='cancelled', cancelled_at=now, cancelled_by=user;
 *   - flips ALL its reservation_resource join rows to status='cancelled'. The
 *     EXCLUDE constraint's partial WHERE (status='booked') means cancelled join
 *     rows no longer block — the window is freed and can be re-booked.
 *   - writes ONE audit_log row (action='reservation.cancelled').
 *
 * SEMANTICS:
 *   - not visible in-org (RLS)  → { ok:false, reason:'not_found' } (no write).
 *   - already cancelled         → idempotent { ok:true } (no write, no error).
 *   - booked                    → cancelled; { ok:true }.
 *
 * authz: requireCapability('schedule:create_reservation') (gates cancel in
 * Slice 1 per the capability matrix). org_id only from the session.
 *
 * NO reschedule/update path exists — cancel + re-create only (out of scope).
 */
import { eq, sql } from 'drizzle-orm';
import { reservation, reservationResource, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from './internal.js';
import type { CancelResult } from './types.js';

/** Max length of a cancellation reason (mirrors reservation_cancellation_reason_check). */
const MAX_CANCELLATION_REASON = 500;

/** Input to cancelReservation. */
export interface CancelReservationInput {
  reservationId: string;
  /**
   * OPTIONAL free-text reason (migration 0042). Trimmed; empty → null.
   * Persisted on the reservation + included in the cancel audit metadata.
   * When absent, behavior is byte-identical to before (reason stays NULL,
   * audit metadata stays {}).
   */
  reason?: string;
}

/**
 * normalizeReason — trim + bound-check an optional cancellation reason.
 * undefined/empty-after-trim → null. Over 500 chars → ValidationError.
 * Shared by cancelReservation + cancelSeries.
 */
export function normalizeCancellationReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_CANCELLATION_REASON) {
    throw new ValidationError(
      `[scheduling] cancellation reason must be at most ${MAX_CANCELLATION_REASON} characters`,
    );
  }
  return trimmed;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _cancelReservationImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CancelReservationInput,
): Promise<CancelResult> {
  requireCapability(session, 'schedule:create_reservation');

  // Validate the optional reason up front (throws on over-length).
  const reason = normalizeCancellationReason(input.reason);

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // Load the reservation (RLS scopes to org — a cross-org/unknown id is
    // simply not visible and yields not_found).
    const rows = await tx
      .select({ id: reservation.id, status: reservation.status })
      .from(reservation)
      .where(eq(reservation.id, input.reservationId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return { ok: false, reason: 'not_found' };
    }

    // Idempotent: already cancelled → no write, no audit row, ok:true.
    if (row.status === 'cancelled') {
      return { ok: true };
    }

    // Flip the parent reservation. cancellationReason is null when the caller
    // supplied no reason → the column stays NULL (byte-identical to before).
    await tx
      .update(reservation)
      .set({
        status: 'cancelled',
        cancelledAt: sql`now()`,
        cancelledBy: sess.userId,
        cancellationReason: reason,
        updatedAt: sql`now()`,
      })
      .where(eq(reservation.id, input.reservationId));

    // Flip ALL its join rows → frees the window (partial EXCLUDE WHERE
    // status='booked' no longer matches these rows).
    await tx
      .update(reservationResource)
      .set({ status: 'cancelled' })
      .where(eq(reservationResource.reservationId, input.reservationId));

    // Audit row — cancellation is a recorded mutation. When no reason was
    // supplied, metadata stays {} (byte-identical to before).
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'reservation.cancelled',
      entityType: 'reservation',
      entityId: input.reservationId,
      metadata: reason !== null ? { reason } : {},
    });

    return { ok: true };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * cancelReservation — cancel a reservation in the authenticated org.
 *
 * @param session - AppSession; null/undefined → UnauthenticatedError.
 * @param input   - { reservationId }.
 * @returns CancelResult — ok:true (cancelled or idempotent no-op), or
 *          ok:false reason:'not_found'.
 * @throws  UnauthenticatedError | ForbiddenError.
 */
export async function cancelReservation(
  session: AppSession | null | undefined,
  input: CancelReservationInput,
): Promise<CancelResult> {
  const db = await getDb();
  return _cancelReservationImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** cancelReservationWithDb — test form; inject a pglite client. */
export async function cancelReservationWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CancelReservationInput,
): Promise<CancelResult> {
  return _cancelReservationImpl(db, session, input);
}
