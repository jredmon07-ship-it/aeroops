/**
 * training/internal.ts — tx-level helpers for training reads and writes.
 *
 * NOT exported from @aeroops/api. Holds:
 *   assembleCourseDetail(tx, courseId)      — full course aggregation inside an
 *     existing org context (RLS-scoped by the caller). Used by getCourseDetail
 *     (read) AND by post-write re-reads so both paths share exactly the same
 *     query logic and can never diverge.
 *
 *   assembleEnrollmentDetail(tx, enrollmentId) — full enrollment aggregation inside
 *     an existing org context. ≤4 RLS-scoped queries, NO N+1.
 *     completedCount = DISTINCT recorded lesson_id mapping to a current course lesson.
 *     Voided records shown in the log but excluded from completedCount.
 *     progressRatio via progressRatioFromCounts(@aeroops/core). [VERIFY-T1-B]
 *
 * INVARIANT: All helpers accept an AnyDb tx with org GUC already set by the
 * caller's withSessionOrgContextWithDb. They NEVER set GUC themselves.
 *
 * [VERIFY-T1-A]: grade_label is FREE-TEXT only. No regulatory meaning.
 * [VERIFY-T1-B]: progress = content ratio only. NOT a regulatory determination.
 * [VERIFY-T1-C]: lesson_record is a data-entry record, NOT an e-signature.
 * [VERIFY-T1-G]: stage_label is FREE-TEXT grouping, NOT a Part-141 stage.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { progressRatioFromCounts } from '@aeroops/core';
import type {
  CourseDetail,
  EnrollmentDetail,
  LessonProgressRow,
  LessonRecordView,
  LessonSignatureView,
} from './types.js';
import { extractRows } from '../db-rows.js';

// ─── assembleCourseDetail ──────────────────────────────────────────────────────

/**
 * assembleCourseDetail — full course-detail aggregation inside an existing org
 * context (RLS-scoped by the caller's withSessionOrgContextWithDb).
 *
 * Returns null when the courseId is not visible (cross-org RLS blocks it).
 * Callers map null → not_found.
 *
 * Runs 2 queries: course identity + ordered lessons.
 * NEVER sets org GUC itself.
 */
export async function assembleCourseDetail(
  tx: AnyDb,
  courseId: string,
): Promise<CourseDetail | null> {
  // ── 1. Course identity (RLS-scoped) ─────────────────────────────────────────
  const courseResult = await tx.execute(sql`
    SELECT
      id                   AS "courseId",
      title,
      description,
      status,
      enforce_stage_checks AS "enforceStageChecks",
      created_by           AS "createdBy",
      created_at           AS "createdAt",
      updated_at           AS "updatedAt"
    FROM course
    WHERE id = ${courseId}::uuid
    LIMIT 1
  `);

  const courseRows = extractRows<{
    courseId: string;
    title: string;
    description: string | null;
    status: string;
    enforceStageChecks: boolean | string;
    createdBy: string;
    createdAt: Date | string;
    updatedAt: Date | string;
  }>(courseResult);

  const courseRow = courseRows[0];
  if (!courseRow) return null;

  // ── 2. Ordered lessons (RLS-scoped, ORDER BY position ASC) ─────────────────
  // [VERIFY-T1-G]: stage_label is FREE-TEXT grouping, NOT a Part-141 stage.
  const lessonsResult = await tx.execute(sql`
    SELECT
      id             AS "lessonId",
      title,
      description,
      stage_label    AS "stageLabel",
      position,
      is_stage_check AS "isStageCheck",
      created_by     AS "createdBy",
      created_at     AS "createdAt"
    FROM course_lesson
    WHERE course_id = ${courseId}::uuid
    ORDER BY position ASC
  `);

  const lessonRows = extractRows<{
    lessonId: string;
    title: string;
    description: string | null;
    stageLabel: string | null;
    position: number;
    isStageCheck: boolean | string;
    createdBy: string;
    createdAt: Date | string;
  }>(lessonsResult);

  return {
    courseId:    courseRow.courseId,
    title:       courseRow.title,
    description: courseRow.description ?? null,
    status:      courseRow.status,
    // Operator opt-in (Slice P2-SC1) — NOT a Part-61/141 determination.
    enforceStageChecks:
      courseRow.enforceStageChecks === true ||
      courseRow.enforceStageChecks === 't' ||
      courseRow.enforceStageChecks === 'true',
    createdBy:   courseRow.createdBy,
    createdAt:   courseRow.createdAt instanceof Date ? courseRow.createdAt : new Date(courseRow.createdAt),
    updatedAt:   courseRow.updatedAt instanceof Date ? courseRow.updatedAt : new Date(courseRow.updatedAt),
    lessons:     lessonRows.map((l) => ({
      lessonId:    l.lessonId,
      title:       l.title,
      description: l.description ?? null,
      stageLabel:  l.stageLabel ?? null,
      position:    typeof l.position === 'string' ? parseInt(l.position, 10) : l.position,
      // Operator flag (Slice P2-SC1) — NOT a Part-61/141 stage check of record.
      isStageCheck: l.isStageCheck === true || l.isStageCheck === 't' || l.isStageCheck === 'true',
      createdBy:   l.createdBy,
      createdAt:   l.createdAt instanceof Date ? l.createdAt : new Date(l.createdAt),
    })),
  };
}

