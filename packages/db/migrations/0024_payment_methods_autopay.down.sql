-- ============================================================
-- AeroOps — Down migration for 0024_payment_methods_autopay.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes
-- all saved payment-method + autopay-setting records and the two tables,
-- and restores stripe_customer_select to its pre-0024 (org-GUC-only) form.
--
-- Reverses (in order — reverse of up):
--   (7) Restore stripe_customer_select to org-GUC-only (undo the platform-
--       admin SELECT branch added by 0024)
--   (6) REVOKE grants
--   (5) DROP RLS policies
--   (4) DISABLE + un-FORCE RLS
--   (3) DROP indexes
--   (2) DROP TABLE autopay_setting (references stripe_payment_method)
--   (1) DROP TABLE stripe_payment_method
-- ============================================================


-- ── (7) Restore stripe_customer_select (org-GUC-only, pre-0024 form) ──────────

DROP POLICY "stripe_customer_select" ON "stripe_customer";

CREATE POLICY "stripe_customer_select"
  ON "stripe_customer"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (6) Revoke grants ──────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "autopay_setting"       FROM aeroops_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON "stripe_payment_method" FROM aeroops_app;


-- ── (5) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "autopay_setting_delete" ON "autopay_setting";
DROP POLICY IF EXISTS "autopay_setting_update" ON "autopay_setting";
DROP POLICY IF EXISTS "autopay_setting_insert" ON "autopay_setting";
DROP POLICY IF EXISTS "autopay_setting_select" ON "autopay_setting";

DROP POLICY IF EXISTS "stripe_payment_method_delete" ON "stripe_payment_method";
DROP POLICY IF EXISTS "stripe_payment_method_update" ON "stripe_payment_method";
DROP POLICY IF EXISTS "stripe_payment_method_insert" ON "stripe_payment_method";
DROP POLICY IF EXISTS "stripe_payment_method_select" ON "stripe_payment_method";


-- ── (4) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "autopay_setting"       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "autopay_setting"       DISABLE ROW LEVEL SECURITY;

ALTER TABLE "stripe_payment_method" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "stripe_payment_method" DISABLE ROW LEVEL SECURITY;


-- ── (3) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "stripe_payment_method_org_user_idx";


-- ── (2) DROP TABLE autopay_setting ────────────────────────────────────────────

DROP TABLE IF EXISTS "autopay_setting";


-- ── (1) DROP TABLE stripe_payment_method ──────────────────────────────────────

DROP TABLE IF EXISTS "stripe_payment_method";
