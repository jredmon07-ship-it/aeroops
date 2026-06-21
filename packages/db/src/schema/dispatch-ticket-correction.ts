/**
 * dispatch_ticket_correction — append-only corrections to a CLOSED dispatch
 * ticket's recorded meters.
 *
 * ── Records posture (ADR-0007 §1) ───────────────────────────────────────────
 * The FROZEN write-once close path (closeDispatch) is NEVER mutated. Any
 * correction to a closed ticket's hobbs_in / tach_in is expressed as a NEW
 * row in this table. The effective meter for any downstream consumer (billing,
 * utilization) is:
 *
 *   latest correction for this ticket ?? the ticket's original _in values
 *
 * Corrections are themselves immutable once inserted. A subsequent correction
 * is a NEW row — the latest row per ticket wins (ORDER BY created_at DESC
 * LIMIT 1). There is no "undo a correction" concept; if a correction was wrong,
 * insert another correction with the right values.
 *
 * NO updated_at column — rows are immutable by design (mirrors audit_log).
 *
 * ── Append-only enforcement (migration 0018) ─────────────────────────────────
 * The migration applies ONLY SELECT + INSERT RLS policies. No UPDATE or DELETE
 * policy exists. With FORCE ROW LEVEL SECURITY enabled, the absence of a
 * permissive UPDATE/DELETE policy means those operations are blocked for ALL
 * roles (including the table owner when connecting as aeroops_app). This is the
 * records-integrity headline guarantee — mirroring audit_log exactly.
 *
 * GRANT is SELECT + INSERT only (NOT UPDATE, NOT DELETE). An explicit REVOKE
 * UPDATE, DELETE on dispatch_ticket_correction FROM aeroops_app is applied as a
 * belt-and-suspenders backstop.
 *
 * ── Tenant scope ─────────────────────────────────────────────────────────────
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 *
 * ── Composite FKs (hand-written in migration 0018 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE
 *     Tenant spine — deleting an org cascades to its corrections.
 *     Also expressed via .references() on orgId for Drizzle-level ergonomics.
 *
 *   Composite FK (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
 *     ON DELETE RESTRICT:
 *     Prevents hard-deleting a dispatch ticket that has correction records
 *     (records integrity). Targets dispatch_ticket_id_org_id_unique (migration
 *     0005). dispatch_ticket_id carries no .references() here.
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT:
 *     Corrector must be a member of the same org; prevents referencing a user
 *     in a different org (cross-org guard). Also prevents deleting a user who
 *     has authored corrections (records integrity — corrections are immutable
 *     and the authoring identity must persist). created_by carries no
 *     .references() here.
 *
 * ── CHECKs ───────────────────────────────────────────────────────────────────
 * correction_at_least_one_meter_check:
 *   corrected_hobbs IS NOT NULL OR corrected_tach IS NOT NULL
 *   A correction that adjusts neither meter is a no-op and is rejected.
 *
 * correction_hobbs_nonneg_check:
 *   corrected_hobbs IS NULL OR corrected_hobbs >= 0
 *   Mirrors dispatch_meters_nonneg_check on dispatch_ticket.
 *
 * correction_tach_nonneg_check:
 *   corrected_tach IS NULL OR corrected_tach >= 0
 *   Mirrors dispatch_meters_nonneg_check on dispatch_ticket.
 *
 * correction_reason_nonempty_check:
 *   char_length(btrim(reason)) > 0
 *   A correction without a stated reason is rejected.
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — forward-compat for future composite FKs and
 * consistent with all other tenant tables.
 *
 * ── Index ─────────────────────────────────────────────────────────────────────
 * correction_org_ticket_created_idx (org_id, dispatch_ticket_id, created_at DESC)
 *   Covers: "latest correction per ticket" lookup — the primary query pattern
 *   for effective-meter derivation.
 *   e.g. SELECT * FROM dispatch_ticket_correction
 *          WHERE org_id = $1 AND dispatch_ticket_id = $2
 *          ORDER BY created_at DESC LIMIT 1
 *
 * ── Compliance / audit note ──────────────────────────────────────────────────
 * dispatch_ticket_correction is OPERATOR RECORDS-INTEGRITY data. Corrections
 * adjust Hobbs/tach meter readings recorded at CLOSE time. They are:
 *   - NOT a FAA Part-43/airworthiness determination.
 *   - NOT a flight-log/logbook amendment (Part 61/141).
 *   - NOT a billing instrument — billing CONSUMES the effective meter;
 *     billing-level adjustments (credit memo, re-invoice) are a Phase-2 concern.
 * [VERIFY-B0-COMP-1]: confirm with compliance whether meter corrections require
 * dual-signature or additional audit chain before Phase-2 billing consumes them.
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

export const dispatchTicketCorrection = pgTable(
  'dispatch_ticket_correction',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0018. The simple .references() here covers Drizzle-level
    // ergonomics; the hand-written FK provides named-constraint auditability.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // dispatch_ticket_id carries no .references() — composite FK
    // (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
    // ON DELETE RESTRICT is hand-written in migration 0018 (Drizzle cannot
    // express multi-col FKs). Targets dispatch_ticket_id_org_id_unique (0005).
    dispatchTicketId: uuid('dispatch_ticket_id').notNull(),

    // Corrected meter values — both are nullable because a correction may
    // adjust hobbs only, tach only, or both. At least one must be non-null
    // (enforced by correction_at_least_one_meter_check).
    //
    // numeric(10,1): same precision as dispatch_ticket.hobbs_in / tach_in.
    // Non-negativity enforced by correction_hobbs_nonneg_check /
    // correction_tach_nonneg_check (mirrors dispatch_meters_nonneg_check).
    correctedHobbs: numeric('corrected_hobbs', { precision: 10, scale: 1 }),

    correctedTach: numeric('corrected_tach', { precision: 10, scale: 1 }),

    // Mandatory free-text reason explaining why the correction was needed.
    // correction_reason_nonempty_check enforces btrim(reason) non-empty.
    reason: text('reason').notNull(),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0018. Corrector must be a member of the
    // same org.
    createdBy: uuid('created_by').notNull(),

    // Append timestamp — immutable once set (no updated_at; mirrors audit_log).
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — forward-compat for future composite FKs and
    // consistent with all other tenant tables.
    uniqueIndex('dispatch_ticket_correction_id_org_id_unique').on(t.id, t.orgId),

    // Covers: effective-meter derivation — "latest correction per ticket".
    // e.g. WHERE org_id = $1 AND dispatch_ticket_id = $2 ORDER BY created_at DESC LIMIT 1
    index('correction_org_ticket_created_idx').on(
      t.orgId,
      t.dispatchTicketId,
      t.createdAt,
    ),
  ],
);

export type DispatchTicketCorrectionSelect = typeof dispatchTicketCorrection.$inferSelect;
export type DispatchTicketCorrectionInsert = typeof dispatchTicketCorrection.$inferInsert;
