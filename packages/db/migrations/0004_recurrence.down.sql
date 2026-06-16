-- ============================================================
-- AeroOps — Phase 1 Slice 2b ROLLBACK PLAN
-- Migration: 0004_recurrence.down.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0004_recurrence.sql in strict dependency order.
--
-- Dependency order:
--   1. Drop all RLS policies on reservation_series.
--   2. Disable + un-force RLS on reservation_series.
--   3. Revoke grants from aeroops_app (guarded by pg_roles check).
--   4. Drop reservation_series_id_idx on reservation.
--   5. Drop the composite FK + series_id column on reservation.
--   6. Drop table reservation_series (cascade drops its constraints/indexes).
--   7. Drop the 3 enum types.
--
-- NOTE: reservation rows that had series_id set will have that column
-- dropped. The occurrence reservation rows themselves are preserved —
-- only the series linkage column is removed.
-- ============================================================


-- ── (1) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "reservation_series_delete" ON "reservation_series";
DROP POLICY IF EXISTS "reservation_series_update" ON "reservation_series";
DROP POLICY IF EXISTS "reservation_series_insert" ON "reservation_series";
DROP POLICY IF EXISTS "reservation_series_select" ON "reservation_series";


-- ── (2) Disable + un-force RLS on reservation_series ─────────────────────────

ALTER TABLE IF EXISTS "reservation_series" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "reservation_series" DISABLE ROW LEVEL SECURITY;


-- ── (3) Revoke grants from aeroops_app ───────────────────────────────────────
-- Guarded by pg_roles check so this does not fail in envs where the role
-- does not yet exist (mirrors 0002.down + 0003.down pattern).

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aeroops_app') THEN
    REVOKE ALL PRIVILEGES ON "reservation_series" FROM aeroops_app;
  END IF;
END
$$;


-- ── (4) Drop index on reservation.series_id ──────────────────────────────────

DROP INDEX IF EXISTS "reservation_series_id_idx";


-- ── (5) Drop composite FK + series_id column on reservation ──────────────────
-- Drop the FK constraint first, then the column.

ALTER TABLE IF EXISTS "reservation"
  DROP CONSTRAINT IF EXISTS "reservation_series_id_org_fk";

ALTER TABLE IF EXISTS "reservation"
  DROP COLUMN IF EXISTS "series_id";


-- ── (6) Drop table reservation_series ────────────────────────────────────────
-- Dropping the table automatically removes all its constraints, indexes,
-- and the UNIQUE (id, org_id) candidate key referenced by the FK above
-- (which was already dropped in step 5).

DROP TABLE IF EXISTS "reservation_series";


-- ── (7) Drop enum types ────────────────────────────────────────────────────────
-- Drop in reverse creation order.

DROP TYPE IF EXISTS "public"."reservation_series_status";
DROP TYPE IF EXISTS "public"."recurrence_end_kind";
DROP TYPE IF EXISTS "public"."recurrence_freq";
