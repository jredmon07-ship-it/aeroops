-- ============================================================
-- AeroOps — Slice B1: Billing record tables
-- Migration: 0019_billing_records.sql
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
--               + 0012_training.sql + 0013_work_orders.sql
--               + 0014_availability.sql + 0015_booking_request.sql
--               + 0016_booking_request_convert.sql
--               + 0017_booking_retention.sql
--               + 0018_dispatch_ticket_correction.sql
--               must already be applied.
--
-- Implements Slice B1: operator billing record tables.
--   rate_schedule — operator-defined pricing rates.
--   invoice       — billing invoices for members.
--   invoice_line_item — individual charge lines on an invoice.
--
-- Key guarantees:
--   (1) All three tables are tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS
--       + 4 named policies (SELECT/INSERT/UPDATE/DELETE) each — fail-closed
--       via NULLIF GUC predicate (identical to 0018 pattern).
--   (2) GRANT SELECT,INSERT,UPDATE,DELETE TO aeroops_app on all three tables.
--   (3) Money is INTEGER CENTS (amount_cents, subtotal_cents, total_cents,
--       unit_amount_cents, line_total_cents). NEVER floats. quantity_hours is
--       numeric(10,1) — a QUANTITY counter, not money; mirrors dispatch meters.
--   (4) Composite FKs are all hand-written (Drizzle cannot express multi-col FKs).
--       Named constraints follow the {table}_{fk_col}_org_fk convention.
--   (5) UNIQUE(id, org_id) composite candidate key on all three tables —
--       consistent with every other tenant table; forward-compat for composite FKs.
--   (6) STRICTLY ADDITIVE — no existing tables, columns, or constraints modified.
--       Only the three new tables are created.
--   (7) NO Stripe/card columns. NO payment processing. NO FAA/airworthiness
--       determination. Operator billing RECORDS only.
--   (8) Creation order: rate_schedule → invoice → invoice_line_item.
--       invoice_line_item references both invoice AND rate_schedule; both must
--       exist before invoice_line_item is created.
--
-- [VERIFY-B-MONEY-1]: derived flight time (Hobbs basis from dispatch_ticket)
--   becomes the billable unit; confirm with compliance before Phase-2 goes live.
-- [VERIFY-B2-PORTAL]: renter self-scope (intra-org) on invoice SELECT must be
--   adversarially tested before portal invoice view is exposed.
-- [VERIFY-B-PRICING-GROUP]: pricing_group table (B1 optional) deferred; the
--   rate_schedule.resource_id nullable covers the default-rate use-case.
-- Part-141 retention carried from ADR-0007 [VERIFY-C]: confirm retention period
--   for billing records before Phase-2 billing goes live.
--
-- ORDER within this file:
--   (1) CREATE TABLE rate_schedule (FKs + CHECKs + UNIQUE)
--   (2) CREATE TABLE invoice (FKs + CHECKs + UNIQUE)
--   (3) CREATE TABLE invoice_line_item (FKs + CHECKs + UNIQUE)
--   (4) Indexes (3 tables)
--   (5) ENABLE + FORCE RLS (3 tables)
--   (6) RLS policies — 4 per table (SELECT/INSERT/UPDATE/DELETE)
--   (7) GRANT SELECT,INSERT,UPDATE,DELETE TO aeroops_app (3 tables)
-- ============================================================


