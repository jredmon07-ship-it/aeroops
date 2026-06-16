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
 */
import {
  pgTable,
  uuid,
  text,
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
