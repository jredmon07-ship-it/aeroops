/**
 * demo/seed.ts — rich, deterministic demo seed for the zero-setup prototype.
 *
 * Builds TWO orgs so a reviewer can see both ends of the product:
 *
 *   1. "Alpha Flight School" (slug `alpha`) — a busy flight school:
 *      - one user per key role (owner / manager / dispatcher / cfi / student),
 *        each with a known password (see DEMO_PASSWORD) and an auth_credential.
 *      - four aircraft (by tail #) + one instructor resource (linked to the CFI).
 *      - today's flights on three aircraft + a future reservation on the
 *        policy-gated aircraft.
 *      - a per-resource booking policy (max duration / advance / lead time).
 *      - a weekly recurring lesson series.
 *      - today's dispatch tickets, as far as the seed clock has got: a CLOSED
 *        ticket (Hobbs/tach recorded) for each flight that is over, an OPEN
 *        one (aircraft checked out) for a flight under way, none for the rest.
 *      - a month of history, the student's first two lessons among it.
 *      - a six-week forward schedule and four Messages announcements
 *        (demo/seed-upcoming.ts).
 *
 *   2. "Bravo Flying Club" (slug `bravo`) — a SMALL CLUB counter-example:
 *      - three logins (owner / admin / member) in a 17-member roster: a
 *        mechanic, a CFI (also a bookable instructor), renters, a student
 *        pilot and two inactive members, with tags, join dates and
 *        warn-only expiration reminders.
 *      - two aircraft, one location; four weeks of flying on both aircraft by
 *        eleven pilots (meters, fuel, logbook notes, cancellations); a
 *        member's overnight trip, out since yesterday afternoon; today's
 *        flights, dispatched as far as the seed clock has got; a booking
 *        policy and a club-checkout dispatch requirement on the Warrior.
 *      - squawk history, two work orders and maintenance-due items. NO
 *        training course (club operating mode turns training off).
 *      - its own six-week forward schedule, flying every day, and six
 *        announcements.
 *      - CLUB OPERATING MODE (migration 0047, GRACEFUL ABSENCE if unapplied):
 *        the org_feature_config row is written with the 'club' preset
 *        (training/booking/auto-schedule off).
 *
 * Both orgs are built by this SAME seedDemo() call — one entry point so
 * bootstrap.ts, reset.ts, and the real-Postgres runner (seed-demo.ts) all get
 * both without any extra wiring.
 *
 * SEEDING POSTURE: this runs as the PGlite superuser (BEFORE setTestAppRole),
 * exactly like the test seed. Control-plane rows (org/plan/subscription) go
 * through withPlatformAdminContext; tenant rows through withOrgContext. The
 * reservation / policy / series / dispatch rows are created through the REAL,
 * tested write paths (createReservationWithDb, upsertBookingPolicyWithDb,
 * createSeriesWithDb, openDispatchWithDb, closeDispatchWithDb) so the demo data
 * is byte-identical to what the running app would produce — no hand-rolled SQL.
 * The two GRACEFUL-ABSENCE features (club mode / avatars) have no Drizzle
 * table/column object by design (see org-features-internal.ts / avatar.ts) —
 * those two spots use guarded raw SQL, same as their production consumers.
 *
 * Every date is relative to the seed's clock, `now`: the moment the seed runs,
 * or a time a test pins (demo/demo-clock.ts). So a seeded demo ages; the
 * hosted demo re-seeds daily (demo/scheduled-reset.ts). The seed never records
 * anything after its clock: no ticket, meter reading, squawk, sign-off, note,
 * message or audit row is dated later than `now`, and a flight is checked out
 * only once it has started and back in only once it is over (flyAsOf). The
 * nightly reset runs at 03:00 Chicago, so it leaves today's flights booked,
 * and only Bravo's overnight trip, which left the afternoon before, is out.
 *
 * This module is DEMO-ONLY. It is never imported by the production code path
 * (getDb only reaches it when AEROOPS_DEMO=1).
 */
import { sql } from 'drizzle-orm';
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
import { OPERATING_MODE_PRESETS } from '@aeroops/core';
import { hashPassword } from '../auth/hash.js';
import type { AppSession } from '../auth/types.js';
import type { MemberTagColor } from '../people/types.js';
import type { CreatedReservation, CreateReservationResult } from '../scheduling/types.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { cancelReservationWithDb } from '../scheduling/cancel-reservation.js';
import { upsertBookingPolicyWithDb } from '../scheduling/booking-policy-commands.js';
import { createSeriesWithDb } from '../scheduling/create-series.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { recordDispatchServiceWithDb } from '../dispatch/record-dispatch-service.js';
import { addResourceRequiredTagWithDb } from '../dispatch-gate/requirements.js';
import { annotateFlightWithDb } from '../logbook/annotate-flight.js';
import { reportSquawkWithDb } from '../maintenance/report-squawk.js';
import { updateSquawkStatusWithDb } from '../maintenance/update-squawk-status.js';
import { groundAircraftWithDb } from '../maintenance/ground-aircraft.js';
import { openWorkOrderWithDb } from '../maintenance/open-work-order.js';
import { updateWorkOrderStatusWithDb } from '../maintenance/update-work-order-status.js';
import { completeWorkOrderWithDb } from '../maintenance/complete-work-order.js';
import { createMaintenanceItemWithDb } from '../maintenance/create-maintenance-item.js';
import { addMemberExpirationWithDb } from '../people/member-expirations.js';
import { createAvailabilityWindowWithDb } from '../scheduling/availability-commands.js';
import { submitBookingRequestWithDb } from '../booking/submit-booking-request.js';
import { createCourseWithDb } from '../training/create-course.js';
import { addCourseLessonWithDb } from '../training/add-course-lesson.js';
import { enrollMemberWithDb } from '../training/enroll-member.js';
import { recordLessonWithDb } from '../training/record-lesson.js';
import { orgFeatureConfigTableExists } from '../org-features/org-features-internal.js';
import { atLocal, demoWallClockZone, localDateAt } from './demo-clock.js';
import { seedUpcomingReservations, seedAnnouncements, UPCOMING_DAYS } from './seed-upcoming.js';

/** The org address used in the URL: /o/alpha/login */
export const DEMO_SLUG = 'alpha';
/** The small-club org address used in the URL: /o/bravo/login */
export const DEMO_SLUG_BRAVO = 'bravo';
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

/** The three Bravo Flying Club demo logins (owner / admin / member). */
export const DEMO_LOGINS_BRAVO: DemoLogin[] = [
  { email: 'owner@bravo.aero', fullName: 'Jordan Club-President', role: 'owner', phone: '(614) 555-0201' },
  { email: 'admin@bravo.aero', fullName: 'Casey Scheduler', role: 'manager', phone: '(614) 555-0202' },
  { email: 'member@bravo.aero', fullName: 'Riley Member', role: 'renter', phone: '(614) 555-0203' },
];

/**
 * Memoized argon2id hash of the (constant) demo password. The reset-on-open
 * feature runs seedDemo on the login path INSIDE the reset transaction — while
 * the advisory lock is held and the org row is deleted — so recomputing a
 * 19 MiB memory-hard hash of a fixed string there would stretch that critical
 * window on every reset for no informational gain. Same pattern as DUMMY_HASH
 * in auth/hash.ts.
 */
let _demoPasswordHashCache: Promise<string> | null = null;
function demoPasswordHash(): Promise<string> {
  _demoPasswordHashCache ??= hashPassword(DEMO_PASSWORD);
  return _demoPasswordHashCache;
}

/**
 * maybeSeedClubMode — write the org_feature_config row for a small-club org
 * IF migration 0047 is applied. GRACEFUL ABSENCE: probes
 * orgFeatureConfigTableExists first and silently no-ops on a pre-0047 DB (the
 * org then simply behaves as ALL-MODULES-ENABLED, same as today). `tx` must
 * already be org-scoped (RLS GUC set). There is deliberately no Drizzle table
 * object for org_feature_config (see org-features-internal.ts), so this is a
 * guarded raw INSERT — same pattern as its production writer (setOrgFeatures).
 */
async function maybeSeedClubMode(tx: AnyDb, orgId: string): Promise<void> {
  if (!(await orgFeatureConfigTableExists(tx))) return;
  const preset = OPERATING_MODE_PRESETS.club;
  await tx.execute(sql`
    INSERT INTO "org_feature_config" (
      "org_id", "operating_mode",
      "module_training", "module_maintenance", "module_booking",
      "module_portal", "module_reports", "module_auto_schedule", "module_messages"
    ) VALUES (
      ${orgId}::uuid, 'club',
      ${preset.training}, ${preset.maintenance}, ${preset.booking},
      ${preset.portal}, ${preset.reports}, ${preset.auto_schedule}, ${preset.messages}
    )
  `);
}

/**
 * seedDemo — populate a freshly-migrated PGlite client with the demo dataset.
 * MUST be called while still connected as the PGlite superuser (before
 * setTestAppRole), mirroring the test-seed contract.
 *
 * `now` is the seed's clock; every seeded time is relative to it, and nothing
 * is dated after it. Every runner leaves it at the real time; tests pin it. A
 * pinned clock must not run behind the real one, because the write paths
 * stamp their own rows (created_at defaults, audit rows) with the real time.
 */
