/**
 * list-enrollments.ts — List enrollments for the org (Slice T1.2).
 *
 * listEnrollments — returns all enrollments in the org with progress.
 * Optional filters: courseId, studentUserId.
 *
 * GUARANTEES:
 *   - requireCapability('training:access') FIRST.
 *   - org_id from session only; RLS-scoped.
 *   - Progress ratio via progressRatioFromCounts (@aeroops/core). [VERIFY-T1-B]
 *
 * TWO CALLING FORMS:
 *   listEnrollments(session, opts?)          — app code.
 *   listEnrollmentsWithDb(db, session, opts?) — tests.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { progressRatioFromCounts, isEnrollmentStatus } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { ListEnrollmentsResult } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ListEnrollmentsOptions {
  courseId?: string;
  studentUserId?: string;
  status?: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listEnrollmentsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListEnrollmentsOptions,
): Promise<ListEnrollmentsResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:access');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Build optional filters. UUID format is validated only if provided.
    const courseFilter = (opts?.courseId && UUID_RE.test(opts.courseId))
      ? sql`AND e.course_id = ${opts.courseId}::uuid`
      : sql``;
    const studentFilter = (opts?.studentUserId && UUID_RE.test(opts.studentUserId))
      ? sql`AND e.student_user_id = ${opts.studentUserId}::uuid`
      : sql``;
    // Validate the status against the enum before casting (an unknown value would
    // otherwise raise 22P02). Invalid → ignored, mirroring the UUID-filter guards.
    const statusFilter = (opts?.status && isEnrollmentStatus(opts.status))
      ? sql`AND e.status = ${opts.status}::enrollment_status`
      : sql``;

    const result = await tx.execute(sql`
      SELECT
        e.id                        AS "enrollmentId",
        e.course_id                 AS "courseId",
        c.title                     AS "courseTitle",
        e.student_user_id           AS "studentUserId",
        COALESCE(u.full_name, u.email) AS "studentName",
        e.status,
        e.enrolled_by               AS "enrolledBy",
        e.enrolled_at               AS "enrolledAt",
        e.status_changed_at         AS "statusChangedAt",
        COUNT(DISTINCT cl.id)::int  AS "totalLessons",
        COUNT(DISTINCT CASE WHEN lr.status = 'recorded' THEN lr.lesson_id END)::int AS "completedCount"
      FROM enrollment e
      JOIN course c ON c.id = e.course_id
      JOIN app_user u ON u.id = e.student_user_id
      LEFT JOIN course_lesson cl ON cl.course_id = e.course_id
      LEFT JOIN lesson_record lr ON lr.enrollment_id = e.id AND lr.status = 'recorded'
      WHERE 1=1 ${courseFilter} ${studentFilter} ${statusFilter}
      GROUP BY e.id, c.title, u.full_name, u.email
      ORDER BY e.enrolled_at DESC
    `);

    const rows = (result.rows ?? result) as Array<{
      enrollmentId: string;
      courseId: string;
      courseTitle: string;
      studentUserId: string;
      studentName: string;
      status: string;
      enrolledBy: string;
      enrolledAt: Date | string;
      statusChangedAt: Date | string | null;
      totalLessons: number | string;
      completedCount: number | string;
    }>;

    return rows.map((r) => {
      const total = typeof r.totalLessons === 'string' ? parseInt(r.totalLessons, 10) : r.totalLessons;
      const completed = typeof r.completedCount === 'string' ? parseInt(r.completedCount, 10) : r.completedCount;
      const ratio = progressRatioFromCounts(completed, total);
      return {
        enrollmentId:    r.enrollmentId,
        courseId:        r.courseId,
        courseTitle:     r.courseTitle,
        studentUserId:   r.studentUserId,
        studentName:     r.studentName,
        status:          r.status as ListEnrollmentsResult[number]['status'],
        enrolledBy:      r.enrolledBy,
        enrolledAt:      r.enrolledAt instanceof Date ? r.enrolledAt : new Date(r.enrolledAt),
        statusChangedAt: r.statusChangedAt != null
          ? (r.statusChangedAt instanceof Date ? r.statusChangedAt : new Date(r.statusChangedAt))
          : null,
        completedCount:  completed,
        totalLessons:    total,
        progressPercent: ratio.percent,
      };
    });
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function listEnrollments(
  session: AppSession | null | undefined,
  opts?: ListEnrollmentsOptions,
): Promise<ListEnrollmentsResult> {
  const db = await getDb();
  return _listEnrollmentsImpl(db, session, opts);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function listEnrollmentsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListEnrollmentsOptions,
): Promise<ListEnrollmentsResult> {
  return _listEnrollmentsImpl(db, session, opts);
}
