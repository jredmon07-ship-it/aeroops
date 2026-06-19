/**
 * dispatch/types.ts — public result/IO types for the dispatch write paths
 * (DISPATCH-3a, ADR-0007). Framework-agnostic; no I/O.
 *
 * DESIGN POSTURE (mirrors scheduling/types.ts):
 *   - Operational refusals (already_open / not_found / not_open) are RETURNED
 *     as discriminated-union values, NOT thrown. The UI renders them as messages.
 *   - Auth failures are THROWN as ForbiddenError / UnauthenticatedError.
 *   - Validation failures (bad meters, not-UUID, inactive resource) are THROWN
 *     as ValidationError (imported from scheduling/internal.ts).
 *
 * ADDITIVE: do NOT modify scheduling types. These types live in this new module.
 *
 * §3.5 DispatchTicketView: numeric columns parsed to number at the API boundary
 * (numeric(10,1) arrives as string from postgres-js / pglite).
 */

import type { DispatchStatus } from '@aeroops/core';

// ─── DispatchTicketView (§3.5) ────────────────────────────────────────────────

/**
 * DispatchTicketView — the dispatch_ticket row as seen by API callers.
 *
 * Numeric columns (hobbsOut/tachOut/hobbsIn/tachIn/flightTimeHours) are parsed
 * to number at the API boundary (the DB driver returns numeric(10,1) as string).
 *
 * Nullable columns are null when the ticket is open or voided (per the
 * dispatch_closed_shape_check DB constraint and ADR-0007 §1):
 *   hobbsIn, tachIn, flightTimeHours — written only at CLOSE
 *   closedBy, closedAt              — written only at CLOSE
 *   notes                            — optional free text, always nullable
 */
export interface DispatchTicketView {
  id: string;
  reservationId: string;
  resourceId: string;
  pilotUserId: string;
  status: DispatchStatus;
  /** Hobbs meter reading at check-OUT (decimal hours, always set). */
  hobbsOut: number;
  /** Tach meter reading at check-OUT (decimal hours, always set). */
  tachOut: number;
  /** Hobbs meter reading at check-IN (null when open or voided). */
  hobbsIn: number | null;
  /** Tach meter reading at check-IN (null when open or voided). */
  tachIn: number | null;
  /**
   * Derived billable flight time (Hobbs basis, via deriveFlightTime).
   * Written once at CLOSE. Null when open or voided.
   * This is OPERATIONS DATA — never a price.
   */
  flightTimeHours: number | null;
  /** Optional operator notes. */
  notes: string | null;
  /** userId of the actor who opened (checked out) the ticket. */
  openedBy: string;
  /** Timestamp when the ticket was opened. */
  openedAt: Date;
  /** userId of the actor who closed (checked in) the ticket. Null when open/voided. */
  closedBy: string | null;
  /** Timestamp when the ticket was closed. Null when open/voided. */
  closedAt: Date | null;
}

// ─── openDispatch result union ────────────────────────────────────────────────

/**
 * OpenDispatchResult — discriminated union for openDispatch.
 *
 *   ok:true                            → ticket inserted (status='open').
 *   ok:true + eligibilityWarnings      → ticket inserted but pilot is missing
 *                                        required tags (mode='warn'; advisory only).
 *   ok:false reason:'not_found'        → the reservation is not visible in the
 *                                        session org OR is not in 'booked' status.
 *   ok:false reason:'already_open'     → a ticket for this aircraft is already
 *                                        open; openTicketId names the blocking row.
 *                                        Caught from DB 23505 (partial-UNIQUE).
 *   ok:false reason:'grounded'         → the aircraft has an active grounding event;
 *                                        dispatch is blocked (ADR-0008 §2.3 Integration B).
 *                                        grounding.reason is the operator-set reason.
 *                                        [VERIFY-3b-H] operator enforcement only, no FAR.
 *   ok:false reason:'ineligible'       → the aircraft has required tags and the pilot
 *                                        is missing some (mode='block'). missingTags
 *                                        lists the absent tags. No write/audit occurs.
 *                                        [VERIFY-3c-A] operator enforcement only, no FAR.
 *   ok:false reason:'balance_block'    → RESERVED (Phase 1 unreachable via stub).
 *                                        The balance seam returned { ok:false }.
 *                                        No write/audit occurs. [VERIFY-3c-MONEY]
 *
 * ADDITIVE: existing arms (not_found / already_open / grounded) are byte-identical.
 * New arms (ineligible / balance_block) and the eligibilityWarnings optional field
 * are the only additions (ADR-0009 §2).
 */
export type OpenDispatchResult =
  | { ok: true; ticket: DispatchTicketView; eligibilityWarnings?: string[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'already_open'; openTicketId: string }
  | { ok: false; reason: 'grounded'; grounding: { resourceId: string; reason: string | null } }
  | { ok: false; reason: 'ineligible'; missingTags: string[] }
  | { ok: false; reason: 'balance_block' };

// ─── closeDispatch result union ───────────────────────────────────────────────

/**
 * CloseDispatchResult — discriminated union for closeDispatch.
 *
 *   ok:true                       → ticket updated (status='closed', meters IN
 *                                    + flightTimeHours written).
 *   ok:false reason:'not_found'   → the ticket is not visible in the session org.
 *   ok:false reason:'not_open'    → the ticket exists but is already closed or
 *                                    voided (or a concurrent writer raced us).
 */
export type CloseDispatchResult =
  | { ok: true; ticket: DispatchTicketView }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_open' };

// ─── voidDispatch result union ────────────────────────────────────────────────

/**
 * VoidDispatchResult — discriminated union for voidDispatch.
 *
 *   ok:true                       → ticket updated (status='voided'). Aircraft
 *                                    is now free for a new open ticket.
 *   ok:false reason:'not_found'   → the ticket is not visible in the session org.
 *   ok:false reason:'not_open'    → the ticket exists but is already closed or
 *                                    voided.
 */
export type VoidDispatchResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_open' };
