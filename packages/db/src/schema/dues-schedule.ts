/**
 * dues_schedule — an operator-configured recurring-dues line for one member
 * (Slice P0-REV, migration 0025).
 *
 * amount_cents = INTEGER CENTS, never a float. cadence is constrained to
 * 'monthly' only in this slice (forward seam for other cadences). day_of_month
 * is bounded 1–28 (avoids short-month drift) and is informational/planning
 * metadata only — this table does not itself schedule anything (no cron;
 * generation is triggered by generateDuesInvoices, called manually via
 * runDuesForPeriodAction or later founder-infra cron).
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0025).
 *
 * ── Composite FKs (hand-written in migration 0025 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [dues_schedule_org_id_fk]
 *
 *   Composite FK (user_id, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [dues_schedule_user_org_fk]
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [dues_schedule_created_by_org_fk]
 *     Nullable. Targets app_user_id_org_id_unique (migration 0000).
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * dues_schedule_id_org_id_unique UNIQUE (id, org_id) — composite candidate
 *   key, consumed by dues_run(dues_schedule_id, org_id).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * dues_schedule_amount_positive_check: amount_cents > 0
 * dues_schedule_cadence_check: cadence IN ('monthly')
 * dues_schedule_day_of_month_check: day_of_month BETWEEN 1 AND 28
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const duesSchedule = pgTable(
  'dues_schedule',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // user_id / created_by carry no .references() — composite FKs are
    // hand-written in migration 0025.
    userId: uuid('user_id').notNull(),

    // INTEGER CENTS, never a float.
    amountCents: integer('amount_cents').notNull(),

    // dues_schedule_cadence_check: only 'monthly' in this slice.
    cadence: text('cadence').notNull().default('monthly'),

    // dues_schedule_day_of_month_check: BETWEEN 1 AND 28. Informational only.
    dayOfMonth: integer('day_of_month').notNull(),

    // Migration 0050: the month (1-12) a non-monthly cadence anchors on; NULL
    // for monthly. Reads are graceful-absence-guarded (billing/dues-internal.ts)
    // so pre-0050 databases, which lack this column, never break.
    anchorMonth: integer('anchor_month'),

    active: boolean('active').notNull().default(true),

    memo: text('memo'),

    createdBy: uuid('created_by'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dues_schedule_id_org_id_unique').on(t.id, t.orgId),
    index('dues_schedule_org_active_idx').on(t.orgId, t.active),
    index('dues_schedule_org_user_idx').on(t.orgId, t.userId),
  ],
);

export type DuesScheduleSelect = typeof duesSchedule.$inferSelect;
export type DuesScheduleInsert = typeof duesSchedule.$inferInsert;
