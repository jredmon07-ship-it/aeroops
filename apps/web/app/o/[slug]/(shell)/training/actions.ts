/**
 * training/actions.ts — Server actions for the Training module (Slice T1.3).
 *
 * Pattern mirrors people/actions.ts and fleet/actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability inside the fn).
 *   3. Map ForbiddenError / UnauthenticatedError → { error: 'forbidden'|'unauthenticated' }.
 *   4. Map ValidationError (code === 'VALIDATION') → { error: 'validation', message }.
 *   5. Pass through ok:false arms as-is (operational refusals are values, not errors).
 *
 * Dates are serialized to ISO strings at the action boundary so RSC → client
 * components receive plain JSON (Dates are NOT JSON-serializable).
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + org_id scoping are enforced inside the API functions.
 *
 * COMPLIANCE POSTURE (ALL HARD LINES):
 *   [VERIFY-T1-A]: grade_label is FREE-TEXT only — NOT a computed ACS/Part-61/141 verdict.
 *   [VERIFY-T1-B]: progressRatio and enrollment.status='completed' are operator
 *     content-state flags ONLY — NOT Part-141 graduation or regulatory completion.
 *   [VERIFY-T1-C]: lesson_record is DATA ENTRY, NOT an e-signature.
 *   [VERIFY-T1-G]: stage_label is FREE-TEXT operator grouping, NOT a Part-141 stage.
 */
'use server';

import { serializeDate } from '@/lib/serialize-date';

import { actionAuth as auth } from '@/lib/action-auth';
import {
  listCourses,
  getCourseDetail,
  listEnrollments,
  getEnrollmentDetail,
  listEnrollmentsForMember,
  createCourse,
  addCourseLesson,
  removeCourseLesson,
  enrollMember,
  setEnrollmentStatus,
  recordLesson,
  voidLessonRecord,
  setLessonStageCheck,
  setCourseStageCheckEnforcement,
  signLessonRecord,
  voidLessonSignature,
  getLessonSignatures,
} from '@aeroops/api';
import type {
  CourseListRow,
  CourseDetail,
  EnrollmentListRow,
  EnrollmentDetail,
  LessonProgressRow,
  LessonRecordView,
  MemberEnrollmentRow,
  LessonSignatureView,
  ListCoursesOptions,
  ListEnrollmentsOptions,
  GetCourseDetailInput,
  GetEnrollmentDetailInput,
  ListEnrollmentsForMemberInput,
  CreateCourseInput,
  AddCourseLessonInput,
  RemoveCourseLessonInput,
  EnrollMemberInput,
  SetEnrollmentStatusInput,
  RecordLessonInput,
  VoidLessonRecordInput,
  SetLessonStageCheckInput,
  SetCourseStageCheckEnforcementInput,
  SignLessonRecordInput,
  VoidLessonSignatureInput,
  GetLessonSignaturesInput,
} from '@aeroops/api';
import type { ProgressRatioResult } from '@aeroops/core';

// ─── Serialized types (Dates → string) ────────────────────────────────────────

export interface SerializedLessonProgressRow {
  lessonId: string;
  title: string;
  /** FREE-TEXT operator grouping, NOT a Part-141 stage. [VERIFY-T1-G] */
  stageLabel: string | null;
  position: number;
  /** true when a 'recorded' lesson_record exists for this lesson. [VERIFY-T1-B] */
  completed: boolean;
  /** Operator flag (Slice P2-SC1). NOT a Part-61/141 stage check of record. */
  isStageCheck: boolean;
}

export interface SerializedLessonRecordView {
  id: string;
  lessonId: string;
  instructorUserId: string;
  instructorName: string;
  completedAt: string;
  /** FREE-TEXT operator/instructor label. NOT a computed ACS/Part-61/141 verdict. [VERIFY-T1-A] */
  gradeLabel: string | null;
  notes: string | null;
  /**
   * Instructor-stated pass/fail for a stage-check record (Slice P2-SC1).
   * NULL on non-stage-check records. NOT a computed ACS/Part-61/141 verdict.
   */
  stageCheckPassed: boolean | null;
  status: string;
  recordedBy: string;
  voidedBy: string | null;
  voidedReason: string | null;
  voidedAt: string | null;
  createdAt: string;
}

