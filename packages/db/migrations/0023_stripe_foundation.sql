-- ============================================================
-- AeroOps — Slice B3-foundation: Stripe integration foundation
-- Migration: 0023_stripe_foundation.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0022_billing_ledger.sql
--               must already be applied.
--
-- Implements the B3 SEAM-TO-THE-KEY-BOUNDARY: schema only, to be populated
-- once the maintainer provides Stripe TEST keys (STRIPE_SECRET_KEY /
-- STRIPE_PUBLISHABLE_KEY / STRIPE_WEBHOOK_SECRET). Until those keys are set,
-- packages/api/src/integrations/stripe/client.ts resolves to a stub that
-- throws a typed StripeNotConfiguredError on every call — NO real Stripe
-- call is ever made by this migration or by any code that consumes it.
--
--   stripe_customer       — one Stripe Customer id per (org, member).
--   stripe_event          — APPEND-ONLY global webhook-event dedup ledger.
--   payment_intent_record — our record of a Stripe PaymentIntent's lifecycle.
--
-- Key guarantees:
--   (1) stripe_customer + payment_intent_record are tenant-scoped: org_id
--       NOT NULL + ENABLE+FORCE RLS + the standard 4-policy pattern (mirrors
--       migration 0019/0021/0022 billing_account) — EXCEPT
--       payment_intent_record_select ADDITIONALLY permits platform-admin
--       context (mirrors org_select, migration 0000 FIX 4): this is the ONE
--       sanctioned platform-admin read in the Stripe webhook path
--       (resolveOrgByStripePaymentIntentId, integrations/stripe/
--       resolve-payment-intent.ts) — an unauthenticated webhook delivery has
--       no org GUC to set until AFTER resolving which org a Stripe
--       PaymentIntent id belongs to. READ-ONLY: every WRITE policy
--       (UPDATE/INSERT/DELETE) on payment_intent_record stays org-GUC-only.
--   (2) stripe_event is GLOBAL (event_id is Stripe's own idempotency key,
--       which is unique across ALL Stripe accounts/orgs) — its PRIMARY KEY
--       IS event_id (text), not a generated uuid. org_id is NULLABLE on this
--       table ONLY, because signature verification (which happens BEFORE any
--       org lookup) must be able to dedup a webhook delivery even if the
--       payload cannot yet be associated with an org (e.g. a malformed or
--       unrecognized event). This table gets ENABLE+FORCE RLS + APPEND-ONLY
--       policies scoped so that: SELECT/INSERT are allowed when org_id IS
--       NULL (dedup-only path — no org GUC required) OR org_id matches the
--       GUC. See (6) below for the exact policy predicate.
--   (3) NEVER stores raw card/bank data — this migration has NO PAN, CVV,
--       account/routing-number, or similar column anywhere. Only
--       Stripe-permitted DISPLAY fields (last4/brand) are stored, matching
--       PCI SAQ-A (Stripe Elements/hosted fields own the raw instrument).
--   (4) stripe_customer.(org_id, user_id) is UNIQUE — exactly one Stripe
--       Customer per member per org (mirrors billing_account).
--   (5) payment_intent_record.stripe_payment_intent_id is UNIQUE (global —
--       Stripe ids are globally unique) — the idempotency backstop for
--       "have we already recorded this PaymentIntent". ADDITIONALLY, a
--       partial UNIQUE index on (invoice_id) WHERE status IN
--       ('pending','processing','succeeded') caps every invoice at ONE
--       non-terminal payment_intent_record row at a time — the atomic DB
--       backstop behind the app-level one-active-PI-per-invoice guard (see
--       §(4) Indexes below for the full rationale).
--   (6) stripe_event is APPEND-ONLY (SELECT + INSERT policies only, GRANT
--       SELECT+INSERT, explicit REVOKE UPDATE/DELETE) — mirrors
--       dispatch_ticket_correction / ledger_entry / qbo_export_log exactly.
--       Its PRIMARY KEY (event_id) is itself the webhook dedup mechanism:
--       the webhook handler INSERTs first — a unique-violation means the
--       event was already processed, and the handler returns 200 without
--       reprocessing (idempotent-by-construction, not merely
--       application-checked).
--   (7) Composite FKs are all hand-written (Drizzle cannot express multi-col
--       FKs). Named constraints follow the {table}_{fk_col}_org_fk convention.
--   (8) STRICTLY ADDITIVE — no existing tables/columns/constraints modified.
--       Only the three new tables are created.
--   (9) NO money MOVES in this migration or in any code that only reads/
--       writes these tables without live Stripe keys. See
--       packages/api/src/integrations/stripe/client.ts (stub-when-
--       unconfigured seam) and docs/specs/slice-b2-b3-payments.md (the
--       boundary-lift checklist).
--
-- ORDER within this file:
--   (1) CREATE TABLE stripe_customer (FKs + UNIQUE)
--   (2) CREATE TABLE stripe_event (PK = event_id; nullable org_id)
--   (3) CREATE TABLE payment_intent_record (FKs + CHECKs + UNIQUE)
--   (4) Indexes
--   (5) ENABLE + FORCE RLS (3 tables)
--   (6) RLS policies
--   (7) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE stripe_customer ─────────────────────────────────────────────────
--
-- One Stripe Customer per (org, member). Never stores raw card/bank data —
-- last4/brand are Stripe-permitted DISPLAY fields returned by the Stripe API
-- itself (never entered by the app or transmitted by AeroOps servers).
--
-- Composite FKs (all hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT:
--     The member must be a user in the same org.
--     Targets app_user_id_org_id_unique (migration 0000).
--
-- UNIQUE (org_id, user_id): exactly one Stripe Customer per member per org.
-- UNIQUE (stripe_customer_id): Stripe customer ids are globally unique.

CREATE TABLE "stripe_customer" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"               uuid NOT NULL,
  "user_id"              uuid NOT NULL,
  "stripe_customer_id"   text NOT NULL,
  "last4"                text,
  "brand"                text,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "stripe_customer_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the customer's member must be a user in the same org.
  -- ON DELETE RESTRICT: preserves the Stripe linkage record.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "stripe_customer_user_org_fk"
    FOREIGN KEY ("user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Exactly one Stripe Customer per member per org.
  CONSTRAINT "stripe_customer_org_user_unique"
    UNIQUE ("org_id", "user_id"),

  -- Stripe customer ids are globally unique (Stripe's own id space).
  CONSTRAINT "stripe_customer_stripe_id_unique"
    UNIQUE ("stripe_customer_id"),

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "stripe_customer_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  CONSTRAINT "stripe_customer_stripe_id_nonempty_check" CHECK (
    char_length(btrim("stripe_customer_id")) > 0
  )
);


-- ── (2) TABLE stripe_event ────────────────────────────────────────────────────
--
-- GLOBAL append-only webhook-event dedup ledger. PRIMARY KEY IS event_id
-- (Stripe's own event id, e.g. "evt_..."), NOT a generated uuid — Stripe
-- event ids are globally unique across all Stripe accounts, and the webhook
-- handler's dedup strategy is "INSERT this event_id; a unique-violation means
-- already processed" (idempotent-by-construction).
--
-- org_id is NULLABLE — signature verification happens BEFORE any org lookup,
-- and a webhook delivery must be dedup-able even when its payload cannot yet
-- be associated with an org (e.g. malformed/unrecognized event, or an event
-- for a resource this app does not track). When the handler CAN determine the
-- org (payment_intent.succeeded with a resolvable payment_intent_record),
-- org_id is populated for audit/read purposes.
--
-- payload carries the RAW Stripe event JSON for support/audit — this is
-- Stripe's own payment-metadata shape (ids, amounts, status), NEVER raw
-- card/bank data (Stripe never includes PAN/CVV/account numbers in webhook
-- payloads either).
--
-- No updated_at — rows are immutable once inserted (mirrors audit_log /
-- dispatch_ticket_correction).

CREATE TABLE "stripe_event" (
  "event_id"     text PRIMARY KEY NOT NULL,
  "org_id"       uuid,
  "type"         text NOT NULL,
  "processed_at" timestamptz NOT NULL DEFAULT now(),
  "payload"      jsonb NOT NULL,

  -- Tenant spine FK — nullable (see rationale above). When present, deleting
  -- the org cascades to its webhook-event history.
  CONSTRAINT "stripe_event_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  CONSTRAINT "stripe_event_id_nonempty_check" CHECK (
    char_length(btrim("event_id")) > 0
  ),

  CONSTRAINT "stripe_event_type_nonempty_check" CHECK (
    char_length(btrim("type")) > 0
  )
);


-- ── (3) TABLE payment_intent_record ───────────────────────────────────────────
--
-- Our record of a Stripe PaymentIntent's lifecycle, keyed to an AeroOps
-- invoice. amount_cents is our own recorded amount (INTEGER cents) — it is
-- set at creation from the invoice total and never independently trusted for
-- settlement; only a verified `payment_intent.succeeded` webhook event
-- (processed by handleStripeWebhookEvent) ever transitions status to
-- 'succeeded' and posts the corresponding ledger_entry credit.
--
-- Composite FKs (all hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (invoice_id, org_id) → invoice(id, org_id) ON DELETE RESTRICT:
--     The PaymentIntent must be linked to an invoice in the same org.
--     Targets invoice_id_org_id_unique (migration 0019).
--
-- CHECKs:
--   payment_intent_record_amount_positive_check: amount_cents > 0
--   payment_intent_record_status_check: status IN (...)
--   payment_intent_record_pi_id_nonempty_check:
--     char_length(btrim(stripe_payment_intent_id)) > 0
--
-- UNIQUE (stripe_payment_intent_id): Stripe PaymentIntent ids are globally
-- unique — the idempotency backstop for "have we already recorded this PI".

CREATE TABLE "payment_intent_record" (
  "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"                      uuid NOT NULL,
  "invoice_id"                  uuid NOT NULL,
  "stripe_payment_intent_id"    text NOT NULL,
  "amount_cents"                integer NOT NULL,
  "payment_method_types"        text NOT NULL DEFAULT 'card',
  "status"                      text NOT NULL DEFAULT 'pending',
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "payment_intent_record_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the linked invoice must be in the same org.
  -- ON DELETE RESTRICT: preserves the invoice↔PaymentIntent linkage.
  -- Targets invoice_id_org_id_unique (migration 0019).
  CONSTRAINT "payment_intent_record_invoice_org_fk"
    FOREIGN KEY ("invoice_id", "org_id")
    REFERENCES "invoice"("id", "org_id") ON DELETE RESTRICT,

  -- Stripe PaymentIntent ids are globally unique (Stripe's own id space).
  CONSTRAINT "payment_intent_record_stripe_pi_unique"
    UNIQUE ("stripe_payment_intent_id"),

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "payment_intent_record_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  CONSTRAINT "payment_intent_record_pi_id_nonempty_check" CHECK (
    char_length(btrim("stripe_payment_intent_id")) > 0
  ),

  CONSTRAINT "payment_intent_record_amount_positive_check" CHECK (
    "amount_cents" > 0
  ),

  -- Status domain — mirrors Stripe's own PaymentIntent status vocabulary,
  -- narrowed to the subset this app tracks.
  CONSTRAINT "payment_intent_record_status_check" CHECK (
    "status" IN ('pending', 'processing', 'succeeded', 'failed', 'canceled')
  )
);


-- ── (4) Indexes ───────────────────────────────────────────────────────────────

-- stripe_customer: per-member lookup (createInvoicePaymentIntent needs the
-- customer id before calling Stripe).
CREATE INDEX "stripe_customer_org_user_idx"
  ON "stripe_customer" ("org_id", "user_id");

-- stripe_event: recent-history reads (support/audit) + the org-scoped view.
CREATE INDEX "stripe_event_org_processed_idx"
  ON "stripe_event" ("org_id", "processed_at" DESC);

-- payment_intent_record: per-invoice lookup (getPaymentStatus) + per-org listing.
CREATE INDEX "payment_intent_record_org_invoice_idx"
  ON "payment_intent_record" ("org_id", "invoice_id");

-- payment_intent_record: ATOMIC one-active-PaymentIntent-per-invoice backstop
-- (P0-REV money-invariant fix). The application-level idempotency check
-- (SELECT for an existing pending/processing/succeeded row, THEN INSERT) in
-- createPaymentIntentForInvoiceTx / triggerAutopayOnFinalize is NOT atomic on
-- its own — two concurrent callers for the SAME invoice (auto-pay-on-finalize
-- racing a member's self-pay click, or a double self-pay click) can both pass
-- the read check before either INSERTs. This partial UNIQUE index is the DB-
-- level backstop, mirroring dispatch_ticket's one-open-per-aircraft partial
-- UNIQUE (migration 0005, ADR-0007 §2): at most ONE payment_intent_record row
-- per invoice_id may ever be in a non-terminal status at a time. A losing
-- concurrent INSERT raises Postgres 23505 (unique_violation); the caller
-- catches it (isUniqueViolation, dispatch/internal.ts) and returns the
-- winner's already-recorded PaymentIntent instead of creating a second row.
-- Because the Stripe webhook (the SOLE settlement path) resolves org/invoice
-- via a payment_intent_record row match (resolveOrgByStripePaymentIntentId),
-- a PaymentIntent that never gets its own row can never post a ledger credit
-- — so at most one settling PaymentIntent, and at most one 'payment' ledger
-- credit, can ever exist per invoice.
CREATE UNIQUE INDEX "payment_intent_record_invoice_active_unique"
  ON "payment_intent_record" ("invoice_id")
  WHERE "status" IN ('pending', 'processing', 'succeeded');


-- ── (5) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "stripe_customer"       ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "stripe_customer"       FORCE   ROW LEVEL SECURITY;

ALTER TABLE "stripe_event"          ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "stripe_event"          FORCE   ROW LEVEL SECURITY;

ALTER TABLE "payment_intent_record" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "payment_intent_record" FORCE   ROW LEVEL SECURITY;


-- ── (6) RLS policies ──────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)

-- ── stripe_customer policies (standard 4-policy pattern) ───────────────────────

CREATE POLICY "stripe_customer_select"
  ON "stripe_customer"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "stripe_customer_insert"
  ON "stripe_customer"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "stripe_customer_update"
  ON "stripe_customer"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "stripe_customer_delete"
  ON "stripe_customer"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── stripe_event policies — APPEND-ONLY, org_id-NULLABLE predicate ────────────
-- The webhook handler runs OUTSIDE any per-request org GUC (it is an
-- unauthenticated provider callback — org context, when known, is set
-- explicitly by the handler via withOrgContext AFTER signature verification
-- and event-type routing determine it). Two admissible cases:
--   (a) org_id IS NULL — the dedup-only INSERT path (signature verified, org
--       not yet resolved, OR genuinely org-less event). Always visible/
--       insertable regardless of GUC.
--   (b) org_id matches the current GUC — the org-scoped path, once the
--       handler has resolved and set org context for the rest of the
--       transaction (e.g. to also post a ledger_entry in the same tx).
-- This is intentionally MORE permissive on org_id IS NULL than every other
-- table in this schema (which fail-closed on an unset/mismatched GUC) —
-- documented and isolated to this ONE append-only, no-PII, Stripe-owned-id
-- keyed table. No other table in this migration or schema uses this pattern.

CREATE POLICY "stripe_event_select"
  ON "stripe_event"
  FOR SELECT
  USING (
    org_id IS NULL
    OR org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "stripe_event_insert"
  ON "stripe_event"
  FOR INSERT
  WITH CHECK (
    org_id IS NULL
    OR org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── payment_intent_record policies (standard 4-policy pattern) ────────────────

-- payment_intent_record_select ALSO permits platform-admin context (mirrors
-- org_select, migration 0000 FIX 4): resolveOrgByStripePaymentIntentId
-- (integrations/stripe/resolve-payment-intent.ts) is the ONE sanctioned
-- platform-admin read in the Stripe webhook path — an unauthenticated
-- webhook delivery has no org GUC to set until AFTER this lookup resolves
-- which org a given Stripe PaymentIntent id belongs to. Normal tenant
-- context (platform_admin not 'on') remains scoped to its own org; every
-- WRITE (UPDATE/INSERT/DELETE) below stays org-GUC-only — platform-admin
-- context is READ-ONLY here, matching the org table's INSERT-stays-separate
-- precedent (org_insert_platform_admin is its own distinct policy, not
-- folded into org_select).
CREATE POLICY "payment_intent_record_select"
  ON "payment_intent_record"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'on'
  );

CREATE POLICY "payment_intent_record_insert"
  ON "payment_intent_record"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "payment_intent_record_update"
  ON "payment_intent_record"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "payment_intent_record_delete"
  ON "payment_intent_record"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (7) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "stripe_customer"       TO aeroops_app;

GRANT SELECT, INSERT ON "stripe_event" TO aeroops_app;
REVOKE UPDATE, DELETE ON "stripe_event" FROM aeroops_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_intent_record" TO aeroops_app;
