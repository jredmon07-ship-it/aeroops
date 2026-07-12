/**
 * dispatch_service_log — append-only line-ops service events (oil / fuel uplift)
 * attached to a CLOSED dispatch ticket.
 *
 * ── Records posture ──────────────────────────────────────────────────────────
 * The FROZEN write-once close path (closeDispatch) is NEVER mutated. A line-ops
 * service reading is captured as a NEW row here, written by a SEPARATE,
 * best-effort follow-up command after check-in succeeds. The effective service
 * reading for a downstream consumer (the Aircraft report) is:
 *
 *   latest dispatch_service_log for this ticket ?? none
 *
 * Rows are immutable once inserted. A re-entry is a NEW row — the latest row
 * per ticket wins (ORDER BY created_at DESC LIMIT 1), exactly like a meter
 * correction. NO updated_at column (mirrors audit_log / dispatch_ticket_correction).
 *
 * ── Append-only enforcement (migration 0044) ─────────────────────────────────
 * The migration applies ONLY SELECT + INSERT RLS policies. No UPDATE or DELETE
 * policy exists. With FORCE ROW LEVEL SECURITY, the absence of a permissive
 * UPDATE/DELETE policy blocks those operations for ALL roles (including the
 * table owner as aeroops_app). GRANT is SELECT + INSERT only; an explicit
 * REVOKE UPDATE, DELETE is applied as a belt-and-suspenders backstop.
 *
 * ── Tenant scope ─────────────────────────────────────────────────────────────
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 *
 * ── Composite FKs (hand-written in migration 0044 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE
 *     Tenant spine — deleting an org cascades to its service logs. Also
 *     expressed via .references() on orgId for Drizzle-level ergonomics.
 *
 *   Composite FK (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
 *     ON DELETE RESTRICT — the service event must reference a ticket in the
 *     same org; a ticket with service rows cannot be hard-deleted.
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     Recorder must be a member of the same org; authoring identity persists.
 *
 * ── CHECKs ───────────────────────────────────────────────────────────────────
 * service_log_oil_bounds_check:  oil IS NULL OR (oil >= 0 AND oil <= 99)
 * service_log_fuel_bounds_check: fuel IS NULL OR (fuel >= 0 AND fuel <= 999)
 * service_log_note_length_check: note IS NULL OR char_length(note) <= 500
 * service_log_at_least_one_check: oil OR fuel OR note non-null (no-op rejected)
 *
 * ── Compliance note ──────────────────────────────────────────────────────────
 * OPERATOR LINE-OPS data (fuel/oil uplift). NOT a maintenance record, NOT a
 * Part-43/airworthiness determination, NOT a billing instrument.
 */
import {
  pgTable,
  uuid,
  timestamp,
  text,
  numeric,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const dispatchServiceLog = pgTable(
  'dispatch_service_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written in
    // migration 0044. The simple .references() here covers Drizzle ergonomics.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // dispatch_ticket_id carries no .references() — composite FK
    // (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id) RESTRICT is
    // hand-written in migration 0044. Targets dispatch_ticket_id_org_id_unique.
    dispatchTicketId: uuid('dispatch_ticket_id').notNull(),

    // Oil added (quarts). Nullable — a service log may record fuel and/or a
    // note only. Bounds enforced by service_log_oil_bounds_check.
    oilAddedQuarts: numeric('oil_added_quarts', { precision: 4, scale: 1 }),

    // Fuel added (gallons). Nullable. Bounds enforced by
    // service_log_fuel_bounds_check.
    fuelAddedGallons: numeric('fuel_added_gallons', { precision: 5, scale: 1 }),

    // Free-text operator note (length-capped by service_log_note_length_check).
    note: text('note'),

    // created_by carries no .references() — composite FK (created_by, org_id) →
    // app_user(id, org_id) RESTRICT is hand-written in migration 0044.
    createdBy: uuid('created_by').notNull(),

    // Append timestamp — immutable once set (no updated_at; mirrors audit_log).
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consistent with all tenant tables.
    uniqueIndex('dispatch_service_log_id_org_id_unique').on(t.id, t.orgId),

    // Covers: effective-service derivation — "latest service per ticket".
    index('service_log_org_ticket_created_idx').on(
      t.orgId,
      t.dispatchTicketId,
      t.createdAt,
    ),
  ],
);

export type DispatchServiceLogSelect = typeof dispatchServiceLog.$inferSelect;
export type DispatchServiceLogInsert = typeof dispatchServiceLog.$inferInsert;
