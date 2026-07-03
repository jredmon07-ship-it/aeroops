/**
 * portal/get-my-documents.ts — Portal self-scoped documents read (Slice P1.6).
 *
 * getMyDocuments — returns the CALLER'S OWN uploaded documents (owner_type=
 * 'member', owner_id=session.userId), newest first. Read-only in the portal
 * for this slice (upload/delete stay staff-only — see slice-p1-documents.md
 * "deferred" list).
 *
 * SELF-SCOPING (the load-bearing requirement): the owner is ALWAYS
 * session.userId from the verified session. There is NO row-identifying
 * input — a portal user can NEVER list another member's documents.
 *
 * GUARANTEES:
 *   - requireCapability('portal:access') FIRST.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Reads NOT audited (read-only, mirrors getMyReservations). NO money.
 *
 * TWO CALLING FORMS:
 *   getMyDocuments(session)          — app code; uses getDb() internally.
 *   getMyDocumentsWithDb(db, session) — tests; inject pglite client.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { document, toDocumentView } from '../documents/internal.js';
import type { DocumentView } from '../documents/types.js';

async function _getMyDocumentsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<DocumentView[]> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'portal:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-SCOPED: sess.userId only — never a caller-supplied id.
    const rows = await tx
      .select()
      .from(document)
      .where(
        and(
          eq(document.orgId, sess.orgId),
          eq(document.ownerType, 'member'),
          eq(document.ownerId, sess.userId),
        ),
      )
      .orderBy(desc(document.createdAt));

    return rows.map(toDocumentView);
  });
}

export async function getMyDocuments(
  session: AppSession | null | undefined,
): Promise<DocumentView[]> {
  const db = await getDb();
  return _getMyDocumentsImpl(db, session);
}

export async function getMyDocumentsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<DocumentView[]> {
  return _getMyDocumentsImpl(db, session);
}
