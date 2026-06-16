-- ============================================================
-- AeroOps — Phase 1 Slice 3a: Dispatch ticket + check-out/in
-- Migration: 0005_dispatch.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql + 0001_auth_credential.sql
--               + 0002_scheduling.sql + 0003_booking_policies.sql
--               + 0004_recurrence.sql
--               must already be applied.
--
-- Implements ADR-0007: dispatch ticket records-immutable check-out/in,
-- the one-open backstop, and the dispatch↔reservation seam.
--
-- Key guarantees:
--   (1) dispatch_ticket is tenant-scoped (org_id + ENABLE+FORCE RLS
--       + 4 fail-closed policies + composite FKs + aeroops_app grant),
--       mirroring the byte-pattern of 0002/0003/0004 exactly.
--   (2) Partial UNIQUE index (resource_id) WHERE (status='open') enforces
--       "at most one open ticket per aircraft" structurally at DB level.
--       A second INSERT raises 23505 (unique_violation), caught and mapped
--       to the typed 'already_open' refusal (ADR-0007 §2, ADR-0004 pattern).
--   (3) Composite FKs on all edges: (reservation_id,org_id)→reservation,
--       (resource_id,org_id)→resource, (pilot_user_id,org_id)→app_user,
--       (opened_by,org_id)→app_user, (closed_by,org_id)→app_user.
--       ON DELETE RESTRICT on senior records; ON DELETE SET NULL for nullable
--       closed_by (mirrors the reservation.cancelled_by pattern from 0002).
--   (4) CHECK dispatch_meters_nonneg_check: meter readings non-negative.
--   (5) CHECK dispatch_closed_shape_check: 'closed' status ⇒ all _in
--       columns NOT NULL; 'open'/'voided' ⇒ all _in columns NULL.
--       NO in>=out CHECK — that is app-level (ADR-0007 §2; [VERIFY-A]).
--   (6) UNIQUE (id, org_id) composite candidate key — forward-compat for
--       future composite FKs (e.g. dispatch_ticket_correction table).
--
-- ORDER:
--   (1) Enum type: dispatch_status
--   (2) Table dispatch_ticket + all composite FKs + CHECKs + UNIQUE
--   (3) Partial UNIQUE index: one open ticket per aircraft
--   (4) Regular indexes: org+resource, org+reservation
--   (5) ENABLE + FORCE RLS on dispatch_ticket
--   (6) 4 named RLS policies (same GUC predicate as 0002/0003/0004)
--   (7) GRANT to aeroops_app
-- ============================================================


-- ── (1) Enum type ─────────────────────────────────────────────────────────────
-- Derived from @aeroops/core DISPATCH_STATUSES tuple (scheduling/enums.ts).
-- Three values: 'open' (checked out), 'closed' (checked in),
-- 'voided' (mistaken check-out abandoned while open).
-- Order is canonical; never reorder without a new migration.

CREATE TYPE "public"."dispatch_status" AS ENUM(
  'open',
  'closed',
  'voided'
);


-- ── (2) Table dispatch_ticket ─────────────────────────────────────────────────
--
-- Records the check-out (OPEN) and check-in (CLOSE) of an aircraft.
-- A third transition (VOID) abandons a mistaken check-out while still open.
--
-- Records posture (ADR-0007 §1):
--   Meters are write-once: hobbs_out/tach_out at OPEN, the _in columns at CLOSE.
--   Only mutable columns: status (open→closed | open→voided), closed_by,
--   closed_at, updated_at. No code path UPDATEs a recorded meter.
--
-- Composite FKs (all hand-written; Drizzle cannot express multi-col FKs):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine — deleting an org cascades to its tickets.
--
--   Composite FK (reservation_id, org_id) → reservation(id, org_id)
--     ON DELETE RESTRICT:
--     Prevents hard-deleting a reservation that has any dispatch record.
--     Requires reservation(id, org_id) UNIQUE "reservation_id_org_id_unique"
--     established in migration 0002.
--
--   Composite FK (resource_id, org_id) → resource(id, org_id)
--     ON DELETE RESTRICT:
--     Prevents hard-deleting an aircraft that has tickets (same
--     soft-delete-via-active discipline as reservation_resource in 0002).
--     Requires resource(id, org_id) UNIQUE "resource_id_org_id_unique"
--     established in migration 0002.
--
--   Composite FK (pilot_user_id, org_id) → app_user(id, org_id)
--     ON DELETE RESTRICT:
--     Pilot must be a member of the same org; cross-org guard.
--     Requires app_user(id, org_id) UNIQUE "app_user_id_org_id_unique"
--     established in migration 0000.
--
--   Composite FK (opened_by, org_id) → app_user(id, org_id)
--     ON DELETE RESTRICT:
--     Opener must be a member; prevents referencing a deleted user who
--     opened the ticket without explicit cleanup.
--
--   Composite FK (closed_by, org_id) → app_user(id, org_id)
--     ON DELETE SET NULL:
--     Nullable; if the closing user is deleted the audit trail is preserved
--     as NULL rather than blocking deletion.
--     Composite NULL-FK: fires only when closed_by IS NOT NULL (standard
--     Postgres NULL-FK behaviour for composite FKs with a nullable leading
--     column). Mirrors the reservation.cancelled_by pattern from 0002.
--
-- UNIQUE (id, org_id) — composite candidate key for future composite FKs.
--
-- CHECKs:
--   dispatch_meters_nonneg_check:
--     Ensures meter readings are non-negative when present.
--     hobbs_out >= 0 AND tach_out >= 0 covers the mandatory OUT readings.
--     The _in columns are guarded only when non-NULL (they are NULL for
--     open/voided tickets).
--
--   dispatch_closed_shape_check:
--     Enforces the column-nullability invariant per status:
--       'closed'            → hobbs_in / tach_in / flight_time_hours
--                              / closed_by / closed_at must ALL be NOT NULL
--       'open' or 'voided'  → ALL five of those columns must be NULL
--     This check and the write-once meter discipline mean every row is
--     internally consistent without any UPDATE-based repair path.
--
--   NO in>=out CHECK: The "hobbs_in >= hobbs_out" invariant is enforced at
--     the API layer (closeDispatch ValidationError), NOT by a DB CHECK.
--     This keeps the meter-rollover decision open for a future compliance
--     ruling [VERIFY-A] (ADR-0007 §2, §4).

