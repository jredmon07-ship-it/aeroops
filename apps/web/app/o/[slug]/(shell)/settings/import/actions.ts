/**
 * settings/import/actions.ts — Server actions for the Flight Circle data
 * importer (Slice P1.7).
 *
 * Pattern mirrors settings/actions.ts (QBO integration): auth() → call
 * @aeroops/api fn (requireCapability inside, gated per kind: people:manage/
 * people:access for members, fleet:manage/fleet:access for aircraft) → map
 * ForbiddenError/UnauthenticatedError/ValidationError → tagged error result.
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 *
 * NO ledger/financial-history import — previewImport/commitImport enforce
 * that server-side; this file only serializes their results for the client.
 */
'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import {
  previewImport,
  commitImport,
  listImportBatches,
  getImportBatch,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';
import type {
  ImportKind,
  ColumnMapping,
  ImportBatchView,
  ImportRowView,
} from '@aeroops/api';

// ─── Error shapes ──────────────────────────────────────────────────────────────

export type AuthErrorResult = { error: 'forbidden' } | { error: 'unauthenticated' };
export type ValidationErrorResult = { error: 'validation'; message: string };
export type ServerErrorResult = { error: 'server'; message?: string };

function mapAuthError(err: unknown): AuthErrorResult | null {
  if (err instanceof ForbiddenError) return { error: 'forbidden' };
  if (err instanceof UnauthenticatedError) return { error: 'unauthenticated' };
  return null;
}

function isValidationError(err: unknown): err is { message: string; code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'VALIDATION'
  );
}

// ─── Serialized types (Dates → string) ────────────────────────────────────────

export interface SerializedImportBatch {
  id: string;
  kind: ImportKind;
  source: string;
  status: ImportBatchView['status'];
  filename: string;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  errorDetail: string | null;
  outOfScope: boolean;
  mapping: ColumnMapping;
  createdAt: string;
  updatedAt: string;
}

export type SerializedImportRow = ImportRowView;

function serializeBatch(batch: ImportBatchView): SerializedImportBatch {
  return {
    id: batch.id,
    kind: batch.kind,
    source: batch.source,
    status: batch.status,
    filename: batch.filename,
    rowCount: batch.rowCount,
    importedCount: batch.importedCount,
    skippedCount: batch.skippedCount,
    errorDetail: batch.errorDetail,
    outOfScope: batch.outOfScope,
    mapping: batch.mapping,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
  };
}

// ─── previewImportAction ────────────────────────────────────────────────────

export type PreviewImportActionResult =
  | {
      ok: true;
      batch: SerializedImportBatch;
      mapping: ColumnMapping;
      headers: string[];
      rows: SerializedImportRow[];
      outOfScope: boolean;
    }
  | { ok: false; reason: 'empty_csv' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function previewImportAction(input: {
  kind: ImportKind;
  filename: string;
  csvText: string;
  mapping?: ColumnMapping;
}): Promise<PreviewImportActionResult> {
  const session = await auth();
  try {
    const result = await previewImport(session, input);
    if (!result.ok) return result;
    return {
      ok: true,
      batch: serializeBatch(result.batch),
      mapping: result.mapping,
      headers: result.headers,
      rows: result.rows,
      outOfScope: result.outOfScope,
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── commitImportAction ─────────────────────────────────────────────────────

export type CommitImportActionResult =
  | { ok: true; batch: SerializedImportBatch; results: import('@aeroops/api').CommitImportRowResult[] }
  | { ok: false; reason: 'not_found' | 'already_committed' | 'not_previewed' }
  | { ok: false; reason: 'out_of_scope'; message: string }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function commitImportAction(
  input: { batchId: string },
  slug: string,
): Promise<CommitImportActionResult> {
  const session = await auth();
  try {
    const result = await commitImport(session, input);
    if (!result.ok) return result;
    revalidatePath(`/o/${slug}/settings/import`);
    return { ok: true, batch: serializeBatch(result.batch), results: result.results };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── listImportBatchesAction ────────────────────────────────────────────────

export type ListImportBatchesActionResult =
  | { ok: true; batches: SerializedImportBatch[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listImportBatchesAction(kind: ImportKind): Promise<ListImportBatchesActionResult> {
  const session = await auth();
  try {
    const batches = await listImportBatches(session, { kind });
    return { ok: true, batches: batches.map(serializeBatch) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── getImportBatchAction ───────────────────────────────────────────────────

export type GetImportBatchActionResult =
  | { ok: true; batch: SerializedImportBatch; rows: SerializedImportRow[] }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getImportBatchAction(batchId: string): Promise<GetImportBatchActionResult> {
  const session = await auth();
  try {
    const result = await getImportBatch(session, { batchId });
    if (!result.ok) return result;
    return { ok: true, batch: serializeBatch(result.batch), rows: result.rows };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}
