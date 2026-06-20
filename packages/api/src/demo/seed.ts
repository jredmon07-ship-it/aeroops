/**
 * demo/seed.ts — rich, deterministic demo seed for the zero-setup prototype.
 *
 * Builds ONE org ("Alpha Flight School", slug `alpha`) with a believable
 * cross-section of data so a reviewer can click through the whole scheduling +
 * dispatch surface without any setup:
 *
 *   - one user per key role (owner / manager / dispatcher / cfi / student),
 *     each with a known password (see DEMO_PASSWORD) and an auth_credential.
 *   - four aircraft (by tail #) + one instructor resource (linked to the CFI).
 *   - today's reservations across several aircraft (one already flown, one
 *     currently out, two on the books) + a future reservation on the
 *     policy-gated aircraft.
 *   - a per-resource booking policy (max duration / advance / lead time).
 *   - a weekly recurring lesson series.
 *   - one CLOSED dispatch ticket (flown earlier today, Hobbs/tach recorded)
 *     and one OPEN dispatch ticket (aircraft currently checked out).
 *
 * SEEDING POSTURE: this runs as the PGlite superuser (BEFORE setTestAppRole),
 * exactly like the test seed. Control-plane rows (org/plan/subscription) go
 * through withPlatformAdminContext; tenant rows through withOrgContext. The
 * reservation / policy / series / dispatch rows are created through the REAL,
 * tested write paths (createReservationWithDb, upsertBookingPolicyWithDb,
 * createSeriesWithDb, openDispatchWithDb, closeDispatchWithDb) so the demo data
 * is byte-identical to what the running app would produce — no hand-rolled SQL.
 *
 * This module is DEMO-ONLY. It is never imported by the production code path
 * (getDb only reaches it when AEROOPS_DEMO=1).
 */
import {
  withOrgContext,
  withPlatformAdminContext,
  org,
  location,
  plan,
  subscription,
  appUser,
  membership,
  authCredential,
  resource,
  memberTag,
  dispatchRequirement,
  dispatchConfig,
} from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { MembershipRole } from '@aeroops/core';
import { hashPassword } from '../auth/hash.js';
import type { AppSession } from '../auth/types.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { upsertBookingPolicyWithDb } from '../scheduling/booking-policy-commands.js';
import { createSeriesWithDb } from '../scheduling/create-series.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { reportSquawkWithDb } from '../maintenance/report-squawk.js';
import { groundAircraftWithDb } from '../maintenance/ground-aircraft.js';
import { openWorkOrderWithDb } from '../maintenance/open-work-order.js';
import { createAvailabilityWindowWithDb } from '../scheduling/availability-commands.js';
import { submitBookingRequestWithDb } from '../booking/submit-booking-request.js';
import { createCourseWithDb } from '../training/create-course.js';
import { addCourseLessonWithDb } from '../training/add-course-lesson.js';
import { enrollMemberWithDb } from '../training/enroll-member.js';
import { recordLessonWithDb } from '../training/record-lesson.js';

/** The org address used in the URL: /o/alpha/login */
export const DEMO_SLUG = 'alpha';
/** Shared password for every demo login (printed in the runbook). */
export const DEMO_PASSWORD = 'demo1234';

/** A demo login the runbook advertises. */
export interface DemoLogin {
  email: string;
  fullName: string;
  role: MembershipRole;
  phone: string;
}

export const DEMO_LOGINS: DemoLogin[] = [
  { email: 'owner@alpha.aero', fullName: 'Avery Owner', role: 'owner', phone: '(614) 555-0101' },
  { email: 'manager@alpha.aero', fullName: 'Morgan Manager', role: 'manager', phone: '(614) 555-0102' },
  { email: 'dispatch@alpha.aero', fullName: 'Dana Dispatch', role: 'dispatcher', phone: '(614) 555-0103' },
  { email: 'cfi@alpha.aero', fullName: 'Casey Reed (CFI)', role: 'cfi', phone: '(614) 555-0104' },
  { email: 'student@alpha.aero', fullName: 'Sam Student', role: 'student', phone: '(614) 555-0105' },
];

