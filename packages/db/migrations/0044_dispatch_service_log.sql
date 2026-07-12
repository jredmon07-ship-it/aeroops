-- ============================================================
-- AeroOps — Line-ops service log at check-in (oil / fuel uplift)
-- Migration: 0044_dispatch_service_log.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0043_import_source_myfbo.sql must
--               already be applied.
--
-- CONTEXT: Flight-Schedule-Pro-parity "Aircraft report" surfaces per-tail
-- Oil Added / Fuel Added columns. This table captures the operator line-ops
-- data those columns aggregate: the oil (quarts) and fuel (gallons) added to
-- an aircraft, recorded as an OPTIONAL follow-up step after a dispatch ticket
-- is checked in (CLOSED).
--
--   dispatch_service_log — APPEND-ONLY record of a line-ops service event
--     attached to a CLOSED dispatch ticket (mirrors dispatch_ticket_correction
--     / audit_log: SELECT + INSERT RLS policies ONLY). The FROZEN close path
--     (closeDispatch) is NEVER touched — this row is written by a separate,
--     best-effort follow-up command. The latest row per ticket (by created_at
--     DESC) is the EFFECTIVE service reading a report consumes (a re-entry is a
--     NEW row, exactly like a meter correction).
--
-- This is OPERATOR LINE-OPS data (fuel/oil uplift) — NOT a maintenance record,
-- NOT a Part-43/airworthiness determination, NOT a billing instrument.
--
-- Key guarantees:
--   (1) Tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS + the standard
--       current_org_id GUC predicate.
--   (2) APPEND-ONLY: GRANT is SELECT+INSERT only; REVOKE UPDATE, DELETE is an
--       explicit belt-and-suspenders backstop (mirrors dispatch_ticket_correction
--       in migration 0018) — a service log row, once written, is immutable.
--   (3) Composite FK (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
--       ON DELETE RESTRICT (column-list syntax) — the service event must
--       reference a ticket in the SAME org, and a ticket with service rows
--       cannot be hard-deleted (records integrity). Targets
--       dispatch_ticket_id_org_id_unique (migration 0005).
--   (4) Composite FK (created_by, org_id) → app_user(id, org_id)
--       ON DELETE RESTRICT — the recorder must be a member of the same org and
--       authoring identity persists. Targets app_user_id_org_id_unique (0000).
--   (5) CHECKs: oil non-negative and <= 99; fuel non-negative and <= 999;
--       note length <= 500; at least one of oil / fuel / note non-null (a
--       no-op service log is rejected).
--   (6) UNIQUE (id, org_id) composite candidate key — consistent with all
--       other tenant tables; forward-compat for future composite FKs.
--   (7) STRICTLY ADDITIVE — no existing table/column/constraint is touched.
--       The FROZEN dispatch close path and every other engine are untouched.
--       NO money column; no Stripe, no card/bank data.
--
-- Effective service derivation (application layer, get-aircraft-report.ts):
--   effective service for a ticket = latest dispatch_service_log for it
--   (ORDER BY created_at DESC LIMIT 1), or none. A per-tail report SUMs the
--   effective oil / fuel over the closed tickets in the range.
--
-- ORDER within this file:
--   (1) CREATE TABLE dispatch_service_log (FKs + CHECKs + UNIQUE)
--   (2) CREATE INDEX service_log_org_ticket_created_idx
--   (3) ENABLE + FORCE RLS
--   (4) RLS policies (SELECT + INSERT only — append-only)
--   (5) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE dispatch_service_log ────────────────────────────────────────────

CREATE TABLE "dispatch_service_log" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"               uuid NOT NULL,
  "dispatch_ticket_id"   uuid NOT NULL,
  "oil_added_quarts"     numeric(4,1),
  "fuel_added_gallons"   numeric(5,1),
  "note"                 text,
  "created_by"           uuid NOT NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "dispatch_service_log_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the service event must reference a ticket in the same org.
  -- ON DELETE RESTRICT: prevents hard-deleting a ticket with service rows.
  -- Targets dispatch_ticket_id_org_id_unique established in migration 0005.
  CONSTRAINT "dispatch_service_log_ticket_org_fk"
    FOREIGN KEY ("dispatch_ticket_id", "org_id")
    REFERENCES "dispatch_ticket"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: the recorder must be a user in the same org.
  -- ON DELETE RESTRICT: recorder identity must persist with the immutable row.
  -- Targets app_user_id_org_id_unique established in migration 0000.
  CONSTRAINT "dispatch_service_log_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all tenant tables.
  CONSTRAINT "dispatch_service_log_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Oil uplift: non-negative, sanely bounded (numeric(4,1) holds up to 999.9;
  -- a single service adds at most a few quarts — cap at 99).
  CONSTRAINT "service_log_oil_bounds_check" CHECK (
    "oil_added_quarts" IS NULL OR ("oil_added_quarts" >= 0 AND "oil_added_quarts" <= 99)
  ),

  -- Fuel uplift: non-negative, sanely bounded (numeric(5,1) holds up to 9999.9;
  -- cap at 999 gallons for a single uplift).
  CONSTRAINT "service_log_fuel_bounds_check" CHECK (
    "fuel_added_gallons" IS NULL OR ("fuel_added_gallons" >= 0 AND "fuel_added_gallons" <= 999)
  ),

  -- Free-text note, length-capped.
  CONSTRAINT "service_log_note_length_check" CHECK (
    "note" IS NULL OR char_length("note") <= 500
  ),

  -- At least one of oil / fuel / note must be present — a no-op service log
  -- (all three null) is rejected.
  CONSTRAINT "service_log_at_least_one_check" CHECK (
    "oil_added_quarts" IS NOT NULL
    OR "fuel_added_gallons" IS NOT NULL
    OR "note" IS NOT NULL
  )
);


-- ── (2) Index ─────────────────────────────────────────────────────────────────
-- Covers: "latest service per ticket" — the effective-service query for the
-- Aircraft report.
--   e.g. SELECT * FROM dispatch_service_log
--          WHERE org_id = $1 AND dispatch_ticket_id = $2
--          ORDER BY created_at DESC LIMIT 1

CREATE INDEX "service_log_org_ticket_created_idx"
  ON "dispatch_service_log" ("org_id", "dispatch_ticket_id", "created_at" DESC);


-- ── (3) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "dispatch_service_log" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "dispatch_service_log" FORCE   ROW LEVEL SECURITY;


-- ── (4) RLS policies — APPEND-ONLY (SELECT + INSERT only) ─────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)
--
-- Mirrors dispatch_ticket_correction / audit_log exactly: no UPDATE or DELETE
-- policy. With FORCE ROW LEVEL SECURITY, the absence of a permissive policy
-- blocks those operations for ALL roles including the table owner — the
-- structural guarantee that a service log row is immutable once inserted.

CREATE POLICY "dispatch_service_log_select"
  ON "dispatch_service_log"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dispatch_service_log_insert"
  ON "dispatch_service_log"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (5) GRANT to aeroops_app — SELECT + INSERT only ──────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed. GRANT is SELECT + INSERT only; the explicit REVOKE
-- UPDATE, DELETE is a belt-and-suspenders backstop (mirrors migration 0018).

GRANT SELECT, INSERT ON "dispatch_service_log" TO aeroops_app;
REVOKE UPDATE, DELETE ON "dispatch_service_log" FROM aeroops_app;
