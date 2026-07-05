/**
 * block_purchase — APPEND-ONLY record of a member buying a block (Slice B4 —
 * Block-time / prepaid packages).
 *
 * A member bought a prepaid, discounted hour bundle — either from an
 * operator-defined block_package, or an ad-hoc hours+amount sale (package_id
 * NULL). hours + amount_cents are SNAPSHOTTED at sale time: a later edit to
 * the package (or its hard-deletion — not exposed by any command in this
 * slice, but the schema tolerates it via ON DELETE RESTRICT) never alters a
 * historical purchase row.
 *
 * Selling a block posts exactly ONE 'block_purchase' ledger_entry credit
 * (packages/api/src/billing/sell-block.ts) — the SAME B2 ledger recordManualPayment
 * posts a 'payment' credit to. This RAISES the member's derived balance
 * (computeBalance, @aeroops/core) — the "prepaid credit" a member draws down
 * as the existing invoice-finalize debit lowers it. [DEFERRED — v1, see
 * docs/specs/slice-b4-block-time.md]: this slice does NOT build a per-flight
 * hours-based discounted-rate drawdown — v1 tracks remaining prepaid credit
 * ONLY via the existing derived ledger balance.
 *
 * NO updated_at column — rows are immutable once inserted (mirrors
 * ledger_entry / audit_log / dispatch_ticket_correction).
 *
 * ── Append-only enforcement (migration 0034) ─────────────────────────────────
 * The migration applies ONLY SELECT + INSERT RLS policies. No UPDATE or
 * DELETE policy exists. With FORCE ROW LEVEL SECURITY, the absence of a
 * permissive policy blocks those operations for ALL roles (including the
 * table owner). GRANT is SELECT + INSERT only, with an explicit REVOKE
 * UPDATE, DELETE as a belt-and-suspenders backstop. A mistaken sale is
 * corrected with a NEW reversing credit_memo ledger_entry (forward seam),
 * never an edit to this row.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0034).
 *
 * ── Composite FKs (hand-written in migration 0034 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [block_purchase_org_id_fk]
 *
 *   Composite FK (user_id, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [block_purchase_user_org_fk]
 *     The buyer must be a user in the same org. RESTRICT preserves billing
 *     history (mirrors billing_account_user_org_fk).
 *
 *   Composite FK (package_id, org_id) → block_package(id, org_id)
 *     ON DELETE RESTRICT  [block_purchase_package_org_fk]
 *     Nullable: NULL for an ad-hoc (non-package) sale. Targets
 *     block_package_id_org_id_unique (migration 0034).
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [block_purchase_created_by_org_fk]
 *     The staff member who processed the sale must be in the same org.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * block_purchase_hours_positive_check:      hours > 0 (a QUANTITY, not money)
 * block_purchase_amount_positive_check:     amount_cents > 0 (INTEGER CENTS)
 *
 * ── Money boundary note ──────────────────────────────────────────────────────
 * amount_cents is INTEGER CENTS. NEVER a float. NO Stripe/card/bank data
 * anywhere in this table. This RECORDS that a member paid for a block
 * (operator-recorded, like recordManualPayment) — it does not itself move
 * money.
 */
import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const blockPurchase = pgTable(
  'block_purchase',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0034.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // user_id carries no .references() — composite FK
    // (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0034. The member who bought the block.
    userId: uuid('user_id').notNull(),

    // package_id carries no .references() — composite FK
    // (package_id, org_id) → block_package(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0034. Nullable: NULL = an ad-hoc sale
    // (no package involved).
    packageId: uuid('package_id'),

    // Hours in THIS purchase — SNAPSHOTTED at sale time (from the package, or
    // entered ad-hoc). numeric(10,1) — a QUANTITY, NOT money. Must be > 0
    // (block_purchase_hours_positive_check).
    hours: numeric('hours', { precision: 10, scale: 1 }).notNull(),

    // Amount paid, in integer cents — SNAPSHOTTED at sale time. NEVER a
    // float. Must be > 0 (block_purchase_amount_positive_check).
    amountCents: integer('amount_cents').notNull(),

    // Free-text operator note (e.g. "Paid by check #1042"). Nullable.
    note: text('note'),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0034. The staff member who processed the sale.
    createdBy: uuid('created_by').notNull(),

    // Append timestamp — immutable once set (no updated_at; mirrors ledger_entry).
    purchasedAt: timestamp('purchased_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consistent with all other tenant tables.
    uniqueIndex('block_purchase_id_org_id_unique').on(t.id, t.orgId),

    // Covers: a member's purchase history, newest first.
    // e.g. getMemberBlockSummary: WHERE org_id = $1 AND user_id = $2 ORDER BY purchased_at DESC
    index('block_purchase_org_user_purchased_idx').on(t.orgId, t.userId, t.purchasedAt),
  ],
);

export type BlockPurchaseSelect = typeof blockPurchase.$inferSelect;
export type BlockPurchaseInsert = typeof blockPurchase.$inferInsert;
