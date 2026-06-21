/**
 * invoice_line_item — an individual charge line on a billing invoice.
 *
 * Operator billing RECORDS. Money stored as INTEGER CENTS (unit_amount_cents,
 * line_total_cents). quantity_hours uses numeric(10,1) for flight-hour
 * granularity — this is the ONLY non-integer numeric field; it is NOT money.
 * NEVER floats for money. NO Stripe or card data. NO payment processing.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 *
 * Each line item belongs to one invoice and records one charge: description,
 * quantity (in hours, 1 decimal place), unit price (cents), and line total
 * (cents). An optional rate_schedule_id records which rate was used, but the
 * amounts are snapshotted at creation so that later rate changes do not
 * retroactively alter historical invoices.
 *
 * ── Audited / append-only posture ────────────────────────────────────────────
 * Line items on a finalized invoice are immutable (command layer enforces this
 * by rejecting mutations once invoice.status = 'finalized'). Corrections to
 * finalized invoices are expressed as void + re-invoice or credit memo (Phase-2
 * B5 / credit-memo slice). No updated_at column — rows are treated as immutable
 * once the parent invoice is finalized. Created_at is the audit timestamp.
 *
 * ── Composite FKs (hand-written in migration 0019 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [invoice_line_item_org_id_fk]
 *     Tenant spine — deleting an org cascades to its line items.
 *
 *   Composite FK (invoice_id, org_id) → invoice(id, org_id)
 *     ON DELETE RESTRICT  [invoice_line_item_invoice_org_fk]
 *     Line items must belong to an invoice in the same org. RESTRICT prevents
 *     hard-deleting an invoice that has line items (records integrity; the
 *     command layer voids invoices rather than deleting them).
 *     Targets invoice_id_org_id_unique (migration 0019, earlier in same script).
 *
 *   Composite FK (rate_schedule_id, org_id) → rate_schedule(id, org_id)
 *     ON DELETE RESTRICT  [invoice_line_item_rate_schedule_org_fk]
 *     Nullable: NULL when the line is manually entered without a rate schedule.
 *     When present, the rate must exist in the same org. RESTRICT prevents
 *     deleting a rate schedule that has been referenced by line items (billing
 *     history must be preserved).
 *     Targets rate_schedule_id_org_id_unique (migration 0019, earlier in same script).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * invoice_line_item_description_nonempty_check:
 *   char_length(btrim(description)) > 0
 *
 * invoice_line_item_quantity_nonneg_check:
 *   quantity_hours >= 0
 *   numeric(10,1) flight hours — must be non-negative.
 *
 * invoice_line_item_unit_amount_nonneg_check:
 *   unit_amount_cents >= 0
 *   Integer cents — must be non-negative.
 *
 * invoice_line_item_line_total_nonneg_check:
 *   line_total_cents >= 0
 *   Integer cents — must be non-negative. Computed by command layer from
 *   quantity_hours × unit_amount_cents (rounded to whole cents); stored here
 *   as a snapshot for auditability.
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — forward-compat for future composite FKs and
 * consistent with all other tenant tables.
 *
 * ── Index ─────────────────────────────────────────────────────────────────────
 * (org_id, invoice_id) — covers line-item list for an invoice:
 *   e.g. getInvoiceLineItems: WHERE org_id = $1 AND invoice_id = $2
 *
 * ── Money precision note ─────────────────────────────────────────────────────
 * quantity_hours: numeric(10,1) — flight-hour granularity (e.g. 1.5 hours).
 *   This is NOT money; it is a quantity counter. Mirrors dispatch_ticket meter
 *   precision (ADR-0007).
 * unit_amount_cents: integer — the per-hour (or flat) rate in cents. NEVER float.
 * line_total_cents: integer — snapshotted total in cents. NEVER float.
 *   Command layer: line_total = Math.round(quantity_hours × unit_amount_cents).
 *   [VERIFY-B-MONEY-1]: confirm rounding policy with compliance.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const invoiceLineItem = pgTable(
  'invoice_line_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0019. The simple .references() here covers Drizzle-level
    // ergonomics; the hand-written FK provides named-constraint auditability.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // invoice_id carries no .references() — composite FK
    // (invoice_id, org_id) → invoice(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0019.
    invoiceId: uuid('invoice_id').notNull(),

    // Human-readable description of this charge line.
    // Must not be blank (invoice_line_item_description_nonempty_check).
    description: text('description').notNull(),

    // Quantity in flight hours. numeric(10,1) — same precision as dispatch_ticket
    // meters (ADR-0007). This is a QUANTITY, not money. Must be >= 0.
    // invoice_line_item_quantity_nonneg_check enforces non-negativity.
    quantityHours: numeric('quantity_hours', { precision: 10, scale: 1 }).notNull(),

    // Unit price in integer cents (the per-hour rate or flat amount). Must be >= 0.
    // invoice_line_item_unit_amount_nonneg_check enforces non-negativity.
    unitAmountCents: integer('unit_amount_cents').notNull(),

    // Snapshotted line total in integer cents. Must be >= 0.
    // Computed by the command layer (Math.round(quantity_hours × unit_amount_cents)).
    // Stored as a snapshot for auditability of the billed amount at issuance time.
    // invoice_line_item_line_total_nonneg_check enforces non-negativity.
    lineTotalCents: integer('line_total_cents').notNull(),

    // rate_schedule_id carries no .references() — composite FK
    // (rate_schedule_id, org_id) → rate_schedule(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0019. Nullable: NULL for manual line items.
    rateScheduleId: uuid('rate_schedule_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — forward-compat for future composite FKs and
    // consistent with all other tenant tables.
    uniqueIndex('invoice_line_item_id_org_id_unique').on(t.id, t.orgId),

    // Covers: fetch all line items for an invoice.
    // e.g. getInvoiceLineItems: WHERE org_id = $1 AND invoice_id = $2
    index('invoice_line_item_org_invoice_idx').on(t.orgId, t.invoiceId),
  ],
);

export type InvoiceLineItemSelect = typeof invoiceLineItem.$inferSelect;
export type InvoiceLineItemInsert = typeof invoiceLineItem.$inferInsert;
