-- ============================================================
-- AeroOps — Down migration for 0042_cancellation_reason.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this removes the stated reason
-- from every cancelled reservation, for every org. It does NOT touch the
-- reservation status, cancelled_at/cancelled_by, audit_log, or any other
-- table.
--
-- Reverses (in order — reverse of up):
--   (2) DROP CHECK constraint
--   (1) DROP COLUMN reservation.cancellation_reason
-- ============================================================

ALTER TABLE "reservation" DROP CONSTRAINT IF EXISTS "reservation_cancellation_reason_check";

ALTER TABLE "reservation" DROP COLUMN IF EXISTS "cancellation_reason";
