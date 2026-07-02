/**
 * stripe_payment_method — a saved payment instrument (card or US bank
 * account), DISPLAY fields only (Slice P0-REV, migration 0024).
 *
 * NEVER stores raw card/bank data — last4/brand are Stripe-permitted DISPLAY
 * fields returned by the Stripe API itself. PCI SAQ-A: Stripe Elements/hosted
 * fields (SetupIntent confirm) own the raw instrument end-to-end; AeroOps only
 * ever sees Stripe's own ids and display metadata.
 *
 * Recorded from EITHER the portal confirm-callback (saveMyPaymentMethod) OR
 * the setup_intent.succeeded webhook — whichever lands first. UNIQUE
 * (stripe_payment_method_id) makes the second attempt a harmless no-op
 * (ON CONFLICT DO NOTHING).
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0024).
 *
 * ── Composite FKs (hand-written in migration 0024 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [stripe_payment_method_org_id_fk]
 *
 *   Composite FK (user_id, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [stripe_payment_method_user_org_fk]
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * stripe_payment_method_stripe_id_unique UNIQUE (stripe_payment_method_id) —
 *   Stripe payment-method ids are globally unique (Stripe's own id space).
 * stripe_payment_method_id_org_id_unique UNIQUE (id, org_id) — composite
 *   candidate key, consumed by autopay_setting(default_payment_method_id, org_id).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * stripe_payment_method_stripe_id_nonempty_check:
 *   char_length(btrim(stripe_payment_method_id)) > 0
 * stripe_payment_method_type_check: type IN ('card','us_bank_account')
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const stripePaymentMethod = pgTable(
  'stripe_payment_method',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // user_id carries no .references() — composite FK
    // (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0024.
    userId: uuid('user_id').notNull(),

    // Denormalized from stripe_customer for charge-time convenience.
    stripeCustomerId: text('stripe_customer_id').notNull(),

    // Stripe's own PaymentMethod id (e.g. "pm_..."). Globally unique.
    stripePaymentMethodId: text('stripe_payment_method_id').notNull(),

    // 'card' | 'us_bank_account'.
    type: text('type').notNull(),

    // Stripe-permitted DISPLAY fields ONLY — never a raw PAN/account number.
    last4: text('last4'),
    brand: text('brand'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stripe_payment_method_stripe_id_unique').on(t.stripePaymentMethodId),
    uniqueIndex('stripe_payment_method_id_org_id_unique').on(t.id, t.orgId),
    index('stripe_payment_method_org_user_idx').on(t.orgId, t.userId),
  ],
);

export type StripePaymentMethodSelect = typeof stripePaymentMethod.$inferSelect;
export type StripePaymentMethodInsert = typeof stripePaymentMethod.$inferInsert;
