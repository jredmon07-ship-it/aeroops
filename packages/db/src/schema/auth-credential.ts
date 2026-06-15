/**
 * auth_credential — password credential for an app_user, scoped to one org.
 *
 * 1:1 with app_user. Isolates password hashes from the profile row so that
 * auth material is in a dedicated table with its own RLS guard.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE.
 *
 * Cross-org credentials are structurally impossible: the composite FK
 * FOREIGN KEY (user_id, org_id) REFERENCES app_user(id, org_id)
 * ensures a credential row can only point to a user that belongs to the
 * same org. This is enforced in the migration SQL (not expressible directly
 * in Drizzle's .references() helper — same pattern as membership).
 *
 * UNIQUE (user_id) — one credential per user.
 *
 * password_hash stores an argon2id ENCODED string produced by the backend.
 * Never a raw password; the schema-engineer only stores text.
 *
 * NO Auth.js adapter tables (accounts/sessions) — we use JWT.
 * NO last_login / email_verified — not needed for this slice.
 */
import { pgTable, text, uuid, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { org } from './org.js';
import { appUser } from './user.js';

export const authCredential = pgTable(
  'auth_credential',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),
    // userId carries no .references() call — the composite FK
    // (user_id, org_id) → app_user(id, org_id) is hand-written in the
    // migration SQL to structurally prevent cross-org credentials.
    userId: uuid('user_id').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // UNIQUE (user_id) — one credential per user
    uniqueIndex('auth_credential_user_id_unique').on(t.userId),
    // INDEX (org_id) — RLS filter index
    index('auth_credential_org_id_idx').on(t.orgId),
  ],
);

export type AuthCredentialSelect = typeof authCredential.$inferSelect;
export type AuthCredentialInsert = typeof authCredential.$inferInsert;
