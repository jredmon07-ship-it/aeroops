-- ============================================================
-- AeroOps — Slice 6.1 ROLLBACK PLAN
-- Migration: 0008_people.down.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0008_people.sql in strict dependency order.
--
-- Dependency order:
--   1. Drop all RLS policies on member_tag.
--   2. Disable + un-force RLS on member_tag.
--   3. Revoke grants from aeroops_app (guarded by pg_roles check).
--   4. Drop index member_tag_org_user_idx (auto-dropped with table; listed for
--      clarity and in case manual cleanup is needed before table drop).
--   5. Drop table member_tag (drops all its constraints and indexes).
--   6. Drop app_user_status_check constraint.
--   7. Drop app_user.status column.
--   8. Drop app_user.phone column.
-- ============================================================


-- ── (1) Drop RLS policies on member_tag ──────────────────────────────────────

DROP POLICY IF EXISTS "member_tag_delete" ON "member_tag";
DROP POLICY IF EXISTS "member_tag_update" ON "member_tag";
DROP POLICY IF EXISTS "member_tag_insert" ON "member_tag";
DROP POLICY IF EXISTS "member_tag_select" ON "member_tag";


-- ── (2) Disable + un-force RLS on member_tag ──────────────────────────────────

ALTER TABLE IF EXISTS "member_tag" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "member_tag" DISABLE ROW LEVEL SECURITY;


-- ── (3) Revoke grants from aeroops_app ────────────────────────────────────────
-- Guarded by pg_roles check so this does not fail in envs where the role
-- does not yet exist (mirrors 0002.down / 0003.down / 0004.down / 0005.down /
-- 0006.down pattern).

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aeroops_app') THEN
    REVOKE ALL PRIVILEGES ON "member_tag" FROM aeroops_app;
  END IF;
END
$$;


-- ── (4) Drop index (auto-removed with table — listed for clarity) ─────────────

DROP INDEX IF EXISTS "member_tag_org_user_idx";


-- ── (5) Drop table member_tag ─────────────────────────────────────────────────
-- Dropping the table automatically removes all its constraints, indexes,
-- and the composite candidate key.

DROP TABLE IF EXISTS "member_tag";


-- ── (6) Drop app_user_status_check ────────────────────────────────────────────

ALTER TABLE "app_user"
  DROP CONSTRAINT IF EXISTS "app_user_status_check";


-- ── (7) Drop app_user.status column ───────────────────────────────────────────

ALTER TABLE "app_user" DROP COLUMN IF EXISTS "status";


-- ── (8) Drop app_user.phone column ────────────────────────────────────────────

ALTER TABLE "app_user" DROP COLUMN IF EXISTS "phone";
