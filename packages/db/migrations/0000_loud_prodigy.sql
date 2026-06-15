-- ============================================================
-- AeroOps — Slice 0.1: Tenant data spine + RLS backstop
-- Migration: 0000_loud_prodigy.sql
--
-- ORDER:
--   (1) Extension
--   (2) Enum type
--   (3) Tables + constraints + indexes
--   (4) ENABLE + FORCE RLS on every tenant table
--   (5) RLS policies
--
-- HUMAN-GATED: review this file before running.
-- Never auto-apply to a real database.
-- ============================================================


-- ── (1) Extension ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ── (2) Enum type ────────────────────────────────────────────────────────────
-- Derived from @aeroops/core MEMBERSHIP_ROLES tuple.
-- Order is canonical; never reorder without a new migration.

CREATE TYPE "public"."membership_role" AS ENUM(
  'owner',
  'manager',
  'dispatcher',
  'cfi',
  'mechanic',
  'renter',
  'student',
  'accountant'
);


-- ── (3) Tables + constraints + indexes ───────────────────────────────────────

-- org — root tenant entity (self-keyed for RLS)
CREATE TABLE "org" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name"       text NOT NULL,
  "slug"       text NOT NULL,
  "status"     text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "org_slug_unique"          UNIQUE ("slug"),
  CONSTRAINT "org_status_check"         CHECK ("status" IN ('active', 'suspended'))
);

-- location — tenant-scoped
CREATE TABLE "location" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"     uuid NOT NULL,
  "name"       text NOT NULL,
  "icao"       text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "location_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE
);

CREATE INDEX "location_org_id_idx" ON "location" ("org_id");

-- app_user — tenant-scoped (table name avoids reserved word "user")
CREATE TABLE "app_user" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"     uuid NOT NULL,
  "email"      text NOT NULL,
  "full_name"  text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "app_user_org_id_fk"          FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,
  CONSTRAINT "app_user_org_id_email_unique" UNIQUE ("org_id", "email"),
  -- Composite candidate key — consumed by membership composite FK
  CONSTRAINT "app_user_id_org_id_unique"   UNIQUE ("id", "org_id")
);

-- membership — tenant-scoped
CREATE TABLE "membership" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"     uuid NOT NULL,
  "user_id"    uuid NOT NULL,
  "role"       "membership_role" NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "membership_org_id_fk"           FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,
  -- Composite FK: structurally prevents cross-org membership rows
  CONSTRAINT "membership_user_org_fk"         FOREIGN KEY ("user_id", "org_id") REFERENCES "app_user"("id", "org_id") ON DELETE CASCADE,
  CONSTRAINT "membership_org_id_user_id_unique" UNIQUE ("org_id", "user_id")
);

CREATE INDEX "membership_user_id_idx" ON "membership" ("user_id");

-- plan — platform/control-plane (NO RLS)
CREATE TABLE "plan" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code"             text NOT NULL,
  "name"             text NOT NULL,
  "stripe_price_id"  text,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "plan_code_unique" UNIQUE ("code")
);

-- subscription — platform/control-plane (NO RLS)
CREATE TABLE "subscription" (
  "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"                  uuid NOT NULL,
  "plan_id"                 uuid NOT NULL,
  "status"                  text NOT NULL DEFAULT 'trialing',
  "stripe_subscription_id"  text,
  "created_at"              timestamptz NOT NULL DEFAULT now(),
  "updated_at"              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "subscription_org_id_fk"     FOREIGN KEY ("org_id")  REFERENCES "org"("id")  ON DELETE CASCADE,
  CONSTRAINT "subscription_plan_id_fk"    FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_org_id_unique" UNIQUE ("org_id"),
  CONSTRAINT "subscription_status_check"  CHECK ("status" IN ('trialing', 'active', 'past_due', 'canceled'))
);

-- audit_log — tenant-scoped, append-only (no updated_at)
CREATE TABLE "audit_log" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"        uuid NOT NULL,
  "actor_user_id" uuid,
  "action"        text NOT NULL,
  "entity_type"   text NOT NULL,
  "entity_id"     uuid,
  "metadata"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "audit_log_org_id_fk"          FOREIGN KEY ("org_id")        REFERENCES "org"("id")      ON DELETE CASCADE,
  CONSTRAINT "audit_log_actor_user_id_fk"   FOREIGN KEY ("actor_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL
);

CREATE INDEX "audit_log_org_id_idx"     ON "audit_log" ("org_id");
CREATE INDEX "audit_log_org_entity_idx" ON "audit_log" ("org_id", "entity_type", "entity_id");


