/**
 * dispatch_config — per-org dispatch gate configuration (0..1 row per org).
 *
 * Controls two gate dimensions at check-out:
 *   eligibility_mode: whether a missing required tag BLOCKS or WARNS.
 *   balance_check_enabled: feature flag for the future balance seam.
 *
 * [VERIFY-3c-MONEY] (HARD MONEY BOUNDARY): balance_check_enabled is a
 * FEATURE FLAG ONLY. It controls whether the balance-seam stub is invoked.
 * There is NO dollar value, minimum balance, payment reference, Stripe
 * integration, or financial data anywhere in this table. The balance seam
 * always returns {ok:true} in Phase 1 — this flag is wired but inert.
 * Billing / real balance enforcement is Phase 2. UI copy must say
 * "Not yet active — turning this on has no effect until account balances ship."
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0009).
 *
 * UNIQUE (org_id): one config row per org (0..1). Absent row → defaults apply:
 *   { eligibilityMode: 'block', balanceCheckEnabled: false }
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * dispatch_config_org_id_unique UNIQUE (org_id)
 *   One config per org. Used as the ON CONFLICT target in upsert.
 *
 * dispatch_config_id_org_id_unique UNIQUE (id, org_id)
 *   Composite candidate key — forward-compat for future composite FKs,
 *   consistent with all other tenant tables.
 *
 * ── CHECKs (hand-written in migration 0009 SQL) ──────────────────────────────
 * dispatch_config_eligibility_mode_check:
 *   eligibility_mode IN ('block', 'warn')
 *   Prevents unknown mode values from entering the table.
 */
import {
  pgTable,
  uuid,
  timestamp,
  text,
  boolean,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const dispatchConfig = pgTable(
  'dispatch_config',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — simple FK; named FK dispatch_config_org_id_fk
    // with ON DELETE CASCADE is hand-written in migration 0009.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // 'block' | 'warn'. DEFAULT 'block' ensures a missing required tag blocks
    // dispatch when a rule exists. CHECK hand-written in migration 0009.
    eligibilityMode: text('eligibility_mode').notNull().default('block'),

    // FEATURE FLAG — Phase 1 stub only. [VERIFY-3c-MONEY]: no money concept.
    // false = balance seam not invoked. true = stub still returns {ok:true}.
    balanceCheckEnabled: boolean('balance_check_enabled').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One config row per org — target for ON CONFLICT(org_id) upsert.
    uniqueIndex('dispatch_config_org_id_unique').on(t.orgId),

    // Composite candidate key — forward-compat for future composite FKs.
    // Consistent with all other tenant tables.
    uniqueIndex('dispatch_config_id_org_id_unique').on(t.id, t.orgId),
  ],
);

export type DispatchConfigSelect = typeof dispatchConfig.$inferSelect;
export type DispatchConfigInsert = typeof dispatchConfig.$inferInsert;
