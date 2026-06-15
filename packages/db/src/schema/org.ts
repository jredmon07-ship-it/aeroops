/**
 * org — the root tenant entity.
 *
 * RLS NOTE: org is self-keyed (its PK *is* the tenant key).
 * Policies use `id = NULLIF(current_setting('app.current_org_id', true), '')::uuid`
 * rather than `org_id = …`.
 *
 * INSERT on org is guarded by a platform-admin policy:
 * `current_setting('app.platform_admin', true) = 'on'`
 * Normal tenant context never sets app.platform_admin, so tenants
 * cannot create new orgs.
 *
 * Platform/control-plane tables (plan, subscription) are NOT org-scoped
 * for RLS purposes — keep them separate (see plan.ts, subscription.ts).
 */
import { pgTable, text, uuid, timestamp } from 'drizzle-orm/pg-core';

export const org = pgTable('org', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type OrgSelect = typeof org.$inferSelect;
export type OrgInsert = typeof org.$inferInsert;
