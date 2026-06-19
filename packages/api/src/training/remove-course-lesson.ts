/**
 * remove-course-lesson.ts — Remove a lesson from a course (Slice T1.2).
 *
 * removeCourseLesson — hard-deletes a course_lesson row IF no non-voided
 * lesson_records reference it. Returns has_records when any non-voided record
 * exists (even only-voided blocks: audit history preserved per spec §5).
 * DB RESTRICT FK on lesson_record → course_lesson backstops any code path error.
 *
 * NOTE: spec says "refuse has_records when any non-voided lesson_record references it"
 * but also says "remove lesson with records → has_records (incl. only-voided: still blocks)".
 * Implementation: ANY lesson_record (regardless of status) → has_records (spec §5 edge case).
 *
 * GUARANTEES:
 *   - requireCapability('training:manage') FIRST (owner/manager/cfi).
 *   - org_id from session only; cross-org lessonId → not_found (RLS).
 *   - ONE audit row 'training.lesson_removed'.
 *   - Returns fresh CourseDetail.
 *
 * TWO CALLING FORMS:
 *   removeCourseLesson(session, input)          — app code.
 *   removeCourseLessonWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { courseLesson, auditLog } from '@aeroops/db';
import { eq } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { RemoveCourseLessonResult } from './types.js';
import { assembleCourseDetail } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  lessonId: z.string().regex(UUID_RE, { message: 'lessonId must be a UUID' }),
});

export interface RemoveCourseLessonInput {
  lessonId: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _removeCourseLessonImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<RemoveCourseLessonResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid removeCourseLesson input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Check lesson visible in org (RLS; cross-org → not_found).
    const lessonCheck = await tx.execute(sql`
      SELECT id, course_id AS "courseId"
      FROM course_lesson
      WHERE id = ${input.lessonId}::uuid
      LIMIT 1
    `);
    const lessonRows = (lessonCheck.rows ?? lessonCheck) as Array<{ id: string; courseId: string }>;
    const lesson = lessonRows[0];
    if (!lesson) return { ok: false, reason: 'not_found' };

    // 4. Check for any lesson_records referencing this lesson (ANY status).
    // Per spec §5: "incl. only-voided: still blocks, audit history".
    const recordCheck = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM lesson_record WHERE lesson_id = ${input.lessonId}::uuid
      ) AS "hasRecords"
    `);
    const recRows = (recordCheck.rows ?? recordCheck) as Array<{ hasRecords: boolean | string }>;
    const hasRecords = recRows[0]?.hasRecords === true || recRows[0]?.hasRecords === 't' || recRows[0]?.hasRecords === 'true';
    if (hasRecords) return { ok: false, reason: 'has_records' };

    // 5. Delete the lesson row (DB RESTRICT FK backstops any concurrent record insert).
    await tx.delete(courseLesson).where(eq(courseLesson.id, input.lessonId));

    // 6. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'training.lesson_removed',
      entityType:  'course_lesson',
      entityId:    input.lessonId,
      metadata:    { courseId: lesson.courseId },
    });

    // 7. Return fresh course detail.
    const courseDetail = await assembleCourseDetail(tx, lesson.courseId);
    if (!courseDetail) throw new Error('[training] removeCourseLesson: re-read returned no course row');
    return { ok: true, course: courseDetail };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function removeCourseLesson(
  session: AppSession | null | undefined,
  input: RemoveCourseLessonInput,
): Promise<RemoveCourseLessonResult> {
  const db = await getDb();
  return _removeCourseLessonImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function removeCourseLessonWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: RemoveCourseLessonInput,
): Promise<RemoveCourseLessonResult> {
  return _removeCourseLessonImpl(db, session, input);
}