export interface SerializedCourseDetail {
  courseId: string;
  title: string;
  description: string | null;
  status: string;
  /**
   * Operator opt-in (Slice P2-SC1): blocks recording lessons past an
   * unpassed stage check. Enforces the OPERATOR's course structure — NOT a
   * Part-61/141 determination.
   */
  enforceStageChecks: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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
    createdAt: string;
  }>;
}

export interface SerializedProgressRatioResult {
  completed: number;
  total: number;
  ratio: number;
  percent: number;
}

export interface SerializedEnrollmentDetail {
  enrollmentId: string;
  courseId: string;
  courseTitle: string;
  studentUserId: string;
  studentName: string;
  /** 'active' | 'completed' | 'withdrawn'. [VERIFY-T1-B]: operator flag, not reg determination. */
  status: string;
  enrolledBy: string;
  enrolledAt: string;
  statusChangedAt: string | null;
  /** Per-lesson completion checklist. [VERIFY-T1-B] */
  lessonProgress: SerializedLessonProgressRow[];
  /** Full record log (incl. voided). [VERIFY-T1-C] */
  records: SerializedLessonRecordView[];
  /**
   * Content-coverage progress ratio. [VERIFY-T1-B]: NOT a Part-141 determination.
   */
  progressRatio: SerializedProgressRatioResult;
}

/**
 * SerializedLessonSignatureView — Dates → ISO strings for client components.
 *
 * COMPLIANCE HARD LINE [VERIFY-P2-A]: a lesson_signature is an operator/
 * instructor ATTESTATION artifact — NOT an FAA-recognized digital/electronic
 * signature, NOT a §61.51/§61.65/Part-141 endorsement of record, and
 * computes NO training-completion/stage/graduation/currency determination.
 * contentHash is a TAMPER-EVIDENCE digest only — NOT a cryptographic/PKI
 * signature.
 */
export interface SerializedLessonSignatureView {
  id: string;
  lessonRecordId: string;
  signerUserId: string;
  signerName: string;
  roleAtSigning: string;
  attestationText: string;
  contentHash: string;
  voidedBySignatureId: string | null;
  isTombstone: boolean;
  isVoided: boolean;
  signedAt: string;
  createdAt: string;
}

export interface SerializedMemberEnrollmentRow {
  enrollmentId: string;
  courseId: string;
  courseTitle: string;
  /** 'active' | 'completed' | 'withdrawn'. Operator flag. [VERIFY-T1-B] */
  status: string;
  enrolledAt: string;
  statusChangedAt: string | null;
  completedCount: number;
  totalLessons: number;
  /** Content-coverage ratio. [VERIFY-T1-B] */
  progressRatio: SerializedProgressRatioResult;
}

// ─── Error shapes ──────────────────────────────────────────────────────────────

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

// ─── Date serialization helpers ────────────────────────────────────────────────
function serializeProgressRatio(r: ProgressRatioResult): SerializedProgressRatioResult {
  return {
    completed: r.completed,
    total: r.total,
    ratio: r.ratio,
    percent: r.percent,
  };
}

function serializeLessonProgressRow(r: LessonProgressRow): SerializedLessonProgressRow {
  return {
    lessonId: r.lessonId,
    title: r.title,
    stageLabel: r.stageLabel,
    position: r.position,
    completed: r.completed,
    isStageCheck: r.isStageCheck,
  };
}

