/**
 * billing_account — one ledger account per (org, member).
 *
 * Lazily created on first ledger write (ensureBillingAccount, INSERT ...
 * ON CONFLICT (org_id, user_id) DO NOTHING). Holds NO balance column —
 * balance is always DERIVED from ledger_entry via the pure `computeBalance`
 * (@aeroops/core), never stored/cached, so it can never drift from the
 * append-only history.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0022).
 *
 * ── Composite FKs (hand-written in migration 0022 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [billing_account_org_id_fk]
 *     Tenant spine.
 *
 *   Composite FK (user_id, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [billing_account_user_org_fk]
 *     The member must be a user in the same org. RESTRICT preserves billing
 *     history when a user would otherwise be deleted.
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * billing_account_org_user_unique UNIQUE (org_id, user_id)
 *   Exactly one billing account per member per org. ON CONFLICT target for
 *   the lazy-create upsert.
 *
 * billing_account_id_org_id_unique UNIQUE (id, org_id)
 *   Composite candidate key — consumed by ledger_entry(account_id, org_id)
 *   composite FK and consistent with all other tenant tables.
 */
import {
  pgTable,
  uuid,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const billingAccount = pgTable(
  'billing_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0022. The simple .references() here covers Drizzle-level
    // ergonomics; the hand-written FK provides named-constraint auditability.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // user_id carries no .references() — composite FK
    // (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0022.
    userId: uuid('user_id').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Exactly one billing account per member per org — ON CONFLICT target
    // for the lazy-create upsert (ensureBillingAccount).
    uniqueIndex('billing_account_org_user_unique').on(t.orgId, t.userId),

    // Composite candidate key — consumed by ledger_entry(account_id, org_id)
    // composite FK and consistent with all other tenant tables.
    uniqueIndex('billing_account_id_org_id_unique').on(t.id, t.orgId),
  ],
);

export type BillingAccountSelect = typeof billingAccount.$inferSelect;
export type BillingAccountInsert = typeof billingAccount.$inferInsert;
