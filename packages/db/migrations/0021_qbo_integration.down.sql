-- ============================================================
-- AeroOps — Down migration for 0021_qbo_integration.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes
-- all QuickBooks connection/export-log/account-mapping data and the
-- three tables themselves. It does NOT affect the underlying billing
-- records (rate_schedule/invoice/invoice_line_item, migration 0019) —
-- those are untouched by this migration and its reversal.
--
-- Reverses (in order — reverse of up):
--   (7) REVOKE grants
--   (6) DROP RLS policies
--   (5) DISABLE + un-FORCE RLS
--   (4) DROP indexes
--   (3) DROP TABLE qbo_account_mapping
--   (2) DROP TABLE qbo_export_log
--   (1) DROP TABLE qbo_connection
-- ============================================================


-- ── (7) Revoke grants ─────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "qbo_account_mapping" FROM aeroops_app;
REVOKE SELECT, INSERT                 ON "qbo_export_log"      FROM aeroops_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON "qbo_connection"      FROM aeroops_app;


-- ── (6) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "qbo_account_mapping_delete" ON "qbo_account_mapping";
DROP POLICY IF EXISTS "qbo_account_mapping_update" ON "qbo_account_mapping";
DROP POLICY IF EXISTS "qbo_account_mapping_insert" ON "qbo_account_mapping";
DROP POLICY IF EXISTS "qbo_account_mapping_select" ON "qbo_account_mapping";

DROP POLICY IF EXISTS "qbo_export_log_insert" ON "qbo_export_log";
DROP POLICY IF EXISTS "qbo_export_log_select" ON "qbo_export_log";

DROP POLICY IF EXISTS "qbo_connection_delete" ON "qbo_connection";
DROP POLICY IF EXISTS "qbo_connection_update" ON "qbo_connection";
DROP POLICY IF EXISTS "qbo_connection_insert" ON "qbo_connection";
DROP POLICY IF EXISTS "qbo_connection_select" ON "qbo_connection";


-- ── (5) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "qbo_account_mapping" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "qbo_account_mapping" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "qbo_export_log"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "qbo_export_log"      DISABLE ROW LEVEL SECURITY;

ALTER TABLE "qbo_connection"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "qbo_connection"      DISABLE ROW LEVEL SECURITY;


-- ── (4) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "qbo_account_mapping_org_idx";
DROP INDEX IF EXISTS "qbo_export_log_org_entity_exported_unique";
DROP INDEX IF EXISTS "qbo_export_log_org_entity_idx";
DROP INDEX IF EXISTS "qbo_export_log_org_created_idx";


-- ── (3) DROP TABLE qbo_account_mapping ───────────────────────────────────────

DROP TABLE IF EXISTS "qbo_account_mapping";


-- ── (2) DROP TABLE qbo_export_log ────────────────────────────────────────────

DROP TABLE IF EXISTS "qbo_export_log";


-- ── (1) DROP TABLE qbo_connection ────────────────────────────────────────────

DROP TABLE IF EXISTS "qbo_connection";
