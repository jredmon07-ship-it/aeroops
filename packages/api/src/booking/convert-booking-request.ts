/**
 * convert-booking-request.ts — Slice PB2.1b (ADR-0014).
 *
 * convertBookingRequest — the atomic command that closes the public-booking
 * loop: from the staff triage inbox, convert ONE booking_request into a REAL
 * reservation by picking a tail + confirming the window, routed through the
 * FROZEN gatedCreateOccurrence (the SINGLE sanctioned reservation write path —
 * NO bespoke INSERT, the gate stays byte-identical; PB2 is just a NEW CALLER).
 *
 * ── ADR-0014 — Convert is a composite ATOMIC command ─────────────────────────
 * Create the reservation through the single sanctioned write path AND, only on
 * that success, mutate the request to 'converted' (+ link it), BOTH in ONE tx.
 * A gate refusal (or any failure) rolls back BOTH via throw-to-rollback (exactly
 * like rescheduleReservation, ADR-0006 §6): the inbox can never point at a
 * non-existent reservation, and a reservation can never exist with its source
 * request still new/contacted. FOR UPDATE on the request row serializes
 * concurrent converts so exactly one reservation is ever created.
 *
 * GUARANTEES:
 *   - authz BOTH, in order: requireCapability('booking:triage') THEN
 *     requireCapability('schedule:create_reservation') — BEFORE any data access.
 *   - org_id from session ONLY (withSessionOrgContextWithDb + RLS backstop).
 *   - ATOMIC, all-or-nothing, ONE tx. The request is loaded FOR UPDATE first
 *     (serializes double-convert), the reservation created through the gate, then
 *     the SAME request row flipped to 'converted' with the link set.
 *   - THROW-TO-ROLLBACK on gate refusal: a ConvertRefusedError sentinel carrying
 *     the refusal result is thrown inside the tx → Drizzle rolls back → NEITHER
 *     the reservation nor the request mutation persists. Caught OUTSIDE the tx →
 *     the carried refusal arm is returned verbatim. (A plain `return` from inside
 *     the callback would COMMIT the reservation: the throw is load-bearing.)
 *   - RACE: a concurrent commit into the target window fires 23P01 on the INSERT;
 *     gatedCreateOccurrence throws OccurrenceRaceError, which poisons + rolls back
 *     the tx (request untouched). Caught outside → reProbeInFreshTx → conflict.
 *   - idempotency: status NOT in (new, contacted) → not_convertible (covers
 *     already-converted / declined). The state guard + FOR UPDATE make a
 *     re-convert a safe no-op.
 *   - ONE audit_log row (booking_request.converted) per success; NONE on refusal.
 *     metadata: { previousStatus, reservationId, resourceId } — NO requester PII.
 *   - requester fields (name/email/phone/...) are NEVER mutated (write-once).
 *   - NO money. NO app_user / member / pilot / dispatch creation (created_by is
 *     the staff user via the gated path).
 *
 * TWO CALLING FORMS (mirrors create-reservation / reschedule-reservation):
 *   convertBookingRequest(session, input)              — app code; getDb().
 *   convertBookingRequestWithDb(db, session, in, opts?) — tests; inject pglite.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { bookingRequest, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type {
  CreateReservationResult,
  CreatedReservation,
  ConflictHit,
  PolicyViolationView,
  TwilightHit,
  AvailabilityHit,
  GroundingHit,
} from '../scheduling/types.js';
import {
  ValidationError,
  OccurrenceRaceError,
  gatedCreateOccurrence,
  reProbeInFreshTx,
} from '../scheduling/internal.js';
import type { BookingRequestStatus } from './list-booking-requests.js';

// ─── Input schema ──────────────────────────────────────────────────────────────

// RFC-4122 UUID, version-agnostic (mirrors scheduling/internal.ts UUID_RE).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const convertBookingRequestInputSchema = z
  .object({
    id: z.string().regex(UUID_RE, { message: 'id must be a UUID' }),
    resourceId: z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
    startAt: z
      .date({ message: 'startAt must be a Date' })
      .refine((d) => !Number.isNaN(d.getTime()), { message: 'startAt is an invalid Date' }),
    endAt: z
      .date({ message: 'endAt must be a Date' })
      .refine((d) => !Number.isNaN(d.getTime()), { message: 'endAt is an invalid Date' }),
  })
  .refine((v) => v.endAt.getTime() > v.startAt.getTime(), {
    message: 'endAt must be strictly after startAt',
    path: ['endAt'],
  });

/** Input to convertBookingRequest. Notes are DERIVED (not part of the input). */
export interface ConvertBookingRequestInput {
  /** The booking_request to convert. */
  id: string;
  /** The single tail (resource) to book (SINGLE resource in PB2). */
  resourceId: string;
  /** The reservation window start. */
  startAt: Date;
  /** The reservation window end (strictly after startAt). */
  endAt: Date;
}

// ─── Result type ───────────────────────────────────────────────────────────────

