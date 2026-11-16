/**
 * notifications/internal.ts — tx-level helpers for the derived alerts surface.
 *
 * NOT exported from @aeroops/api. Contains:
 *   alertId(kind, parts)       — pure deterministic id generator (unit-tested).
 *   deriveMyAlerts(tx, userId, now, timeZone?) — ≤2-query derive inside an existing org context.
 *
 * INVARIANT: All helpers accept an AnyDb tx with the org GUC already set by the
 * caller's withSessionOrgContextWithDb. They NEVER set the org GUC themselves.
 *
 * SELF-SCOPING: userId is ALWAYS session.userId (the verified JWT subject).
 * It is NEVER a caller-supplied row id. Every query hardwires the predicate to
 * this userId — a user can only ever derive alerts from their OWN rows.
 *
 * READ-ONLY: zero writes, zero audit rows.
 *
 * COMPLIANCE: "is grounded" = operator data (ADR-0008). NOT an airworthiness
 * or Part-91/43 ruling. Copy says "is grounded — contact dispatch".
 *
 * [VERIFY-N1-A]: surfacing operator grounding data to an affected pilot
 * provisional — compliance to confirm.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { loadGroundingProbe } from '../maintenance/internal.js';
import { calendarDayInZone } from '../scheduling/internal.js';
import type { MyAlert } from './types.js';
import { extractRows } from '../db-rows.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of alerts returned (nearest in time kept). */
export const MAX_ALERTS = 20;

/** The lookahead window for reservation_upcoming alerts (ms). */
const UPCOMING_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── alertId ──────────────────────────────────────────────────────────────────

/**
 * alertId — pure deterministic alert id.
 *
 * Format: "{kind}:{parts[0]}:{parts[1]}:..."
 *   reservation_upcoming → alertId('reservation', [reservationId, 'upcoming'])
 *                        → "reservation:{reservationId}:upcoming"
 *   aircraft_grounded    → alertId('grounding', [resourceId, reservationId])
 *                        → "grounding:{resourceId}:{reservationId}"
 *
 * Parts must be non-empty strings. Returns a stable colon-joined string.
 */
export function alertId(kind: string, parts: string[]): string {
  return [kind, ...parts].join(':');
}

// ─── Raw reservation shape from query 1 ──────────────────────────────────────

interface UpcomingReservationRaw {
  reservationId: string;
  startAt: Date;
  /** DISTINCT resource UUIDs on this reservation */
  resourceIds: string[];
  /** Display label (tail number preferred, else resource id) */
  resourceLabels: string[];
}

// ─── deriveMyAlerts ───────────────────────────────────────────────────────────

/**
 * deriveMyAlerts — derive all in-app alerts for `userId` as of `now`.
 *
 * Algorithm (≤2 queries):
 *   1. My upcoming reservations — CLONE the portal readMyReservations self-scoped
 *      predicate EXACTLY (status='booked' AND lower(during)>NOW() AND
 *      (created_by=me OR non-voided dispatch_ticket.pilot_user_id=me OR
 *      member_user_id=me — booked FOR me, migration 0051),
 *      multi-resource collapse) + add raw resource_id UUIDs + tail label + start.
 *   2a. reservation_upcoming: reservations with start ≤ now+24h → one alert each.
 *   2b. aircraft_grounded: collect DISTINCT resource UUIDs across ALL upcoming
 *       reservations → loadGroundingProbe → for each grounded resource emit one
 *       alert per (reservation, grounded-resource).
 *   3. concat → sort at ASC → dedupe by id → cap MAX_ALERTS → count=length.
 *
 * Called inside an existing org context. NEVER sets org GUC.
 *
 * @param tx       - Active AnyDb tx with org GUC already set.
 * @param userId   - session.userId (SELF-SCOPED — never caller-supplied).
 * @param now      - Reference instant (injected for deterministic tests).
 * @param timeZone - IANA zone of the viewer: an "Upcoming flight" links to the
 *                   schedule for its start day in this zone (a 19:00 CST
 *                   flight is that day's, not the next UTC day's). Default
 *                   UTC; a zone this runtime does not know → UTC.
 * @returns        - Sorted, deduped, capped MyAlert[].
 */