// ─── assembleEnrollmentDetail ─────────────────────────────────────────────────

/**
 * assembleEnrollmentDetail — full enrollment-detail aggregation inside an existing
 * org context (RLS-scoped by the caller's withSessionOrgContextWithDb).
 *
 * Returns null when the enrollmentId is not visible (cross-org RLS blocks it).
 * Callers map null → not_found.
 *
 * Query plan (≤4 RLS-scoped queries, no N+1):
 *   Q1: enrollment identity JOIN course JOIN app_user (student name)
 *   Q2: course lessons (denominator) ordered by position, WITH per-lesson
 *       completed boolean (subquery DISTINCT recorded lesson_ids for this enrollment)
 *   Q3: this enrollment's lesson_records (all incl. voided, newest-first),
 *       JOIN app_user for instructor display name
 *   Assemble: completedCount = DISTINCT recorded lesson_ids from Q3 that appear
 *             in the current course lessons (Q2). progressRatio via core fn.
 *
 * [VERIFY-T1-B]: completedCount and progressRatio are content ratios, NOT
 * regulatory completion-rate determinations. [VERIFY-T1-C]: records are data
 * entry, NOT e-signatures. [VERIFY-T1-A]: grade_label is FREE-TEXT only.
 *
 * NEVER sets org GUC itself.
 */
