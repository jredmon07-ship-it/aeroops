/**
 * schedule_optimization_run — audited header for one auto-schedule optimizer run.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 *
 * An optimizer run is INSERT-ONCE (no updated_at column; a run is written once).
 * The run header stores the demand set + constraints used as input (for
 * reproducibility) and the aggregate outcome (created_count, skipped_count).
 * Per-proposal outcomes are reconstructable from each created reservation's
 * audit row (metadata.optimizationRunId).
 *
 * NO MONEY: this table schedules time only; no price, invoice, or payment data.
 *
 * ── Composite FKs (hand-written in migration 0011 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; composite FKs are
 * written in the migration; affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [schedule_optimization_run_org_id_fk]
 *     Tenant spine — deleting an org cascades to its run records.
 *
 *   Composite FK (requested_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     [schedule_optimization_run_requested_by_org_fk]
 *     Preserves attribution: prevents deleting the requesting user while their
 *     run record exists. Targets app_user_id_org_id_unique (0000).
 *     NO simple .references() on requested_by — composite FK only.
 *
 * ── Seed column type ─────────────────────────────────────────────────────────
 * seed is bigint({ mode: 'number' }) → Postgres bigint (int8), TypeScript number.
 * This maps to Drizzle's PgBigInt53 variant, which enforces JS-safe-integer
 * semantics (values 0..Number.MAX_SAFE_INTEGER = 2^53-1). A 53-bit range
 * comfortably exceeds the common 32-bit / 48-bit random seed range while
 * remaining representable as a JS number with no loss of precision. The
 * optimizer injects `seed` as a plain number; storing it as bigint in Postgres
 * preserves full precision and makes determinism auditable.
 * Nullable: a NULL seed means the run was not reproducibly seeded (future use).
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — forward-compat for future composite FKs that may
 * reference schedule_optimization_run(id, org_id). Consistent with all other
 * tenant tables.
 *
 * ── Indexes ──────────────────────────────────────────────────────────────────
 * (org_id, created_at DESC) — covers "list recent runs for this org" query.
 * e.g. listOptimizationRuns: WHERE org_id = $1 ORDER BY created_at DESC
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * schedule_optimization_run_counts_check:
 *   created_count >= 0 AND skipped_count >= 0
 *   Prevents negative counts (defensive; the API layer also validates).
 */
import {
  pgTable,
  uuid,
  timestamp,
  jsonb,
  bigint,
  integer,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const scheduleOptimizationRun = pgTable(
  'schedule_optimization_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — simple FK covers Drizzle ergonomics; the named FK
    // schedule_optimization_run_org_id_fk is hand-written in migration 0011.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // requested_by carries no .references() — composite FK
    // (requested_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0011. Preserves attribution.
    requestedBy: uuid('requested_by').notNull(),

    // The demand set + constraints snapshot used as optimizer input.
    // Stored as-is for reproducibility (re-running with the same input + seed
    // should produce the same proposal set). JSONB for efficient indexing.
    inputJsonb: jsonb('input_jsonb').notNull(),

    // Determinism seed (JS-safe integer, nullable).
    // bigint mode:'number' → PgBigInt53 → Postgres int8 (64-bit), TS number.
    // Stores values 0..Number.MAX_SAFE_INTEGER (2^53-1) with no precision loss.
    // NULL = unseeded run (not yet used; forward seam).
    seed: bigint('seed', { mode: 'number' }),

    // Aggregate outcome counters. Both default 0 (written at commit time).
    // schedule_optimization_run_counts_check enforces non-negativity.
    createdCount: integer('created_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),

    // Insert-once timestamp. NO updated_at — a run is written once.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — forward-compat for future composite FKs.
    // Consistent with all other tenant tables.
    uniqueIndex('schedule_optimization_run_id_org_id_unique').on(t.id, t.orgId),

    // Covers: list recent optimizer runs for an org.
    // e.g. listOptimizationRuns: WHERE org_id = $1 ORDER BY created_at DESC
    index('schedule_optimization_run_org_created_idx').on(t.orgId, t.createdAt),
  ],
);

export type ScheduleOptimizationRunSelect = typeof scheduleOptimizationRun.$inferSelect;
export type ScheduleOptimizationRunInsert = typeof scheduleOptimizationRun.$inferInsert;
