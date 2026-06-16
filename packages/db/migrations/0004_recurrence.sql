-- ============================================================
-- AeroOps — Phase 1 Slice 2b: Recurring reservations
-- Migration: 0004_recurrence.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql + 0001_auth_credential.sql
--               + 0002_scheduling.sql + 0003_booking_policies.sql
--               must already be applied.
--
-- Implements ADR-0006: recurring reservations representation.
-- Key guarantees:
--   (1) reservation_series is tenant-scoped (org_id + ENABLE+FORCE RLS
--       + 4 fail-closed policies + composite FKs + aeroops_app grant),
--       mirroring the byte-pattern of 0002/0003 exactly.
--   (2) reservation.series_id composite FK (series_id, org_id) →
--       reservation_series(id, org_id) ON DELETE SET NULL preserves
--       audited occurrence rows if a series is hard-deleted.
--   (3) btree_gist already installed by 0002 — NOT re-created here.
--       No GiST index needed (series carries no range column).
--
-- ORDER:
--   (1) 3 enum types: recurrence_freq, recurrence_end_kind,
--                     reservation_series_status
--   (2) Table reservation_series + all constraints + index
--   (3) ALTER TABLE reservation ADD COLUMN series_id + composite FK + index
--   (4) ENABLE + FORCE RLS on reservation_series
--   (5) 4 named RLS policies on reservation_series (same GUC predicate as 0002)
--   (6) GRANT to aeroops_app
-- ============================================================


-- ── (1) Enum types ────────────────────────────────────────────────────────────
-- All three types are derived from @aeroops/core tuples
-- (RECURRENCE_FREQS, RECURRENCE_END_KINDS, RESERVATION_SERIES_STATUSES
--  in packages/core/src/scheduling/enums.ts).
-- Order is canonical; never reorder without a new migration.

CREATE TYPE "public"."recurrence_freq" AS ENUM(
  'weekly'
);

CREATE TYPE "public"."recurrence_end_kind" AS ENUM(
  'count',
  'until'
);

CREATE TYPE "public"."reservation_series_status" AS ENUM(
  'active',
  'cancelled'
);


-- ── (2) Table reservation_series ─────────────────────────────────────────────
--
-- The rule record for a recurring booking series. Each expanded occurrence is
-- a `reservation` row linked back here via series_id + composite FK.
--
-- Recurrence columns:
--   freq             — always 'weekly' in Slice 2b (ADR-0006 §1).
--   weekdays         — smallint[]; ISO weekday numbers 1–7 (Mon=1 … Sun=7).
--   interval_weeks   — step in weeks; DEFAULT 1.
--   end_kind         — 'count' | 'until'. Exactly one bound is active (end_shape_check).
--   count            — number of occurrences (1..52). NULL when end_kind='until'.
--   until_date       — local calendar end date. NULL when end_kind='count'.
--   local_start_time — wall-clock start time (time without TZ; DST expansion in core).
--   duration_minutes — length of each occurrence in minutes.
--   iana_tz          — IANA timezone name; API layer validates before persisting.
--   resource_ids     — uuid[]; resources booked for every occurrence.
--   notes            — free text, propagated to occurrence reservation.notes.
--   status           — DEFAULT 'active'; transitions to 'cancelled' via cancelSeries.
--
-- Audit columns:
--   created_by   — app_user id (composite FK RESTRICT — same pattern as reservation).
--   cancelled_at — timestamptz; populated by cancelSeries.
--   cancelled_by — uuid nullable (composite FK SET NULL).
--
-- Composite FKs (all hand-written; Drizzle cannot express multi-col FKs):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine — deleting an org cascades to its series.
--
--   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT:
--     Prevents deleting a user who created series without explicit cleanup.
--     app_user(id, org_id) composite candidate key: UNIQUE (id, org_id) from 0000.
--
--   Composite FK (cancelled_by, org_id) → app_user(id, org_id) ON DELETE SET NULL:
--     Nullable; if the cancelling user is deleted the audit trail is preserved
--     as NULL rather than blocking deletion.
--
-- UNIQUE (id, org_id):
--   Composite candidate key consumed by the reservation.series_id composite FK:
--     (series_id, org_id) → reservation_series(id, org_id) ON DELETE SET NULL.
--   Prevents cross-org occurrence → series linkage structurally.
--
-- CHECK constraints:
--   end_shape_check:
--     Enforces the count XOR until invariant (ADR-0006 §1):
--       count-only:  end_kind='count'  AND count IS NOT NULL AND until_date IS NULL
--       until-only:  end_kind='until'  AND until_date IS NOT NULL AND count IS NULL
--   reservation_series_count_range_check:
--     1 ≤ count ≤ 52 when count IS NOT NULL.
--     The ≤52 cap for until mode is enforced by the app (single choke-point).
--   reservation_series_interval_weeks_check:
--     interval_weeks ≥ 1.
--   reservation_series_duration_minutes_check:
--     duration_minutes > 0.
--   reservation_series_weekdays_check:
--     Cardinality 1–7; all elements in {1,2,3,4,5,6,7}.
--   reservation_series_resource_ids_check:
--     At least 1 element in resource_ids.

