/**
 * ledger_entry — APPEND-ONLY debit/credit history for a billing_account.
 *
 * amount_cents is ALWAYS a positive integer; the sign of the movement is
 * carried by `direction` ('debit' | 'credit'), never by a negative amount —
 * an audit-grade posture (a magnitude + a labelled kind, not a signed delta).
 *
 * `computeBalance` (@aeroops/core) sums credit amounts minus debit amounts
 * for a set of entries — see that module for the documented sign convention.
 * A 'payment' credit RAISES the balance available to a member; an
 * 'invoice_finalized' debit LOWERS it.
 *
 * entry_type:
 *   'invoice_finalized' — a debit posted atomically when an invoice is
 *     finalized (billing/invoice-status-commands.ts). invoice_id REQUIRED.
 *   'payment'            — a credit posted when a payment is recorded,
 *     either manually by an operator (recordManualPayment) or by a verified
 *     Stripe webhook (payment_id = the Stripe PaymentIntent id).
 *   'credit_memo'        — a credit for a billing correction/refund
 *     acknowledgement (forward seam; not written by any command in B2/B3).
 *   'adjustment'         — a manual operator correction of either direction
 *     (forward seam; not written by any command in B2/B3).
 *
 * NO updated_at column — rows are immutable once inserted (mirrors audit_log
 * / dispatch_ticket_correction / qbo_export_log).
 *
 * ── Append-only enforcement (migration 0022) ─────────────────────────────────
 * The migration applies ONLY SELECT + INSERT RLS policies. No UPDATE or
 * DELETE policy exists. With FORCE ROW LEVEL SECURITY, the absence of a
 * permissive policy blocks those operations for ALL roles (including the
 * table owner). GRANT is SELECT + INSERT only, with an explicit REVOKE
 * UPDATE, DELETE as a belt-and-suspenders backstop. Corrections to a wrong
 * entry are expressed as a NEW reversing entry, never an edit.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0022).
 *
 * ── Composite FKs (hand-written in migration 0022 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [ledger_entry_org_id_fk]
 *
 *   Composite FK (account_id, org_id) → billing_account(id, org_id)
 *     ON DELETE RESTRICT  [ledger_entry_account_org_fk]
 *     Targets billing_account_id_org_id_unique (migration 0022).
 *
 *   Composite FK (invoice_id, org_id) → invoice(id, org_id)
 *     ON DELETE RESTRICT  [ledger_entry_invoice_org_fk]
 *     Nullable: NULL unless entry_type='invoice_finalized' (CHECK-enforced).
 *     Targets invoice_id_org_id_unique (migration 0019).
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [ledger_entry_created_by_org_fk]
 *     Nullable — NULL for SYSTEM/webhook-generated entries (mirrors
 *     audit_log.actor_user_id's nullable "System" convention).
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * ledger_entry_entry_type_check:
 *   entry_type IN ('invoice_finalized','payment','credit_memo','adjustment')
 * ledger_entry_direction_check:
 *   direction IN ('debit','credit')
 * ledger_entry_amount_positive_check:
 *   amount_cents > 0
 * ledger_entry_invoice_finalized_shape_check:
 *   entry_type <> 'invoice_finalized' OR invoice_id IS NOT NULL
 *
 * ── Idempotency (structural backstop, migration 0022) ────────────────────────
 * A partial UNIQUE index on (org_id, invoice_id, entry_type) WHERE
 * entry_type = 'invoice_finalized' means an invoice can produce AT MOST ONE
 * invoice_finalized debit per org.
 *
 * ── Compliance / money-boundary note ─────────────────────────────────────────
 * NO Stripe/card/bank data. payment_id is a free-text reference (an operator's
 * manual note OR a Stripe PaymentIntent id in Slice B3) — never a raw
 * instrument. [VERIFY-B2-MONEY]: this table records money MOVEMENTS that have
 * ALREADY happened elsewhere (an operator's manual acknowledgement or a
 * verified Stripe webhook) — it does not itself move money.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const ledgerEntry = pgTable(
  'ledger_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0022.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // account_id carries no .references() — composite FK
    // (account_id, org_id) → billing_account(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0022.
    accountId: uuid('account_id').notNull(),

    // ledger_entry_entry_type_check: 'invoice_finalized' | 'payment' |
    // 'credit_memo' | 'adjustment'. TEXT + CHECK (not pgEnum) for
    // additive/reversible value domain, matching invoice.status.
    entryType: text('entry_type').notNull(),

    // ledger_entry_direction_check: 'debit' | 'credit'. Carries the sign of
    // the movement — amount_cents is always positive.
    direction: text('direction').notNull(),

    // Always a POSITIVE integer (ledger_entry_amount_positive_check).
    amountCents: integer('amount_cents').notNull(),

    // invoice_id carries no .references() — composite FK
    // (invoice_id, org_id) → invoice(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0022. Nullable: required only when
    // entry_type='invoice_finalized' (ledger_entry_invoice_finalized_shape_check).
    invoiceId: uuid('invoice_id'),

    // Free-text payment reference: an operator's manual note (recordManualPayment)
    // OR a Stripe PaymentIntent id (Slice B3 webhook). NEVER a raw card/bank value.
    paymentId: text('payment_id'),

    memo: text('memo'),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0022. NULLABLE — NULL for SYSTEM/webhook-
    // generated entries (e.g. a Stripe-webhook-verified payment credit,
    // Slice B3), mirroring audit_log.actor_user_id's nullable convention.
    createdBy: uuid('created_by'),

    // Append timestamp — immutable once set (no updated_at; mirrors audit_log).
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consistent with all other tenant tables.
    uniqueIndex('ledger_entry_id_org_id_unique').on(t.id, t.orgId),

    // Covers: per-account history, newest first (listLedgerEntries / computeBalance).
    // e.g. WHERE org_id = $1 AND account_id = $2 ORDER BY created_at DESC
    index('ledger_entry_org_account_created_idx').on(
      t.orgId,
      t.accountId,
      t.createdAt,
    ),

    // NOTE: the partial UNIQUE index (org_id, invoice_id, entry_type)
    // WHERE (entry_type='invoice_finalized') that enforces "one debit per
    // invoice" is hand-written in migration 0022 (Drizzle cannot express
    // partial indexes in table config) — mirrors the qbo_export_log convention.
  ],
);

export type LedgerEntrySelect = typeof ledgerEntry.$inferSelect;
export type LedgerEntryInsert = typeof ledgerEntry.$inferInsert;
