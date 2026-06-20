-- ============================================================
-- AeroOps — Slice M1.1 DOWN: reverse migration 0013_work_orders.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Reverses 0013_work_orders.sql in the exact opposite order:
--   (1) REVOKE grant
--   (2) DROP policies
--   (3) DISABLE + NO FORCE RLS
--   (4) DROP indexes
--   (5) DROP TABLE work_order
--   (6) DROP TYPE work_order_status
-- ============================================================

-- (1) Revoke grant
REVOKE SELECT, INSERT, UPDATE, DELETE ON "work_order" FROM aeroops_app;

-- (2) Drop RLS policies
DROP POLICY IF EXISTS "work_order_delete" ON "work_order";
DROP POLICY IF EXISTS "work_order_update" ON "work_order";
DROP POLICY IF EXISTS "work_order_insert" ON "work_order";
DROP POLICY IF EXISTS "work_order_select" ON "work_order";

-- (3) Disable RLS
ALTER TABLE "work_order" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "work_order" DISABLE ROW LEVEL SECURITY;

-- (4) Drop indexes (table drop would cascade, but explicit for clarity)
DROP INDEX IF EXISTS "work_order_org_squawk_idx";
DROP INDEX IF EXISTS "work_order_org_resource_status_idx";
DROP INDEX IF EXISTS "work_order_id_org_id_unique";

-- (5) Drop table (cascades to constraints)
DROP TABLE IF EXISTS "work_order";

-- (6) Drop enum type
DROP TYPE IF EXISTS "work_order_status";
