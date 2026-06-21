/**
 * portal-api.test.ts — API integration tests for Slice P1.1 (student/renter
 * self-service portal). pglite + *WithDb forms; migrations 0000–0013.
 *
 * THE HEADLINE: SELF-SCOPING. Two students A & B in the SAME org, each with
 * distinct training / reservations / account tags. As A, all 4 reads contain
 * ZERO of B's rows, and vice versa. A portal user NEVER sees another member's
 * data — even same-org.
 *
 * COVERAGE:
 *   P1  — self-scoping: A's 4 reads exclude all of B's rows (and vice versa).
 *   P2  — tenant isolation across orgs (org-B student invisible to org-A).
 *   P3  — cap enforcement (no portal:access → Forbidden; null → Unauthenticated).
 *   P4  — SEPARATION: a student (portal:access, no staff caps) calling a STAFF
 *         read (listEnrollments / listMembers / getMemberDetail) → Forbidden.
 *   P5  — self-via-pilot: reservation booked by someone else but dispatch
 *         pilot = A → role 'pilot'; created_by = A no dispatch → 'booker';
 *         both → 'booker_and_pilot'.
 *   P6  — empties: no enrollments → []; nothing booked → [].
 *   P7  — past / cancelled reservations excluded.
 *   P8  — getMyAccount returns own tags only; no status / hasLogin fields.
 *   P9  — getMyPortalSummary bundles the 3 self-scoped facets.
 *
 * NO writes, NO audit, NO money, NO migration (read-only slice).
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
} from '@aeroops/db';
import { appUser, membership } from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { cancelReservationWithDb } from '../scheduling/cancel-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { createCourseWithDb } from '../training/create-course.js';
import { addCourseLessonWithDb } from '../training/add-course-lesson.js';
import { enrollMemberWithDb } from '../training/enroll-member.js';
import { recordLessonWithDb } from '../training/record-lesson.js';
import { addMemberTagWithDb } from '../people/add-member-tag.js';

// STAFF reads — used in the separation test (must Forbid a portal-only student).
import { listEnrollmentsWithDb } from '../training/list-enrollments.js';
import { listMembersWithDb } from '../people/list-members.js';
import { getMemberDetailWithDb } from '../people/get-member-detail.js';

// The portal reads under test.
import { getMyTrainingWithDb } from '../portal/get-my-training.js';
import { getMyReservationsWithDb } from '../portal/get-my-reservations.js';
import { getMyAccountWithDb } from '../portal/get-my-account.js';
import { getMyPortalSummaryWithDb } from '../portal/get-my-portal-summary.js';

import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// ── Path resolution ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const MIGRATION_SQL = [
  readFileSync(resolve(__dirname, '../../../db/migrations/0000_loud_prodigy.sql'),      'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0001_auth_credential.sql'),   'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0002_scheduling.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0003_booking_policies.sql'),  'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0004_recurrence.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0005_dispatch.sql'),          'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0006_squawks_grounding.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0007_fleet.sql'),             'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0008_people.sql'),            'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0009_dispatch_gate.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0010_civil_twilight.sql'),    'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0011_optimizer_run.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0012_training.sql'),          'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0013_work_orders.sql'),       'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0014_availability.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0015_booking_request.sql'),  'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0016_booking_request_convert.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0017_booking_retention.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0018_dispatch_ticket_correction.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0019_billing_records.sql'),        'utf-8'),
];

// ── Test env ──────────────────────────────────────────────────────────────────

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

// Future dates so booking-policy min-advance checks pass.
const FUT = (d: string, h: number) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00Z`);

interface PortalEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  ownerAId: string;       // seeded org-A owner (staff actor)
  ownerBId: string;       // seeded org-B owner (staff actor)
  studentAId: string;     // org-A student A
  studentBId: string;     // org-A student B (same org as A!)
  studentBOrgBId: string; // an org-B student (cross-org)
}

let env: PortalEnv;

/** Seed an org member (roster row) directly. Returns userId. */
async function seedMember(
  db: PgliteTestClient,
  orgId: string,
  email: string,
  role: AppSession['role'],
): Promise<string> {
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
 * Seed an aircraft + an upcoming reservation whose created_by is `bookerId`
 * (createReservation sets created_by = session.userId, so we pass a session for
 * bookerId with an owner role so the cap passes). Returns ids.
 */
async function seedReservation(
  db: PgliteTestClient,
  orgId: string,
  bookerId: string,
  tag: string,
  start: Date,
  end: Date,
): Promise<{ aircraftId: string; reservationId: string }> {
  const bookerSess = makeSession(orgId, bookerId, 'owner');
  const aircraft = await createResourceWithDb(db, bookerSess, {
    kind: 'aircraft',
    displayName: `Aircraft ${tag}`,
    tailNumber:  `N${tag}`,
  });
  const r = await createReservationWithDb(db, bookerSess, {
    startAt: start, endAt: end, resourceIds: [aircraft.id],
  });
  if (!r.ok) throw new Error(`seed reservation failed: ${r.reason}`);
  return { aircraftId: aircraft.id, reservationId: r.reservation.id };
}

/** Enroll `studentId` into a fresh course (with 2 lessons); optionally record N. */
async function seedEnrollment(
  db: PgliteTestClient,
  orgId: string,
  ownerId: string,
  studentId: string,
  courseTitle: string,
  recordCount = 0,
): Promise<string> {
  const ownerSess = makeSession(orgId, ownerId, 'owner');
  const course = await createCourseWithDb(db, ownerSess, { title: courseTitle });
  if (!course.ok) throw new Error('seed course failed');
  const courseId = course.course.courseId;

  const c1 = await addCourseLessonWithDb(db, ownerSess, { courseId, title: 'Lesson 1' });
  const c2 = await addCourseLessonWithDb(db, ownerSess, { courseId, title: 'Lesson 2' });
  if (!c1.ok || !c2.ok) throw new Error('seed lessons failed');
  const lessonIds = c2.course.lessons.map((l) => l.lessonId);

  const enroll = await enrollMemberWithDb(db, ownerSess, { courseId, studentUserId: studentId });
  if (!enroll.ok) throw new Error('seed enrollment failed');
  const enrollmentId = enroll.enrollment.enrollmentId;

  for (let i = 0; i < recordCount && i < lessonIds.length; i++) {
    const rec = await recordLessonWithDb(db, ownerSess, {
      enrollmentId,
      lessonId: lessonIds[i]!,
      instructorUserId: ownerId,
    });
    if (!rec.ok) throw new Error(`seed record failed: ${rec.reason}`);
  }
  return enrollmentId;
}

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });

  const studentAId     = await seedMember(db, seed.orgAId, 'studentA@alpha.example', 'student');
  const studentBId     = await seedMember(db, seed.orgAId, 'studentB@alpha.example', 'student');
  const studentBOrgBId = await seedMember(db, seed.orgBId, 'studentB@beta.example',  'student');

  env = {
    db, pglite,
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    ownerAId: seed.userAId,
    ownerBId: seed.userBId,
    studentAId,
    studentBId,
    studentBOrgBId,
  };

  // ── Distinct data for A and B (same org) ──────────────────────────────────
  // A: 1 enrollment (1 recorded), 1 reservation A booked, tag "A-Only".
  await seedEnrollment(db, env.orgAId, env.ownerAId, env.studentAId, 'Course-A', 1);
  await seedReservation(db, env.orgAId, env.studentAId, 'AAA111', FUT('2026-11-10', 8), FUT('2026-11-10', 10));
  await addMemberTagWithDb(db, makeSession(env.orgAId, env.ownerAId, 'owner'), {
    userId: env.studentAId, tag: 'A-Only',
  });

  // B: 2 enrollments, 1 reservation B booked, tag "B-Only".
  await seedEnrollment(db, env.orgAId, env.ownerAId, env.studentBId, 'Course-B1', 0);
  await seedEnrollment(db, env.orgAId, env.ownerAId, env.studentBId, 'Course-B2', 2);
  await seedReservation(db, env.orgAId, env.studentBId, 'BBB222', FUT('2026-11-11', 8), FUT('2026-11-11', 10));
  await addMemberTagWithDb(db, makeSession(env.orgAId, env.ownerAId, 'owner'), {
    userId: env.studentBId, tag: 'B-Only',
  });

  // org-B student: 1 enrollment + 1 reservation + tag (cross-org isolation).
  await seedEnrollment(db, env.orgBId, env.ownerBId, env.studentBOrgBId, 'Course-OrgB', 1);
  await seedReservation(db, env.orgBId, env.studentBOrgBId, 'ZZZ999', FUT('2026-11-12', 8), FUT('2026-11-12', 10));
  await addMemberTagWithDb(db, makeSession(env.orgBId, env.ownerBId, 'owner'), {
    userId: env.studentBOrgBId, tag: 'OrgB-Only',
  });
}, 90_000);

