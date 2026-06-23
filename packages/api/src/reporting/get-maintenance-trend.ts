/**
 * reporting/get-maintenance-trend.ts — Maintenance activity counts (R1.1).
 *
 * METRIC DEFINITION (all are operator-state counts — NOT airworthiness/Part-43):
 *   squawksOpenedInRange:
 *     COUNT(*) FROM squawk WHERE reported_at >= from AND reported_at < to.
 *     Half-open; all statuses included (opened = when reported).
 *   squawksResolvedInRange:
 *     COUNT(*) FROM squawk WHERE status='resolved' AND resolved_at >= from AND resolved_at < to.
 *     Half-open.
 *   workOrdersOpenedInRange:
 *     COUNT(*) FROM work_order WHERE opened_at >= from AND opened_at < to.
 *     Half-open.
 *   workOrdersCompletedInRange:
 *     COUNT(*) FROM work_order WHERE status='completed' AND signed_off_at >= from AND signed_off_at < to.
 *     Half-open. signed_off_at is the completion timestamp (set by completeWorkOrder).
 *   openSquawkCount:
 *     COUNT(*) FROM squawk WHERE status='open'.
 *     Point-in-time snapshot.
 *   groundedAircraftCount:
 *     Point-in-time. Queries active aircraft IDs then loadGroundingProbe (same
 *     probe as openDispatch and the dashboard) — EXACT dashboard reuse pattern.
 *
 * [VERIFY-M1-A]: WO/squawk/grounded counts = OPERATOR DATA.
 *   completed ≠ RTS; sign-off = operator entry, not e-sig; unground = affirmative
 *   operator action, not computed clearance. NOT an airworthiness or Part-43
 *   determination. NOT an FAA AW release or return-to-service determination.
 *
 * AUTHZ: requireCapability('reporting:access') FIRST.
 * TENANT ISOLATION: org_id from session only; one withSessionOrgContextWithDb.
 * READ-ONLY: zero writes, zero audit.
 *
 * TWO CALLING FORMS:
 *   getMaintenanceTrend(session, input)          — app code.
 *   getMaintenanceTrendWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { resolveReportRange } from './internal.js';
import type { ReportRangeKey } from './internal.js';
import { loadGroundingProbe } from '../maintenance/internal.js';
import type { MaintenanceTrendResult } from './types.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const ReportRangeKeySchema = z.enum(['7d', '30d', '90d', '180d', '365d']).default('30d');
const InputSchema = z.object({ range: ReportRangeKeySchema });
export type GetMaintenanceTrendInput = { range?: ReportRangeKey | string };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetMaintenanceTrendInput,
): Promise<MaintenanceTrendResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'reporting:access');

  // 2. Validate range.
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve UTC window.
  const now = new Date();
  const { from, to } = resolveReportRange(rangeKey, now);

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Query 1: squawks opened in range (anchor: reported_at).
    const sqOpenedResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM squawk
      WHERE reported_at >= ${from}
        AND reported_at < ${to}
    `);
    const squawksOpenedInRange = Number(
      extractRows<{ count: number | string }>(sqOpenedResult)[0]?.count ?? 0,
    );

    // Query 2: squawks resolved in range (anchor: resolved_at; status='resolved').
    const sqResolvedResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM squawk
      WHERE status = 'resolved'
        AND resolved_at >= ${from}
        AND resolved_at < ${to}
    `);
    const squawksResolvedInRange = Number(
      extractRows<{ count: number | string }>(sqResolvedResult)[0]?.count ?? 0,
    );

    // Query 3: work orders opened in range (anchor: opened_at).
    const woOpenedResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM work_order
      WHERE opened_at >= ${from}
        AND opened_at < ${to}
    `);
    const workOrdersOpenedInRange = Number(
      extractRows<{ count: number | string }>(woOpenedResult)[0]?.count ?? 0,
    );

    // Query 4: work orders completed in range (anchor: signed_off_at; status='completed').
    const woCompletedResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM work_order
      WHERE status = 'completed'
        AND signed_off_at >= ${from}
        AND signed_off_at < ${to}
    `);
    const workOrdersCompletedInRange = Number(
      extractRows<{ count: number | string }>(woCompletedResult)[0]?.count ?? 0,
    );

    // Query 5: open squawk snapshot (point-in-time).
    const sqOpenCountResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM squawk
      WHERE status = 'open'
    `);
    const openSquawkCount = Number(
      extractRows<{ count: number | string }>(sqOpenCountResult)[0]?.count ?? 0,
    );

    // Query 6: grounded aircraft count via loadGroundingProbe (EXACT dashboard reuse).
    // Step 6a: get active aircraft ids (RLS-scoped to this org).
    const aircraftResult = await tx.execute(sql`
      SELECT id
      FROM resource
      WHERE kind = 'aircraft'
        AND active = true
    `);
    const aircraftRows = extractRows<{ id: string }>(aircraftResult);
    const activeAircraftIds = aircraftRows.map((r) => r.id);

    // Step 6b: probe grounding state for each id (same probe as openDispatch + dashboard).
    const groundingMap = await loadGroundingProbe(tx, activeAircraftIds);
    let groundedAircraftCount = 0;
    for (const entry of groundingMap.values()) {
      if (entry.grounded) groundedAircraftCount++;
    }

    return {
      range: { key: rangeKey, from, to },
      /**
       * squawksOpenedInRange — COUNT of squawk rows with reported_at in [from, to).
       * OPERATIONAL — NOT an airworthiness or Part-43 determination. [VERIFY-M1-A]
       */
      squawksOpenedInRange,
      /**
       * squawksResolvedInRange — COUNT of squawk rows with status='resolved' and
       * resolved_at in [from, to). OPERATIONAL — NOT an RTS clearance. [VERIFY-M1-A]
       */
      squawksResolvedInRange,
      /**
       * workOrdersOpenedInRange — COUNT of work_order rows with opened_at in [from, to).
       * OPERATIONAL — NOT an airworthiness or Part-43 determination. [VERIFY-M1-A]
       */
      workOrdersOpenedInRange,
      /**
       * workOrdersCompletedInRange — COUNT of work_order rows with status='completed'
       * and signed_off_at in [from, to). completed ≠ RTS. [VERIFY-M1-A]
       */
      workOrdersCompletedInRange,
      /**
       * openSquawkCount — point-in-time COUNT of squawk rows with status='open'.
       * OPERATIONAL — NOT an airworthiness status. [VERIFY-M1-A]
       */
      openSquawkCount,
      /**
       * groundedAircraftCount — point-in-time count of active aircraft currently grounded
       * per loadGroundingProbe (same probe as dashboard + openDispatch).
       * Grounding = OPERATOR DATA — NOT a computed Part-91/43 determination. [VERIFY-M1-A]
       */
      groundedAircraftCount,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getMaintenanceTrend(
  session: AppSession | null | undefined,
  rawInput: GetMaintenanceTrendInput = {},
): Promise<MaintenanceTrendResult> {
  const db = await getDb();
  return _impl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getMaintenanceTrendWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetMaintenanceTrendInput = {},
): Promise<MaintenanceTrendResult> {
  return _impl(db, session, rawInput);
}
