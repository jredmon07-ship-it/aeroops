/**
 * import_batch — one row per uploaded Flight-Circle-export CSV file
 * (Slice P1.7, migration 0027).
 *
 * Written by previewImport (INSERT, status='previewed') and updated by
 * commitImport (status → 'committed'|'failed', imported_count/skipped_count
 * set). STANDARD 4-policy mutable RLS (mirrors migration 0024's
 * stripe_payment_method/autopay_setting) — this is NOT an append-only table.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE.
 *
 * ── Composite FKs (hand-written in migration 0027 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [import_batch_org_id_fk]
 *     Tenant spine.
 *
 *   Composite FK (created_by, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [import_batch_created_by_org_fk]
 *     The staff member who uploaded the file. RESTRICT preserves
 *     import-history attribution (mirrors rate_schedule.created_by).
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * import_batch_source_check:  source IN ('flight_circle')
 * import_batch_kind_check:    kind IN ('members','aircraft')
 * import_batch_status_check:  status IN ('pending','previewed','committed','failed')
 * import_batch_counts_nonneg_check: row_count/imported_count/skipped_count >= 0
 * import_batch_filename_nonempty_check: char_length(btrim(filename)) > 0
 *
 * error_detail also doubles as the out-of-scope marker: when previewImport
 * detects a Sales-Transactions-shaped CSV (looksLikeSalesTransactionsExport,
 * @aeroops/core), it writes a human-readable "out_of_scope: ..." message here
 * and commitImport refuses to commit that batch. NO ledger/financial-history
 * kind or table exists in this slice.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const importBatch = pgTable(
  'import_batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // import_batch_source_check: only 'flight_circle' in this slice.
    source: text('source').notNull().default('flight_circle'),

    // import_batch_kind_check: 'members' | 'aircraft'.
    kind: text('kind').notNull(),

    // import_batch_status_check: 'pending' | 'previewed' | 'committed' | 'failed'.
    status: text('status').notNull().default('pending'),

    filename: text('filename').notNull(),

    rowCount: integer('row_count').notNull().default(0),
    importedCount: integer('imported_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),

    // Human-readable failure/out-of-scope message. Doubles as the
    // out-of-scope-for-commit marker (see file header).
    errorDetail: text('error_detail'),

    // The CONFIRMED column mapping (field name -> CSV header name) used at
    // preview time. commitImport re-derives each row's normalized candidate
    // from import_row.raw_data using THIS mapping — never re-guessed, never
    // re-asked of the operator, so preview and commit can never disagree.
    mapping: jsonb('mapping').notNull().default({}),

    // created_by carries no .references() — composite FK
    // (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0027.
    createdBy: uuid('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('import_batch_id_org_id_unique').on(t.id, t.orgId),
    index('import_batch_org_created_idx').on(t.orgId, t.createdAt),
  ],
);

export type ImportBatchSelect = typeof importBatch.$inferSelect;
export type ImportBatchInsert = typeof importBatch.$inferInsert;
