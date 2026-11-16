/**
 * reporting/get-cancellations-report.ts — getCancellationsReport (FC-parity
 * canned-report menu).
 *
 * Org-wide list of CANCELLED reservations over the report range, enriched
 * with the resource/tail label, who cancelled, the (optional) stated reason,
 * and a lead-time-before-start bucket. READ-ONLY over EXISTING tables
 * (reservation, reservation_resource, resource, app_user) — the only new
 * schema is reservation.cancellation_reason (migration 0042, additive).
 *
 * ── METRIC DEFINITIONS (pin here — two people must compute the same number) ──
 *
 * A cancelled reservation is one with status = 'cancelled' AND cancelled_at IN
 * [from, to) (half-open window, same rule as the R1 reports). Both cancel
 * paths (cancelReservation / cancelSeries) set cancelled_at, so this captures
 * single-cancel and series-cancel alike.
 *
 * leadTimeBucket (per row) = the gap between when the reservation was cancelled
 *   and when it was scheduled to START (start_at − cancelled_at):
 *     'lt24h' — under 24h of notice (INCLUDES cancellations made at/after the
 *               scheduled start, i.e. a non-positive gap).
 *     'd1_7'  — at least 24h and at most 7 days of notice.
 *     'gt7d'  — more than 7 days of notice.
 *   The bucket is pure arithmetic on the two timestamps; computed in JS so the
 *   boundaries are unit-testable without a DB.
 *
 * resourceLabel = the aircraft tail number(s) / resource display name(s) the
 *   reservation held, comma-joined ('—' when the reservation held no resource
 *   the caller can see). A reservation may hold several resources (aircraft +
 *   instructor), so this is an aggregate.
 *
 * AUTHZ: requireCapability('reporting:access') FIRST
 *   (owner/manager/dispatcher/cfi/accountant) — same audience as the other
 *   operational reports on the reports page.
 * TENANT ISOLATION: org_id from session only (withSessionOrgContextWithDb);
 *   reservation + reservation_resource + resource + app_user are RLS-scoped by
 *   the GUC — no org_id predicate needed (house convention).
 * READ-ONLY: zero writes, zero audit rows.
 *
 * [VERIFY-R1-TZ] No timeZone: rolling UTC window [now − Nd, now)
 *   (byte-identical). With the viewer's timeZone: that zone's last N calendar
 *   days from local midnight (reporting/zoned-window.ts); an unknown zone
 *   reads as UTC; range.timeZone echoes the zone used. Row timestamps stay
 *   instants; the display layer prints them in the viewer's zone.
 *
 * TWO CALLING FORMS:
 *   getCancellationsReport(session, input)                — app code.
 *   getCancellationsReportWithDb(db, session, input, opts) — tests
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
import { resolveReportRange } from './internal.js';
import type { ReportRangeKey } from './internal.js';
import { zonedReportWindow, reportRangeHeader } from './zoned-window.js';
import type { ReportRange } from './types.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const ReportRangeKeySchema = z.enum(['7d', '30d', '90d', '180d', '365d']).default('30d');
const InputSchema = z.object({
  range: ReportRangeKeySchema,
  timeZone: z.string().optional(),
});

export type GetCancellationsReportInput = {
  range?: ReportRangeKey | string;
  /**
   * The viewer's IANA zone. Given: that zone's last N calendar days, from
   * local midnight; an unknown zone reads as UTC. Omitted: rolling UTC window.
   */
  timeZone?: string;
};

// ─── Lead-time buckets ────────────────────────────────────────────────────────

export type CancellationLeadTimeBucket = 'lt24h' | 'd1_7' | 'gt7d';

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * MS_24H;

/**
 * leadTimeBucketFor — classify the notice given (start − cancelledAt) in ms.
 * Pure; exported for unit tests.
 *   leadMs <  24h  → 'lt24h' (includes non-positive: cancelled at/after start)
 *   leadMs <= 7d   → 'd1_7'
 *   leadMs >  7d   → 'gt7d'
 */
export function leadTimeBucketFor(leadMs: number): CancellationLeadTimeBucket {
  if (leadMs < MS_24H) return 'lt24h';
  if (leadMs <= MS_7D) return 'd1_7';
  return 'gt7d';
}

// ─── Output types ─────────────────────────────────────────────────────────────

