/**
 * import_row — one row per parsed CSV line, staged by previewImport and
 * updated in place by commitImport (Slice P1.7, migration 0027).
 *
 * Lifecycle: previewImport INSERTs every parsed CSV line with mapped_status
 * computed as 'pending' (will attempt import), 'skipped' (duplicate detected
 * at preview time), or 'error' (failed normalization). commitImport then
 * UPDATEs each 'pending' row to 'imported' (target_id set to the newly
 * created app_user/resource id), 'skipped' (a duplicate surfaced at commit
 * time), or 'error' (the write path refused/threw) — a bad row updates to
 * 'error' and the loop continues; it never aborts the whole batch.
 *
 * UNLIKE the fully-immutable append-only family (audit_log, ledger_entry,
 * dispatch_ticket_correction, notification_log, qbo_export_log), this table
 * carries an UPDATE policy (see migration 0027 file header for the full
 * rationale) — it is an operator-facing staging/audit convenience, not a
 * financial or regulatory record, so no compliance guarantee rides on strict
 * INSERT-only immutability. It is still never DELETEd (no DELETE policy/grant).
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE.
 *
 * ── Composite FKs (hand-written in migration 0027 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [import_row_org_id_fk]
 *     Tenant spine.
 *
 *   Composite FK (import_batch_id, org_id) → import_batch(id, org_id)
 *     ON DELETE CASCADE  [import_row_batch_org_fk]
 *     A staging row has no meaning once its batch is gone.
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * import_row_id_org_id_unique UNIQUE (id, org_id) — composite candidate key.
 * import_row_batch_rowindex_unique UNIQUE (import_batch_id, row_index) — one
 *   staged row per CSV line per batch.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * import_row_mapped_status_check: mapped_status IN
 *   ('pending','imported','skipped','error').
 * import_row_row_index_nonneg_check: row_index >= 0.
 *
 * target_id: the created app_user.id (members batch) or resource.id
 * (aircraft batch). Deliberately carries NO FK — it is polymorphic depending
 * on the parent batch's kind, so a single-target foreign key cannot be
 * expressed. The command layer (get-import-batch.ts) is the source of truth
 * for resolving target_id back to a display row, scoped by the batch's kind.
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

export const importRow = pgTable(
  'import_row',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // importBatchId carries no .references() — composite FK
    // (import_batch_id, org_id) → import_batch(id, org_id) ON DELETE CASCADE
    // is hand-written in migration 0027.
    importBatchId: uuid('import_batch_id').notNull(),

    rowIndex: integer('row_index').notNull(),

    // The parsed CSV row, keyed by CSV header name → raw string value.
    // NEVER interpreted here — the pure @aeroops/core normalizers own all
    // parsing/validation; this column is the auditable "what was ingested".
    rawData: jsonb('raw_data').notNull(),

    // import_row_mapped_status_check: 'pending' | 'imported' | 'skipped' | 'error'.
    mappedStatus: text('mapped_status').notNull().default('pending'),

    // Polymorphic target — see file header. NULL until mappedStatus='imported'.
    targetId: uuid('target_id'),

    errorDetail: text('error_detail'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('import_row_id_org_id_unique').on(t.id, t.orgId),
    uniqueIndex('import_row_batch_rowindex_unique').on(t.importBatchId, t.rowIndex),
    index('import_row_org_batch_idx').on(t.orgId, t.importBatchId, t.rowIndex),
    index('import_row_org_batch_status_idx').on(t.orgId, t.importBatchId, t.mappedStatus),
  ],
);

export type ImportRowSelect = typeof importRow.$inferSelect;
export type ImportRowInsert = typeof importRow.$inferInsert;
