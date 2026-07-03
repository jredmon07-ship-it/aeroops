/**
 * mobile/dto.ts — Mobile API DTOs and mappers (Slice 4M.2).
 *
 * RN-SAFE: no Date objects on the wire (Dates → ISO strings).
 * SHARED: imported by both the route handler (apps/web) and the Expo app.
 * BOUNDARY: @aeroops/core ONLY (no @aeroops/api, no @aeroops/db).
 *
 * SECURITY INVARIANTS:
 *   - org_id is NEVER included in any DTO sent to the device.
 *     The org context is established exclusively via the signed bearer token.
 *   - The mapper functions are pure (no I/O, fully unit-testable).
 *   - The window schema is exported for defense-in-depth validation on the
 *     device as well as in the route handler.
 */

import { z } from 'zod';

// ─── Request window schema ─────────────────────────────────────────────────────

/**
 * MAX_WINDOW_DAYS — cap on the from/to window the device may request.
 * Keeps response sizes bounded; 31 days covers any calendar month view.
 */
const MAX_WINDOW_DAYS = 31;

/**
 * mobileScheduleWindowSchema — zod schema for the GET /api/mobile/v1/schedule
 * query parameters.
 *
 * Validates:
 *   - `from` and `to` are valid ISO-8601 datetime strings.
 *   - `to` > `from` (non-zero window).
 *   - Window length ≤ 31 days (MAX_WINDOW_DAYS).
 *
 * Exported so both the route handler and the device (defense-in-depth) use
 * the exact same rules.
 */
export const mobileScheduleWindowSchema = z
  .object({
    from: z.string().datetime({ message: 'from must be a valid ISO datetime string' }),
    to: z.string().datetime({ message: 'to must be a valid ISO datetime string' }),
  })
  .refine(
    (data) => new Date(data.to) > new Date(data.from),
    { message: 'to must be after from', path: ['to'] },
  )
  .refine(
    (data) => {
      const diffMs = new Date(data.to).getTime() - new Date(data.from).getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      return diffDays <= MAX_WINDOW_DAYS;
    },
    { message: `Window must not exceed ${MAX_WINDOW_DAYS} days`, path: ['to'] },
  );

/** Inferred type for the validated window input. */
export type MobileScheduleWindow = z.infer<typeof mobileScheduleWindowSchema>;

// ─── MobileReservationDTO ──────────────────────────────────────────────────────

/**
 * MobileReservationDTO — wire-safe projection of a reservation row.
 *
 * SECURITY:
 *   - `orgId` is ABSENT — the device must not receive or trust the org UUID.
 *   - All Date fields are serialized to ISO-8601 strings (RN cannot safely
 *     transfer Date objects across the serialization boundary).
 */
export interface MobileReservationDTO {
  id: string;
  startAt: string;   // ISO-8601
  endAt: string;     // ISO-8601
  status: 'booked' | 'cancelled';
  notes: string | null;
  resourceIds: string[];
  seriesId: string | null;
  // orgId intentionally ABSENT
}

// ─── MobileResourceDTO ─────────────────────────────────────────────────────────

/**
 * MobileResourceDTO — wire-safe projection of a resource row.
 *
 * The day list needs enough context to render a resource label and
 * (for aircraft) the tail number. No org-scoped identifiers beyond id.
 */
export interface MobileResourceDTO {
  id: string;
  kind: string;
  displayName: string;
  tailNumber: string | null;
  // orgId intentionally ABSENT
}

// ─── MobileScheduleResponse ────────────────────────────────────────────────────

/**
 * MobileScheduleResponse — the full response body for
 * GET /api/mobile/v1/schedule.
 *
 * `from` / `to` echo the validated window so the device can anchor its view
 * without parsing query params from the response.
 */
export interface MobileScheduleResponse {
  from: string;   // ISO-8601 (echoed from validated query param)
  to: string;     // ISO-8601 (echoed from validated query param)
  reservations: MobileReservationDTO[];
  resources: MobileResourceDTO[];
}

// ─── MobileApiError ────────────────────────────────────────────────────────────

/**
 * MobileApiError — discriminated union of all error bodies the mobile API
 * may return.
 *
 * The device should match on the `error` field to determine the recovery path:
 *   - 'unauthenticated' → clear secure-store and redirect to login.
 *   - 'forbidden'       → the user's role cannot access this resource.
 *   - 'invalid_window'  → the from/to query params are invalid or too large.
 *   - 'internal_error'  → server-side failure; retry or show generic error.
 */
export type MobileApiError =
  | { error: 'unauthenticated' }
  | { error: 'forbidden' }
  | { error: 'invalid_window' }
  | { error: 'not_found' }
  | { error: 'internal_error' };

// ─── Mapper functions (pure, unit-testable) ────────────────────────────────────

/**
 * ReservationRowLike — the fields of ReservationRow that the mapper reads.
 *
 * Declared inline so @aeroops/core does not depend on @aeroops/api.
 * The mapper only reads what it needs; extra fields on the row are ignored.
 */
