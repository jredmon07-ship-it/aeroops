/**
 * mobile_session — a revocable, rotating mobile refresh-token session
 * (Slice 4M-REVOKE, migration 0033).
 *
 * [VERIFY-4M-SEC-1] PREDECESSOR: one row per issued refresh token (login) or
 * per rotation (refresh). NEVER stores the raw refresh token — only a
 * deterministic sha256 hash (see packages/api/src/auth/mobile-session.ts for
 * the hashing-choice rationale). The paired ACCESS token stays a stateless
 * signed JWT (unchanged shape/verifyMobileToken), now short-lived (~15 min);
 * instant revocation works because a new access token requires a refresh
 * that is checked against THIS table.
 *
 * rotated_to_id is the rotation-chain pointer: rotating a refresh token sets
 * the OLD row's rotated_to_id to the NEW row's id + revoked_at = now(). A
 * refresh token presented AFTER its row already has rotated_to_id set is a
 * reuse/theft signal — the command layer revokes the entire forward chain.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0033).
 * mobile_session_select ADDITIONALLY admits platform-admin context (mirrors
 * calendar_feed_select) — the ONE sanctioned platform-admin read in the
 * mobile refresh/logout path (resolveMobileSessionByHash). Every WRITE
 * stays org-GUC-only.
 *
 * ── Composite FKs (hand-written in migration 0033 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [mobile_session_org_id_fk]
 *
 *   Composite FK (user_id, org_id) → app_user(id, org_id)
 *     ON DELETE CASCADE  [mobile_session_user_org_fk]
 *     A session has no meaning once its user is gone.
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 *   Composite FK (rotated_to_id, org_id) → mobile_session(id, org_id)
 *     ON DELETE SET NULL  [mobile_session_rotated_to_org_fk] — nullable,
 *     the self-referencing rotation-chain pointer.
 *     Targets mobile_session_id_org_id_unique (below, same table).
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * mobile_session_refresh_token_hash_unique UNIQUE (refresh_token_hash) — the
 *   O(1) lookup key for resolveMobileSessionByHash.
 * mobile_session_id_org_id_unique UNIQUE (id, org_id) — composite candidate
 *   key, consistent with all other tenant tables; also the self-FK target.
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

export const mobileSession = pgTable(
  'mobile_session',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // userId carries no .references() — composite FK
    // (user_id, org_id) → app_user(id, org_id) ON DELETE CASCADE is
    // hand-written in migration 0033.
    userId: uuid('user_id').notNull(),

    // sha256 hex digest of the raw refresh token. NEVER the raw token.
    refreshTokenHash: text('refresh_token_hash').notNull(),

    // Free-text, operator/device-supplied, OPTIONAL — display-only.
    deviceLabel: text('device_label'),

    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    // rotatedToId carries no .references() — the self-referencing composite
    // FK (rotated_to_id, org_id) → mobile_session(id, org_id) ON DELETE SET
    // NULL is hand-written in migration 0033.
    rotatedToId: uuid('rotated_to_id'),
  },
  (t) => [
    uniqueIndex('mobile_session_refresh_token_hash_unique').on(t.refreshTokenHash),
    uniqueIndex('mobile_session_id_org_id_unique').on(t.id, t.orgId),
    index('mobile_session_org_user_idx').on(t.orgId, t.userId),
  ],
);

export type MobileSessionSelect = typeof mobileSession.$inferSelect;
export type MobileSessionInsert = typeof mobileSession.$inferInsert;