/** A Date at `hour:minute` local time, `dayOffset` days from today. */
function atLocal(dayOffset: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/**
 * seedDemo — populate a freshly-migrated PGlite client with the demo dataset.
 * MUST be called while still connected as the PGlite superuser (before
 * setTestAppRole), mirroring the test-seed contract.
 */
export async function seedDemo(db: AnyDb): Promise<void> {
  // ── 1. Control-plane: org + plan + active subscription ──────────────────
  const orgRow = await withPlatformAdminContext(db, async (tx) => {
    const [o] = await tx
      .insert(org)
      .values({ name: 'Alpha Flight School', slug: DEMO_SLUG, status: 'active' })
      .returning();
    const [p] = await tx
      .insert(plan)
      .values({ code: 'growth', name: 'Growth' })
      .returning();
    await tx
      .insert(subscription)
      .values({ orgId: o!.id, planId: p!.id, status: 'active' })
      .returning();
    return o!;
  });
  const orgId = orgRow.id;

  // ── 2. Tenant: users + memberships + credentials + resources ────────────
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const ids = await withOrgContext(db, orgId, async (tx) => {
    // Users + memberships + a credential per login.
    const userIdByEmail = new Map<string, string>();
    for (const login of DEMO_LOGINS) {
      const [u] = await tx
        .insert(appUser)
        .values({ orgId, email: login.email, fullName: login.fullName, phone: login.phone })
        .returning();
      await tx
        .insert(membership)
        .values({ orgId, userId: u!.id, role: login.role })
        .returning();
      await tx
        .insert(authCredential)
        .values({ orgId, userId: u!.id, passwordHash })
        .returning();
      userIdByEmail.set(login.email, u!.id);
    }

    const cfiUserId = userIdByEmail.get('cfi@alpha.aero')!;
    const ownerUserId = userIdByEmail.get('owner@alpha.aero')!;
    const studentUserId = userIdByEmail.get('student@alpha.aero')!;

    // Free-text member tags (operator labels ONLY — no computed currency/medical).
    const demoTags: Array<{ userId: string; tag: string }> = [
      { userId: cfiUserId, tag: 'Gold Seal CFI' },
      { userId: cfiUserId, tag: 'Tailwheel endorsed' },
      // CFI carries this free-text operator label; it exactly matches the Archer's
      // dispatch requirement below, so the CFI passes the eligibility gate (Slice 3c)
      // and the student (who lacks it) is refused — a live demo of the gate. The label
      // is deliberately operator-flavored (a club checkout), NOT an FAA endorsement.
      { userId: cfiUserId, tag: 'Club checkout: complex' },
      { userId: studentUserId, tag: 'Pre-solo' },
      { userId: studentUserId, tag: 'Needs night XC' },
    ];
    for (const t of demoTags) {
      await tx
        .insert(memberTag)
        .values({ orgId, userId: t.userId, tag: t.tag, createdBy: ownerUserId })
        .returning();
    }

    // Home base — the operator's airport (Fleet home-base FK target). Coordinates
    // (KOSU / OSU Don Scott Field, WGS84) drive the Slice 4a civil-twilight calc.
    const [base] = await tx
      .insert(location)
      .values({
        orgId,
        name: 'Alpha Main Base',
        icao: 'KOSU',
        latitude: '40.07800',
        longitude: '-83.07300',
      })
      .returning();

    // Dispatch gate config (Slice 4a) — turn ON the civil-twilight constraint in
    // WARN mode so an evening booking that crosses civil dusk gets a non-blocking
    // notice (the daytime demo bookings below are unaffected). Operator scheduling
    // rule from astronomy — NOT an FAA night-currency determination. Eligibility
    // stays at its default 'block' (the 3c demo requirement still applies).
    // Also turn ON the availability (operating-hours) constraint in WARN mode
    // (Slice AV1) so a booking outside a tail's operating hours gets a non-blocking
    // notice — operator scheduling rule, NOT an FAA duty/§117 determination.
    await tx
      .insert(dispatchConfig)
      .values({
        orgId,
        twilightConstraintEnabled: true,
        twilightMode: 'warn',
        availabilityConstraintEnabled: true,
        availabilityMode: 'warn',
      })
      .returning();

    // Aircraft (tail #). aircraft → tail_number NOT NULL, instructor_user_id NULL.
    // Rich identity (make/model/year/serial/home base) so the Fleet pages show
    // a believable record (Slice 5).
    const aircraftSpecs = [
      { displayName: 'Cessna 172SP', tailNumber: 'N172SP', make: 'Cessna', model: '172S Skyhawk', year: 2014, serialNumber: '172S-11876' },
      { displayName: 'Cessna 152', tailNumber: 'N152AB', make: 'Cessna', model: '152', year: 1980, serialNumber: '15284321' },
      { displayName: 'Piper Archer', tailNumber: 'N28K', make: 'Piper', model: 'PA-28-181 Archer III', year: 2008, serialNumber: '2843210' },
      { displayName: 'Cirrus SR20', tailNumber: 'N66RG', make: 'Cirrus', model: 'SR20', year: 2019, serialNumber: '2456' },
    ];
    const aircraftIdByTail = new Map<string, string>();
    for (const a of aircraftSpecs) {
      const [r] = await tx
        .insert(resource)
        .values({
          orgId,
          kind: 'aircraft',
          displayName: a.displayName,
          tailNumber: a.tailNumber,
          make: a.make,
          model: a.model,
          year: a.year,
          serialNumber: a.serialNumber,
          homeBaseLocationId: base!.id,
        })
        .returning();
      aircraftIdByTail.set(a.tailNumber, r!.id);
    }

    // Dispatch requirement (Slice 3c) — the Archer requires a free-text
    // "Club checkout: complex" operator label on the dispatched pilot. Operator
    // data ONLY (no computed FAA currency/endorsement). The CFI has the matching
    // tag (passes); the student does not (refused) — the gate is demonstrable on the board.
    await tx.insert(dispatchRequirement).values({
      orgId,
      resourceId: aircraftIdByTail.get('N28K')!,
      requiredTag: 'Club checkout: complex',
      createdBy: ownerUserId,
    });

    // Instructor resource (instructor → instructor_user_id NOT NULL, tail NULL).
    const [instructor] = await tx
      .insert(resource)
      .values({
        orgId,
        kind: 'instructor',
        displayName: 'Casey Reed (CFI)',
        instructorUserId: cfiUserId,
      })
      .returning();

    return {
      userIdByEmail,
      aircraftIdByTail,
      instructorId: instructor!.id,
      ownerId: userIdByEmail.get('owner@alpha.aero')!,
      studentId: userIdByEmail.get('student@alpha.aero')!,
    };
  });

  // Owner session used to drive the real write paths (full capabilities).
  const ownerSession: AppSession = {
    user: { email: 'owner@alpha.aero' },
    userId: ids.ownerId,
    orgId,
    slug: DEMO_SLUG,
    role: 'owner',
  };

  const tail = (t: string) => ids.aircraftIdByTail.get(t)!;

  // ── 3. Reservations (through the real gated create path) ────────────────
  // A — flown earlier today (will receive a CLOSED dispatch). 172 + instructor.
  const resA = await mustCreate(
    createReservationWithDb(db, ownerSession, {
      startAt: atLocal(0, 7, 0),
      endAt: atLocal(0, 9, 0),
      resourceIds: [tail('N172SP'), ids.instructorId],
      notes: 'Dual XC — KABC ▸ practice area',
    }),
    'reservation A (172 dual, flown)',
  );

  // B — currently out (will receive an OPEN dispatch). Cessna 152.
  const resB = await mustCreate(
    createReservationWithDb(db, ownerSession, {
      startAt: atLocal(0, 10, 0),
      endAt: atLocal(0, 12, 0),
      resourceIds: [tail('N152AB')],
      notes: 'Solo pattern work',
    }),
    'reservation B (152 solo, out now)',
  );

  // C — on the books for this afternoon. Archer + instructor.
  await mustCreate(
    createReservationWithDb(db, ownerSession, {
      startAt: atLocal(0, 13, 30),
      endAt: atLocal(0, 15, 0),
      resourceIds: [tail('N28K'), ids.instructorId],
      notes: 'Stage check prep',
    }),
    'reservation C (Archer dual)',
  );

  // ── 4. Booking policy on the Cirrus (demonstrates the policy gate) ──────
  await mustOk(
    upsertBookingPolicyWithDb(db, ownerSession, {
      resourceId: tail('N66RG'),
      maxDurationMinutes: 180,
      maxAdvanceDays: 60,
      minAdvanceMinutes: 60,
    }),
    'booking policy (Cirrus)',
  );

  // D — future reservation on the policy-gated Cirrus (passes the policy).
  await mustCreate(
    createReservationWithDb(db, ownerSession, {
      startAt: atLocal(1, 10, 0),
      endAt: atLocal(1, 11, 30),
      resourceIds: [tail('N66RG')],
      notes: 'Transition training',
    }),
    'reservation D (Cirrus, tomorrow)',
  );

  // ── 5. Weekly recurring lesson series (Tue/Thu evening ground+flight) ───
  await createSeriesWithDb(db, ownerSession, {
    weekdays: [2, 4],
    intervalWeeks: 1,
    end: { kind: 'count', count: 8 },
    localStartTime: '17:00',
    durationMinutes: 90,
    tz: 'America/Chicago',
    resourceIds: [tail('N28K')],
    notes: 'Private pilot ground + flight block',
  });

  // ── 6. Dispatch tickets ─────────────────────────────────────────────────
  // Closed ticket on reservation A (flown earlier): open then close.
  const opened = await openDispatchWithDb(db, ownerSession, {
    reservationId: resA.id,
    resourceId: tail('N172SP'),
    pilotUserId: ids.studentId,
    hobbsOut: 3450.2,
    tachOut: 3210.5,
    notes: 'Pre-flight complete',
  });
  if (!opened.ok) throw new Error(`[demo] open dispatch A failed: ${opened.reason}`);
  const closed = await closeDispatchWithDb(db, ownerSession, {
    ticketId: opened.ticket.id,
    hobbsIn: 3451.8,
    tachIn: 3212.0,
  });
  if (!closed.ok) throw new Error(`[demo] close dispatch A failed: ${closed.reason}`);

  // Open ticket on reservation B (aircraft currently out).
  const openedB = await openDispatchWithDb(db, ownerSession, {
    reservationId: resB.id,
    resourceId: tail('N152AB'),
    pilotUserId: ids.studentId,
    hobbsOut: 1875.4,
    tachOut: 1790.1,
  });
  if (!openedB.ok) throw new Error(`[demo] open dispatch B failed: ${openedB.reason}`);

  // ── 7. Squawks + grounding (Slice 3b) ───────────────────────────────────
  // A grounding-severity squawk on the Cirrus, then ground it (linked to the
  // squawk) — so the board shows a "Grounded" chip, the squawk list shows open
  // items, and booking the Cirrus surfaces the grounded warning before commit.
  const groundingSquawk = await reportSquawkWithDb(db, ownerSession, {
    resourceId: tail('N66RG'),
    title: 'Oil seeping at quick-drain',
    description: 'Noted on post-flight walkaround. Maintenance to inspect before next flight.',
    severity: 'grounding',
  });
  if (!groundingSquawk.ok) {
    throw new Error('[demo] report grounding squawk failed — seed cannot continue.');
  }
  const grounded = await groundAircraftWithDb(db, ownerSession, {
    resourceId: tail('N66RG'),
    reason: 'Down for maintenance — oil leak at quick-drain (see squawk).',
    squawkId: groundingSquawk.squawk.id,
  });
  if (!grounded.ok) throw new Error('[demo] ground aircraft failed — seed cannot continue.');

  // A second, low-severity open squawk on the 172 (no grounding) for the list.
  const minorSquawk = await reportSquawkWithDb(db, ownerSession, {
    resourceId: tail('N172SP'),
    title: 'Landing light intermittent',
    description: 'Flickers on the ground; works in flight. Low priority.',
    severity: 'low',
  });
  if (!minorSquawk.ok) {
    throw new Error('[demo] report minor squawk failed — seed cannot continue.');
  }

  // ── 7a2. Availability / operating hours (Slice AV1) ─────────────────────
  // The 172 is available daily 07:00–21:00 local; with the availability
  // constraint ON in WARN mode, booking it outside those hours surfaces a
  // non-blocking "outside operating hours" notice. Operator scheduling data —
  // NOT an FAA duty/§117 determination.
  for (let dow = 1; dow <= 7; dow++) {
    const win = await createAvailabilityWindowWithDb(db, ownerSession, {
      resourceId: tail('N172SP'),
      dayOfWeek: dow,
      startMinute: 7 * 60, // 07:00
      endMinute: 21 * 60, // 21:00
      tz: 'America/Chicago',
    });
    if (!win.ok) {
      throw new Error(`[demo] availability window (dow ${dow}) failed — seed cannot continue.`);
    }
  }

  // ── 7a3. Public booking requests (Slice PB1) ────────────────────────────
  // A couple of inbound lead requests (via the real public anon-submit path)
  // so the staff triage inbox isn't empty. Lead-capture only — NO reservation,
  // NO money; each lands as status 'new' for staff to triage.
  const dayMs = 24 * 60 * 60 * 1000;
  const demoBookingRequests = [
    {
      name: 'Jordan Vance',
      email: 'jordan.vance@example.com',
      phone: '555-0142',
      requestedStart: new Date(Date.now() + 3 * dayMs).toISOString(),
      aircraftTypePref: 'C172 or similar',
      message: 'Hoping to start my private pilot training — flexible on weekday mornings.',
      website: '',
    },
    {
      name: 'Maya Chen',
      email: 'maya.chen@example.com',
      requestedStart: new Date(Date.now() + 5 * dayMs).toISOString(),
      message: 'Renter checkout request — ~80 hrs TT, current. What do you need from me?',
      website: '',
    },
  ];
  for (const req of demoBookingRequests) {
    const r = await submitBookingRequestWithDb(db, DEMO_SLUG, req);
    if (!r.ok) {
      throw new Error('[demo] public booking request failed — seed cannot continue.');
    }
  }

  // ── 7b. Work order on the grounded Cirrus (Slice M1) ────────────────────
  // Linked to the grounding squawk and left OPEN — so the demo shows an open
  // work order on the grounded aircraft. Completing it (resolve squawk + return
  // to service) closes the maintenance loop. Operator maintenance record; NO
  // computed Part-43 / airworthiness determination.
  const workOrder = await openWorkOrderWithDb(db, ownerSession, {
    resourceId: tail('N66RG'),
    squawkId: groundingSquawk.squawk.id,
    title: 'Investigate oil seep at quick-drain',
    description: 'Inspect the quick-drain, reseal as needed, then return to service.',
  });
  if (!workOrder.ok) {
    throw new Error('[demo] open work order failed — seed cannot continue.');
  }

  // ── 8. Training (Slice T1) ──────────────────────────────────────────────
  // An operator-defined Private Pilot course with five lessons, the student
  // enrolled, and the first two lessons recorded as complete by the CFI — so
  // the Training surface shows a populated enrollment at 2/5 (40%) progress.
  // Operator content + instructor data entry; NO computed FAA determination.
  const cfiUserId = ids.userIdByEmail.get('cfi@alpha.aero')!;

  const courseRes = await createCourseWithDb(db, ownerSession, {
    title: 'Private Pilot — Part 61',
    description: 'Operator syllabus: pre-solo fundamentals through cross-country.',
  });
  if (!courseRes.ok) throw new Error('[demo] create course failed — seed cannot continue.');
  const courseId = courseRes.course.courseId;

  const lessonPlan = [
    { title: 'Preflight, taxi & runup', stageLabel: 'Pre-solo' },
    { title: 'Four fundamentals',       stageLabel: 'Pre-solo' },
    { title: 'Slow flight & stalls',    stageLabel: 'Pre-solo' },
    { title: 'Takeoffs & landings',     stageLabel: 'Solo prep' },
    { title: 'Cross-country planning',  stageLabel: 'Cross-country' },
  ];
  let ppCourse = courseRes.course;
  for (const lesson of lessonPlan) {
    const added = await addCourseLessonWithDb(db, ownerSession, {
      courseId,
      title: lesson.title,
      stageLabel: lesson.stageLabel,
    });
    if (!added.ok) throw new Error(`[demo] add lesson "${lesson.title}" failed — seed cannot continue.`);
    ppCourse = added.course;
  }

  const enrollRes = await enrollMemberWithDb(db, ownerSession, {
    courseId,
    studentUserId: ids.studentId,
  });
  if (!enrollRes.ok) {
    throw new Error(`[demo] enroll student failed (${enrollRes.reason}) — seed cannot continue.`);
  }
  const enrollmentId = enrollRes.enrollment.enrollmentId;

  // Record the first two lessons complete (CFI as instructor) → 2/5 progress.
  for (const lesson of ppCourse.lessons.slice(0, 2)) {
    const recorded = await recordLessonWithDb(db, ownerSession, {
      enrollmentId,
      lessonId: lesson.lessonId,
      instructorUserId: cfiUserId,
      gradeLabel: 'Complete',
    });
    if (!recorded.ok) {
      throw new Error(`[demo] record lesson failed (${recorded.reason}) — seed cannot continue.`);
    }
  }
}

/** Assert a createReservation result succeeded, returning the new reservation. */
async function mustCreate(
  p: Promise<{ ok: true; reservation: { id: string } } | { ok: false; reason: string }>,
  label: string,
): Promise<{ id: string }> {
  const r = await p;
  if (!r.ok) {
    throw new Error(`[demo] ${label} was refused (${r.reason}) — seed cannot continue.`);
  }
  return r.reservation;
}

/** Assert a generic {ok} result succeeded. */
async function mustOk(
  p: Promise<{ ok: true } | { ok: false; reason: string }>,
  label: string,
): Promise<void> {
  const r = await p;
  if (!r.ok) {
    throw new Error(`[demo] ${label} failed (${r.reason}) — seed cannot continue.`);
  }
}
