/**
 * import/commit-import.ts — commitImport (Slice P1.7).
 *
 * Turns a PREVIEWED batch's staged 'pending' rows into REAL records, using
 * ONLY the existing write paths — addMember (people) for members, the
 * existing createResource + updateAircraft (fleet) for aircraft. NEVER a
 * bespoke INSERT into app_user or resource.
 *
 * GUARANTEES:
 *   - Loads the batch FIRST (RLS-scoped; cross-org/unknown → not_found),
 *     THEN requireCapability gated on the batch's OWN kind (people:manage /
 *     fleet:manage) — no write is attempted before that check passes.
 *   - Refuses (returned, not thrown) a batch that is not 'previewed'
 *     (already_committed / not_previewed), and refuses an out-of-scope
 *     batch (a detected Sales-Transactions/ledger export) with the staged
 *     error message — NO ledger/financial-history import in this slice.
 *   - Re-checks duplicates against a FRESH read of existing org records at
 *     commit time (state may have changed since preview) — a duplicate
 *     (by email/tail) is SKIPPED, never overwritten.
 *   - ATOMIC PER ROW via a savepoint: a bad row (write-path throw, or a
 *     duplicate surfaced only now) marks that import_row 'error'/'skipped'
 *     and the loop continues — it never aborts the whole batch.
 *   - Members import as ROSTER ENTRIES ONLY via addMember — default role
 *     'renter' (least-privilege; the operator can promote via the existing
 *     People hub afterward). NO auth_credential is created (addMember's own
 *     guarantee).
 *   - Aircraft import: createResource (kind='aircraft', the EXISTING
 *     schedule:manage_resources-gated resource-create path) THEN
 *     updateAircraft (identity fields) — wrapped in ONE savepoint so a
 *     failure in either half rolls back both (no half-created aircraft).
 *     NOTE: this means the acting session ALSO needs schedule:manage_
 *     resources to commit an aircraft batch (owner/manager/dispatcher hold
 *     both fleet:manage + schedule:manage_resources; mechanic holds
 *     fleet:manage but NOT schedule:manage_resources — a mechanic can
 *     preview an aircraft import but every row will surface a Forbidden
 *     error at commit; documented in docs/specs/slice-p1-fc-import.md).
 *   - Committing an already-committed batch is a no-op/refused
 *     ({ok:false, reason:'already_committed'}) — no re-import, no
 *     double-count.
 *   - import_row.mapped_status/target_id/error_detail are UPDATED in place
 *     to reflect the outcome; import_batch.status/imported_count/
 *     skipped_count are updated once at the end. ONE summary audit row
 *     'import.committed'.
 *
 * TWO CALLING FORMS:
 *   commitImport(session, input)          — app code.
 *   commitImportWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { importBatch, importRow, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { normalizeMemberRow, normalizeAircraftRow } from '@aeroops/core';
import type { ImportKind, ColumnMapping } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { addMemberWithDb } from '../people/add-member.js';
import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { updateAircraftWithDb } from '../fleet/update-aircraft.js';
import {
  OUT_OF_SCOPE_PREFIX,
  capabilityForImportKind,
  loadExistingMemberEmails,
  loadExistingAircraftTails,
  toImportBatchView,
} from './internal.js';
import type { CommitImportResult, CommitImportRowResult } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const commitImportInputSchema = z.object({
  batchId: z.string().regex(UUID_RE, { message: 'batchId must be a UUID' }),
});

/** Default role assigned to every imported member — least-privilege roster entry. */
const DEFAULT_IMPORTED_ROLE = 'renter';

/** Truncate a provider/DB error message before it is ever persisted. */
function truncateErrorDetail(message: string): string {
  return message.slice(0, 500);
}

