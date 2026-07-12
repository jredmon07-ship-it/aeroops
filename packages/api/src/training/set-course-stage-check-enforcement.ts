/**
 * set-course-stage-check-enforcement.ts — Toggle a course's stage-check
 * enforcement opt-in (Slice P2-SC1).
 *
 * setCourseStageCheckEnforcement — sets course.enforce_stage_checks. When
 * true, recordLesson refuses (stage_check_required) any record for a lesson
 * positioned AFTER a stage-check lesson that has no non-voided record with
 * stage_check_passed=true. Default false = INERT (existing behavior
 * byte-identical until the operator opts in).
 *
 * COMPLIANCE HARD LINE: this gate enforces the OPERATOR's configured course
 * structure ONLY — it is NOT a Part-61/141 stage check of record, NOT an
 * FAA milestone/graduation/curriculum determination, and computes NO
 * regulatory verdict. A human still makes every regulatory call.
 *
 * GUARANTEES:
 *   - requireCapability('training:manage') FIRST (owner/manager/cfi).
 *   - org_id from session only; cross-org courseId → not_found (RLS).
 *   - Bumps course.updated_at.
 *   - ONE audit row 'training.course_stage_check_enforcement_set'.
 *   - Returns fresh CourseDetail via assembleCourseDetail.
 *
 * TWO CALLING FORMS:
 *   setCourseStageCheckEnforcement(session, input)          — app code.
 *   setCourseStageCheckEnforcementWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { SetCourseStageCheckEnforcementResult } from './types.js';
import { assembleCourseDetail } from './internal.js';
import { extractRows } from '../db-rows.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  courseId:           z.string().regex(UUID_RE, { message: 'courseId must be a UUID' }),
  /** Operator opt-in. NOT a Part-61/141 determination. */
  enforceStageChecks: z.boolean(),
});

export interface SetCourseStageCheckEnforcementInput {
  courseId: string;
  /** Operator opt-in. NOT a Part-61/141 determination. */
  enforceStageChecks: boolean;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _setCourseStageCheckEnforcementImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetCourseStageCheckEnforcementResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[training] invalid setCourseStageCheckEnforcement input: ${first?.message ?? 'unknown'}`,
    );
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. UPDATE the flag (RLS-scoped; cross-org/nonexistent → 0 rows → not_found).
    const updated = await tx.execute(sql`
      UPDATE course
      SET enforce_stage_checks = ${input.enforceStageChecks}, updated_at = now()
      WHERE id = ${input.courseId}::uuid
      RETURNING id
    `);
    const rows = extractRows<{ id: string }>(updated);
    const row = rows[0];
    if (!row) return { ok: false, reason: 'not_found' };

    // 4. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'training.course_stage_check_enforcement_set',
      entityType:  'course',
      entityId:    row.id,
      metadata:    { enforceStageChecks: input.enforceStageChecks },
    });

    // 5. Return fresh course detail.
    const courseDetail = await assembleCourseDetail(tx, row.id);
    if (!courseDetail) throw new Error('[training] setCourseStageCheckEnforcement: re-read returned no row');
    return { ok: true, course: courseDetail };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function setCourseStageCheckEnforcement(
  session: AppSession | null | undefined,
  input: SetCourseStageCheckEnforcementInput,
): Promise<SetCourseStageCheckEnforcementResult> {
  const db = await getDb();
  return _setCourseStageCheckEnforcementImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function setCourseStageCheckEnforcementWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: SetCourseStageCheckEnforcementInput,
): Promise<SetCourseStageCheckEnforcementResult> {
  return _setCourseStageCheckEnforcementImpl(db, session, input);
}
