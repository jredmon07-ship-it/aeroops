/**
 * get-instructor-utilization.test.ts — Integration tests for getInstructorUtilization.
 *
 * Applies migrations 0000–0040 via the shared loader.
 *
 * COVERAGE:
 *   CAPS: reporting:access required. accountant (reporting:access-only) passes;
 *     mechanic / renter (no reporting:access) ⇒ Forbidden; null ⇒ Unauthenticated.
 *   HAPPY: one row per membership.role='cfi' member. Per CFI, over the range:
 *     - flightCount / flightHours from CLOSED dispatch as pilot (1dp rounding).
 *     - lessonsGiven from 'recorded' lesson_record as instructor.
 *     - distinctStudents deduplicates across those lessons' enrollments.
 *   ZERO-ACTIVITY: a CFI with no flights/lessons appears with 0/0/0/0.
 *   NON-CFI EXCLUDED: an owner who flew + taught is NOT a row (role != 'cfi').
 *   ORDER: hours DESC.
 *   T-ISO: org-A session never sees an org-B CFI; org B sees only its own.
 *   VALIDATION: a bad range key ⇒ ValidationError.
 */

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
  loadMigrationSql,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { getInstructorUtilizationWithDb } from '../reporting/get-instructor-utilization.js';
import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { createCourseWithDb } from '../training/create-course.js';
import { addCourseLessonWithDb } from '../training/add-course-lesson.js';
import { enrollMemberWithDb } from '../training/enroll-member.js';
import { recordLessonWithDb } from '../training/record-lesson.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';
import type { MembershipRole } from '@aeroops/core';

const MIGRATION_SQL = loadMigrationSql('0042');

// ── Shared env ────────────────────────────────────────────────────────────────

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
let memberSuffix = 0;

/** Insert a fresh app_user + membership (given role). Returns the userId. */
async function seedMember(
  db: PgliteTestClient,
  orgId: string,
  tag: string,
  role: MembershipRole,
): Promise<string> {
  memberSuffix += 1;
  const label = `${tag}${memberSuffix}`;
  const rows = await withOrgContext(db, orgId, (tx) =>
    tx
      .insert(appUser)
      .values({ orgId, email: `${label.toLowerCase()}@example.test`, fullName: `Member ${label}` })
      .returning({ id: appUser.id }),
  );
  const row = rows[0];
  if (!row) throw new Error('seedMember: INSERT returned no row');
  await withOrgContext(db, orgId, (tx) =>
    tx.insert(membership).values({ orgId, userId: row.id, role }),
  );
  return row.id;
}

let flightSlot = 0;

/** Create an aircraft + open + close one dispatch flown by `pilotUserId`. */
async function seedClosedFlight(
  db: PgliteTestClient,
  orgId: string,
  ownerUserId: string,
  pilotUserId: string,
  hobbsOut: number,
  hobbsIn: number,
): Promise<void> {
  flightSlot += 1;
  // Reservation slot in a proven-safe near future (matches reporting-r1 tests);
  // the dispatch's closed_at is set to now() at close time, so the CLOSED flight
  // lands inside the rolling 30d report window regardless of this slot date.
  const base = new Date(`2027-06-01T00:00:00Z`).getTime() + flightSlot * 3 * 60 * 60 * 1000;
  const sess = makeSession(orgId, ownerUserId, 'owner');
  const ac = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `Aircraft ${100 + flightSlot}`,
    tailNumber: `N${100 + flightSlot}`,
  });
  const r = await createReservationWithDb(db, sess, {
    startAt: new Date(base),
    endAt: new Date(base + 2 * 60 * 60 * 1000),
    resourceIds: [ac.id],
  });
  if (!r.ok) throw new Error(`seed reservation failed: ${r.reason}`);
  const o = await openDispatchWithDb(db, sess, {
    reservationId: r.reservation.id,
    resourceId: ac.id,
    pilotUserId,
    hobbsOut,
    tachOut: hobbsOut,
  });
  if (!o.ok) throw new Error('seed open failed');
  const c = await closeDispatchWithDb(db, sess, { ticketId: o.ticket.id, hobbsIn, tachIn: hobbsIn });
  if (!c.ok) throw new Error('seed close failed');
}

/** Record ONE lesson given by `instructorUserId` to `studentUserId` in a new course. */
async function seedLesson(
  db: PgliteTestClient,
  orgId: string,
  ownerUserId: string,
  instructorUserId: string,
  studentUserId: string,
  courseTitle: string,
): Promise<void> {
  const sess = makeSession(orgId, ownerUserId, 'owner');
  const course = await createCourseWithDb(db, sess, { title: courseTitle });
  if (!course.ok) throw new Error('course failed');
  const lesson = await addCourseLessonWithDb(db, sess, {
    courseId: course.course.courseId,
    title: `${courseTitle} L1`,
  });
  if (!lesson.ok) throw new Error('lesson failed');
  const lessonId = lesson.course.lessons[0]!.lessonId;
  const enr = await enrollMemberWithDb(db, sess, {
    courseId: course.course.courseId,
    studentUserId,
  });
  if (!enr.ok) throw new Error('enroll failed');
  const rec = await recordLessonWithDb(db, sess, {
    enrollmentId: enr.enrollment.enrollmentId,
    lessonId,
    instructorUserId,
  });
  if (!rec.ok) throw new Error('recordLesson failed');
}

