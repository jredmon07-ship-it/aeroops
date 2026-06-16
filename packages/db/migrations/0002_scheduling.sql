-- ============================================================
-- AeroOps — Phase 1 Slice 1: Scheduling tables + conflict engine
-- Migration: 0002_scheduling.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql + 0001_auth_credential.sql
-- must already be applied.
--
-- Implements ADR-0004: scheduling conflict-detection engine.
-- Key guarantee: the EXCLUDE constraint on reservation_resource makes
-- double-booking structurally impossible at the engine level.
--
-- ORDER:
--   (1) btree_gist extension (required for uuid = inside GiST EXCLUDE)
--   (2) Enum types: resource_kind, reservation_status
--   (3) Tables + constraints + indexes:
--         resource → reservation → reservation_resource (FK dependency order)
--   (4) ENABLE + FORCE RLS on all 3 tenant tables
--   (5) 4 named RLS policies per table
--   (6) GRANTs to aeroops_app
-- ============================================================


-- ── (1) Extension ────────────────────────────────────────────────────────────
-- btree_gist provides the GiST operator class for scalar types (uuid, text,
-- int, etc.) so they can participate in a GiST multi-column index alongside
-- range types. Required for:
--   EXCLUDE USING gist (resource_id WITH =, during WITH &&)
-- Without btree_gist, uuid does not have a GiST operator class and the
-- CREATE TABLE (EXCLUDE ...) statement will fail.
--
-- Standard on Neon, Supabase, and bundled in @electric-sql/pglite 0.5.2.

CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ── (2) Enum types ────────────────────────────────────────────────────────────
-- Both types are derived from @aeroops/core tuples (RESOURCE_KINDS,
-- RESERVATION_STATUSES in packages/core/src/scheduling/enums.ts).
-- Order is canonical; never reorder without a new migration.

CREATE TYPE "public"."resource_kind" AS ENUM(
  'aircraft',
  'instructor',
  'sim',
  'room',
  'vehicle'
);

CREATE TYPE "public"."reservation_status" AS ENUM(
  'booked',
  'cancelled'
);


-- ── (3) Tables + constraints + indexes ───────────────────────────────────────

-- ── resource ─────────────────────────────────────────────────────────────────
-- A bookable entity (aircraft, instructor, sim, room, vehicle) owned by one org.
--
-- Shape invariant (resource_kind_shape_check):
--   aircraft  → tail_number IS NOT NULL, instructor_user_id IS NULL
--   instructor → instructor_user_id IS NOT NULL, tail_number IS NULL
--   sim/room/vehicle → both NULL
--
-- Composite FK (instructor_user_id, org_id) → app_user(id, org_id):
--   Structurally prevents linking an instructor resource to a user in a
--   different org. Same pattern as membership_user_org_fk (0000) and
--   auth_credential_user_org_fk (0001).
--
-- UNIQUE (id, org_id): composite candidate key consumed by the composite
--   FK in reservation_resource (resource_id, org_id) → resource(id, org_id).

CREATE TABLE "resource" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"               uuid NOT NULL,
  "kind"                 "resource_kind" NOT NULL,
  "display_name"         text NOT NULL,
  "tail_number"          text,
  "instructor_user_id"   uuid,
  "active"               boolean NOT NULL DEFAULT true,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "resource_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: prevents cross-org instructor linkage.
  -- instructor_user_id may be NULL (aircraft/sim/room/vehicle); FK only
  -- fires when the column is non-NULL (standard Postgres NULL-FK behaviour).
  CONSTRAINT "resource_instructor_user_org_fk"
    FOREIGN KEY ("instructor_user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE SET NULL,

  -- Composite candidate key — consumed by reservation_resource composite FK.
  CONSTRAINT "resource_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Enforce per-kind column shapes; prevents storing e.g. a tail_number on
  -- an instructor resource or forgetting instructor_user_id on an instructor.
  CONSTRAINT "resource_kind_shape_check" CHECK (
    (kind = 'aircraft'   AND tail_number IS NOT NULL AND instructor_user_id IS NULL)
    OR
    (kind = 'instructor' AND instructor_user_id IS NOT NULL AND tail_number IS NULL)
    OR
    (kind IN ('sim', 'room', 'vehicle') AND tail_number IS NULL AND instructor_user_id IS NULL)
  )
);

