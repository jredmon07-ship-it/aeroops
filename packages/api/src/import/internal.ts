/**
 * import/internal.ts — shared tx-level helpers for the Flight Circle data
 * importer (Slice P1.7).
 *
 * NOT exported from @aeroops/api. Holds:
 *   OUT_OF_SCOPE_PREFIX     — the error_detail sentinel marking a batch as
 *     out-of-scope-for-commit (a detected Sales-Transactions/ledger export).
 *   capabilityForImportKind — which capability gates a given import kind.
 *   loadExistingMemberEmails / loadExistingAircraftTails — fresh dedupe-key
 *     snapshots (RLS-scoped) used by BOTH previewImport (preview-time flag)
 *     and commitImport (re-checked fresh — state may have changed since
 *     preview). Aircraft tail numbers carry NO DB uniqueness constraint
 *     (resource.tail_number is unconstrained), so this in-app Set is the
 *     ONLY duplicate guard for aircraft; members are additionally backstopped
 *     by app_user's (org_id, email) UNIQUE index via addMember's own
 *     email_taken handling.
 *   toImportBatchView / toImportRowView — DB row -> public view mappers.
 *
 * INVARIANT: All helpers accept an AnyDb tx with org GUC already set by the
 * caller's withSessionOrgContextWithDb. They NEVER set GUC themselves.
 */
import { eq, and } from 'drizzle-orm';
import { appUser, resource } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { Capability, ImportKind, ColumnMapping } from '@aeroops/core';
import type {
  ImportBatchView,
  ImportBatchStatus,
  ImportRowView,
  ImportRowStatus,
} from './types.js';

/** Sentinel prefix on import_batch.error_detail marking out-of-scope-for-commit. */
export const OUT_OF_SCOPE_PREFIX = 'out_of_scope: ';

/** capabilityForImportKind — which capability gates a given import kind's write paths. */
export function capabilityForImportKind(kind: ImportKind): Capability {
  return kind === 'members' ? 'people:manage' : 'fleet:manage';
}

/**
 * loadExistingMemberEmails — the set of lowercased emails already on the
 * org's roster (RLS-scoped). Mirrors addMember's own (org_id, email)
 * dedupe key.
 */
export async function loadExistingMemberEmails(tx: AnyDb, orgId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ email: appUser.email })
    .from(appUser)
    .where(eq(appUser.orgId, orgId));
  return new Set(rows.map((r) => r.email.toLowerCase()));
}

/**
 * loadExistingAircraftTails — the set of uppercased, whitespace-stripped
 * tail numbers already in the org's fleet (RLS-scoped). resource.tail_number
 * carries NO DB uniqueness constraint, so this in-app check is the ONLY
 * duplicate guard for aircraft import.
 */
export async function loadExistingAircraftTails(tx: AnyDb, orgId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ tailNumber: resource.tailNumber })
    .from(resource)
    .where(and(eq(resource.orgId, orgId), eq(resource.kind, 'aircraft')));
  const out = new Set<string>();
  for (const r of rows) {
    if (r.tailNumber) out.add(r.tailNumber.toUpperCase().replace(/\s+/g, ''));
  }
  return out;
}

// ─── View mappers ─────────────────────────────────────────────────────────

interface ImportBatchRow {
  id: string;
  kind: string;
  source: string;
  status: string;
  filename: string;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  errorDetail: string | null;
  mapping: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export function toImportBatchView(row: ImportBatchRow): ImportBatchView {
  const errorDetail = row.errorDetail ?? null;
  return {
    id: row.id,
    kind: row.kind as ImportKind,
    source: row.source,
    status: row.status as ImportBatchStatus,
    filename: row.filename,
    rowCount: row.rowCount,
    importedCount: row.importedCount,
    skippedCount: row.skippedCount,
    errorDetail,
    outOfScope: errorDetail !== null && errorDetail.startsWith(OUT_OF_SCOPE_PREFIX),
    mapping: (row.mapping && typeof row.mapping === 'object' ? row.mapping : {}) as ColumnMapping,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface ImportRowRow {
  id: string;
  rowIndex: number;
  rawData: unknown;
  mappedStatus: string;
  targetId: string | null;
  errorDetail: string | null;
}

export function toImportRowView(row: ImportRowRow): ImportRowView {
  return {
    id: row.id,
    rowIndex: row.rowIndex,
    raw: (row.rawData && typeof row.rawData === 'object' ? row.rawData : {}) as Record<string, string>,
    status: row.mappedStatus as ImportRowStatus,
    errorDetail: row.errorDetail ?? null,
    targetId: row.targetId ?? null,
  };
}
