/**
 * lesson-signature-api.test.ts — tests for Slice P2-ESIGN (e-signature on
 * lesson records): migration 0032 (lesson_signature) + signLessonRecord /
 * voidLessonSignature / getLessonSignatures.
 *
 * COMPLIANCE [VERIFY-P2-A]: a lesson_signature is an operator/instructor
 * ATTESTATION artifact — NOT an FAA-recognized digital/electronic signature,
 * NOT a §61.51/§61.65/Part-141 endorsement of record, and computes NO
 * training-completion/stage/graduation/currency determination. These tests
 * verify persistence/RLS/append-only/authz mechanics ONLY; no regulatory
 * logic is exercised because none exists in this slice.
 *
 * TWO SEEDED ORGS (A and B) with deliberate cross-org data — tenant isolation
 * is the PRIMARY risk on every new table.
 *
 * COVERAGE (mirrors the spec §7 test list):
 *
 * Schema / migration:
 *   S1  — RLS isolation: org A cannot SELECT org B's lesson_signature rows.
 *   S2  — Append-only: UPDATE and DELETE are rejected under aeroops_app
 *         (FORCE RLS + no policy + explicit REVOKE) — both fail.
 *   S3  — CHECK constraints fire: empty role_at_signing / attestation_text /
 *         content_hash all rejected.
 *   S4  — Composite FKs reject cross-org lesson_record_id / signer_user_id /
 *         voided_by_signature_id.
 *   S5  — UNIQUE (id, org_id) present; self-FK (tombstone → target) resolves.
 *
 * API — signLessonRecord:
 *   A1  — Happy path: INSERTs an immutable signature; content_hash equals
 *         sha256(canonicalLessonRecordSnapshot(snapshot)) recomputed in-test.
 *   A2  — Exactly ONE audit_log row (training.lesson_record_signed).
 *   A3  — signer_user_id === session.userId always (no signerUserId input
 *         accepted at all — structural, not just "ignored").
 *   A4  — Second active signature on the same record → already_signed (no
 *         second row inserted).
 *   A5  — not_found for cross-org / nonexistent lessonRecordId.
 *   A6  — Auth ordering: non-manager roles → ForbiddenError BEFORE any DB
 *         read/write ("random member can't sign someone's lesson record").
 *         dispatcher (access but not manage) also Forbidden.
 *
 * API — voidLessonSignature:
 *   V1  — Appends a tombstone (voided_by_signature_id = target.id); the
 *         ORIGINAL row is byte-unchanged; row count grows by exactly 1.
 *   V2  — ONE audit_log row (training.lesson_signature_voided).
 *   V3  — After void, isVoided=true and a subsequent signLessonRecord
 *         succeeds (re-sign allowed).
 *   V4  — Voiding a tombstone → cannot_void_tombstone; voiding an
 *         already-voided signature → already_voided.
 *   V5  — Cross-org signatureId → not_found. Non-manager → Forbidden.
 *
 * Tenant isolation (adversarial, top priority):
 *   T1  — Org B session cannot sign, void, or read org A's lesson-record
 *         signatures (not_found/empty; never leaks a row or 500s).
 *
 * Tamper-evidence:
 *   H1  — Void the underlying lesson_record via voidLessonRecord +
 *         recordLesson a fresh one producing a different snapshot; a NEW
 *         signature's hash differs from the first.
 *
 * API — getLessonSignatures:
 *   G1  — Returns rows newest-first with correct isTombstone/isVoided/
 *         signerName/roleAtSigning; training:access-only role (dispatcher)
 *         can read; no-cap role Forbidden.
 *
 * Setup pattern: createTestClient() → applyMigrationSql([0000–0032]) →
 * seedTwoOrgs → additional seed → setTestAppRole.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  lessonSignature,
  appUser,
  membership,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import { canonicalLessonRecordSnapshot } from '@aeroops/core';

import { createCourseWithDb } from '../training/create-course.js';
import { addCourseLessonWithDb } from '../training/add-course-lesson.js';
import { enrollMemberWithDb } from '../training/enroll-member.js';
import { recordLessonWithDb } from '../training/record-lesson.js';
import { voidLessonRecordWithDb } from '../training/void-lesson-record.js';
import { signLessonRecordWithDb } from '../training/sign-lesson-record.js';
import { voidLessonSignatureWithDb } from '../training/void-lesson-signature.js';
import { getLessonSignaturesWithDb } from '../training/get-lesson-signatures.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// ── Path resolution ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const MIGRATION_FILES = [
  '0000_loud_prodigy.sql',
  '0001_auth_credential.sql',
  '0002_scheduling.sql',
  '0003_booking_policies.sql',
  '0004_recurrence.sql',
  '0005_dispatch.sql',
  '0006_squawks_grounding.sql',
  '0007_fleet.sql',
  '0008_people.sql',
  '0009_dispatch_gate.sql',
  '0010_civil_twilight.sql',
  '0011_optimizer_run.sql',
  '0012_training.sql',
  '0013_work_orders.sql',
  '0014_availability.sql',
  '0015_booking_request.sql',
  '0016_booking_request_convert.sql',
  '0017_booking_retention.sql',
  '0018_dispatch_ticket_correction.sql',
  '0019_billing_records.sql',
  '0020_demo_reset_state.sql',
  '0021_qbo_integration.sql',
  '0022_billing_ledger.sql',
  '0023_stripe_foundation.sql',
  '0024_payment_methods_autopay.sql',
  '0025_recurring_dues.sql',
  '0026_notifications.sql',
  '0027_data_import.sql',
  '0028_calendar_feed.sql',
  '0029_maintenance_due.sql',
  '0030_documents.sql',
  '0031_pos_sales.sql',
  '0032_lesson_signature.sql',
];

const MIGRATION_SQL = MIGRATION_FILES.map((f) =>
  readFileSync(resolve(__dirname, '../../../db/migrations/', f), 'utf-8'),
);

// ── Shared test env ──────────────────────────────────────────────────────────

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
}

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

let env: TestEnv;

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });
  env = {
    db,
    pglite,
    orgAId:  seed.orgAId,
    orgBId:  seed.orgBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };
});

// ── Fixture helper ───────────────────────────────────────────────────────────

/**
 * Builds a course → lesson → enrollment → lesson_record fixture for the given
 * org/session, returns the lesson_record id (+ related ids) for signing tests.
 */
