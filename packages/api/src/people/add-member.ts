/**
 * add-member.ts — Add a new roster entry (Slice 6.2).
 *
 * addMember — creates an app_user + membership for a new org member.
 * NO auth_credential is created. The member is a roster entry (taggable,
 * role-assignable, deactivatable) with no password; they get a login when an
 * owner/manager creates a login link for them (people/login-link.ts) and they
 * set a password with it. [AUTH-DECISION / Conductor 2026-06-19]
 *
 * GUARANTEES:
 *   - requireCapability('people:manage') FIRST (owner/manager only).
 *   - NO auth_credential insert — zero credential rows created.
 *   - Org-email collision → returned {ok:false, reason:'email_taken'}.
 *   - ONE audit row 'member.created'.
 *   - Returns fresh MemberDetail via assembleMemberDetail.
 *
 * TWO CALLING FORMS:
 *   addMember(session, input)          — app code.
 *   addMemberWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { appUser, membership, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { isMembershipRole } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { isUniqueViolation } from '../dispatch/internal.js';
import type { AddMemberResult } from './types.js';
import { assembleMemberDetail } from './internal.js';

const inputSchema = z.object({
  email:    z.string().email({ message: 'email must be a valid email address' }),
  fullName: z.string().min(1).optional(),
  phone:    z.string().nullable().optional(),
  role:     z.string(),
});

export interface AddMemberInput {
  email: string;
  fullName?: string;
  phone?: string | null;
  role: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _addMemberImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<AddMemberResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[people] invalid addMember input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  // 3. Validate role.
  if (!isMembershipRole(input.role)) {
    throw new ValidationError(`[people] addMember: invalid role '${input.role}'`);
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 4. Insert app_user (status='active' default; NO auth_credential).
    let newUser: { id: string };
    try {
      const inserted = await tx
        .insert(appUser)
        .values({
          orgId:    sess.orgId,
          email:    input.email,
          fullName: input.fullName ?? null,
          phone:    input.phone    ?? null,
          // status defaults to 'active' via column DEFAULT.
        })
        .returning({ id: appUser.id });
      newUser = inserted[0]!;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // org_id + email unique → email already exists in this org.
        return { ok: false, reason: 'email_taken' };
      }
      throw err;
    }

    // 5. Insert membership.
    await tx.insert(membership).values({
      orgId:  sess.orgId,
      userId: newUser.id,
      role:   input.role as MembershipRole,
    });

    // 6. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'member.created',
      entityType:  'app_user',
      entityId:    newUser.id,
      metadata: {
        email:    input.email,
        fullName: input.fullName ?? null,
        role:     input.role,
        note:     'Roster entry — no password until a login link is used.',
      },
    });

    // 7. Return fresh detail.
    const member = await assembleMemberDetail(tx, newUser.id);
    if (!member) throw new Error('[people] addMember: re-read returned no row');
    return { ok: true, member };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function addMember(
  session: AppSession | null | undefined,
  input: AddMemberInput,
): Promise<AddMemberResult> {
  const db = await getDb();
  return _addMemberImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function addMemberWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: AddMemberInput,
): Promise<AddMemberResult> {
  return _addMemberImpl(db, session, input);
}
