/**
 * location — a physical base for a tenant org (airport, helipad, etc.)
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE.
 *
 * UNIQUE (id, org_id) — composite candidate key added in migration 0007
 * (Slice 5 Fleet). Required as the FK target for the composite FK
 * (home_base_location_id, org_id) → location(id, org_id) on resource.
 * Mirrors the resource / app_user / dispatch_ticket / squawk pattern.
 */
import { pgTable, text, uuid, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const location = pgTable(
  'location',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icao: text('icao'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consumed by resource.home_base_location_id
    // composite FK (home_base_location_id, org_id) → location(id, org_id).
    // Added in migration 0007 (Slice 5 Fleet). Mirrors the resource /
    // app_user / dispatch_ticket / squawk composite-key pattern.
    uniqueIndex('location_id_org_id_unique').on(t.id, t.orgId),
  ],
);

export type LocationSelect = typeof location.$inferSelect;
export type LocationInsert = typeof location.$inferInsert;
