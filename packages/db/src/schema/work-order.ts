/**
 * work_order — records a maintenance task on an aircraft (or other resource).
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 *
 * Records posture (Slice M1.1):
 *   resource_id / title / description / opened_by / opened_at are write-once
 *   (set at INSERT, never mutated). status transitions are guarded by the API
 *   layer (open → in_progress → completed | cancelled). work_performed may be
 *   updated while open/in_progress; it is write-once once the record reaches
 *   completed or cancelled. squawk_id is write-once (linked at creation only).
 *
 * Compliance posture (HARD COMPLIANCE LINE — §M1.1):
 *   A work order, its sign-off, and 'completed' status are OPERATOR DATA /
 *   data entry. The software computes/asserts NO airworthiness,
 *   return-to-service (§43.9/§43.11), AD compliance, inspection currency
 *   (annual/100-hr/§91.409), or MEL status.
 *
 *   [VERIFY-M1-A] completed ≠ RTS: 'completed' is an operator content-state
 *     flag; it is NOT an FAA return-to-service or airworthiness determination.
 *   [VERIFY-M1-B] No reopen: completed/cancelled are terminal; no reopen path.
 *     Confirm this posture is acceptable.
 *   [VERIFY-M1-C] sign-off ≠ e-signature: signed_off_by is an application
 *     user FK, NOT a cryptographic signature or Part-43 regulatory sign-off.
 *     signed_off_by ON DELETE SET NULL ("signed_off_by") — only that column is
 *     nulled; org_id (NOT NULL) is preserved. The durable "who signed" lives in
 *     audit_log, NOT this column.
 *   [VERIFY-M1-D] Unground is an explicit operator action (affirmative box in
 *     completeWorkOrder), governed by the only-if-matching-basis rule. It is
 *     NOT a computed clearance or airworthiness determination.
 *   [VERIFY-M1-E] fleet-reader (fleet:access) read exposure: open work orders
 *     surface on the fleet detail page. Confirm the set of roles intended to see
 *     maintenance data in the fleet context.
 *
 * ── Composite FKs (hand-written in migration 0013 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [work_order_org_id_fk]
 *     Tenant spine — deleting an org cascades to its work orders.
 *
 *   Composite FK (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT
 *     [work_order_resource_org_fk]
 *     Aircraft must exist in the same org. Hard-delete blocked while work orders
 *     exist (records integrity; mirrors squawk + dispatch_ticket patterns).
 *     Requires resource(id, org_id) composite candidate key
 *     "resource_id_org_id_unique" (established in migration 0002).
 *
 *   Composite FK (squawk_id, org_id) → squawk(id, org_id)
 *     ON DELETE SET NULL ("squawk_id")  [work_order_squawk_org_fk]
 *     Nullable: WO optionally linked to a squawk on the SAME aircraft (validated
 *     at openWorkOrder; never cross-aircraft). If the squawk is deleted the WO
 *     record is preserved with squawk_id = NULL. Column-list SET NULL nulls ONLY
 *     squawk_id — org_id (NOT NULL) is preserved.
 *     Requires squawk(id, org_id) composite candidate key
 *     "squawk_id_org_id_unique" (established in migration 0006).
 *
 *   Composite FK (opened_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     [work_order_opened_by_org_fk]
 *     Opener must be a member of the same org. Write-once attribution; preserves
 *     the creation record.
 *     Targets app_user_id_org_id_unique from migration 0000.
 *
 *   Composite FK (signed_off_by, org_id) → app_user(id, org_id)
 *     ON DELETE SET NULL ("signed_off_by")  [work_order_signed_off_by_org_fk]
 *     Nullable (NULL when open/in_progress). Column-list SET NULL nulls ONLY
 *     signed_off_by — org_id (NOT NULL) is preserved. The durable "who signed"
 *     lives in audit_log. [VERIFY-M1-C]
 *     Targets app_user_id_org_id_unique from migration 0000.
 *     NOTE: signed_off_by intentionally NOT required non-null in the
 *     work_order_completed_shape_check — mirrors squawk_resolved_shape_check.
 *     FORWARD-CONSUMER WARNING [VERIFY-M1-C]: any Phase-4+ consumer that attaches
 *     Part-43 / A&P-IA / return-to-service meaning to this sign-off MUST preserve
 *     signer identity IMMUTABLY (soft-delete users, or snapshot the signer) — do
 *     NOT treat this SET-NULL column as the sign-off record; the durable "who"
 *     is the audit_log row. Mirrors squawk.resolved_by / lesson_record.voided_by.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * work_order_title_nonempty_check:
 *   char_length(btrim(title)) > 0
 *
 * work_order_completed_shape_check:
 *   status = 'completed'             ⇒ signed_off_at IS NOT NULL
 *   status = 'cancelled'             ⇒ cancelled_at IS NOT NULL
 *   status IN ('open', 'in_progress') ⇒
 *     signed_off_by IS NULL AND signed_off_at IS NULL AND sign_off_notes IS NULL
 *     AND cancelled_reason IS NULL AND cancelled_at IS NULL
 *   (signed_off_by intentionally NOT required non-null in the completed arm:
 *   it is ON DELETE SET NULL; signer identity may be nulled on a user hard-delete.
 *   signed_off_at + sign_off_notes persist, and the durable "who" lives in
 *   audit_log. Mirrors squawk_resolved_shape_check in migration 0006.)
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — forward-compat for future composite FKs that may
 * reference work_order(id, org_id). Consistent with all tenant tables.
 * NOTE: no one-open partial-UNIQUE — multiple open WOs per aircraft are
 * legitimate (maintenance can run in parallel).
 *
 * ── Indexes ──────────────────────────────────────────────────────────────────
 * (org_id, resource_id, status) — covers open-count + per-aircraft list queries.
 * (org_id, squawk_id)           — covers squawk-linked WO lookup.
 */
