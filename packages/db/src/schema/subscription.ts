/**
 * subscription — platform/control-plane table.
 *
 * NOT org-scoped for RLS purposes. The org_id column here is a
 * relationship column (FK to org) but is NOT an RLS key — subscriptions
 * are managed by the platform/control-plane, not by tenant application
 * code filtered through app.current_org_id.
 *
 * NO RLS in this slice.
 *
 * status CHECK constraint is enforced in the migration SQL.
 */
import { pgTable, text, uuid, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { org } from './org.js';
import { plan } from './plan.js';

export const subscription = pgTable(
  'subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plan.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('trialing'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscription_org_id_unique').on(t.orgId),
  ],
);

export type SubscriptionSelect = typeof subscription.$inferSelect;
export type SubscriptionInsert = typeof subscription.$inferInsert;
