/**
 * member_message — APPEND-ONLY record of each operator-authored member
 * announcement (Slice FC-P1, migration 0036 — STAGED, human-gated, NOT
 * applied).
 *
 * "An operator (owner/manager) sent this announcement to this audience."
 * One row per sendMemberMessage call, regardless of fan-out size — the
 * per-recipient send ATTEMPTS are recorded separately in the EXISTING
 * notification_log table (event_type = 'org.announcement'), via the
 * existing sendNotification dispatcher. recipient_count is a snapshot of
 * how many recipients were resolved at send time.
 *
 * SELECT + INSERT RLS policies ONLY (mirrors notification_log / dues_run /
 * ledger_entry) — no UPDATE/DELETE policy; FORCE RLS blocks those
 * operations for aeroops_app. No updated_at (immutable by design).
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0036).
 *
 * ── FKs (hand-written in migration 0036 SQL) ─────────────────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [member_message_org_id_fk]
 *
 *   Composite FK (sent_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     [member_message_sent_by_org_fk] — attribution on who sent the
 *     announcement is preserved (mirrors study_grant_granted_by_org_fk).
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * member_message_id_org_id_unique UNIQUE (id, org_id) — composite candidate
 *   key, consistent with all other tenant tables.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * member_message_subject_check / member_message_body_check: non-empty
 *   (trimmed) with a length cap (subject <= 200, body <= 5000). Plain text
 *   ONLY — no HTML column.
 * member_message_audience_check: audience IN ('all_active', 'role').
 * member_message_role_required_iff_audience_check: role is required iff
 *   audience='role', otherwise must be NULL.
 * member_message_role_valid_check: role, when present, is a valid
 *   membership_role value (TEXT + CHECK, not a pgEnum FK — a filter value).
 * member_message_recipient_count_nonnegative_check: recipient_count >= 0.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const memberMessage = pgTable(
  'member_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // sentBy carries no .references() — composite FK
    // (sent_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT is
    // hand-written in migration 0036.
    sentBy: uuid('sent_by').notNull(),

    subject: text('subject').notNull(),
    body: text('body').notNull(),

    // 'all_active' | 'role' (member_message_audience_check).
    audience: text('audience').notNull(),

    // Required iff audience='role' (member_message_role_required_iff_audience_check).
    role: text('role'),

    recipientCount: integer('recipient_count').notNull(),

    // No updated_at — immutable by design.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('member_message_id_org_id_unique').on(t.id, t.orgId),
    index('member_message_org_created_idx').on(t.orgId, t.createdAt),
  ],
);

export type MemberMessageSelect = typeof memberMessage.$inferSelect;
export type MemberMessageInsert = typeof memberMessage.$inferInsert;
