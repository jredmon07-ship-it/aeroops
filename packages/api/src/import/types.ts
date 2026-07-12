/**
 * import/types.ts — public result/IO types for the Flight Circle data
 * importer (Slice P1.7). Framework-agnostic; no I/O.
 *
 * DESIGN POSTURE:
 *   - Operational refusals (not_found, already_committed, out_of_scope, ...)
 *     are RETURNED as discriminated-union values, NOT thrown. The UI renders
 *     them as messages.
 *   - Auth failures are THROWN as ForbiddenError / UnauthenticatedError.
 *   - Validation failures (bad kind, oversized CSV) are THROWN as ValidationError.
 *
 * SCOPE: members + aircraft roster import ONLY. NO ledger/financial-history
 * import in this slice — see docs/specs/slice-p1-fc-import.md.
 */
import type { ImportKind, ImportSource, ColumnMapping } from '@aeroops/core';

// Re-export for barrel convenience.
export type { ImportKind, ImportSource, ColumnMapping };

export type ImportBatchStatus = 'pending' | 'previewed' | 'committed' | 'failed';
export type ImportRowStatus = 'pending' | 'imported' | 'skipped' | 'error';

// ─── ImportBatchView ────────────────────────────────────────────────────────

export interface ImportBatchView {
  id: string;
  kind: ImportKind;
  source: string;
  status: ImportBatchStatus;
  filename: string;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  errorDetail: string | null;
  /** True when previewImport detected a Sales-Transactions-shaped export. */
  outOfScope: boolean;
  mapping: ColumnMapping;
  createdAt: Date;
  updatedAt: Date;
}

// ─── ImportRowView ────────────────────────────────────────────────────────

export interface ImportRowView {
  id: string;
  rowIndex: number;
  raw: Record<string, string>;
  status: ImportRowStatus;
  errorDetail: string | null;
  targetId: string | null;
  /**
   * Resolved display label for the target (email for members, tail number
   * for aircraft) — populated by getImportBatch's re-read; absent from the
   * previewImport response (nothing has been created yet).
   */
  targetLabel?: string | null;
}

// ─── previewImport ────────────────────────────────────────────────────────

export interface PreviewImportInput {
  kind: ImportKind;
  /**
   * Which tool the CSV came from — purely a migration-source label for
   * import-history attribution + guidance copy. Omit to default to
   * 'flight_circle'. Does NOT change how the file is parsed/mapped/committed.
   */
  source?: ImportSource;
  filename: string;
  csvText: string;
  /** Operator-confirmed mapping. Omit to use guessColumnMapping's best guess. */
  mapping?: ColumnMapping;
}

export type PreviewImportResult =
  | {
      ok: true;
      batch: ImportBatchView;
      mapping: ColumnMapping;
      headers: string[];
      /** Capped preview of staged rows — the FULL set is staged in import_row. */
      rows: ImportRowView[];
      outOfScope: boolean;
    }
  | { ok: false; reason: 'empty_csv' };

// ─── commitImport ─────────────────────────────────────────────────────────

export interface CommitImportInput {
  batchId: string;
}

export interface CommitImportRowResult {
  rowIndex: number;
  status: ImportRowStatus;
  targetId: string | null;
  errorDetail: string | null;
}

export type CommitImportResult =
  | { ok: true; batch: ImportBatchView; results: CommitImportRowResult[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'already_committed' }
  | { ok: false; reason: 'not_previewed' }
  | { ok: false; reason: 'out_of_scope'; message: string };

// ─── listImportBatches / getImportBatch ───────────────────────────────────

export type GetImportBatchResult =
  | { ok: true; batch: ImportBatchView; rows: ImportRowView[] }
  | { ok: false; reason: 'not_found' };
