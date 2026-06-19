-- ============================================================
-- AeroOps — Slice 4b ROLLBACK PLAN
-- Migration: 0011_optimizer_run.down.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0011_optimizer_run.sql in strict reverse order.
--
-- [VERIFY-4b-A/B]: no financial data, no regulatory data to clean up.
-- Dropping this table discards optimizer run history; confirm before applying.
--
-- Dependency order (reverse of forward migration):
--  (1) REVOKE GRANT from aeroops_app
--  (2) DROP POLICY schedule_optimization_run_delete
--  (3) DROP POLICY schedule_optimization_run_update
--  (4) DROP POLICY schedule_optimization_run_insert
--  (5) DROP POLICY schedule_optimization_run_select
--  (6) ALTER TABLE DISABLE ROW LEVEL SECURITY
--  (7) DROP INDEX schedule_optimization_run_org_created_idx
--  (8) DROP INDEX schedule_optimization_run_id_org_id_unique
--  (9) DROP TABLE schedule_optimization_run
-- ============================================================


-- ── (1) Revoke grant ──────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "schedule_optimization_run" FROM aeroops_app;


-- ── (2–5) Drop RLS policies ───────────────────────────────────────────────────

DROP POLICY IF EXISTS "schedule_optimization_run_delete"
  ON "schedule_optimization_run";

DROP POLICY IF EXISTS "schedule_optimization_run_update"
  ON "schedule_optimization_run";

DROP POLICY IF EXISTS "schedule_optimization_run_insert"
  ON "schedule_optimization_run";

DROP POLICY IF EXISTS "schedule_optimization_run_select"
  ON "schedule_optimization_run";


-- ── (6) Disable RLS ──────────────────────────────────────────────────────────

ALTER TABLE "schedule_optimization_run" DISABLE ROW LEVEL SECURITY;


-- ── (7) Drop listing index ────────────────────────────────────────────────────

DROP INDEX IF EXISTS "schedule_optimization_run_org_created_idx";


-- ── (8) Drop composite candidate key index ────────────────────────────────────

DROP INDEX IF EXISTS "schedule_optimization_run_id_org_id_unique";


-- ── (9) Drop table ────────────────────────────────────────────────────────────
-- Drops all remaining constraints (org FK, requested_by composite FK,
-- counts CHECK) and the table itself. CASCADE handles any dependent objects.

DROP TABLE IF EXISTS "schedule_optimization_run";
