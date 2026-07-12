-- ============================================================
-- AeroOps — Down migration for 0045_fee_passing_balance_payment.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes the
-- balance_payment table (and all balance-payment records) and drops the
-- dispatch_config.pass_ach_fee_to_member column (reverting every org to
-- fee-passing OFF).
--
-- Reverses (in order — reverse of up):
--   (6) REVOKE grant
--   (5) DROP RLS policies
--   (4) DISABLE + un-FORCE RLS
--   (3) DROP index
--   (2) DROP TABLE balance_payment
--   (1) DROP COLUMN dispatch_config.pass_ach_fee_to_member
-- ============================================================


-- ── (6) Revoke grant ──────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "balance_payment" FROM aeroops_app;


-- ── (5) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "balance_payment_delete" ON "balance_payment";
DROP POLICY IF EXISTS "balance_payment_update" ON "balance_payment";
DROP POLICY IF EXISTS "balance_payment_insert" ON "balance_payment";
DROP POLICY IF EXISTS "balance_payment_select" ON "balance_payment";


-- ── (4) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "balance_payment" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "balance_payment" DISABLE ROW LEVEL SECURITY;


-- ── (3) Drop index ────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "balance_payment_org_user_idx";


-- ── (2) DROP TABLE balance_payment ────────────────────────────────────────────

DROP TABLE IF EXISTS "balance_payment";


-- ── (1) DROP COLUMN dispatch_config.pass_ach_fee_to_member ────────────────────

ALTER TABLE "dispatch_config" DROP COLUMN IF EXISTS "pass_ach_fee_to_member";
