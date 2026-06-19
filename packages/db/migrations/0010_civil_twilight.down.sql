-- ============================================================
-- AeroOps — Slice 4a ROLLBACK PLAN
-- Migration: 0010_civil_twilight.down.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0010_civil_twilight.sql in strict reverse order.
-- Constraints must be dropped before the columns that back them are dropped.
--
-- [VERIFY-4a-A/D]: no FAA/regulatory data, no financial data to clean up.
--
-- Dependency order (reverse of forward migration):
--  (1) DROP CONSTRAINT dispatch_config_twilight_exempt_tag_nonempty_check
--  (2) DROP CONSTRAINT dispatch_config_twilight_mode_check
--  (3) DROP COLUMN     dispatch_config.twilight_exempt_tag
--  (4) DROP COLUMN     dispatch_config.twilight_mode
--  (5) DROP COLUMN     dispatch_config.twilight_constraint_enabled
--  (6) DROP CONSTRAINT civil_twilight_latlon_paired_check
--  (7) DROP CONSTRAINT civil_twilight_lon_range_check
--  (8) DROP CONSTRAINT civil_twilight_lat_range_check
--  (9) DROP COLUMN     location.longitude
-- (10) DROP COLUMN     location.latitude
-- ============================================================


-- ── (1) Drop twilight_exempt_tag nonempty check ───────────────────────────────

ALTER TABLE "dispatch_config"
  DROP CONSTRAINT IF EXISTS "dispatch_config_twilight_exempt_tag_nonempty_check";


-- ── (2) Drop twilight_mode domain check ───────────────────────────────────────

ALTER TABLE "dispatch_config"
  DROP CONSTRAINT IF EXISTS "dispatch_config_twilight_mode_check";


-- ── (3) Drop twilight_exempt_tag column ───────────────────────────────────────

ALTER TABLE "dispatch_config" DROP COLUMN IF EXISTS "twilight_exempt_tag";


-- ── (4) Drop twilight_mode column ─────────────────────────────────────────────

ALTER TABLE "dispatch_config" DROP COLUMN IF EXISTS "twilight_mode";


-- ── (5) Drop twilight_constraint_enabled column ───────────────────────────────

ALTER TABLE "dispatch_config" DROP COLUMN IF EXISTS "twilight_constraint_enabled";


-- ── (6) Drop paired-presence check ───────────────────────────────────────────

ALTER TABLE "location"
  DROP CONSTRAINT IF EXISTS "civil_twilight_latlon_paired_check";


-- ── (7) Drop longitude range check ───────────────────────────────────────────

ALTER TABLE "location"
  DROP CONSTRAINT IF EXISTS "civil_twilight_lon_range_check";


-- ── (8) Drop latitude range check ────────────────────────────────────────────

ALTER TABLE "location"
  DROP CONSTRAINT IF EXISTS "civil_twilight_lat_range_check";


-- ── (9) Drop longitude column ─────────────────────────────────────────────────

ALTER TABLE "location" DROP COLUMN IF EXISTS "longitude";


-- ── (10) Drop latitude column ─────────────────────────────────────────────────

ALTER TABLE "location" DROP COLUMN IF EXISTS "latitude";
