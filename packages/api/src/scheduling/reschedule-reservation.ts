/**
 * reschedule-reservation.ts — rescheduleReservation: atomically move ONE
 * reservation to a new window and/or resource set. (SCHED-2c, ADR-0006 §6 +
 * Addendum 2026-06-16.)
 *
 * Reschedule = cancel-original + recreate through the shared gatedCreateOccurrence.
 * NO new write path, NO new gate, NO schema change. The frozen conflict +
 * policy gates are reused verbatim via gatedCreateOccurrence.
 *
 * GUARANTEES:
 *   - authz first: requireCapability('schedule:create_reservation') BEFORE any
 *     data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - ATOMIC, all-or-nothing, ONE tx. The original is cancelled in-tx FIRST
 *     (freeing its window so an overlapping-self move does not self-conflict),
 *     then gatedCreateOccurrence recreates at the new slot.
 *   - THROW-TO-ROLLBACK on refusal: if either gate refuses, we throw a private
 *     RescheduleRefused sentinel carrying the refusal result. withOrgContext's
 *     tx rolls back on the throw — undoing the cancel — so the original stays
 *     booked + intact. We catch the sentinel OUTSIDE the tx and return its
 *     result. (A plain `return` from inside the callback would COMMIT the
 *     cancel: the throw is load-bearing.)
 *   - RACE: a concurrent commit into the target window fires 23P01 on the
 *     INSERT; gatedCreateOccurrence throws OccurrenceRaceError, which poisons +
 *     rolls back the tx (original preserved). We catch it outside, re-probe in a
 *     fresh tx, and return { reason:'conflict' }. Mirrors createReservation.
 *   - A rescheduled occurrence DETACHES from its series (seriesId:undefined →
 *     series_id NULL on the new row).
 *   - AUDIT LINKAGE: reservation.cancelled (metadata reason:'reschedule',
 *     rescheduledTo:newId) + the reservation.created gatedCreateOccurrence
 *     writes + a dedicated reservation.rescheduled row (entityId:newId, metadata
 *     rescheduledFrom:originalId + old/new windows).
 *
 * TWO CALLING FORMS (mirrors create-reservation):
 *   rescheduleReservation(session, input)              — app code; getDb().
 *   rescheduleReservationWithDb(db, session, in, opts?) — tests; inject pglite.
 */

