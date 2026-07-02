/**
 * autopay_setting — one row per member: explicit opt-in (enabled) + a
 * default saved payment method (Slice P0-REV, migration 0024).
 *
 * Auto-pay (triggerAutopayOnFinalize) NEVER fires unless BOTH enabled=true
 * AND default_payment_method_id references a saved payment_method — enforced
 * STRUCTURALLY by the autopay_enabled_requires_pm CHECK below, not merely by
 * the command layer.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0024).
 *
 * ── Composite FKs (hand-written in migration 0024 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [autopay_setting_org_id_fk]
 *
 *   Composite FK (user_id, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [autopay_setting_user_org_fk]
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 *   Composite FK (default_payment_method_id, org_id) →
 *     stripe_payment_method(id, org_id) ON DELETE RESTRICT
 *     [autopay_setting_default_pm_org_fk]
 *     Nullable — NULL when autopay is off/never configured.
 *     Targets stripe_payment_method_id_org_id_unique (migration 0024).
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * autopay_setting_org_user_unique UNIQUE (org_id, user_id) — the upsert target
 *   for setMyAutopay (INSERT ... ON CONFLICT (org_id,user_id) DO UPDATE).
 * autopay_setting_id_org_id_unique UNIQUE (id, org_id) — composite candidate key.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * autopay_enabled_requires_pm: enabled = false OR default_payment_method_id
 *   IS NOT NULL — THE STRUCTURAL GUARANTEE that autopay cannot be armed
 *   without a saved payment method.
 */
import {
  pgTable,
  uuid,
  boolean,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const autopaySetting = pgTable(
  'autopay_setting',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // user_id carries no .references() — composite FK
    // (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0024.
    userId: uuid('user_id').notNull(),

    enabled: boolean('enabled').notNull().default(false),

    // default_payment_method_id carries no .references() — composite FK
    // (default_payment_method_id, org_id) → stripe_payment_method(id, org_id)
    // ON DELETE RESTRICT is hand-written in migration 0024. Nullable.
    defaultPaymentMethodId: uuid('default_payment_method_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('autopay_setting_org_user_unique').on(t.orgId, t.userId),
    uniqueIndex('autopay_setting_id_org_id_unique').on(t.id, t.orgId),
  ],
);

export type AutopaySettingSelect = typeof autopaySetting.$inferSelect;
export type AutopaySettingInsert = typeof autopaySetting.$inferInsert;
