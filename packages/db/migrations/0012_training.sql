-- ============================================================
-- AeroOps — Slice T1.1: Training Foundation (course + course_lesson + enrollment + lesson_record)
-- Migration: 0012_training.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql + 0001_auth_credential.sql
--               + 0002_scheduling.sql + 0003_booking_policies.sql
--               + 0004_recurrence.sql + 0005_dispatch.sql
--               + 0006_squawks_grounding.sql + 0007_fleet.sql
--               + 0008_people.sql + 0009_dispatch_gate.sql
--               + 0010_civil_twilight.sql + 0011_optimizer_run.sql
--               must already be applied.
--
-- Adds the Slice T1.1 (Training Foundation / ADR-0011) data-model delta:
--   (1) CREATE TYPE enrollment_status
--   (2) CREATE TYPE lesson_record_status
--   (3) course             — operator-defined training curriculum
--   (4) course_lesson      — ordered lesson within a course
--   (5) enrollment         — student enrolled in a course
--   (6) lesson_record      — WRITE-ONCE lesson-completion fact (append-only void)
--
-- [VERIFY-T1-A] (HARD COMPLIANCE LINE): lesson_record.grade_label is a FREE-TEXT
-- operator/instructor label ONLY. The system computes/interprets NO ACS grade,
-- Part-61 practical test standard, Part-141 curriculum verdict, or any FAA
-- regulatory outcome from the grade_label value.
--
-- [VERIFY-T1-B] (HARD COMPLIANCE LINE): enrollment.status='completed' and the
-- progress ratio (completedCount/totalLessons) are operator content-state flags
-- ONLY. They are NOT a Part-141 80%-completion-rate determination, graduation,
-- or certificate. The software attaches no regulatory meaning to them.
--
-- [VERIFY-T1-C] (HARD COMPLIANCE LINE): lesson_record is a DATA ENTRY RECORD,
-- NOT an e-signature. instructor_user_id is an application user FK, not a
-- cryptographic signature or regulatory sign-off. voided_by SET NULL means the
-- column may become NULL on a user hard-delete; the durable "who voided" lives
-- in audit_log — do NOT treat the voided_by column as the sign-off record. Any
-- Phase-3+ consumer attaching Part-141 sign-off meaning must preserve signer
-- identity immutably (mirrors the squawk resolved_by note in ADR-0008).
--
-- [VERIFY-T1-D]: T1 allows repeat active records for a lesson after void.
-- Progress numerator counts DISTINCT lesson_id among 'recorded' rows (de-dupes).
-- No UNIQUE(enrollment_id, lesson_id) constraint is present. Confirm this posture.
--
-- [VERIFY-T1-E]: student_user_id and instructor_user_id accept ANY app_user
-- in the org. No role enforcement (CFI-of-record identity deferred to Phase 3+).
-- Confirm: does the operator self-enforce who may be listed as an instructor?
--
-- [VERIFY-T1-F]: UNIQUE(student_user_id, course_id) prevents double-enrollment.
-- No re-enroll path after withdraw/complete in T1. Confirm this is acceptable.
--
-- [VERIFY-T1-G] (HARD COMPLIANCE LINE): course_lesson.stage_label is a FREE-TEXT
-- operator grouping label ONLY. It is NOT a Part-141 stage, a Part-61 stage check,
-- or any regulatory curriculum milestone. No FAA/regulatory meaning is computed
-- from it.
--
-- Key guarantees:
--   (1) All four tables: org_id NOT NULL, ENABLE+FORCE RLS, 4 fail-closed named
--       policies, aeroops_app GRANT (ADR-0001 + migration-0009 byte-pattern).
--   (2) Table creation order is load-bearing: course → course_lesson → enrollment
--       → lesson_record. Composite FKs chain: lesson_record targets enrollment
--       (enrollment_id_org_id_unique) and course_lesson (course_lesson_id_org_id_unique);
--       enrollment targets course (course_id_org_id_unique); course_lesson targets
--       course (course_id_org_id_unique).
--   (3) All composite FKs are hand-written (Drizzle cannot express multi-column FKs).
--   (4) Audited records posture: lesson_record is INSERT-ONLY. A mistake is voided
--       (status='voided' + voided_at + voided_reason), never edited or deleted.
--       void_shape_check enforces the shape invariant (mirrors squawk_resolved_shape_check).
--   (5) course.title and course_lesson.title nonempty CHECKs prevent blank strings.
--   (6) course_lesson.position >= 0 CHECK (zero-based ordering).
--   (7) UNIQUE(student_user_id, course_id) prevents double-enrollment.
--   (8) UNIQUE(course_id, position) backstops addCourseLesson position-race.
--   (9) UNIQUE(id, org_id) on all four tables: composite candidate keys for
--       future composite FKs, consistent with all tenant tables.
--  (10) STRICTLY ADDITIVE — no existing tables, columns, or constraints are modified.
--
-- ORDER:
--   (1)  CREATE TYPE enrollment_status
--   (2)  CREATE TYPE lesson_record_status
--   (3)  CREATE TABLE course + 4 named constraints
--   (4)  CREATE UNIQUE INDEX course_id_org_id_unique
--   (5)  CREATE INDEX course_org_status_idx
--   (6)  ENABLE + FORCE RLS on course; 4 named policies; GRANT
--   (7)  CREATE TABLE course_lesson + 6 named constraints
--   (8)  CREATE UNIQUE INDEX course_lesson_id_org_id_unique
--   (9)  CREATE UNIQUE INDEX course_lesson_course_id_position_unique
--   (10) CREATE INDEX course_lesson_org_course_idx
--   (11) ENABLE + FORCE RLS on course_lesson; 4 named policies; GRANT
--   (12) CREATE TABLE enrollment + 6 named constraints
--   (13) CREATE UNIQUE INDEX enrollment_id_org_id_unique
--   (14) CREATE UNIQUE INDEX enrollment_student_course_unique
--   (15) CREATE INDEX enrollment_org_course_idx
--   (16) CREATE INDEX enrollment_org_student_idx
--   (17) ENABLE + FORCE RLS on enrollment; 4 named policies; GRANT
--   (18) CREATE TABLE lesson_record + 7 named constraints
--   (19) CREATE UNIQUE INDEX lesson_record_id_org_id_unique
--   (20) CREATE INDEX lesson_record_org_enrollment_idx
--   (21) CREATE INDEX lesson_record_org_lesson_idx
--   (22) ENABLE + FORCE RLS on lesson_record; 4 named policies; GRANT
-- ============================================================