-- ── (1) TABLE rate_schedule ───────────────────────────────────────────────────
--
-- Operator-defined pricing rates. amount_cents = INTEGER cents (NEVER float).
-- resource_id nullable: NULL = org-wide default rate; NOT NULL = per-aircraft.
--
-- Composite FKs (all hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT:
--     Nullable (applied only when resource_id IS NOT NULL via deferrable check
--     is NOT available in PG CHECK; FK still fires on non-null values).
--     Prevents hard-deleting an aircraft that has rate schedule records.
--     Targets resource_id_org_id_unique (migration 0002).
--
--   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT:
--     Creator must be a member of the same org. Preserves creation attribution.
--     Targets app_user_id_org_id_unique (migration 0000).
--
-- CHECKs:
--   rate_schedule_name_nonempty_check: char_length(btrim(name)) > 0
--   rate_schedule_rate_kind_check: rate_kind IN (...)
--   rate_schedule_amount_nonneg_check: amount_cents >= 0
--   rate_schedule_effective_range_check: effective_to IS NULL OR effective_to > effective_from

CREATE TABLE "rate_schedule" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"           uuid NOT NULL,
  "resource_id"      uuid,
  "name"             text NOT NULL,
  "rate_kind"        text NOT NULL,
  "amount_cents"     integer NOT NULL,
  "effective_from"   timestamptz NOT NULL,
  "effective_to"     timestamptz,
  "created_by"       uuid NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "rate_schedule_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: rate must reference a resource in the same org (when non-null).
  -- ON DELETE RESTRICT: prevents hard-deleting an aircraft with rate history.
  -- Targets resource_id_org_id_unique established in migration 0002.
  CONSTRAINT "rate_schedule_resource_org_fk"
    FOREIGN KEY ("resource_id", "org_id")
    REFERENCES "resource"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: creator must be a user in the same org.
  -- ON DELETE RESTRICT: preserves creation attribution.
  -- Targets app_user_id_org_id_unique established in migration 0000.
  CONSTRAINT "rate_schedule_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all tenant tables;
  -- consumed by invoice_line_item(rate_schedule_id, org_id) composite FK.
  CONSTRAINT "rate_schedule_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Name must be non-empty.
  CONSTRAINT "rate_schedule_name_nonempty_check" CHECK (
    char_length(btrim("name")) > 0
  ),

  -- Rate kind must be one of the four defined values.
  CONSTRAINT "rate_schedule_rate_kind_check" CHECK (
    "rate_kind" IN ('wet_hourly', 'dry_hourly', 'instruction', 'flat')
  ),

  -- Amount must be non-negative integer cents.
  CONSTRAINT "rate_schedule_amount_nonneg_check" CHECK (
    "amount_cents" >= 0
  ),

  -- Effective range: open-ended (NULL) is valid; if bounded, end > start.
  CONSTRAINT "rate_schedule_effective_range_check" CHECK (
    "effective_to" IS NULL OR "effective_to" > "effective_from"
  )
);


