-- ============================================================
-- AeroOps — Down migration for 0026_notifications.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes all
-- notification-log + notification-pref records and the two tables.
--
-- Reverses (in order — reverse of up):
--   (6) REVOKE grants
--   (5) DROP RLS policies
--   (4) DISABLE + un-FORCE RLS
--   (3) DROP indexes
--   (2) DROP TABLE notification_pref
--   (1) DROP TABLE notification_log
-- ============================================================


-- ── (6) Revoke grants ──────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "notification_pref" FROM aeroops_app;
REVOKE SELECT, INSERT ON "notification_log" FROM aeroops_app;


-- ── (5) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "notification_pref_delete" ON "notification_pref";
DROP POLICY IF EXISTS "notification_pref_update" ON "notification_pref";
DROP POLICY IF EXISTS "notification_pref_insert" ON "notification_pref";
DROP POLICY IF EXISTS "notification_pref_select" ON "notification_pref";

DROP POLICY IF EXISTS "notification_log_insert" ON "notification_log";
DROP POLICY IF EXISTS "notification_log_select" ON "notification_log";


-- ── (4) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "notification_pref" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "notification_pref" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "notification_log"  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "notification_log"  DISABLE ROW LEVEL SECURITY;


-- ── (3) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "notification_log_org_user_idx";
DROP INDEX IF EXISTS "notification_log_org_created_idx";


-- ── (2) DROP TABLE notification_pref ────────────────────────────────────────

DROP TABLE IF EXISTS "notification_pref";


-- ── (1) DROP TABLE notification_log ─────────────────────────────────────────

DROP TABLE IF EXISTS "notification_log";
