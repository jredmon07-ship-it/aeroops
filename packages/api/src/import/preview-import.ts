/**
 * import/preview-import.ts — previewImport (Slice P1.7).
 *
 * Parses an operator-uploaded CSV (members or aircraft), stages EVERY row in
 * import_row (auditable "what was ingested"), and returns a preview summary —
 * WITHOUT creating any real app_user/resource record. The operator reviews
 * (and can re-preview with a corrected mapping) before ever calling
 * commitImport.
 *
 * GUARANTEES:
 *   - Input validated (zod) BEFORE any capability check needs the parsed
 *     `kind`; requireCapability then gates on that kind (people:manage for
 *     members, fleet:manage for aircraft) BEFORE any DB access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Idempotent-safe: previewing the SAME file twice creates two SEPARATE
 *     batches (by design — re-preview after fixing a mapping is a fresh
 *     attempt); nothing is committed here regardless.
 *   - Duplicate detection against BOTH existing org records (fresh read) AND
 *     other rows within the same file (running Set) — flagged 'skipped' at
 *     staging time, never silently dropped.
 *   - A Sales-Transactions-shaped CSV (looksLikeSalesTransactionsExport) is
 *     still fully staged (for visibility/audit) but every row is marked
 *     'error' and the batch carries an OUT_OF_SCOPE_PREFIX error_detail —
 *     commitImport refuses it. NO ledger/financial-history import.
 *   - ONE audit_log row 'import.previewed'.
 *
 * TWO CALLING FORMS:
 *   previewImport(session, input)          — app code.
 *   previewImportWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { importBatch, importRow, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import {
  parseCsv,
  guessColumnMapping,
  looksLikeSalesTransactionsExport,
  normalizeMemberRow,
  normalizeAircraftRow,
} from '@aeroops/core';
import type { ImportKind, ColumnMapping } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import {
  OUT_OF_SCOPE_PREFIX,
  capabilityForImportKind,
  loadExistingMemberEmails,
  loadExistingAircraftTails,
  toImportBatchView,
} from './internal.js';
import type { PreviewImportResult, PreviewImportInput, ImportRowView, ImportRowStatus } from './types.js';

// A generous but bounded ceiling — protects the staging table from a
// runaway upload. Real operator exports (even a large club's full roster)
// are well under this; chunked/streaming import is a forward seam if a
// larger school ever needs it.
const MAX_CSV_LEN = 5_000_000; // ~5MB
const MAX_ROWS = 10_000;
/** Capped preview payload returned inline — the FULL set is staged in import_row regardless. */
const PREVIEW_ROW_CAP = 500;

const mappingValueSchema = z.string().nullable();

const previewImportInputSchema = z.object({
  kind: z.enum(['members', 'aircraft']),
  // Migration-source label only — the parse/map/write path is source-agnostic.
  // Defaults to 'flight_circle' so existing callers (and the DB column default)
  // are byte-identical.
  source: z.enum(['flight_circle', 'myfbo', 'other']).default('flight_circle'),
  filename: z.string().min(1).max(255),
  csvText: z.string().min(1).max(MAX_CSV_LEN),
  mapping: z.record(z.string(), mappingValueSchema).optional(),
});

interface StagedRow {
  rowIndex: number;
  raw: Record<string, string>;
  status: ImportRowStatus;
  errorDetail: string | null;
}

