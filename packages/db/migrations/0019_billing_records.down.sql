-- ============================================================
-- AeroOps — Down migration for 0019_billing_records.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes
-- all billing record data and the three tables themselves.
--
-- Reverses (in order — reverse of up):
--   (7) REVOKE grants
--   (6) DROP RLS policies (4 per table)
--   (5) DISABLE + un-FORCE RLS
--   (4) DROP indexes
--   (3) DROP TABLE invoice_line_item  (references invoice + rate_schedule)
--   (2) DROP TABLE invoice
--   (1) DROP TABLE rate_schedule
-- ============================================================


-- ── (7) Revoke grants ─────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "invoice_line_item" FROM aeroops_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON "invoice"           FROM aeroops_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON "rate_schedule"     FROM aeroops_app;


-- ── (6) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "invoice_line_item_delete" ON "invoice_line_item";
DROP POLICY IF EXISTS "invoice_line_item_update" ON "invoice_line_item";
DROP POLICY IF EXISTS "invoice_line_item_insert" ON "invoice_line_item";
DROP POLICY IF EXISTS "invoice_line_item_select" ON "invoice_line_item";

DROP POLICY IF EXISTS "invoice_delete" ON "invoice";
DROP POLICY IF EXISTS "invoice_update" ON "invoice";
DROP POLICY IF EXISTS "invoice_insert" ON "invoice";
DROP POLICY IF EXISTS "invoice_select" ON "invoice";

DROP POLICY IF EXISTS "rate_schedule_delete" ON "rate_schedule";
DROP POLICY IF EXISTS "rate_schedule_update" ON "rate_schedule";
DROP POLICY IF EXISTS "rate_schedule_insert" ON "rate_schedule";
DROP POLICY IF EXISTS "rate_schedule_select" ON "rate_schedule";


-- ── (5) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "invoice_line_item"  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "invoice_line_item"  DISABLE ROW LEVEL SECURITY;

ALTER TABLE "invoice"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "invoice"            DISABLE ROW LEVEL SECURITY;

ALTER TABLE "rate_schedule"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "rate_schedule"      DISABLE ROW LEVEL SECURITY;


-- ── (4) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "invoice_line_item_org_invoice_idx";
DROP INDEX IF EXISTS "invoice_org_member_idx";
DROP INDEX IF EXISTS "invoice_org_status_created_idx";
DROP INDEX IF EXISTS "rate_schedule_org_resource_idx";


-- ── (3) DROP TABLE invoice_line_item ─────────────────────────────────────────
-- Must be dropped before invoice and rate_schedule (FK dependencies).
-- CASCADE removes all dependent constraints.

DROP TABLE IF EXISTS "invoice_line_item";


-- ── (2) DROP TABLE invoice ────────────────────────────────────────────────────
-- Must be dropped before rate_schedule (none, but after invoice_line_item).
-- CASCADE removes all dependent constraints and the UNIQUE index.

DROP TABLE IF EXISTS "invoice";


-- ── (1) DROP TABLE rate_schedule ─────────────────────────────────────────────
-- Dropped last (referenced by invoice_line_item which is already gone).
-- CASCADE removes all dependent constraints and the UNIQUE index.

DROP TABLE IF EXISTS "rate_schedule";
