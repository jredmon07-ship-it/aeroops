-- ============================================================
-- AeroOps — DOWN migration for 0050_dues_cadence.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Reverses 0050 in exact reverse order. NOTE: dropping the widened CHECK back
-- to 'monthly'-only will FAIL if any non-monthly schedule exists — delete or
-- convert those to 'monthly' first. anchor_month data is discarded.
-- ============================================================

ALTER TABLE "dues_schedule"
  DROP CONSTRAINT "dues_schedule_anchor_required_check";

ALTER TABLE "dues_schedule"
  DROP CONSTRAINT "dues_schedule_anchor_month_range_check";

ALTER TABLE "dues_schedule"
  DROP COLUMN "anchor_month";

ALTER TABLE "dues_schedule"
  DROP CONSTRAINT "dues_schedule_cadence_check";

ALTER TABLE "dues_schedule"
  ADD CONSTRAINT "dues_schedule_cadence_check" CHECK (
    "cadence" IN ('monthly')
  );
