-- ============================================================
-- AeroOps — Slice B4: Block-time / prepaid packages
-- Migration: 0034_block_time.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0033_mobile_session.sql
--               must already be applied.
--
-- COMPLIANCE (records posture): "block time" (THE-BIBLE glossary) is a
-- prepaid, discounted hour bundle a member buys up front and draws down as
-- they fly. This slice records OPERATOR BILLING DATA on the EXISTING B2
-- ledger — exactly like recordManualPayment (billing/record-manual-payment.ts)
-- — it is NOT tax/GAAP/FAA guidance and makes NO airworthiness/currency
-- determination. price_cents/amount_cents are INTEGER CENTS — never floats.
-- hours is numeric(10,1) — the SAME flight-hour granularity already used by
-- invoice_line_item.quantity_hours / dispatch_ticket meters — and is NOT
-- money. NO Stripe, NO card/bank data, NO money-boundary crossing: a block
-- sale posts ONE ledger_entry credit exactly like a manual payment; no
-- payment is ever processed here.
--
-- [DEFERRED — v1 scope, see docs/specs/slice-b4-block-time.md]: hours-based
-- per-flight discounted-rate drawdown (v1 tracks drawdown ONLY via the
-- existing derived ledger balance — the "prepaid credit" mental model already
-- documented in billing/ledger-math.ts — NOT a per-flight hour meter), block
-- expiry/refund, family/shared blocks, selling a block through the Stripe
-- rail (money-boundary, founder-gated).
--
--   block_package  — operator-defined prepaid-hour offering (e.g. "10-hour
--     Archer block"). The effective discounted rate (price_cents / hours) is
--     DISPLAY ONLY, computed by the application layer — never stored.
--   block_purchase — a member bought a block (either from a package, or an
--     ad-hoc hours+amount sale). APPEND-ONLY — a purchase is immutable; a
--     mistake is corrected with a reversing credit_memo (forward seam), never
--     an edit.
--
-- Key guarantees:
--   (1) block_package is tenant-scoped + MUTABLE (ENABLE+FORCE RLS + the
--       standard 4-policy SELECT/INSERT/UPDATE/DELETE pattern) — byte-
--       identical to product_catalog (migration 0031): this is master data
--       (a reusable price list), not a billing record. A block_purchase
--       SNAPSHOTS hours+amount_cents at sale time and holds NO FK back that
--       would let a later package edit retroactively alter a historical sale
--       (package_id is a nullable REFERENCE for reporting only).
--   (2) block_purchase is tenant-scoped + APPEND-ONLY: ENABLE+FORCE RLS +
--       SELECT + INSERT policies ONLY (mirrors ledger_entry / dispatch_ticket_
--       correction / audit_log). GRANT is SELECT + INSERT only; REVOKE UPDATE,
--       DELETE is an explicit belt-and-suspenders backstop.
--   (3) ledger_entry.entry_type CHECK is ADDITIVELY extended with
--       'block_purchase' — a block sale posts a DISTINCT credit entry_type
--       (rather than reusing 'payment') so reporting/AR can tell a prepaid
--       block sale apart from an ad-hoc manual payment or a Stripe-verified
--       payment. This is the SAME table/column touched by migration 0022 —
--       the constraint is DROPPED and RECREATED with the wider domain (no
--       data is touched; safe because no 'block_purchase' rows can exist
--       before this migration runs). The down-migration restores the
--       ORIGINAL (migration-0022) domain — safe ONLY if no 'block_purchase'
--       ledger_entry rows exist yet, which is why every down-migration in
--       this repo is human-gated/manual, never auto-run.
--   (4) Composite FKs are all hand-written (Drizzle cannot express multi-col
--       FKs). Named constraints follow the {table}_{fk_col}_org_fk convention.
--   (5) price_cents / amount_cents are INTEGER CENTS, CHECK > 0 — NEVER a
--       float. hours is numeric(10,1), CHECK > 0 — a QUANTITY, NOT money
--       (mirrors invoice_line_item.quantity_hours precedent exactly).
--   (6) UNIQUE (id, org_id) composite candidate key on both tables —
--       consistent with all other tenant tables.
--   (7) STRICTLY ADDITIVE — no existing table/column is dropped or narrowed;
--       the ONE existing-column touch (ledger_entry.entry_type CHECK) only
--       WIDENS the allowed domain.
--
-- ORDER within this file:
--   (1) CREATE TABLE block_package (FKs + CHECKs + UNIQUE)
--   (2) CREATE TABLE block_purchase (FKs + CHECKs + UNIQUE)
--   (3) ALTER TABLE ledger_entry — widen entry_type CHECK to add 'block_purchase'
--   (4) Indexes
--   (5) ENABLE + FORCE RLS (2 tables)
--   (6) RLS policies
--   (7) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE block_package ──────────────────────────────────────────────────

CREATE TABLE "block_package" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"      uuid NOT NULL,
  "name"        text NOT NULL,
  "hours"       numeric(10, 1) NOT NULL,
  "price_cents" integer NOT NULL,
  "active"      boolean NOT NULL DEFAULT true,
  "created_by"  uuid NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "block_package_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: creator must be a member of the same org. Write-once
  -- attribution (mirrors product_catalog_created_by_org_fk / rate_schedule_created_by_org_fk).
  CONSTRAINT "block_package_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all other tenant tables;
  -- consumed by block_purchase(package_id, org_id) composite FK below.
  CONSTRAINT "block_package_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- name must not be empty (or blank-only).
  CONSTRAINT "block_package_name_nonempty_check" CHECK (
    char_length(btrim("name")) > 0
  ),

  -- hours is a QUANTITY (not money) — must be strictly positive.
  CONSTRAINT "block_package_hours_positive_check" CHECK (
    "hours" > 0
  ),

  -- price_cents is INTEGER CENTS — must be strictly positive.
  CONSTRAINT "block_package_price_positive_check" CHECK (
    "price_cents" > 0
  )
);


