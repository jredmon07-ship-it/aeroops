/**
 * reporting/get-utilization-trend.ts — Utilization-over-time bucketed trend (R1.1).
 *
 * Returns flightCount + flightHours per bucket over the range's window.
 *
 * METRIC DEFINITION:
 *   Numerator:   COUNT / SUM of dispatch_ticket WHERE status='closed' AND
 *                closed_at >= from AND closed_at < to (half-open).
 *   Denominator: All closed tickets in [from, to).
 *   Granularity: day (7d/30d) or week (90d/180d/365d).
 *   Buckets:     the zero-fill list is built in memory (enumerateBuckets, or
 *                enumerateZonedBuckets with a timeZone) — every bucket appears
 *                even if empty; SQL puts each ticket in its bucket with
 *                width_bucket over those bucket starts.
 *   avgHoursPerFlight: safeAvg(totalFlightHours, totalFlights) — 0 when no flights.
 *
 * [VERIFY-R1-TZ] No timeZone: rolling UTC window [now − Nd, now), UTC days /
 *   UTC Monday weeks (the original output, byte-identical). With the viewer's
 *   timeZone: that zone's last N calendar days, local days / local Mondays;
 *   an unknown zone reads as UTC (reporting/zoned-window.ts).
 *
 * OPERATIONAL — NOT airworthiness. [VERIFY-A] Hours = Hobbs-derived.
 *
 * AUTHZ: requireCapability('reporting:access') FIRST.
 * TENANT ISOLATION: org_id from session only; single withSessionOrgContextWithDb.
 * READ-ONLY: zero writes, zero audit.
 *
 * TWO CALLING FORMS:
 *   getUtilizationTrend(session, input)                — app code.
 *   getUtilizationTrendWithDb(db, session, input, opts) — tests
 *     (`opts.now` pins the clock, epoch ms).
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { resolveReportRange, chooseGranularity, safeAvg } from './internal.js';
import type { ReportRangeKey, BucketGranularity } from './internal.js';
import {
  zonedReportWindow,
  reportRangeHeader,
  reportBucketStarts,
  timestamptzArrayLiteral,
} from './zoned-window.js';
import type { UtilizationTrendResult } from './types.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const ReportRangeKeySchema = z.enum(['7d', '30d', '90d', '180d', '365d']).default('30d');

const InputSchema = z.object({
  range: ReportRangeKeySchema,
  timeZone: z.string().optional(),
});

export type GetUtilizationTrendInput = {
  range?: ReportRangeKey | string;
  /**
   * The viewer's IANA zone. Given: that zone's last N calendar days, bucketed
   * by its local days/weeks; an unknown zone reads as UTC. Omitted: the
   * rolling UTC window and UTC buckets.
   */
  timeZone?: string;
};

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetUtilizationTrendInput,
  opts?: { now?: number },
): Promise<UtilizationTrendResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'reporting:access');

  // 2. Validate range (+ optional zone).
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve window + granularity + the zero-fill bucket starts.
  const now = new Date(opts?.now ?? Date.now());
  const reportWindow = zonedReportWindow(rangeKey, now, parsed.data.timeZone, resolveReportRange);
  const { from, to } = reportWindow;
  // In raw sql`` templates, from/to are bound as ISO strings with an explicit
  // ::timestamptz cast: the postgres-js (production) driver cannot serialize a
  // JS Date passed to db.execute() (ERR_INVALID_ARG_TYPE at the wire encoder),
  // while PGlite (tests + local demo) can — so tests never catch a raw Date.
  // The bucket starts go the same way, as one timestamptz[] literal.
  const granularity: BucketGranularity = chooseGranularity(rangeKey);
  const bucketStarts = reportBucketStarts(reportWindow, granularity);

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // ONE query: GROUP BY the ticket's bucket — width_bucket is the 1-based
    // index into bucketStarts (start[i] ≤ closed_at < start[i+1]).
    // status='closed' only; voided/open excluded.
    // Half-open: >= from AND < to.
    // RLS scopes dispatch_ticket to this org — no org_id predicate needed.
    const queryResult = await tx.execute(sql`
      SELECT
        width_bucket(closed_at, ${timestamptzArrayLiteral(bucketStarts)}::timestamptz[]) AS "bucket",
        COUNT(*)::int                                       AS "flightCount",
        COALESCE(SUM(flight_time_hours::numeric), 0)::numeric AS "flightHoursRaw"
      FROM dispatch_ticket
      WHERE status = 'closed'
        AND closed_at >= ${from.toISOString()}::timestamptz
        AND closed_at < ${to.toISOString()}::timestamptz
      GROUP BY 1
      ORDER BY 1
    `);

    const dbRows = extractRows<{
      bucket: number | string;
      flightCount: number | string;
      flightHoursRaw: number | string;
    }>(queryResult);

    // Map bucket index (1-based) → aggregates for O(1) merge.
    const dbMap = new Map<number, { flightCount: number; flightHoursRaw: number }>();
    for (const row of dbRows) {
      dbMap.set(Number(row.bucket), {
        flightCount:    Number(row.flightCount ?? 0),
        flightHoursRaw: Number(row.flightHoursRaw ?? 0),
      });
    }

    // Zero-fill: every bucket in [from, to) appears even if no DB row.
    let totalFlights      = 0;
    let totalFlightHoursRaw = 0;

    const buckets = bucketStarts.map((bs, i) => {
      const data = dbMap.get(i + 1) ?? { flightCount: 0, flightHoursRaw: 0 };
      const flightHours = Math.round(data.flightHoursRaw * 10) / 10;
      totalFlights       += data.flightCount;
      totalFlightHoursRaw += data.flightHoursRaw;
      return { bucketStart: bs, flightCount: data.flightCount, flightHours };
    });

    const totalFlightHours   = Math.round(totalFlightHoursRaw * 10) / 10;
    const avgHoursPerFlight  = safeAvg(totalFlightHours, totalFlights);

    return {
      range:             reportRangeHeader(rangeKey, reportWindow),
      granularity,
      buckets,
      totalFlights,
      totalFlightHours,
      avgHoursPerFlight,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getUtilizationTrend(
  session: AppSession | null | undefined,
  rawInput: GetUtilizationTrendInput = {},
): Promise<UtilizationTrendResult> {
  const db = await getDb();
  return _impl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** Test form; `opts.now` pins the clock (epoch ms) for deterministic windows. */
export async function getUtilizationTrendWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetUtilizationTrendInput = {},
  opts?: { now?: number },
): Promise<UtilizationTrendResult> {
  return _impl(db, session, rawInput, opts);
}
