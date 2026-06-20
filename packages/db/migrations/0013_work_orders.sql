-- ============================================================
-- AeroOps — Slice M1.1: Maintenance Work Orders Foundation (work_order)
-- Migration: 0013_work_orders.sql
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
--               + 0012_training.sql
--               must already be applied.
--
-- Adds the Slice M1.1 (Maintenance Work Orders / ADR-0012) data-model delta:
--   (1) CREATE TYPE work_order_status
--   (2) CREATE TABLE work_order + named composite FKs + 2 CHECKs
--
-- HARD COMPLIANCE LINE (all regulation-adjacent surfaces):
-- NO computed FAA/Part-43/airworthiness determination of ANY kind. A work
-- order, its sign-off, and 'completed' status are OPERATOR DATA / data entry.
-- The software computes/asserts NO airworthiness, return-to-service
-- (§43.9/§43.11), AD compliance, inspection currency (annual/100-hr/§91.409),
-- or MEL status. "Sign-off" is a recorded operator action (free-text), NOT an
-- A&P/IA certification or e-signature. Ungrounding (M1.2) is an explicit
-- operator action (affirmative checkbox), never a computed clearance.
--
-- [VERIFY-M1-A] (HARD COMPLIANCE LINE): 'completed' is an operator content-
-- state flag ONLY. It is NOT an FAA return-to-service, §43.9 logbook entry,
-- §43.11 maintenance release, or airworthiness determination.
--
-- [VERIFY-M1-B] (HARD COMPLIANCE LINE): no reopen path. completed and
-- cancelled are terminal states. Confirm this posture is acceptable.
--
-- [VERIFY-M1-C] (HARD COMPLIANCE LINE): signed_off_by is an application user
-- FK, NOT a cryptographic signature or Part-43 regulatory sign-off. The column
-- is ON DELETE SET NULL ("signed_off_by") — column-list syntax nulls ONLY
-- signed_off_by; org_id (NOT NULL) is preserved. The durable "who signed" lives
-- in audit_log, NOT this column. Any Phase-4+ consumer attaching Part-43/A&P/IA
-- meaning must preserve signer identity immutably (soft-delete users, or
-- snapshot signer — mirrors the squawk.resolved_by note in ADR-0008).
--
-- [VERIFY-M1-D] (HARD COMPLIANCE LINE): unground (M1.2 orchestration, NOT in
-- this migration) is an explicit operator action (affirmative checkbox in
-- completeWorkOrder). The rule guard (matching grounding basis) is an operator-
-- convenience check, not a computed airworthiness clearance.
--
-- [VERIFY-M1-E]: open work orders surface on the fleet detail page gated to
-- fleet:access. Confirm the set of roles intended to see WOs in fleet context.
--
-- Key guarantees:
--   (1) work_order: org_id NOT NULL, ENABLE+FORCE RLS, 4 fail-closed named
--       policies, aeroops_app GRANT (ADR-0001 + migration-0012 byte-pattern).
--   (2) All composite FKs are hand-written (Drizzle cannot express multi-col FKs).
--   (3) Column-list SET NULL syntax: ON DELETE SET NULL ("squawk_id") and
--       ON DELETE SET NULL ("signed_off_by") null ONLY those columns, never
--       org_id. Mirrors lesson_record.voided_by fix in migration 0012.
--   (4) NO one-open partial-UNIQUE: multiple open WOs per aircraft are legitimate.
--   (5) NO money column anywhere. work_performed/sign_off_notes are free-text only.
--   (6) M1 reads NO dispatch meters (dispatch-correction-table-predecessor governs).
--   (7) STRICTLY ADDITIVE — no existing tables, columns, or constraints modified.
--
-- ORDER:
--   (1)  CREATE TYPE work_order_status
--   (2)  CREATE TABLE work_order + 5 named FKs + 2 CHECKs
--   (3)  CREATE UNIQUE INDEX work_order_id_org_id_unique
--   (4)  CREATE INDEX work_order_org_resource_status_idx
--   (5)  CREATE INDEX work_order_org_squawk_idx
--   (6)  ENABLE + FORCE RLS on work_order; 4 named policies; GRANT
-- ============================================================


-- ── (1) CREATE TYPE work_order_status ────────────────────────────────────────
-- Derived from @aeroops/core WORK_ORDER_STATUSES tuple (ADR-0012 / Slice M1.1).
-- Four values: 'open' (created), 'in_progress' (work underway), 'completed'
-- (sign-off recorded; terminal — completed ≠ RTS [VERIFY-M1-A]), 'cancelled'
-- (abandoned; terminal — no reopen [VERIFY-M1-B]).
-- Valid transitions (API-enforced): open→in_progress | open→completed |
--   open→cancelled | in_progress→completed | in_progress→cancelled.

