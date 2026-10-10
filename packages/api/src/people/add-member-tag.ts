/**
 * add-member-tag.ts — Add a free-text tag to a member (Slice 6.2).
 *
 * addMemberTag — inserts a member_tag row. Trims tag; empty → ValidationError.
 * Duplicate (same user + tag) → returns {ok:false, reason:'duplicate'}.
 * Cross-org userId → not_found (RLS pre-check). Deactivated member allowed.
 *
 * [VERIFY-6-A]: tag is a FREE-TEXT operator label ONLY. No FAA/currency/
 * medical/eligibility meaning computed.
 *
 * GUARANTEES:
 *   - requireCapability('people:manage') FIRST (owner/manager only).
 *   - Trim tag before insert; empty after trim → ValidationError (thrown).
 *   - Pre-check member visible in org (else not_found).
 *   - 23505 unique violation → returned {ok:false, reason:'duplicate'}.
 *   - ONE audit row 'member.tag_added'.
 *   - Returns fresh MemberDetail via assembleMemberDetail.
 *
 * TWO CALLING FORMS:
 *   addMemberTag(session, input)          — app code.
 *   addMemberTagWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { membership, memberTag, auditLog } from '@aeroops/db';
import { eq } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { isUniqueViolation } from '../dispatch/internal.js';
import type { AddMemberTagResult, MemberTagColor } from './types.js';
import { MEMBER_TAG_COLORS } from './types.js';
import { assembleMemberDetail } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  userId: z.string().regex(UUID_RE, { message: 'userId must be a UUID' }),
  tag:    z.string(),
  // OPTIONAL palette-key color (migration 0041). Absent → null → renders slate.
  // Constrained to the fixed palette KEY set; the DB CHECK is the backstop.
  color:  z.enum(MEMBER_TAG_COLORS).optional(),
});

export interface AddMemberTagInput {
  userId: string;
  tag: string;
  /** Optional palette-key color. Omit for no color (renders slate). */
  color?: MemberTagColor;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _addMemberTagImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<AddMemberTagResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[people] invalid addMemberTag input: ${first?.message ?? 'unknown'}`);
  }
  const rawTag = parsed.data.tag.trim();
  if (rawTag.length === 0) {
    throw new ValidationError('[people] addMemberTag: tag must not be empty after trimming');
  }
  const input = {
    userId: parsed.data.userId,
    tag: rawTag,
    color: parsed.data.color ?? null,
  };

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Pre-check member is visible in org (RLS + membership check).
    const memberRows = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(eq(membership.userId, input.userId))
      .limit(1);

    if (memberRows.length === 0) return { ok: false, reason: 'not_found' };

    // 4. Insert tag. Unique violation → duplicate.
    try {
      await tx.insert(memberTag).values({
        orgId:     sess.orgId,
        userId:    input.userId,
        tag:       input.tag,
        color:     input.color,
        createdBy: sess.userId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { ok: false, reason: 'duplicate' };
      }
      throw err;
    }

    // 5. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'member.tag_added',
      entityType:  'app_user',
      entityId:    input.userId,
      metadata:    { tag: input.tag, color: input.color },
    });

    // 6. Return fresh detail.
    const member = await assembleMemberDetail(tx, input.userId);
    if (!member) throw new Error('[people] addMemberTag: re-read returned no row');
    return { ok: true, member };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function addMemberTag(
  session: AppSession | null | undefined,
  input: AddMemberTagInput,
): Promise<AddMemberTagResult> {
  const db = await getDb();
  return _addMemberTagImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function addMemberTagWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: AddMemberTagInput,
): Promise<AddMemberTagResult> {
  return _addMemberTagImpl(db, session, input);
}
