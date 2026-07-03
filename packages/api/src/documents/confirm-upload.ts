/**
 * documents/confirm-upload.ts — confirmUpload write path (Slice P1.6).
 *
 * Called by the browser AFTER its direct-to-storage PUT (against the URL
 * requestUpload returned) completes successfully. Flips the document's
 * status from 'pending' to 'stored'. Idempotent: confirming an
 * already-'stored' document is a no-op success (no duplicate audit row) —
 * safe against a retried confirm call.
 *
 * GUARANTEES:
 *   - authz: a FRONT-DOOR 'app:access' gate (every authenticated role has
 *     it — mirrors search-org.ts's pattern), THEN the SPECIFIC owner-type
 *     capability (people:manage | fleet:manage) once the row's ownerType is
 *     known from an org-RLS-scoped read. documentId alone cannot reveal
 *     ownerType before that read, so a single knowable-upfront capability
 *     does not exist for this command (unlike requestUpload, where
 *     ownerType is direct input).
 *   - org_id from session only; cross-org id → not_found (RLS + read).
 *   - Audited 'document.upload_confirmed' (skipped on the idempotent no-op
 *     branch — only the FIRST confirm writes an audit row).
 *
 * TWO CALLING FORMS:
 *   confirmUpload(session, input)          — app code.
 *   confirmUploadWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { document, UUID_RE, toDocumentView, ownerWriteCapability } from './internal.js';
import type { DocumentOwnerType } from './types.js';
import type { ConfirmUploadResult } from './types.js';

const confirmUploadInputSchema = z.object({
  documentId: z.string().regex(UUID_RE, { message: 'documentId must be a UUID' }),
});

export type ConfirmUploadInput = z.infer<typeof confirmUploadInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _confirmUploadImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<ConfirmUploadResult> {
  // 1. FRONT-DOOR AUTHZ — see file header for why the fine-grained check
  //    must wait until the row's ownerType is known.
  requireCapability(session, 'app:access');

  // 2. VALIDATE.
  const parsed = confirmUploadInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[documents] invalid confirmUpload input: ${first?.message ?? 'unknown'}`);
  }
  const { documentId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const rows = await tx.select().from(document).where(eq(document.id, documentId)).limit(1);
    const row = rows[0];
    if (!row) return { ok: false, reason: 'not_found' } as const;

    // 3. FINE-GRAINED gate, now that ownerType is known from an
    //    org-RLS-scoped read (cross-org rows are already invisible here).
    requireCapability(session, ownerWriteCapability(row.ownerType as DocumentOwnerType));

    // 4. Idempotent no-op: already 'stored' → return as-is, NO duplicate audit.
    if (row.status === 'stored') {
      return { ok: true, document: toDocumentView(row) } as const;
    }

    const [updated] = await tx
      .update(document)
      .set({ status: 'stored' })
      .where(eq(document.id, documentId))
      .returning();

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'document.upload_confirmed',
      entityType: 'document',
      entityId: documentId,
      metadata: { ownerType: row.ownerType, ownerId: row.ownerId, filename: row.filename },
    });

    return { ok: true, document: toDocumentView(updated!) } as const;
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function confirmUpload(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<ConfirmUploadResult> {
  const db = await getDb();
  return _confirmUploadImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function confirmUploadWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<ConfirmUploadResult> {
  return _confirmUploadImpl(db, session, input);
}
