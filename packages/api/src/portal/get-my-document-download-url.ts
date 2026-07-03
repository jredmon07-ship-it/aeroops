/**
 * portal/get-my-document-download-url.ts — Portal self-scoped document
 * download read (Slice P1.6).
 *
 * getMyDocumentDownloadUrl — returns a short-lived pre-signed GET URL for
 * ONE of the caller's OWN documents. AUDITED (who downloaded what).
 *
 * SELF-SCOPING (the load-bearing requirement): the row's ownerType/ownerId
 * are checked against ('member', session.userId) AFTER the org-RLS-scoped
 * read — a mismatch (another member's document, or an aircraft document)
 * returns the SAME 'not_found' shape as a truly-missing id (anti-
 * enumeration — mirrors pay-invoice.ts's self-scope-mismatch posture).
 *
 * GUARANTEES:
 *   - requireCapability('portal:access') FIRST.
 *   - org_id from session only; cross-org id → not_found (RLS + read).
 *   - not_configured typed refusal on a StubStorageProvider — never a crash.
 *   - Audited 'document.downloaded' on every ok:true.
 *
 * TWO CALLING FORMS:
 *   getMyDocumentDownloadUrl(session, input, storageProvider?)          — app code.
 *   getMyDocumentDownloadUrlWithDb(db, session, input, storageProvider?) — tests.
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
import { document, UUID_RE, toDocumentView } from '../documents/internal.js';
import type { GetDownloadUrlResult } from '../documents/types.js';

const inputSchema = z.object({
  documentId: z.string().regex(UUID_RE, { message: 'documentId must be a UUID' }),
});

export type GetMyDocumentDownloadUrlInput = z.infer<typeof inputSchema>;

async function _getMyDocumentDownloadUrlImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  storageProvider: StorageProvider = getStorageProvider(),
): Promise<GetDownloadUrlResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'portal:access');

  // 2. VALIDATE.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[portal] invalid getMyDocumentDownloadUrl input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { documentId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const rows = await tx.select().from(document).where(eq(document.id, documentId)).limit(1);
    const row = rows[0];

    // SELF-SCOPED: must be the caller's OWN member document. A mismatch
    // returns the SAME shape as "not found" (anti-enumeration).
    if (!row || row.ownerType !== 'member' || row.ownerId !== sess.userId) {
      return { ok: false, reason: 'not_found' } as const;
    }

    const signResult = await storageProvider.signDownloadUrl({ key: row.storageKey });
    if (!signResult.ok) {
      return { ok: false, reason: 'not_configured' } as const;
    }

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

export async function getMyDocumentDownloadUrl(
  session: AppSession | null | undefined,
  input: unknown,
  storageProvider?: StorageProvider,
): Promise<GetDownloadUrlResult> {
  const db = await getDb();
  return _getMyDocumentDownloadUrlImpl(db, session, input, storageProvider);
}

export async function getMyDocumentDownloadUrlWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  storageProvider?: StorageProvider,
): Promise<GetDownloadUrlResult> {
  return _getMyDocumentDownloadUrlImpl(db, session, input, storageProvider);
}
