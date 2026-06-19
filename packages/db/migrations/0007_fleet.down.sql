-- ============================================================
-- AeroOps — Phase 1 Slice 5.1 ROLLBACK PLAN
-- Migration: 0007_fleet.down.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0007_fleet.sql in strict dependency order.
--
-- Dependency order (reverse of forward migration):
--   1. Drop composite FK resource_home_base_org_fk (references location —
--      must be dropped before the location candidate key is dropped in step 4).
--   2. Drop year sanity CHECK resource_year_sane_check.
--   3. Drop the seven ADD COLUMNs from resource (in reverse order).
--   4. Drop composite candidate key location_id_org_id_unique from location.
-- ============================================================


-- ── (1) Drop composite FK from resource → location ───────────────────────────
-- Must precede step (4): the FK references location_id_org_id_unique; dropping
-- the FK first allows the location unique constraint to be safely removed.

ALTER TABLE "resource"
  DROP CONSTRAINT IF EXISTS "resource_home_base_org_fk";


-- ── (2) Drop year sanity check ────────────────────────────────────────────────

ALTER TABLE "resource"
  DROP CONSTRAINT IF EXISTS "resource_year_sane_check";


-- ── (3) Drop the seven Slice 5 columns from resource (reverse order) ──────────

ALTER TABLE "resource" DROP COLUMN IF EXISTS "has_tach";
ALTER TABLE "resource" DROP COLUMN IF EXISTS "has_hobbs";
ALTER TABLE "resource" DROP COLUMN IF EXISTS "home_base_location_id";
ALTER TABLE "resource" DROP COLUMN IF EXISTS "serial_number";
ALTER TABLE "resource" DROP COLUMN IF EXISTS "year";
ALTER TABLE "resource" DROP COLUMN IF EXISTS "model";
ALTER TABLE "resource" DROP COLUMN IF EXISTS "make";


-- ── (4) Drop composite candidate key from location ────────────────────────────
-- Safe now that resource_home_base_org_fk (which referenced it) was removed
-- in step (1).

ALTER TABLE "location"
  DROP CONSTRAINT IF EXISTS "location_id_org_id_unique";
