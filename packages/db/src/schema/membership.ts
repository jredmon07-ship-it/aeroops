/**
 * membership — links an app_user to an org with a role.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE.
 *
 * Cross-org membership is structurally impossible: the composite FK
 * FOREIGN KEY (user_id, org_id) REFERENCES app_user(id, org_id)
 * ensures a membership row can only point to a user that belongs to
 * the same org. This is enforced in the migration SQL (not expressible
 * directly in Drizzle's .references() helper).
 *
 * STORAGE / TYPE ONLY — no permission enforcement in this slice (0.3).
 */
import { pgTable, uuid, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { org } from './org.js';
import { membershipRole } from './enums.js';

export const membership = pgTable(
  'membership',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    role: membershipRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('membership_org_id_user_id_unique').on(t.orgId, t.userId),
    index('membership_user_id_idx').on(t.userId),
  ],
);

export type MembershipSelect = typeof membership.$inferSelect;
export type MembershipInsert = typeof membership.$inferInsert;
