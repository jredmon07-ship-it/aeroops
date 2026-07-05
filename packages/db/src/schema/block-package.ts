/**
 * block_package — operator-defined prepaid discounted-hour bundle offering
 * (Slice B4 — Block-time / prepaid packages).
 *
 * "Block time" (THE-BIBLE glossary) = a prepaid, discounted hour bundle a
 * member buys up front and draws down as they fly. A block_package row is
 * MASTER DATA (a reusable offering, like "10-hour Archer block") — a
 * block_purchase (block-purchase.ts) SNAPSHOTS hours + amount_cents at sale
 * time and holds no FK back that would let a later package edit retroactively
 * alter a historical sale.
 *
 * price_cents is INTEGER CENTS. NEVER a float. hours is a QUANTITY (flight
 * hours), NOT money — numeric(10,1), same precision as
 * invoice_line_item.quantity_hours. The effective discounted rate
 * (price_cents / hours) is DISPLAY ONLY, computed by the application layer —
 * never stored on this row.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 *
 * ── Composite FKs (hand-written in migration 0034 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [block_package_org_id_fk]
 *     Tenant spine — deleting an org cascades to its block packages.
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [block_package_created_by_org_fk]
 *     Creator must be a member of the same org. Write-once attribution.
 *     Targets app_user_id_org_id_unique from migration 0000.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * block_package_name_nonempty_check:
 *   char_length(btrim(name)) > 0
 *
 * block_package_hours_positive_check:
 *   hours > 0 — a QUANTITY, not money.
 *
 * block_package_price_positive_check:
 *   price_cents > 0 — INTEGER CENTS, never a float.
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — consumed by block_purchase(package_id, org_id)
 * composite FK and consistent with all other tenant tables.
 *
 * ── Index ─────────────────────────────────────────────────────────────────────
 * (org_id, active, name) — covers the active-packages list query:
 *   e.g. listBlockPackages: WHERE org_id = $1 AND active = true ORDER BY name
 *
 * [DEFERRED — v1, see docs/specs/slice-b4-block-time.md]: block expiry/refund,
 * family/shared blocks, selling a block through the Stripe rail.
 */
import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const blockPackage = pgTable(
  'block_package',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0034. The simple .references() here covers Drizzle-level
    // ergonomics; the hand-written FK provides named-constraint auditability.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // Human-readable offering name (e.g. "10-hour Archer block").
    // Must not be blank (block_package_name_nonempty_check).
    name: text('name').notNull(),

    // Prepaid hours in this bundle. numeric(10,1) — a QUANTITY, NOT money,
    // same precision as invoice_line_item.quantity_hours. Must be > 0
    // (block_package_hours_positive_check).
    hours: numeric('hours', { precision: 10, scale: 1 }).notNull(),

    // Price in integer cents. NEVER a float. Must be > 0
    // (block_package_price_positive_check). The effective discounted rate
    // (price_cents / hours) is DISPLAY ONLY — computed by the app layer,
    // never stored here.
    priceCents: integer('price_cents').notNull(),

    // Soft-retire flag. false = hidden from the default active-packages list
    // (listBlockPackages) but never deleted — history-preserving alternative
    // to a hard delete.
    active: boolean('active').notNull().default(true),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0034. Creator must be a member of the same org.
    createdBy: uuid('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consumed by block_purchase(package_id, org_id)
    // composite FK and consistent with all other tenant tables.
    uniqueIndex('block_package_id_org_id_unique').on(t.id, t.orgId),

    // Covers: active-packages list queries.
    // e.g. listBlockPackages: WHERE org_id = $1 AND active = true ORDER BY name
    index('block_package_org_active_name_idx').on(t.orgId, t.active, t.name),
  ],
);

export type BlockPackageSelect = typeof blockPackage.$inferSelect;
export type BlockPackageInsert = typeof blockPackage.$inferInsert;
