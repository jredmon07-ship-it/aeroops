/**
 * aircraft_grounding — append-only event table recording aircraft grounding
 * and release events.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0008 invariant).
 *
 * ── Event-sourced, append-only ───────────────────────────────────────────────
 * Current state = the latest event per aircraft, resolved by:
 *   DISTINCT ON (resource_id) ORDER BY resource_id, created_at DESC, id DESC
 * There is NO updated_at column — rows are immutable once written. Mutations
 * are expressed as new events ('grounded' or 'released'). This is required by
 * the ADR-0007 audit discipline extended to maintenance records.
 *
 * Grounding is operator data, NEVER a computed FAR/Part-91/43 reg verdict.
 * The software makes no airworthiness determination. [VERIFY-3b-H]
 *
 * ── Composite FKs (hand-written in migration 0006 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE
 *     Tenant spine — deleting an org cascades to its grounding events.
 *
 *   Composite FK (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT
 *     Aircraft must exist in the same org; hard-delete blocked while events exist.
 *
 *   Composite FK (squawk_id, org_id) → squawk(id, org_id) ON DELETE SET NULL
 *     Nullable; grounding may optionally reference the triggering squawk.
 *     If the squawk is deleted the event is preserved with squawk_id = NULL.
 *     Requires squawk(id, org_id) UNIQUE "squawk_id_org_id_unique" — created
 *     in the same migration (squawk table must precede aircraft_grounding).
 *
 *   Composite FK (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
 *     ON DELETE SET NULL — nullable; if the ticket is deleted the event is
 *     preserved with dispatch_ticket_id = NULL. FK only — no meter access.
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     Creator must be a member of the same org.
 *
 * ── CHECK ─────────────────────────────────────────────────────────────────────
 * aircraft_grounding_reason_check:
 *   state = 'grounded' ⇒ char_length(btrim(reason)) > 0
 *   (Release-reason is optional — audit trail suffices. [VERIFY-3b-C])
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — forward-compat for future composite FKs, consistent
 * with all other tenant tables.
 *
 * ── Indexes ──────────────────────────────────────────────────────────────────
 * (org_id, resource_id, created_at DESC) — covers the "latest event per aircraft"
 * query pattern:
 *   DISTINCT ON (resource_id)
 *   WHERE org_id = $1 AND resource_id = ANY(...)
 *   ORDER BY resource_id, created_at DESC, id DESC
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
import { groundingState } from './enums.js';

export const aircraftGrounding = pgTable(
  'aircraft_grounding',
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

    // 'grounded' or 'released'. Current state = latest event per aircraft.
    state: groundingState('state').notNull(),

    // Reason is required when state='grounded' (aircraft_grounding_reason_check).
    // When state='released' reason may be empty or blank — optional ([VERIFY-3b-C]).
    reason: text('reason').notNull(),

    // squawk_id carries no .references() — composite FK
    // (squawk_id, org_id) → squawk(id, org_id) ON DELETE SET NULL
    // is hand-written in migration 0006.
    // Requires squawk(id, org_id) UNIQUE (migration 0006 creates squawk first).
    squawkId: uuid('squawk_id'),

    // dispatch_ticket_id carries no .references() — composite FK
    // (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id) ON DELETE SET NULL
    // is hand-written in migration 0006. FK only — no meter access.
    dispatchTicketId: uuid('dispatch_ticket_id'),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0006.
    createdBy: uuid('created_by').notNull(),

    // Immutable timestamp. NO updated_at — this table is append-only.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — forward-compat for future composite FKs.
    // Consistent with all other tenant tables.
    uniqueIndex('aircraft_grounding_id_org_id_unique').on(t.id, t.orgId),

    // Covers: "latest event per aircraft" query.
    // DISTINCT ON (resource_id) WHERE org_id = $1 AND resource_id = ANY(...)
    // ORDER BY resource_id, created_at DESC, id DESC
    // Note: DESC is a logical/query-plan concern; Drizzle index() creates ASC by
    // default. The DESC ordering is expressed in the query ORDER BY, not the index.
    // A standard ascending index on (org_id, resource_id, created_at) is sufficient
    // for the planner to efficiently resolve the DISTINCT ON + ORDER BY pattern.
    index('aircraft_grounding_org_resource_created_idx').on(
      t.orgId,
      t.resourceId,
      t.createdAt,
    ),
  ],
);

export type AircraftGroundingSelect = typeof aircraftGrounding.$inferSelect;
export type AircraftGroundingInsert = typeof aircraftGrounding.$inferInsert;
