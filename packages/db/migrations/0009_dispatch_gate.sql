-- ============================================================
-- AeroOps — Slice 3c: Pre-flight dispatch gate (dispatch_config + dispatch_requirement)
-- Migration: 0009_dispatch_gate.sql
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
--               + 0008_people.sql
--               must already be applied.
--
-- Adds the pre-flight dispatch gate (Slice 3c / ADR-0009):
--   (1) dispatch_config  — per-org gate toggles (eligibility_mode + balance_check_enabled)
--   (2) dispatch_requirement — per-aircraft free-text required tags for check-out
--
-- [VERIFY-3c-A] (HARD COMPLIANCE LINE): required_tag is a FREE-TEXT operator
-- label ONLY. The system computes/interprets NO FAA currency, medical, flight-
-- review, Part 61/141, endorsement, or eligibility status from any tag value.
-- Eligibility blocking = the operator enforcing their own rule. Compliance
-- confirms at QA.
--
-- [VERIFY-3c-MONEY] (HARD MONEY BOUNDARY): dispatch_config.balance_check_enabled
-- is a FEATURE FLAG ONLY. There is NO dollar value, minimum balance, account
-- balance, payment reference, Stripe integration, or any financial data in this
-- migration or any table it creates. The balance seam always returns {ok:true}
-- in Phase 1. Billing / real balance enforcement is Phase 2.
--
-- Key guarantees:
--   (1) dispatch_config: 0..1 row per org (UNIQUE org_id). Absent row → caller
--       applies defaults {eligibilityMode:'block', balanceCheckEnabled:false}.
--   (2) dispatch_config_eligibility_mode_check: only 'block' and 'warn' accepted.
--   (3) dispatch_requirement: per-aircraft free-text labels. Same tag cannot appear
--       twice for one aircraft (UNIQUE resource_id, required_tag).
--   (4) dispatch_requirement_tag_nonempty_check: blank or empty tags rejected.
--   (5) Composite FK (resource_id, org_id) → resource(id, org_id) ON DELETE CASCADE:
--       deleting an aircraft removes its dispatch requirements.
--   (6) Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT:
--       preserves attribution; prevents deleting the creating user while their
--       authorship record exists.
--   (7) Both tables: ENABLE + FORCE RLS + 4 fail-closed named policies + grant to
--       aeroops_app, byte-identical to the pattern in 0008.
--   (8) additive only — no existing tables or columns are modified.
--
-- ORDER:
--   (1) CREATE TABLE dispatch_config + 3 named constraints
--   (2) CREATE TABLE dispatch_requirement + 5 named constraints
--   (3) CREATE INDEX dispatch_requirement_org_resource_idx
--   (4) ENABLE + FORCE RLS on dispatch_config
--   (5) ENABLE + FORCE RLS on dispatch_requirement
--   (6) 4 named RLS policies on dispatch_config
--   (7) 4 named RLS policies on dispatch_requirement
--   (8) GRANT to aeroops_app (both tables)
-- ============================================================


-- ── (1) CREATE TABLE dispatch_config ─────────────────────────────────────────
--
-- Per-org dispatch gate configuration. At most one row per org (UNIQUE org_id).
-- Absent row → defaults apply in application code:
--   { eligibilityMode: 'block', balanceCheckEnabled: false }
--
-- eligibility_mode: controls what happens when a pilot is missing required tags.
--   'block' → dispatch is refused (default, fail-safe).
--   'warn'  → dispatch proceeds with warnings recorded on the ok:true arm.
--
-- balance_check_enabled: FEATURE FLAG ONLY. [VERIFY-3c-MONEY]: no money here.
--   false (default) → balance seam not invoked.
--   true  → stub seam invoked (always {ok:true} in Phase 1, inert).
--   UI copy MUST say "Not yet active — turning this on has no effect until
--   account balances ship."
--
-- Composite FKs:
--   FK (org_id) → org(id) ON DELETE CASCADE  [dispatch_config_org_id_fk]
--     Tenant spine — deleting an org removes its config row.
--
-- CHECKs:
--   dispatch_config_eligibility_mode_check:
--     eligibility_mode IN ('block', 'warn')
--
-- UNIQUEs:
--   dispatch_config_org_id_unique UNIQUE (org_id)
--     One config row per org; used as ON CONFLICT target in upsert.
--   dispatch_config_id_org_id_unique UNIQUE (id, org_id)
--     Composite candidate key — forward-compat for future composite FKs.

CREATE TABLE "dispatch_config" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"                 uuid NOT NULL,
  "eligibility_mode"       text NOT NULL DEFAULT 'block',
  "balance_check_enabled"  boolean NOT NULL DEFAULT false,
  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "updated_at"             timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "dispatch_config_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Eligibility mode domain: only 'block' and 'warn' accepted.
  CONSTRAINT "dispatch_config_eligibility_mode_check"
    CHECK ("eligibility_mode" IN ('block', 'warn')),

  -- One config row per org (ON CONFLICT target for upsert).
  CONSTRAINT "dispatch_config_org_id_unique"
    UNIQUE ("org_id"),

  -- Composite candidate key — forward-compat for future composite FKs.
  CONSTRAINT "dispatch_config_id_org_id_unique"
    UNIQUE ("id", "org_id")
);


