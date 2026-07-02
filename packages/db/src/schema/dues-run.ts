/**
 * dues_run — APPEND-ONLY period marker; THE STRUCTURAL no-double-bill
 * mechanism for recurring dues generation (Slice P0-REV, migration 0025).
 *
 * generateDuesInvoices creates the DRAFT invoice (+ its one line item) FIRST,
 * then inserts this marker carrying that invoice's id (see the command's
 * comment for the exact ordering — a SAVEPOINT rollback discards the
 * tentative invoice if this INSERT conflicts, i.e. this period was already
 * run for this schedule).
 *
 * SELECT + INSERT RLS policies ONLY (mirrors ledger_entry /
 * dispatch_ticket_correction / stripe_event) — no UPDATE/DELETE policy;
 * FORCE RLS blocks those operations for aeroops_app. No updated_at (immutable
 * by design — invoice_id is always set at INSERT time).
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0025).
 *
 * ── Composite FKs (hand-written in migration 0025 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [dues_run_org_id_fk]
 *
 *   Composite FK (dues_schedule_id, org_id) → dues_schedule(id, org_id)
 *     ON DELETE RESTRICT  [dues_run_schedule_org_fk]
 *     Targets dues_schedule_id_org_id_unique (migration 0025).
 *
 *   Composite FK (invoice_id, org_id) → invoice(id, org_id)
 *     ON DELETE RESTRICT  [dues_run_invoice_org_fk]
 *     Targets invoice_id_org_id_unique (migration 0019).
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * dues_run_org_schedule_period_unique UNIQUE (org_id, dues_schedule_id,
 *   period_key) — THE IDEMPOTENCY KEY: a schedule generates AT MOST ONE
 *   invoice per period.
 * dues_run_id_org_id_unique UNIQUE (id, org_id) — composite candidate key.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * dues_run_period_key_format_check: period_key ~ '^[0-9]{4}-[0-9]{2}$' ("YYYY-MM")
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

export const duesRun = pgTable(
  'dues_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // dues_schedule_id / invoice_id carry no .references() — composite FKs
    // are hand-written in migration 0025.
    duesScheduleId: uuid('dues_schedule_id').notNull(),

    // "YYYY-MM" — dues_run_period_key_format_check.
    periodKey: text('period_key').notNull(),

    invoiceId: uuid('invoice_id').notNull(),

    // No updated_at — immutable by design.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dues_run_org_schedule_period_unique').on(t.orgId, t.duesScheduleId, t.periodKey),
    uniqueIndex('dues_run_id_org_id_unique').on(t.id, t.orgId),
    index('dues_run_org_created_idx').on(t.orgId, t.createdAt),
  ],
);

export type DuesRunSelect = typeof duesRun.$inferSelect;
export type DuesRunInsert = typeof duesRun.$inferInsert;