-- ── (1) CREATE TYPE enrollment_status ────────────────────────────────────────
-- Derived from @aeroops/core ENROLLMENT_STATUSES tuple (ADR-0011).
-- Three values: 'active' (enrolled), 'completed' (operator flag, NOT Part-141
-- graduation [VERIFY-T1-B]), 'withdrawn' (roster management [VERIFY-T1-F]).
-- Valid transitions (API-enforced): active→completed | active→withdrawn only.

CREATE TYPE "enrollment_status" AS ENUM ('active', 'completed', 'withdrawn');


-- ── (2) CREATE TYPE lesson_record_status ─────────────────────────────────────
-- Derived from @aeroops/core LESSON_RECORD_STATUSES tuple (ADR-0011).
-- Two values: 'recorded' (write-once fact), 'voided' (append-only tombstone).
-- void_shape_check enforces shape invariant on void transition.
-- [VERIFY-T1-C]: voided_by SET NULL; durable "who" in audit_log, NOT column.

CREATE TYPE "lesson_record_status" AS ENUM ('recorded', 'voided');


-- ── (3) CREATE TABLE course ───────────────────────────────────────────────────
--
-- Operator-defined training curriculum unit. title/status are operator content
-- only — the software computes NO FAA/Part-141 determination from them.
--
-- Composite FKs (hand-written; Drizzle cannot express multi-column FKs):
--
--   FK (org_id) → org(id) ON DELETE CASCADE  [course_org_id_fk]
--     Tenant spine — deleting an org cascades to its courses.
--
--   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--     [course_created_by_org_fk]
--     Preserves attribution. Targets app_user_id_org_id_unique from migration 0000.
--
-- CHECKs:
--   course_title_nonempty_check: char_length(btrim(title)) > 0
--   course_status_check: status IN ('active', 'archived')
--
-- UNIQUEs (hand-written indexes below):
--   course_id_org_id_unique UNIQUE (id, org_id)
--     Composite candidate key — targeted by course_lesson + enrollment composite FKs.
--     MUST exist before course_lesson and enrollment tables.

