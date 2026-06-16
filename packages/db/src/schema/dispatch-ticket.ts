/**
 * dispatch_ticket — records the check-out and check-in of an aircraft.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0007 invariant 6).
 *
 * A dispatch ticket has two events:
 *   OPEN (check-out): records hobbs_out / tach_out + pilot + resource.
 *   CLOSE (check-in): records hobbs_in / tach_in + derived flight_time_hours.
 * A third transition (VOID) abandons a mistaken check-out while still open.
 *
 * ── Records posture (ADR-0007 §1) ───────────────────────────────────────────
 * Meters are write-once once recorded (hobbs_out/tach_out at OPEN, the _in
 * columns at CLOSE). The only mutable columns are status (open→closed or
 * open→voided), closed_by, closed_at, and updated_at. No code path UPDATEs a
 * recorded meter value. Corrections require a future dispatch_ticket_correction
 * append-only table — NOT in 3a.
 *
 * ── One-open backstop (ADR-0007 §2) ─────────────────────────────────────────
 * A partial UNIQUE index on (resource_id) WHERE (status='open') enforces the
 * invariant "at most one open ticket per aircraft" at the DB level. A second
 * INSERT with status='open' on an already-out aircraft raises error code 23505
 * (unique_violation), caught and mapped to the typed 'already_open' refusal.
 * 'closed' and 'voided' rows are outside the predicate and do NOT block a
 * new 'open' ticket.
 *
 * Org-safety: resource_id is globally unique to one org (composite FK), so
 * org partitions are disjoint — org_id is NOT in the partial-UNIQUE index
 * (mirrors ADR-0004 §Org-scoping).
 *
 * ── Composite FKs (hand-written in migration 0005 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE
 *     Tenant spine — deleting an org cascades to its tickets.
 *
 *   Composite FK (reservation_id, org_id) → reservation(id, org_id)
 *     ON DELETE RESTRICT — prevents deleting a reservation that has any
 *     dispatch record (records integrity; ADR-0007 §3).
 *     Requires reservation(id, org_id) composite candidate key
 *     "reservation_id_org_id_unique" (established in migration 0002).
 *
 *   Composite FK (resource_id, org_id) → resource(id, org_id)
 *     ON DELETE RESTRICT — prevents deleting an aircraft that has tickets
 *     (same soft-delete-via-active discipline as reservation_resource).
 *     Requires resource(id, org_id) composite candidate key
 *     "resource_id_org_id_unique" (established in migration 0002).
 *
 *   Composite FK (pilot_user_id, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT — pilot must be a member of the same org; prevents
 *     referencing a user in a different org (cross-org guard).
 *
 *   Composite FK (opened_by, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT — opener must be a member.
 *
 *   Composite FK (closed_by, org_id) → app_user(id, org_id)
 *     ON DELETE SET NULL — nullable; if the closing user is deleted the
 *     audit trail is preserved as NULL rather than blocking deletion.
 *
 * ── CHECKs ───────────────────────────────────────────────────────────────────
 * dispatch_meters_nonneg_check:
 *   hobbs_out >= 0 AND tach_out >= 0
 *   AND (hobbs_in IS NULL OR hobbs_in >= 0)
 *   AND (tach_in IS NULL OR tach_in >= 0)
 *
 * dispatch_closed_shape_check:
 *   status='closed'             ⇒ hobbs_in/tach_in/flight_time_hours/closed_by/closed_at NOT NULL
 *   status IN ('open','voided') ⇒ hobbs_in/tach_in/flight_time_hours/closed_by/closed_at ALL NULL
 *
 * NO in>=out CHECK: "hobbs_in >= hobbs_out" is validated at the API layer
 * (ValidationError), NOT enforced by a DB CHECK. This keeps the meter-rollover
 * decision open for a future compliance ruling [VERIFY-A] (ADR-0007 §2, §4).
 *
 * ── Reconciliation note ──────────────────────────────────────────────────────
 * The invariant hobbs_in >= hobbs_out is APP-LEVEL validation enforced in
 * closeDispatch() before any write. The DB only enforces meter non-negativity
 * and the closed-shape invariant (which columns must be non-null or null per
 * status). This is the binding reconciliation from the conductor (2026-06-16).
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — forward-compat for future composite FKs that may
 * reference dispatch_ticket(id, org_id) (e.g. dispatch_ticket_correction).
 * Mirrors the reservation / resource / reservation_series pattern.
 *
 * ── Indexes ──────────────────────────────────────────────────────────────────
 * (org_id, resource_id) — covers the board query "all tickets for this org's
 * aircraft" (e.g. getDispatchForReservation needs to filter by resource_id).
 * The partial UNIQUE index on (resource_id) WHERE (status='open') is
 * hand-written in the migration (Drizzle cannot express partial indexes).
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
import { dispatchStatus } from './enums.js';

export const dispatchTicket = pgTable(
  'dispatch_ticket',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0005. The simple .references() here covers Drizzle-level
    // ergonomics; the hand-written FK provides named-constraint auditability.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // reservation_id carries no .references() — composite FK
    // (reservation_id, org_id) → reservation(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0005 (Drizzle cannot express multi-col FKs).
    reservationId: uuid('reservation_id').notNull(),

    // resource_id (the aircraft) carries no .references() — composite FK
    // (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0005.
    resourceId: uuid('resource_id').notNull(),

    // pilot_user_id carries no .references() — composite FK
    // (pilot_user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0005.
    pilotUserId: uuid('pilot_user_id').notNull(),

    // Ticket lifecycle status. Default is 'open' (set at check-out).
    // Transitions: open→closed (check-in) | open→voided (abandon/void).
    status: dispatchStatus('status').notNull().default('open'),

    // Meter readings at check-OUT (written at OPEN, immutable thereafter).
    // numeric(10,1): up to 9 digits before decimal, 1 after (e.g. 99999.9).
    // Non-negativity enforced by dispatch_meters_nonneg_check.
    hobbsOut: numeric('hobbs_out', { precision: 10, scale: 1 }).notNull(),
    tachOut: numeric('tach_out', { precision: 10, scale: 1 }).notNull(),

    // Meter readings at check-IN (written at CLOSE, immutable; NULL when open/voided).
    // dispatch_closed_shape_check enforces: NULL iff status in ('open','voided').
    hobbsIn: numeric('hobbs_in', { precision: 10, scale: 1 }),
    tachIn: numeric('tach_in', { precision: 10, scale: 1 }),

    // Derived billable flight time (Hobbs-basis; computed by deriveFlightTime
    // in @aeroops/core and persisted at CLOSE). NULL when open/voided.
    // dispatch_closed_shape_check enforces: NULL iff status in ('open','voided').
    // [VERIFY-A] billing granularity + meter rollover + Hobbs vs tach basis.
    flightTimeHours: numeric('flight_time_hours', { precision: 10, scale: 1 }),

    // Optional operator notes (free text; never used for billing computation).
    notes: text('notes'),

    // opened_by carries no .references() — composite FK
    // (opened_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0005.
    openedBy: uuid('opened_by').notNull(),

    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),

    // closed_by carries no .references() — composite FK
    // (closed_by, org_id) → app_user(id, org_id) ON DELETE SET NULL
    // is hand-written in migration 0005. Nullable: NULL when open/voided.
    closedBy: uuid('closed_by'),

    // NULL when open or voided; populated at CLOSE.
    closedAt: timestamp('closed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consumed by future composite FKs (e.g.
    // dispatch_ticket_correction) and consistent with all other tenant tables.
    uniqueIndex('dispatch_ticket_id_org_id_unique').on(t.id, t.orgId),

    // Covers: board query for all tickets for an org's aircraft.
    // e.g. getDispatchForReservation: WHERE org_id = $1 AND resource_id = ANY(...)
    index('dispatch_ticket_org_resource_idx').on(t.orgId, t.resourceId),

    // Covers: lookup by reservation_id (getDispatchForReservation map build).
    index('dispatch_ticket_org_reservation_idx').on(t.orgId, t.reservationId),

    // NOTE: the partial UNIQUE index (resource_id) WHERE (status='open') that
    // enforces the one-open-per-aircraft backstop (ADR-0007 §2) is hand-written
    // in migration 0005. Drizzle cannot express partial indexes in table config.
  ],
);

export type DispatchTicketSelect = typeof dispatchTicket.$inferSelect;
export type DispatchTicketInsert = typeof dispatchTicket.$inferInsert;
