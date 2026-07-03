/**
 * fleet/internal.ts — tx-level helpers for fleet reads.
 *
 * NOT exported from @aeroops/api. Holds focused query helpers that run
 * inside an existing org context (RLS-scoped by the caller).
 *
 * Helpers:
 *   loadUpcomingReservations — future booked reservations for one aircraft,
 *     joined via reservation_resource, ORDER BY start_at ASC LIMIT 10.
 *   loadRecentDispatch       — last-N dispatch tickets (incl. voided) for one
 *     aircraft, ORDER BY created_at DESC LIMIT N.
 *   loadCurrentMeters        — latest status='closed' ticket's hobbsIn/tachIn
 *     + closedAt (null if no closed ticket exists).
 *
 * Reuses loadGroundingProbe from maintenance/internal.ts.
 *
 * INVARIANT: All helpers accept an `AnyDb` tx with org GUC already set
 * by the caller's withSessionOrgContextWithDb. They NEVER set GUC themselves.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import type { UpcomingReservationRow, AircraftDetail } from './types.js';
import type { DispatchTicketView } from '../dispatch/types.js';
import { toDispatchTicketView } from '../dispatch/internal.js';
import { loadGroundingProbe, toSquawkView, toWorkOrderView } from '../maintenance/internal.js';
import { extractRows } from '../db-rows.js';

// ─── loadUpcomingReservations ─────────────────────────────────────────────────

/**
 * loadUpcomingReservations — return ≤10 future booked reservations for one aircraft.
 *
 * Joins reservation_resource (to scope to this aircraft) → reservation (for
 * status + window + seriesId). Filters: status='booked', lower(during) > NOW(),
 * resource_id = resourceId. Orders by start ascending. LIMIT 10.
 *
 * RLS-scoped by caller's GUC. Never sets org context itself.
 */
export async function loadUpcomingReservations(
  tx: AnyDb,
  resourceId: string,
): Promise<UpcomingReservationRow[]> {
  const result = await tx.execute(sql`
    SELECT
      r.id,
      lower(rr.during) AS "startAt",
      upper(rr.during) AS "endAt",
      r.series_id       AS "seriesId"
    FROM reservation_resource rr
    JOIN reservation r ON r.id = rr.reservation_id
    WHERE rr.resource_id = ${resourceId}::uuid
      AND r.status = 'booked'
      AND lower(rr.during) > NOW()
    ORDER BY lower(rr.during) ASC
    LIMIT 10
  `);

  const rows = extractRows<{
    id: string;
    startAt: Date | string;
    endAt: Date | string;
    seriesId: string | null;
  }>(result);

  return rows.map((row) => ({
    id: row.id,
    startAt: row.startAt instanceof Date ? row.startAt : new Date(row.startAt),
    endAt:   row.endAt   instanceof Date ? row.endAt   : new Date(row.endAt),
    seriesId: row.seriesId ?? null,
  }));
}

// ─── loadRecentDispatch ───────────────────────────────────────────────────────

/**
 * loadRecentDispatch — return ≤10 most-recent dispatch tickets for one aircraft,
 * including voided tickets (for audit history). Ordered newest-first.
 *
 * RLS-scoped by caller's GUC.
 */