CREATE TABLE "dispatch_ticket" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"            uuid NOT NULL,
  "reservation_id"    uuid NOT NULL,
  "resource_id"       uuid NOT NULL,
  "pilot_user_id"     uuid NOT NULL,
  "status"            "dispatch_status" NOT NULL DEFAULT 'open',
  "hobbs_out"         numeric(10,1) NOT NULL,
  "tach_out"          numeric(10,1) NOT NULL,
  "hobbs_in"          numeric(10,1),
  "tach_in"           numeric(10,1),
  "flight_time_hours" numeric(10,1),
  "notes"             text,
  "opened_by"         uuid NOT NULL,
  "opened_at"         timestamptz NOT NULL DEFAULT now(),
  "closed_by"         uuid,
  "closed_at"         timestamptz,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "dispatch_ticket_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: dispatch record must reference a reservation in the same org.
  -- ON DELETE RESTRICT: prevents hard-deleting a reservation with dispatch records
  -- (dispatch is independent of reservation lifecycle — ADR-0007 §3).
  CONSTRAINT "dispatch_ticket_reservation_org_fk"
    FOREIGN KEY ("reservation_id", "org_id")
    REFERENCES "reservation"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: dispatch record must reference a resource in the same org.
  -- ON DELETE RESTRICT: prevents hard-deleting an aircraft with tickets.
  -- Soft-delete via resource.active = false is the preferred decommission path.
  CONSTRAINT "dispatch_ticket_resource_org_fk"
    FOREIGN KEY ("resource_id", "org_id")
    REFERENCES "resource"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: pilot must be a user in the same org.
  -- ON DELETE RESTRICT: prevents removing a pilot who has dispatch records
  -- without explicit cleanup (records integrity).
  CONSTRAINT "dispatch_ticket_pilot_org_fk"
    FOREIGN KEY ("pilot_user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: opener must be a user in the same org.
  -- ON DELETE RESTRICT: consistent with reservation.created_by pattern from 0002.
  CONSTRAINT "dispatch_ticket_opened_by_org_fk"
    FOREIGN KEY ("opened_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: closer must be a user in the same org (nullable column;
  -- FK only fires when closed_by IS NOT NULL — standard Postgres NULL-FK behaviour
  -- for composite FKs with a nullable leading column).
  -- ON DELETE SET NULL: if the closing user is deleted the audit trail is
  -- preserved as NULL rather than blocking deletion (mirrors reservation.cancelled_by).
  CONSTRAINT "dispatch_ticket_closed_by_org_fk"
    FOREIGN KEY ("closed_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE SET NULL,

  -- Composite candidate key — consumed by future composite FKs that may
  -- reference dispatch_ticket(id, org_id) (e.g. dispatch_ticket_correction).
  -- Mirrors the reservation / resource / reservation_series pattern.
  CONSTRAINT "dispatch_ticket_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Meter non-negativity: both OUT readings must be >= 0; IN readings must
  -- be >= 0 when present (they are NULL for open/voided tickets).
  CONSTRAINT "dispatch_meters_nonneg_check" CHECK (
    "hobbs_out" >= 0
    AND "tach_out" >= 0
    AND ("hobbs_in" IS NULL OR "hobbs_in" >= 0)
    AND ("tach_in" IS NULL OR "tach_in" >= 0)
  ),

  -- Closed-shape invariant: the _in columns plus closed_by/closed_at must all
  -- be populated together (when status='closed') or all be NULL (when
  -- status='open' or status='voided').
  --
  -- 'closed'           → five columns NOT NULL (hobbs_in, tach_in,
  --                       flight_time_hours, closed_by, closed_at)
  -- 'open' or 'voided' → those five columns all NULL
  --
  -- NO in>=out CHECK here — that is app-level validation in closeDispatch()
  -- so the meter-rollover decision remains open [VERIFY-A].
  CONSTRAINT "dispatch_closed_shape_check" CHECK (
    (
      "status" = 'closed'
      AND "hobbs_in" IS NOT NULL
      AND "tach_in" IS NOT NULL
      AND "flight_time_hours" IS NOT NULL
      AND "closed_by" IS NOT NULL
      AND "closed_at" IS NOT NULL
    )
    OR
    (
      "status" IN ('open', 'voided')
      AND "hobbs_in" IS NULL
      AND "tach_in" IS NULL
      AND "flight_time_hours" IS NULL
      AND "closed_by" IS NULL
      AND "closed_at" IS NULL
    )
  )
);


-- ── (3) Partial UNIQUE index — one open ticket per aircraft ───────────────────
--
-- THE ONE-OPEN BACKSTOP (ADR-0007 §2):
--
--   CREATE UNIQUE INDEX dispatch_ticket_one_open_per_resource
--     ON dispatch_ticket (resource_id) WHERE (status = 'open')
--
--   Semantics: no two rows with status='open' may share the same resource_id.
--   A second INSERT with status='open' on an already-out aircraft raises
--   error code 23505 (unique_violation). The API layer catches this, re-queries
--   for the existing open ticket, and returns {ok:false,reason:'already_open',
--   openTicketId} to the caller (ADR-0004 catch-and-map pattern).
--
--   'closed' and 'voided' rows are outside the WHERE predicate and do NOT
--   participate in this uniqueness check. A resource may have any number of
--   historical closed/voided tickets — only the current 'open' state is
--   constrained. A voided ticket frees the aircraft immediately; a new 'open'
--   ticket on the same resource is allowed after a void or close.
--
--   Org-safety (ADR-0004 §Org-scoping reused):
--   resource_id is globally unique to one org (composite FK on resource_id,org_id).
--   Two orgs' resources cannot share a resource_id, so cross-org false-blocks
--   are impossible — org_id is NOT in the index. RLS governs which rows a
--   session may touch; the index governs which rows may coexist in 'open' state.
--
--   No btree_gist needed: this is a simple equality uniqueness constraint (=),
--   not a range/overlap constraint. A plain partial btree index is the correct
--   and minimal backstop.

CREATE UNIQUE INDEX "dispatch_ticket_one_open_per_resource"
  ON "dispatch_ticket" ("resource_id")
  WHERE (status = 'open');


-- ── (4) Regular indexes ───────────────────────────────────────────────────────

-- Covers: getDispatchForReservation — WHERE org_id = $1 AND resource_id = ANY(...)
-- and board queries fetching tickets for an org's aircraft.
CREATE INDEX "dispatch_ticket_org_resource_idx"
  ON "dispatch_ticket" ("org_id", "resource_id");

-- Covers: getDispatchForReservation map build — WHERE org_id = $1
-- AND reservation_id = ANY(...)
CREATE INDEX "dispatch_ticket_org_reservation_idx"
  ON "dispatch_ticket" ("org_id", "reservation_id");


-- ── (5) ENABLE + FORCE RLS on dispatch_ticket ─────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "dispatch_ticket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispatch_ticket" FORCE  ROW LEVEL SECURITY;


-- ── (6) RLS policies ─────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
--
-- Every policy is named explicitly for auditability.
-- 4 policies: SELECT, INSERT, UPDATE, DELETE.
-- UPDATE is required for the status transitions (open→closed, open→voided);
-- records integrity (meter write-once) is held by the app single-write-path
-- + audit + the dispatch_closed_shape_check, NOT by blocking UPDATE at DB level.

CREATE POLICY "dispatch_ticket_select"
  ON "dispatch_ticket"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dispatch_ticket_insert"
  ON "dispatch_ticket"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dispatch_ticket_update"
  ON "dispatch_ticket"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dispatch_ticket_delete"
  ON "dispatch_ticket"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (7) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "dispatch_ticket" TO aeroops_app;