function serializeLessonRecord(r: LessonRecordView): SerializedLessonRecordView {
  return {
    id: r.id,
    lessonId: r.lessonId,
    instructorUserId: r.instructorUserId,
    instructorName: r.instructorName,
    completedAt: serializeDate(r.completedAt) ?? '',
    gradeLabel: r.gradeLabel,
    notes: r.notes,
    stageCheckPassed: r.stageCheckPassed,
    status: r.status,
    recordedBy: r.recordedBy,
    voidedBy: r.voidedBy,
    voidedReason: r.voidedReason,
    voidedAt: serializeDate(r.voidedAt),
    createdAt: serializeDate(r.createdAt) ?? '',
  };
}

function serializeCourseDetail(c: CourseDetail): SerializedCourseDetail {
  return {
    courseId: c.courseId,
    title: c.title,
    description: c.description,
    status: c.status,
    enforceStageChecks: c.enforceStageChecks,
    createdBy: c.createdBy,
    createdAt: serializeDate(c.createdAt) ?? '',
    updatedAt: serializeDate(c.updatedAt) ?? '',
    lessons: c.lessons.map((l) => ({
      lessonId: l.lessonId,
      title: l.title,
      description: l.description,
      stageLabel: l.stageLabel,
      position: l.position,
      isStageCheck: l.isStageCheck,
      createdBy: l.createdBy,
      createdAt: serializeDate(l.createdAt) ?? '',
    })),
  };
}

function serializeEnrollmentDetail(e: EnrollmentDetail): SerializedEnrollmentDetail {
  return {
    enrollmentId: e.enrollmentId,
    courseId: e.courseId,
    courseTitle: e.courseTitle,
    studentUserId: e.studentUserId,
    studentName: e.studentName,
    status: e.status,
    enrolledBy: e.enrolledBy,
    enrolledAt: serializeDate(e.enrolledAt) ?? '',
    statusChangedAt: serializeDate(e.statusChangedAt),
    lessonProgress: e.lessonProgress.map(serializeLessonProgressRow),
    records: e.records.map(serializeLessonRecord),
    progressRatio: serializeProgressRatio(e.progressRatio),
  };
}

function serializeLessonSignature(s: LessonSignatureView): SerializedLessonSignatureView {
  return {
    id: s.id,
    lessonRecordId: s.lessonRecordId,
    signerUserId: s.signerUserId,
    signerName: s.signerName,
    roleAtSigning: s.roleAtSigning,
    attestationText: s.attestationText,
    contentHash: s.contentHash,
    voidedBySignatureId: s.voidedBySignatureId,
    isTombstone: s.isTombstone,
    isVoided: s.isVoided,
    signedAt: serializeDate(s.signedAt) ?? '',
    createdAt: serializeDate(s.createdAt) ?? '',
  };
}

function serializeMemberEnrollmentRow(r: MemberEnrollmentRow): SerializedMemberEnrollmentRow {
  return {
    enrollmentId: r.enrollmentId,
    courseId: r.courseId,
    courseTitle: r.courseTitle,
    status: r.status,
    enrolledAt: serializeDate(r.enrolledAt) ?? '',
    statusChangedAt: serializeDate(r.statusChangedAt),
    completedCount: r.completedCount,
    totalLessons: r.totalLessons,
    progressRatio: serializeProgressRatio(r.progressRatio),
  };
}

// ─── listCoursesAction ─────────────────────────────────────────────────────────

