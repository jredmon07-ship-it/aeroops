/**
 * app_user — an authenticated user scoped to exactly one org.
 *
 * Table name is `app_user` because `user` is a reserved word in Postgres.
 * TypeScript export name: `appUser` (TS convention); alias `users` also
 * exported for ergonomic query code.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE.
 *
 * NO auth columns in this slice (password, provider tokens, etc.) — those
 * come in slice 0.2 (Auth.js integration).
 *
 * UNIQUE (id, org_id) — exposes a composite candidate key so that the
 * membership table can carry a composite FK that structurally prevents
 * cross-org membership rows.
 */
import { pgTable, text, uuid, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    fullName: text('full_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('app_user_org_id_email_unique').on(t.orgId, t.email),
    uniqueIndex('app_user_id_org_id_unique').on(t.id, t.orgId),
  ],
);

/** Ergonomic alias — use either name; they reference the same table object. */
export const users = appUser;

export type AppUserSelect = typeof appUser.$inferSelect;
export type AppUserInsert = typeof appUser.$inferInsert;
