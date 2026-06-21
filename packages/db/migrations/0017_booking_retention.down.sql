-- ============================================================
-- AeroOps — Down migration for 0017_booking_retention.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this removes the
-- booking-request retention config columns from dispatch_config.
--
-- Reverses:
--   (3) DROP CONSTRAINT dispatch_config_booking_retention_days_check
--   (2) DROP COLUMN booking_request_retention_includes_converted
--   (1) DROP COLUMN booking_request_retention_days
-- ============================================================

ALTER TABLE "dispatch_config"
  DROP CONSTRAINT IF EXISTS "dispatch_config_booking_retention_days_check";

ALTER TABLE "dispatch_config"
  DROP COLUMN IF EXISTS "booking_request_retention_includes_converted";

ALTER TABLE "dispatch_config"
  DROP COLUMN IF EXISTS "booking_request_retention_days";
