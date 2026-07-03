-- ============================================================
-- AeroOps — Down migration for 0028_calendar_feed.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes all
-- calendar-feed subscription records and the table — every subscribed
-- calendar app's .ics URL for this org immediately starts 404ing.
--
-- Reverses (in order — reverse of up):
--   (5) REVOKE grants
--   (4) DROP RLS policies
--   (3) DISABLE + un-FORCE RLS
--   (2) DROP indexes
--   (1) DROP TABLE calendar_feed
-- ============================================================


-- ── (5) Revoke grants ──────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "calendar_feed" FROM aeroops_app;


-- ── (4) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "calendar_feed_delete" ON "calendar_feed";
DROP POLICY IF EXISTS "calendar_feed_update" ON "calendar_feed";
DROP POLICY IF EXISTS "calendar_feed_insert" ON "calendar_feed";
DROP POLICY IF EXISTS "calendar_feed_select" ON "calendar_feed";


-- ── (3) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "calendar_feed" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "calendar_feed" DISABLE ROW LEVEL SECURITY;


-- ── (2) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "calendar_feed_org_user_idx";


-- ── (1) DROP TABLE calendar_feed ────────────────────────────────────────────

DROP TABLE IF EXISTS "calendar_feed";