/**
 * ConvertBookingRequestResult — discriminated union.
 *
 *   ok:true                              → reservation created + request flipped
 *                                          to 'converted' + linked (all in one tx).
 *   ok:false reason:'not_found'          → the request is not visible in this org
 *                                          (RLS). No write.
 *   ok:false reason:'not_convertible'    → the request is already converted /
 *                                          declined (status not new|contacted). No write.
 *   ok:false reason:'conflict' | 'policy' | 'conflict_and_policy' | 'twilight'
 *            | 'availability'            → the FROZEN gate refused. The reservation
 *                                          was NOT created and the request is intact
 *                                          (still new/contacted, link NULL) — the
 *                                          5 refusal arms are reused VERBATIM from
 *                                          CreateReservationResult.
 *
 * The warn-mode warnings from the gated path's ok:true arm ride through additively.
 */
export type ConvertBookingRequestResult =
  | {
      ok: true;
      id: string;
      status: 'converted';
      reservationId: string;
      reservation: CreatedReservation;
      groundingWarnings?: GroundingHit[];
      twilightWarnings?: TwilightHit[];
      availabilityWarnings?: AvailabilityHit[];
    }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_convertible' }
  // ── The 5 FROZEN refusal arms reused verbatim from CreateReservationResult ──
  | { ok: false; reason: 'conflict'; conflicts: ConflictHit[] }
  | { ok: false; reason: 'policy'; violations: PolicyViolationView[] }
  | { ok: false; reason: 'conflict_and_policy'; conflicts: ConflictHit[]; violations: PolicyViolationView[] }
  | { ok: false; reason: 'twilight'; twilight: TwilightHit[] }
  | { ok: false; reason: 'availability'; availability: AvailabilityHit[] };

/** The refusal arms from the gated create path that convert returns verbatim. */
type GatedRefusal = Extract<CreateReservationResult, { ok: false }>;

// ─── ConvertRefusedError — private throw-to-rollback sentinel ────────────────────

/**
 * ConvertRefusedError — PRIVATE sentinel thrown from inside the tx callback to
 * force a Drizzle ROLLBACK when the FROZEN gate refuses. Carries the refusal
 * result so the outer catch can return it. NOT exported — purely an internal
 * control-flow signal (the rollback is the point, not error semantics). Mirrors
 * reschedule-reservation.ts's RescheduleRefused.
 */
class ConvertRefusedError extends Error {
  readonly code = 'CONVERT_REFUSED' as const;
  constructor(public readonly result: GatedRefusal) {
    super('[booking] convert refused by a gate — rolling back so the request stays intact');
    this.name = 'ConvertRefusedError';
  }
}

// ─── Options ─────────────────────────────────────────────────────────────────

interface ConvertOptions {
  /** Injected epoch ms — deterministic tests. Defaults to Date.now(). */
  now?: number;
}

// ─── Derived notes ─────────────────────────────────────────────────────────────

/**
 * deriveNotes — build the reservation notes from the requester's volunteered
 * contact info. "Public booking request — {name} {email}[ / {phone}]".
 * Operator-internal only; carries the requester PII into the reservation notes
 * (folds into the PB1 retention posture). NO app_user/member/pilot is created.
 */
function deriveNotes(name: string, email: string, phone: string | null): string {
  const base = `Public booking request — ${name} ${email}`;
  return phone ? `${base} / ${phone}` : base;
}

// ─── Shared implementation ──────────────────────────────────────────────────────

