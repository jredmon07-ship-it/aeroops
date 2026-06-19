-- ============================================================
-- AeroOps — Slice 4b: Optimizer run header (schedule_optimization_run)
-- Migration: 0011_optimizer_run.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql + 0001_auth_credential.sql
--               + 0002_scheduling.sql + 0003_booking_policies.sql
--               + 0004_recurrence.sql + 0005_dispatch.sql
--               + 0006_squawks_grounding.sql + 0007_fleet.sql
--               + 0008_people.sql + 0009_dispatch_gate.sql
--               + 0010_civil_twilight.sql
--               must already be applied.
--
-- Adds the Slice 4b (optimizer) data-model delta:
--   (1) schedule_optimization_run — audited run header for one auto-schedule run.
--       Each committed reservation's audit row gets metadata.optimizationRunId.
--
-- [VERIFY-4b-A] (HARD COMPLIANCE LINE): no regulatory determination in the
-- demand model. schedule_optimization_run stores scheduling time only; it
-- contains no price, invoice, payment, billing, or financial data whatsoever.
--
-- [VERIFY-4b-B]: every proposal routes through FROZEN gatedCreateOccurrence.
-- No bespoke INSERT path. This table records the run header only.
--
-- Key guarantees:
--   (1) schedule_optimization_run: 0..N rows per org (one per run).
--   (2) org FK (CASCADE): deleting an org cascades to its run records.
--   (3) Composite FK (requested_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT:
--       preserves attribution; prevents deleting the requesting user while their
--       run record exists. Targets app_user_id_org_id_unique from migration 0000.
--   (4) UNIQUE (id, org_id): composite candidate key for future composite FKs.
--   (5) schedule_optimization_run_counts_check: created_count >= 0 AND skipped_count >= 0.
--   (6) ENABLE + FORCE RLS + 4 fail-closed named policies + grant to aeroops_app.
--   (7) Index (org_id, created_at): covers "list recent runs" query.
--   (8) ADDITIVE ONLY — no existing tables or columns are modified.
--
-- Seed column type: bigint (int8, 64-bit signed).
-- The optimizer injects a JS-safe integer seed (0..Number.MAX_SAFE_INTEGER = 2^53-1).
-- bigint stores 64-bit values; values in the 53-bit JS-safe range round-trip with
-- no loss of precision. This makes determinism auditable without using a TEXT
-- column. NULL seed = unseeded run (forward seam, not yet used in 4b).
--
-- No money: this table schedules time only.
--
-- ORDER:
--   (1) CREATE TABLE schedule_optimization_run + 4 named constraints
--   (2) CREATE UNIQUE INDEX schedule_optimization_run_id_org_id_unique (id, org_id)
--   (3) CREATE INDEX schedule_optimization_run_org_created_idx (org_id, created_at)
--   (4) ENABLE + FORCE RLS on schedule_optimization_run
--   (5) 4 named RLS policies on schedule_optimization_run
--   (6) GRANT to aeroops_app
-- ============================================================


-- ── (1) CREATE TABLE schedule_optimization_run ───────────────────────────────
--
-- Audited optimizer run header. INSERT-ONCE; no updated_at column.
-- Per-proposal outcomes reconstructable from each created reservation's audit
-- row (metadata.optimizationRunId). NO money.
--
-- Composite FKs (hand-written; Drizzle cannot express multi-column FKs):
--
--   FK (org_id) → org(id) ON DELETE CASCADE  [schedule_optimization_run_org_id_fk]
--     Tenant spine — deleting an org cascades to its run records.
--
--   Composite FK (requested_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--     [schedule_optimization_run_requested_by_org_fk]
--     Preserves attribution: prevents deleting the requesting user while their
--     run record exists. Targets app_user_id_org_id_unique from migration 0000.
--
-- CHECKs:
--   schedule_optimization_run_counts_check:
--     created_count >= 0 AND skipped_count >= 0
--     Defensive non-negativity guard; API layer also validates.
--
-- UNIQUEs (hand-written indexes below):
--   schedule_optimization_run_id_org_id_unique UNIQUE (id, org_id)
--     Composite candidate key — forward-compat for future composite FKs.
--     Consistent with all other tenant tables.
--
-- seed: bigint (int8). JS-safe integer (0..2^53-1). NULL = unseeded run.

CREATE TABLE "schedule_optimization_run" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"         uuid NOT NULL,
  "requested_by"   uuid NOT NULL,
  "input_jsonb"    jsonb NOT NULL,
  "seed"           bigint,
  "created_count"  integer NOT NULL DEFAULT 0,
  "skipped_count"  integer NOT NULL DEFAULT 0,
  "created_at"     timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "schedule_optimization_run_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: requester must be a user in the same org.
  -- ON DELETE RESTRICT: preserves attribution.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "schedule_optimization_run_requested_by_org_fk"
    FOREIGN KEY ("requested_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Non-negativity guard on outcome counters.
  CONSTRAINT "schedule_optimization_run_counts_check" CHECK (
    "created_count" >= 0 AND "skipped_count" >= 0
  )
);


-- ── (2) UNIQUE (id, org_id) ───────────────────────────────────────────────────
-- Composite candidate key — forward-compat for future composite FKs.
-- Consistent with all other tenant tables (resource, reservation, dispatch_ticket, etc.).

CREATE UNIQUE INDEX "schedule_optimization_run_id_org_id_unique"
  ON "schedule_optimization_run" ("id", "org_id");


-- ── (3) Index (org_id, created_at) ───────────────────────────────────────────
-- Covers: list recent optimizer runs for an org —
-- WHERE org_id = $1 ORDER BY created_at DESC

CREATE INDEX "schedule_optimization_run_org_created_idx"
  ON "schedule_optimization_run" ("org_id", "created_at");


-- ── (4) ENABLE + FORCE RLS on schedule_optimization_run ──────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "schedule_optimization_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "schedule_optimization_run" FORCE  ROW LEVEL SECURITY;


-- ── (5) RLS policies on schedule_optimization_run ────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
--
-- Every policy is named explicitly for auditability.
-- 4 policies: SELECT, INSERT, UPDATE, DELETE.
-- INSERT-mostly in practice, but the standard 4-policy set is required.
-- No sanctioned UPDATE code path exists; UPDATE policy prevents unguarded mutation.

CREATE POLICY "schedule_optimization_run_select"
  ON "schedule_optimization_run"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "schedule_optimization_run_insert"
  ON "schedule_optimization_run"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "schedule_optimization_run_update"
  ON "schedule_optimization_run"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "schedule_optimization_run_delete"
  ON "schedule_optimization_run"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (6) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed. Standard full-DML grant (INSERT-mostly; UPDATE/DELETE
-- included to allow exceptional admin corrections without re-granting).

GRANT SELECT, INSERT, UPDATE, DELETE ON "schedule_optimization_run" TO aeroops_app;
