/**
 * lesson_record — a WRITE-ONCE fact recording a lesson completion.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0011 invariant 2).
 *
 * Records posture (ADR-0011 §1.2 — mirrors ADR-0007 dispatch_ticket):
 *   enrollment_id / lesson_id / instructor_user_id / completed_at /
 *   grade_label / notes / recorded_by / org_id / created_at are write-once
 *   (set at INSERT, NEVER mutated by any code path). No updateLessonRecord.
 *   A mistake is VOIDED (append-only tombstone via status='voided'), never
 *   edited or hard-deleted. void→re-record is allowed (progress numerator
 *   counts DISTINCT lesson_id among 'recorded' rows; de-duplication handles
 *   repeat recording after void). [VERIFY-T1-D]
 *
 * COMPLIANCE (HARD LINES):
 *   [VERIFY-T1-A]: grade_label is FREE-TEXT only. It is NOT a computed ACS
 *   grade, Part-61/141 verdict, or any regulatory outcome. The operator/
 *   instructor types any label they choose (e.g. "S", "U", "P/F", "3.2").
 *
 *   [VERIFY-T1-C]: lesson_record is a DATA ENTRY RECORD, NOT an e-signature.
 *   instructor_user_id is an app_user FK, not a cryptographic signature. Any
 *   Phase-3+ consumer attaching Part-141 sign-off meaning must preserve signer
 *   identity immutably (voided_by SET NULL means the column may become NULL on
 *   a user hard-delete; the durable "who" lives in audit_log — mirrors the
 *   squawk resolved_by note in squawk.ts).
 *
 *   Forward note (mirrors [[dispatch-correction-table-predecessor]]):
 *   The void-tombstone posture is the Training correction mechanism for T1.
 *   Any Phase-3+ consumer reading lesson_record for regulatory sign-off must
 *   preserve signer identity (do NOT rely on voided_by column; use audit_log).
 *
 * ── Composite FKs (hand-written in migration 0012 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [lesson_record_org_id_fk]
 *     Tenant spine.
 *
 *   Composite FK (enrollment_id, org_id) → enrollment(id, org_id) ON DELETE RESTRICT
 *     [lesson_record_enrollment_org_fk]
 *     Records must belong to an existing enrollment; deleting an enrollment
 *     with lesson records is blocked. Targets enrollment_id_org_id_unique (0012).
 *
 *   Composite FK (lesson_id, org_id) → course_lesson(id, org_id) ON DELETE RESTRICT
 *     [lesson_record_lesson_org_fk]
 *     Records must reference a lesson in the same org. Hard-delete of a lesson
 *     is blocked while records reference it (has_records API refusal + this FK).
 *     Targets course_lesson_id_org_id_unique (0012).
 *
 *   Composite FK (instructor_user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     [lesson_record_instructor_org_fk]
 *     Write-once; instructor must be a member of the same org. Prevents cross-org.
 *     NOT an e-signature. [VERIFY-T1-C]
 *
 *   Composite FK (recorded_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     [lesson_record_recorded_by_org_fk]
 *     Write-once attribution. Targets app_user_id_org_id_unique (0000).
 *
 *   Composite FK (voided_by, org_id) → app_user(id, org_id) ON DELETE SET NULL
 *     [lesson_record_voided_by_org_fk]
 *     Nullable; SET NULL on user hard-delete preserves the record while
 *     nulling the column. The durable "who voided" lives in audit_log, NOT
 *     this column. [VERIFY-T1-C] mirrors squawk.resolved_by SET NULL pattern.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * lesson_record_void_shape_check (mirrors squawk_resolved_shape_check):
 *   status='recorded' ⇒ voided_at IS NULL AND voided_reason IS NULL
 *   status='voided'   ⇒ voided_at IS NOT NULL AND voided_reason IS NOT NULL
 *   (voided_by is intentionally NOT required non-null: it is ON DELETE SET NULL,
 *   so the voider identity may be nulled on a user hard-delete. voided_at +
 *   voided_reason persist, and the durable "who" lives in audit_log.)
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — forward-compat for future composite FKs, consistent
 * with all other tenant tables.
 *
 * ── NO UNIQUE (enrollment_id, lesson_id) ─────────────────────────────────────
 * There is intentionally NO flat unique constraint on (enrollment_id, lesson_id).
 * void→re-record is allowed: progress numerator counts DISTINCT lesson_id among
 * 'recorded' rows. Refusing a second active record is deferred. [VERIFY-T1-D]
 *
 * ── Indexes ──────────────────────────────────────────────────────────────────
 * (org_id, enrollment_id) — covers getEnrollmentDetail record aggregation:
 *   WHERE org_id = $1 AND enrollment_id = $2
 * (org_id, lesson_id) — covers per-lesson completion queries:
 *   WHERE org_id = $1 AND lesson_id = $2 AND status = 'recorded'
 */