interface ReservationRowLike {
  id: string;
  orgId: string;    // present on the row — but OMITTED from the DTO
  startAt: Date;
  endAt: Date;
  status: 'booked' | 'cancelled';
  notes: string | null;
  resourceIds: string[];
  seriesId: string | null;
}

/**
 * toMobileReservationDTO — maps a server-side ReservationRow to the wire DTO.
 *
 * PURE: no I/O. Date → ISO string via .toISOString().
 * SECURITY: orgId is intentionally NOT carried to the output.
 *
 * @param row - A ReservationRow (or compatible shape) from listReservations.
 * @returns   - A MobileReservationDTO safe to send to the device.
 */
export function toMobileReservationDTO(row: ReservationRowLike): MobileReservationDTO {
  return {
    id: row.id,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    status: row.status,
    notes: row.notes,
    resourceIds: row.resourceIds,
    seriesId: row.seriesId,
    // orgId is DELIBERATELY omitted
  };
}

/**
 * ResourceRowLike — the fields of ResourceRow that the mapper reads.
 *
 * Declared inline so @aeroops/core does not depend on @aeroops/api.
 */
interface ResourceRowLike {
  id: string;
  kind: string;
  displayName: string;
  tailNumber: string | null;
}

/**
 * toMobileResourceDTO — maps a server-side ResourceRow to the wire DTO.
 *
 * PURE: no I/O.
 * SECURITY: No org-identifying fields beyond id.
 *
 * @param row - A ResourceRow (or compatible shape) from listResources.
 * @returns   - A MobileResourceDTO safe to send to the device.
 */
export function toMobileResourceDTO(row: ResourceRowLike): MobileResourceDTO {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    tailNumber: row.tailNumber,
    // orgId is intentionally not on ResourceRow and not in the DTO
  };
}

// ─── MobileAircraftListDTO (fleet list) ───────────────────────────────────────

/**
 * MobileAircraftListDTO — wire-safe projection of one AircraftListRow.
 * Thin summary for the fleet list screen: tail, make/model, grounded, active.
 */
export interface MobileAircraftListDTO {
  id: string;
  tailNumber: string;
  make: string | null;
  model: string | null;
  grounded: boolean;
  active: boolean;
  // orgId intentionally ABSENT; groundingReason/squawk/work-order counts kept
  // off the list DTO by design (detail-only) — see MobileAircraftDetailDTO.
}

/** AircraftListRowLike — the fields toMobileAircraftListDTO reads. */
interface AircraftListRowLike {
  id: string;
  tailNumber: string;
  make: string | null;
  model: string | null;
  grounded: boolean;
  active: boolean;
}

/**
 * toMobileAircraftListDTO — maps a server-side AircraftListRow to the wire DTO.
 * PURE: no I/O.
 */
export function toMobileAircraftListDTO(row: AircraftListRowLike): MobileAircraftListDTO {
  return {
    id: row.id,
    tailNumber: row.tailNumber,
    make: row.make,
    model: row.model,
    grounded: row.grounded,
    active: row.active,
  };
}

// ─── MobileSquawkDTO ───────────────────────────────────────────────────────────

/**
 * MobileSquawkDTO — wire-safe projection of a squawk row, joined with the
 * aircraft's tail number (squawk rows only carry resourceId; the tail number
 * is resolved by the route handler via a second, capability-checked read of
 * the same aircraft set — see the /squawks and /fleet/[id] routes).
 */
export interface MobileSquawkDTO {
  id: string;
  resourceId: string;
  tailNumber: string;
  title: string;
  severity: string;
  status: string;
  reportedAt: string; // ISO-8601
}

/** SquawkRowLike — the fields toMobileSquawkDTO reads from a squawk row. */
interface SquawkRowLike {
  id: string;
  resourceId: string;
  title: string;
  severity: string;
  status: string;
  reportedAt: Date;
}

/**
 * toMobileSquawkDTO — maps a server-side SquawkView (+ resolved tailNumber)
 * to the wire DTO. PURE: no I/O. Date → ISO string.
 *
 * @param row        - A SquawkView (or compatible shape).
 * @param tailNumber - The tail number of row.resourceId, resolved by the caller
 *                     (fallback '' when the aircraft could not be resolved —
 *                     never throws, never blocks the squawk from rendering).
 */
export function toMobileSquawkDTO(row: SquawkRowLike, tailNumber: string): MobileSquawkDTO {
  return {
    id: row.id,
    resourceId: row.resourceId,
    tailNumber,
    title: row.title,
    severity: row.severity,
    status: row.status,
    reportedAt: row.reportedAt.toISOString(),
  };
}

// ─── MobileSquawksResponse ─────────────────────────────────────────────────────

export interface MobileSquawksResponse {
  squawks: MobileSquawkDTO[];
}

// ─── MobileUpcomingReservationDTO ──────────────────────────────────────────────

export interface MobileUpcomingReservationDTO {
  id: string;
  startAt: string; // ISO-8601
  endAt: string;   // ISO-8601
}

