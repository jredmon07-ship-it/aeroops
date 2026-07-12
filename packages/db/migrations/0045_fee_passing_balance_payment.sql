-- ============================================================
-- AeroOps — Fee-passing toggle + balance-payment records
-- Migration: 0045_fee_passing_balance_payment.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0044_dispatch_service_log.sql must
--               already be applied.
--
-- CONTEXT: two additive money features cashing in the 1%-capped-$15 ACH
-- pricing, both OFF/inert until this migration is applied AND (for real
-- charges) Stripe keys are configured:
--
--   (1) FEE-PASSING TOGGLE — a per-org boolean on the existing dispatch_config
--       row: `pass_ach_fee_to_member`. DEFAULT false → byte-identical existing
--       behavior. When true, the portal quotes invoice/balance payments GROSSED
--       UP by min(round(base × 1%), $15). The fee is the platform's (carried in
--       Stripe PaymentIntent metadata); the ledger credit still posts the BASE
--       only — the real fee split activates with Stripe Connect later.
--
--   (2) balance_payment — a record of a Stripe PaymentIntent that pays down a
--       member's LEDGER BALANCE directly (not a specific invoice). Mirrors
--       payment_intent_record's shape + RLS posture (incl. the ONE sanctioned
--       platform-admin SELECT for the webhook resolver), but keyed to a
--       (org, member) rather than an invoice — a balance payment has no invoice.
--       The webhook posts ONE 'payment' credit for amount_cents; invoice rows
--       are untouched (statement semantics — a balance payment naturally zeroes
--       a negative balance).
--
-- Key guarantees:
--   (a) STRICTLY ADDITIVE — one new column on dispatch_config (with a DEFAULT so
--       existing rows need no backfill) + one new table. No existing table,
--       column, constraint, index, policy, or grant is modified or dropped.
--   (b) The FROZEN dispatch gate (openDispatch) reads dispatch_config via an
--       EXPLICIT column projection (loadDispatchConfig) that does NOT select the
--       new column — the gate is byte-identical. No money concept enters the gate.
--   (c) balance_payment is tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS +
--       the standard 4-policy pattern, EXCEPT balance_payment_select ADDITIONALLY
--       permits platform-admin context (mirrors payment_intent_record_select) —
--       the ONE sanctioned platform-admin read for the unauthenticated webhook
--       resolver (resolveBalancePaymentByStripePaymentIntentId). Every WRITE
--       policy stays org-GUC-only.
--   (d) NEVER stores raw card/bank data — Stripe's own ids + integer cents only
--       (PCI SAQ-A).
--
-- ORDER within this file:
--   (1) ALTER dispatch_config ADD COLUMN pass_ach_fee_to_member
--   (2) CREATE TABLE balance_payment (FKs + CHECKs + UNIQUEs)
--   (3) Indexes
--   (4) ENABLE + FORCE RLS
--   (5) RLS policies
--   (6) GRANT to aeroops_app
-- ============================================================


-- ── (1) dispatch_config.pass_ach_fee_to_member ────────────────────────────────
-- Per-org opt-in: pass the ACH processing fee through to the member at checkout.
-- DEFAULT false → existing rows and all existing reads are unaffected.

ALTER TABLE "dispatch_config"
  ADD COLUMN "pass_ach_fee_to_member" boolean NOT NULL DEFAULT false;


-- ── (2) TABLE balance_payment ─────────────────────────────────────────────────
--
-- Our record of a Stripe PaymentIntent that pays down a member's ledger balance
-- directly (kind = 'balance_payment' in the PI metadata). Unlike
-- payment_intent_record, it is keyed to a (org, member) and carries NO invoice
-- link — a balance payment is not tied to any single invoice.
--
--   amount_cents — the BASE amount credited to the member's ledger on success
--     (the balance magnitude the member chose to pay). NEVER independently
--     trusted for settlement: only a verified payment_intent.succeeded webhook
--     posts the ledger credit.
--   fee_cents    — the pass-through processing fee ADDED at charge time when
--     fee-passing is on (0 otherwise). INFORMATIONAL — it is the platform's,
--     carried in Stripe metadata; it is NOT credited to the member's ledger.
--
-- Composite FKs (all hand-written):
--   FK (org_id) → org(id) ON DELETE CASCADE — tenant spine.
--   Composite FK (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT —
--     the paying member must be a user in the same org.
--     Targets app_user_id_org_id_unique (migration 0000).
--
-- UNIQUE (stripe_payment_intent_id): Stripe PaymentIntent ids are globally
--   unique — the idempotency backstop for "have we already recorded this PI".

CREATE TABLE "balance_payment" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"                   uuid NOT NULL,
  "user_id"                  uuid NOT NULL,
  "stripe_payment_intent_id" text NOT NULL,
  "amount_cents"             integer NOT NULL,
  "fee_cents"                integer NOT NULL DEFAULT 0,
  "status"                   text NOT NULL DEFAULT 'pending',
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "balance_payment_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the paying member must be a user in the same org.
  -- ON DELETE RESTRICT: preserves the payment linkage record.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "balance_payment_user_org_fk"
    FOREIGN KEY ("user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Stripe PaymentIntent ids are globally unique (Stripe's own id space).
  CONSTRAINT "balance_payment_stripe_pi_unique"
    UNIQUE ("stripe_payment_intent_id"),

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "balance_payment_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  CONSTRAINT "balance_payment_pi_id_nonempty_check" CHECK (
    char_length(btrim("stripe_payment_intent_id")) > 0
  ),

  CONSTRAINT "balance_payment_amount_positive_check" CHECK (
    "amount_cents" > 0
  ),

  CONSTRAINT "balance_payment_fee_nonneg_check" CHECK (
    "fee_cents" >= 0
  ),

  -- Status domain — mirrors payment_intent_record's narrowed Stripe vocabulary.
  CONSTRAINT "balance_payment_status_check" CHECK (
    "status" IN ('pending', 'processing', 'succeeded', 'failed', 'canceled')
  )
);


-- ── (3) Indexes ───────────────────────────────────────────────────────────────

-- Per-member lookup + per-org listing.
CREATE INDEX "balance_payment_org_user_idx"
  ON "balance_payment" ("org_id", "user_id");


-- ── (4) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE.

ALTER TABLE "balance_payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "balance_payment" FORCE  ROW LEVEL SECURITY;


-- ── (5) RLS policies (standard 4-policy pattern) ──────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   fail-closed on an unset/mismatched GUC (NULL = NULL is false in SQL).

-- balance_payment_select ALSO permits platform-admin context (mirrors
-- payment_intent_record_select, migration 0023): the webhook resolver
-- resolveBalancePaymentByStripePaymentIntentId is the ONE sanctioned
-- platform-admin read for balance payments — an unauthenticated webhook
-- delivery has no org GUC to set until AFTER resolving which org a given Stripe
-- PaymentIntent id belongs to. READ-ONLY: every WRITE policy stays org-GUC-only.
CREATE POLICY "balance_payment_select"
  ON "balance_payment"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'on'
  );

CREATE POLICY "balance_payment_insert"
  ON "balance_payment"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "balance_payment_update"
  ON "balance_payment"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "balance_payment_delete"
  ON "balance_payment"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (6) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so FORCE RLS is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "balance_payment" TO aeroops_app;
