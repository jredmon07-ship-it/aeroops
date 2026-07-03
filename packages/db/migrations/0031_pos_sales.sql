-- ============================================================
-- AeroOps — Slice P2: POS / Counter Sales
-- Migration: 0031_pos_sales.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0030_documents.sql
--               must already be applied.
--
-- COMPLIANCE (records posture): product_catalog is an operator-defined price
-- list of non-flight goods and services (headsets, charts, fuel,
-- merchandise). unit_price_cents and every counter-sale amount are INTEGER
-- CENTS — never floats. A counter sale is an operator billing RECORD: it
-- creates a draft invoice via the EXISTING B1 invoice write path and moves
-- NO money by itself — money moves only if the invoice is later finalized
-- and charged through the existing, unchanged P0 Stripe/autopay path (PCI
-- SAQ-A; NO raw card/bank data is ever stored). This slice computes NO tax
-- and makes NO tax determination — category and sku are FREE-TEXT operator
-- labels, not tax classes; sales-tax handling, inventory-on-hand, and
-- card-present (Stripe Terminal) capture are DEFERRED (P3). No FAA/
-- airworthiness determination is involved. [VERIFY-P2-A]: sales-tax
-- collection/remittance posture is out of scope here and must be resolved
-- by compliance before tax lines ship.
--
-- Implements P2: sell non-flight catalog items (headsets, charts, fuel,
-- merch) via a counter sale that rides the EXISTING B1 invoice /
-- invoice_line_item write path — a counter sale is just a draft invoice
-- whose lines are catalog/ad-hoc items instead of dispatch-derived ones.
--
--   product_catalog — one row per operator-defined sellable item.
--     Standard 4-policy mutable RLS (mirrors rate_schedule/document):
--     name/price/sku/category/active are all mutable via
--     updateProductCatalogItem; rows may also be hard-deleted
--     (deleteProductCatalogItem) since invoice_line_item snapshots the
--     name+price at sale time and holds NO FK back to product_catalog.
--
-- Key guarantees:
--   (1) product_catalog is tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS
--       + 4 fail-closed policies (byte-identical NULLIF predicate, copied
--       verbatim from 0030) + grants to aeroops_app.
--   (2) Composite FKs (hand-written; Drizzle cannot express multi-column FKs):
--         (org_id) → org(id) ON DELETE CASCADE.
--         (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT —
--           write-once attribution (mirrors rate_schedule.created_by /
--           document.uploaded_by).
--   (3) unit_price_cents is INTEGER CENTS, CHECK > 0 — never a float. A
--       counter sale's per-line total is computed by the pure
--       computeCounterSaleLineTotal (packages/core) as an EXACT integer
--       product (quantity × unitPriceCents) — no rounding, no float step.
--   (4) NO FK from invoice_line_item back to product_catalog — a sale's
--       lines SNAPSHOT the catalog item's name+price at sale time (exactly
--       like generate-invoice.ts snapshots a rate_schedule's amount), so a
--       later price change or a hard-delete of the catalog item never
--       retroactively alters a historical sale.
--   (5) NO raw card/bank data anywhere in this table or any command built on
--       top of it. NO money is moved by this migration or the commands that
--       write to this table — see COMPLIANCE paragraph above.
--   (6) UNIQUE (id, org_id) composite candidate key — consistent with all
--       other tenant tables.
--   (7) STRICTLY ADDITIVE — no existing tables/columns/constraints modified.
--       Only the one new table is created.
--
-- ORDER within this file:
--   (1) CREATE TABLE product_catalog (FKs + CHECKs + UNIQUE)
--   (2) Indexes
--   (3) ENABLE + FORCE RLS
--   (4) RLS policies (standard 4-policy pattern)
--   (5) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE product_catalog ───────────────────────────────────────────────

CREATE TABLE "product_catalog" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"            uuid NOT NULL,
  "name"              text NOT NULL,
  "unit_price_cents"  integer NOT NULL,
  "sku"               text,
  "category"          text,
  "active"            boolean NOT NULL DEFAULT true,
  "created_by"        uuid NOT NULL,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "product_catalog_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: creator must be a member of the same org. Write-once
  -- attribution (mirrors rate_schedule_created_by_org_fk / document_uploaded_by_org_fk).
  -- Requires app_user(id, org_id) UNIQUE "app_user_id_org_id_unique"
  -- established in migration 0000.
  CONSTRAINT "product_catalog_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "product_catalog_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- name must not be empty (or blank-only).
  CONSTRAINT "product_catalog_name_nonempty_check" CHECK (
    char_length(btrim("name")) > 0
  ),

  -- unit_price_cents must be a positive integer — INTEGER CENTS, never a float.
  CONSTRAINT "product_catalog_unit_price_positive_check" CHECK (
    "unit_price_cents" > 0
  )
);


-- ── (2) Indexes ──────────────────────────────────────────────────────────────

-- Covers: active-items list queries.
-- e.g. listProductCatalogItems: WHERE org_id=$1 AND active=true ORDER BY name
CREATE INDEX "product_catalog_org_active_name_idx"
  ON "product_catalog" ("org_id", "active", "name");


-- ── (3) ENABLE + FORCE RLS ───────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "product_catalog" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "product_catalog" FORCE   ROW LEVEL SECURITY;


-- ── (4) RLS policies (standard 4-policy pattern) ────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)

CREATE POLICY "product_catalog_select"
  ON "product_catalog"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "product_catalog_insert"
  ON "product_catalog"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "product_catalog_update"
  ON "product_catalog"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "product_catalog_delete"
  ON "product_catalog"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (5) GRANT to aeroops_app ─────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "product_catalog" TO aeroops_app;