export async function assembleEnrollmentDetail(
  tx: AnyDb,
  enrollmentId: string,
): Promise<EnrollmentDetail | null> {
  // ── Q1: Enrollment identity + course title + student name ────────────────────
  const enrollmentResult = await tx.execute(sql`
    SELECT
      e.id                  AS "enrollmentId",
      e.course_id           AS "courseId",
      c.title               AS "courseTitle",
      e.student_user_id     AS "studentUserId",
      COALESCE(u.full_name, u.email) AS "studentName",
      e.status,
      e.enrolled_by         AS "enrolledBy",
      e.enrolled_at         AS "enrolledAt",
      e.status_changed_at   AS "statusChangedAt"
    FROM enrollment e
    JOIN course c ON c.id = e.course_id
    JOIN app_user u ON u.id = e.student_user_id
    WHERE e.id = ${enrollmentId}::uuid
    LIMIT 1
  `);

  const enrollRows = extractRows<{
    enrollmentId: string;
    courseId: string;
    courseTitle: string;
    studentUserId: string;
    studentName: string;
    status: string;
    enrolledBy: string;
    enrolledAt: Date | string;
    statusChangedAt: Date | string | null;
  }>(enrollmentResult);

  const enroll = enrollRows[0];
  if (!enroll) return null;

  // ── Q2: Course lessons (denominator) + completed booleans ────────────────────
  // completed = EXISTS a 'recorded' lesson_record for this enrollment + lesson.
  // [VERIFY-T1-B]: per-lesson completed = content flag, NOT a regulatory determination.
  const lessonsResult = await tx.execute(sql`
    SELECT
      cl.id             AS "lessonId",
      cl.title,
      cl.stage_label    AS "stageLabel",
      cl.position,
      cl.is_stage_check AS "isStageCheck",
      EXISTS (
        SELECT 1 FROM lesson_record lr
        WHERE lr.lesson_id = cl.id
          AND lr.enrollment_id = ${enrollmentId}::uuid
          AND lr.status = 'recorded'
      ) AS "completed"
    FROM course_lesson cl
    WHERE cl.course_id = ${enroll.courseId}::uuid
    ORDER BY cl.position ASC
  `);

  const lessonRows = extractRows<{
    lessonId: string;
    title: string;
    stageLabel: string | null;
    position: number | string;
    isStageCheck: boolean | string;
    completed: boolean | string;
  }>(lessonsResult);

  const lessonProgress: LessonProgressRow[] = lessonRows.map((l) => ({
    lessonId:   l.lessonId,
    title:      l.title,
    stageLabel: l.stageLabel ?? null,
    position:   typeof l.position === 'string' ? parseInt(l.position, 10) : l.position,
    completed:  l.completed === true || l.completed === 't' || l.completed === 'true',
    // Operator flag (Slice P2-SC1) — NOT a Part-61/141 stage check of record.
    isStageCheck: l.isStageCheck === true || l.isStageCheck === 't' || l.isStageCheck === 'true',
  }));

  // ── Q3: Lesson records for this enrollment (incl. voided, newest-first) ─────
  // Joins app_user for instructor name display.
  // [VERIFY-T1-A]: grade_label is FREE-TEXT. [VERIFY-T1-C]: NOT an e-signature.
  const recordsResult = await tx.execute(sql`
    SELECT
      lr.id                 AS "id",
      lr.lesson_id          AS "lessonId",
      lr.instructor_user_id AS "instructorUserId",
      COALESCE(iu.full_name, iu.email) AS "instructorName",
      lr.completed_at       AS "completedAt",
      lr.grade_label        AS "gradeLabel",
      lr.notes,
      lr.stage_check_passed AS "stageCheckPassed",
      lr.status,
      lr.recorded_by        AS "recordedBy",
      lr.voided_by          AS "voidedBy",
      lr.voided_reason      AS "voidedReason",
      lr.voided_at          AS "voidedAt",
      lr.created_at         AS "createdAt"
    FROM lesson_record lr
    JOIN app_user iu ON iu.id = lr.instructor_user_id
    WHERE lr.enrollment_id = ${enrollmentId}::uuid
    ORDER BY lr.created_at DESC
  `);

  const recordRows = extractRows<{
    id: string;
    lessonId: string;
    instructorUserId: string;
    instructorName: string;
    completedAt: Date | string;
    gradeLabel: string | null;
    notes: string | null;
    stageCheckPassed: boolean | string | null;
    status: string;
    recordedBy: string;
    voidedBy: string | null;
    voidedReason: string | null;
    voidedAt: Date | string | null;
    createdAt: Date | string;
  }>(recordsResult);

  const records: LessonRecordView[] = recordRows.map((r) => ({
    id:               r.id,
    lessonId:         r.lessonId,
    instructorUserId: r.instructorUserId,
    instructorName:   r.instructorName,
    completedAt:      r.completedAt instanceof Date ? r.completedAt : new Date(r.completedAt),
    gradeLabel:       r.gradeLabel ?? null,
    notes:            r.notes ?? null,
    // Instructor-entered outcome (Slice P2-SC1) — NOT a computed verdict.
    stageCheckPassed: r.stageCheckPassed == null
      ? null
      : r.stageCheckPassed === true || r.stageCheckPassed === 't' || r.stageCheckPassed === 'true',
    status:           r.status,
    recordedBy:       r.recordedBy,
    voidedBy:         r.voidedBy ?? null,
    voidedReason:     r.voidedReason ?? null,
    voidedAt:         r.voidedAt != null
      ? (r.voidedAt instanceof Date ? r.voidedAt : new Date(r.voidedAt))
      : null,
    createdAt:        r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
  }));

  // ── Assemble: completedCount = DISTINCT lesson_ids with a 'recorded' record ─
  // Voided records are excluded from the numerator.
  // [VERIFY-T1-B]: content ratio only.
  const lessonIdSet = new Set(lessonProgress.map((l) => l.lessonId));
  const completedLessonIds = new Set(
    records
      .filter((r) => r.status === 'recorded' && lessonIdSet.has(r.lessonId))
      .map((r) => r.lessonId),
  );
  const completedCount = completedLessonIds.size;
  const totalLessons   = lessonProgress.length;
  const progressRatio  = progressRatioFromCounts(completedCount, totalLessons);

  return {
    enrollmentId:    enroll.enrollmentId,
    courseId:        enroll.courseId,
    courseTitle:     enroll.courseTitle,
    studentUserId:   enroll.studentUserId,
    studentName:     enroll.studentName,
    status:          enroll.status as EnrollmentDetail['status'],
    enrolledBy:      enroll.enrolledBy,
    enrolledAt:      enroll.enrolledAt instanceof Date ? enroll.enrolledAt : new Date(enroll.enrolledAt),
    statusChangedAt: enroll.statusChangedAt != null
      ? (enroll.statusChangedAt instanceof Date ? enroll.statusChangedAt : new Date(enroll.statusChangedAt))
      : null,
    lessonProgress,
    records,
    progressRatio,
  };
}

