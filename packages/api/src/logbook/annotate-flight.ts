/**
 * logbook/annotate-flight.ts — append a flight-condition annotation
 * (night / instrument / cross-country hours + remarks) to a CLOSED dispatch
 * ticket (Slice P2-LOG2).
 *
 * APPEND-ONLY: one INSERT into logbook_annotation (no UPDATE/DELETE RLS
 * policy exists — migration 0037). The EFFECTIVE annotation for a ticket is
 * the LATEST row (mirrors dispatch_ticket_correction's latest-wins pattern);
 * a mistaken annotation is superseded by a NEW row, never edited. The FROZEN
 * dispatch close path (ADR-0007) is untouched — dispatch_ticket gains no
 * columns and is never mutated here.
 *
 * CAPABILITY DECISION (no 'logbook:*' cap family exists — mirrors how the
 * P2 logbook READS are gated):
 *   - STAFF path: 'people:access' (the cap that gates the staff logbook
 *     reads getPilotLog/exportPilotLogCsv) may annotate ANY pilot's closed
 *     ticket in-org (owner/manager/dispatcher/cfi).
 *   - SELF path: otherwise 'portal:access' (the cap that gates the
 *     self-scoped logbook reads) — and the ticket's pilot_user_id MUST be
 *     session.userId. A portal user annotating someone else's ticket gets
 *     not_found (indistinguishable from a nonexistent ticket —
 *     anti-enumeration, same posture as the portal reads).
 *   The annotation's pilot_user_id is ALWAYS snapshotted from the ticket —
 *   never caller-supplied.
 *
 * GUARANTEES:
 *   - authz FIRST: capability check before any data access.
 *   - Zod-validated input → ValidationError on malformed data. Hours are
 *     tenths (multiple of 0.1) in [0, 99.9]; at least one of the four
 *     annotation fields must be provided.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop);
 *     cross-org ticket → not_found (RLS returns 0 rows).
 *   - Ticket must be CLOSED (not open/voided) → not_found / not_closed.
 *   - ONE audit_log row: 'logbook.flight_annotated'.
 *
 * COMPLIANCE HARD LINE: pilot/operator-entered data — NOT an FAA logbook of
 * record, NOT a certified §61.51 entry; AeroOps makes NO computed
 * currency/recency/experience determination (§61.51 / §61.57). NO money.
 *
 * TWO CALLING FORMS:
 *   annotateFlight(session, input)          — app code.
 *   annotateFlightWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { dispatchTicket, logbookAnnotation, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability, hasCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { UUID_RE } from './internal.js';

// ─── Hours schema (tenths, [0, 99.9] — matches the migration-0037 CHECKs) ─────

const hoursSchema = z
  .number({ message: 'Hours must be a number' })
  .finite({ message: 'Hours must be finite' })
  .min(0, { message: 'Hours must be >= 0' })
  .max(99.9, { message: 'Hours must be <= 99.9' })
  .refine(
    (v) => Math.round(v * 10) === v * 10,
    { message: 'Hours must have at most 1 decimal place' },
  );

// ─── Input schema ─────────────────────────────────────────────────────────────

const annotateFlightInputSchema = z
  .object({
    dispatchTicketId: z.string().regex(UUID_RE, { message: 'dispatchTicketId must be a UUID' }),
    nightHours:        hoursSchema.nullish(),
    instrumentHours:   hoursSchema.nullish(),
    crossCountryHours: hoursSchema.nullish(),
    remarks:           z.string().trim().min(1).max(2000).nullish(),
  })
  .refine(
    (d) =>
      d.nightHours != null ||
      d.instrumentHours != null ||
      d.crossCountryHours != null ||
      d.remarks != null,
    { message: 'At least one of nightHours, instrumentHours, crossCountryHours, or remarks must be provided' },
  );

export type AnnotateFlightInput = z.infer<typeof annotateFlightInputSchema>;

// ─── Result types ─────────────────────────────────────────────────────────────

/**
 * LogbookAnnotationView — one immutable annotation row.
 * Pilot/operator-entered data — not a certified §61.51 entry.
 */
export interface LogbookAnnotationView {
  id: string;
  dispatchTicketId: string;
  pilotUserId: string;
  nightHours: number | null;
  instrumentHours: number | null;
  crossCountryHours: number | null;
  remarks: string | null;
  createdBy: string;
  createdAt: Date;
}

