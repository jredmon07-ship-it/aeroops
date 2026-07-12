/**
 * member_expiration — operator-entered expiration reminder dates attached to a
 * member (Slice FC-P2 / Confirm-Dispatch parity, migration 0039 — STAGED,
 * human-gated, NOT applied).
 *
 * "The operator wants a reminder that this member's <label> expires on this
 * date." label is FREE TEXT (e.g. 'Medical', 'Flight review', 'Rental
 * agreement'); expires_on is a plain calendar DATE handled end-to-end as a
 * 'YYYY-MM-DD' string — NO timezone math anywhere.
 *
 * COMPLIANCE (HARD LINE) [VERIFY-FC-P2-A]: OPERATOR-ENTERED REMINDER DATES
 * ONLY. The system computes NO medical/currency/flight-review/Part-61/141/
 * legal validity DETERMINATION from these dates — "expired"/"due soon" is
 * pure date arithmetic on an operator-entered reminder, surfaced WARN-ONLY.
 * Expirations NEVER block dispatch (the FROZEN openDispatch gate is
 * untouched). Verifying actual validity remains the operator's and pilot's
 * responsibility.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0039).
 * RLS policies are SELECT + INSERT + UPDATE — no DELETE policy (the only
 * sanctioned mutation after INSERT is the active=false soft-deactivate).
 *
 * ── Composite FKs (hand-written in migration 0039 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; composite FKs are
 * written in the migration; affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE
 *
 *   Composite FK (member_user_id, org_id) → app_user(id, org_id)
 *     ON DELETE CASCADE [member_expiration_member_user_org_fk] — reminder
 *     rows are disposable operator reminders, not audited records (mirrors
 *     member_tag_user_org_fk). Targets app_user_id_org_id_unique (0000).
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT [member_expiration_created_by_org_fk] — preserves
 *     attribution (mirrors member_tag_created_by_org_fk).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * member_expiration_label_check: non-empty (trimmed), <= 100 chars.
 * member_expiration_note_check: note NULL or <= 1000 chars.
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * member_expiration_id_org_id_unique UNIQUE (id, org_id) — composite
 *   candidate key, consistent with all other tenant tables.
 *
 * ── Indexes ───────────────────────────────────────────────────────────────────
 * member_expiration_org_member_idx (org_id, member_user_id) — per-member list.
 * member_expiration_org_expires_idx (org_id, expires_on) WHERE active
 *   (partial — migration 0039 SQL only; Drizzle index below is the plain
 *   two-column shape) — org-wide expiring-soon scan.
 */
import {
  pgTable,
  uuid,
  text,
  date,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const memberExpiration = pgTable(
  'member_expiration',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // member_user_id carries no .references() — composite FK
    // (member_user_id, org_id) → app_user(id, org_id) ON DELETE CASCADE
    // is hand-written in migration 0039.
    memberUserId: uuid('member_user_id').notNull(),

    // FREE-TEXT operator label (e.g. 'Medical', 'Flight review').
    // [VERIFY-FC-P2-A]: no regulatory meaning attached.
    label: text('label').notNull(),

    // Calendar date, handled as a 'YYYY-MM-DD' string end to end — NO
    // timezone math on dates (mode:'string' mirrors maintenance_item.due_date).
    expiresOn: date('expires_on', { mode: 'string' }).notNull(),

    note: text('note'),

    // Soft-deactivate flag — the only sanctioned post-INSERT mutation.
    active: boolean('active').notNull().default(true),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0039. Preserves attribution.
    createdBy: uuid('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('member_expiration_id_org_id_unique').on(t.id, t.orgId),
    index('member_expiration_org_member_idx').on(t.orgId, t.memberUserId),
    index('member_expiration_org_expires_idx').on(t.orgId, t.expiresOn),
  ],
);

export type MemberExpirationSelect = typeof memberExpiration.$inferSelect;
export type MemberExpirationInsert = typeof memberExpiration.$inferInsert;
