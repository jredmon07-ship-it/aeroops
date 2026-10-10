/**
 * training/types.ts — public result/IO types for the Training API
 * (Slice T1.2, ADR-0011). Framework-agnostic; no I/O.
 *
 * DESIGN POSTURE:
 *   - Operational refusals (not_found, duplicate, has_records, etc.) are RETURNED
 *     as discriminated-union values, NOT thrown. The UI renders them as messages.
 *   - Auth failures are THROWN as ForbiddenError / UnauthenticatedError.
 *   - Validation failures are THROWN as ValidationError.
 *
 * COMPLIANCE POSTURE (ALL HARD LINES):
 *
 *   [VERIFY-T1-A]: grade_label is a FREE-TEXT operator/instructor label ONLY.
 *   It is NOT a computed ACS grade, Part-61/141 verdict, or regulatory outcome.
 *   The system stores and displays whatever text the instructor provides.
 *
 *   [VERIFY-T1-B]: progressRatio and enrollment.status='completed' are operator
 *   content-state flags ONLY. They are NOT a Part-141 80%-completion-rate
 *   determination, graduation, or regulatory certificate. The progress percent
 *   is a content-coverage indicator — completed lessons / total lessons.
 *
 *   [VERIFY-T1-C]: lesson_record is a DATA ENTRY RECORD, NOT an e-signature.
 *   instructor_user_id is an application-user FK; it is NOT a cryptographic
 *   signature, regulatory sign-off, or Part-141 instructor endorsement.
 *   voided_by may be SET NULL on user hard-delete; the durable "who voided"
 *   lives in audit_log, NOT the voided_by column.
 *
 *   [VERIFY-T1-G]: stage_label on a CourseLesson is a FREE-TEXT operator
 *   grouping label (e.g. "Ground School", "Solo Prep"). It is NOT a Part-141
 *   stage or any regulatory curriculum milestone.
 *
 * Training records carry no price or rate data.
 */

import type { EnrollmentStatus, ProgressRatioResult } from '@aeroops/core';

// ─── LessonProgressRow ────────────────────────────────────────────────────────

/**
 * LessonProgressRow — per-lesson completion state within an enrollment detail.
 *
 * `completed` = true when at least one 'recorded' (non-voided) lesson_record
 * exists for this lesson within this enrollment. NOT a regulatory determination.
 * [VERIFY-T1-B]
 *
 * `stage_label` is FREE-TEXT operator grouping. [VERIFY-T1-G]
 */
export interface LessonProgressRow {
  lessonId: string;
  title: string;
  /** FREE-TEXT operator grouping, NOT a Part-141 stage. [VERIFY-T1-G] */
  stageLabel: string | null;
  position: number;
  /** true when a 'recorded' (non-voided) lesson_record exists for this lesson. [VERIFY-T1-B] */
  completed: boolean;
  /**
   * Operator flag (Slice P2-SC1): this lesson is a milestone-evaluation
   * ("stage check") lesson inside the course. NOT a Part-61/141 stage check
   * of record — no regulatory meaning is computed from this flag.
   */
  isStageCheck: boolean;
}

// ─── LessonRecordView ─────────────────────────────────────────────────────────

/**
 * LessonRecordView — one lesson_record row as seen by API callers.
 *
 * WRITE-ONCE fields (set at INSERT, never mutated):
 *   lessonId, instructorUserId, completedAt, gradeLabel, notes, recordedBy.
 *
 * grade_label: FREE-TEXT ONLY — NOT a computed ACS grade, Part-61/141 verdict,
 * or any regulatory outcome. [VERIFY-T1-A]
 *
 * lesson_record is a DATA ENTRY RECORD, NOT an e-signature. [VERIFY-T1-C]
 *
 * Voided records appear in the log with struck-through display (audit history).
 * voided_by may be null if the user was hard-deleted (SET NULL FK). [VERIFY-T1-C]
 */