CREATE TABLE "reservation_series" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"            uuid NOT NULL,
  "freq"              "recurrence_freq" NOT NULL,
  "weekdays"          smallint[] NOT NULL,
  "interval_weeks"    integer NOT NULL DEFAULT 1,
  "end_kind"          "recurrence_end_kind" NOT NULL,
  "count"             integer,
  "until_date"        date,
  "local_start_time"  time NOT NULL,
  "duration_minutes"  integer NOT NULL,
  "iana_tz"           text NOT NULL,
  "resource_ids"      uuid[] NOT NULL,
  "notes"             text,
  "status"            "reservation_series_status" NOT NULL DEFAULT 'active',
  "created_by"        uuid NOT NULL,
  "cancelled_at"      timestamptz,
  "cancelled_by"      uuid,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "reservation_series_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: creator must be a user in the same org.
  -- ON DELETE RESTRICT: prevents removing a user who created series
  -- without explicit cleanup (matches reservation pattern from 0002).
  CONSTRAINT "reservation_series_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: canceller must be a user in the same org (nullable column;
  -- FK only fires when cancelled_by IS NOT NULL).
  -- ON DELETE SET NULL: if the cancelling user is deleted the audit trail is
  -- preserved as NULL rather than blocking deletion.
  CONSTRAINT "reservation_series_cancelled_by_org_fk"
    FOREIGN KEY ("cancelled_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE SET NULL,

  -- Composite candidate key — consumed by reservation.series_id composite FK:
  --   (series_id, org_id) → reservation_series(id, org_id) ON DELETE SET NULL.
  -- Prevents cross-org occurrence → series linkage structurally.
  CONSTRAINT "reservation_series_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- end_shape_check: count-only XOR until-only (ADR-0006 §1, invariant 1).
  -- Neither both set nor both null is permitted.
  CONSTRAINT "reservation_series_end_shape_check"
    CHECK (
      (end_kind = 'count' AND count IS NOT NULL AND until_date IS NULL)
      OR
      (end_kind = 'until' AND until_date IS NOT NULL AND count IS NULL)
    ),

  -- count must be between 1 and 52 when set (DB mirrors app hard-cap; ADR-0006 §1).
  CONSTRAINT "reservation_series_count_range_check"
    CHECK (count IS NULL OR (count >= 1 AND count <= 52)),

  -- interval_weeks must be at least 1 (a 0-week interval is nonsensical).
  CONSTRAINT "reservation_series_interval_weeks_check"
    CHECK (interval_weeks >= 1),

  -- duration_minutes must be positive (a 0-minute occurrence is nonsensical).
  CONSTRAINT "reservation_series_duration_minutes_check"
    CHECK (duration_minutes > 0),

  -- weekdays cardinality must be 1–7 and all elements must be valid ISO weekdays.
  -- IMPORTANT: array_length returns NULL for an empty array, and Postgres CHECK
  -- treats a NULL result as passing (not a constraint violation). The explicit
  -- IS NOT NULL guard ensures an empty array is rejected — without it, an
  -- ARRAY[]::smallint[] would pass the BETWEEN check (NULL BETWEEN 1 AND 7 = NULL).
  -- The <@ (is contained by) operator tests that every element is in {1..7}.
  CONSTRAINT "reservation_series_weekdays_check"
    CHECK (
      array_length(weekdays, 1) IS NOT NULL
      AND array_length(weekdays, 1) BETWEEN 1 AND 7
      AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
    ),

  -- resource_ids must have at least 1 element.
  CONSTRAINT "reservation_series_resource_ids_check"
    CHECK (array_length(resource_ids, 1) >= 1)
);


-- ── (3) ALTER reservation — add series_id + composite FK + index ──────────────
--
-- series_id is nullable (NULL = one-off reservation; single-create unchanged).
-- Composite FK (series_id, org_id) → reservation_series(id, org_id) ON DELETE SET NULL:
--   Preserves audited occurrence rows if a series is hard-deleted (ADR-0006 §4).
--   The constraint only fires when series_id IS NOT NULL (standard Postgres
--   NULL-FK behaviour for composite FKs with a nullable leading column).
--   reservation_series(id, org_id) composite candidate key: UNIQUE (id, org_id)
--   created by the constraint above.
--
-- INDEX reservation_series_id_idx ON reservation(series_id):
--   Covers: SELECT * FROM reservation WHERE series_id = $1 (listSeriesOccurrences,
--   cancelSeries future-only UPDATE). Partial WHERE series_id IS NOT NULL would
--   save space but adds query-planner complexity; plain index is simpler and safe.

ALTER TABLE "reservation"
  ADD COLUMN "series_id" uuid;

ALTER TABLE "reservation"
  ADD CONSTRAINT "reservation_series_id_org_fk"
    FOREIGN KEY ("series_id", "org_id")
    REFERENCES "reservation_series"("id", "org_id") ON DELETE SET NULL;

CREATE INDEX "reservation_series_id_idx"
  ON "reservation" ("series_id");


-- ── (4) ENABLE + FORCE RLS on reservation_series ─────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "reservation_series" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservation_series" FORCE  ROW LEVEL SECURITY;


-- ── (5) RLS policies ─────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
--
-- Every policy is named explicitly for auditability.
-- 4 policies: SELECT, INSERT, UPDATE, DELETE.

CREATE POLICY "reservation_series_select"
  ON "reservation_series"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "reservation_series_insert"
  ON "reservation_series"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "reservation_series_update"
  ON "reservation_series"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "reservation_series_delete"
  ON "reservation_series"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (6) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "reservation_series" TO aeroops_app;
