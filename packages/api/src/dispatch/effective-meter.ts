/**
 * effective-meter.ts — Derives the effective Hobbs/tach meter values for a
 * CLOSED dispatch ticket by applying the latest correction (if any).
 *
 * EFFECTIVE METER RULE (ADR-0007 §1 + dispatch-ticket-correction schema):
 *   effective = latest correction ?? original closed _in values
 *
 * This is the ONLY canonical place to derive the effective meter for a ticket.
 *
 * GUARANTEES:
 *   - READ-ONLY: does not mutate any row.
 *   - The FROZEN dispatch close path is NEVER touched here.
 *   - RLS-scoped via the calling tx (withSessionOrgContextWithDb).
 *   - Returns effective hobbs/tach as numbers (parsed from numeric(10,1) strings).
 *   - flightTimeHours = the write-once flight_time_hours from the closed ticket
 *     (NOT recomputed from effective meters — ADR-0007 §4 frozen).
 *
 * [VERIFY-B0-COMP-1]: correction chain for dual-signature (flagged from the
 *   correction schema).
 */

import { eq, desc } from 'drizzle-orm';
import { dispatchTicket, dispatchTicketCorrection } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EffectiveMeterResult {
  /** The ticket is NOT found in this org or is not closed. */
  ok: false;
  reason: 'not_found' | 'not_closed';
}

export interface EffectiveMeterOk {
  ok: true;
  ticketId: string;
  resourceId: string;
  pilotUserId: string;
  /** Effective hobbs-in (correction ?? original), as a decimal number. */
  effectiveHobbsIn: number;
  /** Effective tach-in (correction ?? original), as a decimal number. */
  effectiveTachIn: number;
  /** The STORED write-once flight_time_hours. NOT recomputed. */
  flightTimeHours: number;
  /** Whether a correction row was used (for audit/UI informational purposes). */
  correctionApplied: boolean;
}

export type GetEffectiveMeterResult = EffectiveMeterResult | EffectiveMeterOk;

// ─── Internal helper ──────────────────────────────────────────────────────────

/**
 * parseNumericCol — safely parse a Drizzle numeric(10,1) value to a JS number.
 * Drizzle returns numeric columns as strings in PGlite; production Postgres also
 * returns them as strings through the node-postgres driver.
 */
function parseNumericCol(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

// ─── Public function ──────────────────────────────────────────────────────────

/**
 * getEffectiveMeter — reads the effective meters for a CLOSED dispatch ticket.
 *
 * Must be called INSIDE a withSessionOrgContextWithDb transaction so that RLS
 * is active (org_id GUC set). The `tx` parameter IS the transaction client.
 *
 * @param tx        - Drizzle transaction client (RLS already set by session context).
 * @param ticketId  - UUID of the dispatch ticket to inspect.
 * @returns GetEffectiveMeterResult — ok:true with effective values, or ok:false.
 */
export async function getEffectiveMeter(
  tx: AnyDb,
  ticketId: string,
): Promise<GetEffectiveMeterResult> {
  // 1. Load the dispatch ticket (RLS scopes to org — not visible → not_found).
  const ticketRows = await tx
    .select({
      id:              dispatchTicket.id,
      resourceId:      dispatchTicket.resourceId,
      pilotUserId:     dispatchTicket.pilotUserId,
      status:          dispatchTicket.status,
      hobbsIn:         dispatchTicket.hobbsIn,
      tachIn:          dispatchTicket.tachIn,
      flightTimeHours: dispatchTicket.flightTimeHours,
    })
    .from(dispatchTicket)
    .where(eq(dispatchTicket.id, ticketId))
    .limit(1);

  const ticket = ticketRows[0];
  if (!ticket) {
    return { ok: false, reason: 'not_found' };
  }
  if (ticket.status !== 'closed') {
    return { ok: false, reason: 'not_closed' };
  }

  // 2. Validate that the closed ticket has all required fields.
  const originalHobbsIn = parseNumericCol(ticket.hobbsIn);
  const originalTachIn  = parseNumericCol(ticket.tachIn);
  const flightTime      = parseNumericCol(ticket.flightTimeHours);

  if (
    originalHobbsIn === null ||
    originalTachIn === null ||
    flightTime === null
  ) {
    // This should be structurally impossible given dispatch_closed_shape_check,
    // but be defensive.
    return { ok: false, reason: 'not_closed' };
  }

  // 3. Look up the latest correction for this ticket (ORDER BY created_at DESC LIMIT 1).
  // The correction table covers (org_id, dispatch_ticket_id, created_at) for this query.
  const correctionRows = await tx
    .select({
      correctedHobbs: dispatchTicketCorrection.correctedHobbs,
      correctedTach:  dispatchTicketCorrection.correctedTach,
    })
    .from(dispatchTicketCorrection)
    .where(eq(dispatchTicketCorrection.dispatchTicketId, ticketId))
    .orderBy(desc(dispatchTicketCorrection.createdAt))
    .limit(1);

  const correction = correctionRows[0];

  // 4. Apply correction ?? original.
  let effectiveHobbsIn = originalHobbsIn;
  let effectiveTachIn  = originalTachIn;
  let correctionApplied = false;

  if (correction) {
    const corrHobbs = parseNumericCol(correction.correctedHobbs);
    const corrTach  = parseNumericCol(correction.correctedTach);
    // Correction may adjust hobbs only, tach only, or both.
    if (corrHobbs !== null) {
      effectiveHobbsIn = corrHobbs;
      correctionApplied = true;
    }
    if (corrTach !== null) {
      effectiveTachIn = corrTach;
      correctionApplied = true;
    }
  }

  return {
    ok: true,
    ticketId,
    resourceId:       ticket.resourceId,
    pilotUserId:      ticket.pilotUserId,
    effectiveHobbsIn,
    effectiveTachIn,
    flightTimeHours:  flightTime,
    correctionApplied,
  };
}
