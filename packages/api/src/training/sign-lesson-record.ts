/**
 * sign-lesson-record.ts — record an e-signature/attestation on a
 * lesson_record (Slice P2-ESIGN).
 *
 * signLessonRecord — INSERTs a WRITE-ONCE, APPEND-ONLY lesson_signature row.
 * Refuses a second active signature on the same record (already_signed).
 *
 * COMPLIANCE HARD LINE [VERIFY-P2-A]: this is an operator/instructor
 * ATTESTATION artifact — NOT an FAA-recognized digital/electronic signature,
 * NOT a §61.51 / §61.65 / Part-141 endorsement of record, and it computes NO
 * training-completion/stage/graduation/currency determination. content_hash
 * is a TAMPER-EVIDENCE digest (sha256 of canonicalLessonRecordSnapshot,
 * @aeroops/core) — NOT a cryptographic/PKI signature. A stored signature
 * does not verify eligibility, endorsement validity, or airworthiness — a
 * human still makes every regulatory call.
 *
 * GUARANTEES:
 *   - requireCapability('training:manage') FIRST (owner/manager/cfi).
 *   - The signer is ALWAYS session.userId — there is NO signerUserId input.
 *     A caller can only ever sign as themselves (first-person attestation).
 *   - org_id from session only; cross-org lessonRecordId → not_found (RLS).
 *   - FOR UPDATE on the locked lesson_record row serializes concurrent signs
 *     on the SAME record — the loser re-evaluates the active-signature set
 *     after the winner commits and returns already_signed.
 *   - ONE audit row 'training.lesson_record_signed'.
 *   - lesson_signature has NO UPDATE/DELETE code path anywhere (RLS backstop
 *     enforces this structurally — see migration 0032).
 *   - Returns the fresh signature list for the record via assembleLessonSignatures.
 *
 * TWO CALLING FORMS:
 *   signLessonRecord(session, input)          — app code.
 *   signLessonRecordWithDb(db, session, input) — tests.
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
import type { SignLessonRecordResult } from './types.js';
import { assembleLessonSignatures } from './internal.js';
import { extractRows } from '../db-rows.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  lessonRecordId:  z.string().regex(UUID_RE, { message: 'lessonRecordId must be a UUID' }),
  /** FREE-TEXT: what the signer attests to. Required, non-empty after trim. */
  attestationText: z.string(),
});

export interface SignLessonRecordInput {
  lessonRecordId: string;
  attestationText: string;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _signLessonRecordImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SignLessonRecordResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'training:manage');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[training] invalid signLessonRecord input: ${first?.message ?? 'unknown'}`);
  }
  const attestationText = parsed.data.attestationText.trim();
  if (attestationText.length === 0) {
    throw new ValidationError('[training] signLessonRecord: attestationText must not be empty after trimming');
  }
  const input = { lessonRecordId: parsed.data.lessonRecordId, attestationText };

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load + LOCK the lesson_record row (RLS-scoped; cross-org → not_found).
    //    FOR UPDATE serializes concurrent signs on the SAME record.
    const recordResult = await tx.execute(sql`
      SELECT
        id, enrollment_id AS "enrollmentId", lesson_id AS "lessonId",
        instructor_user_id AS "instructorUserId", completed_at AS "completedAt",
        grade_label AS "gradeLabel", notes, status
      FROM lesson_record
      WHERE id = ${input.lessonRecordId}::uuid
      FOR UPDATE
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
    if (!record) return { ok: false, reason: 'not_found' };

    // 4. Compute the active-signature set. Any non-tombstone row not voided by
    //    a later tombstone counts as active — refuse a second one.
    const existing = await assembleLessonSignatures(tx, input.lessonRecordId);
    const hasActive = existing.some((s) => !s.isTombstone && !s.isVoided);
    if (hasActive) return { ok: false, reason: 'already_signed' };

    // 5. Snapshot the signer's role AT SIGNING TIME (RLS-scoped; must exist).
    const membershipResult = await tx.execute(sql`
      SELECT role FROM membership WHERE user_id = ${sess.userId}::uuid LIMIT 1
    `);
    const membershipRows = extractRows<{ role: string }>(membershipResult);
    const roleAtSigning = membershipRows[0]?.role;
    if (!roleAtSigning) return { ok: false, reason: 'not_found' };

    // 6. Compute content_hash = sha256(canonicalLessonRecordSnapshot(locked snapshot)).
    //    TAMPER-EVIDENCE digest ONLY — NOT a cryptographic/PKI signature. [VERIFY-P2-A]
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

    // 7. INSERT one lesson_signature (APPEND-ONLY; voided_by_signature_id NULL;
    //    signer_user_id ALWAYS session.userId — NO signerUserId input exists).
    const inserted = await tx
      .insert(lessonSignature)
      .values({
        orgId:            sess.orgId,
        lessonRecordId:   input.lessonRecordId,
        signerUserId:     sess.userId,
        roleAtSigning,
        attestationText:  input.attestationText,
        contentHash,
      })
      .returning({ id: lessonSignature.id });

    const signatureId = inserted[0]?.id;
    if (!signatureId) throw new Error('[training] signLessonRecord: INSERT returned no id');

    // 8. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'training.lesson_record_signed',
      entityType:  'lesson_signature',
      entityId:    signatureId,
      metadata:    {
        lessonRecordId: input.lessonRecordId,
        contentHash,
      },
    });

    // 9. Return fresh signature list.
    const signatures = await assembleLessonSignatures(tx, input.lessonRecordId);
    return { ok: true, signatures };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function signLessonRecord(
  session: AppSession | null | undefined,
  input: SignLessonRecordInput,
): Promise<SignLessonRecordResult> {
  const db = await getDb();
  return _signLessonRecordImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function signLessonRecordWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: SignLessonRecordInput,
): Promise<SignLessonRecordResult> {
  return _signLessonRecordImpl(db, session, input);
}
