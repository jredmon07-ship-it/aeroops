-- ============================================================
-- AeroOps — Slice 0.2 ROLLBACK PLAN
-- Migration: 0001_auth_credential.down.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0001_auth_credential.sql in strict
-- dependency order.
--
-- Dependency order:
--   1. Drop all RLS policies on auth_credential.
--   2. NO FORCE + DISABLE RLS on auth_credential.
--   3. REVOKE grants from aeroops_app.
--   4. Drop the index (auto-dropped with the table — listed for clarity).
--   5. DROP TABLE auth_credential.
--
-- Does NOT touch enums, roles, or extensions (none added in 0001).
-- ============================================================


-- ── (1) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "auth_credential_delete" ON "auth_credential";
DROP POLICY IF EXISTS "auth_credential_update" ON "auth_credential";
DROP POLICY IF EXISTS "auth_credential_insert" ON "auth_credential";
DROP POLICY IF EXISTS "auth_credential_select" ON "auth_credential";


-- ── (2) Disable + un-force RLS ───────────────────────────────────────────────

ALTER TABLE IF EXISTS "auth_credential" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "auth_credential" DISABLE ROW LEVEL SECURITY;


-- ── (3) Revoke grants from aeroops_app ──────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aeroops_app') THEN
    REVOKE ALL PRIVILEGES ON "auth_credential" FROM aeroops_app;
  END IF;
END
$$;


-- ── (4) Drop index (auto-removed with table — listed for clarity) ─────────────

DROP INDEX IF EXISTS "auth_credential_org_id_idx";


-- ── (5) Drop table ────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS "auth_credential";
