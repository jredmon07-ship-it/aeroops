-- ============================================================
-- AeroOps — Slice P0-REV: Payment methods + auto-pay opt-in
-- Migration: 0024_payment_methods_autopay.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0023_stripe_foundation.sql
--               must already be applied.
--
-- Implements P0-REV part 1+2: saved payment methods (SetupIntent-backed) and
-- per-member auto-pay opt-in. Builds on the Stripe seam-to-the-key-boundary
-- (migration 0023) — NO real Stripe call is ever made until STRIPE_SECRET_KEY
-- is set; every command routes through the stub-when-unconfigured StripeClient.
--
--   stripe_payment_method — a saved instrument, DISPLAY fields only. NEVER a
--     PAN/CVV/account/routing number — only Stripe's own ids + Stripe-returned
--     last4/brand (PCI SAQ-A, same posture as stripe_customer, migration 0023).
--   autopay_setting       — one row per member: explicit opt-in (enabled) +
--     default saved payment method. Auto-pay NEVER fires without BOTH.
--
-- Key guarantees:
--   (1) Both tables are tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS +
--       the standard 4-policy pattern (mirrors migration 0022/0023).
--   (2) stripe_payment_method.stripe_payment_method_id is UNIQUE (global —
--       Stripe ids are globally unique) — the idempotency backstop across the
--       TWO paths that can record a saved PM (the confirm-callback
--       saveMyPaymentMethod AND the setup_intent.succeeded webhook): whichever
--       INSERT lands first wins; the second is a no-op via ON CONFLICT DO NOTHING.
--   (3) autopay_setting.(org_id, user_id) is UNIQUE — one setting row per
--       member per org (the upsert target for setMyAutopay).
--   (4) STRUCTURAL GUARANTEE (not just application-checked): CHECK
--       autopay_enabled_requires_pm — enabled=true REQUIRES a non-null
--       default_payment_method_id. A row can never be inserted/updated into
--       an "armed but PM-less" state, even by a bug in the command layer.
--   (5) NEVER stores raw card/bank data — this migration has NO PAN, CVV,
--       account/routing-number, or similar column anywhere. Only
--       Stripe-permitted DISPLAY fields (last4/type/brand) are stored.
--   (6) Composite FKs are all hand-written (Drizzle cannot express multi-col
--       FKs). Named constraints follow the {table}_{fk_col}_org_fk convention.
--   (7) autopay_setting.default_payment_method_id → stripe_payment_method
--       is ON DELETE RESTRICT: a saved PM referenced by an active autopay
--       setting cannot be silently orphaned. (No DELETE command is built in
--       this slice; this is a structural backstop for a future one.)
--   (8) POLICY ADDITION on the PRE-EXISTING stripe_customer table (migration
--       0023): stripe_customer_select is DROPPED and RECREATED to
--       additionally admit platform-admin context, mirroring
--       payment_intent_record_select's exact precedent (migration 0023) — the
--       setup_intent.succeeded webhook (an unauthenticated Stripe callback)
--       needs to resolve which org owns a given stripe_customer_id BEFORE any
--       org GUC can be set. READ-ONLY: every WRITE policy on stripe_customer
--       (UPDATE/INSERT/DELETE) stays org-GUC-only, unchanged from 0023.
--       Migration 0023's own file is NOT edited — this is an additive policy
--       change layered on in this migration, exactly like how 0022 added an
--       additive column to dispatch_config (a pre-existing table) rather than
--       editing an earlier migration file.
--   (9) STRICTLY ADDITIVE otherwise — no existing tables/columns/constraints
--       modified beyond the one documented policy replacement in (8).
--  (10) NO money MOVES in this migration or in any code that only reads/
--       writes these tables without live Stripe keys.
--
-- ORDER within this file:
--   (1) CREATE TABLE stripe_payment_method (FKs + UNIQUE + CHECK)
--   (2) CREATE TABLE autopay_setting (FKs + UNIQUE + shape CHECK)
--   (3) Indexes
--   (4) ENABLE + FORCE RLS (2 new tables)
--   (5) RLS policies (2 new tables)
--   (6) GRANT to aeroops_app (2 new tables)
--   (7) stripe_customer_select policy replacement (platform-admin read, §8)
-- ============================================================


