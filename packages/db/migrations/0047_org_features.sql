-- ============================================================
-- AeroOps — Per-org module toggles + operating mode (small-club mode)
-- Migration: 0047_org_features.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0046_qbo_sync.sql must already be
--               applied.
--
-- CONTEXT: lets an operator turn whole modules of the app on/off (leaner nav
-- for a small flying club) and records an OPERATING MODE ('school' | 'club')
-- chosen at setup and changeable later in settings. Modules default ON —
-- an org with no row (or a DB without this migration) behaves exactly like
-- today's all-modules world.
--
--   org_feature_config — 0..1 row per org (UNIQUE org_id), mirroring
--   dispatch_config's conventions: every column has a DB DEFAULT so a minimal
--   INSERT ... ON CONFLICT upsert can set any single field; an absent row means
--   "all defaults" in application code.
--
--   operating_mode — a PRESET LABEL, not an enforcement value. Choosing 'club'
--   in the UI also writes the club preset into the module booleans below; each
--   boolean stays independently editable afterwards. Enforcement reads ONLY
--   the booleans.
--
--   module_* booleans — one per toggleable module. Core surfaces (scheduling,
--   dispatch board, fleet, people, dashboard, settings, help) are NOT
--   toggleable and have no column. Toggling a module OFF hides it from nav +
--   search and blocks its routes; it NEVER deletes or mutates the module's
--   data ("hide, don't destroy").
--
-- Key guarantees:
--   (a) STRICTLY ADDITIVE — one new table. No existing table, column,
--       constraint, index, policy, or grant is modified or dropped.
--   (b) GRACEFUL ABSENCE: until this migration is applied the table does not
--       exist; every consumer probes to_regclass('org_feature_config') first
--       and degrades to ALL-MODULES-ENABLED (byte-identical to today).
--   (c) Tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS + the standard
--       4-policy pattern + GRANT to aeroops_app. No platform-admin exception.
--   (d) NO money concept, NO FAA/regulatory meaning — pure UI/route
--       configuration data.
--
-- ORDER within this file:
--   (1) CREATE TABLE org_feature_config
--   (2) ENABLE + FORCE RLS
--   (3) RLS policies
--   (4) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE org_feature_config ──────────────────────────────────────────────

CREATE TABLE "org_feature_config" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"              uuid NOT NULL,
  "operating_mode"      text NOT NULL DEFAULT 'school',
  "module_training"     boolean NOT NULL DEFAULT true,
  "module_maintenance"  boolean NOT NULL DEFAULT true,
  "module_billing"      boolean NOT NULL DEFAULT true,
  "module_booking"      boolean NOT NULL DEFAULT true,
  "module_portal"       boolean NOT NULL DEFAULT true,
  "module_reports"      boolean NOT NULL DEFAULT true,
  "module_auto_schedule" boolean NOT NULL DEFAULT true,
  "module_messages"     boolean NOT NULL DEFAULT true,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "org_feature_config_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- 0..1 row per org — the upsert target.
  CONSTRAINT "org_feature_config_org_id_unique"
    UNIQUE ("org_id"),

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "org_feature_config_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Mode domain. A preset label only — enforcement reads the booleans.
  CONSTRAINT "org_feature_config_mode_check" CHECK (
    "operating_mode" IN ('school', 'club')
  )
);


-- ── (2) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE.

ALTER TABLE "org_feature_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_feature_config" FORCE  ROW LEVEL SECURITY;


-- ── (3) RLS policies (standard 4-policy pattern) ──────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   fail-closed on an unset/mismatched GUC (NULL = NULL is false in SQL).

CREATE POLICY "org_feature_config_select"
  ON "org_feature_config"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "org_feature_config_insert"
  ON "org_feature_config"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "org_feature_config_update"
  ON "org_feature_config"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "org_feature_config_delete"
  ON "org_feature_config"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (4) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so FORCE RLS is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "org_feature_config" TO aeroops_app;
