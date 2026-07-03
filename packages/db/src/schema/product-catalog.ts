/**
 * product_catalog — operator-defined price list of non-flight goods and
 * services (headsets, charts, fuel, merchandise). Slice P2 (POS / counter
 * sales).
 *
 * Operator billing RECORDS. Money stored as INTEGER CENTS (unit_price_cents).
 * NEVER floats. NO Stripe or card data. NO payment processing.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 *
 * A product_catalog row is a reusable price-list entry — MASTER DATA, not a
 * billing record. A counter sale (packages/api/src/billing/counter-sale.ts)
 * SNAPSHOTS a catalog item's name + unit_price_cents into an invoice_line_item
 * at sale time (exactly like generate-invoice.ts snapshots a rate_schedule's
 * amount), so a later price change or even a hard-delete of the catalog item
 * never retroactively alters a historical sale.
 *
 * COMPLIANCE: category/sku are FREE-TEXT operator labels — NOT a tax class,
 * NOT a regulatory classification. This slice computes NO tax.
 * [VERIFY-P2-A]: sales-tax collection/remittance posture is deferred.
 *
 * ── Composite FKs (hand-written in migration 0031 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [product_catalog_org_id_fk]
 *     Tenant spine — deleting an org cascades to its catalog items.
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [product_catalog_created_by_org_fk]
 *     Creator must be a member of the same org. Write-once attribution.
 *     Targets app_user_id_org_id_unique from migration 0000.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * product_catalog_name_nonempty_check:
 *   char_length(btrim(name)) > 0
 *
 * product_catalog_unit_price_positive_check:
 *   unit_price_cents > 0
 *   Integer cents — must be strictly positive (a catalog item is always
 *   priced; a $0 item is not a valid catalog entry — use an ad-hoc line for
 *   a comped item on a sale instead).
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — consistent with all other tenant tables.
 *
 * ── Index ─────────────────────────────────────────────────────────────────────
 * (org_id, active, name) — covers the active-items list query:
 *   e.g. listProductCatalogItems: WHERE org_id = $1 AND active = true ORDER BY name
 *
 * ── Money boundary note ──────────────────────────────────────────────────────
 * unit_price_cents is an INTEGER (cents). NEVER a float/numeric for money.
 * A sale's line total is computed by the pure `computeCounterSaleLineTotal`
 * (@aeroops/core) — an EXACT integer product (quantity × unitPriceCents), no
 * rounding, no float step. No inventory-on-hand decrement in this slice
 * (DEFERRED — P3).
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

export const productCatalog = pgTable(
  'product_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0031. The simple .references() here covers Drizzle-level
    // ergonomics; the hand-written FK provides named-constraint auditability.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // Human-readable item name (e.g. "David Clark H10-13.4 Headset").
    // Must not be blank (product_catalog_name_nonempty_check).
    name: text('name').notNull(),

    // Price in integer cents. NEVER a float. Must be > 0.
    // product_catalog_unit_price_positive_check enforces strict positivity.
    unitPriceCents: integer('unit_price_cents').notNull(),

    // FREE-TEXT operator label — NOT a barcode-scanner identity, NOT a tax
    // class. Nullable.
    sku: text('sku'),

    // FREE-TEXT operator label (e.g. "Headsets", "Charts", "Fuel", "Merch").
    // Nullable. NOT a managed taxonomy in this slice.
    category: text('category'),

    // Soft-retire flag. false = hidden from the default active-items list
    // (listProductCatalogItems) but never deleted — history-preserving
    // alternative to deleteProductCatalogItem.
    active: boolean('active').notNull().default(true),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0031. Creator must be a member of the same org.
    createdBy: uuid('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consistent with all other tenant tables.
    uniqueIndex('product_catalog_id_org_id_unique').on(t.id, t.orgId),

    // Covers: active-items list queries.
    // e.g. listProductCatalogItems: WHERE org_id = $1 AND active = true ORDER BY name
    index('product_catalog_org_active_name_idx').on(t.orgId, t.active, t.name),
  ],
);

export type ProductCatalogSelect = typeof productCatalog.$inferSelect;
export type ProductCatalogInsert = typeof productCatalog.$inferInsert;
