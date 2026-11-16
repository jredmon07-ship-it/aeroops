/**
 * reporting/get-reservations-vs-flights-trend.ts — Reservations vs Flights trend (R1.1).
 *
 * Two series per bucket (UTC by default; the viewer's zone with `timeZone`):
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
 *   Buckets: the zero-fill list is built in memory (enumerateBuckets, or
 *     enumerateZonedBuckets with a timeZone); both series share it. SQL puts
 *     each row in its bucket with width_bucket over those bucket starts, so a
 *     row counts on the day its own instant falls on in the window's zone.
 *
 * [VERIFY-R1-TZ] No timeZone: rolling UTC window [now − Nd, now), UTC days /
 *   UTC Monday weeks (the original output, byte-identical). With the viewer's
 *   timeZone: that zone's last N calendar days, local days / local Mondays,
 *   DST days 23 or 25 hours long; an unknown zone reads as UTC
 *   (reporting/zoned-window.ts).
 *
 * OPERATIONAL LABEL: "Reservations created includes cancelled — creation activity, not
 * confirmed bookings." (comply per spec §3 label requirement.)
 *
 * AUTHZ: requireCapability('reporting:access') FIRST.
 * TENANT ISOLATION: org_id from session only; one withSessionOrgContextWithDb; 2 queries inside.
 * READ-ONLY: zero writes, zero audit.
 *
 * TWO CALLING FORMS:
 *   getReservationsVsFlightsTrend(session, input)                — app code.
 *   getReservationsVsFlightsTrendWithDb(db, session, input, opts) — tests
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
import { resolveReportRange, chooseGranularity } from './internal.js';
import type { ReportRangeKey, BucketGranularity } from './internal.js';
import {
  zonedReportWindow,
  reportRangeHeader,
  reportBucketStarts,
  timestamptzArrayLiteral,
} from './zoned-window.js';
import type { ReservationsVsFlightsTrendResult } from './types.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const ReportRangeKeySchema = z.enum(['7d', '30d', '90d', '180d', '365d']).default('30d');
const InputSchema = z.object({
  range: ReportRangeKeySchema,
  timeZone: z.string().optional(),
});
export type GetReservationsVsFlightsTrendInput = {
  range?: ReportRangeKey | string;
  /**
   * The viewer's IANA zone (e.g. 'America/Chicago'). Given: the window is that
   * zone's last N calendar days and the buckets are its local days/weeks; an
   * unknown zone reads as UTC. Omitted: the rolling UTC window and UTC buckets.
   */
  timeZone?: string;
};

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetReservationsVsFlightsTrendInput,
  opts?: { now?: number },
): Promise<ReservationsVsFlightsTrendResult> {
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
  const thresholds = timestamptzArrayLiteral(bucketStarts);

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Query 1: reservations created in range (ALL statuses, incl. cancelled).
    // Anchor: reservation.created_at. Half-open [from, to). "bucket" is the
    // 1-based index into bucketStarts (width_bucket: start[i] ≤ ts < start[i+1]).
    const resvResult = await tx.execute(sql`
      SELECT
        width_bucket(created_at, ${thresholds}::timestamptz[]) AS "bucket",
        COUNT(*)::int AS "reservationsCreated"
      FROM reservation
      WHERE created_at >= ${from.toISOString()}::timestamptz
        AND created_at < ${to.toISOString()}::timestamptz
      GROUP BY 1
      ORDER BY 1
    `);

    const resvRows = extractRows<{
      bucket: number | string;
      reservationsCreated: number | string;
    }>(resvResult);

    // Query 2: flights closed in range (status='closed').
    // Anchor: dispatch_ticket.closed_at. Half-open [from, to).
    const flightResult = await tx.execute(sql`
      SELECT
        width_bucket(closed_at, ${thresholds}::timestamptz[]) AS "bucket",
        COUNT(*)::int AS "flightsClosed"
      FROM dispatch_ticket
      WHERE status = 'closed'
        AND closed_at >= ${from.toISOString()}::timestamptz
        AND closed_at < ${to.toISOString()}::timestamptz
      GROUP BY 1
      ORDER BY 1
    `);

    const flightRows = extractRows<{
      bucket: number | string;
      flightsClosed: number | string;
    }>(flightResult);

    // Lookup maps: bucket index (1-based) → count.
    const resvMap   = new Map<number, number>();
    const flightMap = new Map<number, number>();
    for (const row of resvRows) {
      resvMap.set(Number(row.bucket), Number(row.reservationsCreated ?? 0));
    }
    for (const row of flightRows) {
      flightMap.set(Number(row.bucket), Number(row.flightsClosed ?? 0));
    }

    // Zero-fill + merge.
    let totalReservationsCreated = 0;
    let totalFlightsClosed       = 0;

    const buckets = bucketStarts.map((bs, i) => {
      const reservationsCreated = resvMap.get(i + 1)   ?? 0;
      const flightsClosed       = flightMap.get(i + 1) ?? 0;
      totalReservationsCreated += reservationsCreated;
      totalFlightsClosed       += flightsClosed;
      return { bucketStart: bs, reservationsCreated, flightsClosed };
    });

    return {
      range:                    reportRangeHeader(rangeKey, reportWindow),
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

/** Test form; `opts.now` pins the clock (epoch ms) for deterministic windows. */
export async function getReservationsVsFlightsTrendWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetReservationsVsFlightsTrendInput = {},
  opts?: { now?: number },
): Promise<ReservationsVsFlightsTrendResult> {
  return _impl(db, session, rawInput, opts);
}
