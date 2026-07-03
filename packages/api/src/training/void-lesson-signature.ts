/**
 * void-lesson-signature.ts — void a lesson_signature by APPENDING a tombstone
 * row (Slice P2-ESIGN). The original row is NEVER updated or deleted.
 *
 * voidLessonSignature — INSERTs a new lesson_signature row whose
 * `voided_by_signature_id` points at the signature being voided. That
 * tombstone's `attestation_text` carries the operator-provided void reason.
 *
 * COMPLIANCE HARD LINE [VERIFY-P2-A]: mirrors sign-lesson-record.ts — a
 * lesson_signature (including its tombstone) is an operator/instructor
 * ATTESTATION artifact, NOT an FAA-recognized digital/electronic signature or
 * §61/§141 endorsement of record.
 *
 * GUARANTEES:
 *   - requireCapability('training:manage') FIRST (owner/manager/cfi).
 *   - org_id from session only; cross-org signatureId → not_found (RLS).
 *   - Voiding a tombstone is refused (cannot_void_tombstone) — a tombstone
 *     can never itself be voided.
 *   - Voiding an already-voided signature is refused (already_voided).
 *   - FOR UPDATE on the locked lesson_record row serializes concurrent voids
 *     of signatures on the SAME record (exactly one tombstone per target).
 *   - ONE audit row 'training.lesson_signature_voided'.
 *   - APPEND-ONLY: the ORIGINAL row is never touched by this or any other
 *     code path (structural RLS backstop — see migration 0032).
 *   - Returns the fresh signature list for the record via assembleLessonSignatures.
 *
 * TWO CALLING FORMS:
 *   voidLessonSignature(session, input)          — app code.
 *   voidLessonSignatureWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { lessonSignature, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { canonicalLessonRecordSnapshot } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { VoidLessonSignatureResult } from './types.js';
import { assembleLessonSignatures } from './internal.js';
import { extractRows } from '../db-rows.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  signatureId: z.string().regex(UUID_RE, { message: 'signatureId must be a UUID' }),
  /** Operator-required reason for voiding. Required, non-empty after trim. */
  reason:      z.string(),
});

export interface VoidLessonSignatureInput {
  signatureId: string;
  reason: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _voidLessonSignatureImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<VoidLessonSignatureResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid voidLessonSignature input: ${first?.message ?? 'unknown'}`);
  }
  const reason = parsed.data.reason.trim();
  if (reason.length === 0) {
    throw new ValidationError('[training] voidLessonSignature: reason must not be empty after trimming');
  }
  const input = { signatureId: parsed.data.signatureId, reason };

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Fetch the target signature (RLS-scoped; cross-org → not_found).
    const targetResult = await tx.execute(sql`
      SELECT id, lesson_record_id AS "lessonRecordId", voided_by_signature_id AS "voidedBySignatureId"
      FROM lesson_signature
      WHERE id = ${input.signatureId}::uuid
      LIMIT 1
    `);
    const targetRows = extractRows<{
      id: string;
      lessonRecordId: string;
      voidedBySignatureId: string | null;
    }>(targetResult);
    const target = targetRows[0];
    if (!target) return { ok: false, reason: 'not_found' };

    // 4. Refuse voiding a tombstone.
    if (target.voidedBySignatureId != null) {
      return { ok: false, reason: 'cannot_void_tombstone' };
    }

    // 5. Lock the parent lesson_record row FOR UPDATE — serializes concurrent
    //    voids of signatures on the SAME record.
    await tx.execute(sql`
      SELECT id FROM lesson_record WHERE id = ${target.lessonRecordId}::uuid FOR UPDATE
    `);

    // 6. Refuse voiding an already-voided signature (re-check under the lock).
    const alreadyVoidedResult = await tx.execute(sql`
      SELECT id FROM lesson_signature
      WHERE voided_by_signature_id = ${target.id}::uuid
      LIMIT 1
    `);
    if (extractRows<{ id: string }>(alreadyVoidedResult).length > 0) {
      return { ok: false, reason: 'already_voided' };
    }

    // 7. Snapshot the voider's role AT VOID TIME.
    const membershipResult = await tx.execute(sql`
      SELECT role FROM membership WHERE user_id = ${sess.userId}::uuid LIMIT 1
    `);
    const membershipRows = extractRows<{ role: string }>(membershipResult);
    const roleAtSigning = membershipRows[0]?.role;
    if (!roleAtSigning) return { ok: false, reason: 'not_found' };

    // 8. Compute content_hash of the CURRENT lesson_record snapshot at void
    //    time — tamper-evidence at the moment of voiding. [VERIFY-P2-A]
    const recordResult = await tx.execute(sql`
      SELECT
        id, enrollment_id AS "enrollmentId", lesson_id AS "lessonId",
        instructor_user_id AS "instructorUserId", completed_at AS "completedAt",
        grade_label AS "gradeLabel", notes, status
      FROM lesson_record
      WHERE id = ${target.lessonRecordId}::uuid
      LIMIT 1
    `);
    const recordRows = extractRows<{
      id: string;
      enrollmentId: string;
      lessonId: string;
      instructorUserId: string;
      completedAt: Date | string;
      gradeLabel: string | null;
      notes: string | null;
      status: string;
    }>(recordResult);
    const record = recordRows[0];
    if (!record) throw new Error('[training] voidLessonSignature: linked lesson_record disappeared under lock');

    const completedAtIso = (
      record.completedAt instanceof Date ? record.completedAt : new Date(record.completedAt)
    ).toISOString();
    const canonical = canonicalLessonRecordSnapshot({
      id:               record.id,
      enrollmentId:     record.enrollmentId,
      lessonId:         record.lessonId,
      instructorUserId: record.instructorUserId,
      completedAt:      completedAtIso,
      gradeLabel:       record.gradeLabel ?? null,
      notes:            record.notes ?? null,
      status:           record.status,
    });
    const contentHash = createHash('sha256').update(canonical).digest('hex');

    // 9. INSERT the tombstone (APPEND-ONLY; the ORIGINAL row is never touched).
    const inserted = await tx
      .insert(lessonSignature)
      .values({
        orgId:               sess.orgId,
        lessonRecordId:      target.lessonRecordId,
        signerUserId:        sess.userId,
        roleAtSigning,
        attestationText:     input.reason,
        contentHash,
        voidedBySignatureId: target.id,
      })
      .returning({ id: lessonSignature.id });

    const tombstoneId = inserted[0]?.id;
    if (!tombstoneId) throw new Error('[training] voidLessonSignature: INSERT returned no id');

    // 10. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'training.lesson_signature_voided',
      entityType:  'lesson_signature',
      entityId:    tombstoneId,
      metadata:    {
        voidedSignatureId: target.id,
        lessonRecordId:    target.lessonRecordId,
        reason:            input.reason,
      },
    });

    // 11. Return fresh signature list.
    const signatures = await assembleLessonSignatures(tx, target.lessonRecordId);
    return { ok: true, signatures };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function voidLessonSignature(
  session: AppSession | null | undefined,
  input: VoidLessonSignatureInput,
): Promise<VoidLessonSignatureResult> {
  const db = await getDb();
  return _voidLessonSignatureImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function voidLessonSignatureWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: VoidLessonSignatureInput,
): Promise<VoidLessonSignatureResult> {
  return _voidLessonSignatureImpl(db, session, input);
}
