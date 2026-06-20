/**
 * resource_availability_window — per-resource operating-hours windows (0..N per resource).
 *
 * An operator attaches one or more weekly availability windows to a resource
 * (aircraft). Each row says "this resource is available from start_minute to
 * end_minute on day_of_week (1=Mon … 7=Sun, ISO 8601) in the given IANA tz."
 *
 * The availability gate (`evaluateAvailabilityGate` in @aeroops/core) unions all
 * windows for the candidate reservation's date span and checks that the booking
 * is FULLY CONTAINED in the union. Mode 'warn' / 'block' is controlled by
 * dispatch_config.availability_mode.
 *
 * [VERIFY-AV1-A] (HARD COMPLIANCE LINE): availability windows represent OPERATOR
 * SCHEDULING / OPERATING-HOURS data ONLY. The system computes NO FAA duty-time,
 * rest-period, flight-time-limit, Part-117/135/121 determination whatsoever.
 * These are the times the operator has decided to make the resource available for
 * scheduling — nothing more. Compliance confirms at QA.
 *
 * [VERIFY-AV1-B]: no pilot duty/rest tracking here — windows are on the RESOURCE
 * (aircraft), not on a person. Route to compliance-officer.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0014).
 *
 * Windows are add/remove only — there is NO updated_at column. An incorrect
 * window is deleted and re-added with the corrected values (not mutated).
 *
 * ── Composite FKs (hand-written in migration 0014 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; composite FKs are
 * written in the migration; affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [resource_availability_window_org_id_fk]
 *     Tenant spine — deleting an org cascades to all its availability windows.
 *
 *   Composite FK (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT
 *     [resource_availability_window_resource_org_fk]
 *     Windows are scheduling config — RESTRICT ensures a resource cannot be
 *     hard-deleted while windows exist (operator must remove them first).
 *     Prevents cross-org resource references.
 *     Targets resource_id_org_id_unique established in migration 0002.
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     [resource_availability_window_created_by_org_fk]
 *     Preserves attribution: prevents deleting the creating user while their
 *     authorship record exists. Targets app_user_id_org_id_unique (0000).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * resource_availability_window_dow_check:
 *   day_of_week BETWEEN 1 AND 7  (ISO 8601: 1=Monday, 7=Sunday)
 *
 * resource_availability_window_start_minute_check:
 *   start_minute BETWEEN 0 AND 1439  (0=00:00, 1439=23:59)
 *
 * resource_availability_window_end_minute_check:
 *   end_minute >= 1 AND end_minute <= 1440 AND end_minute > start_minute
 *   1440 = midnight-next-day (exclusive end). Forbids overnight wrap — overnight
 *   availability requires TWO rows (UI auto-splits). end_minute > start_minute
 *   also prevents zero-duration windows.
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * resource_availability_window_id_org_id_unique UNIQUE (id, org_id)
 *   Composite candidate key — forward-compat for future composite FKs,
 *   consistent with all other tenant tables.
 *
 * resource_availability_window_natural_key_unique
 *   UNIQUE (resource_id, day_of_week, start_minute, end_minute)
 *   Natural deduplication key. Overlapping windows are allowed (the gate unions
 *   them) but an exact duplicate is rejected (per ADR spec decision 8).
 *   Case-insensitive tz is NOT part of the key (same window in a different tz
 *   representation would be a very rare operator error — acceptable).
 *
 * ── Index ─────────────────────────────────────────────────────────────────────
 * resource_availability_window_org_resource_idx (org_id, resource_id)
 *   Covers: load all windows for a resource —
 *   WHERE org_id = $1 AND resource_id = $2
 */
import {
  pgTable,
  uuid,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const resourceAvailabilityWindow = pgTable(
  'resource_availability_window',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — simple FK covers Drizzle ergonomics; the named composite FK
    // resource_availability_window_org_id_fk is hand-written in migration 0014.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // resource_id carries no .references() — composite FK
    // (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0014.
    resourceId: uuid('resource_id').notNull(),

    // ISO 8601 day-of-week: 1=Monday, 7=Sunday.
    // resource_availability_window_dow_check: BETWEEN 1 AND 7
    // (Hand-written in migration — integer column has no .check() method.)
    dayOfWeek: integer('day_of_week').notNull(),

    // Minutes since midnight for window open. 0=00:00, 1439=23:59.
    // resource_availability_window_start_minute_check: BETWEEN 0 AND 1439
    startMinute: integer('start_minute').notNull(),

    // Minutes since midnight for window close. 1=00:01, 1440=24:00 (midnight next day).
    // resource_availability_window_end_minute_check:
    //   end_minute >= 1 AND end_minute <= 1440 AND end_minute > start_minute
    // Overnight wrap is forbidden — use two rows instead.
    endMinute: integer('end_minute').notNull(),

    // IANA timezone string for this window (e.g. 'America/New_York').
    // The API pre-resolves to UTC `[open,close)` before passing to the core gate.
    tz: text('tz').notNull(),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0014. Preserves attribution.
    createdBy: uuid('created_by').notNull(),

    // Immutable timestamp. NO updated_at — windows are add/remove only.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — forward-compat for future composite FKs.
    // Consistent with all other tenant tables.
    uniqueIndex('resource_availability_window_id_org_id_unique').on(t.id, t.orgId),

    // Natural deduplication key. Overlapping windows are allowed (gate unions them)
    // but an exact duplicate is not. Case-insensitive tz NOT included in key.
    uniqueIndex('resource_availability_window_natural_key_unique').on(
      t.resourceId,
      t.dayOfWeek,
      t.startMinute,
      t.endMinute,
    ),

    // Covers: load all windows for a resource —
    // WHERE org_id = $1 AND resource_id = $2
    index('resource_availability_window_org_resource_idx').on(t.orgId, t.resourceId),
  ],
);

export type ResourceAvailabilityWindowSelect = typeof resourceAvailabilityWindow.$inferSelect;
export type ResourceAvailabilityWindowInsert = typeof resourceAvailabilityWindow.$inferInsert;
