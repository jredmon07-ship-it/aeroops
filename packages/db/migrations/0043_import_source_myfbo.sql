-- ============================================================
-- AeroOps — Widen import_batch source for the myFBO importer
-- Migration: 0043_import_source_myfbo.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0042_cancellation_reason.sql must
--               already be applied.
--
-- CONTEXT: migration 0027 created import_batch with
--   CONSTRAINT "import_batch_source_check" CHECK ("source" IN ('flight_circle'))
-- and a comment: "Forward seam for other providers — widen when a second
-- source ships." myFBO (myfbo.com) retires in August 2026 and its operators
-- are choosing replacements now, so the importer now offers a source selector
-- — Flight Circle | myFBO | Other CSV. This widens the CHECK to accept the two
-- new source labels so previewImport can persist them for import-history
-- attribution. The label is purely descriptive: the parse/map/normalize/commit
-- write paths are IDENTICAL across sources (per-tool header differences are
-- handled by the operator-confirmed column-mapping step, not by `source`).
--
-- Key guarantees:
--   (1) STRICTLY ADDITIVE — the ONLY change is swapping one CHECK constraint
--       for a wider one on the SAME column. No column is added/dropped, no
--       existing row is touched (every existing row's source='flight_circle'
--       satisfies the wider set), no policy/grant/index is touched.
--   (2) DEFAULT is unchanged ('flight_circle'), so any writer that omits
--       `source` behaves byte-identically to today.
--   (3) RLS unchanged: import_batch keeps its migration-0027 ENABLE+FORCE RLS
--       and the standard org-scoped policies; a constraint swap needs no GRANT.
--
-- ORDER within this file:
--   (1) DROP the old single-value CHECK
--   (2) ADD the widened CHECK ('flight_circle','myfbo','other')
-- ============================================================


-- ── (1) DROP the old CHECK ────────────────────────────────────────────────────
ALTER TABLE "import_batch" DROP CONSTRAINT IF EXISTS "import_batch_source_check";


-- ── (2) ADD the widened CHECK ─────────────────────────────────────────────────
-- 'flight_circle' — the original Flight Circle importer.
-- 'myfbo'         — a myFBO CSV export (myfbo.com, retiring August 2026).
-- 'other'         — any other tool's CSV, mapped generically via the column-
--                   mapping step.
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_source_check" CHECK (
  "source" IN ('flight_circle', 'myfbo', 'other')
);
