/**
 * calendar_feed — a read-only .ics subscription pointer (Slice P1.4,
 * migration 0028).
 *
 * One row per (owner, scope[, resource]) subscription. feed_token is the URL
 * secret — a long, cryptographically-random opaque string (the bearer
 * capability that IS the auth on the public .ics route; see
 * packages/api/src/calendar/create-calendar-feed.ts and
 * apps/web/app/api/calendar/[token]/route.ts).
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0028).
 * calendar_feed_select ADDITIONALLY admits platform-admin context (mirrors
 * payment_intent_record_select / stripe_customer_select) — the ONE
 * sanctioned platform-admin read in the public .ics feed path
 * (resolveFeedByToken). Every WRITE stays org-GUC-only.
 *
 * ── Composite FKs (hand-written in migration 0028 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [calendar_feed_org_id_fk]
 *
 *   Composite FK (user_id, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [calendar_feed_user_org_fk]
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 *   Composite FK (resource_id, org_id) → resource(id, org_id)
 *     ON DELETE RESTRICT  [calendar_feed_resource_org_fk] — nullable, NULL
 *     for scope='my_reservations'.
 *     Targets resource_id_org_id_unique (migration 0002).
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * calendar_feed_token_unique UNIQUE (feed_token) — the URL secret + the
 *   lookup key for resolveFeedByToken; also serves as the feed_token index.
 * calendar_feed_id_org_id_unique UNIQUE (id, org_id) — composite candidate key.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * calendar_feed_scope_check: scope IN ('my_reservations','aircraft')
 * calendar_feed_scope_shape_check — STRUCTURAL: resource_id IS NOT NULL iff
 *   scope='aircraft'.
 * calendar_feed_token_nonempty_check: char_length(btrim(feed_token)) > 0
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

/** The two feed scopes. Kept as a plain union (not a pgEnum) — mirrors the
 * migration's CHECK-constrained free text, matching stripe_payment_method.type. */
export type CalendarFeedScope = 'my_reservations' | 'aircraft';

export const calendarFeed = pgTable(
  'calendar_feed',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // userId carries no .references() — composite FK
    // (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0028.
    userId: uuid('user_id').notNull(),

    // 'my_reservations' | 'aircraft' — CHECK-constrained in the migration.
    scope: text('scope').notNull(),

    // resourceId carries no .references() — composite FK
    // (resource_id, org_id) → resource(id, org_id) ON DELETE RESTRICT is
    // hand-written in migration 0028. Nullable — NULL for 'my_reservations'.
    resourceId: uuid('resource_id'),

    // The URL secret (node:crypto randomBytes → base64url). Globally unique.
    feedToken: text('feed_token').notNull(),

    active: boolean('active').notNull().default(true),

    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('calendar_feed_token_unique').on(t.feedToken),
    uniqueIndex('calendar_feed_id_org_id_unique').on(t.id, t.orgId),
    index('calendar_feed_org_user_idx').on(t.orgId, t.userId),
  ],
);

export type CalendarFeedSelect = typeof calendarFeed.$inferSelect;
export type CalendarFeedInsert = typeof calendarFeed.$inferInsert;