async function _previewImportImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<PreviewImportResult> {
  // 1. VALIDATE input shape first (need `kind` to pick the right capability).
  const parsed = previewImportInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[import] invalid previewImport input: ${first?.message ?? 'unknown'}`);
  }
  const input: PreviewImportInput = parsed.data;

  // 2. AUTHZ — before any DB access.
  requireCapability(session, capabilityForImportKind(input.kind));

  // 3. Parse CSV (pure, never throws).
  const { headers, rows: rawRows } = parseCsv(input.csvText);
  if (headers.length === 0 || rawRows.length === 0) {
    return { ok: false, reason: 'empty_csv' };
  }
  if (rawRows.length > MAX_ROWS) {
    throw new ValidationError(
      `[import] previewImport: ${rawRows.length} rows exceeds the ${MAX_ROWS}-row limit for this slice.`,
    );
  }

  const mapping: ColumnMapping = input.mapping ?? guessColumnMapping(headers, input.kind);
  const outOfScope = looksLikeSalesTransactionsExport(headers);

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 4. Load existing dedupe keys — fresh, RLS-scoped preview-time snapshot.
    const seen = new Set<string>(
      input.kind === 'members'
        ? await loadExistingMemberEmails(tx, sess.orgId)
        : await loadExistingAircraftTails(tx, sess.orgId),
    );

    // 5. Normalize every row + compute its staged status. PURE per-row work;
    //    no DB access inside this loop.
    const staged: StagedRow[] = [];
    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i]!;

      if (outOfScope) {
        staged.push({
          rowIndex: i,
          raw,
          status: 'error',
          errorDetail: `${OUT_OF_SCOPE_PREFIX}ledger/financial-history data is not supported by this importer`,
        });
        continue;
      }

      const result =
        input.kind === 'members' ? normalizeMemberRow(raw, mapping) : normalizeAircraftRow(raw, mapping);

      if (!result.ok) {
        staged.push({ rowIndex: i, raw, status: 'error', errorDetail: result.reason });
        continue;
      }
      if (seen.has(result.dedupeKey)) {
        staged.push({ rowIndex: i, raw, status: 'skipped', errorDetail: 'duplicate' });
        continue;
      }
      seen.add(result.dedupeKey);
      staged.push({ rowIndex: i, raw, status: 'pending', errorDetail: null });
    }

    // 6. INSERT import_batch — carries the CONFIRMED mapping so commitImport
    //    never has to re-guess or re-ask.
    const batchErrorDetail = outOfScope
      ? `${OUT_OF_SCOPE_PREFIX}this file looks like a Sales Transactions / ledger export — ledger and ` +
        `financial-history import is not supported in this slice. Only Users/Members and Aircraft exports ` +
        `can be committed.`
      : null;

    const [batchRow] = await tx
      .insert(importBatch)
      .values({
        orgId: sess.orgId,
        source: input.source,
        kind: input.kind,
        status: 'previewed',
        filename: input.filename,
        rowCount: rawRows.length,
        importedCount: 0,
        skippedCount: 0,
        errorDetail: batchErrorDetail,
        mapping,
        createdBy: sess.userId,
      })
      .returning();
    const batch = batchRow!;

    // 7. Bulk INSERT import_row staging rows — ONE statement, no N+1.
    //    .returning() preserves input-row order for a single INSERT (a
    //    single-statement multi-VALUES INSERT's RETURNING rows come back in
    //    the same order the VALUES were supplied), so zipping by array index
    //    below is safe.
    let insertedIds: string[] = [];
    if (staged.length > 0) {
      const inserted = await tx
        .insert(importRow)
        .values(
          staged.map((s) => ({
            orgId: sess.orgId,
            importBatchId: batch.id,
            rowIndex: s.rowIndex,
            rawData: s.raw,
            mappedStatus: s.status,
            errorDetail: s.errorDetail,
          })),
        )
        .returning({ id: importRow.id });
      insertedIds = inserted.map((r) => r.id);
    }

    // 8. Audit row.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'import.previewed',
      entityType: 'import_batch',
      entityId: batch.id,
      metadata: {
        kind: input.kind,
        filename: input.filename,
        rowCount: rawRows.length,
        willImportCount: staged.filter((s) => s.status === 'pending').length,
        willSkipCount: staged.filter((s) => s.status === 'skipped').length,
        errorCount: staged.filter((s) => s.status === 'error').length,
        outOfScope,
      },
    });

    // 9. Build the (capped) preview payload — the FULL set is staged
    //    regardless of the cap.
    const previewRows: ImportRowView[] = staged.slice(0, PREVIEW_ROW_CAP).map((s, idx) => ({
      id: insertedIds[idx] ?? '',
      rowIndex: s.rowIndex,
      raw: s.raw,
      status: s.status,
      errorDetail: s.errorDetail,
      targetId: null,
    }));

    return {
      ok: true,
      batch: toImportBatchView(batch),
      mapping,
      headers,
      rows: previewRows,
      outOfScope,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function previewImport(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<PreviewImportResult> {
  const db = await getDb();
  return _previewImportImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function previewImportWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<PreviewImportResult> {
  return _previewImportImpl(db, session, input);
}
