/**
 * balance_payment — our record of a Stripe PaymentIntent that pays down a
 * member's LEDGER BALANCE directly (fee-passing / pay-full-balance feature,
 * migration 0045). Unlike payment_intent_record (which is keyed to an invoice),
 * a balance payment is keyed to a (org, member) and carries NO invoice link —
 * it is not tied to any single invoice (statement semantics: invoice rows are
 * untouched; the credit simply zeroes a negative ledger balance).
 *
 * amount_cents is the BASE amount credited to the member's ledger on success
 * (the balance magnitude the member chose to pay). It is NEVER independently
 * trusted for settlement — only a verified `payment_intent.succeeded` webhook
 * event (handleStripeWebhookEvent) ever transitions status to 'succeeded' and
 * posts the corresponding 'payment' ledger credit. Client responses NEVER
 * settle anything (webhooks are the source of truth — ADR-0015).
 *
 * fee_cents is the pass-through ACH processing fee ADDED at charge time when
 * the org has fee-passing on (0 otherwise). INFORMATIONAL only — it is the
 * platform's (carried in Stripe metadata), NOT credited to the member's ledger.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0045).
 * balance_payment_select ALSO permits platform-admin context (mirrors
 * payment_intent_record_select) — the ONE sanctioned platform-admin read for
 * the unauthenticated webhook resolver.
 *
 * ── Composite FKs (hand-written in migration 0045 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [balance_payment_org_id_fk]
 *   Composite FK (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     [balance_payment_user_org_fk] — the paying member must be in the same org.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * balance_payment_pi_id_nonempty_check: char_length(btrim(stripe_payment_intent_id)) > 0
 * balance_payment_amount_positive_check: amount_cents > 0
 * balance_payment_fee_nonneg_check:      fee_cents >= 0
 * balance_payment_status_check: status IN ('pending','processing','succeeded','failed','canceled')
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * balance_payment_stripe_pi_unique UNIQUE (stripe_payment_intent_id) — Stripe
 *   ids are globally unique; the idempotency backstop.
 * balance_payment_id_org_id_unique UNIQUE (id, org_id) — composite candidate key.
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

export const balancePayment = pgTable(
  'balance_payment',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // user_id carries no .references() — composite FK
    // (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0045.
    userId: uuid('user_id').notNull(),

    // Stripe's own PaymentIntent id (e.g. "pi_..."). Globally unique.
    stripePaymentIntentId: text('stripe_payment_intent_id').notNull(),

    // BASE amount credited to the ledger on success — INTEGER cents, NEVER
    // independently trusted for settlement (see file-level comment).
    amountCents: integer('amount_cents').notNull(),

    // Pass-through processing fee added at charge time — INFORMATIONAL only,
    // NOT credited to the ledger (the platform's; carried in Stripe metadata).
    feeCents: integer('fee_cents').notNull().default(0),

    // balance_payment_status_check: mirrors payment_intent_record's vocabulary.
    status: text('status').notNull().default('pending'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('balance_payment_stripe_pi_unique').on(t.stripePaymentIntentId),
    uniqueIndex('balance_payment_id_org_id_unique').on(t.id, t.orgId),
    index('balance_payment_org_user_idx').on(t.orgId, t.userId),
  ],
);

export type BalancePaymentSelect = typeof balancePayment.$inferSelect;
export type BalancePaymentInsert = typeof balancePayment.$inferInsert;
