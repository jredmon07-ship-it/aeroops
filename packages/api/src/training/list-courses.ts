/**
 * list-courses.ts — List all courses for the org (Slice T1.2).
 *
 * listCourses — returns all courses in the org ordered by title ASC.
 * Includes lesson count per course.
 *
 * GUARANTEES:
 *   - requireCapability('training:access') FIRST.
 *   - org_id from session only; RLS-scoped.
 *   - Returns [] for an org with no courses (not an error).
 *
 * TWO CALLING FORMS:
 *   listCourses(session, opts?)          — app code.
 *   listCoursesWithDb(db, session, opts?) — tests.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { ListCoursesResult } from './types.js';
import { extractRows } from '../db-rows.js';

export interface ListCoursesOptions {
  /** Filter by status. Omit for all statuses. */
  status?: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listCoursesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListCoursesOptions,
): Promise<ListCoursesResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:access');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const statusFilter = opts?.status
      ? sql`AND c.status = ${opts.status}`
      : sql``;

    const result = await tx.execute(sql`
      SELECT
        c.id          AS "courseId",
        c.title,
        c.description,
        c.status,
        c.created_by  AS "createdBy",
        c.created_at  AS "createdAt",
        c.updated_at  AS "updatedAt",
        COUNT(cl.id)::int AS "lessonCount"
      FROM course c
      LEFT JOIN course_lesson cl ON cl.course_id = c.id
      WHERE 1=1 ${statusFilter}
      GROUP BY c.id
      ORDER BY c.title ASC
    `);

    const rows = extractRows<{
      courseId: string;
      title: string;
      description: string | null;
      status: string;
      createdBy: string;
      createdAt: Date | string;
      updatedAt: Date | string;
      lessonCount: number | string;
    }>(result);

    return rows.map((r) => ({
      courseId:    r.courseId,
      title:       r.title,
      description: r.description ?? null,
      status:      r.status,
      createdBy:   r.createdBy,
      createdAt:   r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
      updatedAt:   r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt),
      lessonCount: typeof r.lessonCount === 'string' ? parseInt(r.lessonCount, 10) : r.lessonCount,
    }));
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function listCourses(
  session: AppSession | null | undefined,
  opts?: ListCoursesOptions,
): Promise<ListCoursesResult> {
  const db = await getDb();
  return _listCoursesImpl(db, session, opts);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function listCoursesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListCoursesOptions,
): Promise<ListCoursesResult> {
  return _listCoursesImpl(db, session, opts);
}