CREATE TYPE "work_order_status" AS ENUM ('open', 'in_progress', 'completed', 'cancelled');


-- ── (2) CREATE TABLE work_order ───────────────────────────────────────────────
--
-- Maintenance task on an aircraft (or other resource). Optionally linked to a
-- squawk on the SAME aircraft (enforced at openWorkOrder; never cross-aircraft).
--
-- Records posture:
--   resource_id / squawk_id / title / description / opened_by / opened_at are
--   write-once (set at INSERT, never mutated by any code path).
--   work_performed is mutable while open/in_progress; write-once once completed
--   or cancelled.
--   status, signed_off_by/at/notes, cancelled_reason/at, updated_at may change
--   via the guarded API transitions.
--
-- work_performed / sign_off_notes are FREE-TEXT operator data. The software
-- computes NO airworthiness, RTS, AD, or MEL status from them. [VERIFY-M1-A]
--
-- Composite FKs (hand-written; Drizzle cannot express multi-column FKs):
--
--   FK (org_id) → org(id) ON DELETE CASCADE  [work_order_org_id_fk]
--     Tenant spine — deleting an org cascades to its work orders.
--
--   Composite FK (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT
--     [work_order_resource_org_fk]
--     Aircraft must exist in the same org. Hard-delete blocked while work orders
--     exist (records integrity). Requires resource_id_org_id_unique (migration 0002).
--
--   Composite FK (squawk_id, org_id) → squawk(id, org_id)
--     ON DELETE SET NULL ("squawk_id")  [work_order_squawk_org_fk]
--     Nullable. Column-list syntax: only squawk_id is nulled; org_id preserved.
--     Requires squawk_id_org_id_unique (migration 0006).
--
--   Composite FK (opened_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--     [work_order_opened_by_org_fk]
--     Write-once attribution. Requires app_user_id_org_id_unique (migration 0000).
--
--   Composite FK (signed_off_by, org_id) → app_user(id, org_id)
--     ON DELETE SET NULL ("signed_off_by")  [work_order_signed_off_by_org_fk]
--     Nullable (NULL when open/in_progress). Column-list syntax: only signed_off_by
--     is nulled; org_id preserved. [VERIFY-M1-C]: NOT an e-signature.
--     Requires app_user_id_org_id_unique (migration 0000).
--
-- CHECKs:
--   work_order_title_nonempty_check: char_length(btrim(title)) > 0
--
--   work_order_completed_shape_check (mirrors squawk_resolved_shape_check):
--     status = 'completed'              ⇒ signed_off_at IS NOT NULL
--     status = 'cancelled'              ⇒ cancelled_at IS NOT NULL
--     status IN ('open', 'in_progress') ⇒
--       signed_off_by IS NULL AND signed_off_at IS NULL AND sign_off_notes IS NULL
--       AND cancelled_reason IS NULL AND cancelled_at IS NULL
--   (signed_off_by intentionally NOT required non-null in the 'completed' arm:
--   it is ON DELETE SET NULL; identity may be nulled on a user hard-delete.
--   signed_off_at + sign_off_notes persist; durable "who" lives in audit_log.)
--
-- UNIQUEs (indexes below):
--   work_order_id_org_id_unique UNIQUE (id, org_id) — composite candidate key.
--   NO one-open partial-UNIQUE: multiple open WOs per aircraft are legitimate.

CREATE TABLE "work_order" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"           uuid NOT NULL,
  "resource_id"      uuid NOT NULL,
  "squawk_id"        uuid,
  "title"            text NOT NULL,
  "description"      text,
  "status"           work_order_status NOT NULL DEFAULT 'open',
  "work_performed"   text,
  "opened_by"        uuid NOT NULL,
  "opened_at"        timestamptz NOT NULL DEFAULT now(),
  "signed_off_by"    uuid,
  "signed_off_at"    timestamptz,
  "sign_off_notes"   text,
  "cancelled_reason" text,
  "cancelled_at"     timestamptz,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "work_order_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: aircraft must exist in the same org.
  -- ON DELETE RESTRICT: records integrity — hard-delete blocked while WOs exist.
  -- Targets resource_id_org_id_unique from migration 0002.
  CONSTRAINT "work_order_resource_org_fk"
    FOREIGN KEY ("resource_id", "org_id")
    REFERENCES "resource"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: linked squawk must be in the same org (same aircraft enforced at API).
  -- ON DELETE SET NULL ("squawk_id"): column-list syntax nulls ONLY squawk_id;
  -- org_id (NOT NULL) is preserved. Mirrors lesson_record_voided_by_org_fk (0012).
  -- Targets squawk_id_org_id_unique from migration 0006.
  CONSTRAINT "work_order_squawk_org_fk"
    FOREIGN KEY ("squawk_id", "org_id")
    REFERENCES "squawk"("id", "org_id") ON DELETE SET NULL ("squawk_id"),

  -- Composite FK: opener must be a user in the same org.
  -- ON DELETE RESTRICT: write-once attribution; preserves creation record.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "work_order_opened_by_org_fk"
    FOREIGN KEY ("opened_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: signer is nullable; SET NULL on user hard-delete.
  -- Column-list syntax ON DELETE SET NULL ("signed_off_by") nulls ONLY signed_off_by;
  -- org_id (NOT NULL) is preserved. [VERIFY-M1-C]: NOT an e-signature or Part-43
  -- sign-off. The durable "who signed" lives in audit_log, NOT this column.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "work_order_signed_off_by_org_fk"
    FOREIGN KEY ("signed_off_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE SET NULL ("signed_off_by"),

  -- Title must not be empty (or blank-only). UI trims before sending.
  CONSTRAINT "work_order_title_nonempty_check" CHECK (
    char_length(btrim("title")) > 0
  ),

  -- Shape invariant (mirrors squawk_resolved_shape_check in migration 0006):
  --   status = 'completed'              ⇒ signed_off_at IS NOT NULL
  --   status = 'cancelled'              ⇒ cancelled_at IS NOT NULL
  --   status IN ('open', 'in_progress') ⇒ sign-off + cancellation cols all NULL
  -- signed_off_by intentionally NOT in the NOT NULL arm (SET NULL on user delete).
  CONSTRAINT "work_order_completed_shape_check" CHECK (
    (
      "status" = 'completed'
      AND "signed_off_at" IS NOT NULL
      AND "cancelled_at" IS NULL
      AND "cancelled_reason" IS NULL
    ) OR (
      "status" = 'cancelled'
      AND "cancelled_at" IS NOT NULL
      AND "signed_off_at" IS NULL
      AND "signed_off_by" IS NULL
      AND "sign_off_notes" IS NULL
    ) OR (
      "status" IN ('open', 'in_progress')
      AND "signed_off_by" IS NULL
      AND "signed_off_at" IS NULL
      AND "sign_off_notes" IS NULL
      AND "cancelled_reason" IS NULL
      AND "cancelled_at" IS NULL
    )
  )
);


-- ── (3) UNIQUE (id, org_id) on work_order ────────────────────────────────────
-- Composite candidate key — forward-compat for future composite FKs and
-- consistent with all other tenant tables.

CREATE UNIQUE INDEX "work_order_id_org_id_unique"
  ON "work_order" ("id", "org_id");


-- ── (4) Index (org_id, resource_id, status) on work_order ────────────────────
-- Covers: open-count per resource + per-aircraft list queries + fleet detail.
-- e.g. listWorkOrders: WHERE org_id=$1 [AND resource_id=$2] [AND status=$3]
--      assembleAircraftDetail openWorkOrders: WHERE org_id=$1 AND resource_id=$2
--        AND status='open' ORDER BY created_at DESC LIMIT 10

CREATE INDEX "work_order_org_resource_status_idx"
  ON "work_order" ("org_id", "resource_id", "status");


-- ── (5) Index (org_id, squawk_id) on work_order ──────────────────────────────
-- Covers: squawk-linked WO lookup.
-- e.g. WHERE org_id=$1 AND squawk_id=$2 (getWorkOrderDetail join)

CREATE INDEX "work_order_org_squawk_idx"
  ON "work_order" ("org_id", "squawk_id");


-- ── (6) ENABLE + FORCE RLS on work_order; 4 named policies; GRANT ─────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "work_order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_order" FORCE  ROW LEVEL SECURITY;

-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
-- Byte-identical to 0012 (training) and 0009 (dispatch_gate) patterns.

CREATE POLICY "work_order_select"
  ON "work_order"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "work_order_insert"
  ON "work_order"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "work_order_update"
  ON "work_order"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "work_order_delete"
  ON "work_order"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "work_order" TO aeroops_app;
