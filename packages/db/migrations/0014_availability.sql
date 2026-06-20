-- ============================================================
-- AeroOps — Slice AV1.1: Resource availability windows + dispatch_config flags
-- Migration: 0014_availability.sql
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
--               must already be applied.
--
-- Adds the Slice AV1.1 (Resource Availability Windows) data-model delta:
--   (1) ALTER dispatch_config ADD availability_constraint_enabled (bool, default false)
--   (2) ALTER dispatch_config ADD availability_mode (text, default 'warn')
--   (3) ALTER dispatch_config ADD CONSTRAINT availability_mode CHECK (block/warn)
--   (4) CREATE TABLE resource_availability_window + named composite FKs + 3 CHECKs
--   (5) CREATE UNIQUE INDEX resource_availability_window_id_org_id_unique
--   (6) CREATE UNIQUE INDEX resource_availability_window_natural_key_unique
--   (7) CREATE INDEX resource_availability_window_org_resource_idx
--   (8) ENABLE + FORCE RLS on resource_availability_window; 4 named policies; GRANT
--
-- HARD COMPLIANCE LINE [VERIFY-AV1-A]: availability windows represent OPERATOR
-- SCHEDULING / OPERATING-HOURS data ONLY. The system computes NO FAA duty-time,
-- rest-period, flight-time-limit, Part-117/135/121 determination whatsoever.
-- These are the times the operator has decided to make the resource available for
-- scheduling — not a regulatory determination of any kind.
-- UI copy MUST carry: "This is an operator scheduling rule based on your defined
-- operating hours. It is NOT an FAA duty-time, rest-period, Part-117/135/121,
-- or flight-time-limit determination."
--
-- [VERIFY-AV1-B]: no pilot duty/rest tracking here — windows are on the RESOURCE
-- (aircraft), not on a person.
--
-- [VERIFY-AV1-C]: day_of_week uses ISO 8601 (1=Monday, 7=Sunday). UI must
-- confirm this matches the operator's expectation (some FBOs use Sun=1).
--
-- [VERIFY-AV1-D]: start_minute/end_minute are in the resource's local IANA tz.
-- The API pre-resolves to UTC before passing to the core gate. DST transitions
-- (spring-forward gap: nonexistent open snaps FORWARD to gap-end; fall-back
-- ambiguous close snaps to EARLIER instant) are handled in @aeroops/core per
-- ADR-AV1 spec decisions 5+10.
--
-- Key guarantees:
--   (1) Both ALTER TABLE statements are NOT NULL with safe DEFAULT — existing
--       dispatch_config rows receive the defaults without UPDATE; existing INSERT
--       statements that omit the new columns succeed unchanged (additive).
--   (2) resource_availability_window: org_id NOT NULL, ENABLE+FORCE RLS, 4 fail-
--       closed named policies, aeroops_app GRANT (ADR-0001 byte-pattern).
--   (3) All composite FKs are hand-written (Drizzle cannot express multi-col FKs).
--   (4) ON DELETE RESTRICT on (resource_id,org_id) and (created_by,org_id) FKs:
--       hard-delete blocked while windows exist (operator must remove them first).
--   (5) No overnight wrap: end_minute > start_minute is enforced at DB level.
--   (6) NO money column anywhere. NO FAA regulatory data.
--   (7) STRICTLY ADDITIVE — no existing tables, columns, or constraints modified
--       except the two new columns on dispatch_config.
--   (8) dispatch_config already has ENABLE+FORCE RLS + 4 named policies (0009).
--       New columns inherit existing RLS predicates automatically.
--       No new RLS or grants needed on dispatch_config.
--
-- ORDER:
--   (1) ALTER TABLE dispatch_config ADD COLUMN availability_constraint_enabled
--   (2) ALTER TABLE dispatch_config ADD COLUMN availability_mode
--   (3) ALTER TABLE dispatch_config ADD CONSTRAINT dispatch_config_availability_mode_check
--   (4) CREATE TABLE resource_availability_window + named FKs + 3 CHECKs
--   (5) CREATE UNIQUE INDEX resource_availability_window_id_org_id_unique
--   (6) CREATE UNIQUE INDEX resource_availability_window_natural_key_unique
--   (7) CREATE INDEX resource_availability_window_org_resource_idx
--   (8) ENABLE + FORCE RLS; 4 named policies; GRANT
-- ============================================================


-- ── (1) Add availability_constraint_enabled to dispatch_config ────────────────
-- Operator opt-in flag. Default false → gate is INERT until deliberately enabled.
-- NOT NULL with DEFAULT false: existing rows receive false silently (no UPDATE needed).
-- dispatch_config already has ENABLE+FORCE RLS (migration 0009); new column
-- inherits the existing RLS predicates automatically. No new RLS or grant needed.

ALTER TABLE "dispatch_config"
  ADD COLUMN "availability_constraint_enabled" boolean NOT NULL DEFAULT false;


-- ── (2) Add availability_mode to dispatch_config ──────────────────────────────
-- 'warn' (default) | 'block'. CHECK in step (3).
-- Default 'warn' → if the operator enables the gate without choosing a mode,
-- the system warns rather than hard-blocks (fail-open for scheduling continuity).

ALTER TABLE "dispatch_config"
  ADD COLUMN "availability_mode" text NOT NULL DEFAULT 'warn';


-- ── (3) availability_mode domain check ───────────────────────────────────────
-- Only 'block' and 'warn' are valid mode values. Mirrors twilight_mode pattern
-- from migration 0010. Prevents unknown modes.

ALTER TABLE "dispatch_config"
  ADD CONSTRAINT "dispatch_config_availability_mode_check"
  CHECK ("availability_mode" IN ('block', 'warn'));