/** UpcomingReservationRowLike — fields read from UpcomingReservationRow. */
interface UpcomingReservationRowLike {
  id: string;
  startAt: Date;
  endAt: Date;
}

// ─── MobileAircraftDetailDTO (fleet detail) ────────────────────────────────────

/**
 * MobileAircraftDetailDTO — wire-safe projection of AircraftDetail.
 *
 * [VERIFY-5-A] currentHobbs/currentTach: "last recorded" reading only — NOT an
 * authoritative airframe total or maintenance value (mirrors the web fleet
 * detail page's disclaimer posture).
 * [VERIFY-5-B] grounding: operator data, NEVER "not airworthy" language.
 */
export interface MobileAircraftDetailDTO {
  id: string;
  tailNumber: string;
  displayName: string;
  make: string | null;
  model: string | null;
  active: boolean;
  hasHobbs: boolean;
  hasTach: boolean;

  grounded: boolean;
  groundingReason: string | null;
  groundingSince: string | null; // ISO-8601, null when not grounded

  openSquawkCount: number;
  recentSquawks: MobileSquawkDTO[]; // ≤10, newest-first

  currentHobbs: number | null;
  currentTach: number | null;
  currentMetersAsOf: string | null; // ISO-8601

  upcomingReservations: MobileUpcomingReservationDTO[]; // ≤10, ASC
}

/**
 * AircraftDetailLike — the fields toMobileAircraftDetailDTO reads from
 * AircraftDetail. Declared inline so @aeroops/core stays free of an
 * @aeroops/api dependency (mirrors ReservationRowLike / ResourceRowLike).
 */
interface AircraftDetailLike {
  id: string;
  tailNumber: string;
  displayName: string;
  make: string | null;
  model: string | null;
  active: boolean;
  hasHobbs: boolean;
  hasTach: boolean;
  grounding: {
    grounded: boolean;
    reason: string | null;
    since: Date | null;
  };
  openSquawkCount: number;
  recentSquawks: SquawkRowLike[];
  currentHobbs: number | null;
  currentTach: number | null;
  currentMetersAsOf: Date | null;
  upcomingReservations: UpcomingReservationRowLike[];
}

/**
 * toMobileAircraftDetailDTO — maps a server-side AircraftDetail to the wire DTO.
 * PURE: no I/O. Dates → ISO strings. Every squawk in recentSquawks is stamped
 * with the SAME tailNumber as the aircraft itself (a squawk always belongs to
 * the aircraft it was reported against — no cross-aircraft join needed here).
 */
export function toMobileAircraftDetailDTO(detail: AircraftDetailLike): MobileAircraftDetailDTO {
  return {
    id: detail.id,
    tailNumber: detail.tailNumber,
    displayName: detail.displayName,
    make: detail.make,
    model: detail.model,
    active: detail.active,
    hasHobbs: detail.hasHobbs,
    hasTach: detail.hasTach,

    grounded: detail.grounding.grounded,
    groundingReason: detail.grounding.reason,
    groundingSince: detail.grounding.since ? detail.grounding.since.toISOString() : null,

    openSquawkCount: detail.openSquawkCount,
    recentSquawks: detail.recentSquawks.map((s) => toMobileSquawkDTO(s, detail.tailNumber)),

    currentHobbs: detail.currentHobbs,
    currentTach: detail.currentTach,
    currentMetersAsOf: detail.currentMetersAsOf ? detail.currentMetersAsOf.toISOString() : null,

    upcomingReservations: detail.upcomingReservations.map((r) => ({
      id: r.id,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt.toISOString(),
    })),
  };
}

// ─── MobileFleetListResponse / MobileFleetDetailResponse ──────────────────────

export interface MobileFleetListResponse {
  aircraft: MobileAircraftListDTO[];
}

export type MobileFleetDetailResponse =
  | { ok: true; aircraft: MobileAircraftDetailDTO }
  | { ok: false; reason: 'not_found' };

// ─── MobileAlertDTO (alerts) ────────────────────────────────────────────────────

/**
 * MobileAlertDTO — wire-safe projection of a MyAlert (Slice N1.1).
 * Self-scoped server-side (session.userId only) — no row-identifying input.
 */
export interface MobileAlertDTO {
  id: string;
  kind: string;
  title: string;
  detail: string;
  path: string | null;
  at: string; // ISO-8601
}

/** MyAlertLike — the fields toMobileAlertDTO reads from a MyAlert. */
interface MyAlertLike {
  id: string;
  kind: string;
  title: string;
  detail: string;
  path: string | null;
  at: Date;
}

/**
 * toMobileAlertDTO — maps a server-side MyAlert to the wire DTO.
 * PURE: no I/O. Date → ISO string.
 */
export function toMobileAlertDTO(alert: MyAlertLike): MobileAlertDTO {
  return {
    id: alert.id,
    kind: alert.kind,
    title: alert.title,
    detail: alert.detail,
    path: alert.path,
    at: alert.at.toISOString(),
  };
}

export interface MobileAlertsResponse {
  alerts: MobileAlertDTO[];
  count: number;
}
