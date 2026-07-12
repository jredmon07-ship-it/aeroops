-- ============================================================
-- AeroOps — Reservation cancellation reason
-- Migration: 0042_cancellation_reason.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0041_member_tag_color.sql must
--               already be applied.
--
-- CONTEXT: cancelling a reservation (cancel-reservation.ts / cancel-series.ts)
-- already records who cancelled + when + an audit row. Operators asked to
-- capture WHY, so a cancellation report can show reasons and lead time. This
-- adds an OPTIONAL free-text reason to a reservation, persisted at cancel time.
--
-- Key guarantees:
--   (1) STRICTLY ADDITIVE — one new NULLABLE column on reservation. No existing
--       column/constraint/policy/grant is touched. A cancel that supplies no
--       reason leaves the column NULL (byte-identical to today's behavior).
--   (2) reason is FREE TEXT, sanely bounded (<= 500 chars) via a CHECK. The
--       column is only ever WRITTEN on the cancel path; the FROZEN create /
--       reschedule / dispatch paths never touch it.
--   (3) RLS is unchanged: reservation already ENABLE+FORCE RLS with the
--       standard org-scoped policies (migration 0002); a new column inherits
--       the table's row-level policies and the existing aeroops_app grants —
--       no new GRANT is required for an ADD COLUMN.
--
-- ORDER within this file:
--   (1) ADD COLUMN reservation.cancellation_reason (nullable)
--   (2) ADD CHECK constraint (length <= 500)
-- ============================================================


-- ── (1) ADD COLUMN ────────────────────────────────────────────────────────────
-- Nullable: a reservation that was never cancelled, or cancelled without a
-- stated reason, keeps this NULL.

ALTER TABLE "reservation" ADD COLUMN "cancellation_reason" text;


-- ── (2) CHECK: sane length bound ──────────────────────────────────────────────
-- NULL is allowed (no reason). A non-null value is free text capped at 500
-- characters. Application code trims + validates before persisting.

ALTER TABLE "reservation" ADD CONSTRAINT "reservation_cancellation_reason_check" CHECK (
  "cancellation_reason" IS NULL OR char_length("cancellation_reason") <= 500
);
