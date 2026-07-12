-- ============================================================
-- AeroOps — Slice P2-SC1: stage-check enforcement (deferred from
-- the e-signature slice)
-- Migration: 0038_stage_check_enforcement.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0037_logbook_annotation.sql must
--               already be applied.
--
-- CONTEXT: Training (Slice T1, migration 0012) stores operator-defined
-- courses with ordered lessons and write-once lesson records. A "stage
-- check" is a milestone-evaluation lesson INSIDE a course. Today lessons
-- are ordered but nothing enforces passing a stage check before recording
-- later lessons. This slice adds the OPERATOR-SET gate: when an operator
-- opts a course in, recording a lesson positioned AFTER an unpassed
-- stage-check lesson is refused (stage_check_required) until a non-voided
-- record with stage_check_passed = true exists for that stage check.
--
-- COMPLIANCE HARD LINE: this gate enforces the OPERATOR's configured
-- course structure ONLY. is_stage_check / enforce_stage_checks /
-- stage_check_passed are operator/instructor data — NOT a Part-61/141
-- stage check of record, NOT an FAA milestone, graduation, or curriculum
-- determination of any kind. AeroOps computes NO regulatory verdict from
-- these flags; a human still makes every regulatory call. (Mirrors
-- [VERIFY-T1-A/B/G]; forward seam from ADR-0011's "stage-check
-- enforcement DEFERRED" list.)
--
-- Key guarantees:
--   (1) STRICTLY ADDITIVE — three new columns on existing tenant tables;
--       NO new table, NO new RLS policy needed (the three tables already
--       carry ENABLE+FORCE RLS from migration 0012; table-level GRANTs
--       cover new columns automatically).
--   (2) INERT DEFAULTS — course.enforce_stage_checks defaults false and
--       course_lesson.is_stage_check defaults false, so EXISTING behavior
--       is byte-identical until an operator opts in.
--   (3) lesson_record.stage_check_passed is NULLable and WRITE-ONCE (set
--       at CREATE time only — lesson_record has no UPDATE code path; the
--       void-tombstone posture from 0012 is unchanged). It is only
--       meaningful on records for stage-check lessons; NULL elsewhere.
--   (4) NO money. NO computed FAA determination.
--
-- ORDER within this file:
--   (1) ALTER TABLE course_lesson ADD COLUMN is_stage_check
--   (2) ALTER TABLE course        ADD COLUMN enforce_stage_checks
--   (3) ALTER TABLE lesson_record ADD COLUMN stage_check_passed
-- ============================================================


-- ── (1) course_lesson.is_stage_check ──────────────────────────────────────────
-- Operator flag: this lesson is a milestone-evaluation ("stage check")
-- lesson inside the course. NOT a Part-61/141 stage check of record —
-- the software attaches no regulatory meaning to it.

ALTER TABLE "course_lesson"
  ADD COLUMN "is_stage_check" boolean NOT NULL DEFAULT false;


-- ── (2) course.enforce_stage_checks ───────────────────────────────────────────
-- Operator opt-in: when true, recording a lesson positioned AFTER an
-- unpassed stage-check lesson is refused at the API layer
-- (stage_check_required). Default false = INERT — existing create-record
-- behavior is byte-identical until the operator opts in. This enforces
-- the OPERATOR's course structure, never a regulatory rule.

ALTER TABLE "course"
  ADD COLUMN "enforce_stage_checks" boolean NOT NULL DEFAULT false;


-- ── (3) lesson_record.stage_check_passed ──────────────────────────────────────
-- Instructor-entered pass/fail outcome for a STAGE-CHECK lesson record.
-- NULL on records for non-stage-check lessons (API-enforced: the input is
-- only accepted when the target lesson is_stage_check). Write-once — set
-- at INSERT, never mutated (lesson_record has no UPDATE path; corrections
-- go through the 0012 void-tombstone + re-record flow). NOT a computed
-- ACS/Part-61/141 verdict — the instructor states the outcome.

ALTER TABLE "lesson_record"
  ADD COLUMN "stage_check_passed" boolean;
