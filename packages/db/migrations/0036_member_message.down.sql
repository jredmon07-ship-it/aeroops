-- ============================================================
-- AeroOps — Down migration for 0036_member_message.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes ALL
-- member_message records (every announcement an operator has ever sent, for
-- every org). It does NOT touch notification_log (the per-recipient send
-- attempts survive) or any other table.
--
-- Reverses (in order — reverse of up):
--   (5) REVOKE bookkeeping (no-op: dropping the table removes grants)
--   (4) DROP RLS policies
--   (3) DISABLE + un-FORCE RLS
--   (2) DROP indexes
--   (1) DROP TABLE member_message
-- ============================================================


-- ── (4) Drop RLS policies ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "member_message_insert" ON "member_message";
DROP POLICY IF EXISTS "member_message_select" ON "member_message";


-- ── (3) Disable RLS ──────────────────────────────────────────────────────────

ALTER TABLE "member_message" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "member_message" DISABLE ROW LEVEL SECURITY;


-- ── (2) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "member_message_org_created_idx";


-- ── (1) DROP TABLE member_message ────────────────────────────────────────────

DROP TABLE IF EXISTS "member_message";
