/**
 * set-lesson-stage-check.ts — Toggle a lesson's stage-check flag (Slice P2-SC1).
 *
 * setLessonStageCheck — sets course_lesson.is_stage_check for an existing
 * lesson (operator course-structure config; the flag is otherwise set at
 * addCourseLesson time).
 *
 * COMPLIANCE HARD LINE: is_stage_check is an OPERATOR flag marking a
 * milestone-evaluation lesson inside the operator's course. It is NOT a
 * Part-61/141 stage check of record, NOT an FAA milestone or curriculum
 * determination — the software attaches no regulatory meaning to it.
 * (Mirrors [VERIFY-T1-G].)
 *
 * GUARANTEES:
 *   - requireCapability('training:manage') FIRST (owner/manager/cfi).
 *   - org_id from session only; cross-org lessonId → not_found (RLS).
 *   - Bumps course_lesson.updated_at.
 *   - ONE audit row 'training.lesson_stage_check_set'.
 *   - Returns fresh CourseDetail via assembleCourseDetail.
 *
 * TWO CALLING FORMS:
 *   setLessonStageCheck(session, input)          — app code.
 *   setLessonStageCheckWithDb(db, session, input) — tests.
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
import type { SetLessonStageCheckResult } from './types.js';
import { assembleCourseDetail } from './internal.js';
import { extractRows } from '../db-rows.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  lessonId:     z.string().regex(UUID_RE, { message: 'lessonId must be a UUID' }),
  /** Operator flag. NOT a Part-61/141 stage check of record. */
  isStageCheck: z.boolean(),
});

export interface SetLessonStageCheckInput {
  lessonId: string;
  /** Operator flag. NOT a Part-61/141 stage check of record. */
  isStageCheck: boolean;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _setLessonStageCheckImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetLessonStageCheckResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid setLessonStageCheck input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. UPDATE the flag (RLS-scoped; cross-org/nonexistent → 0 rows → not_found).
    const updated = await tx.execute(sql`
      UPDATE course_lesson
      SET is_stage_check = ${input.isStageCheck}, updated_at = now()
      WHERE id = ${input.lessonId}::uuid
      RETURNING id, course_id AS "courseId"
    `);
    const rows = extractRows<{ id: string; courseId: string }>(updated);
    const row = rows[0];
    if (!row) return { ok: false, reason: 'not_found' };

    // 4. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'training.lesson_stage_check_set',
      entityType:  'course_lesson',
      entityId:    row.id,
      metadata:    { courseId: row.courseId, isStageCheck: input.isStageCheck },
    });

    // 5. Return fresh course detail.
    const courseDetail = await assembleCourseDetail(tx, row.courseId);
    if (!courseDetail) throw new Error('[training] setLessonStageCheck: re-read returned no row');
    return { ok: true, course: courseDetail };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function setLessonStageCheck(
  session: AppSession | null | undefined,
  input: SetLessonStageCheckInput,
): Promise<SetLessonStageCheckResult> {
  const db = await getDb();
  return _setLessonStageCheckImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function setLessonStageCheckWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: SetLessonStageCheckInput,
): Promise<SetLessonStageCheckResult> {
  return _setLessonStageCheckImpl(db, session, input);
}
