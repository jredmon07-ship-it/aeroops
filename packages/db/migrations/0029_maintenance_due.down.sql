-- ============================================================
-- AeroOps — Down migration for 0029_maintenance_due.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes all
-- maintenance_item records (operator-entered maintenance-due tracking data)
-- and the table itself.
--
-- Reverses (in order — reverse of up):
--   (5) REVOKE grants
--   (4) DROP RLS policies
--   (3) DISABLE + un-FORCE RLS
--   (2) DROP index
--   (1) DROP TABLE maintenance_item
-- ============================================================


-- ── (5) Revoke grants ────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "maintenance_item" FROM aeroops_app;


-- ── (4) Drop RLS policies ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "maintenance_item_delete" ON "maintenance_item";
DROP POLICY IF EXISTS "maintenance_item_update" ON "maintenance_item";
DROP POLICY IF EXISTS "maintenance_item_insert" ON "maintenance_item";
DROP POLICY IF EXISTS "maintenance_item_select" ON "maintenance_item";


-- ── (3) Disable RLS ──────────────────────────────────────────────────────────

ALTER TABLE "maintenance_item" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "maintenance_item" DISABLE ROW LEVEL SECURITY;


-- ── (2) Drop index ───────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "maintenance_item_org_resource_active_idx";


-- ── (1) DROP TABLE maintenance_item ─────────────────────────────────────────

DROP TABLE IF EXISTS "maintenance_item";
