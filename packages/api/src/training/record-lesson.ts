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
 * STAGE-CHECK GATE (Slice P2-SC1, ADDITIVE):
 *   When the course has enforce_stage_checks=true (operator opt-in, default
 *   OFF — existing arms byte-identical when off), recording a lesson
 *   positioned AFTER a stage-check lesson with no non-voided
 *   stage_check_passed=true record is refused with
 *   { ok:false, reason:'stage_check_required', blockingLessonId }.
 *   Recording the stage-check lesson itself is always allowed.
 *   Optional input stageCheckPassed is VALID ONLY when the target lesson
 *   is_stage_check (else ValidationError); it is written once at INSERT.
 *
 * COMPLIANCE:
 *   grade_label = FREE-TEXT only. NOT a computed ACS/Part-61/141 verdict. [VERIFY-T1-A]
 *   lesson_record = DATA ENTRY RECORD, NOT an e-signature. [VERIFY-T1-C]
 *   instructor_user_id = ANY org member; no CFI-of-record enforcement in T1. [VERIFY-T1-E]
 *   The stage-check gate enforces the OPERATOR's configured course structure
 *   ONLY — NOT a Part-61/141 stage check of record or any FAA determination;
 *   stage_check_passed is an instructor-stated outcome, never computed.
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
import { evaluateStageCheckGate } from './stage-check-gate.js';
import { extractRows } from '../db-rows.js';

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
  /**
   * Instructor-stated pass/fail outcome (Slice P2-SC1). VALID ONLY when the
   * target lesson is_stage_check (else ValidationError). NOT a computed
   * ACS/Part-61/141 verdict. Write-once at INSERT.
   */
  stageCheckPassed: z.boolean().optional(),
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
  /**
   * Instructor-stated pass/fail outcome for a STAGE-CHECK lesson (Slice
   * P2-SC1). Only accepted when the target lesson is_stage_check. NOT a
   * computed ACS/Part-61/141 verdict.
   */
  stageCheckPassed?: boolean;
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
    const enrollRows = extractRows<{
      id: string;
      status: string;
      courseId: string;
    }>(enrollCheck);
    const enroll = enrollRows[0];

    // not_found (invisible/cross-org) vs enrollment_not_active (visible, non-active).
    if (!enroll) return { ok: false, reason: 'not_found' };
    if (enroll.status !== 'active') return { ok: false, reason: 'enrollment_not_active' };

    // 4. Pre-check: lesson belongs to the enrollment's course.
    // (Slice P2-SC1: also reads is_stage_check for the stageCheckPassed
    // input validation + the enforcement gate below.)
    const lessonCheck = await tx.execute(sql`
      SELECT id, is_stage_check AS "isStageCheck" FROM course_lesson
      WHERE id = ${input.lessonId}::uuid
        AND course_id = ${enroll.courseId}::uuid
      LIMIT 1
    `);
    const lessonRows = extractRows<{ id: string; isStageCheck: boolean | string }>(lessonCheck);
    if (lessonRows.length === 0) return { ok: false, reason: 'lesson_not_in_course' };
    const targetIsStageCheck =
      lessonRows[0]!.isStageCheck === true ||
      lessonRows[0]!.isStageCheck === 't' ||
      lessonRows[0]!.isStageCheck === 'true';

    // 4b. stageCheckPassed is VALID ONLY on a stage-check lesson (Slice P2-SC1).
    if (input.stageCheckPassed !== undefined && !targetIsStageCheck) {
      throw new ValidationError(
        '[training] recordLesson: stageCheckPassed is only valid when the target lesson is a stage check',
      );
    }

    // 4c. STAGE-CHECK GATE (Slice P2-SC1, ADDITIVE — only when the operator
    // opted the course in; default OFF ⇒ this block is a no-op and every
    // existing arm is byte-identical). OPERATOR-SET course structure ONLY —
    // NOT a Part-61/141 determination.
    const enforceCheck = await tx.execute(sql`
      SELECT enforce_stage_checks AS "enforceStageChecks"
      FROM course
      WHERE id = ${enroll.courseId}::uuid
      LIMIT 1
    `);
    const enforceRows = extractRows<{ enforceStageChecks: boolean | string }>(enforceCheck);
    const enforceStageChecks =
      enforceRows[0]?.enforceStageChecks === true ||
      enforceRows[0]?.enforceStageChecks === 't' ||
      enforceRows[0]?.enforceStageChecks === 'true';

    if (enforceStageChecks) {
      const gateLessonsResult = await tx.execute(sql`
        SELECT id, position, is_stage_check AS "isStageCheck"
        FROM course_lesson
        WHERE course_id = ${enroll.courseId}::uuid
        ORDER BY position ASC
      `);
      const gateLessons = extractRows<{
        id: string;
        position: number | string;
        isStageCheck: boolean | string;
      }>(gateLessonsResult);

      const gateRecordsResult = await tx.execute(sql`
        SELECT lesson_id AS "lessonId", status, stage_check_passed AS "stageCheckPassed"
        FROM lesson_record
        WHERE enrollment_id = ${input.enrollmentId}::uuid
      `);
      const gateRecords = extractRows<{
        lessonId: string;
        status: string;
        stageCheckPassed: boolean | string | null;
      }>(gateRecordsResult);

      const gate = evaluateStageCheckGate(
        gateLessons.map((l) => ({
          id: l.id,
          sortOrder: typeof l.position === 'string' ? parseInt(l.position, 10) : l.position,
          isStageCheck: l.isStageCheck === true || l.isStageCheck === 't' || l.isStageCheck === 'true',
        })),
        gateRecords.map((r) => ({
          lessonId: r.lessonId,
          voided: r.status === 'voided',
          stageCheckPassed: r.stageCheckPassed == null
            ? null
            : r.stageCheckPassed === true || r.stageCheckPassed === 't' || r.stageCheckPassed === 'true',
        })),
        input.lessonId,
      );
      if (!gate.ok) {
        return { ok: false, reason: 'stage_check_required', blockingLessonId: gate.blockingLessonId };
      }
    }

    // 5. Pre-check: instructor visible in org.
    const instrCheck = await tx.execute(sql`
      SELECT user_id FROM membership
      WHERE user_id = ${input.instructorUserId}::uuid
      LIMIT 1
    `);
    const instrRows = extractRows<{ user_id: string }>(instrCheck);
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
        // Instructor-stated outcome; only reachable on a stage-check lesson
        // (4b above). NULL otherwise. Write-once. (Slice P2-SC1)
        stageCheckPassed: input.stageCheckPassed ?? undefined,
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
