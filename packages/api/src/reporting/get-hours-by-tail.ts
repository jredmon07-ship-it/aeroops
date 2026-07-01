/**
 * reporting/get-hours-by-tail.ts — Per-tail utilization with widened range (R1.1).
 *
 * Returns one row per ACTIVE aircraft. Aircraft with zero closed tickets in the
 * range appear with flightCount=0, flightHours=0 (LEFT JOIN, COALESCE).
 *
 * IDENTICAL QUERY + ISOLATION to the FROZEN getAircraftUtilization (Slice 7.1),
 * but accepts the widened ReportRangeKey ('7d'|'30d'|'90d'|'180d'|'365d').
 * The FROZEN getAircraftUtilization is NOT modified.
 *
 * TENANT ISOLATION (subtlest spot — identical to getAircraftUtilization §2):
 *   - resource rows are RLS-scoped to the session org by the GUC.
 *   - dispatch_ticket rows are RLS-scoped to the session org by the GUC.
 *   - The LEFT JOIN therefore sees ONLY tickets from the session org — a cross-org
 *     ticket is invisible to the RLS-scoped session; no d.org_id predicate needed.
 *   - T-ISO-HOURSBYTAIL in the R1.1 test suite exercises this exact path.
 *
 * OPERATIONAL — NOT billing/airworthiness. [VERIFY-A] Hours = Hobbs-derived.
 *
 * AUTHZ: requireCapability('reporting:access') FIRST.
 * READ-ONLY: zero writes, zero audit.
 * Reuses AircraftUtilizationRow shape (from get-aircraft-utilization.ts).
 *
 * TWO CALLING FORMS:
 *   getHoursByTail(session, input)          — app code.
 *   getHoursByTailWithDb(db, session, input) — tests.
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
import type { AircraftUtilizationRow } from './get-aircraft-utilization.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const ReportRangeKeySchema = z.enum(['7d', '30d', '90d', '180d', '365d']).default('30d');

const InputSchema = z.object({ range: ReportRangeKeySchema });

export type GetHoursByTailInput = { range?: ReportRangeKey | string };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetHoursByTailInput,
): Promise<AircraftUtilizationRow[]> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'reporting:access');

  // 2. Validate range.
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve rolling UTC window.
  const now = new Date();
  const { from, to } = resolveReportRange(rangeKey, now);
  // In raw sql`` templates, from/to are bound as ISO strings with an explicit
  // ::timestamptz cast: the postgres-js (production) driver cannot serialize a
  // JS Date passed to db.execute() (ERR_INVALID_ARG_TYPE at the wire encoder),
  // while PGlite (tests + local demo) can — so tests never catch a raw Date.

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // ONE query: resource LEFT JOIN dispatch_ticket.
    //
    // Tenant isolation (identical to FROZEN getAircraftUtilization — the subtlest
    // T-ISO spot in reporting):
    //   - `resource` is RLS-scoped to session.orgId by the GUC (FORCE RLS).
    //   - `dispatch_ticket` is also RLS-scoped to session.orgId by the GUC.
    //   - The ON clause joins on resource_id + range filter; no cross-org ticket
    //     can appear because RLS filters dispatch_ticket to the current org before
    //     the join evaluates. No d.org_id predicate needed — RLS is the backstop.
    //
    // ORDER: hours DESC, tail ASC (spec R1.1 §2).
    const queryResult = await tx.execute(sql`
      SELECT
        r.id                                                           AS "resourceId",
        r.tail_number                                                  AS "tailNumber",
        COUNT(d.id)::int                                               AS "flightCount",
        COALESCE(SUM(d.flight_time_hours::numeric), 0)::numeric        AS "flightHoursRaw"
      FROM resource r
      LEFT JOIN dispatch_ticket d
        ON  d.resource_id = r.id
        AND d.status = 'closed'
        AND d.closed_at >= ${from.toISOString()}::timestamptz
        AND d.closed_at < ${to.toISOString()}::timestamptz
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
    }>(queryResult);

    return rows.map((row) => {
      const flightHoursRaw = Number(row.flightHoursRaw ?? 0);
      return {
        resourceId:  row.resourceId,
        tailNumber:  row.tailNumber,
        flightCount: Number(row.flightCount ?? 0),
        flightHours: Math.round(flightHoursRaw * 10) / 10,
      };
    });
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getHoursByTail(
  session: AppSession | null | undefined,
  rawInput: GetHoursByTailInput = {},
): Promise<AircraftUtilizationRow[]> {
  const db = await getDb();
  return _impl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getHoursByTailWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetHoursByTailInput = {},
): Promise<AircraftUtilizationRow[]> {
  return _impl(db, session, rawInput);
}
