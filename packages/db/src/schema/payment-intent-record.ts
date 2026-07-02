/**
 * payment_intent_record — our record of a Stripe PaymentIntent's lifecycle,
 * keyed to an AeroOps invoice.
 *
 * amount_cents is our own recorded amount (INTEGER cents), set at creation
 * from the invoice total. It is NEVER independently trusted for settlement —
 * only a verified `payment_intent.succeeded` webhook event
 * (handleStripeWebhookEvent) ever transitions status to 'succeeded' and
 * posts the corresponding ledger_entry credit. Client responses NEVER settle
 * anything (webhooks are the source of truth — ADR-0015).
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0023).
 *
 * ── Composite FKs (hand-written in migration 0023 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [payment_intent_record_org_id_fk]
 *
 *   Composite FK (invoice_id, org_id) → invoice(id, org_id)
 *     ON DELETE RESTRICT  [payment_intent_record_invoice_org_fk]
 *     Targets invoice_id_org_id_unique (migration 0019).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * payment_intent_record_pi_id_nonempty_check:
 *   char_length(btrim(stripe_payment_intent_id)) > 0
 * payment_intent_record_amount_positive_check:
 *   amount_cents > 0
 * payment_intent_record_status_check:
 *   status IN ('pending','processing','succeeded','failed','canceled')
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * payment_intent_record_stripe_pi_unique UNIQUE (stripe_payment_intent_id) —
 *   Stripe PaymentIntent ids are globally unique — the idempotency backstop
 *   for "have we already recorded this PaymentIntent".
 * payment_intent_record_id_org_id_unique UNIQUE (id, org_id) — composite
 *   candidate key.
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

export const paymentIntentRecord = pgTable(
  'payment_intent_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // invoice_id carries no .references() — composite FK
    // (invoice_id, org_id) → invoice(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0023.
    invoiceId: uuid('invoice_id').notNull(),

    // Stripe's own PaymentIntent id (e.g. "pi_..."). Globally unique.
    stripePaymentIntentId: text('stripe_payment_intent_id').notNull(),

    // Our own recorded amount at creation time — INTEGER cents, NEVER
    // independently trusted for settlement (see file-level comment).
    amountCents: integer('amount_cents').notNull(),

    // Comma-joined Stripe payment_method_types, e.g. "us_bank_account,card"
    // (ACH-first — see docs/specs/slice-b2-b3-payments.md fee rationale).
    paymentMethodTypes: text('payment_method_types').notNull().default('card'),

    // payment_intent_record_status_check: mirrors Stripe's own PaymentIntent
    // status vocabulary, narrowed to the subset this app tracks.
    status: text('status').notNull().default('pending'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_intent_record_stripe_pi_unique').on(t.stripePaymentIntentId),
    uniqueIndex('payment_intent_record_id_org_id_unique').on(t.id, t.orgId),

    // Covers: per-invoice lookup (getPaymentStatus) + per-org listing.
    index('payment_intent_record_org_invoice_idx').on(t.orgId, t.invoiceId),
  ],
);

export type PaymentIntentRecordSelect = typeof paymentIntentRecord.$inferSelect;
export type PaymentIntentRecordInsert = typeof paymentIntentRecord.$inferInsert;
