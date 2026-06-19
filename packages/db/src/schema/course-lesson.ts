/**
 * course_lesson — an ordered lesson within a course.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0011 invariant 1).
 *
 * Records posture (ADR-0011 §1):
 *   title / description / stage_label / position / course_id / created_by /
 *   created_at are write-once (set at INSERT). title / description /
 *   stage_label / position / updated_at may be mutated via operator config.
 *   Hard-delete is blocked at the API layer when non-voided lesson_records
 *   reference this lesson (has_records refusal). The DB enforces this via the
 *   lesson_record → course_lesson RESTRICT composite FK backstop.
 *
 * COMPLIANCE:
 *   stage_label is a FREE-TEXT operator grouping label. It is NOT a Part-141
 *   stage, a Part-61 stage check, or any regulatory curriculum milestone.
 *   The software attaches no regulatory meaning to it. [VERIFY-T1-G]
 *
 *   course_lesson.title is operator-named content. No FAA/regulatory meaning
 *   is computed from the lesson title.
 *
 * ── Composite FKs (hand-written in migration 0012 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [course_lesson_org_id_fk]
 *     Tenant spine.
 *
 *   Composite FK (course_id, org_id) → course(id, org_id) ON DELETE CASCADE
 *     [course_lesson_course_org_fk]
 *     Lessons belong to their course; deleting a course cascades to its lessons.
 *     Prevents cross-org course references.
 *     Targets course_id_org_id_unique established in migration 0012 (course created first).
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     [course_lesson_created_by_org_fk]
 *     Preserves attribution. Targets app_user_id_org_id_unique (0000).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * course_lesson_title_nonempty_check:
 *   char_length(btrim(title)) > 0
 *   Prevents blank-only or empty lesson titles.
 *
 * course_lesson_position_nonneg_check:
 *   position >= 0
 *   Lesson ordering is zero-based non-negative integer. addCourseLesson uses
 *   max(position)+1 in-transaction; the UNIQUE(course_id,position) backstops
 *   race conditions.
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — consumed by lesson_record composite FK
 * (lesson_id, org_id) → course_lesson(id, org_id). Must exist before lesson_record.
 *
 * ── UNIQUE (course_id, position) ─────────────────────────────────────────────
 * Each position slot in a course is taken by exactly one lesson. Backstops
 * addCourseLesson position-race (in-tx max+1 + unique conflict = retryable error).
 *
 * ── Indexes ──────────────────────────────────────────────────────────────────
 * (org_id, course_id) — covers listLessons for a course:
 *   WHERE org_id = $1 AND course_id = $2 ORDER BY position
 */
import {
  pgTable,
  uuid,
  timestamp,
  text,
  integer,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const courseLesson = pgTable(
  'course_lesson',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — simple FK covers Drizzle ergonomics; the named composite FK
    // course_lesson_org_id_fk is hand-written in migration 0012.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // course_id carries no .references() — composite FK
    // (course_id, org_id) → course(id, org_id) ON DELETE CASCADE
    // is hand-written in migration 0012.
    courseId: uuid('course_id').notNull(),

    // Free-text operator-defined lesson title. course_lesson_title_nonempty_check
    // rejects blank. May be updated via operator config.
    title: text('title').notNull(),

    // Optional long-form lesson description; nullable.
    description: text('description'),

    // stage_label: FREE-TEXT operator grouping (e.g. "Ground School",
    // "Solo Prep"). NOT a Part-141 stage or regulatory curriculum milestone.
    // [VERIFY-T1-G]: no regulatory meaning is computed from this value.
    stageLabel: text('stage_label'),

    // Zero-based ordering index within the course.
    // course_lesson_position_nonneg_check enforces position >= 0.
    // UNIQUE(course_id, position) backstops race conditions in addCourseLesson.
    position: integer('position').notNull(),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0012. Write-once; preserves attribution.
    createdBy: uuid('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consumed by lesson_record (lesson_id, org_id)
    // composite FK. MUST be created before lesson_record table.
    uniqueIndex('course_lesson_id_org_id_unique').on(t.id, t.orgId),

    // Position uniqueness per course — backstops addCourseLesson position-race.
    uniqueIndex('course_lesson_course_id_position_unique').on(t.courseId, t.position),

    // Covers: listLessons WHERE org_id = $1 AND course_id = $2 ORDER BY position
    index('course_lesson_org_course_idx').on(t.orgId, t.courseId),
  ],
);

export type CourseLessonSelect = typeof courseLesson.$inferSelect;
export type CourseLessonInsert = typeof courseLesson.$inferInsert;
