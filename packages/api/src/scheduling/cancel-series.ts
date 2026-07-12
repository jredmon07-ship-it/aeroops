/**
 * cancel-series.ts — cancelSeries: cancel all future booked occurrences of a
 * recurring series.
 * (SCHED-2b, ADR-0006 §3.2 / §4)
 *
 * SEMANTICS (ADR-0006 §4):
 *   - Cancels the series row (status → 'cancelled').
 *   - Cancels only FUTURE booked occurrences (start_at > now).
 *     Past occurrences are records (may be dispatched/billed); untouched.
 *   - Flips reservation_resource join rows → 'cancelled' (frees windows for re-booking).
 *   - Writes ONE audit row per cancelled occurrence + ONE 'series.cancelled' audit.
 *   - not visible (RLS) → { ok:false, reason:'not_found' }.
 *   - already cancelled → idempotent { ok:true, cancelledCount:0 }.
 *
 * authz: schedule:create_reservation (same gate as single-create/cancel-reservation).
 * org_id from session only (RLS backstop).
 *
 * Single-occurrence cancel uses the existing cancelReservation path (unchanged).
 *
 * TWO CALLING FORMS:
 *   cancelSeries(session, input)                       — app code.
 *   cancelSeriesWithDb(db, session, input, opts?)      — tests; inject pglite.
 */

import { eq, sql, and, gt } from 'drizzle-orm';
import { reservationSeries, reservation, reservationResource, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { normalizeCancellationReason } from './cancel-reservation.js';
import type { CancelSeriesResult } from './types.js';

export interface CancelSeriesInput {
  seriesId: string;
  /**
   * OPTIONAL free-text reason (migration 0042). Trimmed; empty → null.
   * Applied to EVERY future occurrence cancelled by this call + included in
   * each occurrence's cancel audit metadata. When absent, behavior is
   * byte-identical to before.
   */
  reason?: string;
}

interface CancelSeriesOptions {
  /** Injected epoch ms — for deterministic tests. Defaults to Date.now(). */
  now?: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _cancelSeriesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CancelSeriesInput,
  opts?: CancelSeriesOptions,
): Promise<CancelSeriesResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:create_reservation');

  // Validate the optional reason up front (throws on over-length).
  const reason = normalizeCancellationReason(input.reason);

  const nowMs = opts?.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 2. Load the series row (RLS scopes to org; not visible → not_found).
    const seriesRows = await tx
      .select({
        id: reservationSeries.id,
        orgId: reservationSeries.orgId,
        status: reservationSeries.status,
      })
      .from(reservationSeries)
      .where(eq(reservationSeries.id, input.seriesId))
      .limit(1);

    const series = seriesRows[0];
    if (!series) {
      return { ok: false, reason: 'not_found' };
    }

    // 3. Idempotent: already cancelled → no write, ok:true, cancelledCount:0.
    if (series.status === 'cancelled') {
      return { ok: true, cancelledCount: 0 };
    }

    // 4. Load future booked occurrences (start_at > now AND status='booked').
    const futureRows = await tx
      .select({ id: reservation.id })
      .from(reservation)
      .where(
        and(
          eq(reservation.seriesId, input.seriesId),
          eq(reservation.status, 'booked'),
          sql`${reservation.startAt} > ${nowIso}::timestamptz`,
        ),
      );

    const futureIds = futureRows.map((r) => r.id);
    const cancelledCount = futureIds.length;

    // 5. Cancel future occurrences: flip reservation.status + reservation_resource.status.
    //    One audit row per occurrence.
    if (futureIds.length > 0) {
      // Cancel reservation rows. cancellation_reason is set only when a reason
      // was supplied — otherwise the SET is byte-identical to before (column
      // stays NULL).
      const reasonAssignment =
        reason !== null ? sql`, cancellation_reason = ${reason}` : sql``;
      await tx.execute(sql`
        UPDATE reservation
        SET status = 'cancelled',
            cancelled_at = ${nowIso}::timestamptz,
            cancelled_by = ${sess.userId}::uuid,
            updated_at = ${nowIso}::timestamptz${reasonAssignment}
        WHERE id = ANY(ARRAY[${sql.join(futureIds.map((id) => sql`${id}::uuid`), sql`, `)}])
          AND series_id = ${input.seriesId}::uuid
      `);

      // Flip join rows → frees the windows (EXCLUDE WHERE status='booked').
      await tx.execute(sql`
        UPDATE reservation_resource
        SET status = 'cancelled'
        WHERE reservation_id = ANY(ARRAY[${sql.join(futureIds.map((id) => sql`${id}::uuid`), sql`, `)}])
      `);

      // One audit row per cancelled occurrence.
      for (const resvId of futureIds) {
        await tx.insert(auditLog).values({
          orgId: sess.orgId,
          actorUserId: sess.userId,
          action: 'reservation.cancelled',
          entityType: 'reservation',
          entityId: resvId,
          metadata: {
            source: 'cancelSeries',
            seriesId: input.seriesId,
            ...(reason !== null ? { reason } : {}),
          },
        });
      }
    }

    // 6. Mark the series as cancelled.
    await tx
      .update(reservationSeries)
      .set({
        status: 'cancelled',
        cancelledAt: sql`${nowIso}::timestamptz`,
        cancelledBy: sess.userId,
        updatedAt: sql`now()`,
      })
      .where(eq(reservationSeries.id, input.seriesId));

    // 7. Audit: series.cancelled.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'series.cancelled',
      entityType: 'reservation_series',
      entityId: input.seriesId,
      metadata: {
        cancelledCount,
        ...(reason !== null ? { reason } : {}),
      },
    });

    return { ok: true, cancelledCount };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * cancelSeries — cancel all future booked occurrences of a series.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param input   - { seriesId }.
 * @returns CancelSeriesResult — ok:true with cancelledCount, or ok:false not_found.
 * @throws  UnauthenticatedError | ForbiddenError.
 */
export async function cancelSeries(
  session: AppSession | null | undefined,
  input: CancelSeriesInput,
): Promise<CancelSeriesResult> {
  const db = await getDb();
  return _cancelSeriesImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** cancelSeriesWithDb — test form; inject a pglite client. */
export async function cancelSeriesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CancelSeriesInput,
  opts?: { now?: number },
): Promise<CancelSeriesResult> {
  return _cancelSeriesImpl(db, session, input, opts);
}
