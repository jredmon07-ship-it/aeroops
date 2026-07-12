/**
 * logbook_annotation — append-only per-flight pilot-logbook annotations
 * (night / instrument / cross-country time + remarks) on a CLOSED dispatch
 * ticket (Slice P2-LOG2).
 *
 * ── Records posture ──────────────────────────────────────────────────────────
 * The FROZEN dispatch close path (ADR-0007) is NEVER mutated — annotations
 * live entirely in this side table. The EFFECTIVE annotation for a ticket is
 * the LATEST row (ORDER BY created_at DESC LIMIT 1 per dispatch_ticket_id) —
 * exactly the dispatch_ticket_correction latest-wins pattern (migration 0018).
 * A mistaken annotation is superseded by a NEW row, never edited.
 *
 * NO updated_at column — rows are immutable once inserted (mirrors audit_log).
 *
 * ── Append-only enforcement (migration 0037) ─────────────────────────────────
 * ONLY SELECT + INSERT RLS policies; no UPDATE/DELETE policy. With FORCE ROW
 * LEVEL SECURITY the absence of a permissive policy blocks those operations
 * for ALL roles. GRANT is SELECT + INSERT only; REVOKE UPDATE, DELETE is the
 * belt-and-suspenders backstop.
 *
 * ── Tenant scope ─────────────────────────────────────────────────────────────
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 *
 * ── Composite FKs (hand-written in migration 0037 SQL) ───────────────────────
 * Drizzle cannot express multi-column FKs; the affected columns carry NO
 * .references():
 *   (org_id) → org(id) ON DELETE CASCADE (also via .references() ergonomics).
 *   (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id) RESTRICT.
 *   (pilot_user_id, org_id) → app_user(id, org_id) RESTRICT.
 *   (created_by, org_id) → app_user(id, org_id) RESTRICT.
 *
 * ── CHECKs (migration 0037) ──────────────────────────────────────────────────
 * Each hours column NULL or in [0, 99.9]; at least one of the four annotation
 * fields present; remarks NULL or non-empty trimmed and <= 2000 chars.
 *
 * ── Compliance note ──────────────────────────────────────────────────────────
 * PILOT/OPERATOR-ENTERED DATA — NOT an FAA logbook of record, NOT a certified
 * §61.51 entry. AeroOps makes NO computed currency/recency/experience
 * determination (§61.51 / §61.57) from these values.
 */
import {
  pgTable,
  uuid,
  timestamp,
  text,
  numeric,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const logbookAnnotation = pgTable(
  'logbook_annotation',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0037; the simple .references() covers Drizzle ergonomics.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // Composite FK (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
    // ON DELETE RESTRICT — hand-written in migration 0037.
    dispatchTicketId: uuid('dispatch_ticket_id').notNull(),

    // The ticket's pilot — snapshotted from dispatch_ticket.pilot_user_id at
    // annotate time (never caller-supplied). Composite FK
    // (pilot_user_id, org_id) → app_user(id, org_id) RESTRICT in migration 0037.
    pilotUserId: uuid('pilot_user_id').notNull(),

    // Pilot/operator-entered flight-condition hours. All nullable; at least
    // one of the four annotation fields must be present (CHECK).
    // numeric(5,1): tenths precision; CHECK narrows to [0, 99.9].
    nightHours: numeric('night_hours', { precision: 5, scale: 1 }),
    instrumentHours: numeric('instrument_hours', { precision: 5, scale: 1 }),
    crossCountryHours: numeric('cross_country_hours', { precision: 5, scale: 1 }),

    // Free-text remarks — NULL or non-empty trimmed, <= 2000 chars (CHECK).
    remarks: text('remarks'),

    // Composite FK (created_by, org_id) → app_user(id, org_id) RESTRICT.
    createdBy: uuid('created_by').notNull(),

    // Append timestamp — immutable once set (no updated_at; mirrors audit_log).
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consistent with all tenant tables.
    uniqueIndex('logbook_annotation_id_org_id_unique').on(t.id, t.orgId),

    // Covers: effective-annotation derivation — "latest annotation per ticket".
    index('logbook_annotation_org_ticket_created_idx').on(
      t.orgId,
      t.dispatchTicketId,
      t.createdAt,
    ),
  ],
);

export type LogbookAnnotationSelect = typeof logbookAnnotation.$inferSelect;
export type LogbookAnnotationInsert = typeof logbookAnnotation.$inferInsert;
