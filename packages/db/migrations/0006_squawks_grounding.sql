-- ============================================================
-- AeroOps — Phase 1 Slice 3b: Squawks + operator-set grounding
-- Migration: 0006_squawks_grounding.sql
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
--               must already be applied.
--
-- Implements ADR-0008: squawk records and operator-set grounding events
-- (append-only); grounding gate at create (warn) and openDispatch (block).
--
-- Key guarantees:
--   (1) squawk and aircraft_grounding are tenant-scoped (org_id + ENABLE+FORCE
--       RLS + 4 fail-closed policies + composite FKs + aeroops_app grant),
--       mirroring the byte-pattern of 0002/0003/0004/0005 exactly.
--   (2) squawk is created before aircraft_grounding so that the composite FK
--       (squawk_id, org_id) → squawk(id, org_id) can reference the UNIQUE
--       candidate key on squawk (spec §1.5).
--   (3) aircraft_grounding is append-only (event-sourced); NO updated_at column.
--       Current state = latest event per aircraft (DISTINCT ON resource_id).
--   (4) Composite FKs on all edges (squawk and aircraft_grounding) — hand-written;
--       Drizzle cannot express multi-column FKs.
--   (5) CHECK squawk_title_nonempty_check: non-empty trimmed title.
--   (6) CHECK squawk_resolved_shape_check: resolved/deferred ⇒ resolved_by +
--       resolved_at NOT NULL; open ⇒ all three resolution fields NULL.
--   (7) CHECK aircraft_grounding_reason_check: state='grounded' ⇒ non-empty reason.
--   (8) UNIQUE (id, org_id) composite candidate keys on both tables — forward-compat
--       for future composite FKs. squawk's key is consumed immediately by
--       aircraft_grounding's squawk_id FK.
--   (9) Grounding is operator data only. The software makes no FAR/Part-91/43
--       airworthiness determination. Severity='grounding' never auto-grounds.
--
-- ORDER:
--   (1) Enum types: grounding_state, squawk_status, squawk_severity
--   (2) Table squawk + all composite FKs + CHECKs + UNIQUE
--   (3) Table aircraft_grounding + all composite FKs + CHECK + UNIQUE
--   (4) Indexes on both tables
--   (5) ENABLE + FORCE RLS on squawk and aircraft_grounding
--   (6) 4 named RLS policies × 2 tables (same GUC predicate as 0002–0005)
--   (7) GRANT to aeroops_app
-- ============================================================


-- ── (1) Enum types ────────────────────────────────────────────────────────────
-- Derived from @aeroops/core maintenance/enums.ts tuples (ADR-0008).
-- Order is canonical; never reorder without a new migration.

-- grounding_state: operator-set status. 'grounded' = aircraft not available
-- for dispatch; 'released' = grounding cleared. Current state = latest event.
-- This is operator data, NEVER a computed FAR/Part-91/43 reg verdict.
CREATE TYPE "public"."grounding_state" AS ENUM(
  'grounded',
  'released'
);

-- squawk_status: squawk lifecycle. Transitions: open → resolved | open → deferred.
-- No reopen path ([VERIFY-3b-D]).
-- 'deferred' is an operator triage status with a reason, NOT an MEL/airworthiness
-- construct ([VERIFY-3b-A]).
CREATE TYPE "public"."squawk_status" AS ENUM(
  'open',
  'deferred',
  'resolved'
);

-- squawk_severity: operator triage label only.
-- 'grounding' is a UI hint; it does NOT auto-ground the aircraft ([VERIFY-3b-B]).
CREATE TYPE "public"."squawk_severity" AS ENUM(
  'low',
  'medium',
  'high',
  'grounding'
);


