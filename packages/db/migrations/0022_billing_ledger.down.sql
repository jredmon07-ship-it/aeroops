-- ============================================================
-- AeroOps — Down migration for 0022_billing_ledger.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes
-- all ledger/account records, the two new tables, and the additive
-- dispatch_config.minimum_balance_cents column.
--
-- Reverses (in order — reverse of up):
--   (7) REVOKE grants
--   (6) DROP RLS policies
--   (5) DISABLE + un-FORCE RLS
--   (4) DROP indexes
--   (3) DROP dispatch_config.minimum_balance_cents (+ its CHECK)
--   (2) DROP TABLE ledger_entry (references billing_account + invoice)
--   (1) DROP TABLE billing_account
-- ============================================================


-- ── (7) Revoke grants ─────────────────────────────────────────────────────────

REVOKE SELECT, INSERT ON "ledger_entry" FROM aeroops_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON "billing_account" FROM aeroops_app;


-- ── (6) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "ledger_entry_insert" ON "ledger_entry";
DROP POLICY IF EXISTS "ledger_entry_select" ON "ledger_entry";

DROP POLICY IF EXISTS "billing_account_delete" ON "billing_account";
DROP POLICY IF EXISTS "billing_account_update" ON "billing_account";
DROP POLICY IF EXISTS "billing_account_insert" ON "billing_account";
DROP POLICY IF EXISTS "billing_account_select" ON "billing_account";


-- ── (5) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "ledger_entry"    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_entry"    DISABLE ROW LEVEL SECURITY;

ALTER TABLE "billing_account" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "billing_account" DISABLE ROW LEVEL SECURITY;


-- ── (4) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "ledger_entry_org_invoice_finalized_unique";
DROP INDEX IF EXISTS "ledger_entry_org_account_created_idx";
DROP INDEX IF EXISTS "billing_account_org_user_idx";


-- ── (3) Drop dispatch_config.minimum_balance_cents ────────────────────────────

ALTER TABLE "dispatch_config"
  DROP CONSTRAINT IF EXISTS "dispatch_config_minimum_balance_nonneg_check";

ALTER TABLE "dispatch_config" DROP COLUMN IF EXISTS "minimum_balance_cents";


-- ── (2) DROP TABLE ledger_entry ───────────────────────────────────────────────
-- Must be dropped before billing_account (FK dependency). CASCADE removes
-- all dependent constraints.

DROP TABLE IF EXISTS "ledger_entry";


-- ── (1) DROP TABLE billing_account ────────────────────────────────────────────

DROP TABLE IF EXISTS "billing_account";
