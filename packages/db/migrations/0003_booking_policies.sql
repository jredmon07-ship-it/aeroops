-- ============================================================
-- AeroOps — Phase 1 Slice 2a: Booking policies + blackout windows
-- Migration: 0003_booking_policies.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql + 0001_auth_credential.sql
--               + 0002_scheduling.sql must already be applied.
--
-- Implements ADR-0005: booking-policy enforcement gate.
-- Key guarantee: both new tables are tenant-scoped (org_id + ENABLE+FORCE RLS
-- + 4 fail-closed policies + composite FK + aeroops_app grant), mirroring
-- the pattern in 0002_scheduling.sql exactly.
--
-- SCOPE AMENDMENT (2026-06-16, founder):
--   required_tags is DEFERRED out of Slice 2a.
--   NO required_tags column on booking_policy.
--   NO booking_tags column on membership.
--   NO new pgEnum.
--   btree_gist already installed by 0002 — not re-created here.
--
-- ORDER:
--   (1) Table booking_policy + constraints + indexes
--   (2) Table resource_blackout + constraints + indexes
--   (3) ENABLE + FORCE RLS on both new tenant tables
--   (4) 4 named RLS policies per table (same GUC predicate as 0002)
--   (5) GRANTs to aeroops_app
-- ============================================================


-- ── (1) Table booking_policy ──────────────────────────────────────────────────
--
-- One optional policy row per resource (UNIQUE resource_id).
-- Absent row = open booking; Slice-1 behaviour preserved byte-for-byte.
--
-- Rules (all nullable — NULL means "no limit on that dimension"):
--   max_duration_minutes: CHECK > 0  (a 0-minute limit makes no sense)
--   max_advance_days:     CHECK >= 0 (0 = same-day only)
--   min_advance_minutes:  CHECK >= 0 (0 = instant booking allowed)
--
-- Composite FK (resource_id, org_id) → resource(id, org_id) ON DELETE CASCADE:
--   Policy is a child attribute of the resource; deleting the resource
--   removes its policy. Cross-org resource linkage is structurally impossible.
--   resource(id, org_id) composite candidate key created by 0002's
--   CONSTRAINT resource_id_org_id_unique UNIQUE (id, org_id).
--
-- FK (org_id) → org(id) ON DELETE CASCADE:
--   Tenant spine — deleting an org cascades to its policies.
--
-- UNIQUE (resource_id): one policy per resource.
--
-- INDEX (org_id, resource_id): covers the per-resource policy-probe query
--   on the reservation create path.

CREATE TABLE "booking_policy" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"                uuid NOT NULL,
  "resource_id"           uuid NOT NULL,
  "max_duration_minutes"  integer,
  "max_advance_days"      integer,
  "min_advance_minutes"   integer,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "booking_policy_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: policy must reference a resource in the same org.
  -- ON DELETE CASCADE: removing a resource removes its policy.
  CONSTRAINT "booking_policy_resource_org_fk"
    FOREIGN KEY ("resource_id", "org_id")
    REFERENCES "resource"("id", "org_id") ON DELETE CASCADE,

  -- One policy row per resource.
  CONSTRAINT "booking_policy_resource_id_unique"
    UNIQUE ("resource_id"),

  -- max_duration_minutes must be positive (a 0-minute max makes no sense).
  CONSTRAINT "booking_policy_max_duration_check"
    CHECK ("max_duration_minutes" IS NULL OR "max_duration_minutes" > 0),

  -- max_advance_days: 0 = same-day only; must not be negative.
  CONSTRAINT "booking_policy_max_advance_check"
    CHECK ("max_advance_days" IS NULL OR "max_advance_days" >= 0),

  -- min_advance_minutes: 0 = instant booking; must not be negative.
  CONSTRAINT "booking_policy_min_advance_check"
    CHECK ("min_advance_minutes" IS NULL OR "min_advance_minutes" >= 0)
);

-- Covers: SELECT * FROM booking_policy WHERE org_id = $1 AND resource_id = $2
CREATE INDEX "booking_policy_org_id_resource_id_idx"
  ON "booking_policy" ("org_id", "resource_id");


