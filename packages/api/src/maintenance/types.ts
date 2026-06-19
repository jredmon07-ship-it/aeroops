/**
 * maintenance/types.ts — public result/IO types for the maintenance write paths
 * (DISPATCH-3b, ADR-0008). Framework-agnostic; no I/O.
 *
 * DESIGN POSTURE (mirrors dispatch/types.ts):
 *   - Operational refusals (not_found, not_open, alreadyGrounded, alreadyReleased)
 *     are RETURNED as discriminated-union values, NOT thrown. The UI renders them.
 *   - Auth failures are THROWN as ForbiddenError / UnauthenticatedError.
 *   - Validation failures (bad input, non-aircraft, inactive, cross-org-invisible)
 *     are THROWN as ValidationError.
 *
 * ADDITIVE: do NOT modify dispatch types. These types live in this new module.
 *
 * Grounding is operator data only — the software makes no FAR/Part-91/43
 * airworthiness determination. Severity='grounding' never auto-grounds.
 */

import type { GroundingState, SquawkStatus, SquawkSeverity } from '@aeroops/core';

// ─── GroundingEventView ───────────────────────────────────────────────────────

/**
 * GroundingEventView — a single aircraft_grounding row as seen by API callers.
 */
export interface GroundingEventView {
  id: string;
  resourceId: string;
  state: GroundingState;
  reason: string;
  squawkId: string | null;
  dispatchTicketId: string | null;
  createdBy: string;
  createdAt: Date;
}

// ─── GroundingStatusView ──────────────────────────────────────────────────────

/**
 * GroundingStatusView — current computed grounding status for a resource.
 * Derived from the latest aircraft_grounding event (or absence thereof).
 */
export interface GroundingStatusView {
  grounded: boolean;
  reason: string | null;
  since: Date | null;
  groundedBy: string | null;
  eventId: string | null;
}

// ─── SquawkView ───────────────────────────────────────────────────────────────

/**
 * SquawkView — a squawk row as seen by API callers.
 *
 * Write-once fields: resourceId, dispatchTicketId, title, description, severity,
 * reportedBy, reportedAt. Only status/resolution fields mutate.
 */
export interface SquawkView {
  id: string;
  resourceId: string;
  dispatchTicketId: string | null;
  title: string;
  description: string | null;
  severity: SquawkSeverity;
  status: SquawkStatus;
  reportedBy: string;
  reportedAt: Date;
  resolutionNotes: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
}

// ─── groundAircraft result union ─────────────────────────────────────────────

/**
 * GroundAircraftResult — discriminated union for groundAircraft.
 *
 *   ok:true alreadyGrounded:true  → aircraft was already grounded; NO new row/audit.
 *   ok:true alreadyGrounded:false → new 'grounded' event inserted; audit written.
 *
 * Everything invalid THROWS (ValidationError / ForbiddenError / UnauthenticatedError).
 * There is no not_found arm — non-visible resources throw ValidationError.
 */
export type GroundAircraftResult =
  | { ok: true; grounding: GroundingEventView; alreadyGrounded?: boolean };

// ─── unGroundAircraft result union ───────────────────────────────────────────

/**
 * UnGroundResult — discriminated union for unGroundAircraft.
 *
 *   ok:true alreadyReleased:true  → aircraft was not grounded; NO new row/audit.
 *   ok:true alreadyReleased:false → new 'released' event inserted; audit written.
 *   grounding: null when alreadyReleased (no row was written).
 */
export type UnGroundResult =
  | { ok: true; grounding: GroundingEventView | null; alreadyReleased?: boolean };

// ─── reportSquawk result union ────────────────────────────────────────────────

/**
 * ReportSquawkResult — discriminated union for reportSquawk.
 *
 *   ok:true → squawk inserted; audit written.
 *
 * Everything invalid THROWS. No refusal arms on the happy-path call.
 */
export type ReportSquawkResult =
  | { ok: true; squawk: SquawkView };

// ─── updateSquawkStatus result union ─────────────────────────────────────────

/**
 * UpdateSquawkStatusResult — discriminated union for updateSquawkStatus.
 *
 *   ok:true            → transition applied (open→resolved or open→deferred).
 *   ok:false not_found → squawk not visible in the session org.
 *   ok:false not_open  → squawk exists but is not in 'open' status (already
 *                         resolved/deferred, or a concurrent writer raced).
 *
 * Note: open→open is handled as a no-op ok:true (spec §2.4 comment "open→open
 * no-op { ok:true }") — but the input schema constrains status to
 * 'resolved'|'deferred' so this arm is unreachable via the API.
 * No reopen path ([VERIFY-3b-D]).
 */
export type UpdateSquawkStatusResult =
  | { ok: true; squawk: SquawkView }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_open' };
