/**
 * dispatch_requirement — per-aircraft free-text tag requirements for dispatch.
 *
 * An operator attaches one or more opaque labels to a resource (aircraft).
 * At check-out the system computes a set difference: if the pilot's member_tag
 * set does not include every required_tag on the aircraft, dispatch is blocked
 * (or warned, depending on dispatch_config.eligibility_mode).
 *
 * [VERIFY-3c-A] (HARD COMPLIANCE LINE): required_tag is a FREE-TEXT operator
 * label ONLY. The system computes/interprets NO FAA currency, medical, flight-
 * review, Part 61/141, endorsement, or eligibility status from the tag value.
 * Eligibility blocking = the operator enforcing their own rule. Compliance
 * confirms at QA.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0009).
 *
 * Tags are add/remove only — there is NO updated_at column. An unwanted
 * requirement is deleted and re-added with the corrected label (not mutated).
 *
 * ── Composite FKs (hand-written in migration 0009 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; composite FKs are
 * written in the migration; affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [dispatch_requirement_org_id_fk]
 *     Tenant spine — deleting an org cascades to its requirements.
 *
 *   Composite FK (resource_id, org_id) → resource(id, org_id) ON DELETE CASCADE
 *     [dispatch_requirement_resource_org_fk]
 *     Requirements are config, not audited records — CASCADE is correct.
 *     Prevents cross-org resource references.
 *     Targets resource_id_org_id_unique established in migration 0002.
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     [dispatch_requirement_created_by_org_fk]
 *     Preserves attribution: prevents deleting the creating user while their
 *     authorship record exists. Targets app_user_id_org_id_unique (0000).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * dispatch_requirement_tag_nonempty_check:
 *   char_length(btrim(required_tag)) > 0
 *   Prevents blank-only or empty tags; UI trims before sending.
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * dispatch_requirement_resource_tag_unique UNIQUE (resource_id, required_tag)
 *   Case-sensitive exact match; same tag may not appear twice for one aircraft.
 *
 * dispatch_requirement_id_org_id_unique UNIQUE (id, org_id)
 *   Composite candidate key — forward-compat for future composite FKs,
 *   consistent with all other tenant tables.
 *
 * ── Index ─────────────────────────────────────────────────────────────────────
 * dispatch_requirement_org_resource_idx (org_id, resource_id)
 *   Covers: list requirements for an aircraft —
 *   WHERE org_id = $1 AND resource_id = $2
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

export const dispatchRequirement = pgTable(
  'dispatch_requirement',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — simple FK covers Drizzle ergonomics; the named composite FK
    // dispatch_requirement_org_id_fk is hand-written in migration 0009.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // resource_id carries no .references() — composite FK
    // (resource_id, org_id) → resource(id, org_id) ON DELETE CASCADE
    // is hand-written in migration 0009.
    resourceId: uuid('resource_id').notNull(),

    // FREE-TEXT operator label. [VERIFY-3c-A]: no regulatory meaning attached.
    // dispatch_requirement_tag_nonempty_check ensures btrim(required_tag) has
    // at least one char.
    requiredTag: text('required_tag').notNull(),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0009. Preserves attribution.
    createdBy: uuid('created_by').notNull(),

    // Immutable timestamp. NO updated_at — requirements are add/remove only.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // UNIQUE (resource_id, required_tag) — same tag cannot appear twice for one
    // aircraft. Case-sensitive; UI must trim before sending.
    uniqueIndex('dispatch_requirement_resource_tag_unique').on(t.resourceId, t.requiredTag),

    // Composite candidate key — forward-compat for future composite FKs.
    // Consistent with all other tenant tables.
    uniqueIndex('dispatch_requirement_id_org_id_unique').on(t.id, t.orgId),

    // Covers: list requirements for an aircraft —
    // WHERE org_id = $1 AND resource_id = $2
    index('dispatch_requirement_org_resource_idx').on(t.orgId, t.resourceId),
  ],
);

export type DispatchRequirementSelect = typeof dispatchRequirement.$inferSelect;
export type DispatchRequirementInsert = typeof dispatchRequirement.$inferInsert;
