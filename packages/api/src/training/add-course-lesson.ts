/**
 * add-course-lesson.ts — Add an ordered lesson to a course (Slice T1.2).
 *
 * addCourseLesson — assigns position = (max position in course) + 1 in-tx,
 * then inserts the lesson. The UNIQUE(course_id, position) DB constraint is the
 * race backstop (concurrent inserts → 23505; client may retry).
 *
 * GUARANTEES:
 *   - requireCapability('training:manage') FIRST (owner/manager/cfi).
 *   - org_id from session only; cross-org courseId → not_found (RLS).
 *   - Position = max(existing)+1 in-tx (zero if course has no lessons yet).
 *   - ONE audit row 'training.lesson_added'.
 *   - Returns fresh CourseDetail via assembleCourseDetail.
 *
 * [VERIFY-T1-G]: stage_label is FREE-TEXT operator grouping, NOT a Part-141 stage.
 *
 * TWO CALLING FORMS:
 *   addCourseLesson(session, input)          — app code.
 *   addCourseLessonWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { courseLesson, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { AddCourseLessonResult } from './types.js';
import { assembleCourseDetail } from './internal.js';
import { extractRows } from '../db-rows.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  courseId:    z.string().regex(UUID_RE, { message: 'courseId must be a UUID' }),
  title:       z.string(),
  description: z.string().optional(),
  /** FREE-TEXT operator grouping label. NOT a Part-141 stage. [VERIFY-T1-G] */
  stageLabel:  z.string().optional(),
});

export interface AddCourseLessonInput {
  courseId: string;
  title: string;
  description?: string;
  /** FREE-TEXT operator grouping, NOT a Part-141 stage. [VERIFY-T1-G] */
  stageLabel?: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _addCourseLessonImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<AddCourseLessonResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid addCourseLesson input: ${first?.message ?? 'unknown'}`);
  }
  const title = parsed.data.title.trim();
  if (title.length === 0) {
    throw new ValidationError('[training] addCourseLesson: title must not be empty after trimming');
  }
  const input = {
    courseId:    parsed.data.courseId,
    title,
    description: parsed.data.description?.trim() ?? null,
    stageLabel:  parsed.data.stageLabel?.trim() ?? null,
  };

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Check course is visible in org (RLS; cross-org → not_found).
    const courseCheck = await tx.execute(sql`
      SELECT id FROM course WHERE id = ${input.courseId}::uuid LIMIT 1
    `);
    const courseRows = extractRows<{ id: string }>(courseCheck);
    if (courseRows.length === 0) return { ok: false, reason: 'not_found' };

    // 4. Compute next position in-tx (max(position)+1; 0 if no lessons yet).
    const maxPosResult = await tx.execute(sql`
      SELECT COALESCE(MAX(position), -1)::int AS "maxPos"
      FROM course_lesson
      WHERE course_id = ${input.courseId}::uuid
    `);
    const maxPosRows = extractRows<{ maxPos: number | string }>(maxPosResult);
    const maxPos = typeof maxPosRows[0]?.maxPos === 'string'
      ? parseInt(maxPosRows[0].maxPos, 10)
      : (maxPosRows[0]?.maxPos ?? -1);
    const position = maxPos + 1;

    // 5. INSERT lesson. The UNIQUE(course_id, position) is the race backstop.
    const inserted = await tx
      .insert(courseLesson)
      .values({
        orgId:       sess.orgId,
        courseId:    input.courseId,
        title:       input.title,
        description: input.description ?? undefined,
        stageLabel:  input.stageLabel ?? undefined,
        position,
        createdBy:   sess.userId,
      })
      .returning({ id: courseLesson.id });

    const lessonId = inserted[0]?.id;
    if (!lessonId) throw new Error('[training] addCourseLesson: INSERT returned no id');

    // 6. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'training.lesson_added',
      entityType:  'course_lesson',
      entityId:    lessonId,
      metadata:    { courseId: input.courseId, title: input.title, position },
    });

    // 7. Return fresh course detail.
    const courseDetail = await assembleCourseDetail(tx, input.courseId);
    if (!courseDetail) throw new Error('[training] addCourseLesson: re-read returned no row');
    return { ok: true, course: courseDetail };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function addCourseLesson(
  session: AppSession | null | undefined,
  input: AddCourseLessonInput,
): Promise<AddCourseLessonResult> {
  const db = await getDb();
  return _addCourseLessonImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function addCourseLessonWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: AddCourseLessonInput,
): Promise<AddCourseLessonResult> {
  return _addCourseLessonImpl(db, session, input);
}
