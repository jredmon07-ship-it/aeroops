/**
 * get-lesson-signatures.ts — read the signature list for a lesson_record
 * (Slice P2-ESIGN).
 *
 * getLessonSignatures — returns all lesson_signature rows for a record
 * (including tombstones), newest-first, with derived isTombstone/isVoided.
 * Cross-org / nonexistent lessonRecordId returns [] (RLS makes it invisible;
 * no distinguishable not_found — reads never leak existence).
 *
 * COMPLIANCE [VERIFY-P2-A]: see sign-lesson-record.ts / types.ts — an
 * operator/instructor ATTESTATION artifact, NOT an FAA-recognized digital/
 * electronic signature.
 *
 * GUARANTEES:
 *   - requireCapability('training:access') FIRST (owner/manager/dispatcher/cfi).
 *   - org_id from session only; ONE RLS-scoped aggregation query, no N+1.
 *
 * TWO CALLING FORMS:
 *   getLessonSignatures(session, input)          — app code.
 *   getLessonSignaturesWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { GetLessonSignaturesResult } from './types.js';
import { assembleLessonSignatures } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  lessonRecordId: z.string().regex(UUID_RE, { message: 'lessonRecordId must be a UUID' }),
});

export interface GetLessonSignaturesInput {
  lessonRecordId: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getLessonSignaturesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetLessonSignaturesResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:access');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid getLessonSignatures input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    return assembleLessonSignatures(tx, input.lessonRecordId);
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getLessonSignatures(
  session: AppSession | null | undefined,
  input: GetLessonSignaturesInput,
): Promise<GetLessonSignaturesResult> {
  const db = await getDb();
  return _getLessonSignaturesImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getLessonSignaturesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetLessonSignaturesInput,
): Promise<GetLessonSignaturesResult> {
  return _getLessonSignaturesImpl(db, session, input);
}
