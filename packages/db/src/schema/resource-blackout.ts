/**
 * resource_blackout — per-resource unavailability windows (0..N per resource).
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE.
 *
 * Implements ADR-0005 §4: blackout windows are a child table of resource,
 * mirroring the reservation_resource range discipline.
 *
 * `during` is a `tstzrange` using the REUSED `tstzrange` customType from
 * reservation-resource.ts. Built ONLY as:
 *   tstzrange($start::timestamptz, $end::timestamptz, '[)')
 * Half-open [inclusive-start, exclusive-end) — adjacency is NOT a violation.
 *
 * CHECK during_nonempty: lower IS NOT NULL AND upper IS NOT NULL AND lower < upper.
 * Prevents degenerate (empty, inverted) ranges at the DB level.
 *
 * NO GiST/EXCLUDE constraint — two blackouts on one resource may overlap freely
 * (operator's prerogative; ADR-0005 §Decision.4, invariant B). Blackout overlap
 * with a proposed reservation is a pure-core advisory check in policy.ts, not a
 * DB constraint.
 *
 * Composite FKs (all hand-written in migration SQL — Drizzle cannot express
 * multi-column FKs):
 *   (resource_id, org_id) → resource(id, org_id) ON DELETE CASCADE
 *     Deleting a resource cascades to all its blackout windows.
 *   (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     Prevents deleting the creating user without explicit cleanup of their
 *     blackout entries (preserves audit trail; soft-delete app_user instead).
 *
 * FK (org_id) → org(id) ON DELETE CASCADE:
 *   Tenant spine — deleting an org removes all its blackouts.
 *
 * INDEX (org_id, resource_id): covers the blackout-load query on the create path.
 *
 * No updated_at — blackout rows are NOT silently mutated; records integrity.
 * (Immutable once created; delete + recreate if correction needed.)
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';
import { tstzrange } from './reservation-resource.js';

export const resourceBlackout = pgTable(
  'resource_blackout',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),
    // resource_id carries no .references() — composite FK hand-written in migration.
    // (resource_id, org_id) → resource(id, org_id) ON DELETE CASCADE
    resourceId: uuid('resource_id').notNull(),
    // Half-open [start, end) tstzrange. Reused customType from reservation-resource.
    // CHECK (during_nonempty): lower IS NOT NULL AND upper IS NOT NULL AND lower < upper.
    // (Hand-written in migration — customType has no .check() method.)
    during: tstzrange('during').notNull(),
    reason: text('reason'),
    // created_by carries no .references() — composite FK hand-written in migration.
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Covers: SELECT * FROM resource_blackout WHERE org_id = $1 AND resource_id = $2
    index('resource_blackout_org_id_resource_id_idx').on(t.orgId, t.resourceId),
  ],
);

export type ResourceBlackoutSelect = typeof resourceBlackout.$inferSelect;
export type ResourceBlackoutInsert = typeof resourceBlackout.$inferInsert;
