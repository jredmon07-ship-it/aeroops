/**
 * set-enrollment-status.ts — Change enrollment status (Slice T1.2).
 *
 * setEnrollmentStatus — transitions enrollment status.
 * Valid transitions: active→completed | active→withdrawn ONLY.
 * Other transitions (incl. completed/withdrawn→active) → invalid_transition.
 *
 * COMPLIANCE:
 *   'completed' = operator toggle, NOT a Part-141 80%-completion-rate or graduation.
 *   [VERIFY-T1-B]
 *
 * GUARANTEES:
 *   - requireCapability('training:manage') FIRST (owner/manager/cfi).
 *   - org_id from session only; cross-org → not_found.
 *   - active→completed | active→withdrawn ONLY; else → invalid_transition.
 *   - ONE audit row 'training.enrollment_status_changed'.
 *   - Returns fresh EnrollmentDetail.
 *
 * TWO CALLING FORMS:
 *   setEnrollmentStatus(session, input)          — app code.
 *   setEnrollmentStatusWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { enrollment, auditLog } from '@aeroops/db';
import { eq } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { ENROLLMENT_STATUSES } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { SetEnrollmentStatusResult } from './types.js';
import { assembleEnrollmentDetail } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  enrollmentId: z.string().regex(UUID_RE, { message: 'enrollmentId must be a UUID' }),
  status: z.enum([...ENROLLMENT_STATUSES] as [string, ...string[]]),
});

export interface SetEnrollmentStatusInput {
  enrollmentId: string;
  status: string;
}

// Valid transitions (API-enforced): active → completed | active → withdrawn
const VALID_TRANSITIONS: Record<string, string[]> = {
  active: ['completed', 'withdrawn'],
};

// ─── Shared implementation ────────────────────────────────────────────────────

async function _setEnrollmentStatusImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetEnrollmentStatusResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid setEnrollmentStatus input: ${first?.message ?? 'unknown'}`);
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Fetch enrollment (RLS-scoped; cross-org → not_found).
    const enrollCheck = await tx.execute(sql`
      SELECT id, status FROM enrollment WHERE id = ${input.enrollmentId}::uuid LIMIT 1
    `);
    const enrollRows = (enrollCheck.rows ?? enrollCheck) as Array<{ id: string; status: string }>;
    const enrollRow = enrollRows[0];
    if (!enrollRow) return { ok: false, reason: 'not_found' };

    // 4. Validate transition.
    const allowed = VALID_TRANSITIONS[enrollRow.status] ?? [];
    if (!allowed.includes(input.status)) {
      return { ok: false, reason: 'invalid_transition' };
    }

    // 5. UPDATE status + status_changed_at.
    await tx
      .update(enrollment)
      .set({
        status:          input.status as typeof enrollment.$inferInsert['status'],
        statusChangedAt: new Date(),
        updatedAt:       new Date(),
      })
      .where(eq(enrollment.id, input.enrollmentId));

    // 6. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'training.enrollment_status_changed',
      entityType:  'enrollment',
      entityId:    input.enrollmentId,
      metadata:    { from: enrollRow.status, to: input.status },
    });

    // 7. Return fresh detail.
    const enrollDetail = await assembleEnrollmentDetail(tx, input.enrollmentId);
    if (!enrollDetail) throw new Error('[training] setEnrollmentStatus: re-read returned no row');
    return { ok: true, enrollment: enrollDetail };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function setEnrollmentStatus(
  session: AppSession | null | undefined,
  input: SetEnrollmentStatusInput,
): Promise<SetEnrollmentStatusResult> {
  const db = await getDb();
  return _setEnrollmentStatusImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function setEnrollmentStatusWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: SetEnrollmentStatusInput,
): Promise<SetEnrollmentStatusResult> {
  return _setEnrollmentStatusImpl(db, session, input);
}
