-- ============================================================
-- AeroOps — Slice B2: Billing ledger + balance
-- Migration: 0022_billing_ledger.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0021_qbo_integration.sql
--               must already be applied.
--
-- Implements Slice B2: an append-only account ledger + a real (but NOT
-- injected) balance-seam data source, and the operator-config minimum
-- balance threshold. NO Stripe. NO card/bank data. NO real money movement —
-- this migration creates RECORD-KEEPING tables only; the gate that would
-- ever ENFORCE a balance stays wired to the Phase-1 no-op stub
-- (packages/core/src/dispatch-gate/balance-seam.ts, `stubBalanceSeam`) —
-- see (3) below.
--
--   billing_account         — one ledger account per (org, member).
--   ledger_entry            — APPEND-ONLY debit/credit history per account.
--   dispatch_config.minimum_balance_cents — additive column (operator-set
--     threshold consumed ONLY by realBalanceSeam, which is NOT injected by
--     this migration or any app code path in this slice).
--
-- Key guarantees:
--   (1) billing_account is tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS
--       + the standard 4-policy (SELECT/INSERT/UPDATE/DELETE) pattern
--       (mirrors migration 0019/0021 qbo_connection).
--   (2) ledger_entry is tenant-scoped + APPEND-ONLY: ENABLE+FORCE RLS +
--       SELECT + INSERT policies ONLY (mirrors dispatch_ticket_correction /
--       audit_log / qbo_export_log — migrations 0018 / 0000 / 0021). GRANT is
--       SELECT + INSERT only; REVOKE UPDATE, DELETE is an explicit
--       belt-and-suspenders backstop. Corrections to a wrong ledger entry are
--       expressed as a NEW reversing entry, never an edit.
--   (3) [VERIFY-B2-MONEY] HARD MONEY BOUNDARY — this migration does NOT wire
--       any real balance enforcement. dispatch_config.balance_check_enabled
--       stays operator-set (default false) and, even when an operator
--       enables it, packages/api/src/dispatch/open-dispatch.ts:338 still
--       calls `stubBalanceSeam` (always `{ ok: true }`) in every app-code
--       path in this slice. The real ledger-backed seam
--       (packages/api/src/billing/real-balance-seam.ts) is fully built and
--       unit/property-tested in this slice but is injected ONLY by test code
--       — NEVER by openDispatch()'s app-code form. Swapping the injected
--       seam is a later, separately-reviewed step (ADR-0015 boundary-lift
--       checklist item 6).
--   (4) billing_account.(org_id, user_id) is UNIQUE — exactly one ledger
--       account per member per org (a member with no account yet is
--       lazily created by `ensureBillingAccount` on first use — INSERT ...
--       ON CONFLICT DO NOTHING keyed on this UNIQUE).
--   (5) ledger_entry.amount_cents is a POSITIVE integer (CHECK > 0); the sign
--       of a movement is carried by `direction` ('debit' | 'credit'), never
--       by a negative amount — mirrors the append-only, audit-grade posture
--       of dispatch_ticket_correction (positive magnitudes + a labelled kind,
--       not a signed delta).
--   (6) Idempotency: a partial UNIQUE index on (org_id, invoice_id, entry_type)
--       WHERE entry_type = 'invoice_finalized' means an invoice can generate
--       AT MOST ONE 'invoice_finalized' debit entry per org — the structural
--       backstop behind finalizeInvoice's same-transaction ledger append
--       (packages/api/src/billing/invoice-status-commands.ts).
--   (7) Composite FKs are all hand-written (Drizzle cannot express multi-col
--       FKs). Named constraints follow the {table}_{fk_col}_org_fk convention.
--   (8) STRICTLY ADDITIVE — no existing tables/columns/constraints modified
--       except the single additive `dispatch_config.minimum_balance_cents`
--       column (default 0, matching the existing additive-column precedent
--       set by migrations 0010/0014/0017 on this same table).
--   (9) NO Stripe/card/bank columns anywhere in this migration.
--
-- ORDER within this file:
--   (1) CREATE TABLE billing_account (FKs + UNIQUE)
--   (2) CREATE TABLE ledger_entry (FKs + CHECKs + partial UNIQUE)
--   (3) ALTER TABLE dispatch_config ADD COLUMN minimum_balance_cents
--   (4) Indexes
--   (5) ENABLE + FORCE RLS (2 tables)
--   (6) RLS policies
--   (7) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE billing_account ─────────────────────────────────────────────────
--
-- One ledger account per (org, member). Lazily created on first ledger write
-- (ensureBillingAccount). Holds NO balance column — balance is always DERIVED
-- from ledger_entry via the pure `computeBalance` (packages/core), never
-- stored/cached, so it can never drift from the append-only history.
--
-- Composite FKs (all hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT:
--     The member must be a user in the same org. RESTRICT preserves billing
--     history when a user would otherwise be deleted.
--     Targets app_user_id_org_id_unique (migration 0000).
--
-- UNIQUE (org_id, user_id): exactly one ledger account per member per org.

CREATE TABLE "billing_account" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"     uuid NOT NULL,
  "user_id"    uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "billing_account_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the account's member must be a user in the same org.
  -- ON DELETE RESTRICT: preserves billing/ledger history.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "billing_account_user_org_fk"
    FOREIGN KEY ("user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Exactly one billing account per member per org.
  CONSTRAINT "billing_account_org_user_unique"
    UNIQUE ("org_id", "user_id"),

  -- Composite candidate key — consistent with all other tenant tables;
  -- consumed by ledger_entry(account_id, org_id) composite FK.
  CONSTRAINT "billing_account_id_org_id_unique"
    UNIQUE ("id", "org_id")
);


-- ── (2) TABLE ledger_entry ────────────────────────────────────────────────────
--
-- APPEND-ONLY debit/credit history. amount_cents is always a POSITIVE integer;
-- the sign of the movement is carried by `direction`. `computeBalance`
-- (packages/core) sums credit amounts minus debit amounts — see that module
-- for the documented sign convention (a "payment" credit RAISES the balance
-- available to a member; an "invoice_finalized" debit LOWERS it).
--
-- entry_type:
--   'invoice_finalized' — a debit posted atomically when an invoice is
--     finalized (packages/api/src/billing/invoice-status-commands.ts).
--     invoice_id is REQUIRED for this kind (see CHECK below).
--   'payment'            — a credit posted when a payment is recorded, either
--     manually by an operator (recordManualPayment, payment_id = a free-text
--     operator reference) or by a verified Stripe webhook
--     (payment_id = the Stripe PaymentIntent id, Slice B3).
--   'credit_memo'        — a credit posted for a billing correction / refund
--     acknowledgement (forward seam; not written by any command in this
--     slice).
--   'adjustment'         — a manual operator correction of either direction
--     (forward seam; not written by any command in this slice).
--
-- Composite FKs (all hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (account_id, org_id) → billing_account(id, org_id)
--     ON DELETE RESTRICT:
--     Entry must belong to an account in the same org. Preserves ledger
--     history (records integrity — an account with entries can never be
--     hard-deleted).
--     Targets billing_account_id_org_id_unique (created above).
--
--   Composite FK (invoice_id, org_id) → invoice(id, org_id) ON DELETE RESTRICT:
--     Nullable (fires on non-null values). Preserves the link between a
--     finalized invoice and its ledger debit.
--     Targets invoice_id_org_id_unique (migration 0019).
--
--   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT:
--     Nullable — NULL for SYSTEM/webhook-generated entries (e.g. a Stripe-
--     webhook-verified payment credit, Slice B3; mirrors audit_log.actor_user_id's
--     nullable "System" convention). When non-null, the actor who posted the
--     entry must be a member of the same org.
--     Targets app_user_id_org_id_unique (migration 0000).
--
-- CHECKs:
--   ledger_entry_entry_type_check: entry_type IN (...)
--   ledger_entry_direction_check: direction IN ('debit','credit')
--   ledger_entry_amount_positive_check: amount_cents > 0
--   ledger_entry_invoice_finalized_shape_check:
--     entry_type <> 'invoice_finalized' OR invoice_id IS NOT NULL
--     (an invoice_finalized entry must always carry the invoice it came from)
--
-- Idempotency backstop (structural, per (6) above): a partial UNIQUE index on
-- (org_id, invoice_id, entry_type) WHERE entry_type = 'invoice_finalized'
-- means an invoice can produce AT MOST ONE invoice_finalized debit per org.

CREATE TABLE "ledger_entry" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"       uuid NOT NULL,
  "account_id"   uuid NOT NULL,
  "entry_type"   text NOT NULL,
  "direction"    text NOT NULL,
  "amount_cents" integer NOT NULL,
  "invoice_id"   uuid,
  "payment_id"   text,
  "memo"         text,
  "created_by"   uuid,
  "created_at"   timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "ledger_entry_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: entry must reference an account in the same org.
  -- ON DELETE RESTRICT: preserves ledger history.
  -- Targets billing_account_id_org_id_unique (created above in this migration).
  CONSTRAINT "ledger_entry_account_org_fk"
    FOREIGN KEY ("account_id", "org_id")
    REFERENCES "billing_account"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: linked invoice (when present) must be in the same org.
  -- ON DELETE RESTRICT: preserves the invoice↔ledger link.
  -- Targets invoice_id_org_id_unique (migration 0019).
  CONSTRAINT "ledger_entry_invoice_org_fk"
    FOREIGN KEY ("invoice_id", "org_id")
    REFERENCES "invoice"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: when present, the posting actor must be a user in the same
  -- org. NULLABLE — NULL for SYSTEM/webhook-generated entries (e.g. a Stripe-
  -- webhook-verified payment credit, Slice B3); the FK only fires on non-null
  -- values, mirroring audit_log.actor_user_id's nullable "System" convention.
  -- ON DELETE RESTRICT: preserves creation attribution on an immutable record.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "ledger_entry_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "ledger_entry_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- entry_type domain.
  CONSTRAINT "ledger_entry_entry_type_check" CHECK (
    "entry_type" IN ('invoice_finalized', 'payment', 'credit_memo', 'adjustment')
  ),

  -- direction domain — the sign of the movement, never a negative amount.
  CONSTRAINT "ledger_entry_direction_check" CHECK (
    "direction" IN ('debit', 'credit')
  ),

  -- amount_cents is always a POSITIVE integer; direction carries the sign.
  CONSTRAINT "ledger_entry_amount_positive_check" CHECK (
    "amount_cents" > 0
  ),

  -- An invoice_finalized entry must always carry the invoice it originated
  -- from (the idempotency partial-UNIQUE index below depends on this).
  CONSTRAINT "ledger_entry_invoice_finalized_shape_check" CHECK (
    "entry_type" <> 'invoice_finalized' OR "invoice_id" IS NOT NULL
  )
);


-- ── (3) dispatch_config ADD COLUMN minimum_balance_cents ─────────────────────
--
-- Additive column (mirrors the precedent set by migrations 0010/0014/0017 on
-- this same table: twilight fields, availability fields, retention fields).
--
-- [VERIFY-B2-MONEY] HARD MONEY BOUNDARY: this column is DATA ONLY — an
-- operator-set threshold. It is consumed EXCLUSIVELY by
-- packages/api/src/billing/real-balance-seam.ts (realBalanceSeam), which is
-- NOT injected by openDispatch()'s app-code form in this slice (see (3) in
-- the file header). Adding this column does NOT change dispatch gate
-- behaviour: balance_check_enabled stays operator-set (default false) and
-- stubBalanceSeam (always {ok:true}) remains the only seam ever invoked by
-- app code. Default 0 — an operator who has never touched this setting has
-- no effective minimum even after a future seam swap.
--
-- CHECK: minimum_balance_cents >= 0 (a negative minimum balance is meaningless).

