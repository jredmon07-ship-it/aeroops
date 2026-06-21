-- ============================================================
-- AeroOps — Down migration for 0018_dispatch_ticket_correction.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes
-- all dispatch ticket correction records and the table itself.
--
-- Reverses (in order):
--   (5) REVOKE SELECT, INSERT on dispatch_ticket_correction FROM aeroops_app
--   (4) DROP RLS policies (dispatch_ticket_correction_select + _insert)
--   (3) DISABLE + un-FORCE RLS
--   (2) DROP INDEX correction_org_ticket_created_idx
--   (1) DROP TABLE dispatch_ticket_correction
--       (CASCADE drops the UNIQUE index + all constraints)
-- ============================================================


-- ── (5) Revoke grants ─────────────────────────────────────────────────────────

REVOKE SELECT, INSERT ON "dispatch_ticket_correction" FROM aeroops_app;


-- ── (4) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "dispatch_ticket_correction_insert" ON "dispatch_ticket_correction";
DROP POLICY IF EXISTS "dispatch_ticket_correction_select" ON "dispatch_ticket_correction";


-- ── (3) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "dispatch_ticket_correction" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "dispatch_ticket_correction" DISABLE ROW LEVEL SECURITY;


-- ── (2) Drop index ────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "correction_org_ticket_created_idx";


-- ── (1) Drop table ────────────────────────────────────────────────────────────
-- CASCADE removes all dependent constraints (the UNIQUE index and any
-- composite FK referencing this table in future migrations).

DROP TABLE IF EXISTS "dispatch_ticket_correction";
