/**
 * stage-check-enforcement.test.ts — Integration tests for Slice P2-SC1:
 * stage-check enforcement (migration 0038).
 *
 * Applies migrations 0000–0038 (0038 adds course_lesson.is_stage_check,
 * course.enforce_stage_checks, lesson_record.stage_check_passed — ALL
 * additive, INERT defaults).
 *
 * COVERAGE:
 *   CAPS: null session ⇒ Unauthenticated; dispatcher/renter (no
 *     training:manage) ⇒ Forbidden — for both toggles AND recordLesson.
 *   DEFAULT-OFF BYTE-IDENTICAL: enforcement defaults false — recording any
 *     lesson past an unpassed stage check succeeds exactly as before.
 *   GATE (through the REAL recordLesson command): enforcement on ⇒
 *     stage_check_required with the EARLIEST blocking lesson id; the stage
 *     check itself is always recordable; a non-voided pass unlocks; a FAIL
 *     record does not unlock; NULL-outcome record does not unlock.
 *   VOID-RESURRECTS-BLOCK: voiding the passing record re-blocks.
 *   VALIDATION: stageCheckPassed on a non-stage-check lesson ⇒
 *     ValidationError (enforcement on OR off).
 *   ADMIN: addCourseLesson isStageCheck flag; both toggles update the
 *     CourseDetail + write ONE audit row; unknown ids ⇒ not_found.
 *   T-ISO: an org-B session cannot toggle an org-A course/lesson
 *     (not_found; nothing persisted).
 *
 * COMPLIANCE: the gate enforces the OPERATOR's configured course structure
 * ONLY — NOT a Part-61/141 stage check of record or any FAA determination;
 * stage_check_passed is an instructor-STATED outcome, never computed.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  appUser,
  membership,
  auditLog,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createCourseWithDb } from '../training/create-course.js';
import { addCourseLessonWithDb } from '../training/add-course-lesson.js';
import { enrollMemberWithDb } from '../training/enroll-member.js';
import { recordLessonWithDb } from '../training/record-lesson.js';
import { voidLessonRecordWithDb } from '../training/void-lesson-record.js';
import { getCourseDetailWithDb } from '../training/get-course-detail.js';
import { setLessonStageCheckWithDb } from '../training/set-lesson-stage-check.js';
import { setCourseStageCheckEnforcementWithDb } from '../training/set-course-stage-check-enforcement.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// ── Path resolution ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function migrationSql(name: string): string {
  return readFileSync(resolve(__dirname, `../../../db/migrations/${name}`), 'utf-8');
}

const MIGRATION_SQL = [
  migrationSql('0000_loud_prodigy.sql'),
  migrationSql('0001_auth_credential.sql'),
  migrationSql('0002_scheduling.sql'),
  migrationSql('0003_booking_policies.sql'),
  migrationSql('0004_recurrence.sql'),
  migrationSql('0005_dispatch.sql'),
  migrationSql('0006_squawks_grounding.sql'),
  migrationSql('0007_fleet.sql'),
  migrationSql('0008_people.sql'),
  migrationSql('0009_dispatch_gate.sql'),
  migrationSql('0010_civil_twilight.sql'),
  migrationSql('0011_optimizer_run.sql'),
  migrationSql('0012_training.sql'),
  migrationSql('0013_work_orders.sql'),
  migrationSql('0014_availability.sql'),
  migrationSql('0015_booking_request.sql'),
  migrationSql('0016_booking_request_convert.sql'),
  migrationSql('0017_booking_retention.sql'),
  migrationSql('0018_dispatch_ticket_correction.sql'),
  migrationSql('0019_billing_records.sql'),
  migrationSql('0020_demo_reset_state.sql'),
  migrationSql('0021_qbo_integration.sql'),
  migrationSql('0022_billing_ledger.sql'),
  migrationSql('0023_stripe_foundation.sql'),
  migrationSql('0024_payment_methods_autopay.sql'),
  migrationSql('0025_recurring_dues.sql'),
  migrationSql('0026_notifications.sql'),
  migrationSql('0027_data_import.sql'),
  migrationSql('0028_calendar_feed.sql'),
  migrationSql('0029_maintenance_due.sql'),
  migrationSql('0030_documents.sql'),
  migrationSql('0031_pos_sales.sql'),
  migrationSql('0032_lesson_signature.sql'),
  migrationSql('0033_mobile_session.sql'),
  migrationSql('0034_block_time.sql'),
  migrationSql('0035_study_grant.sql'),
  migrationSql('0036_member_message.sql'),
  migrationSql('0037_logbook_annotation.sql'),
  migrationSql('0038_stage_check_enforcement.sql'),
];

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
let memberCounter = 0;

/** Seed an org member with a membership. Returns userId. */
async function seedOrgMember(
  db: PgliteTestClient,
  orgId: string,
  role: AppSession['role'] = 'student',
): Promise<string> {
  memberCounter += 1;
  const email = `sc-member-${memberCounter}@test.com`;
  return withOrgContext(db, orgId, async (tx) => {
    const [usr] = await tx
      .insert(appUser)
      .values({ orgId, email, fullName: `User ${email}`, status: 'active' })
      .returning();
    await tx.insert(membership).values({ orgId, userId: usr!.id, role });
    return usr!.id;
  });
}