export type AnnotateFlightResult =
  | { ok: true; annotation: LogbookAnnotationView }
  | { ok: false; reason: 'not_found' | 'not_closed' };

// ─── Internal helper ──────────────────────────────────────────────────────────

function parseNumericCol(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _annotateFlightImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<AnnotateFlightResult> {
  // 1. AUTHZ FIRST — staff (people:access, mirrors the staff logbook reads)
  //    may annotate any in-org pilot's ticket; otherwise portal:access
  //    (mirrors the self-scoped logbook reads) + self-only enforcement below.
  //    hasCapability only SELECTS the branch; the real gate on BOTH branches
  //    is requireCapability (fail-closed on missing/incomplete sessions).
  const isStaff = hasCapability(session, 'people:access');
  requireCapability(session, isStaff ? 'people:access' : 'portal:access');

  // 2. VALIDATE input.
  const parsed = annotateFlightInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[logbook] invalid annotateFlight input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { dispatchTicketId, nightHours, instrumentHours, crossCountryHours, remarks } =
    parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load ticket (RLS scopes to org; not visible → not_found).
    const ticketRows = await tx
      .select({
        id:          dispatchTicket.id,
        status:      dispatchTicket.status,
        pilotUserId: dispatchTicket.pilotUserId,
      })
      .from(dispatchTicket)
      .where(eq(dispatchTicket.id, dispatchTicketId))
      .limit(1);

    const ticket = ticketRows[0];
    if (!ticket) {
      return { ok: false, reason: 'not_found' } as const;
    }

    // SELF path: the ticket must be the caller's own flight. not_found (not
    // Forbidden) — indistinguishable from a nonexistent ticket (anti-enumeration).
    if (!isStaff && ticket.pilotUserId !== sess.userId) {
      return { ok: false, reason: 'not_found' } as const;
    }

    if (ticket.status !== 'closed') {
      return { ok: false, reason: 'not_closed' } as const;
    }

    // 4. INSERT annotation row (append-only; latest row per ticket wins).
    //    pilot_user_id is snapshotted from the ticket — never caller input.
    const inserted = await tx
      .insert(logbookAnnotation)
      .values({
        orgId:             sess.orgId,
        dispatchTicketId,
        pilotUserId:       ticket.pilotUserId,
        nightHours:        nightHours != null ? nightHours.toFixed(1) : null,
        instrumentHours:   instrumentHours != null ? instrumentHours.toFixed(1) : null,
        crossCountryHours: crossCountryHours != null ? crossCountryHours.toFixed(1) : null,
        remarks:           remarks ?? null,
        createdBy:         sess.userId,
        // createdAt defaults via defaultNow() in schema
      })
      .returning();

    const row = inserted[0];
    if (!row) {
      throw new Error('[logbook] annotateFlight: INSERT returned no rows');
    }

    // 5. ONE audit row (records integrity).
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'logbook.flight_annotated',
      entityType:  'dispatch_ticket',
      entityId:    dispatchTicketId,
      metadata: {
        annotationId:      row.id,
        pilotUserId:       ticket.pilotUserId,
        nightHours:        nightHours ?? null,
        instrumentHours:   instrumentHours ?? null,
        crossCountryHours: crossCountryHours ?? null,
        hasRemarks:        remarks != null,
        self:              ticket.pilotUserId === sess.userId,
      },
    });

    // 6. Build the view.
    const view: LogbookAnnotationView = {
      id:                row.id,
      dispatchTicketId:  row.dispatchTicketId,
      pilotUserId:       row.pilotUserId,
      nightHours:        parseNumericCol(row.nightHours),
      instrumentHours:   parseNumericCol(row.instrumentHours),
      crossCountryHours: parseNumericCol(row.crossCountryHours),
      remarks:           row.remarks,
      createdBy:         row.createdBy,
      createdAt:         row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as string),
    };

    return { ok: true, annotation: view };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function annotateFlight(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<AnnotateFlightResult> {
  const db = await getDb();
  return _annotateFlightImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function annotateFlightWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<AnnotateFlightResult> {
  return _annotateFlightImpl(db, session, input);
}
