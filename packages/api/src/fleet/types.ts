/**
 * fleet/types.ts — public result/IO types for the fleet read + edit paths
 * (Slice 5.2, AeroOps Fleet Hub). Framework-agnostic; no I/O.
 *
 * DESIGN POSTURE:
 *   - Operational refusals (not_found, invalid_home_base) are RETURNED as
 *     discriminated-union values, NOT thrown. The UI renders them as messages.
 *   - Auth failures are THROWN as ForbiddenError / UnauthenticatedError.
 *   - Validation failures (bad year, non-UUID) are THROWN as ValidationError.
 *
 * REUSES (import-only, never redefine):
 *   DispatchTicketView  — from dispatch/types.ts
 *   SquawkView          — from maintenance/types.ts
 *   GroundingStatusView — from maintenance/types.ts
 *
 * [VERIFY-5-A] currentHobbs/currentTach display: label as "last recorded"
 *   reading (latest closed ticket's _in fields), NOT an authoritative airframe
 *   total or maintenance value. Compliance must confirm display-only wording.
 * [VERIFY-5-B] grounding banner: operator-data language only, never "not airworthy".
 */

import type { DispatchTicketView } from '../dispatch/types.js';
import type { SquawkView, GroundingStatusView } from '../maintenance/types.js';
import type { WorkOrderView } from '../maintenance/work-order-types.js';

// Re-export for barrel convenience.
export type { DispatchTicketView, SquawkView, GroundingStatusView, WorkOrderView };

// ─── AircraftListRow ──────────────────────────────────────────────────────────

/**
 * AircraftListRow — one row in the fleet list (listAircraft).
 * Lightweight summary: identity + grounding + open-squawk count +
 * open work-order count (≥0).
 */
export interface AircraftListRow {
  id: string;
  tailNumber: string;
  make: string | null;
  model: string | null;
  active: boolean;
  grounded: boolean;
  /** Operator-entered grounding reason when grounded (null otherwise). [VERIFY-5-B] operator data, never an airworthiness determination. */
  groundingReason: string | null;
  openSquawkCount: number;
  /** Count of work orders in status open or in_progress for this aircraft. */
  openWorkOrderCount: number;
}

// ─── UpcomingReservationRow ───────────────────────────────────────────────────

/**
 * UpcomingReservationRow — one upcoming booked reservation for this aircraft.
 * Focused shape for the fleet detail page; no N+1.
 */
export interface UpcomingReservationRow {
  id: string;
  startAt: Date;
  endAt: Date;
  /** Non-null when the reservation belongs to a recurring series. */
  seriesId: string | null;
}

// ─── AircraftDetail ───────────────────────────────────────────────────────────

/**
 * AircraftDetail — full aggregated detail for a single aircraft.
 *
 * Returned by getAircraftDetail. All facets are fetched inside a single
 * org context (no N+1, no cross-org peek).
 *
 * currentHobbs / currentTach / currentMetersAsOf: derived from the latest
 * status='closed' dispatch ticket's hobbsIn / tachIn / closedAt. Null when
 * no closed ticket exists. [VERIFY-5-A]
 */
export interface AircraftDetail {
  // Identity
  id: string;
  tailNumber: string;
  displayName: string;
  make: string | null;
  model: string | null;
  year: number | null;
  serialNumber: string | null;
  active: boolean;
  hasHobbs: boolean;
  hasTach: boolean;

  // Home base (null when not set or location was deleted via SET NULL)
  homeBase: { id: string; name: string; icao: string | null } | null;

  // Grounding (operator data — [VERIFY-5-B])
  grounding: GroundingStatusView;

  // Squawks
  openSquawkCount: number;
  recentSquawks: SquawkView[];  // ≤10, newest-first

  // Dispatch (incl. voided tickets for audit history)
  recentDispatch: DispatchTicketView[];  // ≤10, newest-first

  // Current meters — latest closed ticket's _in readings [VERIFY-5-A]
  currentHobbs: number | null;
  currentTach: number | null;
  currentMetersAsOf: Date | null;

  // Upcoming reservations (future, booked, this aircraft, ≤10, ASC)
  upcomingReservations: UpcomingReservationRow[];

  // Open work orders (status in open/in_progress, ≤10, newest-first) [VERIFY-M1-E]
  openWorkOrders: WorkOrderView[];
  openWorkOrderCount: number;
}

// ─── UpdateAircraftResult ─────────────────────────────────────────────────────

/**
 * UpdateAircraftResult — discriminated union for updateAircraft.
 *
 *   ok:true                            → identity fields updated; ONE audit row.
 *                                        Returns fresh AircraftDetail.
 *   ok:false reason:'not_found'        → no visible aircraft with that id.
 *   ok:false reason:'invalid_home_base' → homeBaseLocationId not visible/same-org.
 */
export type UpdateAircraftResult =
  | { ok: true; aircraft: AircraftDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_home_base' };

// ─── LocationOption ───────────────────────────────────────────────────────────

/**
 * LocationOption — lightweight location row for the home-base select.
 * Returned by listLocations.
 */
export interface LocationOption {
  id: string;
  name: string;
  icao: string | null;
}
