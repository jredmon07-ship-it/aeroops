-- ============================================================
-- AeroOps — Down migration for 0035_study_grant.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes ALL
-- study_grant records (every school-granted AeroStudy entitlement, active
-- AND revoked history) and ALL study_progress records (every member's
-- knowledge-test readiness read model) for every org. After this runs,
-- school-linked AeroStudy clients lose their grants when their on-device
-- cache TTL expires, and any CFI-facing readiness view goes empty. It does
-- NOT touch any other table.
--
-- Reverses (in order — reverse of up):
--   (6) REVOKE bookkeeping (no-op: dropping the tables removes grants)
--   (5) DROP RLS policies (both tables)
--   (4) DISABLE + un-FORCE RLS (both tables)
--   (3) DROP indexes
--   (2) DROP TABLE study_progress
--   (1) DROP TABLE study_grant
-- ============================================================


-- ── (5) Drop RLS policies ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "study_progress_delete" ON "study_progress";
DROP POLICY IF EXISTS "study_progress_update" ON "study_progress";
DROP POLICY IF EXISTS "study_progress_insert" ON "study_progress";
DROP POLICY IF EXISTS "study_progress_select" ON "study_progress";

DROP POLICY IF EXISTS "study_grant_delete" ON "study_grant";
DROP POLICY IF EXISTS "study_grant_update" ON "study_grant";
DROP POLICY IF EXISTS "study_grant_insert" ON "study_grant";
DROP POLICY IF EXISTS "study_grant_select" ON "study_grant";


-- ── (4) Disable RLS ──────────────────────────────────────────────────────────

ALTER TABLE "study_progress" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "study_progress" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "study_grant" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "study_grant" DISABLE ROW LEVEL SECURITY;


-- ── (3) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "study_grant_org_user_idx";
DROP INDEX IF EXISTS "study_grant_org_user_scope_active_unique";


-- ── (2) DROP TABLE study_progress ────────────────────────────────────────────

DROP TABLE IF EXISTS "study_progress";


-- ── (1) DROP TABLE study_grant ───────────────────────────────────────────────

DROP TABLE IF EXISTS "study_grant";
