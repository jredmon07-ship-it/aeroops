/**
 * member_tag — free-text operator labels attached to a member (app_user) within
 * an org. Tags are opaque strings: the system attaches NO regulatory, currency,
 * medical, eligibility, or FAA meaning to them.
 *
 * [VERIFY-6-A] (HARD COMPLIANCE LINE): member_tag.tag is a FREE-TEXT operator
 * label ONLY. The system computes/interprets NO FAA currency, medical, flight-
 * review, Part 61/141, endorsement, or eligibility status from a tag. Eligibility
 * ENFORCEMENT is NOT in this slice — this is only the admin surface the deferred
 * eligibility follow-up will later read. Compliance confirms at QA.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0008).
 *
 * Tags are add/remove only — there is NO updated_at column. An unwanted tag is
 * deleted and a corrected one is re-added (not mutated). This keeps the table
 * semantically clean and avoids partial-update audit complexity.
 *
 * ── Composite FKs (hand-written in migration 0008 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; composite FKs are
 * written in the migration; affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE
 *     Tenant spine — deleting an org cascades to its tags.
 *
 *   Composite FK (user_id, org_id) → app_user(id, org_id) ON DELETE CASCADE
 *     Tags are disposable labels, not audited records — CASCADE is correct here.
 *     Prevents cross-org user references. Targets app_user_id_org_id_unique
 *     established in migration 0000.
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     Preserves attribution: prevents deleting the creating user while their
 *     authorship record exists. Targets app_user_id_org_id_unique (0000).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * member_tag_tag_nonempty_check:
 *   char_length(btrim(tag)) > 0
 *   Prevents blank-only or empty tags; UI trims before sending.
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * member_tag_user_id_tag_unique UNIQUE (user_id, tag)
 *   Case-sensitive exact match; same tag may exist on different members.
 *
 * member_tag_id_org_id_unique UNIQUE (id, org_id)
 *   Composite candidate key — forward-compat for future composite FKs,
 *   consistent with all other tenant tables.
 *
 * ── Index ─────────────────────────────────────────────────────────────────────
 * member_tag_org_user_idx (org_id, user_id)
 *   Covers: listTags for a member — WHERE org_id = $1 AND user_id = $2
 */
import {
  pgTable,
  uuid,
  timestamp,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const memberTag = pgTable(
  'member_tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — simple FK covers Drizzle ergonomics; the named composite FK
    // member_tag_org_id_fk is hand-written in migration 0008.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // user_id carries no .references() — composite FK
    // (user_id, org_id) → app_user(id, org_id) ON DELETE CASCADE
    // is hand-written in migration 0008.
    userId: uuid('user_id').notNull(),

    // FREE-TEXT operator label. [VERIFY-6-A]: no regulatory meaning attached.
    // member_tag_tag_nonempty_check ensures btrim(tag) has at least one char.
    tag: text('tag').notNull(),

    // OPTIONAL palette-key color hint (migration 0041). Nullable → the UI
    // renders the neutral 'slate' default. Constrained to a fixed palette KEY
    // set by member_tag_color_check (hand-written in migration 0041). This is a
    // DISPLAY hint ONLY — [VERIFY-6-A] the tag (and its color) carry no
    // regulatory/eligibility meaning. The UI maps a key to a literal class (no
    // dynamic class construction).
    color: text('color'),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0008. Preserves attribution.
    createdBy: uuid('created_by').notNull(),

    // Immutable timestamp. NO updated_at — tags are add/remove only.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // UNIQUE (user_id, tag) — same tag cannot appear twice for one member.
    // Case-sensitive; UI must trim before sending.
    uniqueIndex('member_tag_user_id_tag_unique').on(t.userId, t.tag),

    // Composite candidate key — forward-compat for future composite FKs.
    // Consistent with all other tenant tables.
    uniqueIndex('member_tag_id_org_id_unique').on(t.id, t.orgId),

    // Covers: listTags for a member — WHERE org_id = $1 AND user_id = $2
    index('member_tag_org_user_idx').on(t.orgId, t.userId),
  ],
);

export type MemberTagSelect = typeof memberTag.$inferSelect;
export type MemberTagInsert = typeof memberTag.$inferInsert;