async function makeLessonRecordFixture(
  sess: AppSession,
  opts: { gradeLabel?: string; notes?: string } = {},
): Promise<{
  courseId: string;
  lessonId: string;
  enrollmentId: string;
  lessonRecordId: string;
  studentUserId: string;
}> {
  const course = await createCourseWithDb(env.db, sess, { title: `Sig Course ${Date.now()}-${Math.random()}` });
  if (!course.ok) throw new Error('fixture: createCourse failed');
  const courseId = course.course.courseId;

  const lesson = await addCourseLessonWithDb(env.db, sess, { courseId, title: 'Sig Lesson' });
  if (!lesson.ok) throw new Error('fixture: addCourseLesson failed');
  const lessonId = lesson.course.lessons[lesson.course.lessons.length - 1]!.lessonId;

  const enroll = await enrollMemberWithDb(env.db, sess, { courseId, studentUserId: sess.userId });
  if (!enroll.ok) throw new Error('fixture: enrollMember failed');
  const enrollmentId = enroll.enrollment.enrollmentId;

  const recorded = await recordLessonWithDb(env.db, sess, {
    enrollmentId,
    lessonId,
    instructorUserId: sess.userId,
    gradeLabel: opts.gradeLabel ?? 'S',
    notes: opts.notes ?? 'Solid lesson',
  });
  if (!recorded.ok) throw new Error('fixture: recordLesson failed');
  const lessonRecordId = recorded.enrollment.records[0]!.id;

  return { courseId, lessonId, enrollmentId, lessonRecordId, studentUserId: sess.userId };
}

let seedTail = 0;

/** Seeds a fresh org member with the given role (mirrors documents-api.test.ts). */
async function seedMemberWithRole(
  orgId: string,
  role: AppSession['role'],
  tag: string,
): Promise<{ id: string; email: string }> {
  seedTail += 1;
  const email = `${tag.toLowerCase()}-${seedTail}@example.test`;
  const rows = await withOrgContext(env.db, orgId, (tx) =>
    tx.insert(appUser).values({ orgId, email, fullName: `Member ${tag}-${seedTail}` }).returning({ id: appUser.id }),
  );
  const row = rows[0];
  if (!row) throw new Error('seedMemberWithRole: INSERT returned no row');
  await withOrgContext(env.db, orgId, (tx) => tx.insert(membership).values({ orgId, userId: row.id, role }));
  return { id: row.id, email };
}

async function countAuditRows(
  orgId: string,
  action: string,
  entityId: string,
): Promise<number> {
  return withOrgContext(env.db, orgId, async (tx) => {
    const result = await tx.execute(
      sql`SELECT COUNT(*)::int AS c FROM audit_log WHERE action = ${action} AND entity_id = ${entityId}::uuid`,
    );
    const rows = (result.rows ?? result) as Array<{ c: number | string }>;
    const count = typeof rows[0]?.c === 'string' ? parseInt(rows[0].c, 10) : (rows[0]?.c ?? 0);
    return count;
  });
}

// ── A: signLessonRecord ───────────────────────────────────────────────────────

