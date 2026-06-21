/**
 * invoice — records a billing invoice for a member/renter.
 *
 * Operator billing RECORDS. Money stored as INTEGER CENTS (subtotal_cents,
 * total_cents). NEVER floats. NO Stripe or card data. NO payment processing.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 *
 * An invoice is created in 'draft' status, optionally linked to a dispatch
 * ticket (the source flight). Once finalized it must have issued_at set
 * (invoice_finalized_shape_check). 'void' = cancelled, never deleted.
 *
 * Immutability of finalized invoices is enforced in the command layer
 * (Phase-2 B1 api) — the DB schema does not enforce the "no mutation after
 * finalize" rule via CHECK (that would require a trigger); the command layer
 * checks status before any update.
 *
 * ── Audited / append-only posture ────────────────────────────────────────────
 * Invoices are audited records. Status transitions are write-logged via
 * audit_log (command layer). 'void' is a terminal state — voided invoices are
 * never hard-deleted (records integrity, mirrors ADR-0015).
 *
 * ── Composite FKs (hand-written in migration 0019 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [invoice_org_id_fk]
 *     Tenant spine — deleting an org cascades to its invoices.
 *
 *   Composite FK (member_user_id, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [invoice_member_user_org_fk]
 *     Member must be a user in the same org. RESTRICT prevents deleting a user
 *     who has invoices (records integrity — billing records must be preserved).
 *     Targets app_user_id_org_id_unique from migration 0000.
 *
 *   Composite FK (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
 *     ON DELETE RESTRICT  [invoice_dispatch_ticket_org_fk]
 *     Nullable: NULL when invoice is not linked to a dispatch flight.
 *     When present, prevents deleting a dispatch ticket that has an invoice
 *     (records integrity). Targets dispatch_ticket_id_org_id_unique (migration 0005).
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [invoice_created_by_org_fk]
 *     Creator must be a member of the same org. RESTRICT preserves attribution.
 *     Targets app_user_id_org_id_unique from migration 0000.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * invoice_status_check:
 *   status IN ('draft','finalized','void')
 *
 * invoice_subtotal_nonneg_check:
 *   subtotal_cents >= 0
 *
 * invoice_total_nonneg_check:
 *   total_cents >= 0
 *
 * invoice_finalized_shape_check:
 *   status = 'finalized' ⇒ issued_at IS NOT NULL
 *   (draft and void may have issued_at NULL)
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — consumed by invoice_line_item(invoice_id, org_id)
 * composite FK and consistent with all other tenant tables.
 *
 * ── Indexes ──────────────────────────────────────────────────────────────────
 * (org_id, status, created_at DESC) — covers list-invoices-by-status queries:
 *   e.g. listInvoices: WHERE org_id = $1 AND status = $2 ORDER BY created_at DESC
 * (org_id, member_user_id) — covers per-member invoice history:
 *   e.g. getMemberInvoices: WHERE org_id = $1 AND member_user_id = $2
 *
 * ── [VERIFY-B2-PORTAL] ────────────────────────────────────────────────────────
 * A renter must see ONLY their own invoices (intra-org self-scope on top of
 * org-level RLS, mirroring the P1 portal pattern). Adversarially test before
 * portal invoice view goes live.
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

export const invoice = pgTable(
  'invoice',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0019. The simple .references() here covers Drizzle-level
    // ergonomics; the hand-written FK provides named-constraint auditability.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // member_user_id carries no .references() — composite FK
    // (member_user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0019.
    memberUserId: uuid('member_user_id').notNull(),

    // Invoice lifecycle status. Default 'draft' at creation.
    // Transitions (API-enforced): draft→finalized | draft→void | finalized→void.
    // 'void' is terminal — voided invoices are never hard-deleted.
    // invoice_status_check: 'draft' | 'finalized' | 'void'.
    // TEXT + CHECK (not pgEnum) for additive/reversible value domain.
    status: text('status').notNull().default('draft'),

    // Sum of all line items before adjustments, in integer cents. >= 0.
    subtotalCents: integer('subtotal_cents').notNull().default(0),

    // Final amount owed (after any operator adjustments), in integer cents. >= 0.
    totalCents: integer('total_cents').notNull().default(0),

    // dispatch_ticket_id carries no .references() — composite FK
    // (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0019. Nullable: NULL when not linked to a flight.
    dispatchTicketId: uuid('dispatch_ticket_id'),

    // Timestamp the invoice was issued. Required when finalized.
    // invoice_finalized_shape_check: status='finalized' ⇒ issued_at IS NOT NULL.
    issuedAt: timestamp('issued_at', { withTimezone: true }),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0019.
    createdBy: uuid('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consumed by invoice_line_item(invoice_id, org_id)
    // composite FK and consistent with all other tenant tables.
    uniqueIndex('invoice_id_org_id_unique').on(t.id, t.orgId),

    // Covers: list-invoices-by-status with created_at ordering.
    // e.g. listInvoices: WHERE org_id = $1 [AND status = $2] ORDER BY created_at DESC
    index('invoice_org_status_created_idx').on(t.orgId, t.status, t.createdAt),

    // Covers: per-member invoice history.
    // e.g. getMemberInvoices: WHERE org_id = $1 AND member_user_id = $2
    index('invoice_org_member_idx').on(t.orgId, t.memberUserId),
  ],
);

export type InvoiceSelect = typeof invoice.$inferSelect;
export type InvoiceInsert = typeof invoice.$inferInsert;
