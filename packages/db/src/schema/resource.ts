/**
 * resource — a bookable entity owned by one org.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE.
 *
 * Each resource has a `kind` (aircraft, instructor, sim, room, vehicle),
 * with subtype-specific nullable columns enforced via a CHECK constraint
 * (resource_kind_shape_check in the migration). Slice 1 uses aircraft +
 * instructor only; sim/room/vehicle are forward-compatible data additions
 * (ADR-0004 §Forward-compat).
 *
 * UNIQUE (id, org_id) — composite candidate key consumed by the composite
 * FKs on reservation_resource (same pattern as app_user / membership).
 *
 * Composite FK: (instructor_user_id, org_id) → app_user(id, org_id)
 * is hand-written in the migration SQL — prevents linking an instructor
 * resource to a user in a different org. Drizzle's .references() cannot
 * express multi-column FKs, so instructor_user_id carries NO .references().
 *
 * INDEX (org_id, kind) — covers the common "fetch all aircraft for org"
 * query pattern used by the scheduling board.
 *
 * Slice 5 (Fleet) adds aircraft-identity columns: make, model, year,
 * serialNumber, homeBaseLocationId, hasHobbs, hasTach.
 * homeBaseLocationId carries NO .references() — the composite FK
 * (home_base_location_id, org_id) → location(id, org_id) is hand-written
 * in migration 0007 (same composite-FK pattern as instructor_user_id).
 *
 * Phase 4 maintenance will add nullable inspection columns here —
 * documented forward seam, NOT built in Slice 5 (no inspection/AD/
 * airworthiness computation in Phase 1).
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';
import { resourceKind } from './enums.js';

export const resource = pgTable(
  'resource',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),
    kind: resourceKind('kind').notNull(),
    displayName: text('display_name').notNull(),
    tailNumber: text('tail_number'),
    // instructorUserId carries no .references() — the composite FK
    // (instructor_user_id, org_id) → app_user(id, org_id) is hand-written
    // in the migration SQL (same pattern as auth_credential / membership).
    instructorUserId: uuid('instructor_user_id'),
    active: boolean('active').notNull().default(true),
    // ── Slice 5 (Fleet) aircraft-identity columns ─────────────────────────
    // All nullable so existing inserts that omit them continue to succeed.
    // resource_kind_shape_check is NOT widened — these columns are outside it.
    make: text('make'),
    model: text('model'),
    year: integer('year'),  // CHECK (year IS NULL OR year BETWEEN 1900 AND 2200) in migration
    serialNumber: text('serial_number'),
    // homeBaseLocationId carries no .references() — the composite FK
    // (home_base_location_id, org_id) → location(id, org_id) ON DELETE SET NULL
    // is hand-written in migration 0007 to prevent cross-org home-base linkage.
    homeBaseLocationId: uuid('home_base_location_id'),
    // Display/config only — do NOT alter the FROZEN ADR-0007 dispatch meter-capture path.
    hasHobbs: boolean('has_hobbs').notNull().default(true),
    hasTach: boolean('has_tach').notNull().default(true),
    // ── End Slice 5 columns ───────────────────────────────────────────────
    // ── Slice P2-LOG2 aircraft identity columns (migration 0037) ──────────
    // FREE TEXT, operator-entered (e.g. 'Airplane' / 'ASEL'). NOT an enum,
    // NOT a certification/type-rating determination — display data for the
    // pilot logbook and fleet identity surfaces. Nullable/additive.
    category: text('category'),
    aircraftClass: text('aircraft_class'),
    // ── End Slice P2-LOG2 columns ─────────────────────────────────────────
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consumed by reservation_resource composite FK
    uniqueIndex('resource_id_org_id_unique').on(t.id, t.orgId),
    // Covers: SELECT * FROM resource WHERE org_id = $1 AND kind = $2
    index('resource_org_id_kind_idx').on(t.orgId, t.kind),
  ],
);

export type ResourceSelect = typeof resource.$inferSelect;
export type ResourceInsert = typeof resource.$inferInsert;