export async function loadRecentDispatch(
  tx: AnyDb,
  resourceId: string,
  limit = 10,
): Promise<DispatchTicketView[]> {
  const result = await tx.execute(sql`
    SELECT
      id,
      org_id            AS "orgId",
      reservation_id    AS "reservationId",
      resource_id       AS "resourceId",
      pilot_user_id     AS "pilotUserId",
      status,
      hobbs_out         AS "hobbsOut",
      tach_out          AS "tachOut",
      hobbs_in          AS "hobbsIn",
      tach_in           AS "tachIn",
      flight_time_hours AS "flightTimeHours",
      notes,
      opened_by         AS "openedBy",
      opened_at         AS "openedAt",
      closed_by         AS "closedBy",
      closed_at         AS "closedAt",
      created_at        AS "createdAt",
      updated_at        AS "updatedAt"
    FROM dispatch_ticket
    WHERE resource_id = ${resourceId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);

  const rows = extractRows<{
    id: string;
    orgId: string;
    reservationId: string;
    resourceId: string;
    pilotUserId: string;
    status: string;
    hobbsOut: string | number;
    tachOut: string | number;
    hobbsIn: string | number | null;
    tachIn: string | number | null;
    flightTimeHours: string | number | null;
    notes: string | null;
    openedBy: string;
    openedAt: Date | string;
    closedBy: string | null;
    closedAt: Date | string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
  }>(result);

  return rows.map(toDispatchTicketView);
}

// ─── CurrentMeters ────────────────────────────────────────────────────────────

export interface CurrentMeters {
  currentHobbs: number | null;
  currentTach: number | null;
  currentMetersAsOf: Date | null;
}

/**
 * loadCurrentMeters — latest status='closed' dispatch ticket's hobbsIn/tachIn
 * + closedAt. Returns null for all fields if no closed ticket exists.
 *
 * [VERIFY-5-A] label as "last recorded" in the UI, not an authoritative total.
 */
export async function loadCurrentMeters(
  tx: AnyDb,
  resourceId: string,
): Promise<CurrentMeters> {
  const result = await tx.execute(sql`
    SELECT
      hobbs_in  AS "hobbsIn",
      tach_in   AS "tachIn",
      closed_at AS "closedAt"
    FROM dispatch_ticket
    WHERE resource_id = ${resourceId}::uuid
      AND status = 'closed'
    ORDER BY closed_at DESC
    LIMIT 1
  `);

  const rows = extractRows<{
    hobbsIn: string | number | null;
    tachIn: string | number | null;
    closedAt: Date | string | null;
  }>(result);

  const row = rows[0];
  if (!row || row.hobbsIn == null) {
    return { currentHobbs: null, currentTach: null, currentMetersAsOf: null };
  }

  const parseNum = (v: string | number | null): number | null => {
    if (v == null) return null;
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return isNaN(n) ? null : n;
  };

  const asOf = row.closedAt
    ? (row.closedAt instanceof Date ? row.closedAt : new Date(row.closedAt))
    : null;

  return {
    currentHobbs: parseNum(row.hobbsIn),
    currentTach: parseNum(row.tachIn),
    currentMetersAsOf: asOf,
  };
}

// ─── loadCurrentMetersBatch ───────────────────────────────────────────────────

/**
 * loadCurrentMetersBatch — batched form of loadCurrentMeters for MULTIPLE
 * resources in one query (Slice P1.5). Avoids an N+1 fetch-in-loop when a
 * caller (e.g. listMaintenanceDue) needs the last-recorded meters for many
 * aircraft at once.
 *
 * DISTINCT ON (resource_id) picks the latest status='closed' dispatch ticket
 * per aircraft — same "last recorded" semantics as loadCurrentMeters.
 * [VERIFY-5-A] label as "last recorded" in the UI, not an authoritative total.
 *
 * RLS-scoped by caller's GUC. Never sets org context itself.
 *
 * @param tx          - Active Drizzle tx with org GUC already set.
 * @param resourceIds - The aircraft resource IDs to probe (may be empty → empty Map).
 * @returns Map<resourceId, CurrentMeters> — every requested id keyed (absent
 *          ids get all-null, meaning no closed ticket exists yet).
 */
export async function loadCurrentMetersBatch(
  tx: AnyDb,
  resourceIds: string[],
): Promise<Map<string, CurrentMeters>> {
  const result = new Map<string, CurrentMeters>();
  for (const id of resourceIds) {
    result.set(id, { currentHobbs: null, currentTach: null, currentMetersAsOf: null });
  }

  if (resourceIds.length === 0) return result;

  const idList = sql.join(
    resourceIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const queryResult = await tx.execute(sql`
    SELECT DISTINCT ON (resource_id)
      resource_id AS "resourceId",
      hobbs_in    AS "hobbsIn",
      tach_in     AS "tachIn",
      closed_at   AS "closedAt"
    FROM dispatch_ticket
    WHERE resource_id = ANY(ARRAY[${idList}])
      AND status = 'closed'
    ORDER BY resource_id, closed_at DESC
  `);

  const rows = extractRows<{
    resourceId: string;
    hobbsIn: string | number | null;
    tachIn: string | number | null;
    closedAt: Date | string | null;
  }>(queryResult);

  const parseNum = (v: string | number | null): number | null => {
    if (v == null) return null;
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return isNaN(n) ? null : n;
  };

  for (const row of rows) {
    if (row.hobbsIn == null) continue; // shouldn't happen (hobbs_out/hobbs_in are write-once required on close), defensive
    const asOf = row.closedAt
      ? (row.closedAt instanceof Date ? row.closedAt : new Date(row.closedAt))
      : null;
    result.set(row.resourceId, {
      currentHobbs: parseNum(row.hobbsIn),
      currentTach: parseNum(row.tachIn),
      currentMetersAsOf: asOf,
    });
  }

  return result;
}

// ─── assembleAircraftDetail ───────────────────────────────────────────────────

/**
 * assembleAircraftDetail — full aircraft-detail aggregation inside an existing
 * org context (RLS-scoped by the caller's withSessionOrgContextWithDb).
 *
 * Returns null when the resourceId is not a visible aircraft (cross-org RLS
 * blocks it, or kind !== 'aircraft'). Callers map null → not_found.
 *
 * Runs ~5 queries: identity, grounding, open-squawk count, recent squawks ≤10,
 * recent dispatch ≤10, current meters, upcoming reservations ≤10.
 * NEVER sets org GUC itself.
 *
 * Used by getAircraftDetail (read path) and updateAircraft (post-write re-read)
 * so both paths share exactly the same query logic and can never diverge.
 */
export async function assembleAircraftDetail(
  tx: AnyDb,
  resourceId: string,
): Promise<AircraftDetail | null> {
  // Identity row (RLS-scoped; cross-org → 0 rows → null).
  const identityResult = await tx.execute(sql`
    SELECT
      r.id,
      r.tail_number           AS "tailNumber",
      r.display_name          AS "displayName",
      r.kind,
      r.make,
      r.model,
      r.year,
      r.serial_number         AS "serialNumber",
      r.active,
      r.has_hobbs             AS "hasHobbs",
      r.has_tach              AS "hasTach",
      r.home_base_location_id AS "homeBaseLocationId",
      l.name                  AS "homeBaseName",
      l.icao                  AS "homeBaseIcao"
    FROM resource r
    LEFT JOIN location l
      ON l.id = r.home_base_location_id
    WHERE r.id = ${resourceId}::uuid
    LIMIT 1
  `);

  const identityRows = extractRows<{
    id: string;
    tailNumber: string | null;
    displayName: string;
    kind: string;
    make: string | null;
    model: string | null;
    year: number | null;
    serialNumber: string | null;
    active: boolean;
    hasHobbs: boolean;
    hasTach: boolean;
    homeBaseLocationId: string | null;
    homeBaseName: string | null;
    homeBaseIcao: string | null;
  }>(identityResult);

  const identityRow = identityRows[0];

  // Return null when not visible (cross-org RLS blocks) or kind !== 'aircraft'.
  if (!identityRow || identityRow.kind !== 'aircraft') {
    return null;
  }

  // Grounding status.
  const groundingMap = await loadGroundingProbe(tx, [resourceId]);
  const groundingEntry = groundingMap.get(resourceId) ?? {
    grounded: false,
    reason: null,
    since: null,
    groundedBy: null,
    eventId: null,
    squawkId: null,
  };

  // Open-squawk count.
  const squawkCountResult = await tx.execute(sql`
    SELECT COUNT(*)::int AS "count"
    FROM squawk
    WHERE resource_id = ${resourceId}::uuid
      AND status = 'open'
  `);
  const squawkCountRows = extractRows<{
    count: number | string;
  }>(squawkCountResult);
  const openSquawkCount = squawkCountRows[0]
    ? (typeof squawkCountRows[0].count === 'string'
        ? parseInt(squawkCountRows[0].count, 10)
        : squawkCountRows[0].count)
    : 0;

  // Recent squawks ≤10 (newest-first).
  const squawkResult = await tx.execute(sql`
    SELECT
      id,
      resource_id        AS "resourceId",
      dispatch_ticket_id AS "dispatchTicketId",
      title,
      description,
      severity,
      status,
      reported_by        AS "reportedBy",
      reported_at        AS "reportedAt",
      resolution_notes   AS "resolutionNotes",
      resolved_by        AS "resolvedBy",
      resolved_at        AS "resolvedAt"
    FROM squawk
    WHERE resource_id = ${resourceId}::uuid
    ORDER BY reported_at DESC
    LIMIT 10
  `);
  const squawkRows = extractRows<{
    id: string;
    resourceId: string;
    dispatchTicketId: string | null;
    title: string;
    description: string | null;
    severity: string;
    status: string;
    reportedBy: string;
    reportedAt: Date | string;
    resolutionNotes: string | null;
    resolvedBy: string | null;
    resolvedAt: Date | string | null;
  }>(squawkResult);
  const recentSquawks = squawkRows.map(toSquawkView);

  // Recent dispatch ≤10 (incl. voided).
  const recentDispatch = await loadRecentDispatch(tx, resourceId, 10);

  // Current meters (latest closed ticket).
  const meters = await loadCurrentMeters(tx, resourceId);

  // Upcoming reservations ≤10.
  const upcomingReservations = await loadUpcomingReservations(tx, resourceId);

  // Open work orders ≤10 (status IN ('open','in_progress'), newest-first). [VERIFY-M1-E]
  // Gated by fleet:access (consistent with how squawks/grounding already surface here).
  const woResult = await tx.execute(sql`
    SELECT
      id,
      org_id            AS "orgId",
      resource_id       AS "resourceId",
      squawk_id         AS "squawkId",
      title,
      description,
      status,
      work_performed    AS "workPerformed",
      opened_by         AS "openedBy",
      opened_at         AS "openedAt",
      signed_off_by     AS "signedOffBy",
      signed_off_at     AS "signedOffAt",
      sign_off_notes    AS "signOffNotes",
      cancelled_reason  AS "cancelledReason",
      cancelled_at      AS "cancelledAt",
      created_at        AS "createdAt",
      updated_at        AS "updatedAt"
    FROM work_order
    WHERE resource_id = ${resourceId}::uuid
      AND status IN ('open', 'in_progress')
    ORDER BY created_at DESC
    LIMIT 10
  `);
  const woRows = extractRows<{
    id: string;
    orgId: string;
    resourceId: string;
    squawkId: string | null;
    title: string;
    description: string | null;
    status: string;
    workPerformed: string | null;
    openedBy: string;
    openedAt: Date | string;
    signedOffBy: string | null;
    signedOffAt: Date | string | null;
    signOffNotes: string | null;
    cancelledReason: string | null;
    cancelledAt: Date | string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
  }>(woResult);
  const openWorkOrders = woRows.map(toWorkOrderView);

  const homeBase = identityRow.homeBaseLocationId
    ? {
        id: identityRow.homeBaseLocationId,
        name: identityRow.homeBaseName ?? '',
        icao: identityRow.homeBaseIcao ?? null,
      }
    : null;

  return {
    id: identityRow.id,
    tailNumber: identityRow.tailNumber ?? '',
    displayName: identityRow.displayName,
    make: identityRow.make,
    model: identityRow.model,
    year: identityRow.year,
    serialNumber: identityRow.serialNumber,
    active: identityRow.active,
    hasHobbs: identityRow.hasHobbs,
    hasTach: identityRow.hasTach,
    homeBase,
    grounding: groundingEntry,
    openSquawkCount,
    recentSquawks,
    recentDispatch,
    currentHobbs: meters.currentHobbs,
    currentTach: meters.currentTach,
    currentMetersAsOf: meters.currentMetersAsOf,
    upcomingReservations,
    openWorkOrders,
    openWorkOrderCount: openWorkOrders.length,
  };
}
