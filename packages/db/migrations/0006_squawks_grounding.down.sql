-- ============================================================
-- AeroOps — Phase 1 Slice 3b ROLLBACK PLAN
-- Migration: 0006_squawks_grounding.down.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0006_squawks_grounding.sql in strict dependency order.
--
-- Dependency order:
--   1. Drop all RLS policies on aircraft_grounding (referencing squawk via FK —
--      must drop aircraft_grounding before squawk to satisfy FK constraint).
--   2. Drop all RLS policies on squawk.
--   3. Disable + un-force RLS on both tables.
--   4. Revoke grants from aeroops_app (guarded by pg_roles check).
--   5. Drop indexes on both tables (auto-dropped with table; listed for
--      clarity and in case manual cleanup is needed before table drop).
--   6. Drop table aircraft_grounding (composite FK squawk_id → squawk must
--      be dropped first to allow squawk to be dropped after).
--   7. Drop table squawk (after aircraft_grounding removed its FK reference).
--   8. Drop enum types: squawk_severity, squawk_status, grounding_state.
-- ============================================================


-- ── (1) Drop RLS policies on aircraft_grounding ──────────────────────────────

DROP POLICY IF EXISTS "aircraft_grounding_delete" ON "aircraft_grounding";
DROP POLICY IF EXISTS "aircraft_grounding_update" ON "aircraft_grounding";
DROP POLICY IF EXISTS "aircraft_grounding_insert" ON "aircraft_grounding";
DROP POLICY IF EXISTS "aircraft_grounding_select" ON "aircraft_grounding";


-- ── (2) Drop RLS policies on squawk ──────────────────────────────────────────

DROP POLICY IF EXISTS "squawk_delete" ON "squawk";
DROP POLICY IF EXISTS "squawk_update" ON "squawk";
DROP POLICY IF EXISTS "squawk_insert" ON "squawk";
DROP POLICY IF EXISTS "squawk_select" ON "squawk";


-- ── (3) Disable + un-force RLS on both tables ─────────────────────────────────

ALTER TABLE IF EXISTS "aircraft_grounding" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "aircraft_grounding" DISABLE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS "squawk" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "squawk" DISABLE ROW LEVEL SECURITY;


-- ── (4) Revoke grants from aeroops_app ───────────────────────────────────────
-- Guarded by pg_roles check so this does not fail in envs where the role
-- does not yet exist (mirrors 0002.down / 0003.down / 0004.down / 0005.down pattern).

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aeroops_app') THEN
    REVOKE ALL PRIVILEGES ON "aircraft_grounding" FROM aeroops_app;
    REVOKE ALL PRIVILEGES ON "squawk" FROM aeroops_app;
  END IF;
END
$$;


-- ── (5) Drop indexes (auto-removed with table — listed for clarity) ───────────

DROP INDEX IF EXISTS "aircraft_grounding_org_resource_created_idx";
DROP INDEX IF EXISTS "squawk_org_resource_status_idx";


-- ── (6) Drop table aircraft_grounding ─────────────────────────────────────────
-- Must precede squawk drop: aircraft_grounding has a FK into squawk(id, org_id).
-- Dropping the table automatically removes all its constraints and indexes.

DROP TABLE IF EXISTS "aircraft_grounding";


-- ── (7) Drop table squawk ─────────────────────────────────────────────────────
-- Now safe to drop because aircraft_grounding (which referenced it) is gone.
-- Dropping the table automatically removes all its constraints, indexes, and
-- the UNIQUE (id, org_id) composite candidate key.

DROP TABLE IF EXISTS "squawk";


-- ── (8) Drop enum types ───────────────────────────────────────────────────────

DROP TYPE IF EXISTS "public"."squawk_severity";
DROP TYPE IF EXISTS "public"."squawk_status";
DROP TYPE IF EXISTS "public"."grounding_state";
