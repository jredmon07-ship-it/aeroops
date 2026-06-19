/**
 * void-lesson-record.ts — Void a lesson record (append-only tombstone) (Slice T1.2).
 *
 * voidLessonRecord — transitions a lesson_record from 'recorded' → 'voided'.
 * A second void on an already-voided record → already_voided (returned).
 *
 * The record is NEVER deleted. It remains in the record log with struck-through
 * display (audit history). The "who voided" lives in audit_log; voided_by may be
 * SET NULL on user hard-delete. [VERIFY-T1-C]
 *
 * GUARANTEES:
 *   - requireCapability('training:manage') FIRST (owner/manager/cfi).
 *   - org_id from session only; cross-org recordId → not_found (RLS).
 *   - voided_reason REQUIRED (non-empty after trim).
 *   - ONE audit row 'training.lesson_record_voided'.
 *   - Returns fresh EnrollmentDetail via assembleEnrollmentDetail.
 *
 * TWO CALLING FORMS:
 *   voidLessonRecord(session, input)          — app code.
 *   voidLessonRecordWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { lessonRecord, auditLog } from '@aeroops/db';
import { eq } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { VoidLessonRecordResult } from './types.js';
import { assembleEnrollmentDetail } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  recordId:     z.string().regex(UUID_RE, { message: 'recordId must be a UUID' }),
  voidedReason: z.string(),
});

export interface VoidLessonRecordInput {
  recordId: string;
  voidedReason: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _voidLessonRecordImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<VoidLessonRecordResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid voidLessonRecord input: ${first?.message ?? 'unknown'}`);
  }
  const reason = parsed.data.voidedReason.trim();
  if (reason.length === 0) {
    throw new ValidationError('[training] voidLessonRecord: voidedReason must not be empty after trimming');
  }
  const input = { recordId: parsed.data.recordId, voidedReason: reason };

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Fetch record (RLS-scoped; cross-org → not_found).
    const recordCheck = await tx.execute(sql`
      SELECT id, status, enrollment_id AS "enrollmentId"
      FROM lesson_record
      WHERE id = ${input.recordId}::uuid
      LIMIT 1
    `);
    const recordRows = (recordCheck.rows ?? recordCheck) as Array<{
      id: string;
      status: string;
      enrollmentId: string;
    }>;
    const record = recordRows[0];
    if (!record) return { ok: false, reason: 'not_found' };

    // 4. Check not already voided.
    if (record.status === 'voided') return { ok: false, reason: 'already_voided' };

    // 5. UPDATE: status → 'voided' + voided_at + voided_reason + voided_by.
    // The ONLY mutation path for lesson_record. Content fields (completed_at,
    // grade_label, notes, instructor_user_id) remain write-once. [VERIFY-T1-C]
    const now = new Date();
    await tx
      .update(lessonRecord)
      .set({
        status:       'voided',
        voidedAt:     now,
        voidedReason: input.voidedReason,
        voidedBy:     sess.userId,
      })
      .where(eq(lessonRecord.id, input.recordId));

    // 6. ONE audit row. The durable "who voided" lives here (voided_by SET NULL
    // on user hard-delete; audit_log is the authoritative record). [VERIFY-T1-C]
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'training.lesson_record_voided',
      entityType:  'lesson_record',
      entityId:    input.recordId,
      metadata:    {
        enrollmentId: record.enrollmentId,
        voidedReason: input.voidedReason,
        voidedBy:     sess.userId,
      },
    });

    // 7. Return fresh enrollment detail.
    const enrollDetail = await assembleEnrollmentDetail(tx, record.enrollmentId);
    if (!enrollDetail) throw new Error('[training] voidLessonRecord: re-read returned no enrollment row');
    return { ok: true, enrollment: enrollDetail };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function voidLessonRecord(
  session: AppSession | null | undefined,
  input: VoidLessonRecordInput,
): Promise<VoidLessonRecordResult> {
  const db = await getDb();
  return _voidLessonRecordImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function voidLessonRecordWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: VoidLessonRecordInput,
): Promise<VoidLessonRecordResult> {
  return _voidLessonRecordImpl(db, session, input);
}
