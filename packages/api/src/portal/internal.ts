/**
 * portal/internal.ts — tx-level helpers for the self-scoped portal reads.
 *
 * NOT exported from @aeroops/api. Mirrors people/internal.ts:
 *   assembleMyPortal(tx, userId)     — the 3-facet aggregation inside an existing
 *                                      org context (RLS-scoped by the caller).
 *   readMyTraining(tx, userId)       — own enrollments + progress.
 *   readMyReservations(tx, userId)   — own upcoming reservations (booker|pilot).
 *   readMyAccount(tx, userId)        — own identity + own free-text tags.
 *
 * INVARIANT: All helpers accept an AnyDb tx with the org GUC already set by the
 * caller's withSessionOrgContextWithDb. They NEVER set GUC themselves.
 *
 * SELF-SCOPING: the `userId` argument is ALWAYS session.userId (the verified
 * JWT subject). It is NEVER a caller-supplied row id. Every query hardwires
 * the predicate to this userId — a portal user can only ever read their own rows.
 *
 * [VERIFY-T1-B]: progress = content coverage, not a regulatory determination.
 * [VERIFY-6-A]: tags are free-text opaque labels only.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { progressRatioFromCounts } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';
import type {
  MyAccountView,
  MyEnrollmentRow,
  MyPortalSummary,
  MyReservationRow,
} from './types.js';

// ─── readMyTraining ───────────────────────────────────────────────────────────

/**
 * readMyTraining — the caller's OWN enrollments + content-coverage progress.
 * Predicate HARDWIRED to e.student_user_id = userId (session.userId). enrolled_at DESC.
 * Clone of the listEnrollmentsForMember query shape; self-scoped, NOT a staff read.
 */
