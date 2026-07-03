/**
 * maintenance_item — operator-defined maintenance-due tracking item on an
 * aircraft (or other resource). Slice P1.5.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 *
 * COMPLIANCE (HARD LINE — matches squawk.ts / work-order.ts precedent):
 *   A maintenance_item's due_value_hours / due_date / warn_* fields are
 *   OPERATOR-ENTERED tracking thresholds. This table stores NO computed
 *   FAA/Part-43/91.409 airworthiness or inspection-due DETERMINATION — the
 *   arithmetic that compares a threshold to a recorded meter/date lives in
 *   @aeroops/core's evaluateMaintenanceDue (pure, no DB access) and is
 *   likewise operator arithmetic, not a regulatory verdict. A mechanic/IA
 *   still makes the airworthiness call. [VERIFY-P1.5-A]
 *
 * NO completion-history table in this slice (deliberate, documented
 * deviation from the spec's optional maintenance_item_completion table):
 *   "mark serviced" (markMaintenanceItemServiced, packages/api/src/
 *   maintenance/mark-maintenance-item-serviced.ts) simply advances
 *   due_value_hours / due_date on this row via a guarded UPDATE + writes ONE
 *   audit_log row (action='maintenance_item.serviced', metadata carries the
 *   old + new threshold) — audit_log already gives durable, queryable
 *   servicing history without a second append-only table. Revisit if a
 *   dedicated completion-history UI/report is ever needed (DEFERRED forward
 *   seam, documented in docs/specs/slice-p1-maintenance-due.md).
 *
 * Records posture:
 *   org_id / resource_id / track_by / meter_basis / created_by are write-once
 *   (set at INSERT, never mutated). title / due_value_hours / due_date /
 *   warn_threshold_hours / warn_lead_days / notes are mutable (updateMaintenanceItem
 *   + markMaintenanceItemServiced). active is mutable (deactivateMaintenanceItem
 *   soft-delete only — hard-delete is structurally prevented, mirrors squawk/
 *   work_order: no DELETE command is built on this table).
 *
 * ── Composite FKs (hand-written in migration 0029 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE
 *     Tenant spine — deleting an org cascades to its maintenance items.
 *
 *   Composite FK (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT
 *     Aircraft must exist in the same org; hard-delete blocked while
 *     maintenance items exist (records integrity — mirrors squawk/work_order).
 *     Requires resource(id, org_id) composite candidate key
 *     "resource_id_org_id_unique" (established in migration 0002).
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     Creator must be a member of the same org; write-once attribution.
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * maintenance_item_title_nonempty_check:
 *   char_length(btrim(title)) > 0
 *
 * maintenance_item_track_by_check:
 *   track_by IN ('hours','date')
 *
 * maintenance_item_meter_basis_check:
 *   meter_basis IS NULL OR meter_basis IN ('hobbs','tach')
 *
 * maintenance_item_shape_check — THE structural guarantee (mirrors
 * squawk_resolved_shape_check / work_order_completed_shape_check):
 *   track_by='hours' ⇒ meter_basis NOT NULL AND due_value_hours NOT NULL
 *                       AND due_date IS NULL
 *   track_by='date'  ⇒ meter_basis IS NULL AND due_value_hours IS NULL
 *                       AND due_date NOT NULL
 *
 * maintenance_item_due_value_nonneg_check:
 *   due_value_hours IS NULL OR due_value_hours >= 0
 *
 * maintenance_item_warn_threshold_nonneg_check:
 *   warn_threshold_hours IS NULL OR warn_threshold_hours >= 0
 *
 * maintenance_item_warn_lead_days_nonneg_check:
 *   warn_lead_days IS NULL OR warn_lead_days >= 0
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — consistent with all other tenant tables.
 *
 * ── Indexes ──────────────────────────────────────────────────────────────────
 * (org_id, resource_id, active) — covers per-aircraft + org-wide active-item
 *   list queries (listMaintenanceDue).
 */
import {
  pgTable,
  uuid,
  timestamp,
  text,
  numeric,
  integer,
  boolean,
  date,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const maintenanceItem = pgTable(
  'maintenance_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0029. The simple .references() here covers Drizzle-level
    // ergonomics; the hand-written FK provides named-constraint auditability.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // resource_id carries no .references() — composite FK
    // (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0029. Write-once.
    resourceId: uuid('resource_id').notNull(),

    // Write-once human-readable label (e.g. "Annual inspection", "100-hour").
    // Must not be blank (maintenance_item_title_nonempty_check).
    title: text('title').notNull(),

    // 'hours' | 'date'. TEXT + CHECK (not a pgEnum) — mirrors
    // rate_schedule.rate_kind's additive/reversible-value-domain posture.
    // Write-once (structural: switching basis mid-life would silently
    // invalidate the existing due_value_hours/due_date pairing).
    trackBy: text('track_by').notNull(),

    // 'hobbs' | 'tach', required iff track_by='hours'; NULL iff track_by='date'.
    // Write-once. Which recorded meter (DISPLAY-ONLY read, never recomputed)
    // this item is measured against.
    meterBasis: text('meter_basis'),

    // The meter reading at which this item becomes due. numeric(10,1) —
    // same precision discipline as dispatch_ticket.hobbs_in/tach_in.
    // Mutable (updateMaintenanceItem correction; markMaintenanceItemServiced
    // advances it). Required iff track_by='hours'.
    dueValueHours: numeric('due_value_hours', { precision: 10, scale: 1 }),

    // The calendar date at which this item becomes due. date/mode:'string'
    // (no time-of-day — matches @aeroops/core's DST-agnostic calendar-day
    // arithmetic). Mutable. Required iff track_by='date'.
    dueDate: date('due_date', { mode: 'string' }),

    // Optional lead: warn when the remaining hours <= this value.
    warnThresholdHours: numeric('warn_threshold_hours', { precision: 10, scale: 1 }),

    // Optional lead: warn when the remaining days <= this value.
    warnLeadDays: integer('warn_lead_days'),

    // Free-text operator notes. NOT a Part-43 logbook entry.
    notes: text('notes'),

    // Soft-delete flag. deactivateMaintenanceItem sets false; no hard-delete
    // command exists on this table (mirrors squawk/work_order posture).
    active: boolean('active').notNull().default(true),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0029. Write-once.
    createdBy: uuid('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consistent with all other tenant tables.
    uniqueIndex('maintenance_item_id_org_id_unique').on(t.id, t.orgId),

    // Covers: per-aircraft + org-wide active-item list queries.
    // e.g. listMaintenanceDue: WHERE org_id=$1 [AND resource_id=$2] AND active=true
    index('maintenance_item_org_resource_active_idx').on(t.orgId, t.resourceId, t.active),
  ],
);

export type MaintenanceItemSelect = typeof maintenanceItem.$inferSelect;
export type MaintenanceItemInsert = typeof maintenanceItem.$inferInsert;
