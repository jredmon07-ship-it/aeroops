/**
 * set-member-status.ts — Member roster status change (Slice 6.2).
 *
 * setMemberStatus — sets a member's roster status to 'active' or 'inactive'.
 * Status is a ROSTER FLAG only — NOT a login gate in this slice. [VERIFY-6-D]
 *
 * GUARANTEES:
 *   - requireCapability('people:manage') FIRST (owner/manager only).
 *   - Self-deactivation guard: setting own userId to 'inactive' → refused.
 *   - Last-owner guard: deactivating the sole active owner → refused.
 *   - ONE audit row 'member.status_changed' per call.
 *   - Returns fresh MemberDetail via assembleMemberDetail.
 *
 * TWO CALLING FORMS:
 *   setMemberStatus(session, input)          — app code.
 *   setMemberStatusWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { appUser, membership, auditLog } from '@aeroops/db';
import { eq } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { SetMemberStatusResult } from './types.js';
import { assembleMemberDetail } from './internal.js';
import { extractRows } from '../db-rows.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  userId: z.string().regex(UUID_RE, { message: 'userId must be a UUID' }),
  status: z.enum(['active', 'inactive']),
});

export interface SetMemberStatusInput {
  userId: string;
  status: 'active' | 'inactive';
}

// ─── Count active owners ──────────────────────────────────────────────────────

async function countActiveOwners(tx: AnyDb): Promise<number> {
  const result = await tx.execute(sql`
    SELECT COUNT(*)::int AS "count"
    FROM membership m
    JOIN app_user u ON u.id = m.user_id
    WHERE m.role = 'owner'
      AND u.status = 'active'
  `);
  const rows = extractRows<{ count: number | string }>(result);
  const raw = rows[0]?.count ?? 0;
  return typeof raw === 'string' ? parseInt(raw, 10) : raw;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _setMemberStatusImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetMemberStatusResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[people] invalid setMemberStatus input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  // 3. Self-deactivation guard (pre-tx — session.userId is authoritative).
  if (input.status === 'inactive' && input.userId === session?.userId) {
    return { ok: false, reason: 'cannot_deactivate_self' };
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 4. Load current state (RLS-scoped; cross-org → 0 rows → not_found).
    const existing = await tx
      .select({
        userId: appUser.id,
        status: appUser.status,
        role:   membership.role,
      })
      .from(appUser)
      .innerJoin(membership, eq(membership.userId, appUser.id))
      .where(eq(appUser.id, input.userId))
      .limit(1);

    const current = existing[0];
    if (!current) return { ok: false, reason: 'not_found' };

    // 5. Last-owner guard: deactivating the sole active owner → refused.
    if (input.status === 'inactive' && current.role === 'owner') {
      const activeOwners = await countActiveOwners(tx);
      if (activeOwners <= 1) {
        return { ok: false, reason: 'last_owner' };
      }
    }

    // 6. Apply status update.
    await tx
      .update(appUser)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(appUser.id, input.userId));

    // 7. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'member.status_changed',
      entityType:  'app_user',
      entityId:    input.userId,
      metadata: {
        before: { status: current.status },
        after:  { status: input.status },
      },
    });

    // 8. Return fresh detail.
    const member = await assembleMemberDetail(tx, input.userId);
    if (!member) throw new Error('[people] setMemberStatus: re-read returned no row');
    return { ok: true, member };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function setMemberStatus(
  session: AppSession | null | undefined,
  input: SetMemberStatusInput,
): Promise<SetMemberStatusResult> {
  const db = await getDb();
  return _setMemberStatusImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function setMemberStatusWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: SetMemberStatusInput,
): Promise<SetMemberStatusResult> {
  return _setMemberStatusImpl(db, session, input);
}