export async function readMyTraining(
  tx: AnyDb,
  userId: string,
): Promise<MyEnrollmentRow[]> {
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
    WHERE e.student_user_id = ${userId}::uuid
    GROUP BY e.id, c.title
    ORDER BY e.enrolled_at DESC
  `);

  const rows = (result.rows ?? result) as Array<{
    enrollmentId: string;
    courseId: string;
    courseTitle: string;
    status: string;
    enrolledAt: Date | string;
    statusChangedAt: Date | string | null;
    totalLessons: number | string;
    completedCount: number | string;
  }>;

  return rows.map((r) => {
    const total = typeof r.totalLessons === 'string' ? parseInt(r.totalLessons, 10) : r.totalLessons;
    const completed = typeof r.completedCount === 'string' ? parseInt(r.completedCount, 10) : r.completedCount;
    return {
      enrollmentId:    r.enrollmentId,
      courseId:        r.courseId,
      courseTitle:     r.courseTitle,
      status:          r.status as MyEnrollmentRow['status'],
      enrolledAt:      r.enrolledAt instanceof Date ? r.enrolledAt : new Date(r.enrolledAt),
      statusChangedAt: r.statusChangedAt != null
        ? (r.statusChangedAt instanceof Date ? r.statusChangedAt : new Date(r.statusChangedAt))
        : null,
      completedCount: completed,
      totalLessons:   total,
      progressRatio:  progressRatioFromCounts(completed, total),
    };
  });
}

// ─── readMyReservations ───────────────────────────────────────────────────────

/**
 * readMyReservations — the caller's OWN upcoming reservations.
 *
 * In-scope iff status='booked' AND start > NOW() AND
 *   (reservation.created_by = me  OR  a NON-VOIDED dispatch_ticket links the
 *    reservation with pilot_user_id = me).
 * role derived from which condition(s) matched. resourceIds carries the aircraft
 * tail number when present (display), else the resource id. start ASC, LIMIT 20.
 */
export async function readMyReservations(
  tx: AnyDb,
  userId: string,
): Promise<MyReservationRow[]> {
  const result = await tx.execute(sql`
    SELECT
      r.id,
      lower(rr.during)                                    AS "startAt",
      upper(rr.during)                                    AS "endAt",
      r.series_id                                         AS "seriesId",
      COALESCE(res.tail_number, rr.resource_id::text)     AS "resourceLabel",
      (r.created_by = ${userId}::uuid)                    AS "isBooker",
      bool_or(
        dt.id IS NOT NULL
        AND dt.pilot_user_id = ${userId}::uuid
        AND dt.status <> 'voided'
      )                                                   AS "isPilot"
    FROM reservation r
    JOIN reservation_resource rr ON rr.reservation_id = r.id
    LEFT JOIN resource res ON res.id = rr.resource_id
    LEFT JOIN dispatch_ticket dt ON dt.reservation_id = r.id
    WHERE r.status = 'booked'
      AND lower(rr.during) > NOW()
      AND (
        r.created_by = ${userId}::uuid
        OR EXISTS (
          SELECT 1 FROM dispatch_ticket dt2
          WHERE dt2.reservation_id = r.id
            AND dt2.pilot_user_id = ${userId}::uuid
            AND dt2.status <> 'voided'
        )
      )
    GROUP BY r.id, lower(rr.during), upper(rr.during), r.series_id, rr.resource_id, res.tail_number, r.created_by
    ORDER BY lower(rr.during) ASC
    LIMIT 20
  `);

  const rows = (result.rows ?? result) as Array<{
    id: string;
    startAt: Date | string;
    endAt: Date | string;
    seriesId: string | null;
    resourceLabel: string;
    isBooker: boolean;
    isPilot: boolean;
  }>;

  // Multiple resources on one reservation produce multiple rows; collapse them,
  // preserving start ASC order and aggregating resource labels + the role flags.
  const byId = new Map<string, MyReservationRow & { _booker: boolean; _pilot: boolean }>();
  for (const r of rows) {
    const existing = byId.get(r.id);
    if (existing) {
      if (r.resourceLabel && !existing.resourceIds.includes(r.resourceLabel)) {
        existing.resourceIds.push(r.resourceLabel);
      }
      existing._booker = existing._booker || r.isBooker === true;
      existing._pilot = existing._pilot || r.isPilot === true;
    } else {
      byId.set(r.id, {
        id: r.id,
        startAt: r.startAt instanceof Date ? r.startAt : new Date(r.startAt),
        endAt:   r.endAt   instanceof Date ? r.endAt   : new Date(r.endAt),
        seriesId: r.seriesId ?? null,
        resourceIds: r.resourceLabel ? [r.resourceLabel] : [],
        role: 'booker', // placeholder; set below
        _booker: r.isBooker === true,
        _pilot: r.isPilot === true,
      });
    }
  }

  return [...byId.values()].map(({ _booker, _pilot, ...row }) => {
    const role: MyReservationRow['role'] =
      _booker && _pilot ? 'booker_and_pilot' : _pilot ? 'pilot' : 'booker';
    return { ...row, role };
  });
}

// ─── readMyAccount ────────────────────────────────────────────────────────────

/**
 * readMyAccount — the caller's OWN identity + OWN free-text tags.
 *
 * Returns null only when the caller has no visible membership row (should not
 * happen for an authenticated session, but fail-closed). Deliberately a strict
 * subset of MemberDetail: NO status / hasLogin / createdBy / other-member data.
 * [VERIFY-6-A]: tags are free-text opaque labels only.
 */
export async function readMyAccount(
  tx: AnyDb,
  userId: string,
): Promise<MyAccountView | null> {
  const identityResult = await tx.execute(sql`
    SELECT
      m.user_id    AS "userId",
      u.full_name  AS "fullName",
      u.email,
      u.phone,
      m.role,
      m.created_at AS "joinedAt"
    FROM membership m
    JOIN app_user u ON u.id = m.user_id
    WHERE m.user_id = ${userId}::uuid
    LIMIT 1
  `);

  const identityRows = (identityResult.rows ?? identityResult) as Array<{
    userId: string;
    fullName: string | null;
    email: string;
    phone: string | null;
    role: string;
    joinedAt: Date | string;
  }>;

  const identity = identityRows[0];
  if (!identity) return null;

  const tagsResult = await tx.execute(sql`
    SELECT id, tag
    FROM member_tag
    WHERE user_id = ${userId}::uuid
    ORDER BY tag ASC
  `);

  const tagRows = (tagsResult.rows ?? tagsResult) as Array<{ id: string; tag: string }>;

  return {
    userId: identity.userId,
    displayName: identity.fullName ?? identity.email,
    email: identity.email,
    phone: identity.phone,
    role: identity.role as MembershipRole,
    joinedAt: identity.joinedAt instanceof Date ? identity.joinedAt : new Date(identity.joinedAt),
    tags: tagRows.map((t) => ({ id: t.id, tag: t.tag })),
  };
}

// ─── assembleMyPortal ─────────────────────────────────────────────────────────

/**
 * assembleMyPortal — the 3-facet self-scoped aggregation inside an existing org
 * context. Mirrors assembleMemberDetail. userId is ALWAYS session.userId.
 *
 * account is non-null for any authenticated portal user; we fall back to a
 * minimal view derived from the (already-validated) session subject if the
 * membership row is somehow invisible (defensive — never expected).
 */
export async function assembleMyPortal(
  tx: AnyDb,
  userId: string,
): Promise<MyPortalSummary> {
  const [account, reservations, training] = await Promise.all([
    readMyAccount(tx, userId),
    readMyReservations(tx, userId),
    readMyTraining(tx, userId),
  ]);

  return {
    account: account ?? {
      userId,
      displayName: userId,
      email: '',
      phone: null,
      role: 'student',
      joinedAt: new Date(0),
      tags: [],
    },
    reservations,
    training,
  };
}
