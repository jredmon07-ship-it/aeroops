/**
 * update-booking-request-status.ts — Staff booking-request triage mutation.
 * (Slice PB1.2)
 *
 * TRANSITIONS (enforced as a tagged result, NOT thrown):
 *   new       → contacted | declined
 *   contacted → declined | contacted  (re-note: re-setting contacted is valid)
 *   converted → (no further transitions — terminal)
 *   declined  → (no further transitions — terminal)
 *   Any other transition → { ok:false, reason:'invalid_transition' }
 *
 * PB2.1b CHANGE: 'converted' was REMOVED as a target from this command. The ONLY
 * path to status='converted' is now convertBookingRequest (convert-booking-request.ts),
 * which atomically creates the reservation + flips the status in ONE tx. This kills
 * the "converted but no reservation" footgun — a converted request always has a
 * (linked) reservation. contacted → converted via this command is now an
 * invalid_transition.
 *
 * GUARANTEES:
 *   - requireCapability('booking:triage') FIRST — before any data access.
 *   - org_id from session ONLY; RLS is the backstop (no explicit org predicate).
 *   - Load row scoped by RLS (not found → { ok:false, reason:'not_found' }).
 *   - On success: status, handled_by=session.userId, handled_at=now(),
 *     optional triage_notes, updated_at=now() — satisfies booking_request_handled_shape_check.
 *   - ONE audit_log row per successful transition (action: 'booking_request.status_changed').
 *   - Audit metadata: { previousStatus, newStatus } — NO requester PII beyond what's
 *     necessary; NO money.
 *   - Requester fields (name/email/phone/requestedStart/End/aircraftTypePref/message)
 *     are NEVER mutated (write-once, per ADR-0013).
 *   - 'converted' sets the status flag ONLY — does NOT create a reservation,
 *     does NOT touch any scheduling/dispatch table.
 *
 * TWO CALLING FORMS:
 *   updateBookingRequestStatus(session, input)          — app code (uses getDb()).
 *   updateBookingRequestStatusWithDb(db, session, input) — tests (inject pglite).
 */

import { z } from 'zod';
import { sql, eq } from 'drizzle-orm';
import { bookingRequest, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { BookingRequestStatus } from './list-booking-requests.js';

// ─── Transition table ──────────────────────────────────────────────────────────

/**
 * ALLOWED_TRANSITIONS — maps each status to the set of statuses it may
 * transition to. Only entries here are permitted.
 *
 * new       → contacted | declined
 * contacted → declined | contacted  (re-note is valid)
 * converted → (terminal, no outgoing transitions)
 * declined  → (terminal, no outgoing transitions)
 *
 * PB2.1b: 'converted' is NO LONGER a reachable target here — the ONLY path to
 * converted is convertBookingRequest (atomic create-reservation + flip). This
 * guarantees a converted request always has a linked reservation.
 */
const ALLOWED_TRANSITIONS: Record<BookingRequestStatus, ReadonlySet<BookingRequestStatus>> = {
  new:       new Set<BookingRequestStatus>(['contacted', 'declined']),
  contacted: new Set<BookingRequestStatus>(['declined', 'contacted']),
  converted: new Set<BookingRequestStatus>([]),
  declined:  new Set<BookingRequestStatus>([]),
};

// ─── Input schema ──────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const updateBookingRequestStatusInputSchema = z.object({
  id:          z.string().regex(UUID_RE, { message: 'id must be a UUID' }),
  status:      z.enum(['new', 'contacted', 'converted', 'declined']),
  triageNotes: z.string().optional(),
});

export type UpdateBookingRequestStatusInput = z.infer<
  typeof updateBookingRequestStatusInputSchema
>;

// ─── Result type ───────────────────────────────────────────────────────────────

export type UpdateBookingRequestStatusResult =
  | { ok: true;  id: string; status: BookingRequestStatus }
  | { ok: false; reason: 'not_found' | 'invalid_transition' };

// ─── Shared implementation ─────────────────────────────────────────────────────

async function _updateBookingRequestStatusImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<UpdateBookingRequestStatusResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'booking:triage');

  // 2. VALIDATE input.
  const parsed = updateBookingRequestStatusInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[booking] invalid updateBookingRequestStatus input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { id, status: newStatus, triageNotes } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load row — RLS scopes to org; not visible → not_found.
    const rows = await tx
      .select({ id: bookingRequest.id, status: bookingRequest.status })
      .from(bookingRequest)
      .where(eq(bookingRequest.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return { ok: false, reason: 'not_found' } as const;
    }

    const currentStatus = row.status as BookingRequestStatus;

    // 4. Enforce transition guard.
    const allowed = ALLOWED_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.has(newStatus as BookingRequestStatus)) {
      return { ok: false, reason: 'invalid_transition' } as const;
    }

    // 5. Mutate — only triage fields. Requester fields are untouched (write-once).
    // handled_by = session.userId; handled_at = now() (satisfies shape check).
    // triage_notes is optional — only set when provided.
    const updateValues: Record<string, unknown> = {
      status:    newStatus,
      handledBy: sess.userId,
      handledAt: sql`now()`,
      updatedAt: sql`now()`,
    };
    if (triageNotes !== undefined) {
      updateValues.triageNotes = triageNotes;
    }

    await tx
      .update(bookingRequest)
      .set(updateValues)
      .where(eq(bookingRequest.id, id));

    // 6. ONE audit_log row per successful status change.
    // Metadata: previousStatus + newStatus only — no requester PII, no money.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'booking_request.status_changed',
      entityType:  'booking_request',
      entityId:    id,
      metadata:    { previousStatus: currentStatus, newStatus },
    });

    return { ok: true, id, status: newStatus as BookingRequestStatus };
  });
}

// ─── App-code form ─────────────────────────────────────────────────────────────

/**
 * updateBookingRequestStatus — staff triage mutation.
 *
 * @param session  - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param rawInput - { id, status, triageNotes? }.
 * @returns        - Tagged result: ok:true or ok:false with reason.
 * @throws         - UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function updateBookingRequestStatus(
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<UpdateBookingRequestStatusResult> {
  const db = await getDb();
  return _updateBookingRequestStatusImpl(db, session, rawInput);
}

// ─── Test/injectable form ──────────────────────────────────────────────────────

/** updateBookingRequestStatusWithDb — test form; inject a pglite client. */
export async function updateBookingRequestStatusWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<UpdateBookingRequestStatusResult> {
  return _updateBookingRequestStatusImpl(db, session, rawInput);
}