import {
  pgTable,
  uuid,
  timestamp,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';
import { workOrderStatus } from './enums.js';

export const workOrder = pgTable(
  'work_order',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0013. The simple .references() here covers Drizzle-level
    // ergonomics; the hand-written FK provides named-constraint auditability.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // resource_id (the aircraft) carries no .references() — composite FK
    // (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0013. Write-once.
    resourceId: uuid('resource_id').notNull(),

    // squawk_id carries no .references() — composite FK
    // (squawk_id, org_id) → squawk(id, org_id) ON DELETE SET NULL ("squawk_id")
    // is hand-written in migration 0013. Column-list SET NULL: only squawk_id
    // is nulled; org_id (NOT NULL) is preserved. Write-once (linked at creation).
    // The linked squawk MUST be on the same aircraft (enforced at openWorkOrder).
    squawkId: uuid('squawk_id'),

    // Write-once title of the work order. Must not be blank (nonempty CHECK).
    title: text('title').notNull(),

    // Optional write-once free-text description of the work needed.
    description: text('description'),

    // Work order lifecycle status. Default 'open' at creation.
    // Transitions (API-enforced): open→in_progress | open→completed |
    //   open→cancelled | in_progress→completed | in_progress→cancelled.
    // completed + cancelled are terminal — no reopen path. [VERIFY-M1-B]
    status: workOrderStatus('status').notNull().default('open'),

    // Free-text record of work performed. Mutable while open/in_progress;
    // write-once once completed or cancelled (no silent mutation after terminal).
    workPerformed: text('work_performed'),

    // opened_by carries no .references() — composite FK
    // (opened_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0013. Write-once.
    openedBy: uuid('opened_by').notNull(),

    // Write-once timestamp of work order creation.
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),

    // signed_off_by carries no .references() — composite FK
    // (signed_off_by, org_id) → app_user(id, org_id) ON DELETE SET NULL ("signed_off_by")
    // is hand-written in migration 0013. Nullable: NULL when open/in_progress.
    // Column-list SET NULL: only signed_off_by is nulled; org_id (NOT NULL)
    // is preserved. [VERIFY-M1-C]: NOT an e-signature or Part-43 sign-off.
    signedOffBy: uuid('signed_off_by'),

    // Timestamp of sign-off. Required when completed (work_order_completed_shape_check).
    signedOffAt: timestamp('signed_off_at', { withTimezone: true }),

    // Free-text sign-off notes (operator/mechanic annotation). NULL when not completed.
    // NOT a Part-43 logbook entry. [VERIFY-M1-A/C]
    signOffNotes: text('sign_off_notes'),

    // Cancellation reason (required at API layer when cancelling; NULL until then).
    cancelledReason: text('cancelled_reason'),

    // Timestamp of cancellation. Required when cancelled (work_order_completed_shape_check).
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — forward-compat for future composite FKs and
    // consistent with all other tenant tables.
    uniqueIndex('work_order_id_org_id_unique').on(t.id, t.orgId),

    // Covers: open-count per resource + per-aircraft list queries.
    // e.g. listWorkOrders: WHERE org_id=$1 [AND resource_id=$2] [AND status=$3]
    //      assembleAircraftDetail: WHERE org_id=$1 AND resource_id=$2 AND status='open'
    index('work_order_org_resource_status_idx').on(t.orgId, t.resourceId, t.status),

    // Covers: squawk-linked WO lookup (getWorkOrderDetail join; squawk resolve check).
    // e.g. WHERE org_id=$1 AND squawk_id=$2
    index('work_order_org_squawk_idx').on(t.orgId, t.squawkId),
  ],
);

export type WorkOrderSelect = typeof workOrder.$inferSelect;
export type WorkOrderInsert = typeof workOrder.$inferInsert;
