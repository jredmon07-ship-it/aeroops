/**
 * squawk — reports a maintenance discrepancy on an aircraft (or other resource).
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0008 invariant).
 *
 * Records posture (ADR-0008 §1.3):
 *   title / description / severity / reported_by / reported_at are write-once
 *   (set at creation, never mutated). Only status / resolution_notes /
 *   resolved_by / resolved_at / updated_at may change (via updateSquawkStatus).
 *   Transitions: open → resolved | open → deferred. No reopen path ([VERIFY-3b-D]).
 *
 * Severity is an operator triage label. 'grounding' does NOT auto-ground the
 * aircraft — that requires an explicit groundAircraft call. [VERIFY-3b-B]
 *
 * 'deferred' is a plain operator status with a reason string. It is NOT an
 * MEL/airworthiness construct. [VERIFY-3b-A]
 *
 * ── Composite FKs (hand-written in migration 0006 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE
 *     Tenant spine — deleting an org cascades to its squawks.
 *
 *   Composite FK (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT
 *     Aircraft must exist in the same org; hard-delete blocked while squawks exist.
 *
 *   Composite FK (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
 *     ON DELETE SET NULL — nullable; if the ticket is deleted the squawk record
 *     is preserved with dispatch_ticket_id = NULL.
 *     FK only — no meter access.
 *
 *   Composite FK (reported_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     Reporter must be a member of the same org.
 *
 *   Composite FK (resolved_by, org_id) → app_user(id, org_id) ON DELETE SET NULL
 *     Nullable; if the resolving user is deleted the record is preserved as NULL.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * squawk_title_nonempty_check:
 *   char_length(btrim(title)) > 0
 *
 * squawk_resolved_shape_check:
 *   status IN ('resolved','deferred') ⇒ resolved_at IS NOT NULL
 *   status = 'open'                   ⇒ resolved_by IS NULL AND resolved_at IS NULL
 *                                        AND resolution_notes IS NULL
 *   (resolved_by is intentionally NOT required non-null: it is ON DELETE SET NULL,
 *   so the resolver identity may be nulled on a user hard-delete. resolved_at +
 *   resolution_notes persist, and the durable "who" lives in audit_log.)
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — consumed by aircraft_grounding.squawk_id composite FK
 * (squawk_id, org_id) → squawk(id, org_id). Must be created before aircraft_grounding.
 * Mirrors the reservation / resource / dispatch_ticket pattern.
 *
 * ── Indexes ──────────────────────────────────────────────────────────────────
 * (org_id, resource_id, status) — covers open-count + per-aircraft list queries.
 * e.g. getOpenSquawkCounts: WHERE status='open' AND resource_id = ANY(...)
 *      listSquawks:          WHERE org_id = $1 AND resource_id = $2
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
import { squawkStatus, squawkSeverity } from './enums.js';

export const squawk = pgTable(
  'squawk',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0006. The simple .references() here covers Drizzle-level
    // ergonomics; the hand-written FK provides named-constraint auditability.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // resource_id carries no .references() — composite FK
    // (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0006.
    resourceId: uuid('resource_id').notNull(),

    // dispatch_ticket_id carries no .references() — composite FK
    // (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id) ON DELETE SET NULL
    // is hand-written in migration 0006. FK only — no meter access.
    dispatchTicketId: uuid('dispatch_ticket_id'),

    // Write-once fields (set at INSERT, never mutated by any code path).
    title: text('title').notNull(),
    description: text('description'),

    // severity is an operator triage label only; 'grounding' does NOT auto-ground.
    severity: squawkSeverity('severity').notNull(),

    // status default 'open'; transitions open→resolved | open→deferred only.
    status: squawkStatus('status').notNull().default('open'),

    // reported_by carries no .references() — composite FK
    // (reported_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0006. Write-once.
    reportedBy: uuid('reported_by').notNull(),

    // Write-once timestamp of the squawk report.
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),

    // Mutable resolution fields (NULL when status='open').
    // squawk_resolved_shape_check enforces the shape invariant per status.
    resolutionNotes: text('resolution_notes'),

    // resolved_by carries no .references() — composite FK
    // (resolved_by, org_id) → app_user(id, org_id) ON DELETE SET NULL
    // is hand-written in migration 0006.
    // [VERIFY-PHASE3/4] (compliance, Slice 3b): resolver identity may become NULL
    // after a user hard-delete; the durable "who" lives in audit_log. When Phase 3
    // (Training) or Phase 4 (Maintenance) attaches Part-43 / Part-141 sign-off
    // meaning to a resolution, preserve signer identity immutably (soft-delete
    // users, or snapshot the signer) — do NOT treat this SET-NULL column as the
    // sign-off record.
    resolvedBy: uuid('resolved_by'),

    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consumed by aircraft_grounding (squawk_id, org_id)
    // composite FK and consistent with all other tenant tables.
    // squawk table MUST be created before aircraft_grounding (migration order §1.5).
    uniqueIndex('squawk_id_org_id_unique').on(t.id, t.orgId),

    // Covers: open-count per resource + per-aircraft list.
    // e.g. getOpenSquawkCounts: WHERE status='open' AND resource_id = ANY(...)
    //      listSquawks: WHERE org_id = $1 [AND resource_id = $2] [AND status = $3]
    index('squawk_org_resource_status_idx').on(t.orgId, t.resourceId, t.status),
  ],
);

export type SquawkSelect = typeof squawk.$inferSelect;
export type SquawkInsert = typeof squawk.$inferInsert;