/**
 * Seed a 4-lesson course in org A:
 *   [0] Intro (plain) → [1] Stage check A → [2] Maneuvers (plain) →
 *   [3] Stage check B
 * plus an active enrollment for a fresh student.
 */
async function seedCourseWithStageChecks(opts?: { enforce?: boolean }): Promise<{
  courseId: string;
  lessonIds: string[]; // by position
  enrollmentId: string;
  studentId: string;
  ownerSess: AppSession;
}> {
  const { db, orgAId, userAId } = env;
  const ownerSess = makeSession(orgAId, userAId, 'owner');

  const created = await createCourseWithDb(db, ownerSess, {
    title: `Stage-check course ${Date.now()}-${memberCounter}`,
  });
  if (!created.ok) throw new Error('seed createCourse failed');
  const courseId = created.course.courseId;

  const lessonSpecs = [
    { title: 'Intro', isStageCheck: false },
    { title: 'Stage check A', isStageCheck: true },
    { title: 'Maneuvers', isStageCheck: false },
    { title: 'Stage check B', isStageCheck: true },
  ];
  let lessons: string[] = [];
  for (const spec of lessonSpecs) {
    const added = await addCourseLessonWithDb(db, ownerSess, {
      courseId,
      title: spec.title,
      isStageCheck: spec.isStageCheck || undefined,
    });
    if (!added.ok) throw new Error('seed addCourseLesson failed');
    lessons = added.course.lessons
      .sort((a, b) => a.position - b.position)
      .map((l) => l.lessonId);
  }

  if (opts?.enforce) {
    const set = await setCourseStageCheckEnforcementWithDb(db, ownerSess, {
      courseId,
      enforceStageChecks: true,
    });
    if (!set.ok) throw new Error('seed setCourseStageCheckEnforcement failed');
  }

  const studentId = await seedOrgMember(db, orgAId, 'student');
  const enrolled = await enrollMemberWithDb(db, ownerSess, { courseId, studentUserId: studentId });
  if (!enrolled.ok) throw new Error(`seed enroll failed: ${enrolled.reason}`);

  return {
    courseId,
    lessonIds: lessons,
    enrollmentId: enrolled.enrollment.enrollmentId,
    studentId,
    ownerSess,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });
  env = {
    db,
    pglite,
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };
}, 120_000);

// ════════════════════════════════════════════════════════════════════════════════
// CAPS
// ════════════════════════════════════════════════════════════════════════════════

