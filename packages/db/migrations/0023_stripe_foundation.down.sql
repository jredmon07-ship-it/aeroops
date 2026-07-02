-- ============================================================
-- AeroOps — Down migration for 0023_stripe_foundation.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes
-- all Stripe-foundation records and the three tables.
--
-- Reverses (in order — reverse of up):
--   (7) REVOKE grants
--   (6) DROP RLS policies
--   (5) DISABLE + un-FORCE RLS
--   (4) DROP indexes
--   (3) DROP TABLE payment_intent_record (references invoice)
--   (2) DROP TABLE stripe_event
--   (1) DROP TABLE stripe_customer
-- ============================================================


-- ── (7) Revoke grants ─────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "payment_intent_record" FROM aeroops_app;
REVOKE SELECT, INSERT ON "stripe_event" FROM aeroops_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON "stripe_customer" FROM aeroops_app;


-- ── (6) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "payment_intent_record_delete" ON "payment_intent_record";
DROP POLICY IF EXISTS "payment_intent_record_update" ON "payment_intent_record";
DROP POLICY IF EXISTS "payment_intent_record_insert" ON "payment_intent_record";
DROP POLICY IF EXISTS "payment_intent_record_select" ON "payment_intent_record";

DROP POLICY IF EXISTS "stripe_event_insert" ON "stripe_event";
DROP POLICY IF EXISTS "stripe_event_select" ON "stripe_event";

DROP POLICY IF EXISTS "stripe_customer_delete" ON "stripe_customer";
DROP POLICY IF EXISTS "stripe_customer_update" ON "stripe_customer";
DROP POLICY IF EXISTS "stripe_customer_insert" ON "stripe_customer";
DROP POLICY IF EXISTS "stripe_customer_select" ON "stripe_customer";


-- ── (5) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "payment_intent_record" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_intent_record" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "stripe_event"          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "stripe_event"          DISABLE ROW LEVEL SECURITY;

ALTER TABLE "stripe_customer"       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "stripe_customer"       DISABLE ROW LEVEL SECURITY;


-- ── (4) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "payment_intent_record_invoice_active_unique";
DROP INDEX IF EXISTS "payment_intent_record_org_invoice_idx";
DROP INDEX IF EXISTS "stripe_event_org_processed_idx";
DROP INDEX IF EXISTS "stripe_customer_org_user_idx";


-- ── (3) DROP TABLE payment_intent_record ──────────────────────────────────────

DROP TABLE IF EXISTS "payment_intent_record";


-- ── (2) DROP TABLE stripe_event ───────────────────────────────────────────────

DROP TABLE IF EXISTS "stripe_event";


-- ── (1) DROP TABLE stripe_customer ────────────────────────────────────────────

DROP TABLE IF EXISTS "stripe_customer";
