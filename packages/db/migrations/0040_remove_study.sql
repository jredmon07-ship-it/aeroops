-- ============================================================
-- AeroOps — 0040_remove_study.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
--
-- REMOVES the AeroStudy integration (maintainer decision 2026-07-11:
-- remove the study feature).
--
-- Drops study_grant + study_progress, introduced by migration 0035
-- (which IS applied in production — hence a forward drop migration,
-- not a rewrite of 0035). Content mirrors 0035's down file exactly.
-- All application code, schema definitions, mobile routes, and barrel
-- exports were removed in the same commit; nothing reads these tables.
--
-- Data loss note: permanently removes ALL study_grant records (active
-- and revoked history) and ALL study_progress records for every org.
-- The demo/prod tables are empty (feature never launched) — verified
-- zero rows expected at apply time.
-- ============================================================

-- ── (1) Drop RLS policies ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "study_progress_delete" ON "study_progress";
DROP POLICY IF EXISTS "study_progress_update" ON "study_progress";
DROP POLICY IF EXISTS "study_progress_insert" ON "study_progress";
DROP POLICY IF EXISTS "study_progress_select" ON "study_progress";

DROP POLICY IF EXISTS "study_grant_delete" ON "study_grant";
DROP POLICY IF EXISTS "study_grant_update" ON "study_grant";
DROP POLICY IF EXISTS "study_grant_insert" ON "study_grant";
DROP POLICY IF EXISTS "study_grant_select" ON "study_grant";

-- ── (2) Disable RLS ──────────────────────────────────────────────────────────

ALTER TABLE "study_progress" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "study_progress" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "study_grant" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "study_grant" DISABLE ROW LEVEL SECURITY;

-- ── (3) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "study_grant_org_user_idx";
DROP INDEX IF EXISTS "study_grant_org_user_scope_active_unique";

-- ── (4) Drop tables ──────────────────────────────────────────────────────────

DROP TABLE IF EXISTS "study_progress";
DROP TABLE IF EXISTS "study_grant";
