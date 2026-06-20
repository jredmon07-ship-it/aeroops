/**
 * reporting/get-training-throughput.ts — Training throughput counts (R1.1).
 *
 * METRIC DEFINITION (all are operator-state counts — NOT Part-141 graduation):
 *   enrollmentsCreatedInRange:
 *     COUNT(*) FROM enrollment WHERE enrolled_at >= from AND enrolled_at < to.
 *     Half-open; all statuses included.
 *   enrollmentsCompletedInRange:
 *     COUNT(*) FROM enrollment WHERE status='completed'
 *     AND status_changed_at >= from AND status_changed_at < to.
 *     Half-open; status_changed_at is when status was last set.
 *   lessonsRecordedInRange:
 *     COUNT(*) FROM lesson_record WHERE status='recorded'
 *     AND completed_at >= from AND completed_at < to.
 *     Voided records (status='voided') excluded.
 *     Half-open.
 *   activeEnrollmentCount:
 *     COUNT(*) FROM enrollment WHERE status='active'.
 *     Point-in-time snapshot (no range filter).
 *
 * [VERIFY-T1-B]: enrollment/lesson counts = operator state, NOT a Part-141 or FAA
 *   training determination. No computed FAA currency, graduation, or stage-check outcome.
 *
 * AUTHZ: requireCapability('reporting:access') FIRST.
 * TENANT ISOLATION: org_id from session only; one withSessionOrgContextWithDb.
 * READ-ONLY: zero writes, zero audit.
 *
 * TWO CALLING FORMS:
 *   getTrainingThroughput(session, input)          — app code.
 *   getTrainingThroughputWithDb(db, session, input) — tests.
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
import type { TrainingThroughputResult } from './types.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const ReportRangeKeySchema = z.enum(['7d', '30d', '90d', '180d', '365d']).default('30d');
const InputSchema = z.object({ range: ReportRangeKeySchema });
export type GetTrainingThroughputInput = { range?: ReportRangeKey | string };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetTrainingThroughputInput,
): Promise<TrainingThroughputResult> {
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
    // Query 1: enrollments created in range (anchor: enrolled_at).
    const createdResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM enrollment
      WHERE enrolled_at >= ${from}
        AND enrolled_at < ${to}
    `);
    const enrollmentsCreatedInRange = Number(
      ((createdResult.rows ?? createdResult) as Array<{ count: number | string }>)[0]?.count ?? 0,
    );

    // Query 2: enrollments completed in range (anchor: status_changed_at).
    // status='completed' AND status_changed_at in [from, to).
    const completedResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM enrollment
      WHERE status = 'completed'
        AND status_changed_at >= ${from}
        AND status_changed_at < ${to}
    `);
    const enrollmentsCompletedInRange = Number(
      ((completedResult.rows ?? completedResult) as Array<{ count: number | string }>)[0]?.count ?? 0,
    );

    // Query 3: lessons recorded in range (anchor: completed_at).
    // status='recorded' (voided excluded). Half-open.
    const lessonsResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM lesson_record
      WHERE status = 'recorded'
        AND completed_at >= ${from}
        AND completed_at < ${to}
    `);
    const lessonsRecordedInRange = Number(
      ((lessonsResult.rows ?? lessonsResult) as Array<{ count: number | string }>)[0]?.count ?? 0,
    );

    // Query 4: active enrollment snapshot (point-in-time, no range filter).
    const activeResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM enrollment
      WHERE status = 'active'
    `);
    const activeEnrollmentCount = Number(
      ((activeResult.rows ?? activeResult) as Array<{ count: number | string }>)[0]?.count ?? 0,
    );

    return {
      range: { key: rangeKey, from, to },
      /**
       * enrollmentsCreatedInRange — count of enrollment rows with enrolled_at in [from,to).
       * OPERATIONAL operator count — NOT a Part-141 or FAA training determination. [VERIFY-T1-B]
       */
      enrollmentsCreatedInRange,
      /**
       * enrollmentsCompletedInRange — count of enrollments with status='completed'
       * AND status_changed_at in [from,to).
       * OPERATIONAL — NOT a Part-141 graduation or FAA completion determination. [VERIFY-T1-B]
       */
      enrollmentsCompletedInRange,
      /**
       * lessonsRecordedInRange — count of lesson_record rows with status='recorded'
       * AND completed_at in [from,to). Voided records excluded.
       * OPERATIONAL — NOT an FAA logbook or Part-141/61 endorsement. [VERIFY-T1-B]
       */
      lessonsRecordedInRange,
      /**
       * activeEnrollmentCount — point-in-time count of enrollment rows with status='active'.
       * OPERATIONAL — NOT a Part-141 or FAA training determination. [VERIFY-T1-B]
       */
      activeEnrollmentCount,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getTrainingThroughput(
  session: AppSession | null | undefined,
  rawInput: GetTrainingThroughputInput = {},
): Promise<TrainingThroughputResult> {
  const db = await getDb();
  return _impl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getTrainingThroughputWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetTrainingThroughputInput = {},
): Promise<TrainingThroughputResult> {
  return _impl(db, session, rawInput);
}
