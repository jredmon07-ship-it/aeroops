/**
 * location — a physical base for a tenant org (airport, helipad, etc.)
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE.
 */
import { pgTable, text, uuid, timestamp } from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const location = pgTable('location', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => org.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  icao: text('icao'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LocationSelect = typeof location.$inferSelect;
export type LocationInsert = typeof location.$inferInsert;