-- Covers: SELECT * FROM resource WHERE org_id = $1 AND kind = $2
CREATE INDEX "resource_org_id_kind_idx" ON "resource" ("org_id", "kind");


-- ── reservation ───────────────────────────────────────────────────────────────
-- The canonical time window + status record for a booking.
-- Up to N resources are linked via reservation_resource join rows.
--
-- CHECK (end_at > start_at): enforced at DB level; adjacency is valid.
--
-- Composite FKs (both hand-written; Drizzle cannot express multi-col FKs):
--   (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--     Prevents deleting a user who owns reservations without explicit cleanup.
--   (cancelled_by, org_id) → app_user(id, org_id) ON DELETE SET NULL
--     Nullable; if the cancelling user is deleted the audit trail is preserved
--     as NULL rather than blocking deletion.
--
-- UNIQUE (id, org_id): composite candidate key for reservation_resource FK.

CREATE TABLE "reservation" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"        uuid NOT NULL,
  "start_at"      timestamptz NOT NULL,
  "end_at"        timestamptz NOT NULL,
  "status"        "reservation_status" NOT NULL DEFAULT 'booked',
  "notes"         text,
  "created_by"    uuid NOT NULL,
  "cancelled_at"  timestamptz,
  "cancelled_by"  uuid,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "reservation_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: creator must be a user in the same org.
  CONSTRAINT "reservation_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: canceller must be a user in the same org (nullable column;
  -- FK only fires when cancelled_by IS NOT NULL).
  CONSTRAINT "reservation_cancelled_by_org_fk"
    FOREIGN KEY ("cancelled_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE SET NULL,

  -- Composite candidate key — consumed by reservation_resource composite FK.
  CONSTRAINT "reservation_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Time-range sanity check (also enforced in @aeroops/core before submit).
  CONSTRAINT "reservation_end_after_start_check"
    CHECK ("end_at" > "start_at")
);

-- Covers: SELECT * FROM reservation WHERE org_id = $1 AND status = $2
CREATE INDEX "reservation_org_id_status_idx" ON "reservation" ("org_id", "status");


-- ── reservation_resource ─────────────────────────────────────────────────────
-- Join table linking one reservation to one resource. Carries denormalized
-- `during tstzrange` (derived from reservation.start_at/end_at) so that the
-- EXCLUDE constraint can enforce overlap without a join.
--
-- THE EXCLUDE CONSTRAINT (the no-double-book guarantee):
--
--   EXCLUDE USING gist (resource_id WITH =, during WITH &&)
--   WHERE (status = 'booked')
--
--   Semantics: no two committed rows with status='booked' may share the same
--   resource_id AND have overlapping `during` ranges. `&&` is the Postgres
--   range overlap operator; the `[)'` half-open encoding means adjacent windows
--   [10:00,11:00) and [11:00,12:00) do NOT overlap (ADR-0004 invariant 6).
--
--   org_id is NOT in the exclusion because resource_id is globally unique
--   (composite FK makes "resource_id → one org" structural); two orgs'
--   resources cannot share a resource_id, so cross-org false-blocks are
--   impossible (ADR-0004 §Org-scoping).
--
--   Error code on violation: 23P01 (exclusion_violation). The API layer
--   catches this, re-queries for the colliding rows, and returns a rich
--   ConflictHit[] to the caller.
--
-- TSTZRANGE building convention (the ONLY sanctioned representation):
--   tstzrange(start_at::timestamptz, end_at::timestamptz, '[)')
--   Always half-open: inclusive start, exclusive end. Adjacency ≠ conflict.
--
-- Application conflict-probe query:
--   SELECT rr.* FROM reservation_resource rr
--   WHERE rr.resource_id = ANY($resourceIds::uuid[])
--     AND rr.status = 'booked'
--     AND rr.during && tstzrange($start::timestamptz, $end::timestamptz, '[)')
--   (The GiST EXCLUDE index also serves this query — GiST supports &&.)
--
-- Composite FKs (hand-written; Drizzle cannot express multi-col FKs):
--   (reservation_id, org_id) → reservation(id, org_id) ON DELETE CASCADE
--     Deleting a reservation cascades to all its resource-join rows.
--   (resource_id, org_id)    → resource(id, org_id)    ON DELETE RESTRICT
--     Prevents deleting a resource that is referenced by future reservations
--     without explicit cleanup (soft-delete via resource.active instead).
--
-- UNIQUE (reservation_id, resource_id): one join row per resource per reservation.
--
-- INDEX (org_id, resource_id, status): covers non-range lookups such as
--   "all booked join rows for this org and resource". The GiST EXCLUDE index
--   covers overlap (&&) queries; this btree covers equality probes.

