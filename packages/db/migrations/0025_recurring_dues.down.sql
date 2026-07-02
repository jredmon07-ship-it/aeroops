-- ============================================================
-- AeroOps — Down migration for 0025_recurring_dues.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes all
-- dues-schedule + dues-run records and the two tables.
--
-- Reverses (in order — reverse of up):
--   (6) REVOKE grants
--   (5) DROP RLS policies
--   (4) DISABLE + un-FORCE RLS
--   (3) DROP indexes
--   (2) DROP TABLE dues_run (references dues_schedule + invoice)
--   (1) DROP TABLE dues_schedule
-- ============================================================


-- ── (6) Revoke grants ──────────────────────────────────────────────────────────

REVOKE SELECT, INSERT ON "dues_run" FROM aeroops_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON "dues_schedule" FROM aeroops_app;


-- ── (5) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "dues_run_insert" ON "dues_run";
DROP POLICY IF EXISTS "dues_run_select" ON "dues_run";

DROP POLICY IF EXISTS "dues_schedule_delete" ON "dues_schedule";
DROP POLICY IF EXISTS "dues_schedule_update" ON "dues_schedule";
DROP POLICY IF EXISTS "dues_schedule_insert" ON "dues_schedule";
DROP POLICY IF EXISTS "dues_schedule_select" ON "dues_schedule";


-- ── (4) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "dues_run"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "dues_run"      DISABLE ROW LEVEL SECURITY;

ALTER TABLE "dues_schedule" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "dues_schedule" DISABLE ROW LEVEL SECURITY;


-- ── (3) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "dues_run_org_created_idx";
DROP INDEX IF EXISTS "dues_schedule_org_user_idx";
DROP INDEX IF EXISTS "dues_schedule_org_active_idx";


-- ── (2) DROP TABLE dues_run ────────────────────────────────────────────────────

DROP TABLE IF EXISTS "dues_run";


-- ── (1) DROP TABLE dues_schedule ────────────────────────────────────────────────

DROP TABLE IF EXISTS "dues_schedule";
