-- ============================================================
-- AeroOps — Slice P1.5: Maintenance-due reminders
-- Migration: 0029_maintenance_due.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0028_calendar_feed.sql
--               must already be applied.
--
-- COMPLIANCE (HARD LINE — matches migration 0006 squawks/grounding and
-- 0013 work_orders precedent, verbatim posture): maintenance_item stores
-- OPERATOR-ENTERED maintenance-tracking thresholds ONLY. This table (and
-- the pure arithmetic in @aeroops/core's evaluateMaintenanceDue that
-- compares a threshold to a recorded meter/date) computes NO FAA/Part-43/
-- 91.409 airworthiness or inspection-due DETERMINATION of any kind. A
-- mechanic/IA still makes the airworthiness call — this is a reminder that
-- the operator set a threshold and is approaching or has passed it, nothing
-- more. [VERIFY-P1.5-A]
--
-- Implements P1.5: operator-defined per-aircraft maintenance-due items that
-- come due either by an HOURS threshold (against the aircraft's
-- last-recorded Hobbs or tach meter — the operator picks the basis; the
-- meter itself is read DISPLAY-ONLY from the existing dispatch_ticket
-- history, never recomputed or written by this slice) or by a DATE.
--
--   maintenance_item — one row per tracked maintenance item on an aircraft.
--     Standard 4-policy mutable RLS (mirrors rate_schedule / dues_schedule):
--     title/due_value_hours/due_date/warn_*/notes/active are mutable via the
--     command layer (updateMaintenanceItem / markMaintenanceItemServiced /
--     deactivateMaintenanceItem); resource_id/track_by/meter_basis/created_by
--     are write-once by convention (never mutated by any command).
--
-- Key guarantees:
--   (1) maintenance_item is tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS
--       + 4 fail-closed policies (byte-identical NULLIF predicate) + grants
--       to aeroops_app, mirroring the byte-pattern of 0006/0013/0019 exactly.
--   (2) Composite FKs (hand-written; Drizzle cannot express multi-column FKs):
--         (org_id) → org(id) ON DELETE CASCADE.
--         (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT —
--           aircraft must exist in the same org; hard-delete blocked while
--           maintenance items exist (records integrity, mirrors squawk/work_order).
--         (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT —
--           creator must be a member of the same org.
--   (3) maintenance_item_shape_check is THE structural guarantee that
--       track_by/meter_basis/due_value_hours/due_date can never be
--       inconsistent (mirrors squawk_resolved_shape_check /
--       work_order_completed_shape_check):
--         track_by='hours' ⇒ meter_basis NOT NULL AND due_value_hours NOT NULL
--                             AND due_date IS NULL
--         track_by='date'  ⇒ meter_basis IS NULL AND due_value_hours IS NULL
--                             AND due_date NOT NULL
--   (4) TEXT + CHECK for track_by/meter_basis (NOT pgEnum) — mirrors
--       rate_schedule.rate_kind's additive/reversible-value-domain posture
--       (migration 0019 §rate_kind).
--   (5) UNIQUE (id, org_id) composite candidate key — consistent with all
--       other tenant tables; forward-compat for any future composite FK.
--   (6) STRICTLY ADDITIVE — no existing tables/columns/constraints modified.
--       Only the one new table is created.
--   (7) NO completion-history table in this slice (documented deviation —
--       see maintenance-item.ts header for the full rationale): "mark
--       serviced" advances due_value_hours/due_date on this row via a
--       guarded UPDATE + writes ONE audit_log row. Revisit if a dedicated
--       completion-history UI/report is ever needed.
--   (8) NO money column anywhere in this migration.
--
-- ORDER within this file:
--   (1) CREATE TABLE maintenance_item (FKs + CHECKs + UNIQUE)
--   (2) Index
--   (3) ENABLE + FORCE RLS
--   (4) RLS policies (standard 4-policy pattern)
--   (5) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE maintenance_item ────────────────────────────────────────────────

CREATE TABLE "maintenance_item" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"               uuid NOT NULL,
  "resource_id"          uuid NOT NULL,
  "title"                text NOT NULL,
  "track_by"             text NOT NULL,
  "meter_basis"          text,
  "due_value_hours"      numeric(10, 1),
  "due_date"             date,
  "warn_threshold_hours" numeric(10, 1),
  "warn_lead_days"       integer,
  "notes"                text,
  "active"               boolean NOT NULL DEFAULT true,
  "created_by"           uuid NOT NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "maintenance_item_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: item must reference an aircraft (or other resource) in the
  -- same org. ON DELETE RESTRICT: prevents hard-deleting a resource that has
  -- maintenance items (records integrity — mirrors squawk_resource_org_fk /
  -- work_order_resource_org_fk).
  -- Requires resource(id, org_id) UNIQUE "resource_id_org_id_unique"
  -- established in migration 0002.
  CONSTRAINT "maintenance_item_resource_org_fk"
    FOREIGN KEY ("resource_id", "org_id")
    REFERENCES "resource"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: creator must be a member of the same org.
  -- ON DELETE RESTRICT: preserves creation attribution.
  -- Requires app_user(id, org_id) UNIQUE "app_user_id_org_id_unique"
  -- established in migration 0000.
  CONSTRAINT "maintenance_item_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "maintenance_item_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Title must not be empty (or blank-only).
  CONSTRAINT "maintenance_item_title_nonempty_check" CHECK (
    char_length(btrim("title")) > 0
  ),

  -- track_by value domain.
  CONSTRAINT "maintenance_item_track_by_check" CHECK (
    "track_by" IN ('hours', 'date')
  ),

  -- meter_basis value domain (nullable — see shape check below for when it
  -- must/must not be present).
  CONSTRAINT "maintenance_item_meter_basis_check" CHECK (
    "meter_basis" IS NULL OR "meter_basis" IN ('hobbs', 'tach')
  ),

  -- THE STRUCTURAL GUARANTEE: track_by/meter_basis/due_value_hours/due_date
  -- can never be inconsistent. Mirrors squawk_resolved_shape_check /
  -- work_order_completed_shape_check.
  CONSTRAINT "maintenance_item_shape_check" CHECK (
    (
      "track_by" = 'hours'
      AND "meter_basis" IS NOT NULL
      AND "due_value_hours" IS NOT NULL
      AND "due_date" IS NULL
    )
    OR
    (
      "track_by" = 'date'
      AND "meter_basis" IS NULL
      AND "due_value_hours" IS NULL
      AND "due_date" IS NOT NULL
    )
  ),

  -- Non-negativity — an hours threshold, warn threshold, or lead-day count
  -- can never be negative.
  CONSTRAINT "maintenance_item_due_value_nonneg_check" CHECK (
    "due_value_hours" IS NULL OR "due_value_hours" >= 0
  ),
  CONSTRAINT "maintenance_item_warn_threshold_nonneg_check" CHECK (
    "warn_threshold_hours" IS NULL OR "warn_threshold_hours" >= 0
  ),
  CONSTRAINT "maintenance_item_warn_lead_days_nonneg_check" CHECK (
    "warn_lead_days" IS NULL OR "warn_lead_days" >= 0
  )
);


-- ── (2) Index ────────────────────────────────────────────────────────────────

-- Covers: per-aircraft + org-wide active-item list queries (listMaintenanceDue).
-- e.g. WHERE org_id=$1 [AND resource_id=$2] AND active=true
CREATE INDEX "maintenance_item_org_resource_active_idx"
  ON "maintenance_item" ("org_id", "resource_id", "active");


-- ── (3) ENABLE + FORCE RLS ───────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "maintenance_item" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "maintenance_item" FORCE   ROW LEVEL SECURITY;


-- ── (4) RLS policies (standard 4-policy pattern) ────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)

CREATE POLICY "maintenance_item_select"
  ON "maintenance_item"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "maintenance_item_insert"
  ON "maintenance_item"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "maintenance_item_update"
  ON "maintenance_item"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "maintenance_item_delete"
  ON "maintenance_item"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (5) GRANT to aeroops_app ─────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "maintenance_item" TO aeroops_app;