describe('A — signLessonRecord', () => {
  it('A1: happy path — INSERTs an immutable signature; content_hash matches recomputed sha256', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess, { gradeLabel: 'S', notes: 'Great work' });

    const result = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'I attest this lesson was conducted as described.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signatures.length).toBe(1);
    const sig = result.signatures[0]!;
    expect(sig.lessonRecordId).toBe(fx.lessonRecordId);
    expect(sig.signerUserId).toBe(env.userAId);
    expect(sig.isTombstone).toBe(false);
    expect(sig.isVoided).toBe(false);
    expect(sig.voidedBySignatureId).toBeNull();

    // Recompute the expected hash directly from the lesson_record row.
    const recordRow = await withOrgContext(env.db, env.orgAId, async (tx) => {
      const r = await tx.execute(sql`
        SELECT id, enrollment_id AS "enrollmentId", lesson_id AS "lessonId",
               instructor_user_id AS "instructorUserId", completed_at AS "completedAt",
               grade_label AS "gradeLabel", notes, status
        FROM lesson_record WHERE id = ${fx.lessonRecordId}::uuid
      `);
      const rows = (r.rows ?? r) as Array<Record<string, unknown>>;
      return rows[0]!;
    });
    const expectedCanonical = canonicalLessonRecordSnapshot({
      id: recordRow.id as string,
      enrollmentId: recordRow.enrollmentId as string,
      lessonId: recordRow.lessonId as string,
      instructorUserId: recordRow.instructorUserId as string,
      completedAt: new Date(recordRow.completedAt as string).toISOString(),
      gradeLabel: (recordRow.gradeLabel as string | null) ?? null,
      notes: (recordRow.notes as string | null) ?? null,
      status: recordRow.status as string,
    });
    const expectedHash = createHash('sha256').update(expectedCanonical).digest('hex');
    expect(sig.contentHash).toBe(expectedHash);
  });

  it('A2: exactly ONE audit_log row training.lesson_record_signed', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const result = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'Attest A2',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sigId = result.signatures[0]!.id;
    const count = await countAuditRows(env.orgAId, 'training.lesson_record_signed', sigId);
    expect(count).toBe(1);
  });

  it('A3: signer_user_id is always session.userId — there is no signerUserId input to override it', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    // SignLessonRecordInput structurally has NO signerUserId field — the only
    // way to attempt an override is by widening the type at the call site.
    const maliciousInput = {
      lessonRecordId: fx.lessonRecordId,
      signerUserId: env.userBId,
      attestationText: 'Attest A3',
    } as unknown as Parameters<typeof signLessonRecordWithDb>[2];
    const result = await signLessonRecordWithDb(env.db, sess, maliciousInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signatures[0]!.signerUserId).toBe(env.userAId);
    expect(result.signatures[0]!.signerUserId).not.toBe(env.userBId);
  });

  it('A4: a second active signature on the same record is refused (already_signed); no second row inserted', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const first = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'First attestation',
    });
    expect(first.ok).toBe(true);

    const second = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'Second attestation attempt',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('already_signed');

    const rows = await getLessonSignaturesWithDb(env.db, sess, { lessonRecordId: fx.lessonRecordId });
    expect(rows.length).toBe(1);
  });

  it('A5: not_found for cross-org lessonRecordId', async () => {
    const sessB = makeSession(env.orgBId, env.userBId);
    const fxB = await makeLessonRecordFixture(sessB);

    const sessA = makeSession(env.orgAId, env.userAId);
    const result = await signLessonRecordWithDb(env.db, sessA, {
      lessonRecordId: fxB.lessonRecordId,
      attestationText: 'Cross-org attempt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('A5b: not_found for a nonexistent UUID', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const result = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: '00000000-0000-0000-0000-000000000000',
      attestationText: 'Nonexistent record',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('A6: no session → UnauthenticatedError (throws before any query)', async () => {
    await expect(
      signLessonRecordWithDb(env.db, null, {
        lessonRecordId: '00000000-0000-0000-0000-000000000000',
        attestationText: 'x',
      }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('A6: student → ForbiddenError (no training:manage) — "random member" cannot sign', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'student');
    await expect(
      signLessonRecordWithDb(env.db, sess, {
        lessonRecordId: '00000000-0000-0000-0000-000000000000',
        attestationText: 'x',
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('A6: renter → ForbiddenError (no training:manage)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(
      signLessonRecordWithDb(env.db, sess, {
        lessonRecordId: '00000000-0000-0000-0000-000000000000',
        attestationText: 'x',
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('A6: mechanic → ForbiddenError (no training:manage)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'mechanic');
    await expect(
      signLessonRecordWithDb(env.db, sess, {
        lessonRecordId: '00000000-0000-0000-0000-000000000000',
        attestationText: 'x',
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('A6: accountant → ForbiddenError (no training:manage)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      signLessonRecordWithDb(env.db, sess, {
        lessonRecordId: '00000000-0000-0000-0000-000000000000',
        attestationText: 'x',
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('A6: dispatcher → ForbiddenError (has training:access but NOT training:manage)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(
      signLessonRecordWithDb(env.db, sess, {
        lessonRecordId: '00000000-0000-0000-0000-000000000000',
        attestationText: 'x',
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('rejects an empty (whitespace-only) attestationText', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    await expect(
      signLessonRecordWithDb(env.db, sess, {
        lessonRecordId: fx.lessonRecordId,
        attestationText: '   ',
      }),
    ).rejects.toThrow(ValidationError);
  });
});

// ── V: voidLessonSignature ────────────────────────────────────────────────────

describe('V — voidLessonSignature', () => {
  it('V1: appends a tombstone; the ORIGINAL row is byte-unchanged; row count grows by exactly 1', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const signed = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'Original attestation',
    });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const originalId = signed.signatures[0]!.id;

    const originalBefore = await withOrgContext(env.db, env.orgAId, async (tx) => {
      const rows = await tx.select().from(lessonSignature).where(sql`${lessonSignature.id} = ${originalId}::uuid`);
      return rows[0]!;
    });

    const voided = await voidLessonSignatureWithDb(env.db, sess, {
      signatureId: originalId,
      reason: 'Signed the wrong record by mistake',
    });
    expect(voided.ok).toBe(true);
    if (!voided.ok) return;
    expect(voided.signatures.length).toBe(2);

    const originalAfter = await withOrgContext(env.db, env.orgAId, async (tx) => {
      const rows = await tx.select().from(lessonSignature).where(sql`${lessonSignature.id} = ${originalId}::uuid`);
      return rows[0]!;
    });
    // ORIGINAL row byte-unchanged (append-only — assert equality of every field).
    expect(originalAfter).toEqual(originalBefore);

    const tombstone = voided.signatures.find((s) => s.id !== originalId)!;
    expect(tombstone.voidedBySignatureId).toBe(originalId);
    expect(tombstone.isTombstone).toBe(true);
    expect(tombstone.attestationText).toBe('Signed the wrong record by mistake');

    const targetAfter = voided.signatures.find((s) => s.id === originalId)!;
    expect(targetAfter.isVoided).toBe(true);
  });

  it('V2: exactly ONE audit_log row training.lesson_signature_voided', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const signed = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'To be voided',
    });
    if (!signed.ok) throw new Error('fixture sign failed');
    const voided = await voidLessonSignatureWithDb(env.db, sess, {
      signatureId: signed.signatures[0]!.id,
      reason: 'V2 void reason',
    });
    expect(voided.ok).toBe(true);
    if (!voided.ok) return;
    const tombstoneId = voided.signatures.find((s) => s.isTombstone)!.id;
    const count = await countAuditRows(env.orgAId, 'training.lesson_signature_voided', tombstoneId);
    expect(count).toBe(1);
  });

  it('V3: after void, isVoided=true and a subsequent signLessonRecord succeeds (re-sign allowed)', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const signed = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'First',
    });
    if (!signed.ok) throw new Error('fixture sign failed');
    await voidLessonSignatureWithDb(env.db, sess, {
      signatureId: signed.signatures[0]!.id,
      reason: 'V3 void',
    });

    const active = await getLessonSignaturesWithDb(env.db, sess, { lessonRecordId: fx.lessonRecordId });
    expect(active.some((s) => !s.isTombstone && !s.isVoided)).toBe(false);

    const resigned = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'Re-signed after void',
    });
    expect(resigned.ok).toBe(true);
    if (!resigned.ok) return;
    expect(resigned.signatures.filter((s) => !s.isTombstone && !s.isVoided).length).toBe(1);
  });

  it('V4a: voiding a tombstone → cannot_void_tombstone', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const signed = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'Attest V4a',
    });
    if (!signed.ok) throw new Error('fixture sign failed');
    const voided = await voidLessonSignatureWithDb(env.db, sess, {
      signatureId: signed.signatures[0]!.id,
      reason: 'V4a first void',
    });
    if (!voided.ok) throw new Error('fixture void failed');
    const tombstoneId = voided.signatures.find((s) => s.isTombstone)!.id;

    const secondVoid = await voidLessonSignatureWithDb(env.db, sess, {
      signatureId: tombstoneId,
      reason: 'attempt to void the tombstone itself',
    });
    expect(secondVoid.ok).toBe(false);
    if (secondVoid.ok) return;
    expect(secondVoid.reason).toBe('cannot_void_tombstone');
  });

  it('V4b: voiding an already-voided signature → already_voided', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const signed = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'Attest V4b',
    });
    if (!signed.ok) throw new Error('fixture sign failed');
    const originalId = signed.signatures[0]!.id;
    const voided = await voidLessonSignatureWithDb(env.db, sess, {
      signatureId: originalId,
      reason: 'V4b first void',
    });
    expect(voided.ok).toBe(true);

    const secondVoid = await voidLessonSignatureWithDb(env.db, sess, {
      signatureId: originalId,
      reason: 'V4b second void attempt',
    });
    expect(secondVoid.ok).toBe(false);
    if (secondVoid.ok) return;
    expect(secondVoid.reason).toBe('already_voided');
  });

  it('V5a: cross-org signatureId → not_found', async () => {
    const sessB = makeSession(env.orgBId, env.userBId);
    const fxB = await makeLessonRecordFixture(sessB);
    const signedB = await signLessonRecordWithDb(env.db, sessB, {
      lessonRecordId: fxB.lessonRecordId,
      attestationText: 'Org B attestation',
    });
    if (!signedB.ok) throw new Error('fixture sign failed');

    const sessA = makeSession(env.orgAId, env.userAId);
    const result = await voidLessonSignatureWithDb(env.db, sessA, {
      signatureId: signedB.signatures[0]!.id,
      reason: 'cross-org void attempt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('V5b: non-manager → ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'student');
    await expect(
      voidLessonSignatureWithDb(env.db, sess, {
        signatureId: '00000000-0000-0000-0000-000000000000',
        reason: 'x',
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('rejects an empty (whitespace-only) reason', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const signed = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'Attest',
    });
    if (!signed.ok) throw new Error('fixture sign failed');
    await expect(
      voidLessonSignatureWithDb(env.db, sess, {
        signatureId: signed.signatures[0]!.id,
        reason: '   ',
      }),
    ).rejects.toThrow(ValidationError);
  });
});

// ── T1: Tenant isolation (adversarial, top priority) ──────────────────────────

describe('T1 — tenant isolation (adversarial)', () => {
  it('org B session cannot sign an org-A lesson record (not_found, no leak)', async () => {
    const sessA = makeSession(env.orgAId, env.userAId);
    const fxA = await makeLessonRecordFixture(sessA);

    const sessB = makeSession(env.orgBId, env.userBId);
    const result = await signLessonRecordWithDb(env.db, sessB, {
      lessonRecordId: fxA.lessonRecordId,
      attestationText: 'Org B attempts to sign Org A record',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('org B session cannot void an org-A signature (not_found, no leak)', async () => {
    const sessA = makeSession(env.orgAId, env.userAId);
    const fxA = await makeLessonRecordFixture(sessA);
    const signedA = await signLessonRecordWithDb(env.db, sessA, {
      lessonRecordId: fxA.lessonRecordId,
      attestationText: 'Org A attestation',
    });
    if (!signedA.ok) throw new Error('fixture sign failed');

    const sessB = makeSession(env.orgBId, env.userBId);
    const result = await voidLessonSignatureWithDb(env.db, sessB, {
      signatureId: signedA.signatures[0]!.id,
      reason: 'Org B attempts to void Org A signature',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('org B session reading org-A lesson-record signatures returns empty (never a leak/500)', async () => {
    const sessA = makeSession(env.orgAId, env.userAId);
    const fxA = await makeLessonRecordFixture(sessA);
    await signLessonRecordWithDb(env.db, sessA, {
      lessonRecordId: fxA.lessonRecordId,
      attestationText: 'Org A attestation',
    });

    const sessB = makeSession(env.orgBId, env.userBId);
    const rows = await getLessonSignaturesWithDb(env.db, sessB, { lessonRecordId: fxA.lessonRecordId });
    expect(rows).toEqual([]);
  });
});

// ── H: tamper-evidence ────────────────────────────────────────────────────────

describe('H — tamper-evidence: content_hash changes when the underlying snapshot differs', () => {
  it('a fresh signature after voiding + re-recording the lesson has a DIFFERENT hash than the first', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess, { gradeLabel: 'S', notes: 'first pass' });

    const firstSign = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'First attestation',
    });
    expect(firstSign.ok).toBe(true);
    if (!firstSign.ok) return;
    const hash1 = firstSign.signatures[0]!.contentHash;

    // Void the underlying lesson_record and re-record with a DIFFERENT snapshot
    // (different grade_label/notes → different canonical snapshot → different hash).
    await voidLessonRecordWithDb(env.db, sess, {
      recordId: fx.lessonRecordId,
      voidedReason: 'correcting the record before re-signing',
    });
    const reRecorded = await recordLessonWithDb(env.db, sess, {
      enrollmentId: fx.enrollmentId,
      lessonId: fx.lessonId,
      instructorUserId: sess.userId,
      gradeLabel: 'U',
      notes: 'second pass — different snapshot',
    });
    expect(reRecorded.ok).toBe(true);
    if (!reRecorded.ok) return;
    const newRecordId = reRecorded.enrollment.records.find((r) => r.status === 'recorded')!.id;
    expect(newRecordId).not.toBe(fx.lessonRecordId);

    const secondSign = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: newRecordId,
      attestationText: 'Second attestation on the new record',
    });
    expect(secondSign.ok).toBe(true);
    if (!secondSign.ok) return;
    const hash2 = secondSign.signatures[0]!.contentHash;

    expect(hash2).not.toBe(hash1);
  });
});

// ── G: getLessonSignatures ────────────────────────────────────────────────────

describe('G — getLessonSignatures', () => {
  it('G1: returns rows newest-first with correct isTombstone/isVoided/signerName/roleAtSigning', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const signed = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'G1 attestation',
    });
    if (!signed.ok) throw new Error('fixture sign failed');
    const voided = await voidLessonSignatureWithDb(env.db, sess, {
      signatureId: signed.signatures[0]!.id,
      reason: 'G1 void reason',
    });
    if (!voided.ok) throw new Error('fixture void failed');

    const rows = await getLessonSignaturesWithDb(env.db, sess, { lessonRecordId: fx.lessonRecordId });
    expect(rows.length).toBe(2);
    // newest-first: the tombstone (inserted after) comes before the original.
    expect(rows[0]!.isTombstone).toBe(true);
    expect(rows[1]!.isTombstone).toBe(false);
    expect(rows[1]!.isVoided).toBe(true);
    expect(rows[0]!.isVoided).toBe(false);
    expect(rows[0]!.signerName.length).toBeGreaterThan(0);
    expect(rows[0]!.roleAtSigning).toBe('owner');
    expect(rows[1]!.roleAtSigning).toBe('owner');
  });

  it('G1: dispatcher (training:access only) can read', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'readable by dispatcher',
    });

    const dispatcherSess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    const rows = await getLessonSignaturesWithDb(env.db, dispatcherSess, { lessonRecordId: fx.lessonRecordId });
    expect(rows.length).toBe(1);
  });

  it('G1: no-cap role (student) → ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'student');
    await expect(
      getLessonSignaturesWithDb(env.db, sess, { lessonRecordId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('cross-org / nonexistent lessonRecordId returns [] (RLS-invisible, no error)', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const rows = await getLessonSignaturesWithDb(env.db, sess, {
      lessonRecordId: '00000000-0000-0000-0000-000000000000',
    });
    expect(rows).toEqual([]);
  });
});

// ── AUTH: signer authorization is CAPABILITY-based, not instructor-ownership ──
// (matches T1's documented precedent [VERIFY-T1-E] in record-lesson.ts: "ANY
// org member; no CFI-of-record enforcement". A member who lacks training:manage
// can NEVER sign (see A6 above, exhaustive per-role truth table); a member who
// HOLDS training:manage may sign ANY visible lesson_record in their org,
// whether or not they are that record's instructor_user_id.)

describe('AUTH — signer authorization: cap holder can sign regardless of instructor identity', () => {
  it('the record\'s own instructor (holding training:manage) can sign it', async () => {
    const sess = makeSession(env.orgAId, env.userAId); // owner === instructor in the fixture
    const fx = await makeLessonRecordFixture(sess);
    const result = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'Instructor signs their own record',
    });
    expect(result.ok).toBe(true);
  });

  it('a DIFFERENT training:manage cap holder (NOT the record\'s instructor) can also sign it', async () => {
    const ownerSess = makeSession(env.orgAId, env.userAId);
    // instructor_user_id on this fixture is env.userAId (the owner) — a
    // separate cfi member, who is NOT the instructor, signs it instead.
    const fx = await makeLessonRecordFixture(ownerSess);
    const cfi = await seedMemberWithRole(env.orgAId, 'cfi', 'auth-noninstructor-cfi');
    const cfiSess = makeSession(env.orgAId, cfi.id, 'cfi');

    const result = await signLessonRecordWithDb(env.db, cfiSess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'Non-instructor CFI signs on behalf of the operator',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // signer_user_id is the CFI who called, never the record's instructor.
    expect(result.signatures[0]!.signerUserId).toBe(cfi.id);
    expect(result.signatures[0]!.signerUserId).not.toBe(fx.studentUserId);
  });

  it('a member with training:access ONLY (dispatcher, not the instructor) still cannot sign — cap gates it, not identity', async () => {
    const ownerSess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(ownerSess);
    const dispatcher = await seedMemberWithRole(env.orgAId, 'dispatcher', 'auth-dispatcher-noncap');
    const dispatcherSess = makeSession(env.orgAId, dispatcher.id, 'dispatcher');

    await expect(
      signLessonRecordWithDb(env.db, dispatcherSess, {
        lessonRecordId: fx.lessonRecordId,
        attestationText: 'attempted sign without training:manage',
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

// ── H2: tamper-evidence determinism ───────────────────────────────────────────

describe('H2 — content_hash determinism: same underlying snapshot ⇒ same hash across signature events', () => {
  it('signing, voiding, and re-signing the SAME (unchanged) lesson_record yields identical content_hash both times', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess, { gradeLabel: 'S', notes: 'unchanged snapshot' });

    const first = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'First signature on unchanged record',
    });
    if (!first.ok) throw new Error('fixture sign failed');
    const hash1 = first.signatures[0]!.contentHash;

    await voidLessonSignatureWithDb(env.db, sess, {
      signatureId: first.signatures[0]!.id,
      reason: 'voiding to re-sign, record itself unchanged',
    });

    const second = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId, // SAME record, SAME content — never mutated (write-once)
      attestationText: 'Second signature on the SAME unchanged record',
    });
    if (!second.ok) throw new Error('re-sign failed');
    const hash2 = second.signatures[0]!.contentHash;

    // Tamper-evidence cuts both ways: unchanged snapshot ⇒ identical digest.
    expect(hash2).toBe(hash1);
  });

  it('two DIFFERENT lesson_records with different content (no void involved) produce DIFFERENT hashes', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fxA = await makeLessonRecordFixture(sess, { gradeLabel: 'S', notes: 'record one content' });
    const fxB = await makeLessonRecordFixture(sess, { gradeLabel: 'U', notes: 'record two, different content' });

    const signedA = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fxA.lessonRecordId,
      attestationText: 'Sign record A',
    });
    const signedB = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fxB.lessonRecordId,
      attestationText: 'Sign record B',
    });
    if (!signedA.ok || !signedB.ok) throw new Error('fixture sign failed');

    expect(signedA.signatures[0]!.contentHash).not.toBe(signedB.signatures[0]!.contentHash);
  });
});