export async function seedDemo(db: AnyDb, now: Date = new Date()): Promise<void> {
  // ── 1. Control-plane: org + plan + active subscription ──────────────────
  const orgRow = await withPlatformAdminContext(db, async (tx) => {
    const [o] = await tx
      .insert(org)
      .values({ name: 'Alpha Flight School', slug: DEMO_SLUG, status: 'active' })
      .returning();
    // Idempotent on the (global, non-org-scoped) plan: a demo reset deletes only
    // the org row (scoped wipe), so the 'growth' plan survives across resets.
    // On a fresh DB this inserts; on re-seed it returns the existing plan.
    const [p] = await tx
      .insert(plan)
      .values({ code: 'growth', name: 'Growth' })
      .onConflictDoUpdate({ target: plan.code, set: { name: 'Growth' } })
      .returning();
    await tx
      .insert(subscription)
      .values({ orgId: o!.id, planId: p!.id, status: 'active' })
      .returning();
    return o!;
  });
  const orgId = orgRow.id;

  // ── 2. Tenant: users + memberships + credentials + resources ────────────
  const passwordHash = await demoPasswordHash();

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

    // No seeded avatars — demo users show the shared silhouette placeholder
    // (a real "default profile photo"); visitors can upload one in the portal.

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
    // (KOSU / OSU Bravo Field, WGS84) drive the Slice 4a civil-twilight calc.
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
  /** A time on the demo wall clock, `day` days from the seed clock's today. */
  const at = (day: number, hour: number, minute = 0) => atLocal(day, hour, minute, now);
  /** The gates' clock: booking policies judge the seed's bookings at `now`. */
  const clock = { now: now.getTime() };

  // ── 3. Reservations (through the real gated create path) ────────────────
  // Today's three flights. Each is checked out once it has started and back
  // in once it is over (8a2), so the seed clock decides how far they have got:
  // all three still booked at the 03:00 reset, the first two flown and the
  // Archer out at 15:00.
  // A — this morning's dual cross-country. 172 + instructor.
  const resA = await mustCreate(
    createReservationWithDb(db, ownerSession, {
      startAt: at(0, 7),
      endAt: at(0, 9),
      resourceIds: [tail('N172SP'), ids.instructorId],
      notes: 'Dual XC — KABC ▸ practice area',
    }, clock),
    'reservation A (172 dual)',
  );

  // B — a late-morning solo. Cessna 152.
  const resB = await mustCreate(
    createReservationWithDb(db, ownerSession, {
      startAt: at(0, 10),
      endAt: at(0, 12),
      resourceIds: [tail('N152AB')],
      notes: 'Solo pattern work',
    }, clock),
    'reservation B (152 solo)',
  );

  // C — this afternoon's stage-check prep. Archer + instructor.
  const resC = await mustCreate(
    createReservationWithDb(db, ownerSession, {
      startAt: at(0, 14),
      endAt: at(0, 15, 30),
      resourceIds: [tail('N28K'), ids.instructorId],
      notes: 'Stage check prep',
    }, clock),
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
      startAt: at(1, 10),
      endAt: at(1, 11, 30),
      resourceIds: [tail('N66RG')],
      notes: 'Transition training',
    }, clock),
    'reservation D (Cirrus, tomorrow)',
  );

  // ── 5. Weekly recurring lesson series (Tue/Thu evening ground+flight) ───
  await createSeriesWithDb(db, ownerSession, {
    weekdays: [2, 4],
    intervalWeeks: 1,
    end: { kind: 'count', count: 8 },
    localStartTime: '17:00',
    durationMinutes: 90,
    tz: demoWallClockZone(),
    resourceIds: [tail('N28K')],
    notes: 'Private pilot ground + flight block',
  }, clock);

  // ── 5a. The coming six weeks (demo/seed-upcoming.ts) ───────────────────
  // A weekly pattern so every day a visitor browses to has flying on it. It
  // starts the day after tomorrow (today and tomorrow are hand-placed above)
  // and keeps clear of the Tue/Thu evening series and of itself: one block per
  // aircraft per time band, the instructor on Mon/Wed/Fri mornings and the
  // Cirrus checkouts. Any collision throws. The Cirrus slots start a week out,
  // after its maintenance (see the grounding below and the announcement).
  // Notes deliberately differ from the hand-placed reservations' notes, which
  // tests look up by exact text.
  await seedUpcomingReservations(
    db,
    ownerSession,
    [
      {
        weekdays: [1, 3, 5],
        hour: 8,
        durationMinutes: 120,
        resourceIds: [tail('N172SP'), ids.instructorId],
        notes: [
          'Dual — steep turns & slow flight',
          'Dual — pattern work',
          'Dual — emergency procedures',
          'Dual — XC planning flight',
          'Stage check — oral & flight prep',
        ],
      },
      {
        weekdays: [2, 4],
        hour: 9,
        durationMinutes: 90,
        resourceIds: [tail('N152AB')],
        notes: ['Solo — practice area', 'Solo — pattern work'],
      },
      {
        weekdays: [1, 2, 3, 4, 5],
        hour: 11,
        durationMinutes: 120,
        resourceIds: [tail('N28K')],
        notes: ['Rental — KOSU ▸ KLCK and back', 'Proficiency flight', 'Rental — local', 'Club checkout flight'],
      },
      {
        weekdays: [6],
        hour: 9,
        durationMinutes: 180,
        resourceIds: [tail('N28K')],
        notes: ['Rental — weekend XC', 'Rental — scenic flight'],
      },
      {
        weekdays: [6],
        hour: 13,
        durationMinutes: 150,
        resourceIds: [tail('N172SP')],
        notes: ['Rental — weekend flying', 'Rental — currency flight'],
      },
      {
        weekdays: [0],
        hour: 13,
        durationMinutes: 120,
        resourceIds: [tail('N152AB')],
        notes: ['Solo — weekend practice'],
      },
      {
        weekdays: [3, 6],
        hour: 14,
        durationMinutes: 120,
        resourceIds: [tail('N66RG'), ids.instructorId],
        fromDay: 7,
        notes: [
          'SR20 transition — avionics & flows',
          'SR20 transition — landings',
          'SR20 transition — CAPS briefing & checkout',
        ],
      },
    ],
    { firstDay: 2, lastDay: UPCOMING_DAYS },
    now,
  );

  // ── 6. Dispatch tickets ─────────────────────────────────────────────────
  // Today's go in after the history (8a2): their meters pick up where it
  // stops, and no history check-out meets an aircraft still out today.

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
      tz: demoWallClockZone(),
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
      requestedStart: new Date(now.getTime() + 3 * dayMs).toISOString(),
      aircraftTypePref: 'C172 or similar',
      message: 'Hoping to start my private pilot training — flexible on weekday mornings.',
      website: '',
    },
    {
      name: 'Maya Chen',
      email: 'maya.chen@example.com',
      requestedStart: new Date(now.getTime() + 5 * dayMs).toISOString(),
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
  // enrolled, and the first two lessons recorded as complete by the CFI after
  // the dual flights they were flown on (8a1) — so the Training surface shows
  // a populated enrollment at 2/5 (40%) progress.
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

  // ── 8a. Historical activity backfill (DEMO-ONLY) ────────────────────────
  // Give the dashboard activity chart, fleet utilization, and reporting trends
  // a believable month of flights instead of only today's snapshot. Each flight
  // is created through the REAL gated write paths at a backdated (past) time,
  // then dated to the flight day along with today's tickets (8a2), so the
  // time-bucketed reports pick them up.
  // DEFENSIVE: any failure is logged and skipped so the core demo still seeds.
  // Resets on every demo restart.
  //
  // Two trainers carry the history: the 172 (student-flown) and the Archer
  // (CFI-flown — satisfies its 'Club checkout: complex' dispatch requirement).
  // Meters climb with recency, and today's flights (8a2) pick up where they
  // stop, so the fleet timeline stays monotonic.
  // pilot must be an app_user MEMBER (ids.instructorId is the instructor
  // *resource*, not a user — the Archer is flown by the CFI user, who also
  // carries the 'Club checkout: complex' tag its dispatch requirement needs).
  const histPlan = [
    { tail: 'N172SP', pilot: ids.studentId, hobbs: 3300, tach: 3100 },
    { tail: 'N28K', pilot: cfiUserId, hobbs: 1500, tach: 1400 },
  ];
  // The student's first two course lessons were flown dual in the 172, 18 and
  // 11 days ago (on both days the CFI's own Archer flight is that morning);
  // their check-in times, by lesson, date the training records (8a1).
  const lessonDaysAgo = [18, 11];
  const lessonFlownAt: Date[] = [];
  const backdated: { resId: string; ticketId: string }[] = [];
  try {
    const durChoices = [60, 90, 90, 120, 105, 75];
    // 56 flights: BOTH trainers fly once a day for the last 28 days. Pairing the
    // day index with the aircraft keeps one flight per tail per day, so there is
    // still no resource conflict — it just doubles the volume. Each flight is
    // isolated in its own try so one refusal never drops the rest.
    //
    // Owner (2026-09-02): the demo dashboard defaults to a 30-DAY window and was
    // reading 0 flights. The cause is not volume, it is age — these dates anchor
    // to the moment the seed RUNS, and the deployed database was last seeded
    // ~48 days earlier, so every flight had aged past 30 days. Filling 28 days
    // means a freshly seeded demo is full on arrival; it still needs re-seeding
    // periodically to stay that way.
    for (let k = 0; k < 56; k++) {
      const plan = histPlan[k % histPlan.length]!;
      const daysAgo = 28 - Math.floor(k / 2);
      const startH = 8 + (k % 7); // 08:00–14:00 local
      const durMin = durChoices[k % durChoices.length]!;
      const startAt = at(-daysAgo, startH);
      const endAt = new Date(startAt.getTime() + durMin * 60_000);
      // -1 unless this is one of the student's dual lessons.
      const lesson = plan.tail === 'N172SP' ? lessonDaysAgo.indexOf(daysAgo) : -1;
      try {
        const res = await createReservationWithDb(db, ownerSession, {
          startAt,
          endAt,
          resourceIds: lesson < 0 ? [tail(plan.tail)] : [tail(plan.tail), ids.instructorId],
          notes: lesson < 0 ? 'Training flight' : `Dual — ${lessonPlan[lesson]!.title.toLowerCase()}`,
        }, clock);
        if (!res.ok) continue;

        const durH = durMin / 60;
        const hobbsOut = Number(plan.hobbs.toFixed(1));
        const hobbsIn = Number((plan.hobbs + durH).toFixed(1));
        const tachOut = Number(plan.tach.toFixed(1));
        const tachIn = Number((plan.tach + durH * 0.95).toFixed(1));

        const op = await openDispatchWithDb(db, ownerSession, {
          reservationId: res.reservation.id,
          resourceId: tail(plan.tail),
          pilotUserId: plan.pilot,
          hobbsOut,
          tachOut,
        });
        if (!op.ok) continue;
        const cl = await closeDispatchWithDb(db, ownerSession, {
          ticketId: op.ticket.id,
          hobbsIn,
          tachIn,
        });
        if (!cl.ok) continue;

        plan.hobbs = tenths(hobbsIn + 0.4); // advance the running meter for this tail
        plan.tach = tenths(tachIn + 0.4);
        backdated.push({ resId: res.reservation.id, ticketId: op.ticket.id });
        if (lesson >= 0) lessonFlownAt[lesson] = endAt;
      } catch {
        // a single refused flight (e.g. a gate) is non-fatal — skip it.
        continue;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[demo] historical backfill: ${backdated.length} flights over ~24 days`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[demo] historical activity backfill skipped:', err);
  }

  // ── 8a1. The student's first two lessons (Slice T1) ────────────────────
  // Recorded complete by the CFI at the end of the dual flights above, so the
  // training record, and the CFI's lessons on Reports, rest on flights that
  // happened → 2/5 (40%) progress.
  for (const [i, lesson] of ppCourse.lessons.slice(0, 2).entries()) {
    const flownAt = lessonFlownAt[i];
    if (!flownAt) {
      throw new Error(`[demo] dual lesson "${lesson.title}" was not flown — seed cannot continue.`);
    }
    const recorded = await recordLessonWithDb(db, ownerSession, {
      enrollmentId,
      lessonId: lesson.lessonId,
      instructorUserId: cfiUserId,
      gradeLabel: 'Complete',
      completedAt: flownAt.toISOString(),
    });
    if (!recorded.ok) {
      throw new Error(`[demo] record lesson failed (${recorded.reason}) — seed cannot continue.`);
    }
  }

  // ── 8a2. Today's flights, as far as the seed clock has got ──────────────
  // Each picks up from its aircraft's last reading (the 152 has no history).
  // The CFI flies C as pilot in command, as the Archer's checkout requirement
  // asks; the student flies A and B.
  const todayFlights: TodayFlight[] = [
    { label: 'reservation A (172 dual)', booking: resA, aircraftId: tail('N172SP'), pilotUserId: ids.studentId,
      meter: histPlan[0]!, hobbsHours: 1.6, notes: 'Pre-flight complete' },
    { label: 'reservation B (152 solo)', booking: resB, aircraftId: tail('N152AB'), pilotUserId: ids.studentId,
      meter: { hobbs: 1875.4, tach: 1790.1 }, hobbsHours: 1.5 },
    { label: 'reservation C (Archer dual)', booking: resC, aircraftId: tail('N28K'), pilotUserId: cfiUserId,
      meter: histPlan[1]!, hobbsHours: 1.2 },
  ];
  const todayTickets: string[] = [];
  for (const flight of todayFlights) {
    const ticket = await flyAsOf(db, ownerSession, flight, now);
    if (ticket) todayTickets.push(ticket.ticketId);
  }

  // Date the flying, in ONE org-scoped context: each history booking was made
  // two hours ahead, and every ticket, today's included, was opened, closed and
  // created at its booked times. reservation and dispatch_ticket have UPDATE
  // policies; explicit org predicates.
  await withOrgContext(db, orgId, async (tx) => {
    if (backdated.length > 0) {
      const booked = backdated.map((b) => sql`${b.resId}::uuid`);
      await tx.execute(sql`
        UPDATE reservation SET created_at = start_at - interval '2 hours'
         WHERE org_id = ${orgId}::uuid AND id IN (${sql.join(booked, sql`, `)})`);
    }
    await dateTickets(tx, orgId, [...backdated.map((b) => b.ticketId), ...todayTickets]);
  });

  // ── 8b. Messages — operator announcements (demo/seed-upcoming.ts) ───────
  const managerUserId = ids.userIdByEmail.get('manager@alpha.aero')!;
  await seedAnnouncements(db, orgId, [
    {
      daysAgo: 12,
      hour: 9,
      sentBy: ids.ownerId,
      audience: 'all_active',
      subject: 'Welcome to the new scheduling system',
      body:
        'Everything now lives in one place: book aircraft and instructors from Schedule, check out ' +
        'and in on the Board, and report squawks from any aircraft page. Questions go to the front desk.',
    },
    {
      daysAgo: 6,
      hour: 16,
      sentBy: ids.ownerId,
      audience: 'all_active',
      subject: 'Cirrus N66RG is down for maintenance',
      body:
        'The SR20 is grounded for an oil seep at the quick-drain. A work order is open, and we will ' +
        'post here when it is back on the line. Until then, please move Cirrus flights to the 172 or the Archer.',
    },
    {
      daysAgo: 3,
      hour: 11,
      sentBy: managerUserId,
      audience: 'role',
      role: 'student',
      subject: 'Stage check slots this month',
      body:
        'Casey has stage check slots open on Tuesday and Thursday afternoons. Book one from the ' +
        'schedule, and bring your logbook and training records.',
    },
    {
      daysAgo: 1,
      hour: 18,
      sentBy: managerUserId,
      audience: 'all_active',
      subject: 'Ramp reminder',
      body:
        'Please leave aircraft tied down with the cowl plugs in, and enter your Hobbs and tach ' +
        'readings on the Board before you head out.',
    },
  ], now);

  // ── 8c. Second org — "Bravo Flying Club" (small club, slug `bravo`) ──
  await seedBravoClub(db, now);
}

// ─── Today's flights, as far as the seed clock has got (both orgs) ──────────

/** An aircraft's running Hobbs and tach: its next check-out reading. */
interface MeterRun {
  hobbs: number;
  tach: number;
}

/** One of today's bookings and who flies it (flyAsOf). */
interface TodayFlight {
  /** Names the flight in a refusal. */
  label: string;
  booking: CreatedReservation;
  aircraftId: string;
  pilotUserId: string;
  /** The aircraft's running meters, moved past the flight once it is over. */
  meter: MeterRun;
  /** Hobbs time logged once the flight is over; the tach logs 95% of it. */
  hobbsHours: number;
  notes?: string;
}

/**
 * flyAsOf — dispatch one booking only as far as the seed clock `now` has got,
 * so the seed never records a flight before it happens. Not started: no
 * ticket, and it stays a plain booking for a visitor to check out. Under way:
 * checked out. Over: checked out and back in, and the aircraft's meters move
 * on (plus a little ground running). Returns the ticket, with the tach it was
 * checked in at, or null. Refusals throw. The caller then dates the ticket to
 * its booked times (dateTickets).
 */
async function flyAsOf(
  db: AnyDb,
  session: AppSession,
  flight: TodayFlight,
  now: Date,
): Promise<{ ticketId: string; tachIn?: number } | null> {
  if (now < flight.booking.startAt) return null;
  const { meter } = flight;
  const opened = await mustOk(
    openDispatchWithDb(db, session, {
      reservationId: flight.booking.id,
      resourceId: flight.aircraftId,
      pilotUserId: flight.pilotUserId,
      hobbsOut: tenths(meter.hobbs),
      tachOut: tenths(meter.tach),
      ...(flight.notes ? { notes: flight.notes } : {}),
    }),
    `${flight.label} check-out`,
  );
  if (now < flight.booking.endAt) return { ticketId: opened.ticket.id };
  const hobbsIn = tenths(meter.hobbs + flight.hobbsHours);
  const tachIn = tenths(meter.tach + flight.hobbsHours * 0.95);
  await mustOk(
    closeDispatchWithDb(db, session, { ticketId: opened.ticket.id, hobbsIn, tachIn }),
    `${flight.label} check-in`,
  );
  meter.hobbs = tenths(hobbsIn + 0.3);
  meter.tach = tenths(tachIn + 0.3);
  return { ticketId: opened.ticket.id, tachIn };
}

/**
 * dateTickets — date dispatch tickets to their bookings, in one statement:
 * opened and created at the booked start, closed at the booked end if checked
 * in. Seed-only staging of tickets created above. dispatch_ticket has an
 * UPDATE policy, and the org predicates are explicit because the seed may run
 * as a superuser. `tx` must be org-scoped.
 */
async function dateTickets(tx: AnyDb, orgId: string, ticketIds: string[]): Promise<void> {
  if (ticketIds.length === 0) return;
  await tx.execute(sql`
    UPDATE dispatch_ticket dt
       SET opened_at = r.start_at, created_at = r.start_at,
           closed_at = CASE WHEN dt.status = 'closed' THEN r.end_at END
      FROM reservation r
     WHERE r.id = dt.reservation_id AND r.org_id = ${orgId}::uuid
       AND dt.org_id = ${orgId}::uuid
       AND dt.id IN (${sql.join(ticketIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
}

// ─── Bravo Flying Club: the roster and four weeks of flying ─────────────────

/** Handles for the Bravo roster, used below for pilots, bookers and reporters. */
type BravoKey =
  | 'jordan' | 'casey' | 'riley' | 'pat' | 'morgan' | 'dana' | 'lena' | 'marcus' | 'priya'
  | 'tom' | 'hannah' | 'victor' | 'ana' | 'ben' | 'jamie' | 'grace' | 'eli';

/** One member of the Bravo roster (see BRAVO_ROSTER). */
interface BravoMember extends DemoLogin {
  key: BravoKey;
  /**
   * "Member since" (membership.created_at). A calendar date is stored at 12:00
   * UTC, so it reads as that date from UTC-11 to UTC+11 (including the UTC
   * server that renders the portal). A number is days before today, on the
   * demo wall clock.
   */
  since: string | number;
  /** Has a credential (DEMO_PASSWORD). Without one, People shows "No login yet". */
  login: boolean;
  /** Roster flag (app_user.status); People lists inactive members under "Show inactive". */
  status?: 'inactive';
  /** Free-text operator labels with a palette color (no regulatory meaning). */
  tags: Array<[tag: string, color: MemberTagColor]>;
}

/**
 * The club's aircraft checkouts, as free-text operator labels (NOT FAA
 * endorsements). Pilots fly only the aircraft they hold the label for, and the
 * Warrior's dispatch requirement (seedBravoClub, step 5) matches its label.
 */
const SKYHAWK_CHECKOUT = 'Club checkout: N735BW';
const WARRIOR_CHECKOUT = 'Club checkout: N2189K';

const [BRAVO_OWNER, BRAVO_ADMIN, BRAVO_MEMBER] = DEMO_LOGINS_BRAVO as [DemoLogin, DemoLogin, DemoLogin];

/**
 * The Bravo roster: the three demo logins plus the rest of a small club (a
 * mechanic, a CFI, nine more renters, two of them new members, a student
 * pilot, and two members who have left). Fictional people, @example.com
 * addresses, 555 numbers, no avatars. Everyone with a login uses DEMO_PASSWORD,
 * but only the three @bravo.aero logins are advertised.
 */
const BRAVO_ROSTER: BravoMember[] = [
  { ...BRAVO_OWNER, key: 'jordan', since: '2011-04-02', login: true,
    tags: [['Board: president', 'violet'], [SKYHAWK_CHECKOUT, 'sky'], [WARRIOR_CHECKOUT, 'teal']] },
  { ...BRAVO_ADMIN, key: 'casey', since: '2013-09-14', login: true,
    tags: [['Board: scheduling', 'violet'], [SKYHAWK_CHECKOUT, 'sky'], [WARRIOR_CHECKOUT, 'teal']] },
  { ...BRAVO_MEMBER, key: 'riley', since: '2022-05-21', login: true,
    tags: [[SKYHAWK_CHECKOUT, 'sky']] },
  { key: 'pat', email: 'pat.okafor@example.com', fullName: 'Pat Okafor', role: 'mechanic', phone: '(614) 555-0211',
    since: '2014-03-08', login: true, tags: [['A&P/IA', 'amber'], ['Maintenance officer', 'violet']] },
  { key: 'morgan', email: 'morgan.ellis@example.com', fullName: 'Morgan Ellis', role: 'cfi', phone: '(614) 555-0212',
    since: '2016-06-11', login: true,
    tags: [['CFI/CFII', 'green'], ['Safety officer', 'violet'], [SKYHAWK_CHECKOUT, 'sky'], [WARRIOR_CHECKOUT, 'teal']] },
  { key: 'dana', email: 'dana.whitfield@example.com', fullName: 'Dana Whitfield', role: 'renter', phone: '(614) 555-0213',
    since: '2011-06-18', login: true,
    tags: [['Board: secretary', 'violet'], ['Instrument rated', 'green'], [SKYHAWK_CHECKOUT, 'sky'], [WARRIOR_CHECKOUT, 'teal']] },
  { key: 'lena', email: 'lena.park@example.com', fullName: 'Lena Park', role: 'renter', phone: '(614) 555-0214',
    since: '2019-08-03', login: true,
    tags: [['Instrument rated', 'green'], [SKYHAWK_CHECKOUT, 'sky'], [WARRIOR_CHECKOUT, 'teal']] },
  { key: 'marcus', email: 'marcus.bell@example.com', fullName: 'Marcus Bell', role: 'renter', phone: '(614) 555-0215',
    since: '2021-02-27', login: true, tags: [['Tailwheel', 'slate'], [SKYHAWK_CHECKOUT, 'sky']] },
  { key: 'priya', email: 'priya.raman@example.com', fullName: 'Priya Raman', role: 'renter', phone: '(614) 555-0216',
    since: '2018-10-06', login: true, tags: [[SKYHAWK_CHECKOUT, 'sky'], [WARRIOR_CHECKOUT, 'teal']] },
  { key: 'tom', email: 'tom.kowalski@example.com', fullName: 'Tom Kowalski', role: 'renter', phone: '(614) 555-0217',
    since: '2009-05-16', login: true, tags: [['Founding member', 'slate'], [WARRIOR_CHECKOUT, 'teal']] },
  { key: 'hannah', email: 'hannah.lee@example.com', fullName: 'Hannah Lee', role: 'renter', phone: '(614) 555-0218',
    since: '2015-07-25', login: true, tags: [[SKYHAWK_CHECKOUT, 'sky'], [WARRIOR_CHECKOUT, 'teal']] },
  { key: 'victor', email: 'victor.nguyen@example.com', fullName: 'Victor Nguyen', role: 'renter', phone: '(614) 555-0219',
    since: '2020-01-18', login: true, tags: [['Instrument rated', 'green'], [WARRIOR_CHECKOUT, 'teal']] },
  { key: 'ana', email: 'ana.ruiz@example.com', fullName: 'Ana Ruiz', role: 'renter', phone: '(614) 555-0220',
    since: 16, login: true, tags: [['New member: checkout in progress', 'amber']] },
  { key: 'ben', email: 'ben.carter@example.com', fullName: 'Ben Carter', role: 'renter', phone: '(614) 555-0221',
    since: 14, login: false, tags: [['New member: checkout in progress', 'amber']] },
  { key: 'jamie', email: 'jamie.tran@example.com', fullName: 'Jamie Tran', role: 'student', phone: '(614) 555-0222',
    since: '2024-09-07', login: true, tags: [['Student pilot', 'amber']] },
  { key: 'grace', email: 'grace.oneill@example.com', fullName: "Grace O'Neill", role: 'renter', phone: '(614) 555-0223',
    since: '2012-11-10', login: false, status: 'inactive', tags: [['On leave', 'slate']] },
  { key: 'eli', email: 'eli.moreno@example.com', fullName: 'Eli Moreno', role: 'renter', phone: '(614) 555-0224',
    since: '2017-04-22', login: false, status: 'inactive', tags: [['Moved away', 'slate']] },
];

/** BravoMember.since as the ISO timestamp stored in membership.created_at. */
function memberSince(since: string | number, now: Date): string {
  return typeof since === 'number' ? atLocal(-since, 10, 0, now).toISOString() : `${since}T12:00:00.000Z`;
}

/**
 * One past Bravo flight, on the demo wall clock. Instruction (checkouts, flight
 * reviews, lessons) books the CFI too and is dispatched to Morgan as the pilot
 * in command; everyone else flies an aircraft they hold the checkout label for.
 */
interface BravoPastFlight {
  daysAgo: number;
  tail: 'N735BW' | 'N2189K';
  hour: number;
  minutes: number;
  pilot: BravoKey;
  note: string;
  withCfi?: true;
}

/**
 * Four weeks of club flying, oldest first: 37 flights by eleven pilots over
 * the last 27 days, on both aircraft, with every day covered. At most one
 * flight per aircraft per day (Skyhawk mornings, Warrior afternoons) and one
 * with the CFI, so nothing collides, and the Skyhawk's evenings stay free for
 * the cancellations. Marcus last flies 14 days ago: his flight review reminder
 * lapsed 5 days ago, and he flies the review with Morgan tomorrow.
 */
const BRAVO_HISTORY: BravoPastFlight[] = [
  { daysAgo: 27, tail: 'N735BW', hour: 9, minutes: 60, pilot: 'riley', note: 'Riley — local flight' },
  { daysAgo: 27, tail: 'N2189K', hour: 13, minutes: 90, pilot: 'dana', note: 'Dana — KOSU ▸ KMNN and back' },
  { daysAgo: 26, tail: 'N735BW', hour: 10, minutes: 90, pilot: 'marcus', note: 'Marcus — pattern work' },
  { daysAgo: 25, tail: 'N735BW', hour: 11, minutes: 120, pilot: 'lena', note: 'Lena — KOSU ▸ KLCK and back' },
  { daysAgo: 24, tail: 'N735BW', hour: 9, minutes: 75, pilot: 'hannah', note: 'Hannah — practice area' },
  { daysAgo: 24, tail: 'N2189K', hour: 13, minutes: 90, pilot: 'morgan', note: 'Lesson — Jamie with Morgan', withCfi: true },
  { daysAgo: 23, tail: 'N735BW', hour: 10, minutes: 105, pilot: 'riley', note: 'Riley — KOSU ▸ KMNN and back' },
  { daysAgo: 23, tail: 'N2189K', hour: 15, minutes: 120, pilot: 'victor', note: 'Victor — KOSU ▸ KDLZ practice approaches' },
  { daysAgo: 22, tail: 'N735BW', hour: 11, minutes: 90, pilot: 'morgan', note: 'Flight review — Priya with Morgan', withCfi: true },
  { daysAgo: 21, tail: 'N735BW', hour: 9, minutes: 60, pilot: 'jordan', note: 'Jordan — local flight' },
  { daysAgo: 21, tail: 'N2189K', hour: 13, minutes: 105, pilot: 'hannah', note: 'Hannah — KOSU ▸ KLCK and back' },
  { daysAgo: 20, tail: 'N2189K', hour: 14, minutes: 90, pilot: 'tom', note: 'Tom — proficiency flight' },
  { daysAgo: 19, tail: 'N735BW', hour: 10, minutes: 90, pilot: 'riley', note: 'Riley — pattern work' },
  { daysAgo: 18, tail: 'N735BW', hour: 11, minutes: 120, pilot: 'dana', note: 'Dana — scenic flight' },
  { daysAgo: 18, tail: 'N2189K', hour: 15, minutes: 75, pilot: 'lena', note: 'Lena — pattern work' },
  { daysAgo: 17, tail: 'N2189K', hour: 13, minutes: 90, pilot: 'morgan', note: 'Lesson — Jamie with Morgan', withCfi: true },
  { daysAgo: 16, tail: 'N735BW', hour: 9, minutes: 105, pilot: 'priya', note: 'Priya — KOSU ▸ KMNN and back' },
  { daysAgo: 15, tail: 'N735BW', hour: 10, minutes: 120, pilot: 'riley', note: 'Riley — KOSU ▸ KLCK and back' },
  { daysAgo: 14, tail: 'N735BW', hour: 11, minutes: 75, pilot: 'marcus', note: 'Marcus — practice area' },
  { daysAgo: 14, tail: 'N2189K', hour: 13, minutes: 90, pilot: 'victor', note: 'Victor — proficiency flight' },
  { daysAgo: 13, tail: 'N735BW', hour: 9, minutes: 90, pilot: 'casey', note: 'Casey — scenic flight' },
  { daysAgo: 12, tail: 'N2189K', hour: 13, minutes: 90, pilot: 'morgan', note: 'Club checkout — Ana with Morgan', withCfi: true },
  { daysAgo: 11, tail: 'N735BW', hour: 10, minutes: 90, pilot: 'riley', note: 'Riley — practice area' },
  { daysAgo: 11, tail: 'N2189K', hour: 15, minutes: 120, pilot: 'dana', note: 'Dana — KOSU ▸ KDLZ practice approaches' },
  { daysAgo: 10, tail: 'N735BW', hour: 11, minutes: 60, pilot: 'hannah', note: 'Hannah — pattern work' },
  { daysAgo: 10, tail: 'N2189K', hour: 14, minutes: 105, pilot: 'jordan', note: 'Jordan — KOSU ▸ KMNN and back' },
  { daysAgo: 9, tail: 'N735BW', hour: 9, minutes: 105, pilot: 'lena', note: 'Lena — scenic flight' },
  { daysAgo: 8, tail: 'N2189K', hour: 13, minutes: 90, pilot: 'priya', note: 'Priya — local flight' },
  { daysAgo: 7, tail: 'N735BW', hour: 10, minutes: 120, pilot: 'riley', note: 'Riley — KOSU ▸ KMNN and back' },
  { daysAgo: 6, tail: 'N735BW', hour: 11, minutes: 90, pilot: 'dana', note: 'Dana — local flight' },
  { daysAgo: 6, tail: 'N2189K', hour: 15, minutes: 75, pilot: 'tom', note: 'Tom — pattern work' },
  { daysAgo: 5, tail: 'N2189K', hour: 13, minutes: 90, pilot: 'morgan', note: 'Club checkout — Ana with Morgan', withCfi: true },
  { daysAgo: 4, tail: 'N2189K', hour: 14, minutes: 120, pilot: 'lena', note: 'Lena — KOSU ▸ KMNN and back' },
  { daysAgo: 3, tail: 'N735BW', hour: 10, minutes: 75, pilot: 'jordan', note: 'Jordan — pattern work' },
  { daysAgo: 3, tail: 'N2189K', hour: 13, minutes: 90, pilot: 'morgan', note: 'Lesson — Jamie with Morgan', withCfi: true },
  { daysAgo: 2, tail: 'N735BW', hour: 11, minutes: 90, pilot: 'riley', note: 'Riley — touch and goes' },
  { daysAgo: 1, tail: 'N2189K', hour: 14, minutes: 90, pilot: 'hannah', note: 'Hannah — local flight' },
];

/** A meter reading, rounded to the tenth the Hobbs and tach record. */
function tenths(n: number): number {
  return Number(n.toFixed(1));
}

/**
 * seedBravoClub — the small-club counter-example org, built through the
 * SAME real write paths as Alpha above. Called once from seedDemo() so every
 * runner (bootstrap, reset, the real-Postgres script) gets both orgs for free.
 *
 * ORDER MATTERS: each gate goes in only after the rows it would refuse.
 *   1. the history, before the Warrior's booking policy exists (its 60-minute
 *      minimum lead refuses every past booking);
 *   2. an overnight trip that left yesterday, then today and the next two
 *      days, hand-placed, every Warrior booking still ahead of that policy
 *      (the lead refuses any of today's flights the seed clock has reached);
 *   3. the Warrior's booking policy, then the six-week forward schedule;
 *   4. today's dispatches, as far as the seed clock has got (flyAsOf);
 *   5. the Warrior's club-checkout dispatch requirement, LAST, so the gate can
 *      never refuse one of the seed's own dispatches.
 * Every refusal THROWS, like the forward schedule: the club must not thin out
 * silently on the live demo. Every time is on `now`, the seed's clock, and
 * nothing is dated after it.
 *
 * Roles do what they would in a real club: Casey (the scheduler) books and
 * dispatches for the members (renters cannot book in this app), Morgan books
 * the instruction, Pat keeps the maintenance records, and Jordan sets the
 * aircraft rules.
 *
 * RAW SQL: the seed runs as the PGlite superuser locally and in tests (RLS
 * bypassed) but as Neon's NON-superuser owner under FORCE RLS on the hosted
 * reset. So every raw statement carries explicit org_id predicates, and raw
 * UPDATEs touch only tables with an UPDATE policy (membership, reservation,
 * dispatch_ticket, squawk, work_order). The append-only tables (audit_log,
 * member_message, logbook_annotation, dispatch_service_log, …) are never
 * updated: on Neon that UPDATE would silently change 0 rows.
 */
async function seedBravoClub(db: AnyDb, now: Date): Promise<void> {
  /** A time on the demo wall clock, `day` days from the seed clock's today. */
  const at = (day: number, hour: number, minute = 0) => atLocal(day, hour, minute, now);
  /** The gates' clock: booking policies judge the seed's bookings at `now`. */
  const clock = { now: now.getTime() };

  // ── Control-plane: org + plan + active subscription ──────────────────────
  const orgRow = await withPlatformAdminContext(db, async (tx) => {
    const [o] = await tx
      .insert(org)
      .values({ name: 'Bravo Flying Club', slug: DEMO_SLUG_BRAVO, status: 'active' })
      .returning();
    // Idempotent on the (global, non-org-scoped) plan — shared with Alpha.
    const [p] = await tx
      .insert(plan)
      .values({ code: 'growth', name: 'Growth' })
      .onConflictDoUpdate({ target: plan.code, set: { name: 'Growth' } })
      .returning();
    await tx
      .insert(subscription)
      .values({ orgId: o!.id, planId: p!.id, status: 'active' })
      .returning();
    return o!;
  });
  const orgId = orgRow.id;

  // ── Tenant: roster + tags + join dates + club mode + base + fleet ────────
  const passwordHash = await demoPasswordHash();

  const ids = await withOrgContext(db, orgId, async (tx) => {
    const userIdByKey = new Map<BravoKey, string>();
    for (const m of BRAVO_ROSTER) {
      const [u] = await tx
        .insert(appUser)
        .values({ orgId, email: m.email, fullName: m.fullName, phone: m.phone, status: m.status ?? 'active' })
        .returning();
      await tx
        .insert(membership)
        .values({ orgId, userId: u!.id, role: m.role })
        .returning();
      if (m.login) {
        await tx
          .insert(authCredential)
          .values({ orgId, userId: u!.id, passwordHash })
          .returning();
      }
      userIdByKey.set(m.key, u!.id);
    }

    // Free-text member tags (operator labels ONLY — no computed currency/medical).
    for (const m of BRAVO_ROSTER) {
      for (const [tag, color] of m.tags) {
        await tx
          .insert(memberTag)
          .values({ orgId, userId: userIdByKey.get(m.key)!, tag, color, createdBy: userIdByKey.get('jordan')! });
      }
    }

    // "Member since" for the whole roster in ONE statement. membership has an
    // UPDATE policy, so this holds under FORCE RLS too.
    const joined = BRAVO_ROSTER.map(
      (m) => sql`(${userIdByKey.get(m.key)!}::uuid, ${memberSince(m.since, now)}::timestamptz)`,
    );
    await tx.execute(sql`
      UPDATE membership m SET created_at = v.since
        FROM (VALUES ${sql.join(joined, sql`, `)}) AS v(user_id, since)
       WHERE m.user_id = v.user_id AND m.org_id = ${orgId}::uuid`);

    // CLUB OPERATING MODE (migration 0047, GRACEFUL ABSENCE — no-ops pre-0047).
    // Training / public booking / auto-scheduler off; everything else on.
    await maybeSeedClubMode(tx, orgId);

    // No seeded avatars — demo users show the shared silhouette placeholder.

    // Home base — Bravo Field (KOSU), the same field Alpha uses.
    const [base] = await tx
      .insert(location)
      .values({
        orgId,
        name: 'Bravo Field',
        icao: 'KOSU',
        latitude: '40.07980',
        longitude: '-83.07300',
      })
      .returning();

    // Two aircraft — a small club's whole fleet. Both have Hobbs + tach.
    const aircraftSpecs = [
      { displayName: 'Cessna 172N Skyhawk', tailNumber: 'N735BW', make: 'Cessna', model: '172N Skyhawk', year: 1977, serialNumber: '17270123' },
      { displayName: 'Piper PA-28-161 Warrior II', tailNumber: 'N2189K', make: 'Piper', model: 'PA-28-161 Warrior II', year: 1979, serialNumber: '28-7916345' },
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
          hasHobbs: true,
          hasTach: true,
        })
        .returning();
      aircraftIdByTail.set(a.tailNumber, r!.id);
    }

    // The club CFI as a bookable instructor resource. Core scheduling, not the
    // (off) training module: checkouts, flight reviews and lessons book the
    // aircraft AND the instructor, and the Board gets an instructor row.
    const [instructor] = await tx
      .insert(resource)
      .values({
        orgId,
        kind: 'instructor',
        displayName: 'Morgan Ellis (CFI)',
        instructorUserId: userIdByKey.get('morgan')!,
      })
      .returning();

    return { userIdByKey, aircraftIdByTail, instructorId: instructor!.id };
  });

  const user = (key: BravoKey) => ids.userIdByKey.get(key)!;
  /** A roster member's session, to drive the real write paths as them. */
  const sessionAs = (key: BravoKey): AppSession => {
    const m = BRAVO_ROSTER.find((r) => r.key === key)!;
    return { user: { email: m.email }, userId: user(key), orgId, slug: DEMO_SLUG_BRAVO, role: m.role };
  };
  const ownerSession = sessionAs('jordan');
  const adminSession = sessionAs('casey');
  const cfiSession = sessionAs('morgan');
  const mechanicSession = sessionAs('pat');

  const tail = (t: string) => ids.aircraftIdByTail.get(t)!;
  const skyhawk = tail('N735BW');
  const warrior = tail('N2189K');

  // ── 1. Four weeks of history (BRAVO_HISTORY) ─────────────────────────────
  // Booked, checked out and checked in through the real gated paths, then
  // dated to the day it was flown (after step 4). Hobbs and tach climb per
  // aircraft into today's flights, so the Fleet page's meters never run
  // backwards.
  const meters = new Map<string, MeterRun>([
    [skyhawk, { hobbs: 845.0, tach: 806.0 }],
    [warrior, { hobbs: 4212.3, tach: 3998.6 }],
  ]);
  /** Each aircraft's last check-in tach: the Fleet page's current reading. */
  const lastTachIn = new Map<string, number>();
  const flown: Array<BravoPastFlight & { reservationId: string; ticketId: string; hobbsHours: number }> = [];
  for (const f of BRAVO_HISTORY) {
    const resourceId = tail(f.tail);
    const startAt = at(-f.daysAgo, f.hour);
    const booked = await mustCreate(
      createReservationWithDb(db, f.withCfi ? cfiSession : adminSession, {
        startAt,
        endAt: new Date(startAt.getTime() + f.minutes * 60_000),
        resourceIds: f.withCfi ? [resourceId, ids.instructorId] : [resourceId],
        notes: f.note,
      }, clock),
      `history "${f.note}" (${f.daysAgo} days ago)`,
    );
    const meter = meters.get(resourceId)!;
    const opened = await mustOk(
      openDispatchWithDb(db, adminSession, {
        reservationId: booked.id,
        resourceId,
        pilotUserId: user(f.pilot),
        hobbsOut: meter.hobbs,
        tachOut: meter.tach,
      }),
      `history check-out "${f.note}"`,
    );
    const hours = f.minutes / 60;
    const hobbsIn = tenths(meter.hobbs + hours);
    const tachIn = tenths(meter.tach + hours * 0.95);
    await mustOk(
      closeDispatchWithDb(db, adminSession, { ticketId: opened.ticket.id, hobbsIn, tachIn }),
      `history check-in "${f.note}"`,
    );
    flown.push({
      ...f,
      reservationId: booked.id,
      ticketId: opened.ticket.id,
      hobbsHours: tenths(hobbsIn - meter.hobbs),
    });
    lastTachIn.set(resourceId, tachIn);
    // A little ground running between flights.
    meter.hobbs = tenths(hobbsIn + 0.3);
    meter.tach = tenths(tachIn + 0.3);
  }

  // Three past cancellations with reasons, on free Skyhawk evenings, one in
  // each lead-time bucket of the Reports cancellations section.
  const pastCancellations = [
    { daysAgo: 20, note: 'Marcus — evening flight', reason: 'Weather: low ceilings at KOSU', leadMinutes: 3 * 60 },
    { daysAgo: 12, note: 'Hannah — evening flight', reason: 'Gusty crosswind, above my personal limits', leadMinutes: 90 },
    { daysAgo: 5, note: 'Priya — evening flight', reason: 'Schedule conflict, rebooked for the weekend', leadMinutes: 2 * 24 * 60 },
  ];
  const cancelled: Array<{ id: string; cancelledAt: Date }> = [];
  for (const c of pastCancellations) {
    const startAt = at(-c.daysAgo, 18);
    const booked = await mustCreate(
      createReservationWithDb(db, adminSession, {
        startAt,
        endAt: at(-c.daysAgo, 19, 30),
        resourceIds: [skyhawk],
        notes: c.note,
      }, clock),
      `cancelled booking "${c.note}"`,
    );
    await mustOk(
      cancelReservationWithDb(db, adminSession, { reservationId: booked.id, reason: c.reason }),
      `cancellation "${c.note}"`,
    );
    cancelled.push({ id: booked.id, cancelledAt: new Date(startAt.getTime() - c.leadMinutes * 60_000) });
  }

  // Line service and logbook notes: fuel (now and then oil) after every other
  // flight, entered at the desk, and cross-country time (the whole Hobbs time)
  // on the cross-countries, entered by each pilot on their own flight (members
  // annotate their own logbook from the portal). Both tables are append-only.
  for (const [i, f] of flown.entries()) {
    if (i % 2 === 0) {
      await mustOk(
        recordDispatchServiceWithDb(db, adminSession, {
          dispatchTicketId: f.ticketId,
          fuelAddedGallons: 12 + (i % 5) * 3,
          ...(i % 6 === 0 ? { oilAddedQuarts: 1 } : {}),
        }),
        `fuel uplift "${f.note}"`,
      );
    }
    if (f.note.includes('▸')) {
      await mustOk(
        annotateFlightWithDb(db, sessionAs(f.pilot), {
          dispatchTicketId: f.ticketId,
          crossCountryHours: f.hobbsHours,
          ...(f.note.includes('approaches')
            ? { instrumentHours: 0.8, remarks: 'Practice approaches at KDLZ with a safety pilot' }
            : { remarks: f.note.split(' — ')[1] }),
        }),
        `logbook note "${f.note}"`,
      );
    }
  }

  // ── 2. Today and the next two days (hand-placed) ─────────────────────────
  // Priya took the Skyhawk to Put-in-Bay yesterday afternoon and is due back
  // late morning, so right after the 03:00 reset the Board already has an
  // aircraft out. The Skyhawk has no booking policy, so a trip of a night is
  // within the club's own rules. Today, around it: a breakfast run in the
  // Warrior, Riley's currency flight once the Skyhawk is back, Lena's scenic
  // flight across mid-afternoon, and a new member's checkout with the CFI.
  // Step 4 checks each out and in as far as the seed clock has got.
  const overnightTrip = await mustCreate(
    createReservationWithDb(db, adminSession, {
      startAt: at(-1, 15),
      endAt: at(0, 11, 30),
      resourceIds: [skyhawk],
      notes: 'Priya — overnight to Put-in-Bay (3W2)',
    }, clock),
    'reservation (Skyhawk, overnight trip)',
  );
  const breakfastRun = await mustCreate(
    createReservationWithDb(db, adminSession, {
      startAt: at(0, 10),
      endAt: at(0, 12),
      resourceIds: [warrior],
      notes: 'Dana — breakfast run to KMNN',
    }, clock),
    'reservation (Warrior, this morning)',
  );
  const currencyFlight = await mustCreate(
    createReservationWithDb(db, adminSession, {
      startAt: at(0, 12, 30),
      endAt: at(0, 13, 30),
      resourceIds: [skyhawk],
      notes: 'Riley — club currency flight',
    }, clock),
    'reservation (Skyhawk, midday)',
  );
  const scenicFlight = await mustCreate(
    createReservationWithDb(db, adminSession, {
      startAt: at(0, 14),
      endAt: at(0, 16),
      resourceIds: [skyhawk],
      notes: 'Lena — scenic flight',
    }, clock),
    'reservation (Skyhawk, this afternoon)',
  );
  const benCheckout = await mustCreate(
    createReservationWithDb(db, cfiSession, {
      startAt: at(0, 16, 30),
      endAt: at(0, 18),
      resourceIds: [warrior, ids.instructorId],
      notes: 'Club checkout — Ben with Morgan',
    }, clock),
    'reservation (Warrior checkout, today)',
  );

  // Tomorrow: Marcus flies his flight review on the Skyhawk (his reminder
  // lapsed, see the expirations below), then the regular flying.
  await mustCreate(
    createReservationWithDb(db, cfiSession, {
      startAt: at(1, 8),
      endAt: at(1, 9, 30),
      resourceIds: [skyhawk, ids.instructorId],
      notes: 'Flight review — Marcus with Morgan',
    }, clock),
    'reservation (flight review, tomorrow)',
  );
  await mustCreate(
    createReservationWithDb(db, adminSession, {
      startAt: at(1, 10),
      endAt: at(1, 11, 30),
      resourceIds: [skyhawk],
      notes: 'Riley — pattern work',
    }, clock),
    'reservation (Skyhawk, tomorrow)',
  );
  await mustCreate(
    createReservationWithDb(db, adminSession, {
      startAt: at(1, 13),
      endAt: at(1, 15),
      resourceIds: [warrior],
      notes: 'Victor — proficiency flight',
    }, clock),
    'reservation (Warrior, tomorrow)',
  );

  // The day after: Riley's Warrior checkout. Riley holds only the Skyhawk
  // checkout, which is why the Warrior's requirement (step 5) refuses Riley as
  // its pilot until then.
  await mustCreate(
    createReservationWithDb(db, cfiSession, {
      startAt: at(2, 14),
      endAt: at(2, 15, 30),
      resourceIds: [warrior, ids.instructorId],
      notes: 'Riley — Warrior checkout with Morgan',
    }, clock),
    'reservation (Warrior checkout, day after tomorrow)',
  );
  await mustCreate(
    createReservationWithDb(db, adminSession, {
      startAt: at(2, 17, 30),
      endAt: at(2, 19),
      resourceIds: [skyhawk],
      notes: 'Hannah — evening pattern work',
    }, clock),
    'reservation (Skyhawk, day after tomorrow)',
  );

  // ── 3. Booking policy on the Warrior, then the coming six weeks ──────────
  await mustOk(
    upsertBookingPolicyWithDb(db, ownerSession, {
      resourceId: warrior,
      maxDurationMinutes: 240,
      maxAdvanceDays: 45,
      minAdvanceMinutes: 60,
    }),
    'booking policy (Warrior)',
  );

  // Club flying from day 3 (days 0–2 are hand-placed above): weekends, weekday
  // evenings, a Tuesday morning and the CFI on Thursday mornings, so every day
  // of the six weeks has flying. One block per aircraft per time band; any
  // collision throws. Within the Warrior's policy (≤ 4 h, ≤ 45 days out).
  // Casey books for the members, Jordan books Jordan's own flights, and Morgan
  // books the instruction.
  await seedUpcomingReservations(
    db,
    adminSession,
    [
      {
        weekdays: [6],
        hour: 9,
        durationMinutes: 180,
        resourceIds: [skyhawk],
        notes: ['Riley — weekend XC', 'Riley — breakfast flight to KMNN'],
      },
      {
        weekdays: [6],
        hour: 13,
        durationMinutes: 180,
        resourceIds: [warrior],
        notes: ['Casey — local flight', 'Casey — currency flight'],
      },
      {
        weekdays: [0],
        hour: 14,
        durationMinutes: 120,
        resourceIds: [skyhawk],
        notes: ['Riley — touch and goes'],
      },
      {
        weekdays: [1],
        hour: 17,
        minute: 30,
        durationMinutes: 90,
        resourceIds: [skyhawk],
        notes: ['Hannah — evening pattern work', 'Dana — night landings'],
      },
      {
        weekdays: [2],
        hour: 9,
        durationMinutes: 120,
        resourceIds: [warrior],
        notes: ['Tom — weekday local flight', 'Priya — proficiency flight'],
      },
      {
        weekdays: [3],
        hour: 17,
        minute: 30,
        durationMinutes: 90,
        resourceIds: [skyhawk],
        notes: ['Riley — evening pattern work'],
      },
      {
        weekdays: [4],
        hour: 17,
        minute: 30,
        durationMinutes: 90,
        resourceIds: [skyhawk],
        notes: ['Marcus — evening flight', 'Lena — evening flight'],
      },
      {
        weekdays: [5],
        hour: 16,
        durationMinutes: 120,
        resourceIds: [warrior],
        notes: ['Casey — sunset flight'],
      },
    ],
    { firstDay: 3, lastDay: UPCOMING_DAYS },
    now,
  );
  await seedUpcomingReservations(
    db,
    ownerSession,
    [
      {
        weekdays: [0],
        hour: 9,
        durationMinutes: 120,
        resourceIds: [warrior],
        notes: ['Jordan — Sunday flight', 'Jordan — proficiency flight'],
      },
    ],
    { firstDay: 3, lastDay: UPCOMING_DAYS },
    now,
  );
  await seedUpcomingReservations(
    db,
    cfiSession,
    [
      {
        weekdays: [4],
        hour: 9,
        durationMinutes: 90,
        resourceIds: [warrior, ids.instructorId],
        notes: [
          'Flight review — Hannah with Morgan',
          'Club checkout — Ana with Morgan',
          'Lesson — Jamie with Morgan',
        ],
      },
    ],
    { firstDay: 3, lastDay: UPCOMING_DAYS },
    now,
  );

  // One future cancellation, more than a week out (06:30 is clear of every
  // Skyhawk slot on any weekday).
  const callOff = await mustCreate(
    createReservationWithDb(db, adminSession, {
      startAt: at(9, 6, 30),
      endAt: at(9, 8),
      resourceIds: [skyhawk],
      notes: 'Lena — early local flight',
    }, clock),
    'reservation (Skyhawk, later cancelled)',
  );
  await mustOk(
    cancelReservationWithDb(db, adminSession, {
      reservationId: callOff.id,
      reason: 'Member traveling, will rebook',
    }),
    'future cancellation',
  );

  // ── 4. Today's dispatches, as far as the seed clock has got (flyAsOf) ─────
  // In time order, each picking up from its aircraft's last reading. Right
  // after the 03:00 reset only the overnight trip is out; by 15:00 it and the
  // morning's flights are checked in and Lena has the Skyhawk out; by evening
  // everything is in. Morgan flies Ben's checkout as pilot in command.
  const todayFlights: TodayFlight[] = [
    { label: 'bravo overnight trip (Skyhawk)', booking: overnightTrip, aircraftId: skyhawk,
      pilotUserId: user('priya'), meter: meters.get(skyhawk)!, hobbsHours: 2.4 },
    { label: 'bravo breakfast run (Warrior)', booking: breakfastRun, aircraftId: warrior,
      pilotUserId: user('dana'), meter: meters.get(warrior)!, hobbsHours: 1.1 },
    { label: 'bravo currency flight (Skyhawk)', booking: currencyFlight, aircraftId: skyhawk,
      pilotUserId: user('riley'), meter: meters.get(skyhawk)!, hobbsHours: 0.9, notes: 'Pre-flight complete' },
    { label: 'bravo scenic flight (Skyhawk)', booking: scenicFlight, aircraftId: skyhawk,
      pilotUserId: user('lena'), meter: meters.get(skyhawk)!, hobbsHours: 1.7 },
    { label: 'bravo checkout (Warrior)', booking: benCheckout, aircraftId: warrior,
      pilotUserId: user('morgan'), meter: meters.get(warrior)!, hobbsHours: 1.3 },
  ];
  const todayTickets: string[] = [];
  for (const flight of todayFlights) {
    const ticket = await flyAsOf(db, adminSession, flight, now);
    if (!ticket) continue;
    todayTickets.push(ticket.ticketId);
    if (ticket.tachIn !== undefined) lastTachIn.set(flight.aircraftId, ticket.tachIn);
  }

  // Date the flying, in ONE org-scoped context: each past booking was made 1–6
  // days ahead (the overnight trip six), every ticket, today's included, was
  // opened and closed at its booked times (created_at with it, so a
  // newest-first list by either column starts with today's flights), and each
  // cancelled booking was made a week ahead and called off at its lead time.
  // Seed-only staging of rows created above, like Alpha's history.
  await withOrgContext(db, orgId, async (tx) => {
    const leads = [
      ...flown.map((f, i) => sql`(${f.reservationId}::uuid, ${1 + (i % 6)}::int)`),
      sql`(${overnightTrip.id}::uuid, ${6}::int)`,
    ];
    await tx.execute(sql`
      UPDATE reservation r SET created_at = r.start_at - make_interval(days => v.lead_days)
        FROM (VALUES ${sql.join(leads, sql`, `)}) AS v(id, lead_days)
       WHERE r.id = v.id AND r.org_id = ${orgId}::uuid`);
    await dateTickets(tx, orgId, [...flown.map((f) => f.ticketId), ...todayTickets]);
    const calledOff = cancelled.map((c) => sql`(${c.id}::uuid, ${c.cancelledAt.toISOString()}::timestamptz)`);
    await tx.execute(sql`
      UPDATE reservation r
         SET created_at = r.start_at - interval '7 days', cancelled_at = v.cancelled_at
        FROM (VALUES ${sql.join(calledOff, sql`, `)}) AS v(id, cancelled_at)
       WHERE r.id = v.id AND r.org_id = ${orgId}::uuid`);
  });

  // ── Maintenance: squawk history, work orders, items coming due ───────────
  // Low/medium squawks only and nothing grounded, so the club stays flyable.
  // Operator maintenance records; NO computed Part-43 / airworthiness
  // determination ('completed' is not a return to service).
  const tire = await mustOk(
    reportSquawkWithDb(db, ownerSession, {
      resourceId: warrior,
      title: 'Right main tire showing wear',
      description: 'Noted during preflight walkaround. Keep an eye on it before the next annual.',
      severity: 'low',
    }),
    'bravo squawk (tire)',
  );
  const light = await mustOk(
    reportSquawkWithDb(db, cfiSession, {
      resourceId: skyhawk,
      title: 'Landing light inoperative',
      description: 'Found on the preflight walkaround.',
      severity: 'medium',
    }),
    'bravo squawk (landing light)',
  );
  const door = await mustOk(
    reportSquawkWithDb(db, adminSession, {
      resourceId: skyhawk,
      title: 'Cabin door seal whistles in cruise',
      severity: 'low',
    }),
    'bravo squawk (door seal)',
  );
  const lastSkyhawkFlight = flown.filter((f) => f.tail === 'N735BW').at(-1)!;
  const jack = await mustOk(
    reportSquawkWithDb(db, adminSession, {
      resourceId: skyhawk,
      title: 'Right-seat headset jack crackles',
      description: 'Intermittent static on the right-seat jack, noticed after the flight. Left seat is fine.',
      severity: 'low',
      dispatchTicketId: lastSkyhawkFlight.ticketId,
    }),
    'bravo squawk (headset jack)',
  );
  await mustOk(
    updateSquawkStatusWithDb(db, mechanicSession, {
      squawkId: door.squawk.id,
      status: 'deferred',
      resolutionNotes: 'Seal is on order; Pat will fit it at the next annual.',
    }),
    'bravo squawk deferral (door seal)',
  );
  const lampOrder = await mustOk(
    openWorkOrderWithDb(db, mechanicSession, {
      resourceId: skyhawk,
      squawkId: light.squawk.id,
      title: 'Replace landing light lamp',
    }),
    'bravo work order (landing light)',
  );
  const lampDone = await mustOk(
    completeWorkOrderWithDb(db, mechanicSession, {
      workOrderId: lampOrder.workOrder.id,
      workPerformed: 'Replaced the landing light lamp. Light checks good.',
      resolveSquawk: true,
      squawkResolutionNotes: 'Lamp replaced.',
    }),
    'bravo work order completion (landing light)',
  );
  if (!lampDone.squawk) {
    throw new Error('[demo] bravo landing-light squawk was not resolved — seed cannot continue.');
  }
  const tireOrder = await mustOk(
    openWorkOrderWithDb(db, mechanicSession, {
      resourceId: warrior,
      squawkId: tire.squawk.id,
      title: 'Replace right main tire',
      description: 'Tire and tube on order. Pat will fit them at the annual unless the wear gets worse first.',
    }),
    'bravo work order (tire)',
  );
  await mustOk(
    updateWorkOrderStatusWithDb(db, mechanicSession, { workOrderId: tireOrder.workOrder.id, status: 'in_progress' }),
    'bravo work order in progress (tire)',
  );

  // Date the maintenance records like the history: the landing light found two
  // weeks ago and fixed two days later, the door seal deferred last week, the
  // tire and the headset jack found this week. squawk and work_order have
  // UPDATE policies; explicit org predicates.
  await withOrgContext(db, orgId, async (tx) => {
    const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;
    await tx.execute(sql`
      UPDATE squawk SET reported_at = ${ts(at(-14, 8, 40))}, resolved_at = ${ts(at(-12, 15, 30))}
       WHERE id = ${light.squawk.id}::uuid AND org_id = ${orgId}::uuid`);
    await tx.execute(sql`
      UPDATE work_order SET opened_at = ${ts(at(-13, 14))}, signed_off_at = ${ts(at(-12, 15, 30))}
       WHERE id = ${lampOrder.workOrder.id}::uuid AND org_id = ${orgId}::uuid`);
    await tx.execute(sql`
      UPDATE squawk SET reported_at = ${ts(at(-9, 12, 10))}, resolved_at = ${ts(at(-8, 16))}
       WHERE id = ${door.squawk.id}::uuid AND org_id = ${orgId}::uuid`);
    await tx.execute(sql`
      UPDATE squawk SET reported_at = ${ts(at(-3, 17, 15))}
       WHERE id = ${tire.squawk.id}::uuid AND org_id = ${orgId}::uuid`);
    await tx.execute(sql`
      UPDATE work_order SET opened_at = ${ts(at(-2, 9, 30))}
       WHERE id = ${tireOrder.workOrder.id}::uuid AND org_id = ${orgId}::uuid`);
    await tx.execute(sql`
      UPDATE squawk SET reported_at = ${ts(at(-2, 13, 20))}
       WHERE id = ${jack.squawk.id}::uuid AND org_id = ${orgId}::uuid`);
  });

  // Maintenance-due items: two due soon (the Skyhawk's oil change, the
  // Warrior's annual), none overdue, so the demo never shows the club flying
  // past one of its own limits. Hour thresholds sit above each aircraft's
  // last recorded tach, however far today's flights have got; dates are on the
  // demo wall clock.
  // [VERIFY-DEMO-MX] Operator-entered tracking, not an FAA determination: the
  // titles name the club's own reminders (annual inspection, ELT battery,
  // transponder and pitot-static check), and the app only compares these
  // thresholds with the last recorded meters and today's date.
  const maintenanceItems = [
    { resourceId: skyhawk, title: 'Oil change (50 hr)', trackBy: 'hours', meterBasis: 'tach', dueValueHours: tenths(lastTachIn.get(skyhawk)! + 3.8), warnThresholdHours: 10 },
    { resourceId: skyhawk, title: 'Annual inspection', trackBy: 'date', dueDate: localDateAt(118, now), warnLeadDays: 30 },
    { resourceId: skyhawk, title: 'ELT battery', trackBy: 'date', dueDate: localDateAt(300, now), warnLeadDays: 30 },
    { resourceId: warrior, title: 'Annual inspection', trackBy: 'date', dueDate: localDateAt(21, now), warnLeadDays: 30, notes: 'Pat has it on the calendar.' },
    { resourceId: warrior, title: 'Oil change (50 hr)', trackBy: 'hours', meterBasis: 'tach', dueValueHours: tenths(lastTachIn.get(warrior)! + 30), warnThresholdHours: 10 },
    { resourceId: warrior, title: 'Transponder and pitot-static check', trackBy: 'date', dueDate: localDateAt(200, now), warnLeadDays: 60 },
  ];
  for (const item of maintenanceItems) {
    await mustOk(createMaintenanceItemWithDb(db, mechanicSession, item), `maintenance item "${item.title}"`);
  }

  // ── Member expirations (warn-only reminders) ─────────────────────────────
  // [VERIFY-FC-P2-A] Operator-entered reminder dates, NOT a medical, currency
  // or legal determination; they warn at check-out and never block it. Three
  // fall due within 30 days; Marcus's flight review lapsed five days ago (he
  // last flew two weeks ago and flies the review tomorrow); Grace is on leave.
  const expirations: Array<[BravoKey, string, number]> = [
    ['riley', 'Medical', 240],
    ['riley', 'Flight review', 400],
    ['dana', 'Medical', 25],
    ['dana', 'Flight review', 300],
    ['marcus', 'Flight review', -5],
    ['marcus', 'Medical', 500],
    ['lena', 'Medical', 600],
    ['lena', 'Club annual checkout', 12],
    ['tom', 'Medical', 90],
    ['priya', 'Club annual checkout', 200],
    ['hannah', 'Medical', 27],
    ['victor', 'Flight review', 150],
    ['grace', 'Medical', -60],
  ];
  for (const [key, label, inDays] of expirations) {
    await mustOk(
      addMemberExpirationWithDb(db, adminSession, {
        memberUserId: user(key),
        label,
        expiresOn: localDateAt(inDays, now),
      }),
      `expiration "${label}" (${key})`,
    );
  }

  // ── 5. The Warrior's club-checkout requirement (Slice 3c gate) ───────────
  // LAST, after every seeded dispatch. Operator label only — NOT an FAA
  // endorsement. On the Board, Dana and Morgan pass; Riley is refused.
  await mustOk(
    addResourceRequiredTagWithDb(db, ownerSession, { resourceId: warrior, requiredTag: WARRIOR_CHECKOUT }),
    'dispatch requirement (Warrior checkout)',
  );

  // ── Messages — club announcements (demo/seed-upcoming.ts) ────────────────
  await seedAnnouncements(db, orgId, [
    {
      daysAgo: 13,
      hour: 18,
      sentBy: user('jordan'),
      audience: 'all_active',
      subject: 'Welcome Ana and Ben',
      body:
        'Please welcome our two newest members, Ana Ruiz and Ben Carter. Morgan is flying their ' +
        'club checkouts, so say hello at the hangar.',
    },
    {
      daysAgo: 9,
      hour: 10,
      sentBy: user('jordan'),
      audience: 'all_active',
      subject: 'Club scheduling has moved',
      body:
        'Book the Skyhawk and the Warrior from Reservations, and squawk anything you find from the ' +
        'aircraft page. Questions go to Casey.',
    },
    {
      daysAgo: 6,
      hour: 12,
      sentBy: user('casey'),
      audience: 'all_active',
      subject: 'Fly-in breakfast at KMNN',
      body:
        'A group is flying up to Marion for the breakfast fly-in. If you have a seat to spare or ' +
        'would like to ride along, tell me and I will pair people up.',
    },
    {
      daysAgo: 4,
      hour: 19,
      sentBy: user('jordan'),
      audience: 'all_active',
      subject: 'Club meeting Thursday at 7 pm',
      body: 'In the hangar. On the agenda: a fleet update and fly-in planning. Bring ideas for the next club trip.',
    },
    {
      daysAgo: 2,
      hour: 9,
      sentBy: user('casey'),
      audience: 'all_active',
      subject: 'Warrior annual inspection',
      body:
        "Pat has the Warrior's annual inspection on the calendar in about three weeks. Expect it to " +
        'be down for a couple of days; I will move any bookings it affects.',
    },
    {
      daysAgo: 1,
      hour: 8,
      sentBy: user('casey'),
      audience: 'all_active',
      subject: 'Warrior tire wear',
      body:
        'There is an open squawk on N2189K for wear on the right main tire. It is still flying, but ' +
        'please give it a good look on your preflight and add a note to the squawk if it gets worse.',
    },
  ], now);

  // ── When the coming bookings were made ───────────────────────────────────
  // Everything from today on was created just now, which would stand as one
  // tall bar on the dashboard's reservations-vs-flights chart. Spread the
  // booking dates over the previous two weeks instead: the n-th booking, in
  // start order, was made 1 + (n mod 13) days and (n mod 9) hours before the
  // seed clock, so before it starts. reservation has an UPDATE policy;
  // explicit org predicates.
  await withOrgContext(db, orgId, async (tx) => {
    await tx.execute(sql`
      UPDATE reservation r
         SET created_at = ${now.toISOString()}::timestamptz
                          - make_interval(days => 1 + (b.n % 13)::int, hours => (b.n % 9)::int)
        FROM (SELECT id, row_number() OVER (ORDER BY start_at, id) AS n
                FROM reservation
               WHERE org_id = ${orgId}::uuid
                 AND start_at >= ${at(0, 0).toISOString()}::timestamptz) b
       WHERE r.id = b.id AND r.org_id = ${orgId}::uuid`);
  });
}

/** Assert a createReservation result succeeded, returning the new reservation. */
async function mustCreate(
  p: Promise<CreateReservationResult>,
  label: string,
): Promise<CreatedReservation> {
  const r = await p;
  if (!r.ok) {
    throw new Error(`[demo] ${label} was refused (${r.reason}) — seed cannot continue.`);
  }
  return r.reservation;
}

/** Assert a generic {ok} result succeeded, returning it. */
async function mustOk<T extends { ok: boolean }>(
  p: Promise<T>,
  label: string,
): Promise<Extract<T, { ok: true }>> {
  const r = await p;
  if (!r.ok) {
    const reason = (r as { reason?: unknown }).reason;
    throw new Error(`[demo] ${label} failed (${String(reason)}) — seed cannot continue.`);
  }
  return r as Extract<T, { ok: true }>;
}