-- ── (4) CREATE TABLE resource_availability_window ────────────────────────────
--
-- Per-resource weekly operating-hours window. An operator defines N windows per
-- resource; the availability gate unions them for the candidate reservation's
-- date span and checks that the booking is FULLY CONTAINED in the union.
--
-- time representation:
--   day_of_week: ISO 8601 (1=Monday, 7=Sunday)
--   start_minute: minutes since midnight, 0–1439 (0=00:00, 1439=23:59)
--   end_minute:   minutes since midnight, 1–1440 (1440=24:00 = midnight next day)
--   tz: IANA timezone string (e.g. 'America/New_York'); API pre-resolves to UTC.
--
-- Records posture: add/remove only — NO updated_at. Corrections = delete + re-add.
--
-- Composite FKs (hand-written; Drizzle cannot express multi-column FKs):
--
--   FK (org_id) → org(id) ON DELETE CASCADE  [resource_availability_window_org_id_fk]
--     Tenant spine — deleting an org cascades to all its availability windows.
--
--   Composite FK (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT
--     [resource_availability_window_resource_org_fk]
--     Windows are scheduling config — hard-delete of resource blocked while windows
--     exist (operator must remove them first). Prevents cross-org references.
--     Targets resource_id_org_id_unique from migration 0002.
--
--   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--     [resource_availability_window_created_by_org_fk]
--     Write-once attribution; prevents deleting the creating user without explicit
--     cleanup of their window entries. Targets app_user_id_org_id_unique (0000).
--
-- CHECKs:
--   resource_availability_window_dow_check:
--     day_of_week BETWEEN 1 AND 7  (ISO 8601)
--
--   resource_availability_window_start_minute_check:
--     start_minute BETWEEN 0 AND 1439
--
--   resource_availability_window_end_minute_check:
--     end_minute >= 1 AND end_minute <= 1440 AND end_minute > start_minute
--     Forbids overnight wrap; prohibits zero-duration windows.
--
-- UNIQUEs (indexes below):
--   resource_availability_window_id_org_id_unique UNIQUE (id, org_id)
--     Composite candidate key — forward-compat for future composite FKs.
--   resource_availability_window_natural_key_unique
--     UNIQUE (resource_id, day_of_week, start_minute, end_minute)
--     Overlapping windows are allowed (gate unions them) but an exact duplicate
--     is rejected.

CREATE TABLE "resource_availability_window" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"       uuid NOT NULL,
  "resource_id"  uuid NOT NULL,
  "day_of_week"  integer NOT NULL,
  "start_minute" integer NOT NULL,
  "end_minute"   integer NOT NULL,
  "tz"           text NOT NULL,
  "created_by"   uuid NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "resource_availability_window_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: resource must exist in the same org.
  -- ON DELETE RESTRICT: hard-delete blocked while windows exist.
  -- Prevents cross-org resource references.
  -- Targets resource_id_org_id_unique from migration 0002.
  CONSTRAINT "resource_availability_window_resource_org_fk"
    FOREIGN KEY ("resource_id", "org_id")
    REFERENCES "resource"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: creator must be a user in the same org.
  -- ON DELETE RESTRICT: preserves attribution.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "resource_availability_window_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- ISO 8601 day-of-week: 1=Monday, 7=Sunday.
  CONSTRAINT "resource_availability_window_dow_check"
    CHECK ("day_of_week" BETWEEN 1 AND 7),

  -- Start minute: 0=00:00, 1439=23:59.
  CONSTRAINT "resource_availability_window_start_minute_check"
    CHECK ("start_minute" BETWEEN 0 AND 1439),

  -- End minute: 1=00:01, 1440=24:00 (midnight next day, exclusive).
  -- Must be > start_minute to prevent zero-duration and overnight-wrap windows.
  CONSTRAINT "resource_availability_window_end_minute_check"
    CHECK ("end_minute" >= 1 AND "end_minute" <= 1440 AND "end_minute" > "start_minute")
);


-- ── (5) UNIQUE (id, org_id) on resource_availability_window ──────────────────
-- Composite candidate key — forward-compat for future composite FKs and
-- consistent with all other tenant tables.

CREATE UNIQUE INDEX "resource_availability_window_id_org_id_unique"
  ON "resource_availability_window" ("id", "org_id");


-- ── (6) UNIQUE (resource_id, day_of_week, start_minute, end_minute) ──────────
-- Natural deduplication key. Overlapping windows are allowed (gate unions them)
-- but an exact duplicate is rejected.

CREATE UNIQUE INDEX "resource_availability_window_natural_key_unique"
  ON "resource_availability_window" ("resource_id", "day_of_week", "start_minute", "end_minute");


-- ── (7) Index (org_id, resource_id) on resource_availability_window ───────────
-- Covers: load all windows for a resource —
-- WHERE org_id = $1 AND resource_id = $2

CREATE INDEX "resource_availability_window_org_resource_idx"
  ON "resource_availability_window" ("org_id", "resource_id");


-- ── (8) ENABLE + FORCE RLS on resource_availability_window; 4 policies; GRANT ──
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "resource_availability_window" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resource_availability_window" FORCE  ROW LEVEL SECURITY;

-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
-- Byte-identical to 0013 (work_order) and 0009 (dispatch_gate) patterns.

CREATE POLICY "resource_availability_window_select"
  ON "resource_availability_window"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "resource_availability_window_insert"
  ON "resource_availability_window"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "resource_availability_window_update"
  ON "resource_availability_window"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "resource_availability_window_delete"
  ON "resource_availability_window"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "resource_availability_window" TO aeroops_app;