export interface CancellationReportRow {
  reservationId: string;
  /** When the reservation was cancelled (UTC). */
  cancelledAt: Date;
  /** When the reservation was scheduled to start (UTC). */
  startAt: Date;
  /** Comma-joined tail number(s) / resource name(s); '—' when none visible. */
  resourceLabel: string;
  /** Display name / email of who cancelled; '—' when unattributed. */
  cancelledByName: string;
  /** The stated reason, or null when none was given. */
  reason: string | null;
  /** Notice given, bucketed (start − cancelledAt). */
  leadTimeBucket: CancellationLeadTimeBucket;
}

export interface CancellationsReportResult {
  range: ReportRange;
  rows: CancellationReportRow[];
  totalCount: number;
  lt24hCount: number;
  d1_7Count: number;
  gt7dCount: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetCancellationsReportInput,
  opts?: { now?: number },
): Promise<CancellationsReportResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'reporting:access');

  // 2. VALIDATE.
  const parsed = InputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[reporting] invalid getCancellationsReport input: ${first?.message ?? 'unknown'}`,
    );
  }
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve the window: rolling UTC, or the zone's last N calendar days.
  const now = new Date(opts?.now ?? Date.now());
  const reportWindow = zonedReportWindow(rangeKey, now, parsed.data.timeZone, resolveReportRange);
  const { from, to } = reportWindow;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // reservation (cancelled) LEFT JOIN who-cancelled + its resources.
    // RLS scopes every table to this org — no org_id predicate needed.
    // In raw sql`` templates from/to are bound as ISO strings + ::timestamptz
    // (the postgres-js production driver cannot serialize a JS Date).
    const result = await tx.execute(sql`
      SELECT
        r.id                  AS "reservationId",
        r.cancelled_at        AS "cancelledAt",
        r.start_at            AS "startAt",
        r.cancellation_reason AS "reason",
        COALESCE(u.full_name, u.email) AS "cancelledByName",
        COALESCE(
          string_agg(DISTINCT COALESCE(res.tail_number, res.display_name), ', '),
          ''
        )                     AS "resourceLabel"
      FROM reservation r
      LEFT JOIN app_user u ON u.id = r.cancelled_by
      LEFT JOIN reservation_resource rr ON rr.reservation_id = r.id
      LEFT JOIN resource res ON res.id = rr.resource_id
      WHERE r.status = 'cancelled'
        AND r.cancelled_at >= ${from.toISOString()}::timestamptz
        AND r.cancelled_at <  ${to.toISOString()}::timestamptz
      GROUP BY r.id, r.cancelled_at, r.start_at, r.cancellation_reason, u.full_name, u.email
      ORDER BY r.cancelled_at DESC
    `);

    const raw = extractRows<{
      reservationId: string;
      cancelledAt: Date | string;
      startAt: Date | string;
      reason: string | null;
      cancelledByName: string | null;
      resourceLabel: string | null;
    }>(result);

    let lt24hCount = 0;
    let d1_7Count = 0;
    let gt7dCount = 0;

    const rows: CancellationReportRow[] = raw.map((row) => {
      const cancelledAt =
        row.cancelledAt instanceof Date ? row.cancelledAt : new Date(row.cancelledAt);
      const startAt = row.startAt instanceof Date ? row.startAt : new Date(row.startAt);
      const bucket = leadTimeBucketFor(startAt.getTime() - cancelledAt.getTime());
      if (bucket === 'lt24h') lt24hCount++;
      else if (bucket === 'd1_7') d1_7Count++;
      else gt7dCount++;

      const label = row.resourceLabel && row.resourceLabel.length > 0 ? row.resourceLabel : '—';

      return {
        reservationId: row.reservationId,
        cancelledAt,
        startAt,
        resourceLabel: label,
        cancelledByName: row.cancelledByName ?? '—',
        reason: row.reason ?? null,
        leadTimeBucket: bucket,
      };
    });

    return {
      range: reportRangeHeader(rangeKey, reportWindow),
      rows,
      totalCount: rows.length,
      lt24hCount,
      d1_7Count,
      gt7dCount,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getCancellationsReport(
  session: AppSession | null | undefined,
  input: GetCancellationsReportInput = {},
): Promise<CancellationsReportResult> {
  const db = await getDb();
  return _impl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** Test form; `opts.now` pins the clock (epoch ms) for deterministic windows. */
export async function getCancellationsReportWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetCancellationsReportInput = {},
  opts?: { now?: number },
): Promise<CancellationsReportResult> {
  return _impl(db, session, input, opts);
}
