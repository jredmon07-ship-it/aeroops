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
 * cross-org membership rows. Also consumed by member_tag composite FKs
 * (migration 0008).
 *
 * ── Slice 6.1 additive columns (migration 0008) ──────────────────────────
 * phone: text (nullable, free-text, no format enforcement).
 *
 * status: text NOT NULL DEFAULT 'active'. ROSTER FLAG only — 'active' or
 *   'inactive'. The CHECK constraint app_user_status_check is hand-written
 *   in migration 0008 (text + CHECK, not a pg enum, for additive/reversible
 *   two-value domain).
 *
 *   !! 'inactive' does NOT block login in this slice. !!
 *   Login does not read the status column. Wiring inactive → login-refusal
 *   is deferred to a future auth slice. Operators must be told clearly that
 *   deactivating a member removes them from the roster view but does NOT
 *   prevent them from authenticating. [VERIFY-6-D]
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
    // phone: free-text, nullable. No format enforcement. Added in migration 0008.
    phone: text('phone'),
    // status: ROSTER FLAG ('active' | 'inactive'). NOT an auth gate in this slice.
    // app_user_status_check CHECK is hand-written in migration 0008.
    // DEFAULT 'active' — existing INSERT statements that omit this column
    // continue to succeed; back-fill is silent via the column DEFAULT.
    status: text('status').notNull().default('active'),
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
