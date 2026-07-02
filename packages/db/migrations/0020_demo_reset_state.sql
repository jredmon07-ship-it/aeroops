-- ============================================================
-- AeroOps — Demo reset-on-open bookkeeping
-- Migration: 0020_demo_reset_state.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0019_billing_records.sql
--               must already be applied.
--
-- Implements the throttle bookkeeping for the public-demo
-- "reset-on-open" feature (packages/api/src/demo/reset.ts):
-- one row per demo slug records when the tenant was last wiped
-- and re-seeded, so the reset logic can enforce a minimum
-- interval between resets (default 60s) and — together with a
-- pg_try_advisory_xact_lock — guarantee at most one reset runs
-- at a time.
--
-- Key guarantees:
--   (1) This is DEMO INFRASTRUCTURE, not a tenant table:
--       it has NO org_id, is NOT enrolled in RLS, and is
--       written ONLY by the privileged demo-owner connection
--       (AEROOPS_DEMO_OWNER_URL). The runtime aeroops_app role
--       is NEVER granted access (explicit REVOKE below is
--       belt-and-suspenders — a freshly created table already
--       grants nothing to other roles).
--   (2) slug is the primary key: exactly one bookkeeping row
--       per demo tenant.
--   (3) No money, no PII, no FAA/airworthiness data.
-- ============================================================

CREATE TABLE IF NOT EXISTS "demo_reset_state" (
  "slug"          text        PRIMARY KEY,
  "last_reset_at" timestamptz NOT NULL DEFAULT now()
);

-- DEMO INFRASTRUCTURE — owner-only. The tenant application role must never
-- see or touch this table. (A new table grants nothing to aeroops_app by
-- default; this REVOKE makes the intent explicit and survives any future
-- blanket GRANT.)
REVOKE ALL ON "demo_reset_state" FROM aeroops_app;
