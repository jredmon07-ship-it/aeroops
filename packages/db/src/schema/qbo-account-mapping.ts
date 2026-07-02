/**
 * qbo_account_mapping — per-org, per-line-item-kind → QBO Item (income
 * account) mapping.
 *
 * This is the "real-time line-item GL mapping" competitive wedge: instead
 * of pushing one lump-sum invoice line to QBO, each AeroOps invoice line
 * item is mapped by KIND to the operator's own designated QBO Item, so
 * aircraft rental revenue, instructor time, and other charge kinds land in
 * their own operator-chosen GL buckets automatically.
 *
 * line_kind mirrors rate_schedule.rate_kind (migration 0019) —
 * 'wet_hourly' | 'dry_hourly' | 'instruction' | 'flat' — plus two synthetic
 * buckets:
 *   'other'   — invoice line items with no rate_schedule_id (manual/ad-hoc
 *               charges, e.g. an operator-typed landing fee or fuel
 *               surcharge line).
 *   'default' — an OPTIONAL catch-all an operator may set so that any kind
 *               without its own explicit row still exports (falls back to
 *               'default') instead of being refused. When neither a
 *               specific-kind row nor a 'default' row exists for a kind
 *               present on an invoice, the pure mapper
 *               (integrations/qbo/map-invoice.ts) refuses the export and
 *               lists the unmapped kinds — it NEVER silently lumps line
 *               items together.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 * UNIQUE (org_id, line_kind) — at most one QBO Item mapped per kind per org.
 *
 * [VERIFY-QB1-B]: the rate_schedule.rate_kind CHECK domain (migration 0019)
 * is FROZEN in this slice. A future slice could add dedicated kinds (e.g.
 * landing_fee, fuel_surcharge) as first-class rate kinds so those charges
 * get their own GL bucket instead of sharing 'flat'/'other' — additive
 * follow-up, not required here.
 *
 * ── Composite FKs (hand-written in migration 0021 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [qbo_account_mapping_org_id_fk]
 *   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     [qbo_account_mapping_created_by_org_fk] — creator must be a member of
 *     the same org; preserves creation attribution.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const qboAccountMapping = pgTable(
  'qbo_account_mapping',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // qbo_account_mapping_line_kind_check:
    //   'wet_hourly' | 'dry_hourly' | 'instruction' | 'flat' | 'other' | 'default'.
    lineKind: text('line_kind').notNull(),

    // The QBO Item id/name this kind maps to (an Income-account-backed Item
    // in the operator's own QBO company file). Both required.
    qboItemId: text('qbo_item_id').notNull(),
    qboItemName: text('qbo_item_name').notNull(),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0021.
    createdBy: uuid('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one QBO Item mapped per kind per org.
    uniqueIndex('qbo_account_mapping_org_line_kind_unique').on(t.orgId, t.lineKind),

    // Composite candidate key — consistent with all other tenant tables.
    uniqueIndex('qbo_account_mapping_id_org_id_unique').on(t.id, t.orgId),

    // Covers: full-mapping-table read for the settings card + the exporter.
    index('qbo_account_mapping_org_idx').on(t.orgId),
  ],
);

export type QboAccountMappingSelect = typeof qboAccountMapping.$inferSelect;
export type QboAccountMappingInsert = typeof qboAccountMapping.$inferInsert;
