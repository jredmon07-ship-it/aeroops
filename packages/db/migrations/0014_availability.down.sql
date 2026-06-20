-- ============================================================
-- AeroOps — Slice AV1.1 DOWN: reverse migration 0014_availability.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0014_availability.sql in strict reverse order.
-- Constraints must be dropped before columns that back them; table
-- must be gone before dispatch_config columns are dropped.
--
-- [VERIFY-AV1-A/B/C/D]: no FAA/regulatory data, no financial data to clean up.
--
-- Dependency order (reverse of forward migration):
--  (1) REVOKE grant on resource_availability_window
--  (2) DROP policies on resource_availability_window
--  (3) DISABLE + NO FORCE RLS on resource_availability_window
--  (4) DROP indexes on resource_availability_window
--  (5) DROP TABLE resource_availability_window
--  (6) DROP CONSTRAINT dispatch_config_availability_mode_check
--  (7) DROP COLUMN dispatch_config.availability_mode
--  (8) DROP COLUMN dispatch_config.availability_constraint_enabled
-- ============================================================


-- ── (1) Revoke grant ──────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "resource_availability_window" FROM aeroops_app;


-- ── (2) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "resource_availability_window_delete" ON "resource_availability_window";
DROP POLICY IF EXISTS "resource_availability_window_update" ON "resource_availability_window";
DROP POLICY IF EXISTS "resource_availability_window_insert" ON "resource_availability_window";
DROP POLICY IF EXISTS "resource_availability_window_select" ON "resource_availability_window";


-- ── (3) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "resource_availability_window" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "resource_availability_window" DISABLE ROW LEVEL SECURITY;


-- ── (4) Drop indexes (table drop would cascade, but explicit for clarity) ─────

DROP INDEX IF EXISTS "resource_availability_window_org_resource_idx";
DROP INDEX IF EXISTS "resource_availability_window_natural_key_unique";
DROP INDEX IF EXISTS "resource_availability_window_id_org_id_unique";


-- ── (5) Drop table (cascades to constraints) ──────────────────────────────────

DROP TABLE IF EXISTS "resource_availability_window";


-- ── (6) Drop availability_mode domain check ───────────────────────────────────

ALTER TABLE "dispatch_config"
  DROP CONSTRAINT IF EXISTS "dispatch_config_availability_mode_check";


-- ── (7) Drop availability_mode column ────────────────────────────────────────

ALTER TABLE "dispatch_config" DROP COLUMN IF EXISTS "availability_mode";


-- ── (8) Drop availability_constraint_enabled column ──────────────────────────

ALTER TABLE "dispatch_config" DROP COLUMN IF EXISTS "availability_constraint_enabled";