// ── COMPLIANCE: structural — no §61/141 endorsement/currency/stage computation ─
// [VERIFY-P2-A]: the API surface must carry ONLY attestation/tamper-evidence
// fields — never a computed regulatory determination field. This is a
// structural (not textual/grep) guard: any future field named like these
// would itself be the compliance violation this test is designed to catch.

describe('COMPLIANCE — LessonSignatureView carries no regulatory-determination field', () => {
  const FORBIDDEN_KEY_SUBSTRINGS = [
    'endorsement',
    'currency',
    'stagecheck',
    'faacompliant',
    'certified',
    'graduation',
    'part61',
    'part141',
  ];

  it('no key on a real LessonSignatureView row matches a forbidden regulatory-determination substring', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const signed = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'compliance shape check',
    });
    if (!signed.ok) throw new Error('fixture sign failed');

    const keys = Object.keys(signed.signatures[0]!).map((k) => k.toLowerCase());
    for (const forbidden of FORBIDDEN_KEY_SUBSTRINGS) {
      expect(keys.some((k) => k.includes(forbidden))).toBe(false);
    }
    // Sanity: the attestation/tamper-evidence fields DO exist (the test isn't vacuous).
    expect(keys).toContain('contenthash');
    expect(keys).toContain('attestationtext');
    expect(keys).toContain('roleatsigning');
  });
});

