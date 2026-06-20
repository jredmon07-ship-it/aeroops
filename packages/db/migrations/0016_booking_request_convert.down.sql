-- ============================================================
-- AeroOps — Slice PB2.1a DOWN: reverse migration 0016_booking_request_convert.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0016_booking_request_convert.sql in strict reverse order.
--   (1) DROP the composite FK constraint (before dropping the column).
--   (2) DROP the column.
--
-- STRICTLY ADDITIVE REVERSE: no other tables, constraints, indexes, RLS
-- policies, or GRANTs are modified. Only the booking_request ALTER is undone.
-- ============================================================


-- ── (1) Drop the composite FK constraint ─────────────────────────────────────

ALTER TABLE "booking_request"
  DROP CONSTRAINT IF EXISTS "booking_request_converted_reservation_org_fk";


-- ── (2) Drop the column ───────────────────────────────────────────────────────

ALTER TABLE "booking_request"
  DROP COLUMN IF EXISTS "converted_reservation_id";
