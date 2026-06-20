-- ============================================================
-- AeroOps — Slice PB1.1 DOWN: reverse migration 0015_booking_request.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Purpose: reverses 0015_booking_request.sql in strict reverse order.
-- Constraints must be dropped before the table; the table drop cascades
-- to indexes and constraints automatically.
--
-- [VERIFY-PB1-COMP-1]: contains PII lead data — confirm retention/purge
-- posture before running this down migration in production.
--
-- Dependency order (reverse of forward migration):
--  (1) REVOKE grant on booking_request
--  (2) DROP policies on booking_request
--  (3) DISABLE + NO FORCE RLS on booking_request
--  (4) DROP indexes on booking_request
--  (5) DROP TABLE booking_request
-- ============================================================


-- ── (1) Revoke grant ──────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "booking_request" FROM aeroops_app;


-- ── (2) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "booking_request_delete" ON "booking_request";
DROP POLICY IF EXISTS "booking_request_update" ON "booking_request";
DROP POLICY IF EXISTS "booking_request_insert" ON "booking_request";
DROP POLICY IF EXISTS "booking_request_select" ON "booking_request";


-- ── (3) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "booking_request" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "booking_request" DISABLE ROW LEVEL SECURITY;


-- ── (4) Drop indexes (table drop would cascade, but explicit for clarity) ─────

DROP INDEX IF EXISTS "booking_request_org_status_created_idx";
DROP INDEX IF EXISTS "booking_request_id_org_id_unique";


-- ── (5) Drop table (cascades to constraints) ──────────────────────────────────

DROP TABLE IF EXISTS "booking_request";