CREATE TABLE "course" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"      uuid NOT NULL,
  "title"       text NOT NULL,
  "description" text,
  "status"      text NOT NULL DEFAULT 'active',
  "created_by"  uuid NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "course_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: creator must be a user in the same org.
  -- ON DELETE RESTRICT: preserves attribution.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "course_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Title must not be empty (or blank-only). UI trims before sending.
  CONSTRAINT "course_title_nonempty_check" CHECK (
    char_length(btrim("title")) > 0
  ),

  -- Only 'active' and 'archived' are valid status values.
  CONSTRAINT "course_status_check" CHECK (
    "status" IN ('active', 'archived')
  )
);


-- ── (4) UNIQUE (id, org_id) on course ────────────────────────────────────────
-- Composite candidate key — targeted by course_lesson (course_id, org_id) and
-- enrollment (course_id, org_id) composite FKs. MUST exist before those tables.

CREATE UNIQUE INDEX "course_id_org_id_unique"
  ON "course" ("id", "org_id");


-- ── (5) Index (org_id, status) on course ─────────────────────────────────────
-- Covers: listCourses WHERE org_id = $1 [AND status = $2]

CREATE INDEX "course_org_status_idx"
  ON "course" ("org_id", "status");


-- ── (6) ENABLE + FORCE RLS on course; 4 named policies; GRANT ────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "course" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "course" FORCE  ROW LEVEL SECURITY;

-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
-- Byte-identical to 0009 (dispatch_gate) and 0008 (people) patterns.

CREATE POLICY "course_select"
  ON "course"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "course_insert"
  ON "course"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "course_update"
  ON "course"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "course_delete"
  ON "course"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "course" TO aeroops_app;


-- ── (7) CREATE TABLE course_lesson ────────────────────────────────────────────
--
-- Ordered lesson within a course. stage_label = FREE-TEXT operator grouping,
-- NOT a Part-141 stage or regulatory milestone. [VERIFY-T1-G]
--
-- Hard-delete is blocked at the API layer when lesson_records exist (has_records
-- refusal). The DB backstops this via the RESTRICT composite FK on lesson_record
-- (lesson_id, org_id) → course_lesson(id, org_id). [VERIFY-T1-G]
--
-- Composite FKs (hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE  [course_lesson_org_id_fk]
--     Tenant spine.
--
--   Composite FK (course_id, org_id) → course(id, org_id) ON DELETE CASCADE
--     [course_lesson_course_org_fk]
--     Lessons belong to their course; deleting a course cascades to its lessons.
--     Prevents cross-org course references.
--     Targets course_id_org_id_unique established above in this migration.
--
--   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--     [course_lesson_created_by_org_fk]
--     Preserves attribution. Targets app_user_id_org_id_unique from migration 0000.
--
-- CHECKs:
--   course_lesson_title_nonempty_check: char_length(btrim(title)) > 0
--   course_lesson_position_nonneg_check: position >= 0
--
-- UNIQUEs (indexes below):
--   course_lesson_id_org_id_unique UNIQUE (id, org_id) — composite candidate key
--   course_lesson_course_id_position_unique UNIQUE (course_id, position)

CREATE TABLE "course_lesson" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"      uuid NOT NULL,
  "course_id"   uuid NOT NULL,
  "title"       text NOT NULL,
  "description" text,
  "stage_label" text,
  "position"    integer NOT NULL,
  "created_by"  uuid NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "course_lesson_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: lesson must reference a course in the same org.
  -- ON DELETE CASCADE: deleting a course cascades to its lessons.
  -- Targets course_id_org_id_unique from above.
  CONSTRAINT "course_lesson_course_org_fk"
    FOREIGN KEY ("course_id", "org_id")
    REFERENCES "course"("id", "org_id") ON DELETE CASCADE,

  -- Composite FK: creator must be a user in the same org.
  -- ON DELETE RESTRICT: preserves attribution.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "course_lesson_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Lesson title must not be empty (or blank-only).
  CONSTRAINT "course_lesson_title_nonempty_check" CHECK (
    char_length(btrim("title")) > 0
  ),

  -- Position must be a non-negative integer (zero-based ordering).
  CONSTRAINT "course_lesson_position_nonneg_check" CHECK (
    "position" >= 0
  )
);


-- ── (8) UNIQUE (id, org_id) on course_lesson ─────────────────────────────────
-- Composite candidate key — targeted by lesson_record (lesson_id, org_id) → 
-- course_lesson(id, org_id) composite FK. MUST exist before lesson_record.

CREATE UNIQUE INDEX "course_lesson_id_org_id_unique"
  ON "course_lesson" ("id", "org_id");


-- ── (9) UNIQUE (course_id, position) on course_lesson ────────────────────────
-- Position uniqueness per course — backstops addCourseLesson position-race
-- (in-tx max+1 + unique conflict = retryable 23505 error).

