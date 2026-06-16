/**
 * reservation_series — the rule record for a recurring booking series.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0006 §5).
 *
 * Each expanded occurrence is a `reservation` row with nullable `series_id`
 * pointing back here via a composite FK (series_id, org_id) → (id, org_id).
 * The UNIQUE (id, org_id) composite candidate key makes that cross-table FK
 * structurally same-org.
 *
 * Recurrence rule columns:
 *   freq             — always 'weekly' in Slice 2b (ADR-0006 §1).
 *   weekdays         — ISO weekday numbers 1–7; CHECK cardinality 1..7, elements 1..7.
 *   interval_weeks   — step in weeks (≥1, DEFAULT 1).
 *   end_kind         — 'count' or 'until' (XOR enforced by end_shape_check).
 *   count            — number of occurrences (1..52); NULL when end_kind='until'.
 *   until_date       — local calendar end date; NULL when end_kind='count'.
 *   local_start_time — wall-clock start time (timezone-aware expansion in core).
 *   duration_minutes — length of each occurrence (>0, same-day).
 *   iana_tz          — IANA timezone name (e.g. 'America/Chicago').
 *   resource_ids     — UUIDs of resources booked per occurrence (≥1 element).
 *   notes            — free text, propagated to each occurrence's reservation.notes.
 *   status           — 'active' | 'cancelled' (DEFAULT 'active').
 *
 * Audit columns:
 *   created_by   — app_user id (composite FK hand-written in migration: RESTRICT).
 *   cancelled_at / cancelled_by — populated by cancelSeries (nullable).
 *
 * Complex constraints that Drizzle cannot express (all hand-written in migration):
 *   UNIQUE (id, org_id)             — composite candidate key for occurrence FK.
 *   end_shape_check                 — count XOR until (see migration comment).
 *   composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT.
 *   composite FK (cancelled_by, org_id) → app_user(id, org_id) ON DELETE SET NULL.
 *   CHECK count BETWEEN 1 AND 52 (when not null).
 *   CHECK interval_weeks >= 1.
 *   CHECK duration_minutes > 0.
 *   CHECK weekdays cardinality (1..7) and element bounds (1..7).
 *   CHECK array_length(resource_ids, 1) >= 1.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  time,
  date,
  timestamp,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';
import { recurrenceFreq, recurrenceEndKind, reservationSeriesStatus } from './enums.js';

/**
 * smallintArray — custom Drizzle column type for Postgres `smallint[]`.
 *
 * Used for `weekdays`: ISO weekday numbers 1–7 (Mon=1 … Sun=7).
 * JS representation: number[]. Postgres stores as a smallint array.
 *
 * Application code sets this via a $1::smallint[] parameter or a raw
 * ARRAY[1,2,3]::smallint[] literal. The PGlite driver returns it as number[].
 */
export const smallintArray = customType<{ data: number[]; driverData: number[] | string }>({
  dataType() {
    return 'smallint[]';
  },
  fromDriver(value: number[] | string): number[] {
    if (Array.isArray(value)) return value.map(Number);
    // PGlite may return the raw Postgres array literal e.g. '{1,2,3}'
    if (typeof value === 'string') {
      return value
        .replace(/^\{|\}$/g, '')
        .split(',')
        .filter(Boolean)
        .map(Number);
    }
    return [];
  },
});

/**
 * uuidArray — custom Drizzle column type for Postgres `uuid[]`.
 *
 * Used for `resource_ids`: the list of resource UUIDs booked per occurrence.
 * CHECK array_length(resource_ids, 1) >= 1 is hand-written in migration.
 */
export const uuidArray = customType<{ data: string[]; driverData: string[] | string }>({
  dataType() {
    return 'uuid[]';
  },
  fromDriver(value: string[] | string): string[] {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      return value
        .replace(/^\{|\}$/g, '')
        .split(',')
        .filter(Boolean)
        .map((s) => s.replace(/^"|"$/g, '').trim());
    }
    return [];
  },
});

export const reservationSeries = pgTable(
  'reservation_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // Recurrence rule ──────────────────────────────────────────────────────────
    freq: recurrenceFreq('freq').notNull(),

    // weekdays: ISO weekday numbers 1–7 (Mon=1 … Sun=7).
    // CHECK constraints (cardinality 1..7, elements ∈ {1..7}) hand-written in migration.
    weekdays: smallintArray('weekdays').notNull(),

    // interval_weeks: step between occurrence weeks (≥1). CHECK hand-written in migration.
    intervalWeeks: integer('interval_weeks').notNull().default(1),

    endKind: recurrenceEndKind('end_kind').notNull(),

    // count: non-null when end_kind='count'; CHECK 1..52. NULL when end_kind='until'.
    count: integer('count'),

    // until_date: non-null when end_kind='until'. NULL when end_kind='count'.
    // end_shape_check enforces the XOR in migration.
    untilDate: date('until_date'),

    // local_start_time: wall-clock start; DST-correct expansion done in core.
    localStartTime: time('local_start_time').notNull(),

    // duration_minutes: CHECK > 0 hand-written in migration.
    durationMinutes: integer('duration_minutes').notNull(),

    // iana_tz: IANA timezone string e.g. 'America/Chicago'. No DB validation —
    // the API layer validates with Intl before persisting.
    ianaTz: text('iana_tz').notNull(),

    // resource_ids: UUIDs of resources booked for every occurrence.
    // CHECK array_length(resource_ids, 1) >= 1 hand-written in migration.
    resourceIds: uuidArray('resource_ids').notNull(),

    notes: text('notes'),

    // status: DEFAULT 'active'. Transitions to 'cancelled' via cancelSeries.
    status: reservationSeriesStatus('status').notNull().default('active'),

    // Audit — created_by ───────────────────────────────────────────────────────
    // Carries no .references(): composite FK (created_by, org_id) → app_user(id, org_id)
    // ON DELETE RESTRICT is hand-written in migration 0004 (same pattern as reservation).
    createdBy: uuid('created_by').notNull(),

    // Audit — cancellation ─────────────────────────────────────────────────────
    // cancelled_by carries no .references(): composite FK (cancelled_by, org_id) →
    // app_user(id, org_id) ON DELETE SET NULL is hand-written in migration 0004.
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consumed by the reservation.series_id composite FK:
    //   (series_id, org_id) → reservation_series(id, org_id) ON DELETE SET NULL.
    // Structurally prevents cross-org occurrence → series linkage.
    uniqueIndex('reservation_series_id_org_id_unique').on(t.id, t.orgId),
  ],
);

export type ReservationSeriesSelect = typeof reservationSeries.$inferSelect;
export type ReservationSeriesInsert = typeof reservationSeries.$inferInsert;