-- ── (4) ENABLE + FORCE RLS on tenant tables ──────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "org"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org"        FORCE  ROW LEVEL SECURITY;

ALTER TABLE "location"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "location"   FORCE  ROW LEVEL SECURITY;

ALTER TABLE "app_user"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app_user"   FORCE  ROW LEVEL SECURITY;

ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership" FORCE  ROW LEVEL SECURITY;

ALTER TABLE "audit_log"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log"  FORCE  ROW LEVEL SECURITY;

-- plan and subscription: NO RLS (platform/control-plane tables)


-- ── (5) RLS policies ─────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
--
-- Every policy is named explicitly for auditability.

-- ── org (self-keyed: predicate on id, not org_id) ────────────────────────────
-- FIX 4: org_select also permits platform-admin context so that control-plane
-- code running as aeroops_app can INSERT INTO org ... RETURNING * and SELECT
-- across all orgs. Without this, the RETURNING clause from an INSERT under
-- platform-admin context returns 0 rows (the policy blocks the implicit SELECT).
-- Normal tenant context (platform_admin not 'on') remains scoped to its own org.

CREATE POLICY "org_select"
  ON "org"
  FOR SELECT
  USING (
    id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'on'
  );

CREATE POLICY "org_update"
  ON "org"
  FOR UPDATE
  USING (
    id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "org_delete"
  ON "org"
  FOR DELETE
  USING (
    id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- org INSERT — platform-admin only (tenants must never create orgs)
CREATE POLICY "org_insert_platform_admin"
  ON "org"
  FOR INSERT
  WITH CHECK (
    current_setting('app.platform_admin', true) = 'on'
  );

-- ── location ─────────────────────────────────────────────────────────────────

CREATE POLICY "location_select"
  ON "location"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "location_insert"
  ON "location"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "location_update"
  ON "location"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "location_delete"
  ON "location"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── app_user ──────────────────────────────────────────────────────────────────

CREATE POLICY "app_user_select"
  ON "app_user"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "app_user_insert"
  ON "app_user"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "app_user_update"
  ON "app_user"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "app_user_delete"
  ON "app_user"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── membership ────────────────────────────────────────────────────────────────

CREATE POLICY "membership_select"
  ON "membership"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "membership_insert"
  ON "membership"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "membership_update"
  ON "membership"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "membership_delete"
  ON "membership"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── audit_log (append-only: SELECT + INSERT only; no UPDATE, no DELETE) ───────

CREATE POLICY "audit_log_select"
  ON "audit_log"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "audit_log_insert"
  ON "audit_log"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- No UPDATE or DELETE policies on audit_log.
-- With FORCE ROW LEVEL SECURITY, the absence of a permissive policy
-- means those operations are blocked for ALL roles (including the table owner).


-- ── (6) Application role (non-superuser) ─────────────────────────────────────
-- Production MUST connect as this role (not postgres/superuser).
-- Superusers bypass RLS unconditionally in Postgres; FORCE ROW LEVEL SECURITY
-- only overrides the table-owner exemption for non-superuser owners.
-- Using a dedicated non-superuser role is the structural guarantee that RLS
-- is enforced for every query from the application tier.
--
-- In test environments (PGlite), SET ROLE aeroops_app after applying this
-- migration to simulate the production constraint.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aeroops_app') THEN
    CREATE ROLE aeroops_app NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO aeroops_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  org, location, app_user, membership, audit_log
TO aeroops_app;

-- FIX 2: plan and subscription are platform/control-plane tables (no RLS).
-- aeroops_app (the tenant app role) must NOT write billing/plan state.
-- SELECT is retained so the app can read its own plan/subscription.
-- A dedicated control_plane_role (tracked for Slice 0.4) owns INSERT/UPDATE/DELETE.
-- Seeding runs as the PGlite superuser before SET ROLE, so this won't break seeds.
-- [VERIFY] Confirm with devops/compliance that control_plane_role is created and
-- granted full DML on plan/subscription before the first real Postgres deployment.
GRANT SELECT ON
  plan, subscription
TO aeroops_app;

-- FIX 5: belt-and-suspenders immutability for audit_log.
-- The absence of UPDATE/DELETE policies under FORCE RLS already blocks those
-- operations, but an explicit REVOKE ensures immutability does not rely solely
-- on the policy-absence mechanism (e.g. if a policy were accidentally added).
-- audit_log keeps SELECT + INSERT (append-only).
-- [VERIFY] Full tamper-evidence (hash chain / WORM storage) is tracked for
-- Phase 2/3 before the first real audit writer goes to production.
REVOKE UPDATE, DELETE ON audit_log FROM aeroops_app;