// ─── assembleLessonSignatures (Slice P2-ESIGN) ────────────────────────────────

/**
 * assembleLessonSignatures — full signature list for a single lesson_record,
 * newest-first, inside an existing org context (RLS-scoped by the caller's
 * withSessionOrgContextWithDb). ONE query, no N+1.
 *
 * `isTombstone` = voided_by_signature_id IS NOT NULL (this row itself voids
 * another signature). `isVoided` = some OTHER row in the table references
 * this row's id as its voided_by_signature_id — computed via a correlated
 * EXISTS so a tombstone can never read as voided (nothing may target a
 * tombstone; enforced in the command layer).
 *
 * COMPLIANCE [VERIFY-P2-A]: a lesson_signature is an operator/instructor
 * ATTESTATION artifact, NOT an FAA-recognized digital/electronic signature or
 * §61/§141 endorsement of record. contentHash is a tamper-evidence digest
 * only.
 *
 * NEVER sets org GUC itself.
 */
export async function assembleLessonSignatures(
  tx: AnyDb,
  lessonRecordId: string,
): Promise<LessonSignatureView[]> {
  const result = await tx.execute(sql`
    SELECT
      ls.id                       AS "id",
      ls.lesson_record_id         AS "lessonRecordId",
      ls.signer_user_id           AS "signerUserId",
      COALESCE(su.full_name, su.email) AS "signerName",
      ls.role_at_signing          AS "roleAtSigning",
      ls.attestation_text         AS "attestationText",
      ls.content_hash             AS "contentHash",
      ls.voided_by_signature_id   AS "voidedBySignatureId",
      ls.signed_at                AS "signedAt",
      ls.created_at               AS "createdAt",
      EXISTS (
        SELECT 1 FROM lesson_signature t
        WHERE t.voided_by_signature_id = ls.id
      ) AS "isVoided"
    FROM lesson_signature ls
    JOIN app_user su ON su.id = ls.signer_user_id
    WHERE ls.lesson_record_id = ${lessonRecordId}::uuid
    ORDER BY ls.created_at DESC
  `);

  const rows = extractRows<{
    id: string;
    lessonRecordId: string;
    signerUserId: string;
    signerName: string;
    roleAtSigning: string;
    attestationText: string;
    contentHash: string;
    voidedBySignatureId: string | null;
    signedAt: Date | string;
    createdAt: Date | string;
    isVoided: boolean | string;
  }>(result);

  return rows.map((r) => ({
    id:                  r.id,
    lessonRecordId:      r.lessonRecordId,
    signerUserId:        r.signerUserId,
    signerName:          r.signerName,
    roleAtSigning:       r.roleAtSigning,
    attestationText:     r.attestationText,
    contentHash:         r.contentHash,
    voidedBySignatureId: r.voidedBySignatureId ?? null,
    isTombstone:         r.voidedBySignatureId != null,
    isVoided:            r.isVoided === true || r.isVoided === 't' || r.isVoided === 'true',
    signedAt:            r.signedAt instanceof Date ? r.signedAt : new Date(r.signedAt),
    createdAt:           r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
  }));
}