CREATE TABLE "reservation_resource" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"          uuid NOT NULL,
  "reservation_id"  uuid NOT NULL,
  "resource_id"     uuid NOT NULL,
  "during"          tstzrange NOT NULL,
  "status"          "reservation_status" NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "reservation_resource_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: join row must reference a reservation in the same org.
  CONSTRAINT "reservation_resource_reservation_org_fk"
    FOREIGN KEY ("reservation_id", "org_id")
    REFERENCES "reservation"("id", "org_id") ON DELETE CASCADE,

  -- Composite FK: join row must reference a resource in the same org.
  CONSTRAINT "reservation_resource_resource_org_fk"
    FOREIGN KEY ("resource_id", "org_id")
    REFERENCES "resource"("id", "org_id") ON DELETE RESTRICT,

  -- One join row per resource per reservation.
  CONSTRAINT "reservation_resource_res_id_resource_id_unique"
    UNIQUE ("reservation_id", "resource_id"),

  -- THE CORE GUARANTEE: no two booked join rows may share resource_id and
  -- have overlapping during ranges. Requires btree_gist (installed above)
  -- for the uuid equality (=) operator class inside the GiST index.
  CONSTRAINT "reservation_resource_no_double_book"
    EXCLUDE USING gist (
      "resource_id" WITH =,
      "during"      WITH &&
    )
    WHERE (status = 'booked')
);

-- btree index: covers equality probes (org_id + resource_id + status).
-- The GiST EXCLUDE index (created implicitly by the EXCLUDE constraint above)
-- covers the range overlap (&&) probe in the conflict-probe query.
CREATE INDEX "reservation_resource_org_resource_status_idx"
  ON "reservation_resource" ("org_id", "resource_id", "status");


-- ── (4) ENABLE + FORCE RLS on all 3 tenant tables ────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "resource"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resource"             FORCE  ROW LEVEL SECURITY;

ALTER TABLE "reservation"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservation"          FORCE  ROW LEVEL SECURITY;

ALTER TABLE "reservation_resource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservation_resource" FORCE  ROW LEVEL SECURITY;


-- ── (5) RLS policies ─────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
--
-- Every policy is named explicitly for auditability.
-- 4 policies per table: SELECT, INSERT, UPDATE, DELETE.

-- ── resource ─────────────────────────────────────────────────────────────────

CREATE POLICY "resource_select"
  ON "resource"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "resource_insert"
  ON "resource"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "resource_update"
  ON "resource"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "resource_delete"
  ON "resource"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── reservation ───────────────────────────────────────────────────────────────

CREATE POLICY "reservation_select"
  ON "reservation"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "reservation_insert"
  ON "reservation"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "reservation_update"
  ON "reservation"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "reservation_delete"
  ON "reservation"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── reservation_resource ─────────────────────────────────────────────────────

CREATE POLICY "reservation_resource_select"
  ON "reservation_resource"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "reservation_resource_insert"
  ON "reservation_resource"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "reservation_resource_update"
  ON "reservation_resource"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "reservation_resource_delete"
  ON "reservation_resource"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (6) GRANTs to aeroops_app ─────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "resource"             TO aeroops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "reservation"          TO aeroops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "reservation_resource" TO aeroops_app;
