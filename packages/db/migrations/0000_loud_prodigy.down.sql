-- ============================================================
-- AeroOps — Slice 0.1 ROLLBACK PLAN
-- Migration: 0000_loud_prodigy.down.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0000_loud_prodigy.sql in strict
-- dependency order (policies → RLS → tables FK-safe → enum → role).
--
-- Dependency order rationale:
--   1. Drop all RLS policies first (they reference tables/columns).
--   2. Disable and un-force RLS on each table.
--   3. Revoke grants from aeroops_app (role must exist to revoke from it).
--   4. Drop the aeroops_app role.
--   5. Drop indexes (auto-dropped with their tables, listed for clarity).
--   6. Drop tables in FK-safe order: children before parents.
--      membership → app_user → location → audit_log → subscription → plan → org
--   7. Drop the membership_role enum type.
--   8. pgcrypto extension: LEFT IN PLACE intentionally.
--      DROP EXTENSION pgcrypto is omitted because:
--        (a) other objects in the DB may depend on it,
--        (b) it is safe to leave installed and idempotent to re-create.
--      If you are certain no other object uses pgcrypto, you may add:
--        DROP EXTENSION IF EXISTS pgcrypto;
--      but that must be a separate, explicitly reviewed step.
-- ============================================================


-- ── (1) Drop RLS policies ─────────────────────────────────────────────────────
-- org policies
DROP POLICY IF EXISTS "org_insert_platform_admin" ON "org";
DROP POLICY IF EXISTS "org_delete"                 ON "org";
DROP POLICY IF EXISTS "org_update"                 ON "org";
DROP POLICY IF EXISTS "org_select"                 ON "org";

-- location policies
DROP POLICY IF EXISTS "location_delete" ON "location";
DROP POLICY IF EXISTS "location_update" ON "location";
DROP POLICY IF EXISTS "location_insert" ON "location";
DROP POLICY IF EXISTS "location_select" ON "location";

-- app_user policies
DROP POLICY IF EXISTS "app_user_delete" ON "app_user";
DROP POLICY IF EXISTS "app_user_update" ON "app_user";
DROP POLICY IF EXISTS "app_user_insert" ON "app_user";
DROP POLICY IF EXISTS "app_user_select" ON "app_user";

-- membership policies
DROP POLICY IF EXISTS "membership_delete" ON "membership";
DROP POLICY IF EXISTS "membership_update" ON "membership";
DROP POLICY IF EXISTS "membership_insert" ON "membership";
DROP POLICY IF EXISTS "membership_select" ON "membership";

-- audit_log policies (SELECT + INSERT only — no UPDATE/DELETE policies exist)
DROP POLICY IF EXISTS "audit_log_insert" ON "audit_log";
DROP POLICY IF EXISTS "audit_log_select" ON "audit_log";


-- ── (2) Disable + un-force RLS on tenant tables ──────────────────────────────
ALTER TABLE IF EXISTS "org"        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "org"        DISABLE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS "location"   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "location"   DISABLE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS "app_user"   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "app_user"   DISABLE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS "membership" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "membership" DISABLE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS "audit_log"  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "audit_log"  DISABLE ROW LEVEL SECURITY;


-- ── (3) Revoke grants from aeroops_app ──────────────────────────────────────
-- Must revoke before dropping the role; otherwise DROP ROLE will fail because
-- the role still holds privileges.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aeroops_app') THEN
    REVOKE ALL PRIVILEGES ON
      org, location, app_user, membership, audit_log, plan, subscription
    FROM aeroops_app;
    REVOKE USAGE ON SCHEMA public FROM aeroops_app;
  END IF;
END
$$;


-- ── (4) Drop the aeroops_app role ─────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aeroops_app') THEN
    DROP ROLE aeroops_app;
  END IF;
END
$$;


-- ── (5) Drop indexes (explicit; auto-removed with tables — listed for clarity)
DROP INDEX IF EXISTS "audit_log_org_entity_idx";
DROP INDEX IF EXISTS "audit_log_org_id_idx";
DROP INDEX IF EXISTS "membership_user_id_idx";
DROP INDEX IF EXISTS "location_org_id_idx";


-- ── (6) Drop tables — children before parents (FK-safe order) ────────────────

-- audit_log references org and app_user
DROP TABLE IF EXISTS "audit_log";

-- membership references org and app_user (composite FK)
DROP TABLE IF EXISTS "membership";

-- subscription references org and plan
DROP TABLE IF EXISTS "subscription";

-- app_user references org
DROP TABLE IF EXISTS "app_user";

-- location references org
DROP TABLE IF EXISTS "location";

-- plan has no FK dependencies from above (subscription already dropped)
DROP TABLE IF EXISTS "plan";

-- org is the root; all dependants dropped above
DROP TABLE IF EXISTS "org";


-- ── (7) Drop the membership_role enum ────────────────────────────────────────
DROP TYPE IF EXISTS "public"."membership_role";


-- ── (8) pgcrypto — intentionally LEFT IN PLACE ───────────────────────────────
-- See header comment. Add the line below only after explicit human confirmation
-- that no other object in this database depends on pgcrypto:
--   DROP EXTENSION IF EXISTS pgcrypto;
