/**
 * course — an operator-defined training curriculum unit.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0011 invariant 1).
 *
 * Records posture (ADR-0011 §1):
 *   title / description / created_by / created_at are write-once (set at INSERT).
 *   Only title / description / status / updated_at may be mutated via operator
 *   config (updateCourse). No hard-delete path — archive via status='archived'.
 *
 * COMPLIANCE:
 *   Course = operator-named content. The software interprets NONE of the content
 *   and computes NO FAA determination from it. course.title is free text.
 *   course.status = 'completed' means the operator toggled a content-state flag,
 *   NOT a Part-141 graduation, 80%-completion-rate, or certificate. [VERIFY-T1-B]
 *
 * ── Composite FKs (hand-written in migration 0012 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; composite FKs are
 * written in the migration; affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [course_org_id_fk]
 *     Tenant spine — deleting an org cascades to its courses (and via cascade
 *     chain: course_lesson → enrollment → lesson_record).
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     [course_created_by_org_fk]
 *     Preserves attribution: prevents deleting the creating user while their
 *     authorship record exists. Targets app_user_id_org_id_unique (0000).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * course_title_nonempty_check:
 *   char_length(btrim(title)) > 0
 *   Prevents blank-only or empty course titles; UI trims before sending.
 *
 * course_status_check:
 *   status IN ('active', 'archived')
 *   Only two valid values; 'archived' hides the course from new enrollments.
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — consumed by course_lesson, enrollment composite FKs
 * (course_id, org_id) → course(id, org_id). Must be created BEFORE those tables.
 *
 * ── Indexes ──────────────────────────────────────────────────────────────────
 * (org_id, status) — covers listCourses filtered by status:
 *   WHERE org_id = $1 [AND status = $2]
 */
import {
  pgTable,
  uuid,
  timestamp,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const course = pgTable(
  'course',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — simple FK covers Drizzle ergonomics; the named composite FK
    // course_org_id_fk is hand-written in migration 0012.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // Free-text operator-defined course title. Write-once is NOT enforced at
    // the DB level (title updates are allowed for course config). The API layer
    // trims before sending; course_title_nonempty_check rejects blank.
    title: text('title').notNull(),

    // Optional long-form description; free text; nullable.
    description: text('description'),

    // Lifecycle status. Only 'active' and 'archived' are valid
    // (course_status_check). Default 'active'.
    // 'archived' hides the course from new enrollments; does NOT delete records.
    status: text('status').notNull().default('active'),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0012. Write-once; preserves attribution.
    createdBy: uuid('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consumed by course_lesson and enrollment
    // (course_id, org_id) composite FKs. MUST exist before those tables.
    uniqueIndex('course_id_org_id_unique').on(t.id, t.orgId),

    // Covers: listCourses WHERE org_id = $1 [AND status = $2]
    index('course_org_status_idx').on(t.orgId, t.status),
  ],
);

export type CourseSelect = typeof course.$inferSelect;
export type CourseInsert = typeof course.$inferInsert;
