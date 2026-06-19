/**
 * enrollment — records a student member's enrollment in a course.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0011 invariant 1).
 *
 * Records posture (ADR-0011 §1):
 *   student_user_id / course_id / enrolled_by / enrolled_at / org_id /
 *   created_at are write-once (set at INSERT, never mutated). Only status /
 *   status_changed_at / updated_at may change (via setEnrollmentStatus).
 *   No hard-delete path; no reopen after withdraw/complete (invalid_transition).
 *
 * COMPLIANCE:
 *   'completed' = operator toggled the enrollment status to mark content
 *   coverage. This is NOT a Part-141 graduation, 80%-completion-rate
 *   determination, or regulatory certificate. [VERIFY-T1-B]
 *
 *   'withdrawn' = operator/manager roster action. No re-enroll restriction
 *   is enforced in T1. [VERIFY-T1-F]
 *
 *   student_user_id = ANY member (no role enforcement). CFI-of-record
 *   identity for regulatory purposes is deferred to Phase 3+. [VERIFY-T1-E]
 *
 * ── Composite FKs (hand-written in migration 0012 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [enrollment_org_id_fk]
 *     Tenant spine — deleting an org cascades to its enrollments.
 *
 *   Composite FK (course_id, org_id) → course(id, org_id) ON DELETE RESTRICT
 *     [enrollment_course_org_fk]
 *     Prevents deleting a course that has enrollments (records integrity).
 *     Targets course_id_org_id_unique from migration 0012.
 *
 *   Composite FK (student_user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     [enrollment_student_org_fk]
 *     Student must be a member of the same org; prevents cross-org references.
 *     Targets app_user_id_org_id_unique from migration 0000.
 *
 *   Composite FK (enrolled_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     [enrollment_enrolled_by_org_fk]
 *     Preserves attribution. Targets app_user_id_org_id_unique from migration 0000.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * (No shape-check needed here; the enum domain covers valid status values.
 * Status transition validation is enforced at the API layer:
 *   active→completed | active→withdrawn only. [VERIFY-T1-B/F])
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — consumed by lesson_record composite FK
 * (enrollment_id, org_id) → enrollment(id, org_id). Must exist before lesson_record.
 *
 * ── UNIQUE (student_user_id, course_id) ──────────────────────────────────────
 * Prevents double-enrollment: a student can have at most one enrollment per course.
 * [VERIFY-T1-F]: no re-enroll after withdraw is allowed in T1.
 * Duplicate insert is caught as error code 23505 → mapped to typed 'duplicate'
 * refusal in enrollMember.
 *
 * ── Indexes ──────────────────────────────────────────────────────────────────
 * (org_id, course_id) — covers listEnrollments filtered by course:
 *   WHERE org_id = $1 [AND course_id = $2]
 * (org_id, student_user_id) — covers listEnrollments for a member:
 *   WHERE org_id = $1 AND student_user_id = $2
 */
import {
  pgTable,
  uuid,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';
import { enrollmentStatus } from './enums.js';

export const enrollment = pgTable(
  'enrollment',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — simple FK covers Drizzle ergonomics; the named composite FK
    // enrollment_org_id_fk is hand-written in migration 0012.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // course_id carries no .references() — composite FK
    // (course_id, org_id) → course(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0012. Write-once.
    courseId: uuid('course_id').notNull(),

    // student_user_id carries no .references() — composite FK
    // (student_user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0012. ANY member; no role enforcement in T1.
    // Write-once. [VERIFY-T1-E]
    studentUserId: uuid('student_user_id').notNull(),

    // Enrollment lifecycle status. Default 'active'.
    // Transitions: active→completed | active→withdrawn (API-enforced).
    // 'completed' ≠ regulatory completion. [VERIFY-T1-B]
    status: enrollmentStatus('status').notNull().default('active'),

    // enrolled_by carries no .references() — composite FK
    // (enrolled_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0012. Write-once; preserves attribution.
    enrolledBy: uuid('enrolled_by').notNull(),

    // Write-once timestamp of enrollment. Defaults to now().
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),

    // Nullable: populated when status transitions away from 'active'.
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consumed by lesson_record (enrollment_id, org_id)
    // composite FK. MUST be created before lesson_record table.
    uniqueIndex('enrollment_id_org_id_unique').on(t.id, t.orgId),

    // No double-enrollment: one enrollment per student per course.
    // Duplicate insert → 23505 → mapped to typed 'duplicate' refusal.
    uniqueIndex('enrollment_student_course_unique').on(t.studentUserId, t.courseId),

    // Covers: listEnrollments WHERE org_id = $1 [AND course_id = $2]
    index('enrollment_org_course_idx').on(t.orgId, t.courseId),

    // Covers: listEnrollmentsForMember WHERE org_id = $1 AND student_user_id = $2
    index('enrollment_org_student_idx').on(t.orgId, t.studentUserId),
  ],
);

export type EnrollmentSelect = typeof enrollment.$inferSelect;
export type EnrollmentInsert = typeof enrollment.$inferInsert;