export interface LessonRecordView {
  id: string;
  lessonId: string;
  /** id of the instructor user. NOT an e-signature FK. [VERIFY-T1-C] */
  instructorUserId: string;
  /** Display name of the instructor (fullName ?? email). */
  instructorName: string;
  /** Write-once data-entry timestamp. NOT a regulated completion timestamp. [VERIFY-T1-C] */
  completedAt: Date;
  /** FREE-TEXT operator/instructor label. NOT a computed ACS/Part-61/141 verdict. [VERIFY-T1-A] */
  gradeLabel: string | null;
  /** Optional free-text instructor notes. Write-once. */
  notes: string | null;
  /**
   * Instructor-entered pass/fail outcome for a STAGE-CHECK lesson record
   * (Slice P2-SC1). NULL on non-stage-check records. Write-once. NOT a
   * computed ACS/Part-61/141 verdict — the instructor states the outcome.
   */
  stageCheckPassed: boolean | null;
  /** 'recorded' | 'voided'. Voided records remain visible in the log (audit history). */
  status: string;
  /** userId who entered the record. Write-once attribution. */
  recordedBy: string;
  /** userId who voided the record; may be null (SET NULL on user hard-delete). [VERIFY-T1-C] */
  voidedBy: string | null;
  /** Operator-required reason for voiding. Non-null when status='voided'. */
  voidedReason: string | null;
  /** Timestamp of void. Non-null when status='voided'. */
  voidedAt: Date | null;
  /** Record creation timestamp. */
  createdAt: Date;
}

// ─── CourseListRow ────────────────────────────────────────────────────────────

/**
 * CourseListRow — one row in the course list (listCourses).
 * Lightweight: identity + status + lesson count.
 */
export interface CourseListRow {
  courseId: string;
  title: string;
  description: string | null;
  /** 'active' | 'archived'. Operator lifecycle flag; NO FAA/regulatory meaning. */
  status: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** Total number of course_lesson rows for this course. */
  lessonCount: number;
}

// ─── CourseDetail ─────────────────────────────────────────────────────────────

/**
 * CourseDetail — full aggregated detail for a single course.
 *
 * Returned by getCourseDetail (and post-write re-reads). Includes the ordered
 * lesson list. All data fetched inside a single org context (no N+1, no
 * cross-org peek).
 */
export interface CourseDetail {
  courseId: string;
  title: string;
  description: string | null;
  /** 'active' | 'archived'. Operator lifecycle flag only. */
  status: string;
  /**
   * Operator opt-in (Slice P2-SC1): when true, recording a lesson positioned
   * AFTER an unpassed stage-check lesson is refused (stage_check_required).
   * Enforces the OPERATOR's course structure ONLY — NOT a Part-61/141
   * determination.
   */
  enforceStageChecks: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Ordered list of lessons (ORDER BY position ASC).
   * stage_label = FREE-TEXT operator grouping. [VERIFY-T1-G]
   */
  lessons: Array<{
    lessonId: string;
    title: string;
    description: string | null;
    /** FREE-TEXT operator grouping, NOT a Part-141 stage. [VERIFY-T1-G] */
    stageLabel: string | null;
    position: number;
    /** Operator flag (Slice P2-SC1). NOT a Part-61/141 stage check of record. */
    isStageCheck: boolean;
    createdBy: string;
    createdAt: Date;
  }>;
}

// ─── EnrollmentListRow ────────────────────────────────────────────────────────

/**
 * EnrollmentListRow — one row in the enrollment list (listEnrollments).
 *
 * Includes the progress ratio for at-a-glance display.
 *
 * [VERIFY-T1-B]: status='completed' and progressRatio are operator content-state
 * flags, NOT Part-141 graduation or regulatory completion.
 */
export interface EnrollmentListRow {
  enrollmentId: string;
  courseId: string;
  courseTitle: string;
  studentUserId: string;
  studentName: string;
  /** Operator lifecycle status. [VERIFY-T1-B]: 'completed' ≠ regulatory graduation. */
  status: EnrollmentStatus;
  enrolledBy: string;
  enrolledAt: Date;
  statusChangedAt: Date | null;
  /**
   * Content-coverage progress ratio. [VERIFY-T1-B]: NOT a Part-141 completion rate.
   * completedCount = DISTINCT lesson_id with a 'recorded' lesson_record.
   * totalLessons = course_lesson count (denominator).
   */
  completedCount: number;
  totalLessons: number;
  /** Math.round(completedCount/totalLessons * 100). 0 when totalLessons=0. [VERIFY-T1-B] */
  progressPercent: number;
}

// ─── EnrollmentDetail ────────────────────────────────────────────────────────

