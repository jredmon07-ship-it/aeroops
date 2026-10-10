/**
 * create-course.ts — Create a new training course (Slice T1.2).
 *
 * createCourse — inserts a new course row and emits ONE audit_log row.
 * Returns the fresh CourseDetail via assembleCourseDetail.
 *
 * GUARANTEES:
 *   - requireCapability('training:manage') FIRST (owner/manager/cfi).
 *   - org_id from session only.
 *   - Trims title; empty after trim → ValidationError.
 *   - ONE audit row 'training.course_created'.
 *   - Returns fresh CourseDetail.
 *
 * TWO CALLING FORMS:
 *   createCourse(session, input)          — app code.
 *   createCourseWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { course, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { CreateCourseResult } from './types.js';
import { assembleCourseDetail } from './internal.js';

const inputSchema = z.object({
  title:       z.string(),
  description: z.string().optional(),
});

export interface CreateCourseInput {
  title: string;
  description?: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _createCourseImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CreateCourseResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid createCourse input: ${first?.message ?? 'unknown'}`);
  }
  const title = parsed.data.title.trim();
  if (title.length === 0) {
    throw new ValidationError('[training] createCourse: title must not be empty after trimming');
  }
  const description = parsed.data.description?.trim() ?? null;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. INSERT course row.
    const inserted = await tx
      .insert(course)
      .values({
        orgId:       sess.orgId,
        title,
        description: description ?? undefined,
        createdBy:   sess.userId,
      })
      .returning({ id: course.id });

    const courseId = inserted[0]?.id;
    if (!courseId) throw new Error('[training] createCourse: INSERT returned no id');

    // 4. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'training.course_created',
      entityType:  'course',
      entityId:    courseId,
      metadata:    { title },
    });

    // 5. Return fresh detail.
    const courseDetail = await assembleCourseDetail(tx, courseId);
    if (!courseDetail) throw new Error('[training] createCourse: re-read returned no row');
    return { ok: true, course: courseDetail };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function createCourse(
  session: AppSession | null | undefined,
  input: CreateCourseInput,
): Promise<CreateCourseResult> {
  const db = await getDb();
  return _createCourseImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function createCourseWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CreateCourseInput,
): Promise<CreateCourseResult> {
  return _createCourseImpl(db, session, input);
}