ALTER TABLE "dispatch_config"
  ADD COLUMN "minimum_balance_cents" integer NOT NULL DEFAULT 0;

ALTER TABLE "dispatch_config"
  ADD CONSTRAINT "dispatch_config_minimum_balance_nonneg_check"
  CHECK ("minimum_balance_cents" >= 0);


-- ── (4) Indexes ───────────────────────────────────────────────────────────────

-- billing_account: per-member account lookup (ensureBillingAccount / getMemberBalance).
-- e.g. WHERE org_id=$1 AND user_id=$2
CREATE INDEX "billing_account_org_user_idx"
  ON "billing_account" ("org_id", "user_id");

-- ledger_entry: per-account history, newest first (listLedgerEntries / computeBalance).
-- e.g. WHERE org_id=$1 AND account_id=$2 ORDER BY created_at DESC
CREATE INDEX "ledger_entry_org_account_created_idx"
  ON "ledger_entry" ("org_id", "account_id", "created_at" DESC);

-- Idempotency backstop (per (6) in the file header): an invoice may generate
-- AT MOST ONE invoice_finalized debit per org.
CREATE UNIQUE INDEX "ledger_entry_org_invoice_finalized_unique"
  ON "ledger_entry" ("org_id", "invoice_id", "entry_type")
  WHERE "entry_type" = 'invoice_finalized';


