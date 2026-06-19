/**
 * update-member.ts — Member identity + role edit (Slice 6.2).
 *
 * updateMember — edits fullName / phone / role on a membership. NEVER
 * touches email, auth credentials, meters, or any audited records.
 *
 * GUARANTEES:
 *   - requireCapability('people:manage') FIRST (owner/manager only).
 *   - org_id from session only; cross-org userId → not_found.
 *   - role validated via isMembershipRole.
 *   - Last-owner guard: demoting the sole active owner → last_owner.
 *     "active owners" = membership rows with role='owner' joined to
 *     app_user.status='active'. TOCTOU race is documented as acceptable
 *     (reversible, no money; no FOR UPDATE over-engineering per spec).
 *   - ONE audit row 'member.updated' per call (before/after of changed fields).
 *   - Returns fresh MemberDetail via assembleMemberDetail.
 *
 * TWO CALLING FORMS:
 *   updateMember(session, input)          — app code.
 *   updateMemberWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { membership, appUser, auditLog } from '@aeroops/db';
import { eq } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { isMembershipRole } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { UpdateMemberResult } from './types.js';
import { assembleMemberDetail } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  userId:   z.string().regex(UUID_RE, { message: 'userId must be a UUID' }),
  fullName: z.string().min(1).optional(),
  phone:    z.string().nullable().optional(),
  role:     z.string().optional(),
});

export interface UpdateMemberInput {
  userId: string;
  fullName?: string;
  phone?: string | null;
  role?: string;
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
  const rows = (result.rows ?? result) as Array<{ count: number | string }>;
  const raw = rows[0]?.count ?? 0;
  return typeof raw === 'string' ? parseInt(raw, 10) : raw;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _updateMemberImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<UpdateMemberResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[people] invalid updateMember input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  // 3. Validate role value if provided.
  if (input.role !== undefined && !isMembershipRole(input.role)) {
    throw new ValidationError(`[people] invalid role: ${input.role}`);
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 4. Load current state (RLS-scoped; cross-org → 0 rows → not_found).
    const existing = await tx
      .select({
        userId:   membership.userId,
        role:     membership.role,
        fullName: appUser.fullName,
        phone:    appUser.phone,
      })
      .from(membership)
      .innerJoin(appUser, eq(membership.userId, appUser.id))
      .where(eq(membership.userId, input.userId))
      .limit(1);

    const current = existing[0];
    if (!current) return { ok: false, reason: 'not_found' };

    // 5. Last-owner guard: if demoting the target from 'owner' to something else,
    //    count active owners. If count ≤ 1 after demotion, refuse.
    if (
      input.role !== undefined &&
      input.role !== 'owner' &&
      current.role === 'owner'
    ) {
      const activeOwners = await countActiveOwners(tx);
      if (activeOwners <= 1) {
        return { ok: false, reason: 'last_owner' };
      }
    }

    // 6. Apply app_user updates (fullName / phone).
    const userUpdates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.fullName !== undefined) userUpdates['fullName'] = input.fullName;
    if (input.phone    !== undefined) userUpdates['phone']    = input.phone;
    if (Object.keys(userUpdates).length > 1) {
      await tx
        .update(appUser)
        .set(userUpdates)
        .where(eq(appUser.id, input.userId));
    }

    // 7. Apply membership role update.
    if (input.role !== undefined) {
      await tx
        .update(membership)
        .set({ role: input.role as MembershipRole, updatedAt: new Date() })
        .where(eq(membership.userId, input.userId));
    }

    // 8. ONE audit row — before/after of identity fields.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'member.updated',
      entityType:  'app_user',
      entityId:    input.userId,
      metadata: {
        before: {
          fullName: current.fullName,
          phone:    current.phone,
          role:     current.role,
        },
        after: {
          fullName: input.fullName  !== undefined ? input.fullName  : current.fullName,
          phone:    input.phone     !== undefined ? input.phone     : current.phone,
          role:     input.role      !== undefined ? input.role      : current.role,
        },
      },
    });

    // 9. Return fresh detail.
    const member = await assembleMemberDetail(tx, input.userId);
    if (!member) throw new Error('[people] updateMember: re-read returned no row');
    return { ok: true, member };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function updateMember(
  session: AppSession | null | undefined,
  input: UpdateMemberInput,
): Promise<UpdateMemberResult> {
  const db = await getDb();
  return _updateMemberImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function updateMemberWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: UpdateMemberInput,
): Promise<UpdateMemberResult> {
  return _updateMemberImpl(db, session, input);
}