import { eq, sql } from 'drizzle-orm';
import { reservation, reservationResource, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { RescheduleReservationInput, RescheduleResult } from './types.js';
import type { CreateReservationResult } from './types.js';
import {
  ValidationError,
  OccurrenceRaceError,
  parseReservationWindow,
  gatedCreateOccurrence,
  reProbeInFreshTx,
  toIso,
} from './internal.js';

/**
 * RescheduleRefused — PRIVATE sentinel thrown from inside the tx callback to
 * force a Drizzle ROLLBACK when a target gate refuses. Carries the refusal
 * result so the outer catch can return it. NOT exported — purely an internal
 * control-flow signal (the rollback is the point, not error semantics).
 */
class RescheduleRefused extends Error {
  readonly code = 'RESCHEDULE_REFUSED' as const;
  constructor(public readonly result: Extract<RescheduleResult, { ok: false }>) {
    super('[scheduling] reschedule refused by a gate — rolling back to preserve original');
    this.name = 'RescheduleRefused';
  }
}

interface RescheduleOptions {
  /** Injected epoch ms — deterministic tests. Defaults to Date.now(). */
  now?: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _rescheduleReservationImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: RescheduleReservationInput,
  opts?: RescheduleOptions,
): Promise<RescheduleResult> {
  // Capture `now` ONCE — shared across validation + gatedCreateOccurrence.
  const now = opts?.now ?? Date.now();

  // 1. AUTHZ FIRST — before any data access. Throws Forbidden/Unauthenticated.
  requireCapability(session, 'schedule:create_reservation');

  // 2. VALIDATE the new window. resourceIds is optional here (defaults to the
  //    original's), so we only validate the window + ANY supplied ids through
  //    parseReservationWindow. We pass a placeholder when none supplied so the
  //    window refinement (endAt>startAt) + Date validity still run; the real
  //    target resource set is resolved inside the tx once the original loads.
  const explicitResourceIds = input.newResourceIds;
  const windowParse = parseReservationWindow({
    startAt: input.newStartAt,
    endAt: input.newEndAt,
    // parseReservationWindow requires >=1 resourceId; when the caller omits
    // newResourceIds we validate against a single placeholder UUID purely to
    // exercise the window/date rules. The placeholder is DISCARDED — the real
    // ids come from the original reservation inside the tx.
    resourceIds:
      explicitResourceIds && explicitResourceIds.length > 0
        ? explicitResourceIds
        : ['00000000-0000-0000-0000-000000000000'],
  });
  const newStartAt = windowParse.startAt;
  const newEndAt = windowParse.endAt;
  // De-duplicated explicit ids (or undefined → use original's inside the tx).
  const validatedExplicitIds =
    explicitResourceIds && explicitResourceIds.length > 0 ? windowParse.resourceIds : undefined;

  try {
    return await withSessionOrgContextWithDb(db, session, async (sess, tx): Promise<RescheduleResult> => {
      // 3. Load the original (RLS scopes to org — cross-org/unknown id is simply
      //    not visible → not_found). Need status + notes + window for audit.
      const origRows = await tx
        .select({
          id: reservation.id,
          status: reservation.status,
          notes: reservation.notes,
          startAt: reservation.startAt,
          endAt: reservation.endAt,
        })
        .from(reservation)
        .where(eq(reservation.id, input.reservationId))
        .limit(1);

      const original = origRows[0];
      if (!original || original.status === 'cancelled') {
        // Not visible OR already cancelled → not_found, NO write.
        return { ok: false, reason: 'not_found' };
      }

      // 3a. Load the original's current resource ids (its booked join rows).
      const joinRows = await tx
        .select({ resourceId: reservationResource.resourceId })
        .from(reservationResource)
        .where(eq(reservationResource.reservationId, input.reservationId));
      const originalResourceIds = joinRows.map((r) => r.resourceId);

      // 4. target = explicit ?? original's (dedup, >=1). When swapping resources
      //    the caller supplies the full target set; otherwise we keep the
      //    original's. gatedCreateOccurrence re-validates each id (visible,
      //    active, bookable) and throws ValidationError on a bad id.
      let targetResourceIds: string[];
      if (validatedExplicitIds) {
        targetResourceIds = validatedExplicitIds;
      } else {
        const seen = new Set<string>();
        targetResourceIds = [];
        for (const id of originalResourceIds) {
          if (!seen.has(id)) {
            seen.add(id);
            targetResourceIds.push(id);
          }
        }
      }
      if (targetResourceIds.length === 0) {
        // Defensive: an original with zero join rows cannot be re-placed.
        throw new ValidationError(
          '[scheduling] reschedule target has no resources (original has no booked resources).',
        );
      }

      // 5. CANCEL the original in-tx — flip reservation + its join rows to
      //    cancelled (frees the window via the partial EXCLUDE WHERE status=
      //    'booked'). This MUST precede the recreate so an overlapping-self move
      //    does not collide with itself.
      await tx
        .update(reservation)
        .set({
          status: 'cancelled',
          cancelledAt: sql`now()`,
          cancelledBy: sess.userId,
          updatedAt: sql`now()`,
        })
        .where(eq(reservation.id, input.reservationId));

      await tx
        .update(reservationResource)
        .set({ status: 'cancelled' })
        .where(eq(reservationResource.reservationId, input.reservationId));

      // 6. RECREATE through the shared gated path. seriesId:undefined → detach.
      //    notes carried over from the original. Race (23P01) → OccurrenceRace-
      //    Error propagates out of this callback (poisons tx → outer catch).
      const created: CreateReservationResult = await gatedCreateOccurrence(
        tx,
        sess,
        db,
        {
          startAt: newStartAt,
          endAt: newEndAt,
          resourceIds: targetResourceIds,
          notes: original.notes ?? undefined,
          seriesId: undefined,
        },
        now,
      );

      // 7. On gate refusal: THROW-TO-ROLLBACK. A plain return would COMMIT the
      //    cancel; throwing the sentinel forces Drizzle to ROLLBACK the whole
      //    tx, undoing the cancel so the original stays booked + intact.
      if (!created.ok) {
        throw new RescheduleRefused(created);
      }

      const newId = created.reservation.id;

      // 8. Success → write the audit linkage (the create already wrote
      //    reservation.created). Two more rows:
      //    (a) reservation.cancelled on the ORIGINAL — metadata links forward.
      //    (b) reservation.rescheduled on the NEW row — metadata links back +
      //        records the window delta.
      await tx.insert(auditLog).values({
        orgId: sess.orgId,
        actorUserId: sess.userId,
        action: 'reservation.cancelled',
        entityType: 'reservation',
        entityId: input.reservationId,
        metadata: { reason: 'reschedule', rescheduledTo: newId },
      });

      await tx.insert(auditLog).values({
        orgId: sess.orgId,
        actorUserId: sess.userId,
        action: 'reservation.rescheduled',
        entityType: 'reservation',
        entityId: newId,
        metadata: {
          rescheduledFrom: input.reservationId,
          oldWindow: { startAt: toIso(original.startAt), endAt: toIso(original.endAt) },
          newWindow: { startAt: toIso(newStartAt), endAt: toIso(newEndAt) },
        },
      });

      // Carry the warn-only grounding warnings through from the shared gated
      // create body (ADR-0008 §2.3). Only present when non-empty so the ok:true
      // shape stays byte-identical when nothing is grounded.
      return {
        ok: true,
        reservation: created.reservation,
        ...(created.groundingWarnings ? { groundingWarnings: created.groundingWarnings } : {}),
        // Slice 4a: carry warn-only twilight warnings through. Additive — absent when
        // the gate is disabled / inert so the ok:true shape stays byte-identical.
        ...(created.twilightWarnings ? { twilightWarnings: created.twilightWarnings } : {}),
      };
    });
  } catch (err) {
    // Gate refusal sentinel: the tx rolled back (original preserved) — return
    // the carried refusal result.
    if (err instanceof RescheduleRefused) {
      return err.result;
    }
    // Race: gatedCreateOccurrence's INSERT hit 23P01. The outer tx is poisoned
    // + rolled back (the cancel is undone → original preserved). Re-probe in a
    // FRESH tx to build the rich ConflictHit result. `session` is non-null here
    // (requireCapability validated it above).
    if (err instanceof OccurrenceRaceError) {
      const hits = await reProbeInFreshTx(
        db,
        session as NonNullable<typeof session>,
        err.startAt,
        err.endAt,
        err.resourceIds,
      );
      return { ok: false, reason: 'conflict', conflicts: hits };
    }
    // ValidationError + any other error propagate (no write committed).
    throw err;
  }
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * rescheduleReservation — atomically move a reservation in the authenticated org.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param input   - { reservationId, newStartAt, newEndAt, newResourceIds? }.
 * @returns RescheduleResult — ok:true with the NEW reservation, or ok:false
 *          (not_found | conflict | policy | conflict_and_policy). On any
 *          ok:false the original stays booked + intact.
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function rescheduleReservation(
  session: AppSession | null | undefined,
  input: RescheduleReservationInput,
): Promise<RescheduleResult> {
  const db = await getDb();
  return _rescheduleReservationImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/**
 * rescheduleReservationWithDb — test form; inject a pglite client.
 * `opts.now` accepts an injected epoch-ms clock for deterministic policy tests.
 */
export async function rescheduleReservationWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: RescheduleReservationInput,
  opts?: { now?: number },
): Promise<RescheduleResult> {
  return _rescheduleReservationImpl(db, session, input, opts);
}
