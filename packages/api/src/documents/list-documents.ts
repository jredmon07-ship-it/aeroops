/**
 * documents/list-documents.ts — listDocuments read path (Slice P1.6).
 *
 * Returns metadata rows for ONE owner (a member or an aircraft), newest
 * first. NOT audited (read-only, mirrors search-org.ts / listMaintenanceDue).
 *
 * GUARANTEES:
 *   - authz FIRST: ownerType is direct input, so the SPECIFIC read
 *     capability (people:access | fleet:access) is enforced before any data
 *     access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop);
 *     the owner_id + owner_type + org_id predicate is belt-and-suspenders on
 *     top of RLS (mirrors create-calendar-feed.ts's resource-org check).
 *   - owner must exist, in-org, as the right kind → not_found.
 *
 * TWO CALLING FORMS:
 *   listDocuments(session, input)          — app code.
 *   listDocumentsWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { document, UUID_RE, resolveDocumentOwner, toDocumentView, ownerReadCapability } from './internal.js';
import type { ListDocumentsResult } from './types.js';

const listDocumentsInputSchema = z.object({
  ownerType: z.enum(['member', 'aircraft']),
  ownerId: z.string().regex(UUID_RE, { message: 'ownerId must be a UUID' }),
});

export type ListDocumentsInput = z.infer<typeof listDocumentsInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listDocumentsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<ListDocumentsResult> {
  const parsed = listDocumentsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[documents] invalid listDocuments input: ${first?.message ?? 'unknown'}`);
  }
  const { ownerType, ownerId } = parsed.data;

  // 1. AUTHZ FIRST — ownerType is known from input directly.
  requireCapability(session, ownerReadCapability(ownerType));

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const ownerResult = await resolveDocumentOwner(tx, ownerType, ownerId);
    if (!ownerResult.ok) {
      return { ok: false, reason: 'not_found' } as const;
    }

    const rows = await tx
      .select()
      .from(document)
      .where(
        and(
          eq(document.orgId, sess.orgId),
          eq(document.ownerType, ownerType),
          eq(document.ownerId, ownerId),
        ),
      )
      .orderBy(desc(document.createdAt));

    return { ok: true, documents: rows.map(toDocumentView) } as const;
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function listDocuments(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<ListDocumentsResult> {
  const db = await getDb();
  return _listDocumentsImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function listDocumentsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<ListDocumentsResult> {
  return _listDocumentsImpl(db, session, input);
}
