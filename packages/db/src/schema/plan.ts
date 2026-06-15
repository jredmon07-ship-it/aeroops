/**
 * plan — platform/control-plane table.
 *
 * NOT org-scoped; NO RLS. This is a platform-level entity that describes
 * subscription tiers (e.g. "Starter", "Growth", "Enterprise").
 *
 * Platform/control-plane tables are intentionally kept separate from
 * tenant-scoped tables to make the isolation boundary explicit.
 */
import { pgTable, text, uuid, timestamp } from 'drizzle-orm/pg-core';

export const plan = pgTable('plan', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  stripePriceId: text('stripe_price_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PlanSelect = typeof plan.$inferSelect;
export type PlanInsert = typeof plan.$inferInsert;
