-- ============================================================
-- AeroOps — Slice 3c ROLLBACK PLAN
-- Migration: 0009_dispatch_gate.down.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0009_dispatch_gate.sql in strict dependency order.
-- dispatch_requirement must be dropped before dispatch_config (no FK from
-- dispatch_requirement to dispatch_config, but reverse-order is safest).
--
-- Dependency order:
--   1. Drop all RLS policies on dispatch_requirement.
--   2. Disable + un-force RLS on dispatch_requirement.
--   3. Drop all RLS policies on dispatch_config.
--   4. Disable + un-force RLS on dispatch_config.
--   5. Revoke grants from aeroops_app (guarded by pg_roles check).
--   6. Drop index dispatch_requirement_org_resource_idx (auto-dropped with
--      table; listed for clarity and in case manual cleanup is needed).
--   7. Drop table dispatch_requirement (drops all its constraints and indexes).
--   8. Drop table dispatch_config (drops all its constraints and indexes).
--
-- [VERIFY-3c-A] / [VERIFY-3c-MONEY]: no financial data, no FAA data to clean up.
-- ============================================================


-- ── (1) Drop RLS policies on dispatch_requirement ────────────────────────────

DROP POLICY IF EXISTS "dispatch_requirement_delete" ON "dispatch_requirement";
DROP POLICY IF EXISTS "dispatch_requirement_update" ON "dispatch_requirement";
DROP POLICY IF EXISTS "dispatch_requirement_insert" ON "dispatch_requirement";
DROP POLICY IF EXISTS "dispatch_requirement_select" ON "dispatch_requirement";


-- ── (2) Disable + un-force RLS on dispatch_requirement ───────────────────────

ALTER TABLE IF EXISTS "dispatch_requirement" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "dispatch_requirement" DISABLE ROW LEVEL SECURITY;


-- ── (3) Drop RLS policies on dispatch_config ─────────────────────────────────

DROP POLICY IF EXISTS "dispatch_config_delete" ON "dispatch_config";
DROP POLICY IF EXISTS "dispatch_config_update" ON "dispatch_config";
DROP POLICY IF EXISTS "dispatch_config_insert" ON "dispatch_config";
DROP POLICY IF EXISTS "dispatch_config_select" ON "dispatch_config";


-- ── (4) Disable + un-force RLS on dispatch_config ────────────────────────────

ALTER TABLE IF EXISTS "dispatch_config" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "dispatch_config" DISABLE ROW LEVEL SECURITY;


-- ── (5) Revoke grants from aeroops_app ────────────────────────────────────────
-- Guarded by pg_roles check so this does not fail in envs where the role
-- does not yet exist (mirrors 0002.down / 0003.down / 0004.down / 0005.down /
-- 0006.down / 0007.down / 0008.down pattern).

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aeroops_app') THEN
    REVOKE ALL PRIVILEGES ON "dispatch_requirement" FROM aeroops_app;
    REVOKE ALL PRIVILEGES ON "dispatch_config" FROM aeroops_app;
  END IF;
END
$$;


-- ── (6) Drop index (auto-removed with table — listed for clarity) ─────────────

DROP INDEX IF EXISTS "dispatch_requirement_org_resource_idx";


-- ── (7) Drop table dispatch_requirement ──────────────────────────────────────
-- Dropping the table automatically removes all its constraints, indexes,
-- and the composite candidate keys.

DROP TABLE IF EXISTS "dispatch_requirement";


-- ── (8) Drop table dispatch_config ───────────────────────────────────────────
-- Dropping the table automatically removes all its constraints and indexes.

DROP TABLE IF EXISTS "dispatch_config";
