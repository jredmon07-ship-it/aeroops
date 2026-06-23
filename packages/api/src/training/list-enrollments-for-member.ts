/**
 * list-enrollments-for-member.ts — People-detail Training facet (Slice T1.2).
 *
 * listEnrollmentsForMember — returns a lightweight enrollment summary for a
 * member's "Training" card on the People detail page.
 *
 * DECISION (inline-vs-separate): This is a SEPARATE read (not folded into
 * assembleMemberDetail) to keep assembleMemberDetail thin and avoid bloating
 * the People-detail aggregation. The People web page calls this alongside
 * getMemberDetail in T1.3.
 *
 * GUARANTEES:
 *   - requireCapability('training:access') FIRST.
 *   - org_id from session only; cross-org userId → empty result (RLS blocks).
 *   - Progress ratio via progressRatioFromCounts (@aeroops/core). [VERIFY-T1-B]
 *
 * TWO CALLING FORMS:
 *   listEnrollmentsForMember(session, input)          — app code.
 *   listEnrollmentsForMemberWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { progressRatioFromCounts } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { ListEnrollmentsForMemberResult } from './types.js';
import { extractRows } from '../db-rows.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  userId: z.string().regex(UUID_RE, { message: 'userId must be a UUID' }),
});

export interface ListEnrollmentsForMemberInput {
  userId: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listEnrollmentsForMemberImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<ListEnrollmentsForMemberResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:access');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid listEnrollmentsForMember input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const result = await tx.execute(sql`
      SELECT
        e.id                       AS "enrollmentId",
        e.course_id                AS "courseId",
        c.title                    AS "courseTitle",
        e.status,
        e.enrolled_at              AS "enrolledAt",
        e.status_changed_at        AS "statusChangedAt",
        COUNT(DISTINCT cl.id)::int AS "totalLessons",
        COUNT(DISTINCT CASE WHEN lr.status = 'recorded' THEN lr.lesson_id END)::int AS "completedCount"
      FROM enrollment e
      JOIN course c ON c.id = e.course_id
      LEFT JOIN course_lesson cl ON cl.course_id = e.course_id
      LEFT JOIN lesson_record lr ON lr.enrollment_id = e.id AND lr.status = 'recorded'
      WHERE e.student_user_id = ${input.userId}::uuid
      GROUP BY e.id, c.title
      ORDER BY e.enrolled_at DESC
    `);

    const rows = extractRows<{
      enrollmentId: string;
      courseId: string;
      courseTitle: string;
      status: string;
      enrolledAt: Date | string;
      statusChangedAt: Date | string | null;
      totalLessons: number | string;
      completedCount: number | string;
    }>(result);

    return rows.map((r) => {
      const total = typeof r.totalLessons === 'string' ? parseInt(r.totalLessons, 10) : r.totalLessons;
      const completed = typeof r.completedCount === 'string' ? parseInt(r.completedCount, 10) : r.completedCount;
      return {
        enrollmentId:    r.enrollmentId,
        courseId:        r.courseId,
        courseTitle:     r.courseTitle,
        status:          r.status as ListEnrollmentsForMemberResult[number]['status'],
        enrolledAt:      r.enrolledAt instanceof Date ? r.enrolledAt : new Date(r.enrolledAt),
        statusChangedAt: r.statusChangedAt != null
          ? (r.statusChangedAt instanceof Date ? r.statusChangedAt : new Date(r.statusChangedAt))
          : null,
        completedCount: completed,
        totalLessons:   total,
        progressRatio:  progressRatioFromCounts(completed, total),
      };
    });
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function listEnrollmentsForMember(
  session: AppSession | null | undefined,
  input: ListEnrollmentsForMemberInput,
): Promise<ListEnrollmentsForMemberResult> {
  const db = await getDb();
  return _listEnrollmentsForMemberImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function listEnrollmentsForMemberWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ListEnrollmentsForMemberInput,
): Promise<ListEnrollmentsForMemberResult> {
  return _listEnrollmentsForMemberImpl(db, session, input);
}