-- ── (2) TABLE invoice ─────────────────────────────────────────────────────────
--
-- Billing invoice for a member. subtotal_cents + total_cents = INTEGER cents.
-- dispatch_ticket_id nullable: the source flight (when invoice is from a dispatch).
-- invoice_finalized_shape_check: status='finalized' ⇒ issued_at IS NOT NULL.
--
-- Composite FKs (all hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (member_user_id, org_id) → app_user(id, org_id)
--     ON DELETE RESTRICT:
--     Member must be a user in the same org. Prevents deleting a user with invoices
--     (records integrity).
--     Targets app_user_id_org_id_unique (migration 0000).
--
--   Composite FK (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
--     ON DELETE RESTRICT:
--     Nullable (fires on non-null values). Prevents deleting a dispatch ticket that
--     has an invoice (records integrity).
--     Targets dispatch_ticket_id_org_id_unique (migration 0005).
--
--   Composite FK (created_by, org_id) → app_user(id, org_id)
--     ON DELETE RESTRICT:
--     Creator must be a member of the same org. Preserves creation attribution.
--     Targets app_user_id_org_id_unique (migration 0000).
--
-- CHECKs:
--   invoice_status_check: status IN ('draft','finalized','void')
--   invoice_subtotal_nonneg_check: subtotal_cents >= 0
--   invoice_total_nonneg_check: total_cents >= 0
--   invoice_finalized_shape_check: status = 'finalized' ⇒ issued_at IS NOT NULL

CREATE TABLE "invoice" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"               uuid NOT NULL,
  "member_user_id"       uuid NOT NULL,
  "status"               text NOT NULL DEFAULT 'draft',
  "subtotal_cents"       integer NOT NULL DEFAULT 0,
  "total_cents"          integer NOT NULL DEFAULT 0,
  "dispatch_ticket_id"   uuid,
  "issued_at"            timestamptz,
  "created_by"           uuid NOT NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "invoice_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: member must be a user in the same org.
  -- ON DELETE RESTRICT: preserves billing records when a user would be deleted.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "invoice_member_user_org_fk"
    FOREIGN KEY ("member_user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: dispatch ticket must be in the same org (when non-null).
  -- ON DELETE RESTRICT: preserves invoice linkage integrity.
  -- Targets dispatch_ticket_id_org_id_unique (migration 0005).
  CONSTRAINT "invoice_dispatch_ticket_org_fk"
    FOREIGN KEY ("dispatch_ticket_id", "org_id")
    REFERENCES "dispatch_ticket"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: creator must be a user in the same org.
  -- ON DELETE RESTRICT: preserves creation attribution.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "invoice_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all tenant tables;
  -- consumed by invoice_line_item(invoice_id, org_id) composite FK.
  CONSTRAINT "invoice_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Status must be one of the three defined values.
  CONSTRAINT "invoice_status_check" CHECK (
    "status" IN ('draft', 'finalized', 'void')
  ),

  -- Amounts must be non-negative integer cents.
  CONSTRAINT "invoice_subtotal_nonneg_check" CHECK (
    "subtotal_cents" >= 0
  ),

  CONSTRAINT "invoice_total_nonneg_check" CHECK (
    "total_cents" >= 0
  ),

  -- Finalized invoices must have issued_at set.
  -- draft and void may have issued_at NULL.
  CONSTRAINT "invoice_finalized_shape_check" CHECK (
    "status" <> 'finalized' OR "issued_at" IS NOT NULL
  )
);


-- ── (3) TABLE invoice_line_item ───────────────────────────────────────────────
--
-- Individual charge line on an invoice. quantity_hours = numeric(10,1) (quantity
-- counter, NOT money). unit_amount_cents + line_total_cents = INTEGER cents.
-- rate_schedule_id nullable: links to the rate used (when from a rate schedule).
-- Amounts are snapshotted at creation — later rate changes do not affect history.
--
-- Composite FKs (all hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (invoice_id, org_id) → invoice(id, org_id) ON DELETE RESTRICT:
--     Line items must belong to an invoice in the same org. Prevents hard-deleting
--     an invoice that has line items (command layer voids, not deletes).
--     Targets invoice_id_org_id_unique (created above in this migration).
--
--   Composite FK (rate_schedule_id, org_id) → rate_schedule(id, org_id)
--     ON DELETE RESTRICT:
--     Nullable (fires on non-null values). Prevents hard-deleting a rate schedule
--     referenced by historical line items (billing history must be preserved).
--     Targets rate_schedule_id_org_id_unique (created above in this migration).
--
-- CHECKs:
--   invoice_line_item_description_nonempty_check: char_length(btrim(description)) > 0
--   invoice_line_item_quantity_nonneg_check: quantity_hours >= 0
--   invoice_line_item_unit_amount_nonneg_check: unit_amount_cents >= 0
--   invoice_line_item_line_total_nonneg_check: line_total_cents >= 0

CREATE TABLE "invoice_line_item" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"             uuid NOT NULL,
  "invoice_id"         uuid NOT NULL,
  "description"        text NOT NULL,
  "quantity_hours"     numeric(10,1) NOT NULL,
  "unit_amount_cents"  integer NOT NULL,
  "line_total_cents"   integer NOT NULL,
  "rate_schedule_id"   uuid,
  "created_at"         timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "invoice_line_item_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: line item must reference an invoice in the same org.
  -- ON DELETE RESTRICT: command layer voids invoices rather than deleting them.
  -- Targets invoice_id_org_id_unique (created above in migration 0019).
  CONSTRAINT "invoice_line_item_invoice_org_fk"
    FOREIGN KEY ("invoice_id", "org_id")
    REFERENCES "invoice"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: rate schedule must be in the same org (when non-null).
  -- ON DELETE RESTRICT: preserves billing history when a rate would be deleted.
  -- Targets rate_schedule_id_org_id_unique (created above in migration 0019).
  CONSTRAINT "invoice_line_item_rate_schedule_org_fk"
    FOREIGN KEY ("rate_schedule_id", "org_id")
    REFERENCES "rate_schedule"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all tenant tables.
  CONSTRAINT "invoice_line_item_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Description must be non-empty.
  CONSTRAINT "invoice_line_item_description_nonempty_check" CHECK (
    char_length(btrim("description")) > 0
  ),

  -- Quantity must be non-negative (numeric(10,1) flight hours).
  CONSTRAINT "invoice_line_item_quantity_nonneg_check" CHECK (
    "quantity_hours" >= 0
  ),

  -- Unit amount must be non-negative integer cents.
  CONSTRAINT "invoice_line_item_unit_amount_nonneg_check" CHECK (
    "unit_amount_cents" >= 0
  ),

  -- Line total must be non-negative integer cents.
  CONSTRAINT "invoice_line_item_line_total_nonneg_check" CHECK (
    "line_total_cents" >= 0
  )
);


-- ── (4) Indexes ───────────────────────────────────────────────────────────────

-- rate_schedule: rate-lookup queries (list rates for org [and aircraft]).
-- e.g. WHERE org_id=$1 [AND resource_id=$2]
--        AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
CREATE INDEX "rate_schedule_org_resource_idx"
  ON "rate_schedule" ("org_id", "resource_id");

-- invoice: list-by-status with created_at ordering.
-- e.g. listInvoices: WHERE org_id=$1 [AND status=$2] ORDER BY created_at DESC
CREATE INDEX "invoice_org_status_created_idx"
  ON "invoice" ("org_id", "status", "created_at" DESC);

-- invoice: per-member invoice history.
-- e.g. getMemberInvoices: WHERE org_id=$1 AND member_user_id=$2
CREATE INDEX "invoice_org_member_idx"
  ON "invoice" ("org_id", "member_user_id");

-- invoice_line_item: fetch all line items for an invoice.
-- e.g. getInvoiceLineItems: WHERE org_id=$1 AND invoice_id=$2
CREATE INDEX "invoice_line_item_org_invoice_idx"
  ON "invoice_line_item" ("org_id", "invoice_id");


-- ── (5) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "rate_schedule"      ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "rate_schedule"      FORCE   ROW LEVEL SECURITY;

ALTER TABLE "invoice"            ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "invoice"            FORCE   ROW LEVEL SECURITY;

ALTER TABLE "invoice_line_item"  ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "invoice_line_item"  FORCE   ROW LEVEL SECURITY;


-- ── (6) RLS policies — 4 per table (SELECT/INSERT/UPDATE/DELETE) ──────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)
--
-- All four CRUD operations are gated by the same GUC predicate so that
-- multi-tenant-safe application code (withOrgContext) is the only write path.
-- This mirrors the 4-policy pattern from migrations 0002–0017 (excluding
-- audit_log / dispatch_ticket_correction which are SELECT+INSERT only).

-- ── rate_schedule policies ────────────────────────────────────────────────────

CREATE POLICY "rate_schedule_select"
  ON "rate_schedule"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "rate_schedule_insert"
  ON "rate_schedule"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "rate_schedule_update"
  ON "rate_schedule"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "rate_schedule_delete"
  ON "rate_schedule"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── invoice policies ──────────────────────────────────────────────────────────

CREATE POLICY "invoice_select"
  ON "invoice"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "invoice_insert"
  ON "invoice"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "invoice_update"
  ON "invoice"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "invoice_delete"
  ON "invoice"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── invoice_line_item policies ────────────────────────────────────────────────

CREATE POLICY "invoice_line_item_select"
  ON "invoice_line_item"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "invoice_line_item_insert"
  ON "invoice_line_item"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "invoice_line_item_update"
  ON "invoice_line_item"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "invoice_line_item_delete"
  ON "invoice_line_item"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (7) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.
--
-- Full CRUD grants (billing records require all four operations via the
-- command layer: create drafts, update status/totals, void, read).

GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_schedule"     TO aeroops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice"           TO aeroops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_line_item" TO aeroops_app;