describe('CAPS', () => {
  const ZERO = '00000000-0000-0000-0000-000000000000';

  it('null session ⇒ Unauthenticated (both toggles)', async () => {
    await expect(
      setLessonStageCheckWithDb(env.db, null, { lessonId: ZERO, isStageCheck: true }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(
      setCourseStageCheckEnforcementWithDb(env.db, null, { courseId: ZERO, enforceStageChecks: true }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('dispatcher (training:access but NO training:manage) ⇒ Forbidden (both toggles)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(
      setLessonStageCheckWithDb(env.db, sess, { lessonId: ZERO, isStageCheck: true }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      setCourseStageCheckEnforcementWithDb(env.db, sess, { courseId: ZERO, enforceStageChecks: true }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('renter (no training caps) ⇒ Forbidden on recordLesson with stageCheckPassed', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(
      recordLessonWithDb(env.db, sess, {
        enrollmentId: ZERO,
        lessonId: ZERO,
        instructorUserId: ZERO,
        stageCheckPassed: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// DEFAULT OFF — byte-identical behavior
// ════════════════════════════════════════════════════════════════════════════════

describe('DEFAULT OFF: enforcement is INERT until the operator opts in', () => {
  it('recording a lesson PAST an unpassed stage check succeeds when enforcement is off', async () => {
    const { db } = env;
    const { courseId, lessonIds, enrollmentId, ownerSess } = await seedCourseWithStageChecks();

    // Course default: enforce_stage_checks = false.
    const detail = await getCourseDetailWithDb(db, ownerSess, { courseId });
    expect(detail.ok).toBe(true);
    if (detail.ok) expect(detail.course.enforceStageChecks).toBe(false);

    // Lesson [2] is after the unpassed stage check [1] — still records fine.
    const result = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[2]!,
      instructorUserId: env.userAId,
    });
    expect(result.ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// GATE through the real recordLesson command
// ════════════════════════════════════════════════════════════════════════════════

describe('GATE: enforcement on blocks/unblocks through the real command', () => {
  it('blocks a later lesson with the EARLIEST unpassed stage check; the stage check itself records; a pass unlocks', async () => {
    const { db } = env;
    const { lessonIds, enrollmentId, ownerSess } = await seedCourseWithStageChecks({ enforce: true });

    // Lesson [2] is after unpassed stage check [1] → refused, naming [1].
    const blocked = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[2]!,
      instructorUserId: env.userAId,
    });
    expect(blocked).toEqual({
      ok: false,
      reason: 'stage_check_required',
      blockingLessonId: lessonIds[1],
    });

    // Stage check B [3] is ALSO blocked by the EARLIEST unpassed one [1].
    const blockedB = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[3]!,
      instructorUserId: env.userAId,
    });
    expect(blockedB).toEqual({
      ok: false,
      reason: 'stage_check_required',
      blockingLessonId: lessonIds[1],
    });

    // Lesson [0] (before the stage check) is never gated.
    const before = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[0]!,
      instructorUserId: env.userAId,
    });
    expect(before.ok).toBe(true);

    // Recording the stage-check lesson ITSELF is always allowed — pass it.
    const pass = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[1]!,
      instructorUserId: env.userAId,
      stageCheckPassed: true,
    });
    expect(pass.ok).toBe(true);
    if (pass.ok) {
      const rec = pass.enrollment.records.find((r) => r.lessonId === lessonIds[1]);
      expect(rec?.stageCheckPassed).toBe(true);
    }

    // Now lesson [2] records fine…
    const unlocked = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[2]!,
      instructorUserId: env.userAId,
    });
    expect(unlocked.ok).toBe(true);

    // …but stage check B [3] itself is recordable too (it is the next gate).
    const scB = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[3]!,
      instructorUserId: env.userAId,
      stageCheckPassed: false,
    });
    expect(scB.ok).toBe(true);
    if (scB.ok) {
      const rec = scB.enrollment.records.find((r) => r.lessonId === lessonIds[3]);
      expect(rec?.stageCheckPassed).toBe(false);
    }
  });

  it('a FAILED stage-check record does NOT unlock later lessons', async () => {
    const { db } = env;
    const { lessonIds, enrollmentId, ownerSess } = await seedCourseWithStageChecks({ enforce: true });

    const fail = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[1]!,
      instructorUserId: env.userAId,
      stageCheckPassed: false,
    });
    expect(fail.ok).toBe(true);

    const stillBlocked = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[2]!,
      instructorUserId: env.userAId,
    });
    expect(stillBlocked).toEqual({
      ok: false,
      reason: 'stage_check_required',
      blockingLessonId: lessonIds[1],
    });
  });

  it('a NULL-outcome record on the stage check does NOT unlock later lessons', async () => {
    const { db } = env;
    const { lessonIds, enrollmentId, ownerSess } = await seedCourseWithStageChecks({ enforce: true });

    const plain = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[1]!,
      instructorUserId: env.userAId,
      // stageCheckPassed omitted → NULL
    });
    expect(plain.ok).toBe(true);

    const stillBlocked = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[2]!,
      instructorUserId: env.userAId,
    });
    expect(stillBlocked).toEqual({
      ok: false,
      reason: 'stage_check_required',
      blockingLessonId: lessonIds[1],
    });
  });

  it('VOID-RESURRECTS-BLOCK: voiding the passing record re-blocks later lessons', async () => {
    const { db } = env;
    const { lessonIds, enrollmentId, ownerSess } = await seedCourseWithStageChecks({ enforce: true });

    const pass = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[1]!,
      instructorUserId: env.userAId,
      stageCheckPassed: true,
    });
    expect(pass.ok).toBe(true);
    if (!pass.ok) return;
    const passRecordId = pass.enrollment.records.find((r) => r.lessonId === lessonIds[1])!.id;

    // Unlocked while the pass stands.
    const unlocked = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[2]!,
      instructorUserId: env.userAId,
    });
    expect(unlocked.ok).toBe(true);

    // Void the passing record → the block resurrects for NEW records.
    const voided = await voidLessonRecordWithDb(db, ownerSess, {
      recordId: passRecordId,
      voidedReason: 'entered in error',
    });
    expect(voided.ok).toBe(true);

    const reBlocked = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[2]!,
      instructorUserId: env.userAId,
    });
    expect(reBlocked).toEqual({
      ok: false,
      reason: 'stage_check_required',
      blockingLessonId: lessonIds[1],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════════════════════

describe('VALIDATION: stageCheckPassed only valid on stage-check lessons', () => {
  it('stageCheckPassed on a NON-stage-check lesson ⇒ ValidationError (enforcement off)', async () => {
    const { db } = env;
    const { lessonIds, enrollmentId, ownerSess } = await seedCourseWithStageChecks();

    await expect(
      recordLessonWithDb(db, ownerSess, {
        enrollmentId,
        lessonId: lessonIds[0]!, // plain lesson
        instructorUserId: env.userAId,
        stageCheckPassed: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('stageCheckPassed on a NON-stage-check lesson ⇒ ValidationError (enforcement on)', async () => {
    const { db } = env;
    const { lessonIds, enrollmentId, ownerSess } = await seedCourseWithStageChecks({ enforce: true });

    await expect(
      recordLessonWithDb(db, ownerSess, {
        enrollmentId,
        lessonId: lessonIds[0]!,
        instructorUserId: env.userAId,
        stageCheckPassed: false,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('non-boolean stageCheckPassed ⇒ ValidationError', async () => {
    const { db } = env;
    const { lessonIds, enrollmentId, ownerSess } = await seedCourseWithStageChecks();

    await expect(
      recordLessonWithDb(db, ownerSess, {
        enrollmentId,
        lessonId: lessonIds[1]!,
        instructorUserId: env.userAId,
        stageCheckPassed: 'yes' as unknown as boolean,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// ADMIN toggles — flags + audit
// ════════════════════════════════════════════════════════════════════════════════

describe('ADMIN: toggles update the CourseDetail and are audited', () => {
  it('addCourseLesson isStageCheck flag lands on the CourseDetail', async () => {
    const { lessonIds, courseId, ownerSess } = await seedCourseWithStageChecks();
    const detail = await getCourseDetailWithDb(env.db, ownerSess, { courseId });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    const byId = new Map(detail.course.lessons.map((l) => [l.lessonId, l.isStageCheck]));
    expect(byId.get(lessonIds[0]!)).toBe(false);
    expect(byId.get(lessonIds[1]!)).toBe(true);
    expect(byId.get(lessonIds[2]!)).toBe(false);
    expect(byId.get(lessonIds[3]!)).toBe(true);
  });

  it('setLessonStageCheck toggles the flag and writes ONE audit row', async () => {
    const { db, orgAId } = env;
    const { lessonIds, ownerSess } = await seedCourseWithStageChecks();

    const before = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(
          eq(auditLog.action, 'training.lesson_stage_check_set'),
          eq(auditLog.entityId, lessonIds[0]!),
        ))
        .execute(),
    );

    const result = await setLessonStageCheckWithDb(db, ownerSess, {
      lessonId: lessonIds[0]!,
      isStageCheck: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lesson = result.course.lessons.find((l) => l.lessonId === lessonIds[0]);
    expect(lesson?.isStageCheck).toBe(true);

    const after = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(
          eq(auditLog.action, 'training.lesson_stage_check_set'),
          eq(auditLog.entityId, lessonIds[0]!),
        ))
        .execute(),
    );
    expect(after.length - before.length).toBe(1);
    const meta = after[after.length - 1]!.metadata as Record<string, unknown>;
    expect(meta['isStageCheck']).toBe(true);
  });

  it('setCourseStageCheckEnforcement toggles the flag and writes ONE audit row', async () => {
    const { db, orgAId } = env;
    const { courseId, ownerSess } = await seedCourseWithStageChecks();

    const result = await setCourseStageCheckEnforcementWithDb(db, ownerSess, {
      courseId,
      enforceStageChecks: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.course.enforceStageChecks).toBe(true);

    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(
          eq(auditLog.action, 'training.course_stage_check_enforcement_set'),
          eq(auditLog.entityId, courseId),
        ))
        .execute(),
    );
    expect(rows).toHaveLength(1);
    expect((rows[0]!.metadata as Record<string, unknown>)['enforceStageChecks']).toBe(true);

    // Toggle back off.
    const off = await setCourseStageCheckEnforcementWithDb(db, ownerSess, {
      courseId,
      enforceStageChecks: false,
    });
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.course.enforceStageChecks).toBe(false);
  });

  it('unknown ids ⇒ not_found', async () => {
    const ownerSess = makeSession(env.orgAId, env.userAId, 'owner');
    const ZERO = '00000000-0000-0000-0000-000000000000';
    expect(
      await setLessonStageCheckWithDb(env.db, ownerSess, { lessonId: ZERO, isStageCheck: true }),
    ).toEqual({ ok: false, reason: 'not_found' });
    expect(
      await setCourseStageCheckEnforcementWithDb(env.db, ownerSess, { courseId: ZERO, enforceStageChecks: true }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });

  it('non-UUID ids ⇒ ValidationError', async () => {
    const ownerSess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      setLessonStageCheckWithDb(env.db, ownerSess, { lessonId: 'nope', isStageCheck: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      setCourseStageCheckEnforcementWithDb(env.db, ownerSess, { courseId: 'nope', enforceStageChecks: true }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T-ISO — tenant isolation
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO — tenant isolation', () => {
  it('an org-B owner cannot toggle an org-A lesson or course (not_found; nothing persisted)', async () => {
    const { db, orgBId, userBId } = env;
    const { courseId, lessonIds, ownerSess } = await seedCourseWithStageChecks();

    const sessB = makeSession(orgBId, userBId, 'owner');

    expect(
      await setLessonStageCheckWithDb(db, sessB, { lessonId: lessonIds[0]!, isStageCheck: true }),
    ).toEqual({ ok: false, reason: 'not_found' });
    expect(
      await setCourseStageCheckEnforcementWithDb(db, sessB, { courseId, enforceStageChecks: true }),
    ).toEqual({ ok: false, reason: 'not_found' });

    // Nothing changed in org A.
    const detail = await getCourseDetailWithDb(db, ownerSess, { courseId });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.course.enforceStageChecks).toBe(false);
    expect(detail.course.lessons.find((l) => l.lessonId === lessonIds[0])?.isStageCheck).toBe(false);
  });

  it('an org-B owner cannot record (with stageCheckPassed) into an org-A enrollment', async () => {
    const { db, orgBId, userBId } = env;
    const { lessonIds, enrollmentId } = await seedCourseWithStageChecks({ enforce: true });

    const sessB = makeSession(orgBId, userBId, 'owner');
    const result = await recordLessonWithDb(db, sessB, {
      enrollmentId,
      lessonId: lessonIds[1]!,
      instructorUserId: userBId,
      stageCheckPassed: true,
    });
    // Cross-org enrollment is invisible → not_found (anti-enumeration).
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});