export type ListCoursesActionResult =
  | { ok: true; courses: CourseListRow[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listCoursesAction(
  opts?: ListCoursesOptions,
): Promise<ListCoursesActionResult> {
  const session = await auth();
  try {
    const courses = await listCourses(session, opts);
    return { ok: true, courses };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── getCourseDetailAction ─────────────────────────────────────────────────────

export type GetCourseDetailActionResult =
  | { ok: true; course: SerializedCourseDetail }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getCourseDetailAction(
  input: GetCourseDetailInput,
): Promise<GetCourseDetailActionResult> {
  const session = await auth();
  try {
    const result = await getCourseDetail(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, course: serializeCourseDetail(result.course) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── listEnrollmentsAction ─────────────────────────────────────────────────────

export type ListEnrollmentsActionResult =
  | { ok: true; enrollments: EnrollmentListRow[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listEnrollmentsAction(
  opts?: ListEnrollmentsOptions,
): Promise<ListEnrollmentsActionResult> {
  const session = await auth();
  try {
    const enrollments = await listEnrollments(session, opts);
    return { ok: true, enrollments };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── getEnrollmentDetailAction ─────────────────────────────────────────────────

export type GetEnrollmentDetailActionResult =
  | { ok: true; enrollment: SerializedEnrollmentDetail }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getEnrollmentDetailAction(
  input: GetEnrollmentDetailInput,
): Promise<GetEnrollmentDetailActionResult> {
  const session = await auth();
  try {
    const result = await getEnrollmentDetail(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, enrollment: serializeEnrollmentDetail(result.enrollment) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── listEnrollmentsForMemberAction ───────────────────────────────────────────

export type ListEnrollmentsForMemberActionResult =
  | { ok: true; enrollments: SerializedMemberEnrollmentRow[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listEnrollmentsForMemberAction(
  input: ListEnrollmentsForMemberInput,
): Promise<ListEnrollmentsForMemberActionResult> {
  const session = await auth();
  try {
    const rows = await listEnrollmentsForMember(session, input);
    return { ok: true, enrollments: rows.map(serializeMemberEnrollmentRow) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── createCourseAction ────────────────────────────────────────────────────────

export type CreateCourseActionResult =
  | { ok: true; course: SerializedCourseDetail }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function createCourseAction(
  input: CreateCourseInput,
): Promise<CreateCourseActionResult> {
  const session = await auth();
  try {
    const result = await createCourse(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, course: serializeCourseDetail(result.course) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── addCourseLessonAction ─────────────────────────────────────────────────────

export type AddCourseLessonActionResult =
  | { ok: true; course: SerializedCourseDetail }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function addCourseLessonAction(
  input: AddCourseLessonInput,
): Promise<AddCourseLessonActionResult> {
  const session = await auth();
  try {
    const result = await addCourseLesson(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, course: serializeCourseDetail(result.course) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── removeCourseLessonAction ──────────────────────────────────────────────────

export type RemoveCourseLessonActionResult =
  | { ok: true; course: SerializedCourseDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'has_records' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function removeCourseLessonAction(
  input: RemoveCourseLessonInput,
): Promise<RemoveCourseLessonActionResult> {
  const session = await auth();
  try {
    const result = await removeCourseLesson(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, course: serializeCourseDetail(result.course) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── enrollMemberAction ────────────────────────────────────────────────────────

export type EnrollMemberActionResult =
  | { ok: true; enrollment: SerializedEnrollmentDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'duplicate' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function enrollMemberAction(
  input: EnrollMemberInput,
): Promise<EnrollMemberActionResult> {
  const session = await auth();
  try {
    const result = await enrollMember(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, enrollment: serializeEnrollmentDetail(result.enrollment) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── setEnrollmentStatusAction ─────────────────────────────────────────────────

export type SetEnrollmentStatusActionResult =
  | { ok: true; enrollment: SerializedEnrollmentDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_transition' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function setEnrollmentStatusAction(
  input: SetEnrollmentStatusInput,
): Promise<SetEnrollmentStatusActionResult> {
  const session = await auth();
  try {
    const result = await setEnrollmentStatus(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, enrollment: serializeEnrollmentDetail(result.enrollment) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── recordLessonAction ────────────────────────────────────────────────────────

export type RecordLessonActionResult =
  | { ok: true; enrollment: SerializedEnrollmentDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'lesson_not_in_course' }
  | { ok: false; reason: 'enrollment_not_active' }
  /** Slice P2-SC1: an earlier stage check is unpassed. OPERATOR gate — NOT a Part-61/141 determination. */
  | { ok: false; reason: 'stage_check_required'; blockingLessonId: string }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function recordLessonAction(
  input: RecordLessonInput,
): Promise<RecordLessonActionResult> {
  const session = await auth();
  try {
    const result = await recordLesson(session, input);
    if (!result.ok) {
      if (result.reason === 'stage_check_required') {
        return { ok: false, reason: result.reason, blockingLessonId: result.blockingLessonId };
      }
      return { ok: false, reason: result.reason };
    }
    return { ok: true, enrollment: serializeEnrollmentDetail(result.enrollment) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── voidLessonRecordAction ────────────────────────────────────────────────────

export type VoidLessonRecordActionResult =
  | { ok: true; enrollment: SerializedEnrollmentDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'already_voided' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function voidLessonRecordAction(
  input: VoidLessonRecordInput,
): Promise<VoidLessonRecordActionResult> {
  const session = await auth();
  try {
    const result = await voidLessonRecord(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, enrollment: serializeEnrollmentDetail(result.enrollment) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── Slice P2-SC1: setLessonStageCheckAction / setCourseStageCheckEnforcementAction ──
//
// COMPLIANCE HARD LINE: the stage-check gate enforces the OPERATOR's
// configured course structure ONLY — NOT a Part-61/141 stage check of
// record or any FAA determination. Both toggles require training:manage
// and are audited inside the API functions.

export type SetLessonStageCheckActionResult =
  | { ok: true; course: SerializedCourseDetail }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function setLessonStageCheckAction(
  input: SetLessonStageCheckInput,
): Promise<SetLessonStageCheckActionResult> {
  const session = await auth();
  try {
    const result = await setLessonStageCheck(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, course: serializeCourseDetail(result.course) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

export type SetCourseStageCheckEnforcementActionResult =
  | { ok: true; course: SerializedCourseDetail }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function setCourseStageCheckEnforcementAction(
  input: SetCourseStageCheckEnforcementInput,
): Promise<SetCourseStageCheckEnforcementActionResult> {
  const session = await auth();
  try {
    const result = await setCourseStageCheckEnforcement(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, course: serializeCourseDetail(result.course) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── Slice P2-ESIGN: signLessonRecordAction / voidLessonSignatureAction / getLessonSignaturesAction ──
//
// COMPLIANCE HARD LINE [VERIFY-P2-A]: a lesson_signature is an operator/
// instructor ATTESTATION artifact — NOT an FAA-recognized digital/electronic
// signature, NOT a §61.51/§61.65/Part-141 endorsement of record, and
// computes NO training-completion/stage/graduation/currency determination.

export type SignLessonRecordActionResult =
  | { ok: true; signatures: SerializedLessonSignatureView[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'already_signed' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function signLessonRecordAction(
  input: SignLessonRecordInput,
): Promise<SignLessonRecordActionResult> {
  const session = await auth();
  try {
    const result = await signLessonRecord(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, signatures: result.signatures.map(serializeLessonSignature) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

export type VoidLessonSignatureActionResult =
  | { ok: true; signatures: SerializedLessonSignatureView[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'cannot_void_tombstone' }
  | { ok: false; reason: 'already_voided' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function voidLessonSignatureAction(
  input: VoidLessonSignatureInput,
): Promise<VoidLessonSignatureActionResult> {
  const session = await auth();
  try {
    const result = await voidLessonSignature(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, signatures: result.signatures.map(serializeLessonSignature) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

export type GetLessonSignaturesActionResult =
  | { ok: true; signatures: SerializedLessonSignatureView[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getLessonSignaturesAction(
  input: GetLessonSignaturesInput,
): Promise<GetLessonSignaturesActionResult> {
  const session = await auth();
  try {
    const signatures = await getLessonSignatures(session, input);
    return { ok: true, signatures: signatures.map(serializeLessonSignature) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}
