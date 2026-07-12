-- ============================================================
-- AeroOps — Down migration for 0044_dispatch_service_log.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes ALL
-- dispatch service log records (every oil/fuel uplift ever recorded, for
-- every org) and the table itself.
--
-- Reverses (in order — reverse of up):
--   (5) REVOKE SELECT, INSERT on dispatch_service_log FROM aeroops_app
--   (4) DROP RLS policies (dispatch_service_log_select + _insert)
--   (3) DISABLE + un-FORCE RLS
--   (2) DROP INDEX service_log_org_ticket_created_idx
--   (1) DROP TABLE dispatch_service_log
--       (CASCADE drops the UNIQUE index + all constraints)
-- ============================================================


-- ── (5) Revoke grants ─────────────────────────────────────────────────────────

REVOKE SELECT, INSERT ON "dispatch_service_log" FROM aeroops_app;


-- ── (4) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "dispatch_service_log_insert" ON "dispatch_service_log";
DROP POLICY IF EXISTS "dispatch_service_log_select" ON "dispatch_service_log";


-- ── (3) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "dispatch_service_log" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "dispatch_service_log" DISABLE ROW LEVEL SECURITY;


-- ── (2) Drop index ────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "service_log_org_ticket_created_idx";


-- ── (1) Drop table ────────────────────────────────────────────────────────────
-- CASCADE removes all dependent constraints (the UNIQUE index and any
-- composite FK referencing this table in future migrations).

DROP TABLE IF EXISTS "dispatch_service_log";