-- ── (2) Table resource_blackout ───────────────────────────────────────────────
--
-- Per-resource unavailability windows (0..N per resource).
-- Checked in pure core (policy.ts); NO DB EXCLUDE — two blackouts on one
-- resource may overlap freely (operator's prerogative, ADR-0005 §4).
--
-- `during` tstzrange — MUST be built as:
--   tstzrange($start::timestamptz, $end::timestamptz, '[)')
--   Half-open [inclusive-start, exclusive-end). Adjacency is NOT a violation.
--
-- CHECK during_nonempty: lower IS NOT NULL AND upper IS NOT NULL AND lower < upper.
--   Prevents degenerate (empty, inverted) ranges.
--
-- Composite FKs (all hand-written; same pattern as 0002):
--   (resource_id, org_id) → resource(id, org_id) ON DELETE CASCADE
--     Deleting a resource removes all its blackouts.
--   (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--     Prevents deleting the creating user without cleaning up their blackouts
--     (soft-delete app_user; audit trail preserved as RESTRICT rather than NULL
--     because blackout ownership is operationally significant).
--
-- FK (org_id) → org(id) ON DELETE CASCADE:
--   Tenant spine.
--
-- INDEX (org_id, resource_id): covers the blackout-load query on the create path.
--
-- No updated_at: blackout rows are immutable once created (records integrity).
-- Correction = delete + recreate, each audited separately.

CREATE TABLE "resource_blackout" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"      uuid NOT NULL,
  "resource_id" uuid NOT NULL,
  "during"      tstzrange NOT NULL,
  "reason"      text,
  "created_by"  uuid NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "resource_blackout_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: blackout must reference a resource in the same org.
  -- ON DELETE CASCADE: removing a resource removes all its blackouts.
  CONSTRAINT "resource_blackout_resource_org_fk"
    FOREIGN KEY ("resource_id", "org_id")
    REFERENCES "resource"("id", "org_id") ON DELETE CASCADE,

  -- Composite FK: creator must be a user in the same org.
  -- ON DELETE RESTRICT: prevents removing a user who owns blackout entries
  -- without explicit cleanup.
  -- app_user(id, org_id) composite candidate key: UNIQUE (id, org_id) from 0000.
  CONSTRAINT "resource_blackout_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Prevent degenerate (empty, inverted, or unbounded) ranges.
  CONSTRAINT "resource_blackout_during_nonempty"
    CHECK (
      lower("during") IS NOT NULL
      AND upper("during") IS NOT NULL
      AND lower("during") < upper("during")
    )
);

-- Covers: SELECT * FROM resource_blackout WHERE org_id = $1 AND resource_id = $2
CREATE INDEX "resource_blackout_org_id_resource_id_idx"
  ON "resource_blackout" ("org_id", "resource_id");


-- ── (3) ENABLE + FORCE RLS on both new tenant tables ─────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "booking_policy"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "booking_policy"    FORCE  ROW LEVEL SECURITY;

ALTER TABLE "resource_blackout" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resource_blackout" FORCE  ROW LEVEL SECURITY;


-- ── (4) RLS policies ─────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
--
-- Every policy is named explicitly for auditability.
-- 4 policies per table: SELECT, INSERT, UPDATE, DELETE.

-- ── booking_policy ────────────────────────────────────────────────────────────

CREATE POLICY "booking_policy_select"
  ON "booking_policy"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "booking_policy_insert"
  ON "booking_policy"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "booking_policy_update"
  ON "booking_policy"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "booking_policy_delete"
  ON "booking_policy"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── resource_blackout ─────────────────────────────────────────────────────────

CREATE POLICY "resource_blackout_select"
  ON "resource_blackout"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "resource_blackout_insert"
  ON "resource_blackout"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "resource_blackout_update"
  ON "resource_blackout"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "resource_blackout_delete"
  ON "resource_blackout"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (5) GRANTs to aeroops_app ─────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "booking_policy"    TO aeroops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "resource_blackout" TO aeroops_app;