-- ── (5) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "billing_account" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "billing_account" FORCE   ROW LEVEL SECURITY;

ALTER TABLE "ledger_entry"    ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "ledger_entry"    FORCE   ROW LEVEL SECURITY;


-- ── (6) RLS policies ──────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)

-- ── billing_account policies (standard 4-policy pattern) ──────────────────────

CREATE POLICY "billing_account_select"
  ON "billing_account"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "billing_account_insert"
  ON "billing_account"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "billing_account_update"
  ON "billing_account"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "billing_account_delete"
  ON "billing_account"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── ledger_entry policies — APPEND-ONLY (SELECT + INSERT only) ────────────────
-- Mirrors dispatch_ticket_correction (0018) / qbo_export_log (0021) / audit_log
-- exactly: no UPDATE or DELETE policy. With FORCE ROW LEVEL SECURITY, the
-- absence of a permissive policy blocks those operations for ALL roles,
-- including the table owner — the structural guarantee that a ledger entry
-- is immutable once inserted. Corrections are new reversing entries, never edits.

CREATE POLICY "ledger_entry_select"
  ON "ledger_entry"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "ledger_entry_insert"
  ON "ledger_entry"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (7) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_account" TO aeroops_app;

GRANT SELECT, INSERT ON "ledger_entry" TO aeroops_app;
REVOKE UPDATE, DELETE ON "ledger_entry" FROM aeroops_app;
