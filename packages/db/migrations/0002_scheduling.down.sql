-- ============================================================
-- AeroOps — Phase 1 Slice 1 ROLLBACK PLAN
-- Migration: 0002_scheduling.down.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0002_scheduling.sql in strict dependency order.
--
-- Dependency order:
--   1. Drop all RLS policies (they reference tables/columns).
--   2. Disable + un-force RLS on all 3 tenant tables.
--   3. Revoke grants from aeroops_app.
--   4. Drop indexes (auto-dropped with tables; listed for clarity).
--   5. Drop tables in FK-safe order: reservation_resource → reservation → resource.
--   6. Drop enum types: reservation_status, resource_kind.
--   7. btree_gist — intentionally LEFT IN PLACE (see note below).
--
-- btree_gist is NOT dropped because:
--   (a) Dropping a shared extension is risky — other objects in the DB
--       may depend on it (e.g. future PostGIS integration uses GiST indexes).
--   (b) The extension is safe to leave installed and idempotent to re-create
--       (CREATE EXTENSION IF NOT EXISTS btree_gist).
--   (c) Consistent with the pgcrypto precedent in 0000_loud_prodigy.down.sql.
--   If you are certain no other object uses btree_gist, you may add:
--     DROP EXTENSION IF EXISTS btree_gist;
--   but that must be a separate, explicitly reviewed step.
-- ============================================================


-- ── (1) Drop RLS policies ─────────────────────────────────────────────────────

-- reservation_resource policies
DROP POLICY IF EXISTS "reservation_resource_delete" ON "reservation_resource";
DROP POLICY IF EXISTS "reservation_resource_update" ON "reservation_resource";
DROP POLICY IF EXISTS "reservation_resource_insert" ON "reservation_resource";
DROP POLICY IF EXISTS "reservation_resource_select" ON "reservation_resource";

-- reservation policies
DROP POLICY IF EXISTS "reservation_delete" ON "reservation";
DROP POLICY IF EXISTS "reservation_update" ON "reservation";
DROP POLICY IF EXISTS "reservation_insert" ON "reservation";
DROP POLICY IF EXISTS "reservation_select" ON "reservation";

-- resource policies
DROP POLICY IF EXISTS "resource_delete" ON "resource";
DROP POLICY IF EXISTS "resource_update" ON "resource";
DROP POLICY IF EXISTS "resource_insert" ON "resource";
DROP POLICY IF EXISTS "resource_select" ON "resource";


-- ── (2) Disable + un-force RLS on all 3 tenant tables ────────────────────────

ALTER TABLE IF EXISTS "reservation_resource" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "reservation_resource" DISABLE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS "reservation"          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "reservation"          DISABLE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS "resource"             NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "resource"             DISABLE ROW LEVEL SECURITY;


-- ── (3) Revoke grants from aeroops_app ───────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aeroops_app') THEN
    REVOKE ALL PRIVILEGES ON "reservation_resource" FROM aeroops_app;
    REVOKE ALL PRIVILEGES ON "reservation"          FROM aeroops_app;
    REVOKE ALL PRIVILEGES ON "resource"             FROM aeroops_app;
  END IF;
END
$$;


-- ── (4) Drop indexes (auto-removed with tables — listed for clarity) ──────────

DROP INDEX IF EXISTS "reservation_resource_org_resource_status_idx";
DROP INDEX IF EXISTS "reservation_org_id_status_idx";
DROP INDEX IF EXISTS "resource_org_id_kind_idx";


-- ── (5) Drop tables — FK-safe order (children before parents) ────────────────

-- reservation_resource references reservation and resource
DROP TABLE IF EXISTS "reservation_resource";

-- reservation references org and app_user
DROP TABLE IF EXISTS "reservation";

-- resource references org and app_user (composite FK for instructor)
DROP TABLE IF EXISTS "resource";


-- ── (6) Drop enum types ────────────────────────────────────────────────────────

DROP TYPE IF EXISTS "public"."reservation_status";
DROP TYPE IF EXISTS "public"."resource_kind";


-- ── (7) btree_gist — intentionally LEFT IN PLACE ─────────────────────────────
-- See header comment. Add the line below only after explicit human confirmation
-- that no other object in this database depends on btree_gist:
--   DROP EXTENSION IF EXISTS btree_gist;
