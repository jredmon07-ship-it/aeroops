/**
 * correct-dispatch-meter.ts — Append-only correction to a CLOSED dispatch
 * ticket's recorded meters (Slice B0 / B1, ADR-0007 §1).
 *
 * EFFECTIVE METER: billing CONSUMES the latest correction ?? original.
 * This command APPENDS one row to dispatch_ticket_correction (INSERT-only table).
 * It NEVER mutates dispatch_ticket (the FROZEN close path is untouched).
 *
 * CAPABILITY DECISION:
 *   Uses `dispatch:close` (i.e. dispatch:create, which gates both open AND close
 *   in Slice 3a). Rationale: correcting a dispatch meter is a dispatch record
 *   operation — the same authority that can close a ticket (and thus record meters)
 *   should be able to correct a recorded meter. This avoids a new capability and
 *   correctly scopes to owner/manager/dispatcher/cfi. A separate `billing:manage`
 *   alternative is not used here because billing:manage is about invoice records,
 *   not dispatch meter records. If a higher authority is needed in a future
 *   compliance ruling (e.g. owner/manager only), a new cap can be added without
 *   changing the correction table structure.
 *   [VERIFY-B0-COMP-1]: dual-signature/audit-chain ruling may override this.
 *
 * GUARANTEES:
 *   - authz FIRST: `dispatch:create` required before any data access.
 *   - Validates input with Zod → ValidationError on malformed data.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Ticket must be CLOSED (not open/voided) — returns not_found or not_closed.
 *   - At least one of correctedHobbs or correctedTach must be provided.
 *   - reason must be non-empty after trim.
 *   - One INSERT into dispatch_ticket_correction (append-only; no UPDATE/DELETE).
 *   - One audit row: action 'dispatch.meter_corrected'.
 *   - Returns the inserted correction row.
 *
 * TWO CALLING FORMS:
 *   correctDispatchMeter(session, input)          — app code.
 *   correctDispatchMeterWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { dispatchTicket, dispatchTicketCorrection, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Meter schema (matches dispatch_ticket numeric(10,1) shape) ───────────────

const meterSchema = z
  .number({ message: 'Meter value must be a number' })
  .finite({ message: 'Meter value must be finite' })
  .min(0, { message: 'Meter value must be >= 0' })
  .refine(
    (v) => Math.round(v * 10) === v * 10,
    { message: 'Meter value must have at most 1 decimal place' },
  );

// ─── Input schema ─────────────────────────────────────────────────────────────

const correctDispatchMeterInputSchema = z
  .object({
    dispatchTicketId: z.string().regex(UUID_RE, { message: 'dispatchTicketId must be a UUID' }),
    correctedHobbs:   meterSchema.optional(),
    correctedTach:    meterSchema.optional(),
    reason:           z.string().min(1, { message: 'reason must not be empty' }),
  })
  .refine(
    (d) => d.correctedHobbs !== undefined || d.correctedTach !== undefined,
    { message: 'At least one of correctedHobbs or correctedTach must be provided' },
  );

export type CorrectDispatchMeterInput = z.infer<typeof correctDispatchMeterInputSchema>;

// ─── Result types ─────────────────────────────────────────────────────────────

export interface DispatchCorrectionView {
  id:               string;
  orgId:            string;
  dispatchTicketId: string;
  correctedHobbs:   number | null;
  correctedTach:    number | null;
  reason:           string;
  createdBy:        string;
  createdAt:        Date;
}

export type CorrectDispatchMeterResult =
  | { ok: true;  correction: DispatchCorrectionView }
  | { ok: false; reason: 'not_found' | 'not_closed' };

// ─── Internal helper ──────────────────────────────────────────────────────────

function parseNumericCol(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _correctDispatchMeterImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CorrectDispatchMeterResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'dispatch:create');

  // 2. VALIDATE input.
  const parsed = correctDispatchMeterInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid correctDispatchMeter input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { dispatchTicketId, correctedHobbs, correctedTach, reason } = parsed.data;

  // Trim-check reason (belt-and-suspenders beyond zod min(1)).
  if (reason.trim().length === 0) {
    throw new ValidationError('[billing] correctDispatchMeter: reason must not be blank');
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load ticket (RLS scopes to org; not visible → not_found).
    const ticketRows = await tx
      .select({
        id:     dispatchTicket.id,
        status: dispatchTicket.status,
        orgId:  dispatchTicket.orgId,
      })
      .from(dispatchTicket)
      .where(eq(dispatchTicket.id, dispatchTicketId))
      .limit(1);

    const ticket = ticketRows[0];
    if (!ticket) {
      return { ok: false, reason: 'not_found' } as const;
    }
    if (ticket.status !== 'closed') {
      return { ok: false, reason: 'not_closed' } as const;
    }

    // 4. INSERT correction row (append-only; no UPDATE/DELETE on this table).
    const inserted = await tx
      .insert(dispatchTicketCorrection)
      .values({
        orgId:            sess.orgId,
        dispatchTicketId,
        correctedHobbs:   correctedHobbs !== undefined ? correctedHobbs.toFixed(1) : null,
        correctedTach:    correctedTach  !== undefined ? correctedTach.toFixed(1)  : null,
        reason,
        createdBy:        sess.userId,
        // createdAt defaults via defaultNow() in schema
      })
      .returning();

    const row = inserted[0];
    if (!row) {
      throw new Error('[billing] correctDispatchMeter: INSERT returned no rows');
    }

    // 5. Audit row — one per correction (records integrity).
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'dispatch.meter_corrected',
      entityType:  'dispatch_ticket',
      entityId:    dispatchTicketId,
      metadata: {
        correctionId:  row.id,
        correctedHobbs: correctedHobbs ?? null,
        correctedTach:  correctedTach  ?? null,
        reason,
      },
    });

    // 6. Build the view.
    const view: DispatchCorrectionView = {
      id:               row.id,
      orgId:            row.orgId,
      dispatchTicketId: row.dispatchTicketId,
      correctedHobbs:   parseNumericCol(row.correctedHobbs),
      correctedTach:    parseNumericCol(row.correctedTach),
      reason:           row.reason,
      createdBy:        row.createdBy,
      createdAt:        row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as string),
    };

    return { ok: true, correction: view };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function correctDispatchMeter(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CorrectDispatchMeterResult> {
  const db = await getDb();
  return _correctDispatchMeterImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function correctDispatchMeterWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CorrectDispatchMeterResult> {
  return _correctDispatchMeterImpl(db, session, input);
}
