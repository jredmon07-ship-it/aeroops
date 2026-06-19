/**
 * get-course-detail.ts — Course detail aggregation (Slice T1.2).
 *
 * getCourseDetail — returns full detail for a single course via
 * assembleCourseDetail(tx, courseId). Cross-org → not_found.
 *
 * GUARANTEES:
 *   - requireCapability('training:access') FIRST.
 *   - org_id from session only; cross-org courseId → not_found (RLS).
 *
 * TWO CALLING FORMS:
 *   getCourseDetail(session, input)          — app code.
 *   getCourseDetailWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { GetCourseDetailResult } from './types.js';
import { assembleCourseDetail } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  courseId: z.string().regex(UUID_RE, { message: 'courseId must be a UUID' }),
});

export interface GetCourseDetailInput {
  courseId: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getCourseDetailImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetCourseDetailResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:access');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid getCourseDetail input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const course = await assembleCourseDetail(tx, input.courseId);
    if (!course) return { ok: false, reason: 'not_found' };
    return { ok: true, course };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getCourseDetail(
  session: AppSession | null | undefined,
  input: GetCourseDetailInput,
): Promise<GetCourseDetailResult> {
  const db = await getDb();
  return _getCourseDetailImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getCourseDetailWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetCourseDetailInput,
): Promise<GetCourseDetailResult> {
  return _getCourseDetailImpl(db, session, input);
}
