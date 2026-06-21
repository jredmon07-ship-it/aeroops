-- ============================================================
-- AeroOps — Slice B0: Dispatch ticket correction table
-- Migration: 0018_dispatch_ticket_correction.sql
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
--               + 0010_civil_twilight.sql + 0011_optimizer_run.sql
--               + 0012_training.sql + 0013_work_orders.sql
--               + 0014_availability.sql + 0015_booking_request.sql
--               + 0016_booking_request_convert.sql
--               + 0017_booking_retention.sql
--               must already be applied.
--
-- Implements Slice B0: append-only corrections to a CLOSED dispatch ticket's
-- write-once meter readings (ADR-0007 §1 + [[dispatch-correction-table-predecessor]]).
-- This table is the PREREQUISITE for Phase-2 billing consuming dispatch meters.
--
-- Key guarantees:
--   (1) dispatch_ticket_correction is tenant-scoped (org_id + ENABLE+FORCE RLS
--       + SELECT + INSERT policies ONLY — no UPDATE/DELETE policy; mirrors
--       audit_log's append-only posture exactly).
--   (2) GRANT is SELECT + INSERT only. REVOKE UPDATE, DELETE is applied as a
--       belt-and-suspenders backstop (mirrors the audit_log pattern from 0000).
--   (3) Composite FK (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
--       ON DELETE RESTRICT — prevents hard-deleting a ticket with corrections
--       (records integrity).
--   (4) Composite FK (created_by, org_id) → app_user(id, org_id)
--       ON DELETE RESTRICT — corrector must be a member of the same org.
--   (5) CHECKs: at-least-one-meter-not-null; meter non-negativity (matching
--       dispatch_ticket's numeric(10,1) + >= 0 discipline); reason non-empty.
--   (6) UNIQUE (id, org_id) composite candidate key — consistent with all
--       other tenant tables; forward-compat for future composite FKs.
--   (7) STRICTLY ADDITIVE — no existing tables, columns, or constraints
--       modified. Only the new table is created.
--   (8) NO money column. NO FAA/Part-43/airworthiness determination.
--       [VERIFY-B0-COMP-1]: dual-signature/audit-chain posture for meter
--       corrections before Phase-2 billing consumes effective meters.
--
-- Effective meter derivation (application layer):
--   effective_hobbs_in = latest correction.corrected_hobbs ?? ticket.hobbs_in
--   effective_tach_in  = latest correction.corrected_tach  ?? ticket.tach_in
--   "latest" = ORDER BY created_at DESC LIMIT 1 per dispatch_ticket_id.
--   The original close path is NEVER mutated.
--
-- ORDER:
--   (1) CREATE TABLE dispatch_ticket_correction (all FKs + CHECKs + UNIQUE)
--   (2) CREATE INDEX correction_org_ticket_created_idx
--   (3) ENABLE + FORCE RLS
--   (4) SELECT + INSERT RLS policies ONLY (no UPDATE, no DELETE)
--   (5) GRANT SELECT, INSERT; REVOKE UPDATE, DELETE
-- ============================================================


-- ── (1) Table dispatch_ticket_correction ─────────────────────────────────────
--
-- Append-only corrections to the FROZEN write-once closed meter (ADR-0007 §1).
-- The original close path (closeDispatch) is NEVER mutated.
-- Effective meter = latest correction (by created_at DESC) ?? original _in value.
--
-- NO updated_at column — rows are immutable once inserted (mirrors audit_log).
--
-- Composite FKs (all hand-written; Drizzle cannot express multi-col FKs):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine — deleting an org cascades to its corrections.
--
--   Composite FK (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
--     ON DELETE RESTRICT:
--     Prevents hard-deleting a dispatch ticket that has correction rows.
--     Targets dispatch_ticket_id_org_id_unique (migration 0005).
--
--   Composite FK (created_by, org_id) → app_user(id, org_id)
--     ON DELETE RESTRICT:
--     Corrector must be a member of the same org (cross-org guard).
--     Prevents deleting a user who has authored corrections (records
--     integrity — corrections are immutable and authoring identity must persist).
--     Targets app_user_id_org_id_unique (migration 0000).
--
-- CHECKs:
--   correction_at_least_one_meter_check:
--     corrected_hobbs IS NOT NULL OR corrected_tach IS NOT NULL
--     A no-op correction (neither meter adjusted) is rejected.
--
--   correction_hobbs_nonneg_check:
--     corrected_hobbs IS NULL OR corrected_hobbs >= 0
--     Mirrors dispatch_meters_nonneg_check; numeric(10,1) precision.
--
--   correction_tach_nonneg_check:
--     corrected_tach IS NULL OR corrected_tach >= 0
--     Mirrors dispatch_meters_nonneg_check; numeric(10,1) precision.
--
--   correction_reason_nonempty_check:
--     char_length(btrim(reason)) > 0
--     A correction without a stated reason is rejected.

CREATE TABLE "dispatch_ticket_correction" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"               uuid NOT NULL,
  "dispatch_ticket_id"   uuid NOT NULL,
  "corrected_hobbs"      numeric(10,1),
  "corrected_tach"       numeric(10,1),
  "reason"               text NOT NULL,
  "created_by"           uuid NOT NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "dispatch_ticket_correction_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: correction must reference a ticket in the same org.
  -- ON DELETE RESTRICT: prevents hard-deleting a ticket with correction records.
  -- Targets dispatch_ticket_id_org_id_unique established in migration 0005.
  CONSTRAINT "dispatch_ticket_correction_ticket_org_fk"
    FOREIGN KEY ("dispatch_ticket_id", "org_id")
    REFERENCES "dispatch_ticket"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: corrector must be a user in the same org.
  -- ON DELETE RESTRICT: corrector identity must persist with the immutable record.
  -- Targets app_user_id_org_id_unique established in migration 0000.
  CONSTRAINT "dispatch_ticket_correction_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all tenant tables;
  -- forward-compat for future composite FKs referencing this table.
  CONSTRAINT "dispatch_ticket_correction_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- At least one meter must be corrected. A no-op correction is invalid.
  CONSTRAINT "correction_at_least_one_meter_check" CHECK (
    "corrected_hobbs" IS NOT NULL OR "corrected_tach" IS NOT NULL
  ),

  -- Meter non-negativity — mirrors dispatch_meters_nonneg_check on dispatch_ticket.
  -- numeric(10,1): up to 9 digits before decimal, 1 after (e.g. 99999.9 hours).
  CONSTRAINT "correction_hobbs_nonneg_check" CHECK (
    "corrected_hobbs" IS NULL OR "corrected_hobbs" >= 0
  ),

  CONSTRAINT "correction_tach_nonneg_check" CHECK (
    "corrected_tach" IS NULL OR "corrected_tach" >= 0
  ),

  -- Reason must be non-empty (not null by NOT NULL above; not blank here).
  CONSTRAINT "correction_reason_nonempty_check" CHECK (
    char_length(btrim("reason")) > 0
  )
);


-- ── (2) Index ─────────────────────────────────────────────────────────────────
-- Covers: "latest correction per ticket" — the primary effective-meter query.
-- e.g. SELECT * FROM dispatch_ticket_correction
--        WHERE org_id = $1 AND dispatch_ticket_id = $2
--        ORDER BY created_at DESC LIMIT 1
-- Also covers: "all corrections for a ticket" (list for audit display).

CREATE INDEX "correction_org_ticket_created_idx"
  ON "dispatch_ticket_correction" ("org_id", "dispatch_ticket_id", "created_at" DESC);


-- ── (3) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "dispatch_ticket_correction" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "dispatch_ticket_correction" FORCE   ROW LEVEL SECURITY;


-- ── (4) RLS policies — APPEND-ONLY (SELECT + INSERT only) ─────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
--
-- APPEND-ONLY posture (mirrors audit_log exactly):
--   Only SELECT and INSERT policies are defined.
--   No UPDATE or DELETE policy is defined.
--   With FORCE ROW LEVEL SECURITY, the absence of a permissive policy for
--   UPDATE or DELETE means those operations are blocked for ALL roles —
--   including the table owner connecting as aeroops_app. This is the
--   records-integrity headline guarantee for immutable correction rows.

CREATE POLICY "dispatch_ticket_correction_select"
  ON "dispatch_ticket_correction"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dispatch_ticket_correction_insert"
  ON "dispatch_ticket_correction"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- No UPDATE or DELETE policies on dispatch_ticket_correction.
-- With FORCE ROW LEVEL SECURITY, the absence of a permissive policy
-- means those operations are blocked for ALL roles (including the table
-- owner). This is the structural guarantee that correction rows are
-- immutable once inserted. Mirrors audit_log's append-only posture.


-- ── (5) GRANT to aeroops_app — SELECT + INSERT only ──────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.
--
-- GRANT is SELECT + INSERT only (NOT UPDATE, NOT DELETE).
-- The absence of UPDATE/DELETE policies under FORCE RLS already blocks those
-- operations at the RLS layer. The explicit REVOKE is a belt-and-suspenders
-- backstop that ensures immutability does not rely solely on the
-- policy-absence mechanism (e.g. if a policy were accidentally added later).
-- Mirrors the audit_log REVOKE pattern from migration 0000.

GRANT SELECT, INSERT ON "dispatch_ticket_correction" TO aeroops_app;
REVOKE UPDATE, DELETE ON "dispatch_ticket_correction" FROM aeroops_app;