/**
 * EnrollmentDetail — full aggregated detail for a single enrollment.
 *
 * The core view: progress summary + per-lesson completion checklist +
 * full record log (voided records shown for audit history).
 *
 * [VERIFY-T1-B]: progressRatio.percent is a content-coverage indicator,
 * NOT a Part-141 80%-completion-rate determination or graduation criterion.
 *
 * [VERIFY-T1-A]: gradeLabel on each record is FREE-TEXT only.
 * [VERIFY-T1-C]: lesson_record is a data-entry record, NOT an e-signature.
 */
export interface EnrollmentDetail {
  enrollmentId: string;
  courseId: string;
  courseTitle: string;
  studentUserId: string;
  studentName: string;
  /** 'active' | 'completed' | 'withdrawn'. [VERIFY-T1-B]: operator flag, not reg determination. */
  status: EnrollmentStatus;
  enrolledBy: string;
  enrolledAt: Date;
  statusChangedAt: Date | null;
  /**
   * Per-lesson completion checklist (all lessons of the course, ordered by position).
   * completed=true when a 'recorded' lesson_record exists for this lesson. [VERIFY-T1-B]
   */
  lessonProgress: LessonProgressRow[];
  /**
   * Full record log for this enrollment (all records incl. voided, newest-first).
   * Voided records remain visible (audit history — struck-through in UI). [VERIFY-T1-C]
   */
  records: LessonRecordView[];
  /**
   * Progress ratio (content coverage). [VERIFY-T1-B]: NOT a Part-141 determination.
   * completedCount = DISTINCT lesson_id with a 'recorded' record.
   * totalLessons   = course_lesson count.
   * ratio clamped [0,1]; percent = Math.round(ratio * 100).
   */
  progressRatio: ProgressRatioResult;
}

// ─── MemberEnrollmentRow (People-detail Training facet) ────────────────────────

/**
 * MemberEnrollmentRow — one enrollment for the People-detail Training card.
 *
 * Returned by listEnrollmentsForMember. Lightweight summary: the most relevant
 * fields for a "Training" card on the member detail page.
 *
 * [VERIFY-T1-B]: progressRatio and status='completed' are operator content-state
 * flags, NOT Part-141 graduation or regulatory completion.
 */
export interface MemberEnrollmentRow {
  enrollmentId: string;
  courseId: string;
  courseTitle: string;
  /** 'active' | 'completed' | 'withdrawn'. Operator flag. [VERIFY-T1-B] */
  status: EnrollmentStatus;
  enrolledAt: Date;
  statusChangedAt: Date | null;
  /** DISTINCT recorded lesson count. [VERIFY-T1-B]: NOT a regulatory completion count. */
  completedCount: number;
  totalLessons: number;
  /**
   * Content-coverage progress ratio. [VERIFY-T1-B]: NOT a Part-141 determination.
   * percent = Math.round(completedCount/totalLessons * 100). 0 when totalLessons=0.
   */
  progressRatio: ProgressRatioResult;
}

// ─── LessonSignatureView (Slice P2-ESIGN) ─────────────────────────────────────

/**
 * LessonSignatureView — one lesson_signature row as seen by API callers.
 *
 * COMPLIANCE HARD LINE [VERIFY-P2-A]: a lesson_signature is an operator/
 * instructor ATTESTATION artifact — a record of who signed, when, what they
 * attested to, and a content hash of the signed lesson_record snapshot. It is
 * NOT an FAA-recognized digital/electronic signature, NOT a §61.51 / §61.65 /
 * Part-141 endorsement of record, and it computes NO training-completion,
 * stage, graduation, or currency determination of any kind. role_at_signing
 * is a snapshot of the signer's operator role at signing time; a later role
 * change never rewrites a past attestation. A stored signature does not
 * verify eligibility, endorsement validity, or airworthiness — a human still
 * makes every regulatory call.
 *
 * `contentHash` is a TAMPER-EVIDENCE digest (sha256 of
 * canonicalLessonRecordSnapshot, @aeroops/core) — NOT a cryptographic/PKI
 * signature.
 *
 * `isTombstone` = true when this row itself voids another signature
 * (`voidedBySignatureId` is set on the TARGET record it appears in — see
 * getLessonSignatures for the exact aggregation). `isVoided` = true when some
 * OTHER (tombstone) row in the same set voids this row. A tombstone's own
 * `isVoided` is always false (a tombstone can never itself be voided).
 */
