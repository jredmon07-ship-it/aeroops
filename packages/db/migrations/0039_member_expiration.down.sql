-- ============================================================
-- AeroOps — Down migration for 0039_member_expiration.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes ALL
-- member_expiration records (every operator-entered expiration reminder,
-- for every org). It does NOT touch app_user, member_tag, audit_log, or any
-- other table.
--
-- Reverses (in order — reverse of up):
--   (5) REVOKE bookkeeping (no-op: dropping the table removes grants)
--   (4) DROP RLS policies
--   (3) DISABLE + un-FORCE RLS
--   (2) DROP indexes
--   (1) DROP TABLE member_expiration
-- ============================================================


-- ── (4) Drop RLS policies ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "member_expiration_update" ON "member_expiration";
DROP POLICY IF EXISTS "member_expiration_insert" ON "member_expiration";
DROP POLICY IF EXISTS "member_expiration_select" ON "member_expiration";


-- ── (3) Disable RLS ──────────────────────────────────────────────────────────

ALTER TABLE "member_expiration" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "member_expiration" DISABLE ROW LEVEL SECURITY;


-- ── (2) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "member_expiration_org_expires_idx";
DROP INDEX IF EXISTS "member_expiration_org_member_idx";


-- ── (1) DROP TABLE member_expiration ─────────────────────────────────────────

DROP TABLE IF EXISTS "member_expiration";
