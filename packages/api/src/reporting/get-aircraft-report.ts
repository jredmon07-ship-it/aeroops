/**
 * reporting/get-aircraft-report.ts — FC-parity per-tail "Aircraft report".
 *
 * One row per ACTIVE aircraft over the rolling range, with the columns from the
 * founder's Flight Schedule Pro screenshot:
 *   - flights      = closed dispatch tickets in the range
 *   - flightHours  = SUM of Hobbs-derived flight time over those tickets
 *   - oilAddedQuarts   = SUM of the EFFECTIVE (latest) service log's oil per ticket
 *   - fuelAddedGallons = SUM of the EFFECTIVE (latest) service log's fuel per ticket
 *
 * Aircraft with zero closed tickets in the range appear with all-zero metrics
 * (LEFT JOIN, COALESCE) — same shape as getHoursByTail.
 *
 * EFFECTIVE SERVICE (mirrors effective-meter derivation):
 *   For each ticket, the latest dispatch_service_log row (by created_at DESC)
 *   is the effective one — a re-entry is a new row and the latest wins. The
 *   LATERAL subquery selects that single row; SUM aggregates it per tail.
 *
 * TENANT ISOLATION (subtlest spot — identical posture to getHoursByTail):
 *   - resource, dispatch_ticket, and dispatch_service_log are ALL RLS-scoped to
 *     the session org by the GUC (FORCE RLS). A cross-org ticket or service row
 *     is invisible to the session; no explicit org_id predicate is needed.
 *   - T-ISO-AIRCRAFTREPORT in the test suite exercises this exact path.
 *
 * OPERATIONAL / LINE-OPS — NOT airworthiness. [VERIFY-A] Hours = Hobbs-derived.
 * Oil/fuel are operator line-ops uplift figures, NOT a maintenance record.
 *
 * AUTHZ: requireCapability('reporting:access') FIRST.
 * READ-ONLY: zero writes, zero audit.
 *
 * TWO CALLING FORMS:
 *   getAircraftReport(session, input)          — app code.
 *   getAircraftReportWithDb(db, session, input) — tests.
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
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const ReportRangeKeySchema = z.enum(['7d', '30d', '90d', '180d', '365d']).default('30d');
const InputSchema = z.object({ range: ReportRangeKeySchema });

export type GetAircraftReportInput = { range?: ReportRangeKey | string };

// ─── Output type ──────────────────────────────────────────────────────────────

export interface AircraftReportRow {
  resourceId: string;
  tailNumber: string;
  flightCount: number;
  /** Rounded to 1dp. */
  flightHours: number;
  /** Total oil added (quarts) across the range, latest-service-per-ticket. 1dp. */
  oilAddedQuarts: number;
  /** Total fuel added (gallons) across the range, latest-service-per-ticket. 1dp. */
  fuelAddedGallons: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetAircraftReportInput,
): Promise<AircraftReportRow[]> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'reporting:access');

  // 2. Validate range.
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve rolling UTC window.
  const now = new Date();
  const { from, to } = resolveReportRange(rangeKey, now);
  // ISO + ::timestamptz: postgres-js (production) cannot serialize a JS Date
  // passed to db.execute(); PGlite can. Always bind ISO strings with a cast.

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // resource LEFT JOIN dispatch_ticket (closed, in-range)
    //   LEFT JOIN LATERAL (latest service log for the ticket).
    //
    // Tenant isolation: resource / dispatch_ticket / dispatch_service_log are
    // ALL RLS-scoped to session.orgId by the GUC. No cross-org row can appear.
    //
    // ORDER: hours DESC, tail ASC (matches hours-by-tail).
    const queryResult = await tx.execute(sql`
      SELECT
        r.id                                                        AS "resourceId",
        r.tail_number                                               AS "tailNumber",
        COUNT(d.id)::int                                            AS "flightCount",
        COALESCE(SUM(d.flight_time_hours::numeric), 0)::numeric     AS "flightHoursRaw",
        COALESCE(SUM(svc.oil_added_quarts), 0)::numeric             AS "oilRaw",
        COALESCE(SUM(svc.fuel_added_gallons), 0)::numeric           AS "fuelRaw"
      FROM resource r
      LEFT JOIN dispatch_ticket d
        ON  d.resource_id = r.id
        AND d.status = 'closed'
        AND d.closed_at >= ${from.toISOString()}::timestamptz
        AND d.closed_at < ${to.toISOString()}::timestamptz
      LEFT JOIN LATERAL (
        SELECT s.oil_added_quarts, s.fuel_added_gallons
        FROM dispatch_service_log s
        WHERE s.dispatch_ticket_id = d.id
        ORDER BY s.created_at DESC
        LIMIT 1
      ) svc ON true
      WHERE r.kind = 'aircraft'
        AND r.active = true
      GROUP BY r.id, r.tail_number
      ORDER BY "flightHoursRaw" DESC, r.tail_number ASC
    `);

    const rows = extractRows<{
      resourceId: string;
      tailNumber: string;
      flightCount: number | string;
      flightHoursRaw: number | string;
      oilRaw: number | string;
      fuelRaw: number | string;
    }>(queryResult);

    return rows.map((row) => ({
      resourceId:       row.resourceId,
      tailNumber:       row.tailNumber,
      flightCount:      Number(row.flightCount ?? 0),
      flightHours:      Math.round(Number(row.flightHoursRaw ?? 0) * 10) / 10,
      oilAddedQuarts:   Math.round(Number(row.oilRaw ?? 0) * 10) / 10,
      fuelAddedGallons: Math.round(Number(row.fuelRaw ?? 0) * 10) / 10,
    }));
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getAircraftReport(
  session: AppSession | null | undefined,
  rawInput: GetAircraftReportInput = {},
): Promise<AircraftReportRow[]> {
  const db = await getDb();
  return _impl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getAircraftReportWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetAircraftReportInput = {},
): Promise<AircraftReportRow[]> {
  return _impl(db, session, rawInput);
}