CREATE UNIQUE INDEX "course_lesson_course_id_position_unique"
  ON "course_lesson" ("course_id", "position");


-- ── (10) Index (org_id, course_id) on course_lesson ─────────────────────────
-- Covers: listLessons WHERE org_id = $1 AND course_id = $2 ORDER BY position

CREATE INDEX "course_lesson_org_course_idx"
  ON "course_lesson" ("org_id", "course_id");


-- ── (11) ENABLE + FORCE RLS on course_lesson; 4 named policies; GRANT ─────────

ALTER TABLE "course_lesson" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "course_lesson" FORCE  ROW LEVEL SECURITY;

CREATE POLICY "course_lesson_select"
  ON "course_lesson"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "course_lesson_insert"
  ON "course_lesson"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "course_lesson_update"
  ON "course_lesson"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "course_lesson_delete"
  ON "course_lesson"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "course_lesson" TO aeroops_app;


-- ── (12) CREATE TABLE enrollment ─────────────────────────────────────────────
--
-- Records a student member's enrollment in a course.
--
-- student_user_id: ANY org member; no role enforcement in T1. [VERIFY-T1-E]
-- enrolled_by / enrolled_at / course_id / student_user_id are write-once.
-- Only status / status_changed_at / updated_at may change (setEnrollmentStatus).
-- Transitions (API-enforced): active→completed | active→withdrawn.
-- 'completed' ≠ regulatory completion. [VERIFY-T1-B]
-- No re-enroll after withdraw/complete in T1. [VERIFY-T1-F]
--
-- Composite FKs (hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE  [enrollment_org_id_fk]
--     Tenant spine.
--
--   Composite FK (course_id, org_id) → course(id, org_id) ON DELETE RESTRICT
--     [enrollment_course_org_fk]
--     Prevents deleting a course that has enrollments (records integrity).
--     Targets course_id_org_id_unique from above.
--
--   Composite FK (student_user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--     [enrollment_student_org_fk]
--     Student must be a member of the same org. Prevents cross-org references.
--     Targets app_user_id_org_id_unique from migration 0000.
--
--   Composite FK (enrolled_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--     [enrollment_enrolled_by_org_fk]
--     Preserves attribution. Targets app_user_id_org_id_unique from migration 0000.
--
-- UNIQUEs (indexes below):
--   enrollment_id_org_id_unique UNIQUE (id, org_id) — composite candidate key
--   enrollment_student_course_unique UNIQUE (student_user_id, course_id)
--     No double-enrollment; duplicate insert → 23505 → typed 'duplicate' refusal.

CREATE TABLE "enrollment" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"            uuid NOT NULL,
  "course_id"         uuid NOT NULL,
  "student_user_id"   uuid NOT NULL,
  "status"            enrollment_status NOT NULL DEFAULT 'active',
  "enrolled_by"       uuid NOT NULL,
  "enrolled_at"       timestamptz NOT NULL DEFAULT now(),
  "status_changed_at" timestamptz,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "enrollment_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: enrollment must reference a course in the same org.
  -- ON DELETE RESTRICT: records integrity — cannot delete a course with enrollments.
  -- Targets course_id_org_id_unique from above.
  CONSTRAINT "enrollment_course_org_fk"
    FOREIGN KEY ("course_id", "org_id")
    REFERENCES "course"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: student must be a user in the same org.
  -- ON DELETE RESTRICT: preserves enrollment record.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "enrollment_student_org_fk"
    FOREIGN KEY ("student_user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: enrolled_by must be a user in the same org.
  -- ON DELETE RESTRICT: preserves attribution.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "enrollment_enrolled_by_org_fk"
    FOREIGN KEY ("enrolled_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT
);


-- ── (13) UNIQUE (id, org_id) on enrollment ───────────────────────────────────
-- Composite candidate key — targeted by lesson_record (enrollment_id, org_id) →
-- enrollment(id, org_id) composite FK. MUST exist before lesson_record.

CREATE UNIQUE INDEX "enrollment_id_org_id_unique"
  ON "enrollment" ("id", "org_id");


-- ── (14) UNIQUE (student_user_id, course_id) on enrollment ──────────────────
-- No double-enrollment: one enrollment per student per course.
-- Duplicate insert → 23505 → typed 'duplicate' refusal in enrollMember.
-- [VERIFY-T1-F]: no re-enroll after withdraw in T1.

CREATE UNIQUE INDEX "enrollment_student_course_unique"
  ON "enrollment" ("student_user_id", "course_id");


-- ── (15) Index (org_id, course_id) on enrollment ────────────────────────────
-- Covers: listEnrollments WHERE org_id = $1 [AND course_id = $2]

CREATE INDEX "enrollment_org_course_idx"
  ON "enrollment" ("org_id", "course_id");


-- ── (16) Index (org_id, student_user_id) on enrollment ──────────────────────
-- Covers: listEnrollmentsForMember WHERE org_id = $1 AND student_user_id = $2

CREATE INDEX "enrollment_org_student_idx"
  ON "enrollment" ("org_id", "student_user_id");


-- ── (17) ENABLE + FORCE RLS on enrollment; 4 named policies; GRANT ────────────

ALTER TABLE "enrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrollment" FORCE  ROW LEVEL SECURITY;

CREATE POLICY "enrollment_select"
  ON "enrollment"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "enrollment_insert"
  ON "enrollment"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "enrollment_update"
  ON "enrollment"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "enrollment_delete"
  ON "enrollment"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "enrollment" TO aeroops_app;


-- ── (18) CREATE TABLE lesson_record ──────────────────────────────────────────
--
-- WRITE-ONCE lesson-completion fact (records-integrity posture, ADR-0011 §1.2).
-- enrollment_id / lesson_id / instructor_user_id / completed_at / grade_label /
-- notes / recorded_by / created_at are write-once (INSERT only; no UPDATE path).
-- A mistake is VOIDED (status→'voided' + voided_at + voided_reason), never edited.
-- void_shape_check enforces the shape invariant (mirrors squawk_resolved_shape_check).
--
-- [VERIFY-T1-A]: grade_label = FREE-TEXT only. NOT a computed ACS/Part-61/141 verdict.
-- [VERIFY-T1-C]: instructor_user_id is an FK, NOT an e-signature. voided_by SET NULL;
--   durable "who" in audit_log.
-- [VERIFY-T1-D]: no UNIQUE(enrollment_id, lesson_id); re-record after void is allowed.
--
-- Composite FKs (hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE  [lesson_record_org_id_fk]
--     Tenant spine.
--
--   Composite FK (enrollment_id, org_id) → enrollment(id, org_id) ON DELETE RESTRICT
--     [lesson_record_enrollment_org_fk]
--     Record must belong to an existing enrollment. Records integrity — cannot
--     delete an enrollment while lesson records exist.
--     Targets enrollment_id_org_id_unique from above.
--
--   Composite FK (lesson_id, org_id) → course_lesson(id, org_id) ON DELETE RESTRICT
--     [lesson_record_lesson_org_fk]
--     Record must reference a lesson in the same org. Hard-delete of a lesson
--     with records → RESTRICT (DB backstop for API's has_records refusal).
--     Targets course_lesson_id_org_id_unique from above.
--
--   Composite FK (instructor_user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--     [lesson_record_instructor_org_fk]
--     Write-once; instructor must be an org member. NOT an e-signature. [VERIFY-T1-C]
--     Targets app_user_id_org_id_unique from migration 0000.
--
--   Composite FK (recorded_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--     [lesson_record_recorded_by_org_fk]
--     Write-once attribution. Targets app_user_id_org_id_unique from migration 0000.
--
--   Composite FK (voided_by, org_id) → app_user(id, org_id) ON DELETE SET NULL ("voided_by")
--     [lesson_record_voided_by_org_fk]
--     Nullable; column-list SET NULL only nulls voided_by (NOT org_id).
--     The durable "who voided" lives in audit_log. [VERIFY-T1-C]
--     Mirrors squawk.resolved_by SET NULL in migration 0006.
--     Targets app_user_id_org_id_unique from migration 0000.
--
-- CHECKs:
--   lesson_record_void_shape_check (mirrors squawk_resolved_shape_check):
--     status='recorded' ⇒ voided_at IS NULL AND voided_reason IS NULL
--     status='voided'   ⇒ voided_at IS NOT NULL AND voided_reason IS NOT NULL
--     (voided_by intentionally NOT required non-null: SET NULL on user delete.
--      voided_at + voided_reason persist; durable "who" in audit_log.)
--
-- UNIQUEs:
--   lesson_record_id_org_id_unique UNIQUE (id, org_id) — composite candidate key.
--   NO UNIQUE(enrollment_id, lesson_id) — re-record after void is allowed. [VERIFY-T1-D]

CREATE TABLE "lesson_record" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"              uuid NOT NULL,
  "enrollment_id"       uuid NOT NULL,
  "lesson_id"           uuid NOT NULL,
  "instructor_user_id"  uuid NOT NULL,
  "completed_at"        timestamptz NOT NULL DEFAULT now(),
  "grade_label"         text,
  "notes"               text,
  "status"              lesson_record_status NOT NULL DEFAULT 'recorded',
  "recorded_by"         uuid NOT NULL,
  "voided_by"           uuid,
  "voided_reason"       text,
  "voided_at"           timestamptz,
  "created_at"          timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "lesson_record_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: record must belong to an enrollment in the same org.
  -- ON DELETE RESTRICT: records integrity — enrollment deletion blocked while records exist.
  -- Targets enrollment_id_org_id_unique from above.
  CONSTRAINT "lesson_record_enrollment_org_fk"
    FOREIGN KEY ("enrollment_id", "org_id")
    REFERENCES "enrollment"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: record must reference a lesson in the same org.
  -- ON DELETE RESTRICT: DB backstop for API has_records refusal on lesson delete.
  -- Targets course_lesson_id_org_id_unique from above.
  CONSTRAINT "lesson_record_lesson_org_fk"
    FOREIGN KEY ("lesson_id", "org_id")
    REFERENCES "course_lesson"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: instructor must be an org member. NOT an e-signature. [VERIFY-T1-C]
  -- ON DELETE RESTRICT: write-once attribution; prevents cross-org references.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "lesson_record_instructor_org_fk"
    FOREIGN KEY ("instructor_user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: recorder must be an org member.
  -- ON DELETE RESTRICT: write-once attribution.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "lesson_record_recorded_by_org_fk"
    FOREIGN KEY ("recorded_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: voided_by is nullable; SET NULL on user hard-delete.
  -- Column-list syntax ON DELETE SET NULL ("voided_by") nulls ONLY voided_by;
  -- org_id (NOT NULL) is preserved. Mirrors squawk.resolved_by in migration 0006.
  -- The durable "who voided" lives in audit_log, NOT this column. [VERIFY-T1-C]
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "lesson_record_voided_by_org_fk"
    FOREIGN KEY ("voided_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE SET NULL ("voided_by"),

  -- Shape invariant (mirrors squawk_resolved_shape_check in migration 0006):
  --   status='recorded' ⇒ voided_at IS NULL AND voided_reason IS NULL
  --   status='voided'   ⇒ voided_at IS NOT NULL AND voided_reason IS NOT NULL
  -- voided_by is intentionally NOT included in the NOT NULL arm: it is SET NULL.
  CONSTRAINT "lesson_record_void_shape_check" CHECK (
    (
      "status" = 'recorded'
      AND "voided_at" IS NULL
      AND "voided_reason" IS NULL
    ) OR (
      "status" = 'voided'
      AND "voided_at" IS NOT NULL
      AND "voided_reason" IS NOT NULL
    )
  )
);


-- ── (19) UNIQUE (id, org_id) on lesson_record ────────────────────────────────
-- Composite candidate key — forward-compat for future composite FKs.
-- Consistent with all other tenant tables.

CREATE UNIQUE INDEX "lesson_record_id_org_id_unique"
  ON "lesson_record" ("id", "org_id");


-- ── (20) Index (org_id, enrollment_id) on lesson_record ──────────────────────
-- Covers: getEnrollmentDetail record aggregation
-- WHERE org_id = $1 AND enrollment_id = $2

CREATE INDEX "lesson_record_org_enrollment_idx"
  ON "lesson_record" ("org_id", "enrollment_id");


-- ── (21) Index (org_id, lesson_id) on lesson_record ──────────────────────────
-- Covers: per-lesson completion query
-- WHERE org_id = $1 AND lesson_id = $2 AND status = 'recorded'

CREATE INDEX "lesson_record_org_lesson_idx"
  ON "lesson_record" ("org_id", "lesson_id");


-- ── (22) ENABLE + FORCE RLS on lesson_record; 4 named policies; GRANT ────────

ALTER TABLE "lesson_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lesson_record" FORCE  ROW LEVEL SECURITY;

CREATE POLICY "lesson_record_select"
  ON "lesson_record"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "lesson_record_insert"
  ON "lesson_record"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "lesson_record_update"
  ON "lesson_record"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "lesson_record_delete"
  ON "lesson_record"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "lesson_record" TO aeroops_app;
