/**
 * reservation — the canonical time window + status for a booking.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE.
 *
 * A reservation may hold multiple resources (aircraft + instructor).
 * Each resource link lives in reservation_resource (the join table) which
 * carries the denormalized `during tstzrange` and hosts the EXCLUDE
 * constraint that enforces no-double-book (ADR-0004).
 *
 * CHECK (end_at > start_at) — enforced at DB level; application code
 * must also validate before submit.
 *
 * UNIQUE (id, org_id) — composite candidate key consumed by the composite
 * FK on reservation_resource (same pattern as resource / app_user).
 *
 * Composite FKs (hand-written in migration SQL):
 *   (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *   (cancelled_by, org_id) → app_user(id, org_id) ON DELETE SET NULL
 * These prevent referencing a user in a different org. Drizzle's
 * .references() cannot express multi-column FKs, so created_by and
 * cancelled_by carry NO .references().
 *
 * series_id (nullable, Slice 2b / ADR-0006):
 *   Links this occurrence to its parent reservation_series row.
 *   NULL means a one-off reservation (single-create path — unchanged).
 *   Composite FK (series_id, org_id) → reservation_series(id, org_id)
 *   ON DELETE SET NULL is hand-written in migration 0004; Drizzle cannot
 *   express multi-column FKs, so series_id carries NO .references() here.
 *   ON DELETE SET NULL preserves audited occurrence rows if the series
 *   is hard-deleted (records integrity — ADR-0006 §4).
 *
 * cancelled_at / cancelled_by — populated when status transitions to
 * 'cancelled'. The EXCLUDE constraint WHERE (status='booked') means
 * cancelled rows never cause false conflicts.
 *
 * INDEX (org_id, status) — covers the dispatch board query
 * WHERE org_id = $1 AND status = 'booked'.
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
import { reservationStatus } from './enums.js';

export const reservation = pgTable(
  'reservation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    status: reservationStatus('status').notNull().default('booked'),
    notes: text('notes'),
    // created_by carries no .references() — composite FK hand-written in migration.
    createdBy: uuid('created_by').notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    // cancelled_by carries no .references() — composite FK hand-written in migration.
    cancelledBy: uuid('cancelled_by'),
    // series_id carries no .references() — composite FK (series_id, org_id) →
    // reservation_series(id, org_id) ON DELETE SET NULL is hand-written in
    // migration 0004 (Slice 2b, ADR-0006). NULL = one-off reservation.
    seriesId: uuid('series_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consumed by reservation_resource composite FK
    uniqueIndex('reservation_id_org_id_unique').on(t.id, t.orgId),
    // Covers: SELECT * FROM reservation WHERE org_id = $1 AND status = $2
    index('reservation_org_id_status_idx').on(t.orgId, t.status),
  ],
);

export type ReservationSelect = typeof reservation.$inferSelect;
export type ReservationInsert = typeof reservation.$inferInsert;
