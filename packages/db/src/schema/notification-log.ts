/**
 * notification_log — APPEND-ONLY audit of every email send ATTEMPT
 * (Slice P1.3, migration 0026).
 *
 * Written by sendNotification (packages/api/src/notifications/
 * send-notification.ts) exactly once per call, regardless of outcome
 * (status: 'sent' | 'failed' | 'skipped'). NEVER carries the rendered
 * email body — only the recipient email + a short subject line survive
 * here (no PII beyond that).
 *
 * SELECT + INSERT RLS policies ONLY (mirrors dues_run / ledger_entry /
 * dispatch_ticket_correction / stripe_event) — no UPDATE/DELETE policy;
 * FORCE RLS blocks those operations for aeroops_app. No updated_at
 * (immutable by design).
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0026).
 *
 * ── FKs (hand-written in migration 0026 SQL) ─────────────────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [notification_log_org_id_fk]
 *
 *   FK (user_id) → app_user(id) ON DELETE SET NULL
 *     [notification_log_user_id_fk] — SIMPLE (non-composite), mirrors
 *     audit_log.actor_user_id exactly. Nullable: a future org-level
 *     notification (no single recipient) is representable without a
 *     schema change.
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * notification_log_id_org_id_unique UNIQUE (id, org_id) — composite
 *   candidate key, consistent with all other tenant tables.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * notification_log_channel_check: channel IN ('email') — forward seam for
 *   SMS/push (widen the CHECK when a second channel ships).
 * notification_log_status_check: status IN ('sent','failed','skipped').
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // Nullable — SIMPLE (non-composite) FK, hand-written in migration 0026.
    // Mirrors audit_log.actor_user_id (this table's .references() targets
    // app_user.id directly in the DB, but Drizzle's schema-level FK is
    // declared in the migration SQL, not here — see file header).
    userId: uuid('user_id'),

    // notification_log_channel_check: only 'email' in this slice.
    channel: text('channel').notNull(),

    // Free text (NOT an enum/CHECK) — new event types need no migration.
    eventType: text('event_type').notNull(),

    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),

    // notification_log_status_check: 'sent' | 'failed' | 'skipped'.
    status: text('status').notNull(),

    errorDetail: text('error_detail'),

    // No updated_at — immutable by design.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_log_id_org_id_unique').on(t.id, t.orgId),
    index('notification_log_org_created_idx').on(t.orgId, t.createdAt),
    index('notification_log_org_user_idx').on(t.orgId, t.userId),
  ],
);

export type NotificationLogSelect = typeof notificationLog.$inferSelect;
export type NotificationLogInsert = typeof notificationLog.$inferInsert;
