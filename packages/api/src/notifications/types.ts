/**
 * notifications/types.ts — public result types for the in-app alerts surface
 * (Slice N1.1, READ-ONLY, derived-on-read).
 *
 * NO money, NO FAA determination, NO schema/migration.
 *
 * COMPLIANCE POSTURE:
 *   [VERIFY-N1-A]: surfacing operator grounding data to an affected pilot
 *   needs no extra retention/notice handling (provisional — compliance to confirm).
 *   "is grounded" = operator data (ADR-0008), NOT an airworthiness/Part-91/43 ruling.
 */

// ─── AlertKind ────────────────────────────────────────────────────────────────

/**
 * AlertKind — the two derived alert kinds in Slice N1.1.
 *   reservation_upcoming  — the pilot/booker has a reservation starting ≤ now+24h.
 *   aircraft_grounded     — an aircraft on one of their upcoming reservations is
 *                           grounded (operator data — contact dispatch).
 */
export type AlertKind = 'reservation_upcoming' | 'aircraft_grounded';

// ─── MyAlert ──────────────────────────────────────────────────────────────────

/**
 * MyAlert — a single derived in-app alert for the authenticated user.
 *
 * id          — stable deterministic id; format:
 *               reservation_upcoming → "reservation:{reservationId}:upcoming"
 *               aircraft_grounded    → "grounding:{resourceId}:{reservationId}"
 * kind        — discriminant for icon / styling in the UI.
 * title       — short display heading.
 * detail      — supporting copy (tail, time, reason, operator guidance).
 * path        — slug-LESS path for the related page (e.g. "/schedule?date=2026-11-10"),
 *               or null when there is no obvious deep-link.
 * at          — the reference Date for sort / display (reservation start time).
 */
export interface MyAlert {
  id: string;
  kind: AlertKind;
  title: string;
  detail: string;
  path: string | null;
  at: Date;
}

// ─── MyAlertsResult ───────────────────────────────────────────────────────────

/**
 * MyAlertsResult — the envelope returned by getMyAlerts / getMyAlertsWithDb.
 *
 * alerts  — sorted at ASC, deduped by id, capped at MAX_ALERTS=20.
 * count   — alerts.length (redundant convenience for the bell badge).
 */
export interface MyAlertsResult {
  alerts: MyAlert[];
  count: number;
}