-- ── (2) TABLE block_purchase ─────────────────────────────────────────────────
--
-- APPEND-ONLY (see (2) in the file header). A member's block purchase is
-- SNAPSHOTTED here (hours + amount_cents at sale time) — package_id is a
-- nullable reference for reporting ONLY; a later package edit or the absence
-- of a package (an ad-hoc sale) never alters a historical purchase row.

CREATE TABLE "block_purchase" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"       uuid NOT NULL,
  "user_id"      uuid NOT NULL,
  "package_id"   uuid,
  "hours"        numeric(10, 1) NOT NULL,
  "amount_cents" integer NOT NULL,
  "note"         text,
  "created_by"   uuid NOT NULL,
  "purchased_at" timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "block_purchase_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the buyer must be a user in the same org. RESTRICT
  -- preserves billing history (mirrors billing_account_user_org_fk).
  CONSTRAINT "block_purchase_user_org_fk"
    FOREIGN KEY ("user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: the package (when present) must be in the same org.
  -- Nullable — NULL for an ad-hoc (non-package) sale. RESTRICT preserves the
  -- link between a historical sale and the package it was sold from.
  -- Targets block_package_id_org_id_unique (created above in this migration).
  CONSTRAINT "block_purchase_package_org_fk"
    FOREIGN KEY ("package_id", "org_id")
    REFERENCES "block_package"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: the staff member who processed the sale must be in the
  -- same org. RESTRICT preserves attribution on an immutable record.
  CONSTRAINT "block_purchase_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "block_purchase_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- hours is a QUANTITY (not money) — must be strictly positive.
  CONSTRAINT "block_purchase_hours_positive_check" CHECK (
    "hours" > 0
  ),

  -- amount_cents is INTEGER CENTS — must be strictly positive.
  CONSTRAINT "block_purchase_amount_positive_check" CHECK (
    "amount_cents" > 0
  )
);


-- ── (3) ALTER TABLE ledger_entry — widen entry_type CHECK ────────────────────
--
-- Additively extends the entry_type domain (migration 0022) with
-- 'block_purchase' — see (3) in the file header for why a block sale posts a
-- DISTINCT credit entry_type rather than reusing 'payment'. DROP + RECREATE
-- is the only way to widen a CHECK constraint's domain in Postgres; this is
-- safe because no 'block_purchase' row can exist before this migration runs
-- (the OLD constraint would have rejected it).

ALTER TABLE "ledger_entry"
  DROP CONSTRAINT "ledger_entry_entry_type_check";

ALTER TABLE "ledger_entry"
  ADD CONSTRAINT "ledger_entry_entry_type_check" CHECK (
    "entry_type" IN ('invoice_finalized', 'payment', 'credit_memo', 'adjustment', 'block_purchase')
  );


-- ── (4) Indexes ───────────────────────────────────────────────────────────────

-- block_package: covers the active-packages list query.
-- e.g. listBlockPackages: WHERE org_id=$1 AND active=true ORDER BY name
CREATE INDEX "block_package_org_active_name_idx"
  ON "block_package" ("org_id", "active", "name");

-- block_purchase: covers a member's purchase history, newest first.
-- e.g. getMemberBlockSummary: WHERE org_id=$1 AND user_id=$2 ORDER BY purchased_at DESC
CREATE INDEX "block_purchase_org_user_purchased_idx"
  ON "block_purchase" ("org_id", "user_id", "purchased_at" DESC);


-- ── (5) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "block_package"  ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "block_package"  FORCE   ROW LEVEL SECURITY;

ALTER TABLE "block_purchase" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "block_purchase" FORCE   ROW LEVEL SECURITY;


-- ── (6) RLS policies ──────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)

-- ── block_package policies (standard 4-policy pattern, mirrors product_catalog) ──

CREATE POLICY "block_package_select"
  ON "block_package"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "block_package_insert"
  ON "block_package"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "block_package_update"
  ON "block_package"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "block_package_delete"
  ON "block_package"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── block_purchase policies — APPEND-ONLY (SELECT + INSERT only) ─────────────
-- Mirrors ledger_entry (0022) / dispatch_ticket_correction (0018) exactly: no
-- UPDATE or DELETE policy. With FORCE ROW LEVEL SECURITY, the absence of a
-- permissive policy blocks those operations for ALL roles, including the
-- table owner — the structural guarantee that a block purchase is immutable
-- once inserted. Corrections are new reversing entries (credit_memo, forward
-- seam), never an edit.

CREATE POLICY "block_purchase_select"
  ON "block_purchase"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "block_purchase_insert"
  ON "block_purchase"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (7) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "block_package" TO aeroops_app;

GRANT SELECT, INSERT ON "block_purchase" TO aeroops_app;
REVOKE UPDATE, DELETE ON "block_purchase" FROM aeroops_app;