async function _commitImportImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CommitImportResult> {
  const parsed = commitImportInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[import] invalid commitImport input: ${first?.message ?? 'unknown'}`);
  }
  const { batchId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 1. Load the batch FIRST — RLS-scoped; cross-org/unknown → not_found.
    //    Reading a row's mere EXISTENCE within the caller's own RLS scope
    //    leaks nothing; every write below still requires the kind-gated
    //    capability to pass first.
    const batchRows = await tx.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1);
    const batchRow = batchRows[0];
    if (!batchRow) {
      return { ok: false, reason: 'not_found' };
    }

    const kind = batchRow.kind as ImportKind;

    // 2. AUTHZ — gated on the batch's OWN kind.
    requireCapability(session, capabilityForImportKind(kind));

    if (batchRow.status === 'committed') {
      return { ok: false, reason: 'already_committed' };
    }
    if (batchRow.status !== 'previewed') {
      return { ok: false, reason: 'not_previewed' };
    }
    if (batchRow.errorDetail && batchRow.errorDetail.startsWith(OUT_OF_SCOPE_PREFIX)) {
      return { ok: false, reason: 'out_of_scope', message: batchRow.errorDetail };
    }

    const mapping = (batchRow.mapping && typeof batchRow.mapping === 'object'
      ? batchRow.mapping
      : {}) as ColumnMapping;

    // 3. Fresh dedupe-key snapshot — state may have changed since preview.
    const seen = new Set<string>(
      kind === 'members'
        ? await loadExistingMemberEmails(tx, sess.orgId)
        : await loadExistingAircraftTails(tx, sess.orgId),
    );

    // 4. Load every still-'pending' staged row, in row_index order.
    const pendingRows = await tx
      .select()
      .from(importRow)
      .where(and(eq(importRow.importBatchId, batchId), eq(importRow.mappedStatus, 'pending')))
      .orderBy(importRow.rowIndex);

    const results: CommitImportRowResult[] = [];
    let importedCount = 0;
    // Baseline: rows previewImport ALREADY staged as 'skipped'/'error' (a
    // preview-time duplicate or a malformed row) are not re-processed here
    // (they were never 'pending'), but they DO count toward the batch's
    // final skipped_count — the summary reflects the WHOLE file, not just
    // the rows touched in this commit call.
    let skippedCount = batchRow.rowCount - pendingRows.length;

    for (const row of pendingRows) {
      const raw = (row.rawData && typeof row.rawData === 'object' ? row.rawData : {}) as Record<
        string,
        string
      >;

      // Branch fully on `kind` (a batch-level constant) so TypeScript
      // narrows normalized.value to the correct candidate shape per branch —
      // members and aircraft are handled by entirely separate code paths.
      if (kind === 'members') {
        const normalized = normalizeMemberRow(raw, mapping);

        if (!normalized.ok) {
          await tx
            .update(importRow)
            .set({ mappedStatus: 'error', errorDetail: normalized.reason })
            .where(eq(importRow.id, row.id));
          skippedCount++;
          results.push({ rowIndex: row.rowIndex, status: 'error', targetId: null, errorDetail: normalized.reason });
          continue;
        }

        if (seen.has(normalized.dedupeKey)) {
          await tx
            .update(importRow)
            .set({ mappedStatus: 'skipped', errorDetail: 'duplicate' })
            .where(eq(importRow.id, row.id));
          skippedCount++;
          results.push({ rowIndex: row.rowIndex, status: 'skipped', targetId: null, errorDetail: 'duplicate' });
          continue;
        }

        // ATOMIC PER ROW — addMemberWithDb opens its own savepoint (via its
        // internal withOrgContext → tx.transaction()) inside this already-
        // open outer tx; a throw there rolls back ONLY this row's writes;
        // the outer tx (and every prior row's committed savepoint) stays
        // alive.
        try {
          const memberResult = await addMemberWithDb(tx, session, {
            email: normalized.value.email,
            fullName: normalized.value.fullName ?? undefined,
            phone: normalized.value.phone,
            role: DEFAULT_IMPORTED_ROLE,
          });

          if (!memberResult.ok) {
            // email_taken — a race since our fresh snapshot (another row in
            // this same batch, or a concurrent create). Skip, not overwrite.
            await tx
              .update(importRow)
              .set({ mappedStatus: 'skipped', errorDetail: 'duplicate (email already exists)' })
              .where(eq(importRow.id, row.id));
            skippedCount++;
            results.push({
              rowIndex: row.rowIndex,
              status: 'skipped',
              targetId: null,
              errorDetail: 'duplicate (email already exists)',
            });
            continue;
          }

          seen.add(normalized.dedupeKey);
          const targetId = memberResult.member.userId;
          await tx
            .update(importRow)
            .set({ mappedStatus: 'imported', targetId, errorDetail: null })
            .where(eq(importRow.id, row.id));
          importedCount++;
          results.push({ rowIndex: row.rowIndex, status: 'imported', targetId, errorDetail: null });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown import error';
          const detail = truncateErrorDetail(message);
          await tx
            .update(importRow)
            .set({ mappedStatus: 'error', errorDetail: detail })
            .where(eq(importRow.id, row.id));
          skippedCount++;
          results.push({ rowIndex: row.rowIndex, status: 'error', targetId: null, errorDetail: detail });
        }
        continue;
      }

      // ── Aircraft branch ─────────────────────────────────────────────────
      const normalized = normalizeAircraftRow(raw, mapping);

      if (!normalized.ok) {
        await tx
          .update(importRow)
          .set({ mappedStatus: 'error', errorDetail: normalized.reason })
          .where(eq(importRow.id, row.id));
        skippedCount++;
        results.push({ rowIndex: row.rowIndex, status: 'error', targetId: null, errorDetail: normalized.reason });
        continue;
      }

      if (seen.has(normalized.dedupeKey)) {
        await tx
          .update(importRow)
          .set({ mappedStatus: 'skipped', errorDetail: 'duplicate' })
          .where(eq(importRow.id, row.id));
        skippedCount++;
        results.push({ rowIndex: row.rowIndex, status: 'skipped', targetId: null, errorDetail: 'duplicate' });
        continue;
      }

      // ATOMIC PER ROW: createResource THEN updateAircraft, wrapped in ONE
      // savepoint so a failure in either half rolls back both (no
      // half-created aircraft record). A throw rolls back ONLY this row.
      try {
        const targetId = await (tx as AnyDb).transaction(async (sp: AnyDb) => {
          const created = await createResourceWithDb(sp, session, {
            kind: 'aircraft',
            displayName: normalized.value.tailNumber,
            tailNumber: normalized.value.tailNumber,
          });
          await updateAircraftWithDb(sp, session, {
            resourceId: created.id,
            make: normalized.value.make,
            model: normalized.value.model,
            year: normalized.value.year,
            serialNumber: normalized.value.serialNumber,
          });
          return created.id;
        });

        seen.add(normalized.dedupeKey);
        await tx
          .update(importRow)
          .set({ mappedStatus: 'imported', targetId, errorDetail: null })
          .where(eq(importRow.id, row.id));
        importedCount++;
        results.push({ rowIndex: row.rowIndex, status: 'imported', targetId, errorDetail: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown import error';
        const detail = truncateErrorDetail(message);
        await tx
          .update(importRow)
          .set({ mappedStatus: 'error', errorDetail: detail })
          .where(eq(importRow.id, row.id));
        skippedCount++;
        results.push({ rowIndex: row.rowIndex, status: 'error', targetId: null, errorDetail: detail });
      }
    }

    // 5. Update the batch — status='committed', final counts.
    const [updatedBatch] = await tx
      .update(importBatch)
      .set({
        status: 'committed',
        importedCount: batchRow.importedCount + importedCount,
        skippedCount: batchRow.skippedCount + skippedCount,
        updatedAt: new Date(),
      })
      .where(eq(importBatch.id, batchId))
      .returning();

    // 6. ONE summary audit row.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'import.committed',
      entityType: 'import_batch',
      entityId: batchId,
      metadata: {
        kind,
        importedCount,
        skippedCount,
        processedCount: pendingRows.length,
      },
    });

    return { ok: true, batch: toImportBatchView(updatedBatch!), results };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function commitImport(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CommitImportResult> {
  const db = await getDb();
  return _commitImportImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function commitImportWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CommitImportResult> {
  return _commitImportImpl(db, session, input);
}
