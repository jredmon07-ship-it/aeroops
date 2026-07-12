/**
 * reporting/get-instructor-utilization.ts — Per-CFI utilization for the range.
 *
 * Structural mirror of get-aircraft-utilization.ts (one row per relevant
 * entity, LEFT JOINs so a zero-activity CFI still appears with 0s), but
 * accepts the widened ReportRangeKey ('7d'|'30d'|'90d'|'180d'|'365d') so it can
 * sit on the same Operational Reports page as get-hours-by-tail.
 *
 * Returns one row per member whose membership role is 'cfi'. For each, over the
 * rolling UTC window [now - Nd, now):
 *   - flightCount / flightHours — CLOSED dispatch tickets where the CFI is the
 *     recorded pilot (dispatch_ticket.pilot_user_id), bucketed by closed_at.
 *   - lessonsGiven — 'recorded' lesson_record rows where the CFI is the
 *     instructor_user_id, bucketed by completed_at (voided rows excluded).
 *   - distinctStudents — DISTINCT enrollment.student_user_id across those
 *     lesson records (how many different students the CFI taught in the window).
 *
 * AUTHZ: requireCapability('reporting:access') FIRST.
 * TENANT ISOLATION:
 *   - membership / app_user / dispatch_ticket / lesson_record / enrollment are
 *     ALL RLS-scoped to the session org by the GUC (FORCE RLS). The LEFT JOIN
 *     subqueries therefore see ONLY this org's rows — no explicit org_id
 *     predicate is needed (house convention, mirrors get-aircraft-utilization
 *     §2 subtlest spot). A cross-org CFI/flight/lesson is invisible.
 *
 * [VERIFY-A]  Flight hours are OPERATIONAL utilization (Hobbs-derived), NOT
 *   billable or airworthiness time. lessonsGiven / distinctStudents are
 *   operator DATA-ENTRY counts, NOT a Part-141/61 or FAA determination.
 *
 * TWO CALLING FORMS:
 *   getInstructorUtilization(session, opts)          — app code.
 *   getInstructorUtilizationWithDb(db, session, opts) — tests.
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

const GetInstructorUtilizationInputSchema = z.object({
  range: ReportRangeKeySchema,
});

export type GetInstructorUtilizationInput = {
  range?: ReportRangeKey | string;
};

// ─── Output types ─────────────────────────────────────────────────────────────

export interface InstructorUtilizationRow {
  instructorUserId: string;
  instructorName: string;
  /** CLOSED dispatch tickets flown by this CFI as pilot, in range. */
  flightCount: number;
  /** Rounded to 1dp. Hobbs-derived operational hours as pilot, in range. */
  flightHours: number;
  /** 'recorded' lesson records given by this CFI as instructor, in range. */
  lessonsGiven: number;
  /** DISTINCT students taught (via those lesson records' enrollments), in range. */
  distinctStudents: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getInstructorUtilizationImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetInstructorUtilizationInput,
): Promise<InstructorUtilizationRow[]> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'reporting:access');

  // 2. Validate + parse range.
  const parsed = GetInstructorUtilizationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  }
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve rolling UTC window.
  const now = new Date();
  const { from, to } = resolveReportRange(rangeKey, now);
  // In raw sql`` templates, from/to are bound as ISO strings with an explicit
  // ::timestamptz cast: the postgres-js (production) driver cannot serialize a
  // JS Date passed to db.execute() (ERR_INVALID_ARG_TYPE at the wire encoder),
  // while PGlite (tests + local demo) can — so tests never catch a raw Date.

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // ONE query: membership (role='cfi') → app_user, LEFT JOIN two pre-aggregated
    // subqueries (dispatch-as-pilot, lessons-given). RLS scopes every table to
    // this org, so no org_id predicate is needed anywhere below.
    //
    // ORDER: flight hours DESC, lessons DESC, name ASC (busiest CFI first).
    const queryResult = await tx.execute(sql`
      SELECT
        u.id                                                    AS "instructorUserId",
        COALESCE(u.full_name, u.email)                          AS "instructorName",
        COALESCE(d."flightCount", 0)::int                       AS "flightCount",
        COALESCE(d."flightHoursRaw", 0)::numeric                AS "flightHoursRaw",
        COALESCE(l."lessonsGiven", 0)::int                      AS "lessonsGiven",
        COALESCE(l."distinctStudents", 0)::int                  AS "distinctStudents"
      FROM membership m
      JOIN app_user u ON u.id = m.user_id
      LEFT JOIN (
        SELECT
          dt.pilot_user_id                                      AS pilot_user_id,
          COUNT(dt.id)                                          AS "flightCount",
          SUM(dt.flight_time_hours::numeric)                    AS "flightHoursRaw"
        FROM dispatch_ticket dt
        WHERE dt.status = 'closed'
          AND dt.closed_at >= ${from.toISOString()}::timestamptz
          AND dt.closed_at <  ${to.toISOString()}::timestamptz
        GROUP BY dt.pilot_user_id
      ) d ON d.pilot_user_id = u.id
      LEFT JOIN (
        SELECT
          lr.instructor_user_id                                AS instructor_user_id,
          COUNT(lr.id)                                          AS "lessonsGiven",
          COUNT(DISTINCT e.student_user_id)                    AS "distinctStudents"
        FROM lesson_record lr
        JOIN enrollment e ON e.id = lr.enrollment_id
        WHERE lr.status = 'recorded'
          AND lr.completed_at >= ${from.toISOString()}::timestamptz
          AND lr.completed_at <  ${to.toISOString()}::timestamptz
        GROUP BY lr.instructor_user_id
      ) l ON l.instructor_user_id = u.id
      WHERE m.role = 'cfi'
      ORDER BY "flightHoursRaw" DESC, "lessonsGiven" DESC, "instructorName" ASC
    `);

    const rows = extractRows<{
      instructorUserId: string;
      instructorName: string;
      flightCount: number | string;
      flightHoursRaw: number | string;
      lessonsGiven: number | string;
      distinctStudents: number | string;
    }>(queryResult);

    return rows.map((row) => {
      const flightHoursRaw = Number(row.flightHoursRaw ?? 0);
      return {
        instructorUserId: row.instructorUserId,
        instructorName: row.instructorName,
        flightCount: Number(row.flightCount ?? 0),
        flightHours: Math.round(flightHoursRaw * 10) / 10,
        lessonsGiven: Number(row.lessonsGiven ?? 0),
        distinctStudents: Number(row.distinctStudents ?? 0),
      };
    });
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * getInstructorUtilization — per-CFI utilization for the authenticated org.
 *
 * Uses the memoized production DB client (getDb()). apps/web never passes a db.
 *
 * @param session  - AppSession from auth(); throws UnauthenticatedError if null.
 * @param rawInput - { range?: '7d'|'30d'|'90d'|'180d'|'365d' } — defaults to '30d'.
 * @returns InstructorUtilizationRow[] ordered hours DESC, lessons DESC, name ASC.
 * @throws UnauthenticatedError, ForbiddenError, ValidationError
 */
export async function getInstructorUtilization(
  session: AppSession | null | undefined,
  rawInput: GetInstructorUtilizationInput = {},
): Promise<InstructorUtilizationRow[]> {
  const db = await getDb();
  return _getInstructorUtilizationImpl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/**
 * getInstructorUtilizationWithDb — same contract but accepts an explicit db.
 *
 * Tests MUST use this form so they never trigger getDb().
 */
export async function getInstructorUtilizationWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetInstructorUtilizationInput = {},
): Promise<InstructorUtilizationRow[]> {
  return _getInstructorUtilizationImpl(db, session, rawInput);
}