// Seeded principals.
let cfiA1 = '';
let cfiA2 = '';
let studentA1 = '';
let studentA2 = '';
let cfiB1 = '';
let studentB1 = '';

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

  // ── Org A ──
  cfiA1 = await seedMember(db, env.orgAId, 'CfiA', 'cfi');
  cfiA2 = await seedMember(db, env.orgAId, 'CfiAZero', 'cfi');
  studentA1 = await seedMember(db, env.orgAId, 'StuA', 'student');
  studentA2 = await seedMember(db, env.orgAId, 'StuA', 'student');

  // cfiA1: 2 closed flights (1.5h + 2.0h = 3.5h) + 3 lessons across 2 students.
  await seedClosedFlight(db, env.orgAId, env.userAId, cfiA1, 10.0, 11.5);
  await seedClosedFlight(db, env.orgAId, env.userAId, cfiA1, 20.0, 22.0);
  await seedLesson(db, env.orgAId, env.userAId, cfiA1, studentA1, 'A-Course-1');
  await seedLesson(db, env.orgAId, env.userAId, cfiA1, studentA1, 'A-Course-2'); // same student again
  await seedLesson(db, env.orgAId, env.userAId, cfiA1, studentA2, 'A-Course-3');

  // The org-A OWNER also flies + teaches — must NOT appear (role != 'cfi').
  await seedClosedFlight(db, env.orgAId, env.userAId, env.userAId, 5.0, 6.0);
  await seedLesson(db, env.orgAId, env.userAId, env.userAId, studentA1, 'A-Owner-Course');

  // ── Org B (isolation fixture) ──
  cfiB1 = await seedMember(db, env.orgBId, 'CfiB', 'cfi');
  studentB1 = await seedMember(db, env.orgBId, 'StuB', 'student');
  await seedClosedFlight(db, env.orgBId, env.userBId, cfiB1, 30.0, 33.0);
  await seedLesson(db, env.orgBId, env.userBId, cfiB1, studentB1, 'B-Course-1');
}, 180_000);

// ════════════════════════════════════════════════════════════════════════════════
// CAPS
// ════════════════════════════════════════════════════════════════════════════════

describe('caps', () => {
  it('null session ⇒ Unauthenticated', async () => {
    await expect(
      getInstructorUtilizationWithDb(env.db, null, { range: '30d' }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('accountant (reporting:access) ⇒ allowed', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const rows = await getInstructorUtilizationWithDb(env.db, sess, { range: '30d' });
    expect(Array.isArray(rows)).toBe(true);
  });

  it('mechanic (no reporting:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'mechanic');
    await expect(
      getInstructorUtilizationWithDb(env.db, sess, { range: '30d' }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('renter (no reporting:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(
      getInstructorUtilizationWithDb(env.db, sess, { range: '30d' }),
    ).rejects.toThrow(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// HAPPY PATH
// ════════════════════════════════════════════════════════════════════════════════

describe('getInstructorUtilization — org A', () => {
  it('returns exactly the two CFIs (owner excluded), hours DESC', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const rows = await getInstructorUtilizationWithDb(env.db, sess, { range: '30d' });

    expect(rows.map((r) => r.instructorUserId).sort()).toEqual([cfiA1, cfiA2].sort());
    // busiest first
    expect(rows[0]!.instructorUserId).toBe(cfiA1);
  });

  it('cfiA1: flightCount=2, flightHours=3.5, lessonsGiven=3, distinctStudents=2', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const rows = await getInstructorUtilizationWithDb(env.db, sess, { range: '30d' });
    const row = rows.find((r) => r.instructorUserId === cfiA1);
    expect(row).toBeDefined();
    expect(row!.flightCount).toBe(2);
    expect(row!.flightHours).toBe(3.5);
    expect(row!.lessonsGiven).toBe(3);
    expect(row!.distinctStudents).toBe(2);
  });

  it('cfiA2 (zero activity) appears with 0/0/0/0', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const rows = await getInstructorUtilizationWithDb(env.db, sess, { range: '30d' });
    const row = rows.find((r) => r.instructorUserId === cfiA2);
    expect(row).toBeDefined();
    expect(row!.flightCount).toBe(0);
    expect(row!.flightHours).toBe(0);
    expect(row!.lessonsGiven).toBe(0);
    expect(row!.distinctStudents).toBe(0);
  });

  it('the org-A owner (flew + taught) is NOT a row', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const rows = await getInstructorUtilizationWithDb(env.db, sess, { range: '30d' });
    expect(rows.some((r) => r.instructorUserId === env.userAId)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// TENANT ISOLATION
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO', () => {
  it('org-A session never sees the org-B CFI', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const rows = await getInstructorUtilizationWithDb(env.db, sess, { range: '30d' });
    expect(rows.some((r) => r.instructorUserId === cfiB1)).toBe(false);
  });

  it('org-B session sees only its own CFI with its own totals', async () => {
    const sess = makeSession(env.orgBId, env.userBId, 'owner');
    const rows = await getInstructorUtilizationWithDb(env.db, sess, { range: '30d' });
    expect(rows.map((r) => r.instructorUserId)).toEqual([cfiB1]);
    const row = rows[0]!;
    expect(row.flightCount).toBe(1);
    expect(row.flightHours).toBe(3.0);
    expect(row.lessonsGiven).toBe(1);
    expect(row.distinctStudents).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════════════════════

describe('validation', () => {
  it('bad range key ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      getInstructorUtilizationWithDb(env.db, sess, { range: 'yesterday' }),
    ).rejects.toThrow(ValidationError);
  });
});
