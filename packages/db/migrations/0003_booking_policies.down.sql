-- ============================================================
-- AeroOps — Phase 1 Slice 2a ROLLBACK PLAN
-- Migration: 0003_booking_policies.down.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0003_booking_policies.sql in strict dependency order.
--
-- Dependency order:
--   1. Drop all RLS policies (they reference tables/columns).
--   2. Disable + un-force RLS on both new tenant tables.
--   3. Revoke grants from aeroops_app (guarded by pg_roles check).
--   4. Drop indexes (auto-dropped with tables; listed for clarity).
--   5. Drop tables in FK-safe order:
--        resource_blackout first (child of resource + app_user)
--        booking_policy second (child of resource)
--   6. No enum types to drop (no new enum was added in 0003).
--   7. No membership column to drop (booking_tags deferred; NOT added by 0003).
-- ============================================================


-- ── (1) Drop RLS policies ─────────────────────────────────────────────────────

-- resource_blackout policies (drop children-of-table first)
DROP POLICY IF EXISTS "resource_blackout_delete" ON "resource_blackout";
DROP POLICY IF EXISTS "resource_blackout_update" ON "resource_blackout";
DROP POLICY IF EXISTS "resource_blackout_insert" ON "resource_blackout";
DROP POLICY IF EXISTS "resource_blackout_select" ON "resource_blackout";

-- booking_policy policies
DROP POLICY IF EXISTS "booking_policy_delete" ON "booking_policy";
DROP POLICY IF EXISTS "booking_policy_update" ON "booking_policy";
DROP POLICY IF EXISTS "booking_policy_insert" ON "booking_policy";
DROP POLICY IF EXISTS "booking_policy_select" ON "booking_policy";


-- ── (2) Disable + un-force RLS on both new tenant tables ─────────────────────

ALTER TABLE IF EXISTS "resource_blackout" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "resource_blackout" DISABLE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS "booking_policy"    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "booking_policy"    DISABLE ROW LEVEL SECURITY;


-- ── (3) Revoke grants from aeroops_app ───────────────────────────────────────
-- Guarded by pg_roles check so this does not fail in envs where the role
-- does not yet exist (mirrors 0002.down pattern).

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aeroops_app') THEN
    REVOKE ALL PRIVILEGES ON "resource_blackout" FROM aeroops_app;
    REVOKE ALL PRIVILEGES ON "booking_policy"    FROM aeroops_app;
  END IF;
END
$$;


-- ── (4) Drop indexes (auto-removed with tables — listed for clarity) ──────────

DROP INDEX IF EXISTS "resource_blackout_org_id_resource_id_idx";
DROP INDEX IF EXISTS "booking_policy_org_id_resource_id_idx";


-- ── (5) Drop tables — FK-safe order (children before parents) ────────────────

-- resource_blackout references resource + app_user (composite FKs)
DROP TABLE IF EXISTS "resource_blackout";

-- booking_policy references resource (composite FK)
DROP TABLE IF EXISTS "booking_policy";


-- ── (6) No enum types — no new enum was added by 0003 ────────────────────────

-- ── (7) No membership column — booking_tags deferred; NOT added by 0003 ──────
