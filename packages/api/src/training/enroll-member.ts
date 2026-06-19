/**
 * enroll-member.ts — Enroll a member in a course (Slice T1.2).
 *
 * enrollMember — inserts a new enrollment row.
 * Duplicate (same student + course) → returns {ok:false, reason:'duplicate'} via 23505.
 * Cross-org course/member → not_found (RLS).
 *
 * COMPLIANCE:
 *   student_user_id = ANY org member; no role enforcement in T1. [VERIFY-T1-E]
 *   'completed' after enroll is an operator flag, NOT a Part-141 determination. [VERIFY-T1-B]
 *
 * GUARANTEES:
 *   - requireCapability('training:manage') FIRST (owner/manager/cfi).
 *   - org_id from session only.
 *   - 23505 on (student_user_id, course_id) → returned {ok:false, reason:'duplicate'}.
 *   - ONE audit row 'training.member_enrolled'.
 *   - Returns fresh EnrollmentDetail via assembleEnrollmentDetail.
 *
 * TWO CALLING FORMS:
 *   enrollMember(session, input)          — app code.
 *   enrollMemberWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { enrollment, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { isUniqueViolation } from '../dispatch/internal.js';
import type { EnrollMemberResult } from './types.js';
import { assembleEnrollmentDetail } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  courseId:      z.string().regex(UUID_RE, { message: 'courseId must be a UUID' }),
  studentUserId: z.string().regex(UUID_RE, { message: 'studentUserId must be a UUID' }),
});

export interface EnrollMemberInput {
  courseId: string;
  studentUserId: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _enrollMemberImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<EnrollMemberResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid enrollMember input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Check course visible in org (RLS; cross-org → not_found).
    const courseCheck = await tx.execute(sql`
      SELECT id FROM course WHERE id = ${input.courseId}::uuid LIMIT 1
    `);
    const courseRows = (courseCheck.rows ?? courseCheck) as Array<{ id: string }>;
    if (courseRows.length === 0) return { ok: false, reason: 'not_found' };

    // 4. Check student visible in org (RLS via membership; cross-org → not_found).
    const memberCheck = await tx.execute(sql`
      SELECT user_id FROM membership WHERE user_id = ${input.studentUserId}::uuid LIMIT 1
    `);
    const memberRows = (memberCheck.rows ?? memberCheck) as Array<{ user_id: string }>;
    if (memberRows.length === 0) return { ok: false, reason: 'not_found' };

    // 5. INSERT enrollment. UNIQUE(student_user_id, course_id) → 23505 → duplicate.
    let enrollmentId: string;
    try {
      const inserted = await tx
        .insert(enrollment)
        .values({
          orgId:         sess.orgId,
          courseId:      input.courseId,
          studentUserId: input.studentUserId,
          enrolledBy:    sess.userId,
        })
        .returning({ id: enrollment.id });

      enrollmentId = inserted[0]?.id ?? '';
      if (!enrollmentId) throw new Error('[training] enrollMember: INSERT returned no id');
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { ok: false, reason: 'duplicate' };
      }
      throw err;
    }

    // 6. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'training.member_enrolled',
      entityType:  'enrollment',
      entityId:    enrollmentId,
      metadata:    { courseId: input.courseId, studentUserId: input.studentUserId },
    });

    // 7. Return fresh detail.
    const enrollDetail = await assembleEnrollmentDetail(tx, enrollmentId);
    if (!enrollDetail) throw new Error('[training] enrollMember: re-read returned no row');
    return { ok: true, enrollment: enrollDetail };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function enrollMember(
  session: AppSession | null | undefined,
  input: EnrollMemberInput,
): Promise<EnrollMemberResult> {
  const db = await getDb();
  return _enrollMemberImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function enrollMemberWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: EnrollMemberInput,
): Promise<EnrollMemberResult> {
  return _enrollMemberImpl(db, session, input);
}
