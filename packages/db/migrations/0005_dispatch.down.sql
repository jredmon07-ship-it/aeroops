-- ============================================================
-- AeroOps — Phase 1 Slice 3a ROLLBACK PLAN
-- Migration: 0005_dispatch.down.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0005_dispatch.sql in strict dependency order.
--
-- Dependency order:
--   1. Drop all RLS policies on dispatch_ticket.
--   2. Disable + un-force RLS on dispatch_ticket.
--   3. Revoke grants from aeroops_app (guarded by pg_roles check).
--   4. Drop indexes on dispatch_ticket (auto-dropped with table; listed for
--      clarity and in case manual cleanup is needed before table drop).
--   5. Drop table dispatch_ticket (cascade drops its constraints, indexes,
--      and the UNIQUE (id, org_id) candidate key).
--   6. Drop enum type dispatch_status.
-- ============================================================


-- ── (1) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "dispatch_ticket_delete" ON "dispatch_ticket";
DROP POLICY IF EXISTS "dispatch_ticket_update" ON "dispatch_ticket";
DROP POLICY IF EXISTS "dispatch_ticket_insert" ON "dispatch_ticket";
DROP POLICY IF EXISTS "dispatch_ticket_select" ON "dispatch_ticket";


-- ── (2) Disable + un-force RLS on dispatch_ticket ────────────────────────────

ALTER TABLE IF EXISTS "dispatch_ticket" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "dispatch_ticket" DISABLE ROW LEVEL SECURITY;


-- ── (3) Revoke grants from aeroops_app ───────────────────────────────────────
-- Guarded by pg_roles check so this does not fail in envs where the role
-- does not yet exist (mirrors 0002.down / 0003.down / 0004.down pattern).

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aeroops_app') THEN
    REVOKE ALL PRIVILEGES ON "dispatch_ticket" FROM aeroops_app;
  END IF;
END
$$;


-- ── (4) Drop indexes (auto-removed with table — listed for clarity) ───────────

DROP INDEX IF EXISTS "dispatch_ticket_one_open_per_resource";
DROP INDEX IF EXISTS "dispatch_ticket_org_resource_idx";
DROP INDEX IF EXISTS "dispatch_ticket_org_reservation_idx";


-- ── (5) Drop table dispatch_ticket ───────────────────────────────────────────
-- Dropping the table automatically removes all its constraints, indexes, and
-- the UNIQUE (id, org_id) composite candidate key.

DROP TABLE IF EXISTS "dispatch_ticket";


-- ── (6) Drop enum type ────────────────────────────────────────────────────────

DROP TYPE IF EXISTS "public"."dispatch_status";
