-- ============================================================
-- AeroOps — Down migration for 0033_mobile_session.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes ALL
-- mobile_session records — every issued/rotated/revoked refresh-token
-- session for every org. This DESTROYS the ability to instantly revoke any
-- outstanding mobile refresh token going forward and reverts the mobile app
-- to needing a fresh login. It does NOT touch any other table.
--
-- Reverses (in order — reverse of up):
--   (5) REVOKE bookkeeping (no-op: dropping the table removes grants)
--   (4) DROP RLS policies
--   (3) DISABLE + un-FORCE RLS
--   (2) DROP indexes
--   (1) DROP TABLE mobile_session
-- ============================================================


-- ── (4) Drop RLS policies ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "mobile_session_delete" ON "mobile_session";
DROP POLICY IF EXISTS "mobile_session_update" ON "mobile_session";
DROP POLICY IF EXISTS "mobile_session_insert" ON "mobile_session";
DROP POLICY IF EXISTS "mobile_session_select" ON "mobile_session";


-- ── (3) Disable RLS ──────────────────────────────────────────────────────────

ALTER TABLE "mobile_session" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "mobile_session" DISABLE ROW LEVEL SECURITY;


-- ── (2) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "mobile_session_org_user_idx";


-- ── (1) DROP TABLE mobile_session ───────────────────────────────────────────

DROP TABLE IF EXISTS "mobile_session";
