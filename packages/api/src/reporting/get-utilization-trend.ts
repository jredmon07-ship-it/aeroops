/**
 * reporting/get-utilization-trend.ts — Utilization-over-time bucketed trend (R1.1).
 *
 * Returns flightCount + flightHours per UTC bucket over the rolling window.
 *
 * METRIC DEFINITION:
 *   Numerator:   COUNT / SUM of dispatch_ticket WHERE status='closed' AND
 *                closed_at >= from AND closed_at < to (half-open).
 *   Denominator: All closed tickets in [from, to).
 *   Granularity: day (7d/30d) or week (90d/180d/365d).
 *   Bucketing:   date_trunc AT TIME ZONE 'UTC' → matches bucketStartUtc().
 *   Zero-fill:   enumerateBuckets() in memory — every bucket appears even if empty.
 *   avgHoursPerFlight: safeAvg(totalFlightHours, totalFlights) — 0 when no flights.
 *
 * OPERATIONAL — NOT billing/airworthiness. [VERIFY-A] Hours = Hobbs-derived.
 *
 * AUTHZ: requireCapability('reporting:access') FIRST.
 * TENANT ISOLATION: org_id from session only; single withSessionOrgContextWithDb.
 * READ-ONLY: zero writes, zero audit.
 *
 * TWO CALLING FORMS:
 *   getUtilizationTrend(session, input)          — app code.
 *   getUtilizationTrendWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import {
  resolveReportRange,
  chooseGranularity,
  bucketStartUtc,
  enumerateBuckets,
  safeAvg,
} from './internal.js';
import type { ReportRangeKey, BucketGranularity } from './internal.js';
import type { UtilizationTrendResult } from './types.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const ReportRangeKeySchema = z.enum(['7d', '30d', '90d', '180d', '365d']).default('30d');

const InputSchema = z.object({ range: ReportRangeKeySchema });

export type GetUtilizationTrendInput = { range?: ReportRangeKey | string };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetUtilizationTrendInput,
): Promise<UtilizationTrendResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'reporting:access');

  // 2. Validate range.
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve window + granularity.
  const now = new Date();
  const { from, to } = resolveReportRange(rangeKey, now);
  // In raw sql`` templates, from/to are bound as ISO strings with an explicit
  // ::timestamptz cast: the postgres-js (production) driver cannot serialize a
  // JS Date passed to db.execute() (ERR_INVALID_ARG_TYPE at the wire encoder),
  // while PGlite (tests + local demo) can — so tests never catch a raw Date.
  const granularity: BucketGranularity = chooseGranularity(rangeKey);
  const unit = granularity === 'day' ? 'day' : 'week';

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // ONE query: GROUP BY UTC-truncated closed_at.
    // status='closed' only; voided/open excluded.
    // Half-open: >= from AND < to.
    // RLS scopes dispatch_ticket to this org — no org_id predicate needed.
    const queryResult = await tx.execute(sql`
      SELECT
        date_trunc(${unit}, closed_at AT TIME ZONE 'UTC') AS "bucketStart",
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
      bucketStart: Date | string;
      flightCount: number | string;
      flightHoursRaw: number | string;
    }>(queryResult);

    // Build a map from bucket ISO string → aggregates for O(1) merge.
    const dbMap = new Map<string, { flightCount: number; flightHoursRaw: number }>();
    for (const row of dbRows) {
      const bs = bucketStartUtc(
        row.bucketStart instanceof Date ? row.bucketStart : new Date(row.bucketStart),
        granularity,
      );
      dbMap.set(bs.toISOString(), {
        flightCount:    Number(row.flightCount ?? 0),
        flightHoursRaw: Number(row.flightHoursRaw ?? 0),
      });
    }

    // Zero-fill: every bucket in [from, to) appears even if no DB row.
    const allBuckets = enumerateBuckets(from, to, granularity);
    let totalFlights      = 0;
    let totalFlightHoursRaw = 0;

    const buckets = allBuckets.map((bs) => {
      const key  = bs.toISOString();
      const data = dbMap.get(key) ?? { flightCount: 0, flightHoursRaw: 0 };
      const flightHours = Math.round(data.flightHoursRaw * 10) / 10;
      totalFlights       += data.flightCount;
      totalFlightHoursRaw += data.flightHoursRaw;
      return { bucketStart: bs, flightCount: data.flightCount, flightHours };
    });

    const totalFlightHours   = Math.round(totalFlightHoursRaw * 10) / 10;
    const avgHoursPerFlight  = safeAvg(totalFlightHours, totalFlights);

    return {
      range:             { key: rangeKey, from, to },
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

export async function getUtilizationTrendWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetUtilizationTrendInput = {},
): Promise<UtilizationTrendResult> {
  return _impl(db, session, rawInput);
}
