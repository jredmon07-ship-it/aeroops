/**
 * reporting/get-org-dashboard-metrics.ts — Org-level dashboard metrics (Slice 7.1).
 *
 * Returns a multi-metric snapshot for the authenticated org:
 *   - range-scoped: totalFlights, totalFlightHours, reservationsInRange
 *   - point-in-time snapshots: openSquawkCount, groundedAircraftCount,
 *     activeAircraftCount, activeMemberCount, openWorkOrderCount,
 *     activeEnrollmentCount
 *
 * AUTHZ: requireCapability('reporting:access') FIRST.
 * TENANT ISOLATION: org_id from session only; every query runs inside
 *   withSessionOrgContextWithDb (RLS GUC set on the tx).
 *
 * DESIGN:
 *   - One parameterised query per metric — independently org-auditable,
 *     no N+1 across orgs.
 *   - Zero aircraft / zero members / zero WOs / zero enrollments → 0
 *     (COALESCE), never null/NaN/throw.
 *   - Voided + open tickets excluded from flights/hours (status='closed' only).
 *   - Grounded count uses loadGroundingProbe (same probe as openDispatch) over
 *     the active aircraft ids returned by the activeAircraftCount query.
 *
 * [VERIFY-A] Hours shown are OPERATIONAL utilization derived from recorded
 *   Hobbs at check-in. They are NOT billable or logbook-authoritative figures.
 *
 * TWO CALLING FORMS:
 *   getOrgDashboardMetrics(session, opts)          — app code.
 *   getOrgDashboardMetricsWithDb(db, session, opts) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { loadGroundingProbe } from '../maintenance/internal.js';
import { resolveRange } from './internal.js';
import type { RangeKey } from './internal.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const RangeKeySchema = z.enum(['7d', '30d', '90d']).default('30d');

const GetOrgDashboardMetricsInputSchema = z.object({
  range: RangeKeySchema,
});

export type GetOrgDashboardMetricsInput = {
  range?: RangeKey | string;
};

// ─── Output types ─────────────────────────────────────────────────────────────

export interface OrgDashboardMetricsRange {
  key: RangeKey;
  from: Date;
  to: Date;
}

export interface OrgDashboardMetrics {
  range: OrgDashboardMetricsRange;
  /** Count of closed dispatch tickets in the range. */
  totalFlights: number;
  /** Sum of flight_time_hours for closed tickets in the range, rounded to 1dp. 0 when none. */
  totalFlightHours: number;
  /** Count of non-cancelled reservations overlapping [from, to) half-open window. */
  reservationsInRange: number;
  /** Point-in-time: count of squawks with status='open'. */
  openSquawkCount: number;
  /** Point-in-time: count of active aircraft currently grounded. */
  groundedAircraftCount: number;
  /** Point-in-time: count of resources with kind='aircraft' AND active=true. */
  activeAircraftCount: number;
  /** Point-in-time: count of app_user rows with status='active'. */
  activeMemberCount: number;
  /**
   * Point-in-time: count of work_order rows with status IN ('open','in_progress').
   * OPERATIONAL operator count — NOT an airworthiness or Part-43 determination.
   */
  openWorkOrderCount: number;
  /**
   * Point-in-time: count of enrollment rows with status='active'.
   * OPERATIONAL operator count — NOT a Part-141 or FAA training determination.
   * [VERIFY] Part-141 compliance reporting is deferred to Phase 3 Training.
   */
  activeEnrollmentCount: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getOrgDashboardMetricsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetOrgDashboardMetricsInput,
): Promise<OrgDashboardMetrics> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'reporting:access');

  // 2. Validate + parse range (bad value → ValidationError, not Zod default).
  const parsed = GetOrgDashboardMetricsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  }
  const rangeKey = parsed.data.range as RangeKey;

  // 3. Resolve the rolling UTC window.
  const now = new Date();
  const { from, to } = resolveRange(rangeKey, now);

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // ── Query 1: flights + hours from closed dispatch tickets in range ────────
    // Closed tickets only (status='closed'); voided/open excluded.
    // closed_at is the range anchor (half-open: >= from AND < to).
    const flightsResult = await tx.execute(sql`
      SELECT
        COUNT(*)::int                              AS "totalFlights",
        COALESCE(SUM(flight_time_hours::numeric), 0)::numeric AS "totalFlightHoursRaw"
      FROM dispatch_ticket
      WHERE status = 'closed'
        AND closed_at >= ${from}
        AND closed_at < ${to}
    `);

    const flightsRow = extractRows<{
      totalFlights: number | string;
      totalFlightHoursRaw: number | string;
    }>(flightsResult)[0];

    const totalFlights = Number(flightsRow?.totalFlights ?? 0);
    const totalFlightHoursRaw = Number(flightsRow?.totalFlightHoursRaw ?? 0);
    // Round to 1dp per spec (§2): 0 when none.
    const totalFlightHours = Math.round(totalFlightHoursRaw * 10) / 10;

    // ── Query 2: reservations overlapping [from, to) excl. cancelled ─────────
    // Half-open overlap: start_at < to AND end_at > from (same convention as
    // the conflict engine in ADR-0004 — half-open [)).
    const resvResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "reservationsInRange"
      FROM reservation
      WHERE status <> 'cancelled'
        AND start_at < ${to}
        AND end_at > ${from}
    `);

    const resvRow = extractRows<{
      reservationsInRange: number | string;
    }>(resvResult)[0];

    const reservationsInRange = Number(resvRow?.reservationsInRange ?? 0);

    // ── Query 3: open squawk count (point-in-time) ────────────────────────────
    const squawkResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "openSquawkCount"
      FROM squawk
      WHERE status = 'open'
    `);

    const squawkRow = extractRows<{
      openSquawkCount: number | string;
    }>(squawkResult)[0];

    const openSquawkCount = Number(squawkRow?.openSquawkCount ?? 0);

    // ── Query 4: active aircraft ids + count (point-in-time) ─────────────────
    const aircraftResult = await tx.execute(sql`
      SELECT id
      FROM resource
      WHERE kind = 'aircraft'
        AND active = true
    `);

    const aircraftRows = extractRows<{
      id: string;
    }>(aircraftResult);

    const activeAircraftCount = aircraftRows.length;
    const activeAircraftIds = aircraftRows.map((r) => r.id);

    // ── Query 5: grounded count via loadGroundingProbe (point-in-time) ────────
    // Reuses the same probe as openDispatch — consistent grounding state.
    const groundingMap = await loadGroundingProbe(tx, activeAircraftIds);
    let groundedAircraftCount = 0;
    for (const entry of groundingMap.values()) {
      if (entry.grounded) groundedAircraftCount++;
    }

    // ── Query 6: active member count (point-in-time) ─────────────────────────
    const memberResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "activeMemberCount"
      FROM app_user
      WHERE status = 'active'
    `);

    const memberRow = extractRows<{
      activeMemberCount: number | string;
    }>(memberResult)[0];

    const activeMemberCount = Number(memberRow?.activeMemberCount ?? 0);

    // ── Query 7: open work orders count (point-in-time) ──────────────────────
    // Counts work_order rows with status IN ('open','in_progress').
    // OPERATIONAL count — NOT an airworthiness/Part-43 determination.
    const workOrderResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "openWorkOrderCount"
      FROM work_order
      WHERE status IN ('open', 'in_progress')
    `);

    const workOrderRow = extractRows<{
      openWorkOrderCount: number | string;
    }>(workOrderResult)[0];

    const openWorkOrderCount = Number(workOrderRow?.openWorkOrderCount ?? 0);

    // ── Query 8: active enrollment count (point-in-time) ─────────────────────
    // Counts enrollment rows with status='active'.
    // OPERATIONAL count — NOT a Part-141 or FAA training determination.
    const enrollmentResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "activeEnrollmentCount"
      FROM enrollment
      WHERE status = 'active'
    `);

    const enrollmentRow = extractRows<{
      activeEnrollmentCount: number | string;
    }>(enrollmentResult)[0];

    const activeEnrollmentCount = Number(enrollmentRow?.activeEnrollmentCount ?? 0);

    return {
      range: { key: rangeKey, from, to },
      totalFlights,
      totalFlightHours,
      reservationsInRange,
      openSquawkCount,
      groundedAircraftCount,
      activeAircraftCount,
      activeMemberCount,
      openWorkOrderCount,
      activeEnrollmentCount,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * getOrgDashboardMetrics — fetches org-level reporting metrics.
 *
 * Uses the memoized production DB client (getDb()). apps/web never passes a db.
 *
 * @param session  - AppSession from auth(); throws UnauthenticatedError if null.
 * @param rawInput - { range?: '7d'|'30d'|'90d' } — defaults to '30d'.
 * @returns OrgDashboardMetrics
 * @throws UnauthenticatedError, ForbiddenError, ValidationError
 */
export async function getOrgDashboardMetrics(
  session: AppSession | null | undefined,
  rawInput: GetOrgDashboardMetricsInput = {},
): Promise<OrgDashboardMetrics> {
  const db = await getDb();
  return _getOrgDashboardMetricsImpl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/**
 * getOrgDashboardMetricsWithDb — same contract but accepts an explicit db.
 *
 * Tests MUST use this form so they never trigger getDb().
 */
export async function getOrgDashboardMetricsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetOrgDashboardMetricsInput = {},
): Promise<OrgDashboardMetrics> {
  return _getOrgDashboardMetricsImpl(db, session, rawInput);
}
