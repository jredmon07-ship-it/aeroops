-- ============================================================
-- AeroOps — Down migration for 0034_block_time.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes all
-- block_package/block_purchase records, both tables, and NARROWS
-- ledger_entry.entry_type back to its migration-0022 domain.
--
-- ⚠️  SAFE ONLY IF no 'block_purchase' ledger_entry rows exist — narrowing the
-- CHECK constraint back will fail (or, if forced through a data migration,
-- would orphan the semantic meaning of any existing 'block_purchase' rows).
-- A human must confirm this before running.
--
-- Reverses (in order — reverse of up):
--   (7) REVOKE grants
--   (6) DROP RLS policies
--   (5) DISABLE + un-FORCE RLS
--   (4) DROP indexes
--   (3) RESTORE ledger_entry.entry_type CHECK to its migration-0022 domain
--   (2) DROP TABLE block_purchase (references block_package + app_user)
--   (1) DROP TABLE block_package
-- ============================================================


-- ── (7) Revoke grants ─────────────────────────────────────────────────────────

REVOKE SELECT, INSERT ON "block_purchase" FROM aeroops_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON "block_package" FROM aeroops_app;


-- ── (6) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "block_purchase_insert" ON "block_purchase";
DROP POLICY IF EXISTS "block_purchase_select" ON "block_purchase";

DROP POLICY IF EXISTS "block_package_delete" ON "block_package";
DROP POLICY IF EXISTS "block_package_update" ON "block_package";
DROP POLICY IF EXISTS "block_package_insert" ON "block_package";
DROP POLICY IF EXISTS "block_package_select" ON "block_package";


-- ── (5) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "block_purchase" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "block_purchase" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "block_package"  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "block_package"  DISABLE ROW LEVEL SECURITY;


-- ── (4) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "block_purchase_org_user_purchased_idx";
DROP INDEX IF EXISTS "block_package_org_active_name_idx";


-- ── (3) Restore ledger_entry.entry_type CHECK to its migration-0022 domain ──

ALTER TABLE "ledger_entry"
  DROP CONSTRAINT IF EXISTS "ledger_entry_entry_type_check";

ALTER TABLE "ledger_entry"
  ADD CONSTRAINT "ledger_entry_entry_type_check" CHECK (
    "entry_type" IN ('invoice_finalized', 'payment', 'credit_memo', 'adjustment')
  );


-- ── (2) DROP TABLE block_purchase ────────────────────────────────────────────
-- Must be dropped before block_package (FK dependency).

DROP TABLE IF EXISTS "block_purchase";


-- ── (1) DROP TABLE block_package ─────────────────────────────────────────────

DROP TABLE IF EXISTS "block_package";
