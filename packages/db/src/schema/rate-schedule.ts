/**
 * rate_schedule — operator-defined pricing rates for billing.
 *
 * Operator billing RECORDS. Money stored as INTEGER CENTS (amount_cents).
 * NEVER floats. NO Stripe or card data. NO payment processing.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 *
 * A rate_schedule defines the per-unit price for a kind of charge. It may be
 * scoped to a specific aircraft (resource_id NOT NULL) or apply org-wide
 * as a default (resource_id IS NULL). rate_kind determines the charge dimension
 * (wet_hourly/dry_hourly/instruction/flat). effective_from/effective_to let an
 * operator version rates over time.
 *
 * Immutability of finalized invoices that reference a rate is enforced in the
 * command layer (Phase-2 B1 api). A rate row itself may be superseded by a newer
 * effective_from row; historical invoice_line_items retain their FK snapshot.
 *
 * ── Composite FKs (hand-written in migration 0019 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [rate_schedule_org_id_fk]
 *     Tenant spine — deleting an org cascades to its rate schedules.
 *
 *   Composite FK (resource_id, org_id) → resource(id, org_id)
 *     ON DELETE RESTRICT  [rate_schedule_resource_org_fk]
 *     Nullable: NULL when rate applies as org-wide default.
 *     When present, aircraft must exist in the same org. RESTRICT prevents
 *     hard-deleting an aircraft that has attached rate schedules (records
 *     integrity — rate history must be preserved for past invoice_line_items).
 *     Requires resource(id, org_id) composite candidate key
 *     "resource_id_org_id_unique" (established in migration 0002).
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [rate_schedule_created_by_org_fk]
 *     Creator must be a member of the same org (cross-org guard). RESTRICT
 *     preserves the creation attribution for auditing.
 *     Targets app_user_id_org_id_unique from migration 0000.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * rate_schedule_name_nonempty_check:
 *   char_length(btrim(name)) > 0
 *
 * rate_schedule_rate_kind_check:
 *   rate_kind IN ('wet_hourly','dry_hourly','instruction','flat')
 *
 * rate_schedule_amount_nonneg_check:
 *   amount_cents >= 0
 *   Amount in integer cents — must be non-negative.
 *
 * rate_schedule_effective_range_check:
 *   effective_to IS NULL OR effective_to > effective_from
 *   Open-ended rates (effective_to IS NULL) are valid; if bounded, end must be
 *   strictly after start.
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — forward-compat for future composite FKs that may
 * reference rate_schedule(id, org_id) from invoice_line_item.
 *
 * ── Index ─────────────────────────────────────────────────────────────────────
 * (org_id, resource_id) — covers rate-lookup queries:
 *   "list all rates for org" and "list rates for a specific aircraft".
 *
 * ── Money boundary note ──────────────────────────────────────────────────────
 * amount_cents is an INTEGER (cents). NEVER a float/numeric for money.
 * [VERIFY-B-MONEY-1]: derived flight time (Hobbs basis) becomes the billable
 * unit; confirm with compliance before Phase-2 billing goes live.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const rateSchedule = pgTable(
  'rate_schedule',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0019. The simple .references() here covers Drizzle-level
    // ergonomics; the hand-written FK provides named-constraint auditability.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // resource_id carries no .references() — composite FK
    // (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0019. Nullable: NULL = org-wide default rate.
    resourceId: uuid('resource_id'),

    // Human-readable name for the rate schedule (e.g. "Cessna 172 Wet Hourly 2026").
    // Must not be blank (rate_schedule_name_nonempty_check).
    name: text('name').notNull(),

    // Charge dimension for this rate.
    // rate_schedule_rate_kind_check: one of 'wet_hourly','dry_hourly','instruction','flat'.
    // TEXT + CHECK (not a pgEnum) for additive/reversible value domain.
    rateKind: text('rate_kind').notNull(),

    // Price in integer cents. NEVER a float. Must be >= 0.
    // rate_schedule_amount_nonneg_check enforces non-negativity.
    amountCents: integer('amount_cents').notNull(),

    // Rate is active from this timestamp (inclusive). Required.
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),

    // Rate expires at this timestamp (exclusive). NULL = open-ended.
    // rate_schedule_effective_range_check: effective_to > effective_from when set.
    effectiveTo: timestamp('effective_to', { withTimezone: true }),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0019. Creator must be a member of the same org.
    createdBy: uuid('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consumed by invoice_line_item(rate_schedule_id, org_id)
    // composite FK and consistent with all other tenant tables.
    uniqueIndex('rate_schedule_id_org_id_unique').on(t.id, t.orgId),

    // Covers: rate-lookup queries — list rates for org [AND specific aircraft].
    // e.g. WHERE org_id = $1 [AND resource_id = $2] AND effective_from <= now()
    //        AND (effective_to IS NULL OR effective_to > now())
    index('rate_schedule_org_resource_idx').on(t.orgId, t.resourceId),
  ],
);

export type RateScheduleSelect = typeof rateSchedule.$inferSelect;
export type RateScheduleInsert = typeof rateSchedule.$inferInsert;
