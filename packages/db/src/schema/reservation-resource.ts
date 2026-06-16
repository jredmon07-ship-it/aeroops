/**
 * reservation_resource — join table linking a reservation to one resource,
 * carrying a denormalized `during tstzrange` column.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE.
 *
 * THIS TABLE HOSTS THE EXCLUDE CONSTRAINT (ADR-0004 §Decision):
 *
 *   EXCLUDE USING gist (resource_id WITH =, during WITH &&)
 *   WHERE (status = 'booked')
 *
 * This constraint, combined with `btree_gist` (for the uuid = operator
 * class inside a GiST index), makes double-booking structurally impossible
 * at the engine level. No application code can accidentally skip this guard.
 * A reservation with N resources inserts N join rows in one transaction;
 * if any row collides, Postgres raises error code 23P01 (exclusion_violation)
 * and rolls back the whole transaction — all-or-nothing.
 *
 * WHY NOT org_id IN THE EXCLUSION:
 *   resource_id is globally unique (uuid PK). The composite FK
 *   (resource_id, org_id) → resource(id, org_id) makes "resource_id implies
 *   one org" structural. Two orgs' bookings therefore live in disjoint
 *   resource_id partitions of the GiST index and can never collide. Adding
 *   org_id to the exclusion would be redundant and would prevent a valid
 *   uuid = operator class expression (ADR-0004 §Alternatives).
 *
 * TSTZRANGE + during:
 *   Drizzle has no native tstzrange column type. We define a small customType
 *   that maps to the Postgres `tstzrange` type, returning/accepting strings.
 *   The application must always build the range as:
 *     tstzrange(start_at::timestamptz, end_at::timestamptz, '[)')
 *   i.e. half-open [inclusive-start, exclusive-end) — consistent with the
 *   core intervalsOverlap predicate and the `[)'` convention in ADR-0004.
 *   Adjacency ([10:00,11:00) and [11:00,12:00)) is NOT a conflict.
 *
 *   Application conflict-probe query shape:
 *     SELECT rr.* FROM reservation_resource rr
 *     WHERE rr.resource_id = ANY($resourceIds)
 *       AND rr.status = 'booked'
 *       AND rr.during && tstzrange($start::timestamptz, $end::timestamptz, '[)')
 *
 *   The GiST EXCLUDE index also serves this overlap query (GiST supports &&).
 *   A btree index on (org_id, resource_id, status) is also created to cover
 *   the common "all booked rows for this org+resource" lookup path.
 *
 * Composite FKs (hand-written in migration SQL):
 *   (reservation_id, org_id) → reservation(id, org_id) ON DELETE CASCADE
 *   (resource_id, org_id)    → resource(id, org_id)    ON DELETE RESTRICT
 * These prevent cross-org join rows. Drizzle's .references() cannot express
 * multi-column FKs, so reservation_id and resource_id carry NO .references().
 *
 * UNIQUE (reservation_id, resource_id) — one join row per resource per reservation.
 *
 * No updated_at — join rows are replaced (delete + re-insert) via the single
 * sanctioned write path in @aeroops/api, never silently mutated.
 */
import {
  pgTable,
  uuid,
  timestamp,
  uniqueIndex,
  index,
  customType,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';
import { reservationStatus } from './enums.js';

/**
 * tstzrange — custom Drizzle column type for Postgres `tstzrange`.
 *
 * Data representation: string in Postgres range literal format, e.g.
 *   '["2026-06-15 10:00:00+00","2026-06-15 11:00:00+00")'
 *
 * The application layer constructs values using:
 *   tstzrange($start::timestamptz, $end::timestamptz, '[)')
 *
 * This is a passthrough type — the driver sends/receives the range as a
 * string and Postgres handles parsing. No JS Date mapping is done here;
 * the scheduling-engineer's API layer is responsible for marshalling.
 */
export const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tstzrange';
  },
});

export const reservationResource = pgTable(
  'reservation_resource',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),
    // reservation_id carries no .references() — composite FK hand-written in migration.
    reservationId: uuid('reservation_id').notNull(),
    // resource_id carries no .references() — composite FK hand-written in migration.
    resourceId: uuid('resource_id').notNull(),
    // during — denormalized tstzrange derived from reservation.start_at/end_at.
    // MUST equal tstzrange(reservation.start_at, reservation.end_at, '[)').
    // The EXCLUDE constraint lives on this column (see migration).
    during: tstzrange('during').notNull(),
    // status is denormalized from the parent reservation so the partial EXCLUDE
    // WHERE (status='booked') can filter in the GiST index without a join.
    status: reservationStatus('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One join row per resource per reservation
    uniqueIndex('reservation_resource_res_id_resource_id_unique').on(
      t.reservationId,
      t.resourceId,
    ),
    // Covers: SELECT * FROM reservation_resource
    //         WHERE org_id = $1 AND resource_id = $2 AND status = 'booked'
    // The GiST EXCLUDE index also handles the && overlap probe; this btree
    // covers non-range lookups (fetch all booked rows for an org+resource).
    index('reservation_resource_org_resource_status_idx').on(
      t.orgId,
      t.resourceId,
      t.status,
    ),
  ],
);

export type ReservationResourceSelect = typeof reservationResource.$inferSelect;
export type ReservationResourceInsert = typeof reservationResource.$inferInsert;
