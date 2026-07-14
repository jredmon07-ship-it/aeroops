-- ============================================================
-- DOWN — 0046_qbo_sync.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
--
-- Reverses migration 0046: drops the auto_export_invoices column and
-- re-narrows qbo_export_log.entity_type back to ('invoice','customer').
--
-- NOTE: re-narrowing the CHECK will FAIL if any qbo_export_log row with
-- entity_type='payment' exists — those payment-sync rows must be removed
-- first (a human operation, intentionally not automated here).
-- ============================================================

ALTER TABLE "qbo_export_log"
  DROP CONSTRAINT "qbo_export_log_entity_type_check";

ALTER TABLE "qbo_export_log"
  ADD CONSTRAINT "qbo_export_log_entity_type_check" CHECK (
    "entity_type" IN ('invoice', 'customer')
  );

ALTER TABLE "qbo_connection"
  DROP COLUMN "auto_export_invoices";
