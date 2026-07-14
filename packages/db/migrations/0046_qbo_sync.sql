-- ============================================================
-- AeroOps — QuickBooks Online: manual EXPORT → real SYNC
-- Migration: 0046_qbo_sync.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0045_fee_passing_balance_payment.sql
--               must already be applied.
--
-- CONTEXT: upgrades the QBO integration (Slice QB1, migration 0021) from a
-- manual per-invoice EXPORT into a real SYNC:
--
--   (1) AUTO-SYNC TOGGLE — a per-org boolean on the existing qbo_connection
--       row: `auto_export_invoices`. DEFAULT false → byte-identical existing
--       behavior (manual export only). When true AND the org is connected,
--       the web action layer best-effort exports a finalized invoice to QBO
--       AFTER finalizeInvoice commits (mirrors the post-commit notification
--       hook) — NEVER inside the money path, NEVER blocking it.
--
--   (2) PAYMENT SYNC — widens qbo_export_log.entity_type to additionally
--       permit 'payment'. A QBO ReceivePayment pushed against an
--       already-exported invoice is recorded as a qbo_export_log row exactly
--       like an invoice/customer export (entity_id = the ledger_entry id of
--       the 'payment' credit), reusing the same append-only push-history +
--       idempotency backstop (the partial UNIQUE index on
--       (org_id, entity_type, entity_id) WHERE status='exported' now also
--       guarantees a payment is synced AT MOST ONCE per org).
--
-- Key guarantees:
--   (a) STRICTLY ADDITIVE — one new column on qbo_connection (with a DEFAULT so
--       existing rows need no backfill) + a widened CHECK domain on
--       qbo_export_log.entity_type. No table is created or dropped; no data is
--       modified. The pre-existing 'invoice'/'customer' values remain valid.
--   (b) GRACEFUL ABSENCE: until this migration is applied, the new column does
--       NOT exist and entity_type='payment' is REJECTED by the old CHECK.
--       Every new consumer first probes qbo_connection for the
--       auto_export_invoices column (catalog-only query) — absent ⇒ the whole
--       SYNC layer degrades to OFF / not_available (byte-identical to the
--       pre-0046 manual-export world). Because the column and the widened
--       CHECK land together in this one atomic migration, the column probe is
--       a sufficient single guard for BOTH features.
--   (c) NO money moved. This is a bookkeeping SYNC of existing operator invoice
--       + payment RECORDS into the operator's own QBO company file. NO Stripe,
--       NO card/bank data, NO charge.
--
-- ORDER within this file:
--   (1) ALTER qbo_connection ADD COLUMN auto_export_invoices
--   (2) Widen qbo_export_log_entity_type_check to include 'payment'
-- ============================================================


-- ── (1) qbo_connection.auto_export_invoices ───────────────────────────────────
-- Per-org opt-in: auto-export finalized invoices to QuickBooks on finalize.
-- DEFAULT false → existing rows and all existing reads are unaffected.

ALTER TABLE "qbo_connection"
  ADD COLUMN "auto_export_invoices" boolean NOT NULL DEFAULT false;


-- ── (2) Widen qbo_export_log.entity_type domain ───────────────────────────────
-- Add 'payment' to the permitted entity types. A QBO ReceivePayment sync is
-- recorded as a qbo_export_log row (entity_id = the paying ledger_entry id),
-- reusing the append-only history + the existing partial-UNIQUE idempotency
-- index. Pre-existing 'invoice'/'customer' rows stay valid.

ALTER TABLE "qbo_export_log"
  DROP CONSTRAINT "qbo_export_log_entity_type_check";

ALTER TABLE "qbo_export_log"
  ADD CONSTRAINT "qbo_export_log_entity_type_check" CHECK (
    "entity_type" IN ('invoice', 'customer', 'payment')
  );