-- ── (1) TABLE stripe_payment_method ───────────────────────────────────────────
--
-- A saved payment instrument (card or US bank account), recorded either from
-- the portal confirm-callback (saveMyPaymentMethod) or the setup_intent.
-- succeeded webhook — whichever lands first; the UNIQUE on
-- stripe_payment_method_id makes the second attempt a harmless no-op.
--
-- Composite FKs (all hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT:
--     The saved PM's owner must be a user in the same org.
--     Targets app_user_id_org_id_unique (migration 0000).
--
-- UNIQUE (stripe_payment_method_id): Stripe payment-method ids are globally
--   unique — the idempotency backstop for "have we already recorded this PM".
-- UNIQUE (id, org_id): composite candidate key, consumed by
--   autopay_setting(default_payment_method_id, org_id) below.

CREATE TABLE "stripe_payment_method" (
  "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"                      uuid NOT NULL,
  "user_id"                     uuid NOT NULL,
  "stripe_customer_id"          text NOT NULL,
  "stripe_payment_method_id"    text NOT NULL,
  "type"                        text NOT NULL,
  "last4"                       text,
  "brand"                       text,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "stripe_payment_method_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the PM's owner must be a user in the same org.
  -- ON DELETE RESTRICT: preserves the Stripe linkage record.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "stripe_payment_method_user_org_fk"
    FOREIGN KEY ("user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Stripe payment-method ids are globally unique (Stripe's own id space).
  -- The idempotency backstop across the confirm-callback vs webhook race.
  CONSTRAINT "stripe_payment_method_stripe_id_unique"
    UNIQUE ("stripe_payment_method_id"),

  -- Composite candidate key — consumed by
  -- autopay_setting(default_payment_method_id, org_id).
  CONSTRAINT "stripe_payment_method_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  CONSTRAINT "stripe_payment_method_stripe_id_nonempty_check" CHECK (
    char_length(btrim("stripe_payment_method_id")) > 0
  ),

  -- Instrument type domain.
  CONSTRAINT "stripe_payment_method_type_check" CHECK (
    "type" IN ('card', 'us_bank_account')
  )
);


-- ── (2) TABLE autopay_setting ─────────────────────────────────────────────────
--
-- One row per member: explicit opt-in (enabled) + a default saved payment
-- method. Auto-pay (triggerAutopayOnFinalize) NEVER fires unless BOTH
-- enabled=true AND default_payment_method_id references a saved PM — enforced
-- structurally by the shape CHECK below, not merely by the command layer.
--
-- Composite FKs (all hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT:
--     The setting's member must be a user in the same org.
--     Targets app_user_id_org_id_unique (migration 0000).
--
--   Composite FK (default_payment_method_id, org_id) →
--     stripe_payment_method(id, org_id) ON DELETE RESTRICT:
--     Nullable — NULL when autopay is off/never configured. When present, the
--     PM must exist in the same org. RESTRICT: a saved PM armed as someone's
--     default cannot be silently deleted out from under them (no DELETE
--     command exists on stripe_payment_method in this slice; this is a
--     forward-looking structural backstop).
--     Targets stripe_payment_method_id_org_id_unique (created above).
--
-- UNIQUE (org_id, user_id): exactly one autopay setting per member per org —
--   the upsert target for setMyAutopay (INSERT ... ON CONFLICT (org_id,
--   user_id) DO UPDATE).
--
-- CHECK autopay_enabled_requires_pm — THE STRUCTURAL GUARANTEE: enabled=true
--   REQUIRES default_payment_method_id IS NOT NULL. A row can never be
--   inserted/updated into an "armed but PM-less" state.

CREATE TABLE "autopay_setting" (
  "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"                      uuid NOT NULL,
  "user_id"                     uuid NOT NULL,
  "enabled"                     boolean NOT NULL DEFAULT false,
  "default_payment_method_id"   uuid,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "autopay_setting_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the setting's member must be a user in the same org.
  -- ON DELETE RESTRICT: preserves billing configuration history.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "autopay_setting_user_org_fk"
    FOREIGN KEY ("user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: the default PM (when set) must be a saved PM in the same org.
  -- ON DELETE RESTRICT: a PM armed as a default cannot be silently orphaned.
  -- Targets stripe_payment_method_id_org_id_unique (created above, same migration).
  CONSTRAINT "autopay_setting_default_pm_org_fk"
    FOREIGN KEY ("default_payment_method_id", "org_id")
    REFERENCES "stripe_payment_method"("id", "org_id") ON DELETE RESTRICT,

  -- One autopay setting per member per org — the upsert target.
  CONSTRAINT "autopay_setting_org_user_unique"
    UNIQUE ("org_id", "user_id"),

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "autopay_setting_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- THE STRUCTURAL GUARANTEE: autopay cannot be armed without a saved PM.
  CONSTRAINT "autopay_enabled_requires_pm" CHECK (
    "enabled" = false OR "default_payment_method_id" IS NOT NULL
  )
);


-- ── (3) Indexes ───────────────────────────────────────────────────────────────

-- stripe_payment_method: per-member saved-PM lookup (setMyAutopay validation,
-- getMemberBillingProfile, getMyBilling).
CREATE INDEX "stripe_payment_method_org_user_idx"
  ON "stripe_payment_method" ("org_id", "user_id");

-- autopay_setting: per-member lookup (triggerAutopayOnFinalize, getMyBilling,
-- getMemberBillingProfile). UNIQUE (org_id,user_id) above already provides an
-- index for exact-match lookups; no additional index needed here.


-- ── (4) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "stripe_payment_method" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "stripe_payment_method" FORCE   ROW LEVEL SECURITY;

ALTER TABLE "autopay_setting"       ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "autopay_setting"       FORCE   ROW LEVEL SECURITY;


-- ── (5) RLS policies ──────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)

-- ── stripe_payment_method policies (standard 4-policy pattern) ────────────────
-- NOTE: unlike payment_intent_record/stripe_customer, this table's webhook
-- write path (setup_intent.succeeded) resolves org via resolveOrgByStripe
-- CustomerId → stripe_customer (which itself gets the platform-admin SELECT
-- branch in §7 below) and then writes via withOrgContext(orgId, ...) — the
-- GUC IS set for that write, so stripe_payment_method's INSERT policy stays
-- plain org-GUC-only (no platform-admin branch needed here).

CREATE POLICY "stripe_payment_method_select"
  ON "stripe_payment_method"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "stripe_payment_method_insert"
  ON "stripe_payment_method"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "stripe_payment_method_update"
  ON "stripe_payment_method"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "stripe_payment_method_delete"
  ON "stripe_payment_method"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── autopay_setting policies (standard 4-policy pattern) ──────────────────────

CREATE POLICY "autopay_setting_select"
  ON "autopay_setting"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "autopay_setting_insert"
  ON "autopay_setting"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "autopay_setting_update"
  ON "autopay_setting"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "autopay_setting_delete"
  ON "autopay_setting"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (6) GRANT to aeroops_app ───────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "stripe_payment_method" TO aeroops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "autopay_setting"       TO aeroops_app;


-- ── (7) stripe_customer_select policy replacement (platform-admin read) ───────
-- Mirrors payment_intent_record_select's EXACT precedent (migration 0023 §6):
-- the setup_intent.succeeded webhook handler needs a sanctioned platform-admin
-- read to resolve which org owns a given stripe_customer_id BEFORE any org GUC
-- can be set (an unauthenticated Stripe callback carries no AeroOps session).
-- See integrations/stripe/resolve-payment-customer.ts (resolveOrgByStripe
-- CustomerId) — READ-ONLY, single-row, fixed projection. Every WRITE policy
-- on stripe_customer (UPDATE/INSERT/DELETE) is UNCHANGED from migration 0023 —
-- still org-GUC-only. This is the ONLY statement in this migration that
-- touches a pre-existing (migration 0023) table's policy.

DROP POLICY "stripe_customer_select" ON "stripe_customer";

CREATE POLICY "stripe_customer_select"
  ON "stripe_customer"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'on'
  );
