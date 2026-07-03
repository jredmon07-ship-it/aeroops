/**
 * documents/delete-document.ts — deleteDocument write path (Slice P1.6).
 *
 * Deletes one document: BEST-EFFORT provider delete of the underlying
 * object, then ALWAYS removes the metadata row (a lingering orphaned object
 * in storage is a lesser harm than a metadata row an operator can never
 * remove because the storage provider had a transient blip). Audited
 * regardless of the provider outcome.
 *
 * GUARANTEES:
 *   - authz: a FRONT-DOOR 'app:access' gate, THEN the SPECIFIC owner-type
 *     write capability (people:manage | fleet:manage) once the row's
 *     ownerType is known from an org-RLS-scoped read (mirrors
 *     confirm-upload.ts's front-door + per-branch pattern).
 *   - org_id from session only; cross-org id → not_found (RLS + read).
 *   - Audited 'document.deleted'.
 *
 * TWO CALLING FORMS:
 *   deleteDocument(session, input, storageProvider?)          — app code.
 *   deleteDocumentWithDb(db, session, input, storageProvider?) — tests.
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
import { getStorageProvider } from '../storage/provider.js';
import type { StorageProvider } from '../storage/provider.js';
import { document, UUID_RE, ownerWriteCapability } from './internal.js';
import type { DocumentOwnerType } from './types.js';
import type { DeleteDocumentResult } from './types.js';

const deleteDocumentInputSchema = z.object({
  documentId: z.string().regex(UUID_RE, { message: 'documentId must be a UUID' }),
});

export type DeleteDocumentInput = z.infer<typeof deleteDocumentInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _deleteDocumentImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  storageProvider: StorageProvider = getStorageProvider(),
): Promise<DeleteDocumentResult> {
  // 1. FRONT-DOOR AUTHZ — see file header.
  requireCapability(session, 'app:access');

  // 2. VALIDATE.
  const parsed = deleteDocumentInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[documents] invalid deleteDocument input: ${first?.message ?? 'unknown'}`);
  }
  const { documentId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const rows = await tx.select().from(document).where(eq(document.id, documentId)).limit(1);
    const row = rows[0];
    if (!row) return { ok: false, reason: 'not_found' } as const;

    // 3. FINE-GRAINED gate, now that ownerType is known.
    requireCapability(session, ownerWriteCapability(row.ownerType as DocumentOwnerType));

    // 4. BEST-EFFORT provider delete — never blocks row removal on failure.
    await storageProvider.deleteObject({ key: row.storageKey });

    // 5. Remove the metadata row.
    await tx.delete(document).where(eq(document.id, documentId));

    // 6. Audit row.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'document.deleted',
      entityType: 'document',
      entityId: row.id,
      metadata: { ownerType: row.ownerType, ownerId: row.ownerId, filename: row.filename },
    });

    return { ok: true } as const;
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function deleteDocument(
  session: AppSession | null | undefined,
  input: unknown,
  storageProvider?: StorageProvider,
): Promise<DeleteDocumentResult> {
  const db = await getDb();
  return _deleteDocumentImpl(db, session, input, storageProvider);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function deleteDocumentWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  storageProvider?: StorageProvider,
): Promise<DeleteDocumentResult> {
  return _deleteDocumentImpl(db, session, input, storageProvider);
}