-- ── (2) CREATE TABLE dispatch_requirement ────────────────────────────────────
--
-- Per-aircraft free-text required tags for check-out (dispatch gate).
-- At check-out, the system computes: requiredTags \ pilotTags (case-sensitive
-- set difference). If the result is non-empty:
--   eligibility_mode='block' → dispatch refused.
--   eligibility_mode='warn'  → dispatch proceeds with warnings.
--
-- [VERIFY-3c-A] (HARD COMPLIANCE LINE): required_tag is a FREE-TEXT operator
-- label ONLY. No FAA/currency/medical/endorsement meaning is computed from it.
--
-- NO updated_at column: requirements are add/remove only. An unwanted
-- requirement is deleted and a corrected one is re-added (not mutated).
--
-- Composite FKs (hand-written; Drizzle cannot express multi-column FKs):
--
--   FK (org_id) → org(id) ON DELETE CASCADE  [dispatch_requirement_org_id_fk]
--     Tenant spine — deleting an org cascades to its requirements.
--
--   Composite FK (resource_id, org_id) → resource(id, org_id) ON DELETE CASCADE
--     [dispatch_requirement_resource_org_fk]
--     Requirements are config, not audited records — CASCADE is correct.
--     Prevents cross-org resource references.
--     Targets resource_id_org_id_unique established in migration 0002.
--
--   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--     [dispatch_requirement_created_by_org_fk]
--     Preserves attribution: prevents deleting the creating user while their
--     authorship record exists. Targets app_user_id_org_id_unique (0000).
--
-- CHECKs:
--   dispatch_requirement_tag_nonempty_check:
--     char_length(btrim(required_tag)) > 0
--     Prevents blank-only or empty tags; UI trims before sending.
--
-- UNIQUEs:
--   dispatch_requirement_resource_tag_unique UNIQUE (resource_id, required_tag)
--     Same tag cannot appear twice for one aircraft. Case-sensitive.
--
--   dispatch_requirement_id_org_id_unique UNIQUE (id, org_id)
--     Composite candidate key — forward-compat for future composite FKs,
--     consistent with all other tenant tables.

CREATE TABLE "dispatch_requirement" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"        uuid NOT NULL,
  "resource_id"   uuid NOT NULL,
  "required_tag"  text NOT NULL,
  "created_by"    uuid NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "dispatch_requirement_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: requirement must reference a resource in the same org.
  -- ON DELETE CASCADE: requirements are config, not audited records.
  -- Targets resource_id_org_id_unique from migration 0002.
  CONSTRAINT "dispatch_requirement_resource_org_fk"
    FOREIGN KEY ("resource_id", "org_id")
    REFERENCES "resource"("id", "org_id") ON DELETE CASCADE,

  -- Composite FK: creator must be a user in the same org.
  -- ON DELETE RESTRICT: preserves attribution.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "dispatch_requirement_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Tag must not be empty (or blank-only). UI trims before sending.
  CONSTRAINT "dispatch_requirement_tag_nonempty_check" CHECK (
    char_length(btrim("required_tag")) > 0
  ),

  -- Same tag cannot appear twice for one aircraft (case-sensitive).
  CONSTRAINT "dispatch_requirement_resource_tag_unique"
    UNIQUE ("resource_id", "required_tag"),

  -- Composite candidate key — forward-compat for future composite FKs.
  -- Consistent with all other tenant tables.
  CONSTRAINT "dispatch_requirement_id_org_id_unique"
    UNIQUE ("id", "org_id")
);


-- ── (3) Index ─────────────────────────────────────────────────────────────────
-- Covers: list requirements for an aircraft —
-- WHERE org_id = $1 AND resource_id = $2

CREATE INDEX "dispatch_requirement_org_resource_idx"
  ON "dispatch_requirement" ("org_id", "resource_id");


-- ── (4) ENABLE + FORCE RLS on dispatch_config ─────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "dispatch_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispatch_config" FORCE  ROW LEVEL SECURITY;


-- ── (5) ENABLE + FORCE RLS on dispatch_requirement ───────────────────────────

ALTER TABLE "dispatch_requirement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispatch_requirement" FORCE  ROW LEVEL SECURITY;


-- ── (6) RLS policies on dispatch_config ──────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
--
-- Every policy is named explicitly for auditability.
-- 4 policies: SELECT, INSERT, UPDATE, DELETE.

CREATE POLICY "dispatch_config_select"
  ON "dispatch_config"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dispatch_config_insert"
  ON "dispatch_config"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dispatch_config_update"
  ON "dispatch_config"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dispatch_config_delete"
  ON "dispatch_config"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (7) RLS policies on dispatch_requirement ─────────────────────────────────
-- Byte-identical predicate to (6) and to 0008's member_tag policies.
-- dispatch_requirement is add/remove only (no sanctioned UPDATE code path) but
-- the UPDATE policy is required to prevent unguarded mutations.

CREATE POLICY "dispatch_requirement_select"
  ON "dispatch_requirement"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dispatch_requirement_insert"
  ON "dispatch_requirement"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dispatch_requirement_update"
  ON "dispatch_requirement"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dispatch_requirement_delete"
  ON "dispatch_requirement"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (8) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "dispatch_config" TO aeroops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "dispatch_requirement" TO aeroops_app;
