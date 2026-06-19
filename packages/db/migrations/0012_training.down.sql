-- ============================================================
-- AeroOps — Slice T1.1 ROLLBACK PLAN
-- Migration: 0012_training.down.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0012_training.sql in strict reverse dependency order.
--
-- [VERIFY-T1-A/B/C]: Dropping these tables discards all training records
-- (course definitions, enrollments, and lesson-record facts). This is
-- IRREVERSIBLE for any lesson_record data that has not been backed up.
-- Confirm with the operator before applying in any environment with real data.
--
-- [VERIFY-T1-AUDIT]: audit_log rows referencing training entities (course,
-- enrollment, lesson_record) are preserved — they reference these tables only
-- by id stored in audit_log.entity_id (text), not via FK. Dropping the tables
-- does NOT cascade to audit_log. Training audit history remains intact.
--
-- Dependency order (reverse of forward migration):
--  lesson_record must be dropped before enrollment and course_lesson
--  enrollment must be dropped before course
--  course_lesson must be dropped before course
--  course dropped last (it is the root of the composite FK chain)
--
-- Per table (reverse order):
--   (1)  REVOKE lesson_record
--   (2)  DROP POLICYs lesson_record (×4)
--   (3)  DISABLE RLS lesson_record
--   (4)  DROP INDEX lesson_record_org_lesson_idx
--   (5)  DROP INDEX lesson_record_org_enrollment_idx
--   (6)  DROP INDEX lesson_record_id_org_id_unique
--   (7)  DROP TABLE lesson_record
--   (8)  REVOKE enrollment
--   (9)  DROP POLICYs enrollment (×4)
--   (10) DISABLE RLS enrollment
--   (11) DROP INDEX enrollment_org_student_idx
--   (12) DROP INDEX enrollment_org_course_idx
--   (13) DROP INDEX enrollment_student_course_unique
--   (14) DROP INDEX enrollment_id_org_id_unique
--   (15) DROP TABLE enrollment
--   (16) REVOKE course_lesson
--   (17) DROP POLICYs course_lesson (×4)
--   (18) DISABLE RLS course_lesson
--   (19) DROP INDEX course_lesson_org_course_idx
--   (20) DROP INDEX course_lesson_course_id_position_unique
--   (21) DROP INDEX course_lesson_id_org_id_unique
--   (22) DROP TABLE course_lesson
--   (23) REVOKE course
--   (24) DROP POLICYs course (×4)
--   (25) DISABLE RLS course
--   (26) DROP INDEX course_org_status_idx
--   (27) DROP INDEX course_id_org_id_unique
--   (28) DROP TABLE course
--   (29) DROP TYPE lesson_record_status
--   (30) DROP TYPE enrollment_status
-- ============================================================


-- ── (1) Revoke grant on lesson_record ────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "lesson_record" FROM aeroops_app;


-- ── (2) Drop RLS policies on lesson_record ───────────────────────────────────

DROP POLICY IF EXISTS "lesson_record_delete" ON "lesson_record";
DROP POLICY IF EXISTS "lesson_record_update" ON "lesson_record";
DROP POLICY IF EXISTS "lesson_record_insert" ON "lesson_record";
DROP POLICY IF EXISTS "lesson_record_select" ON "lesson_record";


-- ── (3) Disable RLS on lesson_record ─────────────────────────────────────────

ALTER TABLE "lesson_record" DISABLE ROW LEVEL SECURITY;


-- ── (4–6) Drop indexes on lesson_record ──────────────────────────────────────

DROP INDEX IF EXISTS "lesson_record_org_lesson_idx";
DROP INDEX IF EXISTS "lesson_record_org_enrollment_idx";
DROP INDEX IF EXISTS "lesson_record_id_org_id_unique";


-- ── (7) Drop table lesson_record ─────────────────────────────────────────────
-- Drops all remaining constraints (org FK, composite FKs, void_shape_check).

DROP TABLE IF EXISTS "lesson_record";


-- ── (8) Revoke grant on enrollment ───────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "enrollment" FROM aeroops_app;


-- ── (9) Drop RLS policies on enrollment ──────────────────────────────────────

DROP POLICY IF EXISTS "enrollment_delete" ON "enrollment";
DROP POLICY IF EXISTS "enrollment_update" ON "enrollment";
DROP POLICY IF EXISTS "enrollment_insert" ON "enrollment";
DROP POLICY IF EXISTS "enrollment_select" ON "enrollment";


-- ── (10) Disable RLS on enrollment ───────────────────────────────────────────

ALTER TABLE "enrollment" DISABLE ROW LEVEL SECURITY;


-- ── (11–14) Drop indexes on enrollment ───────────────────────────────────────

DROP INDEX IF EXISTS "enrollment_org_student_idx";
DROP INDEX IF EXISTS "enrollment_org_course_idx";
DROP INDEX IF EXISTS "enrollment_student_course_unique";
DROP INDEX IF EXISTS "enrollment_id_org_id_unique";


-- ── (15) Drop table enrollment ────────────────────────────────────────────────
-- Drops all remaining constraints (org FK, composite FKs).

DROP TABLE IF EXISTS "enrollment";


-- ── (16) Revoke grant on course_lesson ───────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "course_lesson" FROM aeroops_app;


-- ── (17) Drop RLS policies on course_lesson ──────────────────────────────────

DROP POLICY IF EXISTS "course_lesson_delete" ON "course_lesson";
DROP POLICY IF EXISTS "course_lesson_update" ON "course_lesson";
DROP POLICY IF EXISTS "course_lesson_insert" ON "course_lesson";
DROP POLICY IF EXISTS "course_lesson_select" ON "course_lesson";


-- ── (18) Disable RLS on course_lesson ────────────────────────────────────────

ALTER TABLE "course_lesson" DISABLE ROW LEVEL SECURITY;


-- ── (19–21) Drop indexes on course_lesson ────────────────────────────────────

DROP INDEX IF EXISTS "course_lesson_org_course_idx";
DROP INDEX IF EXISTS "course_lesson_course_id_position_unique";
DROP INDEX IF EXISTS "course_lesson_id_org_id_unique";


-- ── (22) Drop table course_lesson ─────────────────────────────────────────────
-- Drops all remaining constraints (org FK, composite FKs, CHECKs).

DROP TABLE IF EXISTS "course_lesson";


-- ── (23) Revoke grant on course ──────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "course" FROM aeroops_app;


-- ── (24) Drop RLS policies on course ─────────────────────────────────────────

DROP POLICY IF EXISTS "course_delete" ON "course";
DROP POLICY IF EXISTS "course_update" ON "course";
DROP POLICY IF EXISTS "course_insert" ON "course";
DROP POLICY IF EXISTS "course_select" ON "course";


-- ── (25) Disable RLS on course ────────────────────────────────────────────────

ALTER TABLE "course" DISABLE ROW LEVEL SECURITY;


-- ── (26–27) Drop indexes on course ───────────────────────────────────────────

DROP INDEX IF EXISTS "course_org_status_idx";
DROP INDEX IF EXISTS "course_id_org_id_unique";


-- ── (28) Drop table course ────────────────────────────────────────────────────
-- Drops all remaining constraints (org FK, created_by composite FK, CHECKs).

DROP TABLE IF EXISTS "course";


-- ── (29) Drop type lesson_record_status ──────────────────────────────────────

DROP TYPE IF EXISTS "lesson_record_status";


-- ── (30) Drop type enrollment_status ─────────────────────────────────────────

DROP TYPE IF EXISTS "enrollment_status";