export interface LessonSignatureView {
  id: string;
  lessonRecordId: string;
  /** Always session.userId at the time this row was inserted — never another user's id. */
  signerUserId: string;
  /** Display name of the signer (fullName ?? email). */
  signerName: string;
  /** Snapshot of the signer's membership.role AT SIGNING TIME. */
  roleAtSigning: string;
  /** FREE-TEXT: what the signer attested to. On a tombstone, the void reason. */
  attestationText: string;
  /** sha256 tamper-evidence digest. NOT a cryptographic/PKI signature. [VERIFY-P2-A] */
  contentHash: string;
  /** Non-null when this row IS a tombstone: the id of the signature it voids. */
  voidedBySignatureId: string | null;
  /** true when voidedBySignatureId is non-null (this row is itself a tombstone). */
  isTombstone: boolean;
  /** true when some tombstone row in the set references this row's id. Always false for a tombstone. */
  isVoided: boolean;
  signedAt: Date;
  createdAt: Date;
}

// ─── Result unions ────────────────────────────────────────────────────────────

// Reads

/** listCourses result */
export type ListCoursesResult = CourseListRow[];

/** getCourseDetail result */
export type GetCourseDetailResult =
  | { ok: true; course: CourseDetail }
  | { ok: false; reason: 'not_found' };

/** listEnrollments result */
export type ListEnrollmentsResult = EnrollmentListRow[];

/** getEnrollmentDetail result */
export type GetEnrollmentDetailResult =
  | { ok: true; enrollment: EnrollmentDetail }
  | { ok: false; reason: 'not_found' };

/** listEnrollmentsForMember result (People-detail Training facet) */
export type ListEnrollmentsForMemberResult = MemberEnrollmentRow[];

// Writes

/** createCourse result */
export type CreateCourseResult =
  | { ok: true; course: CourseDetail }
  | { ok: false; reason: 'not_found' };

/** addCourseLesson result */
export type AddCourseLessonResult =
  | { ok: true; course: CourseDetail }
  | { ok: false; reason: 'not_found' };

/** removeCourseLesson result */
export type RemoveCourseLessonResult =
  | { ok: true; course: CourseDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'has_records' };

/** enrollMember result */
export type EnrollMemberResult =
  | { ok: true; enrollment: EnrollmentDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'duplicate' };

/** setEnrollmentStatus result */
export type SetEnrollmentStatusResult =
  | { ok: true; enrollment: EnrollmentDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_transition' };

/**
 * recordLesson result.
 *
 * stage_check_required (Slice P2-SC1): the course has enforce_stage_checks
 * = true and an EARLIER stage-check lesson (blockingLessonId) has no
 * non-voided record with stage_check_passed = true. OPERATOR-SET gate only
 * — NOT a Part-61/141 determination.
 */
export type RecordLessonResult =
  | { ok: true; enrollment: EnrollmentDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'lesson_not_in_course' }
  | { ok: false; reason: 'enrollment_not_active' }
  | { ok: false; reason: 'stage_check_required'; blockingLessonId: string };

/** setLessonStageCheck result (Slice P2-SC1) */
export type SetLessonStageCheckResult =
  | { ok: true; course: CourseDetail }
  | { ok: false; reason: 'not_found' };

/** setCourseStageCheckEnforcement result (Slice P2-SC1) */
export type SetCourseStageCheckEnforcementResult =
  | { ok: true; course: CourseDetail }
  | { ok: false; reason: 'not_found' };

/** voidLessonRecord result */
export type VoidLessonRecordResult =
  | { ok: true; enrollment: EnrollmentDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'already_voided' };

// ─── Slice P2-ESIGN result unions ─────────────────────────────────────────────

/** signLessonRecord result */
export type SignLessonRecordResult =
  | { ok: true; signatures: LessonSignatureView[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'already_signed' };

/** voidLessonSignature result */
export type VoidLessonSignatureResult =
  | { ok: true; signatures: LessonSignatureView[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'cannot_void_tombstone' }
  | { ok: false; reason: 'already_voided' };

/** getLessonSignatures result */
export type GetLessonSignaturesResult = LessonSignatureView[];
