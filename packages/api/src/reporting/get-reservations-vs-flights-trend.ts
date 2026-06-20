/**
 * reporting/get-reservations-vs-flights-trend.ts — Reservations vs Flights trend (R1.1).
 *
 * Two series per UTC bucket:
 *   reservationsCreated — reservation.created_at bucketed (INCLUDES cancelled —
 *                          this is a creation-activity metric, not a confirmed count).
 *   flightsClosed       — dispatch_ticket WHERE status='closed' bucketed on closed_at.
 *
 * METRIC DEFINITION:
 *   reservationsCreated:
 *     Numerator: COUNT(*) FROM reservation WHERE created_at >= from AND created_at < to.
 *     Includes ALL statuses (active, cancelled, etc.) — creation activity signal.
 *     Anchor: reservation.created_at (half-open).
 *   flightsClosed:
 *     Numerator: COUNT(*) FROM dispatch_ticket WHERE status='closed'
 *                AND closed_at >= from AND closed_at < to.
 *     Voided/open excluded.
 *     Anchor: closed_at (half-open).
 *   Zero-fill: enumerateBuckets() in memory; both series share the same bucket list.
 *
 * OPERATIONAL LABEL: "Reservations created includes cancelled — creation activity, not
 * confirmed bookings." (comply per spec §3 label requirement.)
 *
 * AUTHZ: requireCapability('reporting:access') FIRST.
 * TENANT ISOLATION: org_id from session only; one withSessionOrgContextWithDb; 2 queries inside.
 * READ-ONLY: zero writes, zero audit.
 *
 * TWO CALLING FORMS:
 *   getReservationsVsFlightsTrend(session, input)          — app code.
 *   getReservationsVsFlightsTrendWithDb(db, session, input) — tests.
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
} from './internal.js';
import type { ReportRangeKey, BucketGranularity } from './internal.js';
import type { ReservationsVsFlightsTrendResult } from './types.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const ReportRangeKeySchema = z.enum(['7d', '30d', '90d', '180d', '365d']).default('30d');
const InputSchema = z.object({ range: ReportRangeKeySchema });
export type GetReservationsVsFlightsTrendInput = { range?: ReportRangeKey | string };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetReservationsVsFlightsTrendInput,
): Promise<ReservationsVsFlightsTrendResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'reporting:access');

  // 2. Validate range.
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve window + granularity.
  const now = new Date();
  const { from, to } = resolveReportRange(rangeKey, now);
  const granularity: BucketGranularity = chooseGranularity(rangeKey);
  const unit = granularity === 'day' ? 'day' : 'week';

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Query 1: reservations created in range (ALL statuses, incl. cancelled).
    // Anchor: reservation.created_at. Half-open [from, to).
    const resvResult = await tx.execute(sql`
      SELECT
        date_trunc(${unit}, created_at AT TIME ZONE 'UTC') AS "bucketStart",
        COUNT(*)::int AS "reservationsCreated"
      FROM reservation
      WHERE created_at >= ${from}
        AND created_at < ${to}
      GROUP BY 1
      ORDER BY 1
    `);

    const resvRows = (resvResult.rows ?? resvResult) as Array<{
      bucketStart: Date | string;
      reservationsCreated: number | string;
    }>;

    // Query 2: flights closed in range (status='closed').
    // Anchor: dispatch_ticket.closed_at. Half-open [from, to).
    const flightResult = await tx.execute(sql`
      SELECT
        date_trunc(${unit}, closed_at AT TIME ZONE 'UTC') AS "bucketStart",
        COUNT(*)::int AS "flightsClosed"
      FROM dispatch_ticket
      WHERE status = 'closed'
        AND closed_at >= ${from}
        AND closed_at < ${to}
      GROUP BY 1
      ORDER BY 1
    `);

    const flightRows = (flightResult.rows ?? flightResult) as Array<{
      bucketStart: Date | string;
      flightsClosed: number | string;
    }>;

    // Build lookup maps.
    const resvMap  = new Map<string, number>();
    const flightMap = new Map<string, number>();

    for (const row of resvRows) {
      const bs = bucketStartUtc(
        row.bucketStart instanceof Date ? row.bucketStart : new Date(row.bucketStart),
        granularity,
      );
      resvMap.set(bs.toISOString(), Number(row.reservationsCreated ?? 0));
    }
    for (const row of flightRows) {
      const bs = bucketStartUtc(
        row.bucketStart instanceof Date ? row.bucketStart : new Date(row.bucketStart),
        granularity,
      );
      flightMap.set(bs.toISOString(), Number(row.flightsClosed ?? 0));
    }

    // Zero-fill + merge.
    const allBuckets = enumerateBuckets(from, to, granularity);
    let totalReservationsCreated = 0;
    let totalFlightsClosed       = 0;

    const buckets = allBuckets.map((bs) => {
      const key                 = bs.toISOString();
      const reservationsCreated = resvMap.get(key)   ?? 0;
      const flightsClosed       = flightMap.get(key) ?? 0;
      totalReservationsCreated += reservationsCreated;
      totalFlightsClosed       += flightsClosed;
      return { bucketStart: bs, reservationsCreated, flightsClosed };
    });

    return {
      range:                    { key: rangeKey, from, to },
      granularity,
      buckets,
      totalReservationsCreated,
      totalFlightsClosed,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getReservationsVsFlightsTrend(
  session: AppSession | null | undefined,
  rawInput: GetReservationsVsFlightsTrendInput = {},
): Promise<ReservationsVsFlightsTrendResult> {
  const db = await getDb();
  return _impl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getReservationsVsFlightsTrendWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetReservationsVsFlightsTrendInput = {},
): Promise<ReservationsVsFlightsTrendResult> {
  return _impl(db, session, rawInput);
}
