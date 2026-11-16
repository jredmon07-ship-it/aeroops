/**
 * reporting/get-aircraft-utilization.ts — Per-tail utilization for the range (Slice 7.1).
 *
 * Returns one row per ACTIVE aircraft. Aircraft with zero closed tickets in the
 * range appear with flightCount=0, flightHours=0 (LEFT JOIN, COALESCE).
 *
 * AUTHZ: requireCapability('reporting:access') FIRST.
 * TENANT ISOLATION:
 *   - resource rows are RLS-scoped to the session org by the GUC.
 *   - dispatch_ticket rows are RLS-scoped to the session org by the GUC.
 *   - The LEFT JOIN therefore sees ONLY tickets from the session org — a cross-org
 *     ticket is invisible to the RLS-scoped session; no d.org_id predicate needed.
 *   - This is the subtlest spot in the reporting module (§4, §2 spec).
 *
 * ONE QUERY: resource LEFT JOIN dispatch_ticket ON (resource_id, status='closed',
 *   closed_at in [from,to)) WHERE kind='aircraft' AND active GROUP BY id, tail_number
 *   ORDER BY hours DESC, tail ASC.
 *
 * [VERIFY-A] Hours are OPERATIONAL utilization (Hobbs-derived). NOT billable.
 *
 * [VERIFY-R1-TZ] No timeZone: the rolling UTC window [now − Nd, now)
 *   (resolveRange, byte-identical). With the viewer's timeZone: that zone's
 *   last N calendar days from local midnight, the same window as the
 *   dashboard's KPIs and activity chart (reporting/zoned-window.ts).
 *
 * TWO CALLING FORMS:
 *   getAircraftUtilization(session, input)                — app code.
 *   getAircraftUtilizationWithDb(db, session, input, opts) — tests
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
import { resolveRange } from './internal.js';
import type { RangeKey } from './internal.js';
import { zonedReportWindow } from './zoned-window.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const RangeKeySchema = z.enum(['7d', '30d', '90d']).default('30d');

const GetAircraftUtilizationInputSchema = z.object({
  range: RangeKeySchema,
  timeZone: z.string().optional(),
});

export type GetAircraftUtilizationInput = {
  range?: RangeKey | string;
  /**
   * The viewer's IANA zone. Given: that zone's last N calendar days, from
   * local midnight; an unknown zone reads as UTC. Omitted: rolling UTC window.
   */
  timeZone?: string;
};

// ─── Output types ─────────────────────────────────────────────────────────────

export interface AircraftUtilizationRow {
  resourceId: string;
  tailNumber: string;
  flightCount: number;
  /** Rounded to 1dp per spec. */
  flightHours: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getAircraftUtilizationImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetAircraftUtilizationInput,
  opts?: { now?: number },
): Promise<AircraftUtilizationRow[]> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'reporting:access');

  // 2. Validate + parse range.
  const parsed = GetAircraftUtilizationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  }
  const rangeKey = parsed.data.range as RangeKey;

  // 3. Resolve the window: rolling UTC, or the zone's last N calendar days.
  const now = new Date(opts?.now ?? Date.now());
  const { from, to } = zonedReportWindow(rangeKey, now, parsed.data.timeZone, resolveRange);
  // In raw sql`` templates, from/to are bound as ISO strings with an explicit
  // ::timestamptz cast: the postgres-js (production) driver cannot serialize a
  // JS Date passed to db.execute() (ERR_INVALID_ARG_TYPE at the wire encoder),
  // while PGlite (tests + local demo) can — so tests never catch a raw Date.

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // ONE query: resource LEFT JOIN dispatch_ticket.
    //
    // Tenant isolation:
    //   - `resource` is RLS-scoped to session.orgId by the GUC (FORCE RLS).
    //   - `dispatch_ticket` is also RLS-scoped to session.orgId by the GUC.
    //   - The ON clause joins on resource_id + the range filter; no cross-org
    //     ticket can appear because RLS filters dispatch_ticket to the current
    //     org before the join evaluates. No d.org_id predicate needed — RLS is
    //     the backstop (spec §2 subtlest spot, §4 invariant).
    //
    // ORDER: hours DESC, tail ASC (spec §2).
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
        resourceId: row.resourceId,
        tailNumber: row.tailNumber,
        flightCount: Number(row.flightCount ?? 0),
        flightHours: Math.round(flightHoursRaw * 10) / 10,
      };
    });
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * getAircraftUtilization — per-tail utilization for the authenticated org.
 *
 * Uses the memoized production DB client (getDb()). apps/web never passes a db.
 *
 * @param session  - AppSession from auth(); throws UnauthenticatedError if null.
 * @param rawInput - { range?: '7d'|'30d'|'90d', timeZone?: IANA zone } — range
 *                   defaults to '30d'; timeZone cuts the window in that zone.
 * @returns AircraftUtilizationRow[] ordered hours DESC, tail ASC.
 * @throws UnauthenticatedError, ForbiddenError, ValidationError
 */
export async function getAircraftUtilization(
  session: AppSession | null | undefined,
  rawInput: GetAircraftUtilizationInput = {},
): Promise<AircraftUtilizationRow[]> {
  const db = await getDb();
  return _getAircraftUtilizationImpl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/**
 * getAircraftUtilizationWithDb — same contract but accepts an explicit db.
 *
 * Tests MUST use this form so they never trigger getDb(). `opts.now` pins the
 * clock (epoch ms) for deterministic windows.
 */
export async function getAircraftUtilizationWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetAircraftUtilizationInput = {},
  opts?: { now?: number },
): Promise<AircraftUtilizationRow[]> {
  return _getAircraftUtilizationImpl(db, session, rawInput, opts);
}
