/**
 * stripe_customer — one Stripe Customer id per (org, member).
 *
 * NEVER stores raw card/bank data — last4/brand are Stripe-permitted DISPLAY
 * fields returned by the Stripe API itself (never entered by the app or
 * transmitted by AeroOps servers). PCI SAQ-A: Stripe Elements/hosted fields
 * own the raw instrument end-to-end; AeroOps only ever sees Stripe's own ids
 * and display metadata.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0023).
 *
 * ── Composite FKs (hand-written in migration 0023 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [stripe_customer_org_id_fk]
 *
 *   Composite FK (user_id, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [stripe_customer_user_org_fk]
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * stripe_customer_org_user_unique UNIQUE (org_id, user_id)
 * stripe_customer_stripe_id_unique UNIQUE (stripe_customer_id) — Stripe
 *   customer ids are globally unique (Stripe's own id space).
 * stripe_customer_id_org_id_unique UNIQUE (id, org_id) — composite candidate key.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const stripeCustomer = pgTable(
  'stripe_customer',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // user_id carries no .references() — composite FK
    // (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0023.
    userId: uuid('user_id').notNull(),

    // Stripe's own Customer id (e.g. "cus_..."). Globally unique.
    stripeCustomerId: text('stripe_customer_id').notNull(),

    // Stripe-permitted DISPLAY fields ONLY — never a raw PAN/account number.
    last4: text('last4'),
    brand: text('brand'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stripe_customer_org_user_unique').on(t.orgId, t.userId),
    uniqueIndex('stripe_customer_stripe_id_unique').on(t.stripeCustomerId),
    uniqueIndex('stripe_customer_id_org_id_unique').on(t.id, t.orgId),
  ],
);

export type StripeCustomerSelect = typeof stripeCustomer.$inferSelect;
export type StripeCustomerInsert = typeof stripeCustomer.$inferInsert;