export async function deriveMyAlerts(
  tx: AnyDb,
  userId: string,
  now: Date,
  timeZone: string = 'UTC',
): Promise<MyAlert[]> {
  // ── Query 1: my upcoming reservations (CLONE of portal predicate) ────────────
  //
  // Self-scoped: status='booked' AND lower(during)>NOW() AND
  // (created_by=me OR non-voided dispatch_ticket.pilot_user_id=me OR
  //  member_user_id=me). The last arm (migration 0051) is a booking club staff
  // made FOR me: its "Upcoming flight" (and grounded-aircraft) alert is mine.
  // Multi-resource: one row per (reservation, resource); we collapse below.
  // We add raw resource_id UUID (for grounding probe) AND the display label:
  // the tail #, else the resource's display name (an instructor), never the
  // id. Aircraft rows sort first, so a dual lesson's alert names the aircraft.
  // No LIMIT here — we need ALL upcoming reservations to probe grounding.
  const qResult = await tx.execute(sql`
    SELECT
      r.id                                                    AS "reservationId",
      lower(rr.during)                                        AS "startAt",
      rr.resource_id::text                                    AS "resourceId",
      COALESCE(res.tail_number, res.display_name, rr.resource_id::text) AS "resourceLabel"
    FROM reservation r
    JOIN reservation_resource rr ON rr.reservation_id = r.id
    LEFT JOIN resource res ON res.id = rr.resource_id
    LEFT JOIN dispatch_ticket dt ON dt.reservation_id = r.id
    WHERE r.status = 'booked'
      AND lower(rr.during) > NOW()
      AND (
        r.created_by = ${userId}::uuid
        OR EXISTS (
          SELECT 1 FROM dispatch_ticket dt2
          WHERE dt2.reservation_id = r.id
            AND dt2.pilot_user_id = ${userId}::uuid
            AND dt2.status <> 'voided'
        )
        OR r.member_user_id = ${userId}::uuid
      )
    ORDER BY lower(rr.during) ASC, (res.tail_number IS NULL) ASC, res.display_name ASC
  `);

  const qRows = extractRows<{
    reservationId: string;
    startAt: Date | string;
    resourceId: string;
    resourceLabel: string;
  }>(qResult);

  // Collapse multi-resource rows into per-reservation buckets.
  const byReservation = new Map<string, UpcomingReservationRaw>();
  for (const row of qRows) {
    const startAt = row.startAt instanceof Date ? row.startAt : new Date(row.startAt);
    const existing = byReservation.get(row.reservationId);
    if (existing) {
      if (!existing.resourceIds.includes(row.resourceId)) {
        existing.resourceIds.push(row.resourceId);
        existing.resourceLabels.push(row.resourceLabel);
      }
    } else {
      byReservation.set(row.reservationId, {
        reservationId: row.reservationId,
        startAt,
        resourceIds: [row.resourceId],
        resourceLabels: [row.resourceLabel],
      });
    }
  }

  const upcoming = [...byReservation.values()];
  const alerts: MyAlert[] = [];

  if (upcoming.length === 0) return alerts;

  // ── Step 2a: reservation_upcoming alerts (≤ now+24h) ─────────────────────────
  const cutoff = new Date(now.getTime() + UPCOMING_WINDOW_MS);
  for (const res of upcoming) {
    if (res.startAt <= cutoff) {
      const tailLabel = res.resourceLabels[0] ?? res.reservationId;
      // path → the schedule for the flight's start day in the viewer's zone
      // (slug-less; slug prepended by the UI). Not the UTC day: west of UTC an
      // evening flight's UTC day is the next one.
      const dateStr = calendarDayInZone(res.startAt, timeZone); // YYYY-MM-DD
      alerts.push({
        id: alertId('reservation', [res.reservationId, 'upcoming']),
        kind: 'reservation_upcoming',
        title: `Upcoming flight: ${tailLabel}`,
        detail: `Your upcoming reservation on ${tailLabel}.`,
        path: `/schedule?date=${dateStr}`,
        at: res.startAt,
      });
    }
  }

  // ── Step 2b: aircraft_grounded alerts (ALL upcoming reservations) ─────────────
  //
  // Collect DISTINCT resource UUIDs across ALL upcoming reservations (not just ≤24h),
  // then call loadGroundingProbe (one query) to get current grounding state.
  const allResourceIds = [...new Set(upcoming.flatMap((r) => r.resourceIds))];
  const groundingMap = await loadGroundingProbe(tx, allResourceIds);

  for (const res of upcoming) {
    for (let i = 0; i < res.resourceIds.length; i++) {
      const resourceId = res.resourceIds[i]!;
      const label = res.resourceLabels[i] ?? resourceId;
      const probe = groundingMap.get(resourceId);
      if (probe?.grounded) {
        const reason = probe.reason?.trim() ? probe.reason.trim() : 'No reason given';
        alerts.push({
          id: alertId('grounding', [resourceId, res.reservationId]),
          kind: 'aircraft_grounded',
          title: `${label} is grounded`,
          detail: `${reason} — contact dispatch`,
          path: null,
          at: res.startAt,
        });
      }
    }
  }

  // ── Step 3: sort at ASC → dedupe by id → cap MAX_ALERTS ──────────────────────
  alerts.sort((a, b) => a.at.getTime() - b.at.getTime());

  // Dedupe by id (stable: keep first occurrence after sort).
  const seen = new Set<string>();
  const deduped: MyAlert[] = [];
  for (const alert of alerts) {
    if (!seen.has(alert.id)) {
      seen.add(alert.id);
      deduped.push(alert);
    }
  }

  // Cap to MAX_ALERTS (nearest in time kept — already sorted ASC).
  return deduped.slice(0, MAX_ALERTS);
}
