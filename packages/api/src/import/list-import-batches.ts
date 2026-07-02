/**
 * import/list-import-batches.ts — listImportBatches (Slice P1.7).
 *
 * History read: every import batch for the org + kind, most-recent-first.
 * Mirrors previewImport/commitImport's "pick per kind" capability gate
 * (people:access for members, fleet:access for aircraft) — `kind` is a
 * REQUIRED input so the gate is always unambiguous.
 *
 * GUARANTEES:
 *   - requireCapability FIRST (gated on the requested kind's :access cap).
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Read-only; no I/O beyond the SELECT.
 *
 * TWO CALLING FORMS:
 *   listImportBatches(session, input)          — app code.
 *   listImportBatchesWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { importBatch } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toImportBatchView } from './internal.js';
import type { ImportBatchView } from './types.js';

/** Capability gate for LISTING/READING batches of a given kind. */
function readCapabilityForKind(kind: 'members' | 'aircraft'): 'people:access' | 'fleet:access' {
  return kind === 'members' ? 'people:access' : 'fleet:access';
}

const listImportBatchesInputSchema = z.object({
  kind: z.enum(['members', 'aircraft']),
});

export interface ListImportBatchesInput {
  kind: 'members' | 'aircraft';
}

const BATCH_LIST_CAP = 100;

async function _listImportBatchesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<ImportBatchView[]> {
  const parsed = listImportBatchesInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[import] invalid listImportBatches input: ${first?.message ?? 'unknown'}`);
  }
  const { kind } = parsed.data;

  // 1. AUTHZ FIRST.
  requireCapability(session, readCapabilityForKind(kind));

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const rows = await tx
      .select()
      .from(importBatch)
      .where(and(eq(importBatch.orgId, sess.orgId), eq(importBatch.kind, kind)))
      .orderBy(desc(importBatch.createdAt))
      .limit(BATCH_LIST_CAP);

    return rows.map(toImportBatchView);
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function listImportBatches(
  session: AppSession | null | undefined,
  input: ListImportBatchesInput,
): Promise<ImportBatchView[]> {
  const db = await getDb();
  return _listImportBatchesImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function listImportBatchesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ListImportBatchesInput,
): Promise<ImportBatchView[]> {
  return _listImportBatchesImpl(db, session, input);
}
