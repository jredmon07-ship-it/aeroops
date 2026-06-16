/**
 * booking_policy — optional per-resource booking rules (0..1 per resource).
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE.
 *
 * Implements ADR-0005: a second gate beside the conflict-detection EXCLUDE.
 * Absent row = open booking (Slice-1 behaviour preserved byte-for-byte).
 *
 * Rules enforced (all nullable — NULL means "no limit"):
 *   max_duration_minutes:  reservation length must not exceed this (CHECK > 0).
 *   max_advance_days:      reservation start must be at most this many days
 *                          ahead of now (CHECK >= 0; 0 = same-day only).
 *   min_advance_minutes:   reservation start must be at least this many minutes
 *                          in the future (CHECK >= 0; 0 = instant booking).
 *
 * SCOPE AMENDMENT (2026-06-16, founder): required_tags is DEFERRED out of
 * Slice 2a. NO required_tags column here — it moves to the follow-up slice
 * that also builds the member-tag admin surface.
 *
 * UNIQUE (resource_id): one policy row per resource.
 *
 * Composite FK (resource_id, org_id) → resource(id, org_id) ON DELETE CASCADE:
 *   Structurally prevents referencing a resource in a different org.
 *   Hand-written in migration SQL — Drizzle cannot express multi-column FKs,
 *   so resource_id carries NO .references() here.
 *
 * FK (org_id) → org(id) ON DELETE CASCADE:
 *   Tenant spine — deleting an org removes all its booking policies.
 *
 * INDEX (org_id, resource_id): covers the policy-probe query on the create path.
 */
import {
  pgTable,
  uuid,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const bookingPolicy = pgTable(
  'booking_policy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),
    // resource_id carries no .references() — composite FK hand-written in migration.
    // (resource_id, org_id) → resource(id, org_id) ON DELETE CASCADE
    resourceId: uuid('resource_id').notNull(),
    // All three rule columns are nullable: NULL means "no limit on this dimension".
    // CHECKs are hand-written in migration (>0, >=0, >=0 respectively).
    maxDurationMinutes: integer('max_duration_minutes'),
    maxAdvanceDays: integer('max_advance_days'),
    minAdvanceMinutes: integer('min_advance_minutes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One policy per resource (enforced by DB UNIQUE constraint in migration).
    uniqueIndex('booking_policy_resource_id_unique').on(t.resourceId),
    // Covers: SELECT * FROM booking_policy WHERE org_id = $1 AND resource_id = $2
    index('booking_policy_org_id_resource_id_idx').on(t.orgId, t.resourceId),
  ],
);

export type BookingPolicySelect = typeof bookingPolicy.$inferSelect;
export type BookingPolicyInsert = typeof bookingPolicy.$inferInsert;
