-- ============================================================
-- AeroOps — Slice 0.2: Auth credential table
-- Migration: 0001_auth_credential.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisite: 0000_loud_prodigy.sql must already be applied.
--
-- ORDER:
--   (1) Table + constraints + indexes
--   (2) ENABLE + FORCE RLS
--   (3) RLS policies
--   (4) GRANT to aeroops_app
-- ============================================================


-- ── (1) Table + constraints + indexes ────────────────────────────────────────

-- auth_credential — tenant-scoped, 1:1 with app_user
-- Isolates password hashes from the profile row (app_user).
-- Cross-org credentials are structurally impossible via the composite FK
-- (user_id, org_id) REFERENCES app_user(id, org_id): a credential row can
-- only point to a user that belongs to the same org.
-- password_hash stores an argon2id ENCODED string; never a raw password.

CREATE TABLE "auth_credential" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"        uuid NOT NULL,
  "user_id"       uuid NOT NULL,
  "password_hash" text NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "auth_credential_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,
  -- Composite FK: structurally prevents cross-org credential rows.
  -- Mirrors the membership_user_org_fk pattern from 0000.
  CONSTRAINT "auth_credential_user_org_fk"
    FOREIGN KEY ("user_id", "org_id") REFERENCES "app_user"("id", "org_id") ON DELETE CASCADE,
  -- One credential per user (globally — user_id is unique across all orgs
  -- because app_user.id is itself globally unique).
  CONSTRAINT "auth_credential_user_id_unique"
    UNIQUE ("user_id")
);

-- RLS filter index — every tenant query on auth_credential filters by org_id
CREATE INDEX "auth_credential_org_id_idx" ON "auth_credential" ("org_id");


-- ── (2) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "auth_credential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_credential" FORCE  ROW LEVEL SECURITY;


-- ── (3) RLS policies ─────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
--
-- NO platform-admin branch: auth_credential is always accessed under
-- withOrgContext (the login flow resolves org_id first, then reads the
-- credential). The platform/control-plane never reads credential rows.
--
-- Every policy is named explicitly for auditability.

CREATE POLICY "auth_credential_select"
  ON "auth_credential"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "auth_credential_insert"
  ON "auth_credential"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "auth_credential_update"
  ON "auth_credential"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "auth_credential_delete"
  ON "auth_credential"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (4) GRANT to aeroops_app ─────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "auth_credential" TO aeroops_app;
