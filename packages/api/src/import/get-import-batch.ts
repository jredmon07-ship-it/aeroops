/**
 * import/get-import-batch.ts — getImportBatch (Slice P1.7).
 *
 * Full detail read for one import batch: the batch header + every staged
 * row (raw data + final status + resolved target label). Loads the batch
 * FIRST (RLS-scoped) to discover its kind, THEN gates on that kind's
 * :access capability (people:access / fleet:access) — mirrors commitImport's
 * "load-then-gate" ordering; the existence read leaks nothing beyond the
 * caller's own RLS scope.
 *
 * GUARANTEES:
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - No N+1: target labels (member email / aircraft tail number) are
 *     resolved via ONE extra batched query, not per-row.
 *   - Read-only.
 *
 * TWO CALLING FORMS:
 *   getImportBatch(session, input)          — app code.
 *   getImportBatchWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { importBatch, importRow, appUser, resource } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { ImportKind } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toImportBatchView, toImportRowView } from './internal.js';
import type { GetImportBatchResult } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getImportBatchInputSchema = z.object({
  batchId: z.string().regex(UUID_RE, { message: 'batchId must be a UUID' }),
});

export interface GetImportBatchInput {
  batchId: string;
}

function readCapabilityForKind(kind: ImportKind): 'people:access' | 'fleet:access' {
  return kind === 'members' ? 'people:access' : 'fleet:access';
}

/** Rows beyond this cap are still staged/committed correctly — just not returned in one read. */
const ROW_READ_CAP = 5000;

async function _getImportBatchImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetImportBatchResult> {
  const parsed = getImportBatchInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[import] invalid getImportBatch input: ${first?.message ?? 'unknown'}`);
  }
  const { batchId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 1. Load the batch FIRST (RLS-scoped; cross-org/unknown → not_found).
    const batchRows = await tx.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1);
    const batchRow = batchRows[0];
    if (!batchRow) {
      return { ok: false, reason: 'not_found' };
    }

    const kind = batchRow.kind as ImportKind;

    // 2. AUTHZ — gated on the batch's OWN kind, before returning any content.
    requireCapability(session, readCapabilityForKind(kind));

    // 3. Load staged rows, in row_index order.
    const rowRows = await tx
      .select()
      .from(importRow)
      .where(and(eq(importRow.importBatchId, batchId), eq(importRow.orgId, sess.orgId)))
      .orderBy(asc(importRow.rowIndex))
      .limit(ROW_READ_CAP);

    // 4. Resolve target labels — ONE batched query (no N+1).
    const targetIds = rowRows.map((r) => r.targetId).filter((id): id is string => id !== null);
    const labelById = new Map<string, string>();
    if (targetIds.length > 0) {
      if (kind === 'members') {
        const users = await tx
          .select({ id: appUser.id, email: appUser.email })
          .from(appUser)
          .where(inArray(appUser.id, targetIds));
        for (const u of users) labelById.set(u.id, u.email);
      } else {
        const resources = await tx
          .select({ id: resource.id, tailNumber: resource.tailNumber })
          .from(resource)
          .where(inArray(resource.id, targetIds));
        for (const r of resources) labelById.set(r.id, r.tailNumber ?? '');
      }
    }

    const rows = rowRows.map((r) => {
      const view = toImportRowView(r);
      return { ...view, targetLabel: view.targetId ? (labelById.get(view.targetId) ?? null) : null };
    });

    return { ok: true, batch: toImportBatchView(batchRow), rows };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getImportBatch(
  session: AppSession | null | undefined,
  input: GetImportBatchInput,
): Promise<GetImportBatchResult> {
  const db = await getDb();
  return _getImportBatchImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getImportBatchWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetImportBatchInput,
): Promise<GetImportBatchResult> {
  return _getImportBatchImpl(db, session, input);
}
