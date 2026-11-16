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
 *   P10 — an instructor on a reservation is labelled by name, never by id.
 *   P11 — bookings made FOR the member (member_user_id, migration 0051): staff
 *         book for A → A lists it as 'for_you'; never B's; never across orgs;
 *         a later dispatch of A as its pilot reads 'pilot'.
 *
 * NO writes, NO audit, NO money, NO migration (read-only slice).
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  loadMigrationSql,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// All up migrations through 0038 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0051');

// ── Test env ──────────────────────────────────────────────────────────────────

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

// Future dates so booking-policy min-advance checks pass and the portal's
// upcoming-reservation reads include them. Relative to the day the suite runs:
// fixed calendar dates here went stale (the 2026-11-10..12 ones aged into the
// past and these tests failed from 2026-11-13).
const FUT = (daysAhead: number, h: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(h, 0, 0, 0);
  return d;
};

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
  await seedReservation(db, env.orgAId, env.studentAId, 'AAA111', FUT(30, 8), FUT(30, 10));
  await addMemberTagWithDb(db, makeSession(env.orgAId, env.ownerAId, 'owner'), {
    userId: env.studentAId, tag: 'A-Only',
  });

  // B: 2 enrollments, 1 reservation B booked, tag "B-Only".
  await seedEnrollment(db, env.orgAId, env.ownerAId, env.studentBId, 'Course-B1', 0);
  await seedEnrollment(db, env.orgAId, env.ownerAId, env.studentBId, 'Course-B2', 2);
  await seedReservation(db, env.orgAId, env.studentBId, 'BBB222', FUT(31, 8), FUT(31, 10));
  await addMemberTagWithDb(db, makeSession(env.orgAId, env.ownerAId, 'owner'), {
    userId: env.studentBId, tag: 'B-Only',
  });

  // org-B student: 1 enrollment + 1 reservation + tag (cross-org isolation).
  await seedEnrollment(db, env.orgBId, env.ownerBId, env.studentBOrgBId, 'Course-OrgB', 1);
  await seedReservation(db, env.orgBId, env.studentBOrgBId, 'ZZZ999', FUT(32, 8), FUT(32, 10));
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
      db, orgAId, ownerAId, 'PILOT55', FUT(51, 8), FUT(51, 10),
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
      db, orgAId, studentAId, 'BOTH77', FUT(52, 8), FUT(52, 10),
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
      db, orgAId, ownerAId, 'VOID88', FUT(53, 8), FUT(53, 10),
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
      db, orgAId, sId, 'CANC11', FUT(70, 8), FUT(70, 10),
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

