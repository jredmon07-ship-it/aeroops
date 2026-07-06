/**
 * study_grant — a school-granted AeroStudy entitlement (Slice STUDY-1,
 * migration 0035 — STAGED, human-gated, NOT applied).
 *
 * "This school grants this member this AeroStudy access." scope is either
 * 'all_access' or an FAA knowledge-test cert code (uppercase alphanumeric,
 * e.g. 'PAR', 'IRA') — client-side these map 1:1 onto AeroStudy product IDs
 * (aerostudy.cert.<code> / aerostudy.allaccess.*). Read by the member over
 * the existing mobile-token guard (GET /api/mobile/v1/study/entitlements,
 * self-scoped to session.userId). Revocation is a soft flip of revoked_at
 * (mirrors mobile_session.revoked_at), never a DELETE.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE + the standard
 * 4-policy pattern (migration 0035). NO platform-admin SELECT branch —
 * every read/write happens inside withOrgContext with the org_id from the
 * verified mobile token.
 *
 * ── Composite FKs (hand-written in migration 0035 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [study_grant_org_id_fk]
 *
 *   Composite FK (user_id, org_id) → app_user(id, org_id)
 *     ON DELETE CASCADE  [study_grant_user_org_fk]
 *     A grant has no meaning once its member is gone.
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 *   Composite FK (granted_by, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [study_grant_granted_by_org_fk]
 *     Attribution on who granted access is preserved.
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * study_grant_id_org_id_unique UNIQUE (id, org_id) — composite candidate key.
 * study_grant_org_user_scope_active_unique — PARTIAL unique index
 *   (org_id, user_id, scope) WHERE revoked_at IS NULL, hand-written in the
 *   migration SQL (Drizzle's uniqueIndex cannot express the WHERE clause in
 *   this repo's convention): at most one ACTIVE grant per (member, scope);
 *   revoked history rows may repeat.
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

export const studyGrant = pgTable(
  'study_grant',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // userId carries no .references() — composite FK
    // (user_id, org_id) → app_user(id, org_id) ON DELETE CASCADE is
    // hand-written in migration 0035.
    userId: uuid('user_id').notNull(),

    // 'all_access' or a cert code like 'PAR' (CHECK in migration 0035).
    scope: text('scope').notNull(),

    // grantedBy carries no .references() — composite FK
    // (granted_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT is
    // hand-written in migration 0035.
    grantedBy: uuid('granted_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('study_grant_id_org_id_unique').on(t.id, t.orgId),
    index('study_grant_org_user_idx').on(t.orgId, t.userId),
    // study_grant_org_user_scope_active_unique (partial, WHERE revoked_at IS
    // NULL) is hand-written in migration 0035 — see file header.
  ],
);

export type StudyGrantSelect = typeof studyGrant.$inferSelect;
export type StudyGrantInsert = typeof studyGrant.$inferInsert;