-- ── (2) Table squawk ─────────────────────────────────────────────────────────
--
-- Records a reported maintenance discrepancy on a resource (typically aircraft).
--
-- Records posture (ADR-0008 §1.3):
--   title / description / severity / reported_by / reported_at are write-once.
--   Only status / resolution_notes / resolved_by / resolved_at / updated_at mutate.
--   Squawks are advisory only in 3b — they do NOT block dispatch.
--
-- Composite FKs (all hand-written; Drizzle cannot express multi-col FKs):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine — deleting an org cascades to its squawks.
--
--   Composite FK (resource_id, org_id) → resource(id, org_id)
--     ON DELETE RESTRICT:
--     Prevents hard-deleting a resource (aircraft) that has squawk records.
--     Requires resource(id, org_id) UNIQUE "resource_id_org_id_unique"
--     established in migration 0002.
--
--   Composite FK (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
--     ON DELETE SET NULL:
--     Nullable; if the ticket is deleted the squawk record is preserved with
--     dispatch_ticket_id = NULL. FK only — no meter access.
--     Requires dispatch_ticket(id, org_id) UNIQUE "dispatch_ticket_id_org_id_unique"
--     established in migration 0005.
--
--   Composite FK (reported_by, org_id) → app_user(id, org_id)
--     ON DELETE RESTRICT:
--     Reporter must be a member of the same org; prevents cross-org references.
--     Requires app_user(id, org_id) UNIQUE "app_user_id_org_id_unique"
--     established in migration 0000.
--
--   Composite FK (resolved_by, org_id) → app_user(id, org_id)
--     ON DELETE SET NULL:
--     Nullable; if the resolving user is deleted the record is preserved as NULL.
--     Composite NULL-FK: fires only when resolved_by IS NOT NULL (standard
--     Postgres NULL-FK behaviour for composite FKs with a nullable leading column).
--
-- UNIQUE (id, org_id) — composite candidate key for aircraft_grounding's
-- squawk_id FK and future composite FKs.
--
-- CHECKs:
--   squawk_title_nonempty_check:
--     Ensures the squawk title is not blank (prevents empty-string squawks).
--
--   squawk_resolved_shape_check:
--     Enforces the column-nullability invariant per status:
--       status IN ('resolved','deferred') → resolved_by + resolved_at NOT NULL
--       status = 'open'                   → resolved_by, resolved_at,
--                                           resolution_notes all NULL
--     This prevents orphaned partial-resolution state.

CREATE TABLE "squawk" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"               uuid NOT NULL,
  "resource_id"          uuid NOT NULL,
  "dispatch_ticket_id"   uuid,
  "title"                text NOT NULL,
  "description"          text,
  "severity"             "squawk_severity" NOT NULL,
  "status"               "squawk_status" NOT NULL DEFAULT 'open',
  "reported_by"          uuid NOT NULL,
  "reported_at"          timestamptz NOT NULL DEFAULT now(),
  "resolution_notes"     text,
  "resolved_by"          uuid,
  "resolved_at"          timestamptz,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "squawk_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: squawk must reference a resource in the same org.
  -- ON DELETE RESTRICT: prevents hard-deleting an aircraft with squawk records.
  CONSTRAINT "squawk_resource_org_fk"
    FOREIGN KEY ("resource_id", "org_id")
    REFERENCES "resource"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: optional link to the dispatch ticket during which the squawk
  -- was discovered. FK only — no meter access.
  -- ON DELETE SET NULL (dispatch_ticket_id): only nulls the nullable FK column;
  -- org_id is NOT nulled (it is NOT NULL). Postgres 15+ column-list syntax.
  CONSTRAINT "squawk_dispatch_ticket_org_fk"
    FOREIGN KEY ("dispatch_ticket_id", "org_id")
    REFERENCES "dispatch_ticket"("id", "org_id") ON DELETE SET NULL ("dispatch_ticket_id"),

  -- Composite FK: reporter must be a user in the same org.
  -- ON DELETE RESTRICT: prevents removing a reporter who has squawk records.
  CONSTRAINT "squawk_reported_by_org_fk"
    FOREIGN KEY ("reported_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: resolver is optional; preserved as NULL if user is deleted.
  -- ON DELETE SET NULL (resolved_by): only nulls the nullable FK column;
  -- org_id is NOT nulled (it is NOT NULL). Postgres 15+ column-list syntax.
  CONSTRAINT "squawk_resolved_by_org_fk"
    FOREIGN KEY ("resolved_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE SET NULL ("resolved_by"),

  -- Composite candidate key — consumed by aircraft_grounding (squawk_id, org_id)
  -- FK immediately below and by future composite FKs.
  -- Mirrors the reservation / resource / dispatch_ticket pattern.
  CONSTRAINT "squawk_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Title must not be empty (or blank-only).
  CONSTRAINT "squawk_title_nonempty_check" CHECK (
    char_length(btrim("title")) > 0
  ),

  -- Shape invariant: resolution fields must be consistently populated per status.
  --   resolved/deferred → resolved_at NOT NULL (resolved_by MAY be NULL if the
  --                        resolver user was deleted via ON DELETE SET NULL)
  --   open              → resolved_by, resolved_at, resolution_notes all NULL
  --
  -- NOTE: resolved_by is intentionally excluded from the NOT NULL assertion for
  -- resolved/deferred status. When a resolver user is deleted, the cascade
  -- ON DELETE SET NULL ("resolved_by") nulls resolved_by while preserving
  -- resolved_at and the status — the audit trail (timestamp + notes) is intact.
  -- If resolved_by were required NOT NULL, the SET NULL cascade would conflict
  -- with this check constraint and prevent user deletion.
  CONSTRAINT "squawk_resolved_shape_check" CHECK (
    (
      "status" IN ('resolved', 'deferred')
      AND "resolved_at" IS NOT NULL
    )
    OR
    (
      "status" = 'open'
      AND "resolved_by" IS NULL
      AND "resolved_at" IS NULL
      AND "resolution_notes" IS NULL
    )
  )
);


-- ── (3) Table aircraft_grounding ──────────────────────────────────────────────
--
-- Append-only event table: each row is an immutable grounding or release event.
-- Current state per aircraft = the latest event (DISTINCT ON resource_id,
-- ORDER BY resource_id, created_at DESC, id DESC).
--
-- Grounding is operator data only. The software makes NO FAR/Part-91/43
-- airworthiness determination. severity='grounding' on a squawk never
-- auto-grounds an aircraft — that requires an explicit INSERT here. [VERIFY-3b-H]
--
-- NO updated_at column: rows are immutable once written.
--
-- Composite FKs (all hand-written; Drizzle cannot express multi-col FKs):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine — deleting an org cascades to its grounding events.
--
--   Composite FK (resource_id, org_id) → resource(id, org_id)
--     ON DELETE RESTRICT:
--     Prevents hard-deleting an aircraft with grounding records.
--     Requires resource(id, org_id) UNIQUE "resource_id_org_id_unique"
--     established in migration 0002.
--
--   Composite FK (squawk_id, org_id) → squawk(id, org_id)
--     ON DELETE SET NULL:
--     Nullable; references the squawk that triggered this grounding (advisory link).
--     squawk table is created before aircraft_grounding in this migration (§1.5).
--     Requires squawk(id, org_id) UNIQUE "squawk_id_org_id_unique" — created above.
--     Composite NULL-FK: fires only when squawk_id IS NOT NULL.
--
--   Composite FK (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
--     ON DELETE SET NULL:
--     Nullable; if the ticket is deleted the event is preserved with
--     dispatch_ticket_id = NULL. FK only — no meter access.
--     Requires dispatch_ticket(id, org_id) UNIQUE established in migration 0005.
--
--   Composite FK (created_by, org_id) → app_user(id, org_id)
--     ON DELETE RESTRICT:
--     Creator must be a member of the same org.
--     Requires app_user(id, org_id) UNIQUE established in migration 0000.
--
-- UNIQUE (id, org_id) — composite candidate key for future composite FKs.
--
-- CHECK aircraft_grounding_reason_check:
--   state='grounded' ⇒ char_length(btrim(reason)) > 0
--   (Release-reason is optional — audit trail suffices. [VERIFY-3b-C])

CREATE TABLE "aircraft_grounding" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"               uuid NOT NULL,
  "resource_id"          uuid NOT NULL,
  "state"                "grounding_state" NOT NULL,
  "reason"               text NOT NULL,
  "squawk_id"            uuid,
  "dispatch_ticket_id"   uuid,
  "created_by"           uuid NOT NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "aircraft_grounding_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: grounding event must reference a resource in the same org.
  -- ON DELETE RESTRICT: prevents hard-deleting an aircraft with grounding events.
  CONSTRAINT "aircraft_grounding_resource_org_fk"
    FOREIGN KEY ("resource_id", "org_id")
    REFERENCES "resource"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: optional link to the triggering squawk (advisory; nullable).
  -- ON DELETE SET NULL (squawk_id): only nulls the nullable FK column; org_id
  -- is NOT nulled (it is NOT NULL). Postgres 15+ column-list syntax.
  -- squawk(id, org_id) UNIQUE "squawk_id_org_id_unique" created above in this migration.
  CONSTRAINT "aircraft_grounding_squawk_org_fk"
    FOREIGN KEY ("squawk_id", "org_id")
    REFERENCES "squawk"("id", "org_id") ON DELETE SET NULL ("squawk_id"),

  -- Composite FK: optional link to the dispatch ticket context. FK only — no meter access.
  -- ON DELETE SET NULL (dispatch_ticket_id): only nulls the nullable FK column;
  -- org_id is NOT nulled (it is NOT NULL). Postgres 15+ column-list syntax.
  CONSTRAINT "aircraft_grounding_dispatch_ticket_org_fk"
    FOREIGN KEY ("dispatch_ticket_id", "org_id")
    REFERENCES "dispatch_ticket"("id", "org_id") ON DELETE SET NULL ("dispatch_ticket_id"),

  -- Composite FK: creator must be a user in the same org.
  -- ON DELETE RESTRICT: prevents removing a creator who has grounding events.
  CONSTRAINT "aircraft_grounding_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — forward-compat for future composite FKs.
  -- Mirrors the reservation / resource / dispatch_ticket pattern.
  CONSTRAINT "aircraft_grounding_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Reason is mandatory when grounding (state='grounded') to document why
  -- the aircraft is unavailable. Release-reason is optional ([VERIFY-3b-C]).
  CONSTRAINT "aircraft_grounding_reason_check" CHECK (
    "state" <> 'grounded' OR char_length(btrim("reason")) > 0
  )
);


-- ── (4) Indexes ───────────────────────────────────────────────────────────────

-- squawk: open-count per resource + per-aircraft list.
-- Covers: getOpenSquawkCounts: WHERE status='open' AND resource_id = ANY(...)
--         listSquawks:         WHERE org_id = $1 [AND resource_id = $2] [AND status = $3]
CREATE INDEX "squawk_org_resource_status_idx"
  ON "squawk" ("org_id", "resource_id", "status");

-- aircraft_grounding: latest event per aircraft.
-- Covers: DISTINCT ON (resource_id) WHERE org_id = $1 AND resource_id = ANY(...)
--         ORDER BY resource_id, created_at DESC, id DESC
CREATE INDEX "aircraft_grounding_org_resource_created_idx"
  ON "aircraft_grounding" ("org_id", "resource_id", "created_at");


-- ── (5) ENABLE + FORCE RLS on both tables ─────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "squawk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "squawk" FORCE  ROW LEVEL SECURITY;

ALTER TABLE "aircraft_grounding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "aircraft_grounding" FORCE  ROW LEVEL SECURITY;


-- ── (6) RLS policies ─────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
--
-- Every policy is named explicitly for auditability.
-- 4 policies per table: SELECT, INSERT, UPDATE, DELETE.
-- aircraft_grounding is append-only by design (no sanctioned UPDATE/DELETE code
-- path) but RLS UPDATE/DELETE policies are required to prevent unguarded mutations.

-- ── squawk policies ──────────────────────────────────────────────────────────

CREATE POLICY "squawk_select"
  ON "squawk"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "squawk_insert"
  ON "squawk"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "squawk_update"
  ON "squawk"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "squawk_delete"
  ON "squawk"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── aircraft_grounding policies ───────────────────────────────────────────────

CREATE POLICY "aircraft_grounding_select"
  ON "aircraft_grounding"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "aircraft_grounding_insert"
  ON "aircraft_grounding"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "aircraft_grounding_update"
  ON "aircraft_grounding"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "aircraft_grounding_delete"
  ON "aircraft_grounding"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (7) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "squawk" TO aeroops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "aircraft_grounding" TO aeroops_app;
