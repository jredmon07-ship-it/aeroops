-- ============================================================
-- AeroOps — Down migration for 0031_pos_sales.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes all
-- product_catalog records (the operator's price list of non-flight goods and
-- services) and the table itself. It does NOT touch invoice/invoice_line_item
-- — historical counter-sale invoices are UNAFFECTED (their lines snapshot
-- name+price and hold no FK back to product_catalog).
--
-- Reverses (in order — reverse of up):
--   (5) REVOKE grants
--   (4) DROP RLS policies
--   (3) DISABLE + un-FORCE RLS
--   (2) DROP index
--   (1) DROP TABLE product_catalog
-- ============================================================


-- ── (5) Revoke grants ────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "product_catalog" FROM aeroops_app;


-- ── (4) Drop RLS policies ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "product_catalog_delete" ON "product_catalog";
DROP POLICY IF EXISTS "product_catalog_update" ON "product_catalog";
DROP POLICY IF EXISTS "product_catalog_insert" ON "product_catalog";
DROP POLICY IF EXISTS "product_catalog_select" ON "product_catalog";


-- ── (3) Disable RLS ──────────────────────────────────────────────────────────

ALTER TABLE "product_catalog" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "product_catalog" DISABLE ROW LEVEL SECURITY;


-- ── (2) Drop index ───────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "product_catalog_org_active_name_idx";


-- ── (1) DROP TABLE product_catalog ──────────────────────────────────────────

DROP TABLE IF EXISTS "product_catalog";