// ════════════════════════════════════════════════════════════════════════════
// P1 — SELF-SCOPING (headline): A excludes all of B, and vice versa.
// ════════════════════════════════════════════════════════════════════════════

describe('P1 — self-scoping (same org, two students)', () => {
  it("A's training contains A's course and ZERO of B's", async () => {
    const { db, orgAId, studentAId } = env;
    const sessA = makeSession(orgAId, studentAId, 'student');
    const rows = await getMyTrainingWithDb(db, sessA);
    const titles = rows.map((r) => r.courseTitle);
    expect(titles).toContain('Course-A');
    expect(titles).not.toContain('Course-B1');
    expect(titles).not.toContain('Course-B2');
  });

  it("B's training contains B's courses and ZERO of A's", async () => {
    const { db, orgAId, studentBId } = env;
    const sessB = makeSession(orgAId, studentBId, 'student');
    const rows = await getMyTrainingWithDb(db, sessB);
    const titles = rows.map((r) => r.courseTitle);
    expect(titles).toContain('Course-B1');
    expect(titles).toContain('Course-B2');
    expect(titles).not.toContain('Course-A');
  });

  it("A's reservations exclude B's reservation (by tail), and vice versa", async () => {
    const { db, orgAId, studentAId, studentBId } = env;
    const aRows = await getMyReservationsWithDb(db, makeSession(orgAId, studentAId, 'student'));
    const bRows = await getMyReservationsWithDb(db, makeSession(orgAId, studentBId, 'student'));

    const aTails = aRows.flatMap((r) => r.resourceIds);
    const bTails = bRows.flatMap((r) => r.resourceIds);

    expect(aTails).toContain('NAAA111');
    expect(aTails).not.toContain('NBBB222');
    expect(bTails).toContain('NBBB222');
    expect(bTails).not.toContain('NAAA111');
  });

  it("A's account shows A's tag only; B's shows B's tag only", async () => {
    const { db, orgAId, studentAId, studentBId } = env;
    const a = await getMyAccountWithDb(db, makeSession(orgAId, studentAId, 'student'));
    const b = await getMyAccountWithDb(db, makeSession(orgAId, studentBId, 'student'));
    expect(a?.tags.map((t) => t.tag)).toContain('A-Only');
    expect(a?.tags.map((t) => t.tag)).not.toContain('B-Only');
    expect(b?.tags.map((t) => t.tag)).toContain('B-Only');
    expect(b?.tags.map((t) => t.tag)).not.toContain('A-Only');
    expect(a?.userId).toBe(studentAId);
    expect(b?.userId).toBe(studentBId);
  });

  it("summary for A bundles ONLY A's data (no B leak across any facet)", async () => {
    const { db, orgAId, studentAId } = env;
    const s = await getMyPortalSummaryWithDb(db, makeSession(orgAId, studentAId, 'student'));
    expect(s.account.userId).toBe(studentAId);
    expect(s.account.tags.map((t) => t.tag)).toEqual(['A-Only']);
    expect(s.training.map((t) => t.courseTitle)).toEqual(['Course-A']);
    expect(s.reservations.flatMap((r) => r.resourceIds)).not.toContain('NBBB222');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P2 — tenant isolation across orgs.
// ════════════════════════════════════════════════════════════════════════════

describe('P2 — cross-org tenant isolation', () => {
  it("org-A student never sees the org-B student's course/reservation/tag", async () => {
    const { db, orgAId, studentAId } = env;
    const sessA = makeSession(orgAId, studentAId, 'student');
    const training = await getMyTrainingWithDb(db, sessA);
    const reservations = await getMyReservationsWithDb(db, sessA);
    const account = await getMyAccountWithDb(db, sessA);
    expect(training.map((t) => t.courseTitle)).not.toContain('Course-OrgB');
    expect(reservations.flatMap((r) => r.resourceIds)).not.toContain('NZZZ999');
    expect(account?.tags.map((t) => t.tag)).not.toContain('OrgB-Only');
  });

  it('org-B student reads ONLY their org-B data', async () => {
    const { db, orgBId, studentBOrgBId } = env;
    const sess = makeSession(orgBId, studentBOrgBId, 'student');
    const s = await getMyPortalSummaryWithDb(db, sess);
    expect(s.training.map((t) => t.courseTitle)).toEqual(['Course-OrgB']);
    expect(s.account?.tags.map((t) => t.tag)).toEqual(['OrgB-Only']);
    expect(s.reservations.flatMap((r) => r.resourceIds)).toContain('NZZZ999');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P3 — capability enforcement.
// ════════════════════════════════════════════════════════════════════════════

describe('P3 — cap enforcement', () => {
  it('a role without portal:access (cfi) → ForbiddenError on every read', async () => {
    const { db, orgAId, studentAId } = env;
    const cfi = makeSession(orgAId, studentAId, 'cfi');
    await expect(getMyTrainingWithDb(db, cfi)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getMyReservationsWithDb(db, cfi)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getMyAccountWithDb(db, cfi)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getMyPortalSummaryWithDb(db, cfi)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('mechanic / accountant / dispatcher → ForbiddenError', async () => {
    const { db, orgAId, studentAId } = env;
    for (const role of ['mechanic', 'accountant', 'dispatcher'] as const) {
      await expect(getMyPortalSummaryWithDb(db, makeSession(orgAId, studentAId, role)))
        .rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('null session → UnauthenticatedError', async () => {
    const { db } = env;
    await expect(getMyTrainingWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(getMyReservationsWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(getMyAccountWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(getMyPortalSummaryWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('owner and renter (also hold portal:access) succeed', async () => {
    const { db, orgAId, ownerAId, studentAId } = env;
    await expect(getMyPortalSummaryWithDb(db, makeSession(orgAId, ownerAId, 'owner'))).resolves.toBeDefined();
    await expect(getMyPortalSummaryWithDb(db, makeSession(orgAId, studentAId, 'renter'))).resolves.toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P4 — SEPARATION: portal:access does NOT leak staff access.
// ════════════════════════════════════════════════════════════════════════════

describe('P4 — separation (portal cap ≠ staff access)', () => {
  it('a student calling STAFF reads → ForbiddenError (no transitive leak)', async () => {
    const { db, orgAId, studentAId } = env;
    const student = makeSession(orgAId, studentAId, 'student');
    await expect(listEnrollmentsWithDb(db, student)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listMembersWithDb(db, student)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getMemberDetailWithDb(db, student, { userId: studentAId }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('the SAME student succeeds on the portal reads (cap present)', async () => {
    const { db, orgAId, studentAId } = env;
    const student = makeSession(orgAId, studentAId, 'student');
    await expect(getMyTrainingWithDb(db, student)).resolves.toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P5 — self-via-pilot role derivation.
// ════════════════════════════════════════════════════════════════════════════

describe('P5 — reservation role derivation', () => {
  it("created_by = A, no dispatch → role 'booker'", async () => {
    const { db, orgAId, studentAId } = env;
    const rows = await getMyReservationsWithDb(db, makeSession(orgAId, studentAId, 'student'));
    const own = rows.find((r) => r.resourceIds.includes('NAAA111'));
    expect(own?.role).toBe('booker');
  });

  it("created_by = owner, dispatch pilot = A → role 'pilot'", async () => {
    const { db, orgAId, ownerAId, studentAId } = env;
    // Owner books a reservation; A is the dispatched pilot.
    const { aircraftId, reservationId } = await seedReservation(
      db, orgAId, ownerAId, 'PILOT55', FUT('2026-12-01', 8), FUT('2026-12-01', 10),
    );
    await openDispatchWithDb(db, makeSession(orgAId, ownerAId, 'owner'), {
      reservationId, resourceId: aircraftId, pilotUserId: studentAId,
      hobbsOut: 50.0, tachOut: 50.0,
    });
    const rows = await getMyReservationsWithDb(db, makeSession(orgAId, studentAId, 'student'));
    const flown = rows.find((r) => r.resourceIds.includes('NPILOT55'));
    expect(flown).toBeDefined();
    expect(flown?.role).toBe('pilot');
  });

  it("created_by = A AND dispatch pilot = A → role 'booker_and_pilot'", async () => {
    const { db, orgAId, ownerAId, studentAId } = env;
    const { aircraftId, reservationId } = await seedReservation(
      db, orgAId, studentAId, 'BOTH77', FUT('2026-12-02', 8), FUT('2026-12-02', 10),
    );
    await openDispatchWithDb(db, makeSession(orgAId, ownerAId, 'owner'), {
      reservationId, resourceId: aircraftId, pilotUserId: studentAId,
      hobbsOut: 60.0, tachOut: 60.0,
    });
    const rows = await getMyReservationsWithDb(db, makeSession(orgAId, studentAId, 'student'));
    const both = rows.find((r) => r.resourceIds.includes('NBOTH77'));
    expect(both?.role).toBe('booker_and_pilot');
  });

  it('a voided dispatch does NOT make A a pilot', async () => {
    const { db, orgAId, ownerAId, studentBId } = env;
    // Owner books; dispatch pilot = studentB but VOIDED → B should not see it as pilot,
    // and since created_by is owner, it should not appear for B at all.
    const { aircraftId, reservationId } = await seedReservation(
      db, orgAId, ownerAId, 'VOID88', FUT('2026-12-03', 8), FUT('2026-12-03', 10),
    );
    const open = await openDispatchWithDb(db, makeSession(orgAId, ownerAId, 'owner'), {
      reservationId, resourceId: aircraftId, pilotUserId: studentBId,
      hobbsOut: 70.0, tachOut: 70.0,
    });
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    const { voidDispatchWithDb } = await import('../dispatch/void-dispatch.js');
    await voidDispatchWithDb(db, makeSession(orgAId, ownerAId, 'owner'), {
      ticketId: open.ticket.id, reason: 'mistaken check-out',
    });
    const rows = await getMyReservationsWithDb(db, makeSession(orgAId, studentBId, 'student'));
    expect(rows.find((r) => r.resourceIds.includes('NVOID88'))).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P6 — empties.
// ════════════════════════════════════════════════════════════════════════════

describe('P6 — empties', () => {
  it('a member with no enrollments / no reservations → [] for both', async () => {
    const { db, orgAId } = env;
    const freshId = await seedMember(db, orgAId, `fresh-p6-${Date.now()}@alpha.example`, 'student');
    const sess = makeSession(orgAId, freshId, 'student');
    expect(await getMyTrainingWithDb(db, sess)).toEqual([]);
    expect(await getMyReservationsWithDb(db, sess)).toEqual([]);
    const s = await getMyPortalSummaryWithDb(db, sess);
    expect(s.training).toEqual([]);
    expect(s.reservations).toEqual([]);
    expect(s.account?.tags).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P7 — past / cancelled reservations excluded.
// ════════════════════════════════════════════════════════════════════════════

describe('P7 — past / cancelled excluded', () => {
  it('a cancelled upcoming reservation does not appear', async () => {
    const { db, orgAId } = env;
    const sId = await seedMember(db, orgAId, `cancel-p7-${Date.now()}@alpha.example`, 'student');
    const { reservationId } = await seedReservation(
      db, orgAId, sId, 'CANC11', FUT('2026-12-20', 8), FUT('2026-12-20', 10),
    );
    // Cancel via the booker's own session (schedule:create_reservation gates cancel;
    // student lacks it, so cancel as owner-role session for the same booker user).
    await cancelReservationWithDb(db, makeSession(orgAId, sId, 'owner'), { reservationId });
    const rows = await getMyReservationsWithDb(db, makeSession(orgAId, sId, 'student'));
    expect(rows.find((r) => r.resourceIds.includes('NCANC11'))).toBeUndefined();
  });

  it('a past reservation does not appear (start in the past)', async () => {
    const { db, orgAId } = env;
    const sId = await seedMember(db, orgAId, `past-p7-${Date.now()}@alpha.example`, 'student');
    // Seed a reservation directly in the past (bypass create-path min-advance policy).
    const aircraft = await createResourceWithDb(db, makeSession(orgAId, sId, 'owner'), {
      kind: 'aircraft', displayName: 'Past AC', tailNumber: 'NPAST22',
    });
    await withOrgContext(db, orgAId, async (tx) => {
      const { sql } = await import('drizzle-orm');
      const ins = await tx.execute(sql`
        INSERT INTO reservation (org_id, status, created_by, start_at, end_at)
        VALUES (${orgAId}::uuid, 'booked', ${sId}::uuid,
                '2020-01-01T08:00:00Z'::timestamptz, '2020-01-01T10:00:00Z'::timestamptz)
        RETURNING id
      `);
      const resId = ((ins.rows ?? ins) as Array<{ id: string }>)[0]!.id;
      await tx.execute(sql`
        INSERT INTO reservation_resource (org_id, reservation_id, resource_id, during, status)
        VALUES (${orgAId}::uuid, ${resId}::uuid, ${aircraft.id}::uuid,
                tstzrange('2020-01-01T08:00:00Z'::timestamptz, '2020-01-01T10:00:00Z'::timestamptz, '[)'),
                'booked')
      `);
    });
    const rows = await getMyReservationsWithDb(db, makeSession(orgAId, sId, 'student'));
    expect(rows.find((r) => r.resourceIds.includes('NPAST22'))).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P8 — getMyAccount returns own tags only; no leaked fields.
// ════════════════════════════════════════════════════════════════════════════

describe('P8 — getMyAccount shape', () => {
  it('returns identity + own tags; does NOT expose status / hasLogin / createdBy', async () => {
    const { db, orgAId, studentAId } = env;
    const a = await getMyAccountWithDb(db, makeSession(orgAId, studentAId, 'student'));
    expect(a).not.toBeNull();
    if (!a) return;
    expect(a.userId).toBe(studentAId);
    expect(a.email).toBeTruthy();
    expect(a.role).toBe('student');
    expect(a.joinedAt).toBeInstanceOf(Date);
    expect(Array.isArray(a.tags)).toBe(true);
    // Strict-subset guarantee: these staff-detail fields are absent.
    expect('status' in a).toBe(false);
    expect('hasLogin' in a).toBe(false);
    expect(a.tags.every((t) => 'id' in t && 'tag' in t && !('createdBy' in t))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P9 — progress correctness carried through (content coverage).
// ════════════════════════════════════════════════════════════════════════════

describe('P9 — training progress', () => {
  it("A's Course-A reports 1/2 recorded (50%)", async () => {
    const { db, orgAId, studentAId } = env;
    const rows = await getMyTrainingWithDb(db, makeSession(orgAId, studentAId, 'student'));
    const courseA = rows.find((r) => r.courseTitle === 'Course-A');
    expect(courseA?.completedCount).toBe(1);
    expect(courseA?.totalLessons).toBe(2);
    expect(courseA?.progressRatio.percent).toBe(50);
  });
});
