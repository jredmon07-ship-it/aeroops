/**
 * get-member-detail.ts — Member detail aggregation (Slice 6.2).
 *
 * getMemberDetail — returns full detail for a single org member via
 * assembleMemberDetail(tx, userId). Cross-org / non-member → not_found.
 * Deactivated member → full detail (not not_found).
 *
 * GUARANTEES:
 *   - requireCapability('people:access') FIRST.
 *   - org_id from session only; cross-org userId → not_found (RLS + check).
 *   - Deactivated members return full detail (status flag, not an auth gate).
 *
 * TWO CALLING FORMS:
 *   getMemberDetail(session, input)          — app code.
 *   getMemberDetailWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { GetMemberDetailResult } from './types.js';
import { assembleMemberDetail } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  userId: z.string().regex(UUID_RE, { message: 'userId must be a UUID' }),
});

export interface GetMemberDetailInput {
  userId: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getMemberDetailImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetMemberDetailResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:access');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[people] invalid getMemberDetail input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const member = await assembleMemberDetail(tx, input.userId);
    if (!member) return { ok: false, reason: 'not_found' };
    return { ok: true, member };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getMemberDetail(
  session: AppSession | null | undefined,
  input: GetMemberDetailInput,
): Promise<GetMemberDetailResult> {
  const db = await getDb();
  return _getMemberDetailImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getMemberDetailWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetMemberDetailInput,
): Promise<GetMemberDetailResult> {
  return _getMemberDetailImpl(db, session, input);
}