// ── S: schema / migration guarantees ──────────────────────────────────────────

describe('S — schema / migration guarantees', () => {
  it('S1: RLS isolation — org A session cannot SELECT org B lesson_signature rows', async () => {
    const sessB = makeSession(env.orgBId, env.userBId);
    const fxB = await makeLessonRecordFixture(sessB);
    await signLessonRecordWithDb(env.db, sessB, {
      lessonRecordId: fxB.lessonRecordId,
      attestationText: 'S1 org B attestation',
    });

    const rowsFromA = await withOrgContext(env.db, env.orgAId, async (tx) => {
      const r = await tx.execute(sql`SELECT id FROM lesson_signature WHERE lesson_record_id = ${fxB.lessonRecordId}::uuid`);
      return (r.rows ?? r) as Array<{ id: string }>;
    });
    expect(rowsFromA.length).toBe(0);

    const rowsFromB = await withOrgContext(env.db, env.orgBId, async (tx) => {
      const r = await tx.execute(sql`SELECT id FROM lesson_signature WHERE lesson_record_id = ${fxB.lessonRecordId}::uuid`);
      return (r.rows ?? r) as Array<{ id: string }>;
    });
    expect(rowsFromB.length).toBe(1);
  });

  it('S2a: UPDATE lesson_signature is denied under aeroops_app (FORCE RLS + no policy + REVOKE)', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const signed = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'S2a attestation',
    });
    if (!signed.ok) throw new Error('fixture sign failed');
    const sigId = signed.signatures[0]!.id;

    await expect(
      env.pglite.query(`UPDATE lesson_signature SET attestation_text = 'tampered' WHERE id = '${sigId}' RETURNING id`),
    ).rejects.toThrow();

    const rows = await withOrgContext(env.db, env.orgAId, async (tx) => {
      const r = await tx.execute(sql`SELECT attestation_text AS "attestationText" FROM lesson_signature WHERE id = ${sigId}::uuid`);
      return (r.rows ?? r) as Array<{ attestationText: string }>;
    });
    expect(rows[0]!.attestationText).toBe('S2a attestation');
  });

  it('S2b: DELETE lesson_signature is denied under aeroops_app (FORCE RLS + no policy + REVOKE)', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const signed = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'S2b attestation',
    });
    if (!signed.ok) throw new Error('fixture sign failed');
    const sigId = signed.signatures[0]!.id;

    await expect(
      env.pglite.query(`DELETE FROM lesson_signature WHERE id = '${sigId}' RETURNING id`),
    ).rejects.toThrow();

    const rows = await withOrgContext(env.db, env.orgAId, async (tx) => {
      const r = await tx.execute(sql`SELECT id FROM lesson_signature WHERE id = ${sigId}::uuid`);
      return (r.rows ?? r) as Array<{ id: string }>;
    });
    expect(rows.length).toBe(1);
  });

  it('S3: CHECK constraints reject empty role_at_signing / attestation_text / content_hash', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);

    await expect(
      withOrgContext(env.db, env.orgAId, (tx) =>
        tx.insert(lessonSignature).values({
          orgId: env.orgAId,
          lessonRecordId: fx.lessonRecordId,
          signerUserId: env.userAId,
          roleAtSigning: '   ',
          attestationText: 'ok',
          contentHash: 'deadbeef',
        }),
      ),
    ).rejects.toThrow();

    await expect(
      withOrgContext(env.db, env.orgAId, (tx) =>
        tx.insert(lessonSignature).values({
          orgId: env.orgAId,
          lessonRecordId: fx.lessonRecordId,
          signerUserId: env.userAId,
          roleAtSigning: 'owner',
          attestationText: '',
          contentHash: 'deadbeef',
        }),
      ),
    ).rejects.toThrow();

    await expect(
      withOrgContext(env.db, env.orgAId, (tx) =>
        tx.insert(lessonSignature).values({
          orgId: env.orgAId,
          lessonRecordId: fx.lessonRecordId,
          signerUserId: env.userAId,
          roleAtSigning: 'owner',
          attestationText: 'ok',
          contentHash: '   ',
        }),
      ),
    ).rejects.toThrow();
  });

  it('S4a: composite FK rejects a cross-org lesson_record_id', async () => {
    const sessB = makeSession(env.orgBId, env.userBId);
    const fxB = await makeLessonRecordFixture(sessB);

    await expect(
      withOrgContext(env.db, env.orgAId, (tx) =>
        tx.insert(lessonSignature).values({
          orgId: env.orgAId,
          lessonRecordId: fxB.lessonRecordId,
          signerUserId: env.userAId,
          roleAtSigning: 'owner',
          attestationText: 'cross-org attempt',
          contentHash: 'deadbeef',
        }),
      ),
    ).rejects.toThrow();
  });

  it('S4b: composite FK rejects a cross-org signer_user_id', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);

    await expect(
      withOrgContext(env.db, env.orgAId, (tx) =>
        tx.insert(lessonSignature).values({
          orgId: env.orgAId,
          lessonRecordId: fx.lessonRecordId,
          signerUserId: env.userBId,
          roleAtSigning: 'owner',
          attestationText: 'cross-org signer attempt',
          contentHash: 'deadbeef',
        }),
      ),
    ).rejects.toThrow();
  });

  it('S4c: composite FK rejects a cross-org voided_by_signature_id (self-ref)', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const signed = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'S4c base attestation',
    });
    if (!signed.ok) throw new Error('fixture sign failed');

    const sessB = makeSession(env.orgBId, env.userBId);
    const fxB = await makeLessonRecordFixture(sessB);
    const signedB = await signLessonRecordWithDb(env.db, sessB, {
      lessonRecordId: fxB.lessonRecordId,
      attestationText: 'S4c org B attestation',
    });
    if (!signedB.ok) throw new Error('fixture sign failed');

    await expect(
      withOrgContext(env.db, env.orgAId, (tx) =>
        tx.insert(lessonSignature).values({
          orgId: env.orgAId,
          lessonRecordId: fx.lessonRecordId,
          signerUserId: env.userAId,
          roleAtSigning: 'owner',
          attestationText: 'cross-org tombstone attempt',
          contentHash: 'deadbeef',
          voidedBySignatureId: signedB.signatures[0]!.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('S5: self-FK resolves — voiding an org-A signature with a same-org tombstone succeeds', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const fx = await makeLessonRecordFixture(sess);
    const signed = await signLessonRecordWithDb(env.db, sess, {
      lessonRecordId: fx.lessonRecordId,
      attestationText: 'S5 attestation',
    });
    if (!signed.ok) throw new Error('fixture sign failed');
    const voided = await voidLessonSignatureWithDb(env.db, sess, {
      signatureId: signed.signatures[0]!.id,
      reason: 'S5 same-org void',
    });
    expect(voided.ok).toBe(true);
  });
});
