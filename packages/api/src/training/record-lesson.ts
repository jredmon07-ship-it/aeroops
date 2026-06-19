/**
 * record-lesson.ts — Record a lesson completion (Slice T1.2).
 *
 * recordLesson — inserts a WRITE-ONCE lesson_record row.
 *
 * Pre-checks (in order):
 *   1. enrollment visible AND status='active' → else enrollment_not_active
 *   2. lesson belongs to the enrollment's course → else lesson_not_in_course
 *   3. instructor visible in org → else not_found
 *
 * completed_at defaults to now() (write-once). No updateLessonRecord path.
 *
 * COMPLIANCE:
 *   grade_label = FREE-TEXT only. NOT a computed ACS/Part-61/141 verdict. [VERIFY-T1-A]
 *   lesson_record = DATA ENTRY RECORD, NOT an e-signature. [VERIFY-T1-C]
 *   instructor_user_id = ANY org member; no CFI-of-record enforcement in T1. [VERIFY-T1-E]
 *
 * GUARANTEES:
 *   - requireCapability('training:manage') FIRST (owner/manager/cfi).
 *   - org_id from session only; cross-org enrollmentId/lessonId → not_found/appropriate arm.
 *   - completed_at defaults now; WRITE-ONCE (no UPDATE path for lesson_record fields).
 *   - ONE audit row 'training.lesson_recorded'.
 *   - Returns fresh EnrollmentDetail via assembleEnrollmentDetail.
 *
 * TWO CALLING FORMS:
 *   recordLesson(session, input)          — app code.
 *   recordLessonWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { lessonRecord, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { RecordLessonResult } from './types.js';
import { assembleEnrollmentDetail } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  enrollmentId:    z.string().regex(UUID_RE, { message: 'enrollmentId must be a UUID' }),
  lessonId:        z.string().regex(UUID_RE, { message: 'lessonId must be a UUID' }),
  instructorUserId: z.string().regex(UUID_RE, { message: 'instructorUserId must be a UUID' }),
  /**
   * FREE-TEXT grade label. NOT a computed ACS grade, Part-61/141 verdict, or regulatory
   * outcome. The system stores and displays whatever text is provided. [VERIFY-T1-A]
   */
  gradeLabel:      z.string().optional(),
  notes:           z.string().optional(),
  /** If omitted, defaults to now() at INSERT. Write-once. [VERIFY-T1-C] */
  completedAt:     z.string().datetime().optional(),
});

export interface RecordLessonInput {
  enrollmentId: string;
  lessonId: string;
  instructorUserId: string;
  /** FREE-TEXT only. NOT a computed ACS/Part-61/141 verdict. [VERIFY-T1-A] */
  gradeLabel?: string;
  notes?: string;
  /** ISO 8601 string; defaults to now() if omitted. Write-once. */
  completedAt?: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _recordLessonImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<RecordLessonResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid recordLesson input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Pre-check: enrollment visible AND status='active'.
    // Invisible (cross-org / nonexistent) → not_found (the house convention for an
    // invisible id, matching set-enrollment-status/void/enroll). enrollment_not_active
    // is reserved for a VISIBLE-but-non-active enrollment. Both run in the safe
    // direction: a cross-org id is indistinguishable from a nonexistent one.
    const enrollCheck = await tx.execute(sql`
      SELECT id, status, course_id AS "courseId"
      FROM enrollment
      WHERE id = ${input.enrollmentId}::uuid
      LIMIT 1
    `);
    const enrollRows = (enrollCheck.rows ?? enrollCheck) as Array<{
      id: string;
      status: string;
      courseId: string;
    }>;
    const enroll = enrollRows[0];

    // not_found (invisible/cross-org) vs enrollment_not_active (visible, non-active).
    if (!enroll) return { ok: false, reason: 'not_found' };
    if (enroll.status !== 'active') return { ok: false, reason: 'enrollment_not_active' };

    // 4. Pre-check: lesson belongs to the enrollment's course.
    const lessonCheck = await tx.execute(sql`
      SELECT id FROM course_lesson
      WHERE id = ${input.lessonId}::uuid
        AND course_id = ${enroll.courseId}::uuid
      LIMIT 1
    `);
    const lessonRows = (lessonCheck.rows ?? lessonCheck) as Array<{ id: string }>;
    if (lessonRows.length === 0) return { ok: false, reason: 'lesson_not_in_course' };

    // 5. Pre-check: instructor visible in org.
    const instrCheck = await tx.execute(sql`
      SELECT user_id FROM membership
      WHERE user_id = ${input.instructorUserId}::uuid
      LIMIT 1
    `);
    const instrRows = (instrCheck.rows ?? instrCheck) as Array<{ user_id: string }>;
    if (instrRows.length === 0) return { ok: false, reason: 'not_found' };

    // 6. INSERT lesson_record (WRITE-ONCE; no UPDATE path for content fields).
    // completed_at defaults to now() if not provided. [VERIFY-T1-C]
    const completedAt = input.completedAt ? new Date(input.completedAt) : new Date();

    const inserted = await tx
      .insert(lessonRecord)
      .values({
        orgId:           sess.orgId,
        enrollmentId:    input.enrollmentId,
        lessonId:        input.lessonId,
        instructorUserId: input.instructorUserId,
        completedAt,
        gradeLabel:      input.gradeLabel?.trim() ?? undefined,
        notes:           input.notes?.trim() ?? undefined,
        recordedBy:      sess.userId,
      })
      .returning({ id: lessonRecord.id });

    const recordId = inserted[0]?.id;
    if (!recordId) throw new Error('[training] recordLesson: INSERT returned no id');

    // 7. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'training.lesson_recorded',
      entityType:  'lesson_record',
      entityId:    recordId,
      metadata:    {
        enrollmentId: input.enrollmentId,
        lessonId:     input.lessonId,
        instructorUserId: input.instructorUserId,
      },
    });

    // 8. Return fresh enrollment detail.
    const enrollDetail = await assembleEnrollmentDetail(tx, input.enrollmentId);
    if (!enrollDetail) throw new Error('[training] recordLesson: re-read returned no row');
    return { ok: true, enrollment: enrollDetail };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function recordLesson(
  session: AppSession | null | undefined,
  input: RecordLessonInput,
): Promise<RecordLessonResult> {
  const db = await getDb();
  return _recordLessonImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function recordLessonWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: RecordLessonInput,
): Promise<RecordLessonResult> {
  return _recordLessonImpl(db, session, input);
}
