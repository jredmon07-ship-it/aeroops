/**
 * get-enrollment-detail.ts — Enrollment detail aggregation (Slice T1.2).
 *
 * getEnrollmentDetail — returns full detail for a single enrollment via
 * assembleEnrollmentDetail(tx, enrollmentId). Cross-org → not_found.
 *
 * GUARANTEES:
 *   - requireCapability('training:access') FIRST.
 *   - org_id from session only; cross-org enrollmentId → not_found (RLS).
 *
 * TWO CALLING FORMS:
 *   getEnrollmentDetail(session, input)          — app code.
 *   getEnrollmentDetailWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { GetEnrollmentDetailResult } from './types.js';
import { assembleEnrollmentDetail } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  enrollmentId: z.string().regex(UUID_RE, { message: 'enrollmentId must be a UUID' }),
});

export interface GetEnrollmentDetailInput {
  enrollmentId: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getEnrollmentDetailImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetEnrollmentDetailResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:access');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid getEnrollmentDetail input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const enrollment = await assembleEnrollmentDetail(tx, input.enrollmentId);
    if (!enrollment) return { ok: false, reason: 'not_found' };
    return { ok: true, enrollment };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getEnrollmentDetail(
  session: AppSession | null | undefined,
  input: GetEnrollmentDetailInput,
): Promise<GetEnrollmentDetailResult> {
  const db = await getDb();
  return _getEnrollmentDetailImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getEnrollmentDetailWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetEnrollmentDetailInput,
): Promise<GetEnrollmentDetailResult> {
  return _getEnrollmentDetailImpl(db, session, input);
}
