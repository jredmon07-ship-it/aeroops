-- ============================================================
-- AeroOps — Down migration for 0038_stage_check_enforcement.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes the
-- operator stage-check configuration (which lessons are stage checks and
-- which courses enforce them) AND every recorded stage-check pass/fail
-- outcome (lesson_record.stage_check_passed), for every org. The
-- lesson_record rows themselves, and all other training data, are NOT
-- touched.
--
-- Reverses (in order — reverse of up):
--   (3) DROP lesson_record.stage_check_passed
--   (2) DROP course.enforce_stage_checks
--   (1) DROP course_lesson.is_stage_check
-- ============================================================


-- ── (3) Drop lesson_record.stage_check_passed ─────────────────────────────────

ALTER TABLE "lesson_record" DROP COLUMN IF EXISTS "stage_check_passed";


-- ── (2) Drop course.enforce_stage_checks ──────────────────────────────────────

ALTER TABLE "course" DROP COLUMN IF EXISTS "enforce_stage_checks";


-- ── (1) Drop course_lesson.is_stage_check ─────────────────────────────────────

ALTER TABLE "course_lesson" DROP COLUMN IF EXISTS "is_stage_check";