// ════════════════════════════════════════════════════════════════════════════
// P10 — a reservation line with an instructor shows the instructor's name.
// The portal printed the instructor resource's raw id (COALESCE(tail_number,
// resource_id)); an instructor has no tail number, so the line read
// "N…, 3f2a…-uuid". It now falls back to the resource's display name.
// ════════════════════════════════════════════════════════════════════════════

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('P10 — instructor resources are labelled by name, never by id', () => {
  it('a dual lesson lists the tail # and the instructor name; no uuid', async () => {
    const { db, orgAId, ownerAId } = env;
    const sId = await seedMember(db, orgAId, `dual-p10-${Date.now()}@alpha.example`, 'student');
    const cfiId = await seedMember(db, orgAId, `cfi-p10-${Date.now()}@alpha.example`, 'cfi');
    const ownerSess = makeSession(orgAId, ownerAId, 'owner');
    const aircraft = await createResourceWithDb(db, ownerSess, {
      kind: 'aircraft', displayName: 'Dual AC', tailNumber: 'NDUAL10',
    });
    const instructor = await createResourceWithDb(db, ownerSess, {
      kind: 'instructor', displayName: 'Pat Example (CFI)', instructorUserId: cfiId,
    });
    // created_by = the student (a booker session for that user, as seedReservation does).
    const r = await createReservationWithDb(db, makeSession(orgAId, sId, 'owner'), {
      startAt: FUT(80, 8), endAt: FUT(80, 10), resourceIds: [aircraft.id, instructor.id],
    });
    expect(r.ok).toBe(true);

    const rows = await getMyReservationsWithDb(db, makeSession(orgAId, sId, 'student'));
    expect(rows).toHaveLength(1);
    expect([...rows[0]!.resourceIds].sort()).toEqual(['NDUAL10', 'Pat Example (CFI)']);
    expect(rows[0]!.resourceIds).not.toContain(instructor.id);
    expect(rows[0]!.resourceIds.some((l) => UUID_RE.test(l))).toBe(false);

    // The portal page reads the bundled summary: same labels there.
    const s = await getMyPortalSummaryWithDb(db, makeSession(orgAId, sId, 'student'));
    expect([...s.reservations[0]!.resourceIds].sort()).toEqual(['NDUAL10', 'Pat Example (CFI)']);
  });

  it('an aircraft-only line is unchanged (tail # only)', async () => {
    const { db, orgAId, studentAId } = env;
    const rows = await getMyReservationsWithDb(db, makeSession(orgAId, studentAId, 'student'));
    const own = rows.find((r) => r.resourceIds.includes('NAAA111'));
    expect(own?.resourceIds).toEqual(['NAAA111']);
  });

  it("the alerts bell's upcoming-flight alert names the aircraft, never an id", async () => {
    // Same self-scoped reservation read, in notifications/internal.ts: it took
    // the FIRST resource row's label, and an instructor row's label was its id.
    const { db, orgAId, ownerAId } = env;
    const sId = await seedMember(db, orgAId, `alert-p10-${Date.now()}@alpha.example`, 'student');
    const cfiId = await seedMember(db, orgAId, `alertcfi-p10-${Date.now()}@alpha.example`, 'cfi');
    const ownerSess = makeSession(orgAId, ownerAId, 'owner');
    // Instructor created first, so its row is not ahead by insertion order alone.
    const instructor = await createResourceWithDb(db, ownerSess, {
      kind: 'instructor', displayName: 'Alex Example (CFI)', instructorUserId: cfiId,
    });
    const aircraft = await createResourceWithDb(db, ownerSess, {
      kind: 'aircraft', displayName: 'Alert AC', tailNumber: 'NALRT10',
    });
    const start = new Date(Date.now() + 3 * 60 * 60 * 1000);
    start.setUTCSeconds(0, 0);
    const r = await createReservationWithDb(db, makeSession(orgAId, sId, 'owner'), {
      startAt: start, endAt: new Date(start.getTime() + 60 * 60 * 1000),
      resourceIds: [instructor.id, aircraft.id],
    });
    expect(r.ok).toBe(true);

    const { getMyAlertsWithDb } = await import('../notifications/get-my-alerts.js');
    const res = await getMyAlertsWithDb(db, makeSession(orgAId, sId, 'student'));
    const upcoming = res.alerts.filter((a) => a.kind === 'reservation_upcoming');
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]!.title).toBe('Upcoming flight: NALRT10');
    for (const a of res.alerts) {
      expect(UUID_RE.test(a.title), a.title).toBe(false);
      expect(UUID_RE.test(a.detail), a.detail).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P11 — bookings made FOR the member (reservation.member_user_id, migration
// 0051). Renters and students cannot book; staff book for them. The portal's
// "My upcoming reservations" lists those too — still self-scoped: the
// predicate is member_user_id = session.userId, never a caller-supplied id.
// ════════════════════════════════════════════════════════════════════════════

/** The org owner books an upcoming flight FOR `memberId`. Returns ids. */
async function seedBookingFor(
  orgId: string,
  ownerId: string,
  memberId: string,
  tail: string,
  start: Date,
  end: Date,
): Promise<{ aircraftId: string; reservationId: string }> {
  const ownerSess = makeSession(orgId, ownerId, 'owner');
  const aircraft = await createResourceWithDb(env.db, ownerSess, {
    kind: 'aircraft', displayName: `Aircraft ${tail}`, tailNumber: `N${tail}`,
  });
  const r = await createReservationWithDb(env.db, ownerSess, {
    startAt: start, endAt: end, resourceIds: [aircraft.id], memberUserId: memberId,
  });
  if (!r.ok) throw new Error(`seed booking-for failed: ${r.reason}`);
  return { aircraftId: aircraft.id, reservationId: r.reservation.id };
}

describe('P11 — bookings made for me (member_user_id)', () => {
  it("shows a booking staff made for A, as 'for_you', in the read and the summary", async () => {
    const { db, orgAId, ownerAId, studentAId } = env;
    const { reservationId } = await seedBookingFor(orgAId, ownerAId, studentAId, 'FOR11', FUT(40, 8), FUT(40, 10));

    const rows = await getMyReservationsWithDb(db, makeSession(orgAId, studentAId, 'student'));
    const forMe = rows.find((r) => r.id === reservationId);
    expect(forMe).toBeDefined();
    expect(forMe?.role).toBe('for_you');
    expect(forMe?.resourceIds).toEqual(['NFOR11']);

    const s = await getMyPortalSummaryWithDb(db, makeSession(orgAId, studentAId, 'student'));
    expect(s.reservations.find((r) => r.id === reservationId)?.role).toBe('for_you');
  });

  it("never shows another member's booking: B does not see the one made for A", async () => {
    const { db, orgAId, ownerAId, studentAId, studentBId } = env;
    const { reservationId } = await seedBookingFor(orgAId, ownerAId, studentAId, 'FOR12', FUT(41, 8), FUT(41, 10));

    const bRows = await getMyReservationsWithDb(db, makeSession(orgAId, studentBId, 'student'));
    expect(bRows.find((r) => r.id === reservationId)).toBeUndefined();
    expect(bRows.flatMap((r) => r.resourceIds)).not.toContain('NFOR12');
    // The booker (the owner) still sees it as theirs.
    const ownerRows = await getMyReservationsWithDb(db, makeSession(orgAId, ownerAId, 'owner'));
    expect(ownerRows.find((r) => r.id === reservationId)?.role).toBe('booker');
  });

  it('never crosses orgs: an org-B booking for the org-B student is invisible to org A', async () => {
    const { db, orgAId, orgBId, ownerBId, studentAId, studentBOrgBId } = env;
    const { reservationId } = await seedBookingFor(
      orgBId, ownerBId, studentBOrgBId, 'FOR13', FUT(42, 8), FUT(42, 10),
    );

    const theirs = await getMyReservationsWithDb(db, makeSession(orgBId, studentBOrgBId, 'student'));
    expect(theirs.find((r) => r.id === reservationId)?.role).toBe('for_you');

    const mine = await getMyReservationsWithDb(db, makeSession(orgAId, studentAId, 'student'));
    expect(mine.find((r) => r.id === reservationId)).toBeUndefined();
    expect(mine.flatMap((r) => r.resourceIds)).not.toContain('NFOR13');
  });

  it("a booking made for A and then dispatched to A reads 'pilot'", async () => {
    const { db, orgAId, ownerAId, studentAId } = env;
    const { aircraftId, reservationId } = await seedBookingFor(
      orgAId, ownerAId, studentAId, 'FOR14', FUT(43, 8), FUT(43, 10),
    );
    const opened = await openDispatchWithDb(db, makeSession(orgAId, ownerAId, 'owner'), {
      reservationId, resourceId: aircraftId, pilotUserId: studentAId, hobbsOut: 80.0, tachOut: 80.0,
    });
    expect(opened.ok).toBe(true);
    const rows = await getMyReservationsWithDb(db, makeSession(orgAId, studentAId, 'student'));
    expect(rows.find((r) => r.id === reservationId)?.role).toBe('pilot');
  });
});
