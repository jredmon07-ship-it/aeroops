/**
 * notification_pref — per-user per-event-type email opt-out
 * (Slice P1.3, migration 0026).
 *
 * Absence of a row for a given (org_id, user_id, event_type) means
 * "enabled" (default opt-IN) — enforced entirely in application code
 * (sendNotification treats a missing row as email_enabled = true), NOT by
 * this schema.
 *
 * Standard 4-policy (mutable) RLS — mirrors dues_schedule.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0026).
 *
 * ── Composite FKs (hand-written in migration 0026 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [notification_pref_org_id_fk]
 *
 *   Composite FK (user_id, org_id) → app_user(id, org_id)
 *     ON DELETE CASCADE  [notification_pref_user_org_fk]
 *     A preference row has no meaning once its user is gone — CASCADE
 *     (unlike dues_schedule's history-preserving RESTRICT).
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * notification_pref_org_user_event_unique UNIQUE (org_id, user_id,
 *   event_type) — THE UPSERT TARGET for setMyNotificationPref
 *   (ON CONFLICT DO UPDATE).
 * notification_pref_id_org_id_unique UNIQUE (id, org_id) — composite
 *   candidate key, consistent with all other tenant tables.
 */
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const notificationPref = pgTable(
  'notification_pref',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // user_id carries no .references() — the composite FK is hand-written
    // in migration 0026.
    userId: uuid('user_id').notNull(),

    // Free text (NOT an enum/CHECK) — mirrors notification_log.event_type.
    eventType: text('event_type').notNull(),

    emailEnabled: boolean('email_enabled').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_pref_org_user_event_unique').on(t.orgId, t.userId, t.eventType),
    uniqueIndex('notification_pref_id_org_id_unique').on(t.id, t.orgId),
  ],
);

export type NotificationPrefSelect = typeof notificationPref.$inferSelect;
export type NotificationPrefInsert = typeof notificationPref.$inferInsert;