async function _convertBookingRequestImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  opts?: ConvertOptions,
): Promise<ConvertBookingRequestResult> {
  // Capture `now` ONCE — shared across the gated create body.
  const now = opts?.now ?? Date.now();

  // 1. AUTHZ — BOTH, in order, BEFORE any data access. Converting reads triage
  //    AND creates a reservation. booking:triage is checked FIRST (a role with
  //    schedule:create_reservation but no booking:triage — e.g. cfi — is refused
  //    here), then schedule:create_reservation.
  requireCapability(session, 'booking:triage');
  requireCapability(session, 'schedule:create_reservation');

  // 2. VALIDATE input (bad uuid / bad window → ValidationError, distinct from a
  //    tagged result). NO write is attempted on a ValidationError.
  const parsed = convertBookingRequestInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[booking] invalid convertBookingRequest input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { id, resourceId, startAt, endAt } = parsed.data;

  try {
    return await withSessionOrgContextWithDb(
      db,
      session,
      async (sess, tx): Promise<ConvertBookingRequestResult> => {
        // 3. Load the request row FOR UPDATE (RLS scopes to org — cross-org /
        //    unknown id is simply not visible → not_found). FOR UPDATE serializes
        //    concurrent converts of the SAME request (the loser blocks until the
        //    winner commits, then re-reads status='converted' → not_convertible).
        const loadResult = await tx.execute(sql`
          SELECT
            id,
            status,
            requester_name  AS "requesterName",
            requester_email AS "requesterEmail",
            requester_phone AS "requesterPhone"
          FROM booking_request
          WHERE id = ${id}::uuid
          FOR UPDATE
        `);
        const rows = (loadResult.rows ?? loadResult) as unknown as Array<{
          id: string;
          status: string;
          requesterName: string;
          requesterEmail: string;
          requesterPhone: string | null;
        }>;
        const requestRow = rows[0];
        if (!requestRow) {
          // Not visible (cross-org / unknown) → not_found. No write.
          return { ok: false, reason: 'not_found' };
        }

        // 4. Idempotency guard: only new|contacted may be converted. Anything
        //    else (converted / declined) → not_convertible. No write.
        const currentStatus = requestRow.status as BookingRequestStatus;
        if (currentStatus !== 'new' && currentStatus !== 'contacted') {
          return { ok: false, reason: 'not_convertible' };
        }

        // 5. Create the reservation through the FROZEN single write path ON THE
        //    SAME tx. NO bespoke INSERT — gatedCreateOccurrence is the only path
        //    that touches reservation / reservation_resource (the gate stays
        //    byte-identical; convert is just another caller). created_by = the
        //    staff session user. auditMetadata tags the reservation.created audit
        //    row with the source linkage (additive — never overrides the base keys).
        const notes = deriveNotes(
          requestRow.requesterName,
          requestRow.requesterEmail,
          requestRow.requesterPhone,
        );
        const created: CreateReservationResult = await gatedCreateOccurrence(
          tx,
          sess,
          db,
          {
            startAt,
            endAt,
            resourceIds: [resourceId],
            notes,
            auditMetadata: { source: 'booking_request', bookingRequestId: id },
          },
          now,
        );

        // 6. On gate refusal: THROW-TO-ROLLBACK. A plain return would COMMIT the
        //    reservation; throwing the sentinel forces Drizzle to ROLLBACK the
        //    whole tx, so NEITHER the reservation NOR any request mutation
        //    persists. The carried refusal arm is returned verbatim outside.
        if (!created.ok) {
          throw new ConvertRefusedError(created);
        }

        const reservationId = created.reservation.id;

        // 7. SUCCESS → flip the SAME request row to converted + set the link.
        //    Only triage fields move; requester fields are untouched (write-once).
        //    handled_at = now() satisfies booking_request_handled_shape_check.
        await tx.execute(sql`
          UPDATE booking_request
          SET
            status                   = 'converted',
            converted_reservation_id = ${reservationId}::uuid,
            handled_by               = ${sess.userId}::uuid,
            handled_at               = now(),
            updated_at               = now()
          WHERE id = ${id}::uuid
        `);

        // 8. ONE audit row for the convert (in ADDITION to the reservation.created
        //    row written by gatedCreateOccurrence). metadata is ids-only — NO
        //    requester PII, NO money.
        await tx.insert(auditLog).values({
          orgId: sess.orgId,
          actorUserId: sess.userId,
          action: 'booking_request.converted',
          entityType: 'booking_request',
          entityId: id,
          metadata: { previousStatus: currentStatus, reservationId, resourceId },
        });

        // 9. Return success — pass the gated path's warn-mode warnings through
        //    additively (only present when non-empty so the ok:true shape stays
        //    byte-identical for the common case).
        return {
          ok: true,
          id,
          status: 'converted',
          reservationId,
          reservation: created.reservation,
          ...(created.groundingWarnings ? { groundingWarnings: created.groundingWarnings } : {}),
          ...(created.twilightWarnings ? { twilightWarnings: created.twilightWarnings } : {}),
          ...(created.availabilityWarnings ? { availabilityWarnings: created.availabilityWarnings } : {}),
        };
      },
    );
  } catch (err) {
    // Gate refusal sentinel: the tx rolled back (request + reservation both
    // undone) — return the carried refusal result verbatim.
    if (err instanceof ConvertRefusedError) {
      return err.result as ConvertBookingRequestResult;
    }
    // Race: gatedCreateOccurrence's INSERT hit 23P01. The outer tx is poisoned +
    // rolled back (the request is untouched). Re-probe in a FRESH tx to build the
    // rich ConflictHit result. `session` is non-null here (requireCapability
    // validated it above).
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

// ─── App-code form ──────────────────────────────────────────────────────────────

/**
 * convertBookingRequest — atomically convert a booking_request into a reservation.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param input   - { id, resourceId, startAt, endAt } (notes are derived).
 * @returns ConvertBookingRequestResult — ok:true (reservation + converted) or a
 *          tagged ok:false (not_found | not_convertible | the 5 gate refusal arms).
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function convertBookingRequest(
  session: AppSession | null | undefined,
  input: ConvertBookingRequestInput,
): Promise<ConvertBookingRequestResult> {
  const db = await getDb();
  return _convertBookingRequestImpl(db, session, input);
}

// ─── Test/injectable form ───────────────────────────────────────────────────────

/**
 * convertBookingRequestWithDb — test form; inject a pglite client.
 * `opts.now` accepts an injected epoch-ms clock for deterministic gate tests.
 */
export async function convertBookingRequestWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ConvertBookingRequestInput,
  opts?: ConvertOptions,
): Promise<ConvertBookingRequestResult> {
  return _convertBookingRequestImpl(db, session, input, opts);
}
