/**
 * study_progress — a member's AeroStudy knowledge-test readiness read model
 * (Slice STUDY-1, migration 0035 — STAGED, human-gated, NOT applied).
 *
 * Compact per-(org, user, cert) summary UPSERTED by the mobile app for the
 * signed-in member ONLY (POST /api/mobile/v1/study/progress, self-scoped to
 * session.userId). Always the LATEST summary, never a log — NO raw answer
 * data, NO PII beyond the app_user already in the org. Later read by
 * cfi/manager/owner for the CFI dashboard (forward seam).
 *
 * COMPLIANCE: student-entered study-app data — NOT an FAA knowledge-test
 * result, endorsement, or Part 61/141 determination.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE + the standard
 * 4-policy pattern (migration 0035).
 *
 * ── Composite FKs (hand-written in migration 0035 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [study_progress_org_id_fk]
 *
 *   Composite FK (user_id, org_id) → app_user(id, org_id)
 *     ON DELETE CASCADE  [study_progress_user_org_fk]
 *     A derived read model has no meaning once its member is gone.
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * study_progress_id_org_id_unique UNIQUE (id, org_id) — composite candidate key.
 * study_progress_org_user_cert_unique UNIQUE (org_id, user_id, cert_code) —
 *   the upsert conflict target (ON CONFLICT … DO UPDATE): exactly one
 *   readiness row per member per cert.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const studyProgress = pgTable(
  'study_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // userId carries no .references() — composite FK
    // (user_id, org_id) → app_user(id, org_id) ON DELETE CASCADE is
    // hand-written in migration 0035.
    userId: uuid('user_id').notNull(),

    // A cert code like 'PAR' — never 'all_access' (CHECK in migration 0035).
    certCode: text('cert_code').notNull(),

    // Fraction in [0, 1] (CHECK in migration 0035). NOT money.
    readinessPercent: numeric('readiness_percent', { precision: 5, scale: 4 }).notNull(),

    // Count, >= 0 (CHECK in migration 0035).
    questionsLogged: integer('questions_logged').notNull(),

    lastStudiedAt: timestamp('last_studied_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('study_progress_id_org_id_unique').on(t.id, t.orgId),
    uniqueIndex('study_progress_org_user_cert_unique').on(t.orgId, t.userId, t.certCode),
  ],
);

export type StudyProgressSelect = typeof studyProgress.$inferSelect;
export type StudyProgressInsert = typeof studyProgress.$inferInsert;
