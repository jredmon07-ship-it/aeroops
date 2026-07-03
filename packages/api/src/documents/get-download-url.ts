/**
 * documents/get-download-url.ts — getDownloadUrl read path (Slice P1.6).
 *
 * Returns a short-lived pre-signed GET URL for one document. AUDITED — every
 * successful call records WHO downloaded WHAT (records-integrity posture,
 * same as any other read that discloses a document's contents).
 *
 * GUARANTEES:
 *   - authz: a FRONT-DOOR 'app:access' gate, THEN the SPECIFIC owner-type
 *     read capability (people:access | fleet:access) once the row's
 *     ownerType is known from an org-RLS-scoped read (mirrors
 *     confirm-upload.ts's front-door + per-branch pattern — documentId
 *     alone cannot reveal ownerType upfront).
 *   - org_id from session only; cross-org id → not_found (RLS + read).
 *   - not_configured typed refusal on a StubStorageProvider — never a crash.
 *   - Audited 'document.downloaded' on every ok:true.
 *
 * TWO CALLING FORMS:
 *   getDownloadUrl(session, input, storageProvider?)          — app code.
 *   getDownloadUrlWithDb(db, session, input, storageProvider?) — tests.
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
import { document, UUID_RE, toDocumentView, ownerReadCapability } from './internal.js';
import type { DocumentOwnerType } from './types.js';
import type { GetDownloadUrlResult } from './types.js';

const getDownloadUrlInputSchema = z.object({
  documentId: z.string().regex(UUID_RE, { message: 'documentId must be a UUID' }),
});

export type GetDownloadUrlInput = z.infer<typeof getDownloadUrlInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getDownloadUrlImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  storageProvider: StorageProvider = getStorageProvider(),
): Promise<GetDownloadUrlResult> {
  // 1. FRONT-DOOR AUTHZ — see file header.
  requireCapability(session, 'app:access');

  // 2. VALIDATE.
  const parsed = getDownloadUrlInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[documents] invalid getDownloadUrl input: ${first?.message ?? 'unknown'}`);
  }
  const { documentId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const rows = await tx.select().from(document).where(eq(document.id, documentId)).limit(1);
    const row = rows[0];
    if (!row) return { ok: false, reason: 'not_found' } as const;

    // 3. FINE-GRAINED gate, now that ownerType is known.
    requireCapability(session, ownerReadCapability(row.ownerType as DocumentOwnerType));

    // 4. Sign.
    const signResult = await storageProvider.signDownloadUrl({ key: row.storageKey });
    if (!signResult.ok) {
      return { ok: false, reason: 'not_configured' } as const;
    }

    // 5. Audit — who downloaded what.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'document.downloaded',
      entityType: 'document',
      entityId: row.id,
      metadata: { ownerType: row.ownerType, ownerId: row.ownerId, filename: row.filename },
    });

    return {
      ok: true,
      url: signResult.url,
      expiresAt: signResult.expiresAt,
      document: toDocumentView(row),
    } as const;
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getDownloadUrl(
  session: AppSession | null | undefined,
  input: unknown,
  storageProvider?: StorageProvider,
): Promise<GetDownloadUrlResult> {
  const db = await getDb();
  return _getDownloadUrlImpl(db, session, input, storageProvider);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getDownloadUrlWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  storageProvider?: StorageProvider,
): Promise<GetDownloadUrlResult> {
  return _getDownloadUrlImpl(db, session, input, storageProvider);
}
