/**
 * close-dispatch.ts — the single sanctioned CHECK-IN (CLOSE) write path.
 * (DISPATCH-3a-2, ADR-0007 §1,4,6)
 *
 * GUARANTEES:
 *   - authz first: requireCapability('dispatch:create') BEFORE any data access.
 *   - validates input with Zod → ValidationError on malformed meters.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - ticket not visible in org → not_found.
 *   - ticket status !== 'open' → not_open (returned, not thrown).
 *   - hobbsIn < hobbsOut OR tachIn < tachOut → ValidationError (no write).
 *   - derives flightTimeHours = deriveFlightTime(hobbsOut, hobbsIn) ONCE in-tx.
 *   - UPDATE WHERE id=$id AND status='open' (0 rows = race → not_open).
 *   - writes audit 'dispatch.closed' with metadata {hobbsIn,tachIn,flightTimeHours,basis:'hobbs'}.
 *   - meters write-once (hobbsIn/tachIn/flightTimeHours written here, never again).
 *
 * TWO CALLING FORMS:
 *   closeDispatch(session, input)         — app code.
 *   closeDispatchWithDb(db, session, in)  — tests.
 */
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { dispatchTicket, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { deriveFlightTime } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toDispatchTicketView } from './internal.js';
import type { CloseDispatchResult } from './types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schema ─────────────────────────────────────────────────────────────

const meterSchema = z
  .number({ message: 'Meter reading must be a number' })
  .finite({ message: 'Meter reading must be finite' })
  .min(0, { message: 'Meter reading must be >= 0' })
  .refine(
    (v) => Math.round(v * 10) === v * 10,
    { message: 'Meter reading must have at most 1 decimal place' },
  );

const closeDispatchInputSchema = z.object({
  ticketId: z.string().regex(UUID_RE, { message: 'ticketId must be a UUID' }),
  hobbsIn:  meterSchema,
  tachIn:   meterSchema,
});

export type CloseDispatchInput = z.infer<typeof closeDispatchInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _closeDispatchImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CloseDispatchResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'dispatch:create');

  // 2. VALIDATE input.
  const parsed = closeDispatchInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[dispatch] invalid closeDispatch input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { ticketId, hobbsIn, tachIn } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load ticket (RLS scopes to org; not visible → not_found).
    const rows = await tx
      .select({
        id:               dispatchTicket.id,
        orgId:            dispatchTicket.orgId,
        reservationId:    dispatchTicket.reservationId,
        resourceId:       dispatchTicket.resourceId,
        pilotUserId:      dispatchTicket.pilotUserId,
        status:           dispatchTicket.status,
        hobbsOut:         dispatchTicket.hobbsOut,
        tachOut:          dispatchTicket.tachOut,
        hobbsIn:          dispatchTicket.hobbsIn,
        tachIn:           dispatchTicket.tachIn,
        flightTimeHours:  dispatchTicket.flightTimeHours,
        notes:            dispatchTicket.notes,
        openedBy:         dispatchTicket.openedBy,
        openedAt:         dispatchTicket.openedAt,
        closedBy:         dispatchTicket.closedBy,
        closedAt:         dispatchTicket.closedAt,
        createdAt:        dispatchTicket.createdAt,
        updatedAt:        dispatchTicket.updatedAt,
      })
      .from(dispatchTicket)
      .where(eq(dispatchTicket.id, ticketId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return { ok: false, reason: 'not_found' } as const;
    }

    // 4. Status check: must be 'open'.
    if (row.status !== 'open') {
      return { ok: false, reason: 'not_open' } as const;
    }

    // 5. Validate in >= out (app-level, NOT DB CHECK — ADR-0007 §2 [VERIFY-A]).
    const hobbsOut = typeof row.hobbsOut === 'string' ? parseFloat(row.hobbsOut) : row.hobbsOut;
    const tachOut  = typeof row.tachOut  === 'string' ? parseFloat(row.tachOut)  : row.tachOut;

    if (hobbsIn < hobbsOut) {
      throw new ValidationError(
        `[dispatch] hobbsIn (${hobbsIn}) must be >= hobbsOut (${hobbsOut}).`,
      );
    }
    if (tachIn < tachOut) {
      throw new ValidationError(
        `[dispatch] tachIn (${tachIn}) must be >= tachOut (${tachOut}).`,
      );
    }

    // 6. Derive flight time — pure core fn (ADR-0007 §4).
    const flightTimeHours = deriveFlightTime(hobbsOut, hobbsIn);

    // 7. UPDATE WHERE id=$id AND status='open' (concurrent race guard).
    const updated = await tx
      .update(dispatchTicket)
      .set({
        status:          'closed',
        hobbsIn:         hobbsIn.toFixed(1),
        tachIn:          tachIn.toFixed(1),
        flightTimeHours: flightTimeHours.toFixed(1),
        closedBy:        sess.userId,
        closedAt:        sql`now()`,
        updatedAt:       sql`now()`,
      })
      .where(
        and(
          eq(dispatchTicket.id, ticketId),
          eq(dispatchTicket.status, 'open'),
        ),
      )
      .returning({
        id:               dispatchTicket.id,
        orgId:            dispatchTicket.orgId,
        reservationId:    dispatchTicket.reservationId,
        resourceId:       dispatchTicket.resourceId,
        pilotUserId:      dispatchTicket.pilotUserId,
        status:           dispatchTicket.status,
        hobbsOut:         dispatchTicket.hobbsOut,
        tachOut:          dispatchTicket.tachOut,
        hobbsIn:          dispatchTicket.hobbsIn,
        tachIn:           dispatchTicket.tachIn,
        flightTimeHours:  dispatchTicket.flightTimeHours,
        notes:            dispatchTicket.notes,
        openedBy:         dispatchTicket.openedBy,
        openedAt:         dispatchTicket.openedAt,
        closedBy:         dispatchTicket.closedBy,
        closedAt:         dispatchTicket.closedAt,
        createdAt:        dispatchTicket.createdAt,
        updatedAt:        dispatchTicket.updatedAt,
      });

    // 0 rows returned = lost the race to a concurrent close/void.
    if (!updated[0]) {
      return { ok: false, reason: 'not_open' } as const;
    }

    // 8. Audit row — exactly one per close (ADR-0007 invariant 2).
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'dispatch.closed',
      entityType:  'dispatch_ticket',
      entityId:    ticketId,
      metadata: {
        hobbsIn,
        tachIn,
        flightTimeHours,
        basis: 'hobbs',
      },
    });

    return { ok: true, ticket: toDispatchTicketView(updated[0]) };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * closeDispatch — check in an aircraft (CLOSE a dispatch ticket).
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param input   - { ticketId, hobbsIn, tachIn }.
 * @returns CloseDispatchResult — ok:true with the closed ticket, or ok:false
 *          reason:'not_found'|'not_open'.
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function closeDispatch(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CloseDispatchResult> {
  const db = await getDb();
  return _closeDispatchImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** closeDispatchWithDb — test form; inject a pglite client. */
export async function closeDispatchWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CloseDispatchResult> {
  return _closeDispatchImpl(db, session, input);
}
