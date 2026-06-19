/**
 * remove-member-tag.ts — Remove a tag from a member by tagId (Slice 6.2).
 *
 * removeMemberTag — deletes a member_tag row by id. RLS ensures cross-org
 * tagId is invisible. 0 rows deleted → not_found.
 *
 * GUARANTEES:
 *   - requireCapability('people:manage') FIRST (owner/manager only).
 *   - Capture tag string BEFORE delete (for audit metadata).
 *   - DELETE by id (RLS-scoped); 0 rows → not_found.
 *   - ONE audit row 'member.tag_removed'.
 *   - Returns fresh MemberDetail via assembleMemberDetail.
 *
 * TWO CALLING FORMS:
 *   removeMemberTag(session, input)          — app code.
 *   removeMemberTagWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { memberTag, auditLog } from '@aeroops/db';
import { eq } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { RemoveMemberTagResult } from './types.js';
import { assembleMemberDetail } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  userId: z.string().regex(UUID_RE, { message: 'userId must be a UUID' }),
  tagId:  z.string().regex(UUID_RE, { message: 'tagId must be a UUID' }),
});

export interface RemoveMemberTagInput {
  userId: string;
  tagId:  string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _removeMemberTagImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<RemoveMemberTagResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[people] invalid removeMemberTag input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load the tag BEFORE delete (to capture tag string for audit + verify ownership).
    const existing = await tx
      .select({ id: memberTag.id, userId: memberTag.userId, tag: memberTag.tag })
      .from(memberTag)
      .where(eq(memberTag.id, input.tagId))
      .limit(1);

    const tagRow = existing[0];
    if (!tagRow) return { ok: false, reason: 'not_found' };

    // 4. DELETE by id (RLS-scoped).
    const deleted = await tx
      .delete(memberTag)
      .where(eq(memberTag.id, input.tagId))
      .returning({ id: memberTag.id });

    if (deleted.length === 0) return { ok: false, reason: 'not_found' };

    // 5. ONE audit row (tag string captured before delete).
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'member.tag_removed',
      entityType:  'app_user',
      entityId:    input.userId,
      metadata:    { tagId: input.tagId, tag: tagRow.tag },
    });

    // 6. Return fresh detail.
    const member = await assembleMemberDetail(tx, input.userId);
    if (!member) throw new Error('[people] removeMemberTag: re-read returned no row');
    return { ok: true, member };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function removeMemberTag(
  session: AppSession | null | undefined,
  input: RemoveMemberTagInput,
): Promise<RemoveMemberTagResult> {
  const db = await getDb();
  return _removeMemberTagImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function removeMemberTagWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: RemoveMemberTagInput,
): Promise<RemoveMemberTagResult> {
  return _removeMemberTagImpl(db, session, input);
}