import {
  pgTable,
  uuid,
  timestamp,
  text,
  boolean,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';
import { lessonRecordStatus } from './enums.js';

export const lessonRecord = pgTable(
  'lesson_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — simple FK covers Drizzle ergonomics; the named composite FK
    // lesson_record_org_id_fk is hand-written in migration 0012.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // enrollment_id carries no .references() — composite FK
    // (enrollment_id, org_id) → enrollment(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0012. Write-once.
    enrollmentId: uuid('enrollment_id').notNull(),

    // lesson_id carries no .references() — composite FK
    // (lesson_id, org_id) → course_lesson(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0012. Write-once.
    lessonId: uuid('lesson_id').notNull(),

    // instructor_user_id carries no .references() — composite FK
    // (instructor_user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0012. Write-once; NOT an e-signature. [VERIFY-T1-C]
    instructorUserId: uuid('instructor_user_id').notNull(),

    // Write-once timestamp of lesson completion. Defaults to now() at INSERT.
    // [VERIFY-T1-C]: this is a data-entry timestamp, NOT a regulated completion
    // timestamp. Phase 3+ regulatory consumers must add immutable sign-off posture.
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),

    // FREE-TEXT operator/instructor grade label. NOT a computed ACS grade,
    // Part-61/141 verdict, or regulatory outcome. [VERIFY-T1-A]
    // Examples: "S" (satisfactory), "U", "P/F", "3.2", "Pass", etc.
    gradeLabel: text('grade_label'),

    // Free-text instructor/operator notes. Nullable. Write-once.
    notes: text('notes'),

    // stage_check_passed (migration 0038, Slice P2-SC1): instructor-entered
    // pass/fail outcome for a STAGE-CHECK lesson record. NULL on records for
    // non-stage-check lessons (API-enforced). WRITE-ONCE — set at INSERT
    // only; corrections go through the void-tombstone + re-record flow.
    // NOT a computed ACS/Part-61/141 verdict — the instructor states the
    // outcome; the software attaches no regulatory meaning.
    stageCheckPassed: boolean('stage_check_passed'),

    // Lesson record lifecycle status. Default 'recorded'.
    // Only valid transition: recorded → voided (API-enforced; void_shape_check).
    status: lessonRecordStatus('status').notNull().default('recorded'),

    // recorded_by carries no .references() — composite FK
    // (recorded_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0012. Write-once; preserves attribution.
    recordedBy: uuid('recorded_by').notNull(),

    // voided_by carries no .references() — composite FK
    // (voided_by, org_id) → app_user(id, org_id) ON DELETE SET NULL
    // is hand-written in migration 0012.
    // Nullable; SET NULL on user hard-delete. The durable "who voided" lives
    // in audit_log, NOT this column. [VERIFY-T1-C]
    voidedBy: uuid('voided_by'),

    // Populated at void (required when status='voided'; NULL when 'recorded').
    // lesson_record_void_shape_check enforces the shape invariant.
    voidedReason: text('voided_reason'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — forward-compat for future composite FKs.
    // Consistent with all other tenant tables.
    uniqueIndex('lesson_record_id_org_id_unique').on(t.id, t.orgId),

    // Covers: getEnrollmentDetail record aggregation
    // WHERE org_id = $1 AND enrollment_id = $2
    index('lesson_record_org_enrollment_idx').on(t.orgId, t.enrollmentId),

    // Covers: per-lesson completion query
    // WHERE org_id = $1 AND lesson_id = $2 AND status = 'recorded'
    index('lesson_record_org_lesson_idx').on(t.orgId, t.lessonId),
  ],
);

export type LessonRecordSelect = typeof lessonRecord.$inferSelect;
export type LessonRecordInsert = typeof lessonRecord.$inferInsert;
