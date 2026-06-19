/**
 * training/enums.ts — single source of truth for Training enum types (Slice T1).
 *
 * Mirrors the maintenance/enums.ts pattern: both @aeroops/db (pgEnum) and the
 * application layer import these tuples so the Drizzle schema and the runtime
 * can never drift. The schema-engineer builds pgEnums FROM these `as const` tuples.
 *
 * No I/O, framework-agnostic — safe to import anywhere.
 *
 * COMPLIANCE:
 *   - EnrollmentStatus: operator-set lifecycle flag only.
 *     'completed' = operator/instructor toggled status, NOT a Part-141 80%-completion-
 *     rate determination, graduation, or certificate. [VERIFY-T1-B]
 *     'withdrawn' = roster management only; no re-enroll restriction enforced in T1.
 *     [VERIFY-T1-F]
 *   - LessonRecordStatus: append-only audit posture (void = tombstone, not deletion).
 *     'voided' does NOT remove the record; it marks it as overridden. voided_by SET NULL
 *     = the durable "who" lives in audit_log, NOT the column. [VERIFY-T1-C]
 */

// ─── Enrollment status ────────────────────────────────────────────────────────

/**
 * ENROLLMENT_STATUSES — canonical list of enrollment lifecycle statuses.
 *
 * Order matters: Postgres enum types preserve insertion order and some tooling
 * displays them in this order. Do NOT reorder without a migration.
 *
 * Valid transitions (enforced at API layer):
 *   active → completed  (instructor/manager closes out the enrollment)
 *   active → withdrawn  (student or manager withdraws)
 *   completed/withdrawn → active = INVALID (no reopen path in T1)
 *
 * 'completed' is an operator content-state flag, NOT a Part-141 graduation
 * determination. [VERIFY-T1-B]
 */
export const ENROLLMENT_STATUSES = ['active', 'completed', 'withdrawn'] as const;

/** Union type of all valid enrollment status strings. */
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/**
 * isEnrollmentStatus — runtime type guard for EnrollmentStatus.
 *
 * Returns true only when `value` is a string that is an exact member of
 * ENROLLMENT_STATUSES. Use at untrusted boundaries (API input, DB read-back).
 *
 * @param value - Any unknown value from an untrusted source.
 * @returns `true` if value is a valid EnrollmentStatus, `false` otherwise.
 */
export function isEnrollmentStatus(value: unknown): value is EnrollmentStatus {
  return typeof value === 'string' && (ENROLLMENT_STATUSES as readonly string[]).includes(value);
}

// ─── Lesson record status ─────────────────────────────────────────────────────

/**
 * LESSON_RECORD_STATUSES — canonical list of lesson-record lifecycle statuses.
 *
 * A lesson_record is WRITE-ONCE at INSERT (enrollment_id / lesson_id /
 * completed_at / instructor_user_id / grade_label / notes are immutable).
 * A mistake is VOIDED (appending a tombstone via status='voided') — never
 * edited or hard-deleted. Only status / voided_by / voided_reason / voided_at
 * may change (exactly once: recorded → voided).
 *
 * 'voided' does not constitute an e-signature or a regulatory deletion.
 * [VERIFY-T1-C]
 *
 * The void_shape_check DB constraint enforces the shape invariant:
 *   'recorded' ⇒ voided_at / voided_reason MUST be NULL
 *   'voided'   ⇒ voided_at + voided_reason MUST be NOT NULL
 */
export const LESSON_RECORD_STATUSES = ['recorded', 'voided'] as const;

/** Union type of all valid lesson record status strings. */
export type LessonRecordStatus = (typeof LESSON_RECORD_STATUSES)[number];

/**
 * isLessonRecordStatus — runtime type guard for LessonRecordStatus.
 *
 * Same contract as isEnrollmentStatus, over LESSON_RECORD_STATUSES.
 *
 * @param value - Any unknown value from an untrusted source.
 * @returns `true` if value is a valid LessonRecordStatus, `false` otherwise.
 */
export function isLessonRecordStatus(value: unknown): value is LessonRecordStatus {
  return typeof value === 'string' && (LESSON_RECORD_STATUSES as readonly string[]).includes(value);
}
