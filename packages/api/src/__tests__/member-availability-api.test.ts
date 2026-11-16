/**
 * member-availability-api.test.ts — listMemberAvailability, the read behind the
 * member Schedule (/o/[slug]/portal/schedule). pglite + *WithDb forms; every
 * migration through 0051.
 *
 * Renters and students cannot book, so they could not tell when an aircraft is
 * free. This read shows them — and THE POINT IS PRIVACY: someone else's booking
 * says only WHEN a resource is taken. These pin:
 *
 *   MA1 — capability gate: portal:access (renter, student; owner and manager
 *         may call it too); cfi / dispatcher / mechanic / accountant refused;
 *         a portal-only role still cannot call the staff listReservations.
 *   MA2 — resources: active aircraft (tail #, make/model, bare grounded state)
 *         and instructors only, aircraft first; no grounding reason.
 *   MA3 — redaction: another member's booking and a blackout are EXACTLY
 *         { resourceId, startAt, endAt, kind } — no user id, name, notes,
 *         series or reservation id anywhere in the result; a client-supplied
 *         userId is ignored.
 *   MA4 — mine detection, all three links: created_by = me, member_user_id =
 *         me, a non-voided dispatch with pilot_user_id = me (a voided one is
 *         not); each mine interval carries its notes + resource labels.
 *   MA5 — cancelled bookings excluded.
 *   MA6 — window edges, half-open: ends-at-from and starts-at-to excluded,
 *         straddles included and returned whole; same for blackouts.
 *   MA7 — tenant isolation: org B never sees org A, and vice versa.
 *   MA8 — window validation (bounded input).
 *   MA9 — empties: nothing that day → no intervals; no resources → empty.
 *
 * NO writes by the read, NO audit, NO money, NO migration.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  withPlatformAdminContext,
  seedTwoOrgs,
  loadMigrationSql,
  appUser,
  membership,
  org,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb, deactivateResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { cancelReservationWithDb } from '../scheduling/cancel-reservation.js';
import { createBlackoutWithDb } from '../scheduling/blackout-commands.js';
import { createSeriesWithDb } from '../scheduling/create-series.js';
import { listSeriesOccurrencesWithDb } from '../scheduling/list-series-occurrences.js';
import { listReservationsWithDb } from '../scheduling/list-reservations.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { voidDispatchWithDb } from '../dispatch/void-dispatch.js';
import { groundAircraftWithDb, unGroundAircraftWithDb } from '../maintenance/ground-aircraft.js';
import { updateAircraftWithDb } from '../fleet/update-aircraft.js';
import { listMemberAvailabilityWithDb } from '../portal/list-member-availability.js';
import type {
  MemberAvailabilityInterval,
  MemberAvailabilityMyInterval,
  MemberAvailabilityResult,
} from '../portal/list-member-availability.js';
import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';
import { extractRows } from '../db-rows.js';

const MIGRATION_SQL = loadMigrationSql('0051');

function makeSession(orgId: string, userId: string, role: AppSession['role']): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

/**
 * A UTC instant `dayOffset` days from D = Monday 2031-03-10 (fixed and far
 * ahead: no booking policy is set, so any time books, and nothing ages out).
 */
const at = (dayOffset: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2031, 2, 10 + dayOffset, hour, minute, 0));

/** The day D in UTC: [D 00:00, D+1 00:00). */
const DAY = { from: at(0, 0), to: at(1, 0) };

interface Env {
  db: PgliteTestClient;
  orgAId: string;
  orgBId: string;
  orgCId: string;
  ownerAId: string;
  ownerBId: string;
  managerAId: string;
  cfiAId: string;
  rileyId: string; // org-A renter: the caller in most tests
  samId: string; // org-A student
  beaId: string; // org-A renter: "someone else"
  boId: string; // org-B renter
  cleoId: string; // org-C renter (an org with no resources)
  // org-A resources
  ac101: string; // NMS101 — Cessna 172S
  ac102: string; // NMS102 — no make/model
  acGrounded: string; // NMSGRD — grounded
  acReleased: string; // NMSREL — grounded, then released
  acOld: string; // NMSOLD — deactivated (had a booking)
  acEdge1: string; // NMSEDGE1 — window edges
  acEdge2: string; // NMSEDGE2 — straddles + blackouts
  acSeries: string; // NMSSER — a recurring series for Bea
  instructor: string; // "Casey Example (CFI)"
  simId: string; // a sim (never listed)
  // org-B
  acBeta: string; // NBETA1
  // reservation ids / series ids that must never leak
  otherResId: string; // owner → for Bea, NMS101 09:00–11:00
  myCreatedResId: string; // created_by = Riley, NMS102 13:00–14:00
  myForResId: string; // owner → for Riley, NMS101 + instructor 15:00–17:00
  myPilotResId: string; // owner, no member; Riley dispatched pilot, NMS102 18:00–19:00
  voidedPilotResId: string; // owner; Riley's dispatch voided, NMS102 20:00–21:00
  cancelledResId: string; // owner → for Riley, NMS101 06:00–07:00, cancelled
  oldResId: string; // NMSOLD 10:00–11:00, then NMSOLD deactivated
  betaResId: string; // org B: owner → for Bo, NBETA1 09:00–10:00
  seriesId: string;
  seriesOccurrenceIds: string[];
}

let env: Env;

const OTHER_NOTES = 'Bea checkride prep (private note)';
const BLACKOUT_REASON = 'Instructor family leave (private reason)';
const GROUNDING_REASON = 'Oil leak at the left magneto (private reason)';

async function seedMember(
  db: PgliteTestClient,
  orgId: string,
  email: string,
  role: AppSession['role'],
  fullName: string,
): Promise<string> {
  return withOrgContext(db, orgId, async (tx) => {
    const [usr] = await tx
      .insert(appUser)
      .values({ orgId, email, fullName, status: 'active' })
      .returning();
    await tx.insert(membership).values({ orgId, userId: usr!.id, role });
    return usr!.id;
  });
}

async function aircraft(orgId: string, ownerId: string, tail: string): Promise<string> {
  const r = await createResourceWithDb(env.db, makeSession(orgId, ownerId, 'owner'), {
    kind: 'aircraft',
    displayName: `Aircraft ${tail}`,
    tailNumber: tail,
  });
  return r.id;
}

/** Books via `bookerId`'s session (created_by = bookerId). Returns the reservation id. */
async function book(
  orgId: string,
  bookerId: string,
  resourceIds: string[],
  startAt: Date,
  endAt: Date,
  extra: { notes?: string; memberUserId?: string } = {},
): Promise<string> {
  const r = await createReservationWithDb(env.db, makeSession(orgId, bookerId, 'owner'), {
    startAt,
    endAt,
    resourceIds,
    ...extra,
  });
  if (!r.ok) throw new Error(`seed booking failed: ${r.reason}`);
  return r.reservation.id;
}

/** Riley's view of a window (default: the day D). */
async function asRiley(window = DAY): Promise<MemberAvailabilityResult> {
  return listMemberAvailabilityWithDb(env.db, makeSession(env.orgAId, env.rileyId, 'renter'), window);
}

function onResource(result: MemberAvailabilityResult, resourceId: string): MemberAvailabilityInterval[] {
  return result.intervals.filter((i) => i.resourceId === resourceId);
}

function startingAt(
  result: MemberAvailabilityResult,
  resourceId: string,
  startAt: Date,
): MemberAvailabilityInterval | undefined {
  return onResource(result, resourceId).find((i) => i.startAt.getTime() === startAt.getTime());
}

function asMine(i: MemberAvailabilityInterval | undefined): MemberAvailabilityMyInterval {
  expect(i?.mine).toBe(true);
  return i as MemberAvailabilityMyInterval;
}

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  // A third org with members but no resources at all (MA9).
  const orgCId = await withPlatformAdminContext(db, async (tx) => {
    const [c] = await tx.insert(org).values({ name: 'Gamma Field Club', slug: 'gamma-ma' }).returning();
    return c!.id;
  });
  await setTestAppRole({ pglite });

  env = {
    db,
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    orgCId,
    ownerAId: seed.userAId,
    ownerBId: seed.userBId,
  } as Env;

  env.managerAId = await seedMember(db, env.orgAId, 'manager@alpha.example', 'manager', 'Morgan Manager');
  env.cfiAId = await seedMember(db, env.orgAId, 'cfi@alpha.example', 'cfi', 'Casey Example');
  env.rileyId = await seedMember(db, env.orgAId, 'riley@alpha.example', 'renter', 'Riley Renter');
  env.samId = await seedMember(db, env.orgAId, 'sam@alpha.example', 'student', 'Sam Student');
  env.beaId = await seedMember(db, env.orgAId, 'bea@alpha.example', 'renter', 'Bea Booked');
  env.boId = await seedMember(db, env.orgBId, 'bo@beta.example', 'renter', 'Bo Beta');
  env.cleoId = await seedMember(db, orgCId, 'cleo@gamma.example', 'renter', 'Cleo Gamma');

  const ownerA = makeSession(env.orgAId, env.ownerAId, 'owner');

  // ── org-A resources ──────────────────────────────────────────────────────
  env.ac101 = await aircraft(env.orgAId, env.ownerAId, 'NMS101');
  await updateAircraftWithDb(db, ownerA, { resourceId: env.ac101, make: 'Cessna', model: '172S' });
  env.ac102 = await aircraft(env.orgAId, env.ownerAId, 'NMS102');
  env.acGrounded = await aircraft(env.orgAId, env.ownerAId, 'NMSGRD');
  env.acReleased = await aircraft(env.orgAId, env.ownerAId, 'NMSREL');
  env.acOld = await aircraft(env.orgAId, env.ownerAId, 'NMSOLD');
  env.acEdge1 = await aircraft(env.orgAId, env.ownerAId, 'NMSEDGE1');
  env.acEdge2 = await aircraft(env.orgAId, env.ownerAId, 'NMSEDGE2');
  env.acSeries = await aircraft(env.orgAId, env.ownerAId, 'NMSSER');
  env.instructor = (
    await createResourceWithDb(db, ownerA, {
      kind: 'instructor',
      displayName: 'Casey Example (CFI)',
      instructorUserId: env.cfiAId,
    })
  ).id;
  env.simId = await withOrgContext(db, env.orgAId, async (tx) => {
    const res = await tx.execute(sql`
      INSERT INTO resource (org_id, kind, display_name)
      VALUES (${env.orgAId}::uuid, 'sim', 'Redbird Sim')
      RETURNING id
    `);
    return String(extractRows<Record<string, unknown>>(res)[0]!.id);
  });

  // ── Bookings on D (org A) ────────────────────────────────────────────────
  env.otherResId = await book(env.orgAId, env.ownerAId, [env.ac101], at(0, 9), at(0, 11), {
    notes: OTHER_NOTES,
    memberUserId: env.beaId,
  });
  // created_by = Riley (a booker session for that user, as the portal tests do).
  env.myCreatedResId = await book(env.orgAId, env.rileyId, [env.ac102], at(0, 13), at(0, 14), {
    notes: 'Riley solo pattern work',
  });
  env.myForResId = await book(env.orgAId, env.ownerAId, [env.ac101, env.instructor], at(0, 15), at(0, 17), {
    notes: 'Riley dual lesson',
    memberUserId: env.rileyId,
  });
  env.myPilotResId = await book(env.orgAId, env.ownerAId, [env.ac102], at(0, 18), at(0, 19), {
    notes: 'Club ferry flight',
  });
  env.voidedPilotResId = await book(env.orgAId, env.ownerAId, [env.ac102], at(0, 20), at(0, 21), {
    notes: 'Voided check-out',
  });
  // One OPEN ticket per aircraft: open + void the 20:00 one first, then open
  // the 18:00 one (which stays open).
  const openedVoid = await openDispatchWithDb(db, ownerA, {
    reservationId: env.voidedPilotResId,
    resourceId: env.ac102,
    pilotUserId: env.rileyId,
    hobbsOut: 100.0,
    tachOut: 100.0,
  });
  if (!openedVoid.ok) throw new Error(`seed dispatch (to void) failed: ${openedVoid.reason}`);
  const voided = await voidDispatchWithDb(db, ownerA, { ticketId: openedVoid.ticket.id, reason: 'mistaken check-out' });
  if (!voided.ok) throw new Error('seed void failed');
  const opened = await openDispatchWithDb(db, ownerA, {
    reservationId: env.myPilotResId,
    resourceId: env.ac102,
    pilotUserId: env.rileyId,
    hobbsOut: 100.0,
    tachOut: 100.0,
  });
  if (!opened.ok) throw new Error(`seed dispatch failed: ${opened.reason}`);

  env.cancelledResId = await book(env.orgAId, env.ownerAId, [env.ac101], at(0, 6), at(0, 7), {
    notes: 'Cancelled early flight',
    memberUserId: env.rileyId,
  });
  await cancelReservationWithDb(db, ownerA, { reservationId: env.cancelledResId });

  env.oldResId = await book(env.orgAId, env.ownerAId, [env.acOld], at(0, 10), at(0, 11));
  await deactivateResourceWithDb(db, ownerA, { resourceId: env.acOld });

  // ── Window edges (NMSEDGE1) + straddles (NMSEDGE2) ───────────────────────
  await book(env.orgAId, env.ownerAId, [env.acEdge1], at(-1, 22), at(0, 0)); // ends at from → out
  await book(env.orgAId, env.ownerAId, [env.acEdge1], at(0, 0), at(0, 1)); // starts at from → in
  await book(env.orgAId, env.ownerAId, [env.acEdge1], at(0, 23), at(1, 0)); // ends at to → in
  await book(env.orgAId, env.ownerAId, [env.acEdge1], at(1, 0), at(1, 2)); // starts at to → out
  await book(env.orgAId, env.ownerAId, [env.acEdge2], at(-1, 23), at(0, 1)); // straddles from → in
  await book(env.orgAId, env.ownerAId, [env.acEdge2], at(0, 23), at(1, 1)); // straddles to → in

  // ── Blackouts (created after the bookings; none overlaps one) ───────────
  for (const [startAt, endAt] of [
    [at(-1, 20), at(0, 0)], // ends at from → out
    [at(0, 12), at(0, 13)], // in
    [at(1, 0), at(1, 6)], // starts at to → out
  ] as const) {
    const b = await createBlackoutWithDb(db, ownerA, {
      resourceId: env.acEdge2,
      startAt,
      endAt,
      reason: BLACKOUT_REASON,
    });
    if (!b.ok) throw new Error('seed blackout failed');
  }
  const ib = await createBlackoutWithDb(db, ownerA, {
    resourceId: env.instructor,
    startAt: at(0, 7),
    endAt: at(0, 8),
    reason: BLACKOUT_REASON,
  });
  if (!ib.ok) throw new Error('seed instructor blackout failed');

  // ── Grounding ────────────────────────────────────────────────────────────
  await groundAircraftWithDb(db, ownerA, { resourceId: env.acGrounded, reason: GROUNDING_REASON });
  await groundAircraftWithDb(db, ownerA, { resourceId: env.acReleased, reason: GROUNDING_REASON });
  await unGroundAircraftWithDb(db, ownerA, { resourceId: env.acReleased, reason: 'fixed' });

  // ── A recurring series for Bea (Mondays 08:00 UTC, two occurrences) ─────
  const series = await createSeriesWithDb(
    db,
    ownerA,
    {
      weekdays: [1],
      intervalWeeks: 1,
      end: { kind: 'count', count: 2 },
      localStartTime: '08:00',
      durationMinutes: 60,
      tz: 'UTC',
      resourceIds: [env.acSeries],
      notes: 'Bea weekly block',
      memberUserId: env.beaId,
    },
    { now: Date.UTC(2031, 2, 3, 0, 0, 0) }, // Mon 2031-03-03 → 03-03 and 03-10 (= D)
  );
  env.seriesId = series.series.id;
  const occ = await listSeriesOccurrencesWithDb(db, ownerA, { seriesId: env.seriesId });
  if (!occ.ok) throw new Error('series not found');
  env.seriesOccurrenceIds = occ.occurrences.map((o) => o.id);

  // ── org B ────────────────────────────────────────────────────────────────
  env.acBeta = await aircraft(env.orgBId, env.ownerBId, 'NBETA1');
  env.betaResId = await book(env.orgBId, env.ownerBId, [env.acBeta], at(0, 9), at(0, 10), {
    notes: 'Bo club flight',
    memberUserId: env.boId,
  });
}, 120_000);

// ════════════════════════════════════════════════════════════════════════════
// MA1 — capability gate
// ════════════════════════════════════════════════════════════════════════════

describe('MA1 — capability gate (portal:access)', () => {
  it('a renter and a student may read it', async () => {
    await expect(asRiley()).resolves.toBeDefined();
    await expect(
      listMemberAvailabilityWithDb(env.db, makeSession(env.orgAId, env.samId, 'student'), DAY),
    ).resolves.toBeDefined();
  });

  it('staff with portal:access (owner, manager) may call it too', async () => {
    await expect(
      listMemberAvailabilityWithDb(env.db, makeSession(env.orgAId, env.ownerAId, 'owner'), DAY),
    ).resolves.toBeDefined();
    await expect(
      listMemberAvailabilityWithDb(env.db, makeSession(env.orgAId, env.managerAId, 'manager'), DAY),
    ).resolves.toBeDefined();
  });

  it('a role without portal:access is refused (cfi, dispatcher, mechanic, accountant)', async () => {
    for (const role of ['cfi', 'dispatcher', 'mechanic', 'accountant'] as const) {
      await expect(
        listMemberAvailabilityWithDb(env.db, makeSession(env.orgAId, env.cfiAId, role), DAY),
        role,
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('no session → UnauthenticatedError', async () => {
    await expect(listMemberAvailabilityWithDb(env.db, null, DAY)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('separation: a renter still cannot call the staff listReservations', async () => {
    await expect(
      listReservationsWithDb(env.db, makeSession(env.orgAId, env.rileyId, 'renter'), DAY),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MA2 — resources
// ════════════════════════════════════════════════════════════════════════════

describe('MA2 — resources: active aircraft + instructors, aircraft first', () => {
  it('lists every active aircraft (by tail #) then the instructor; no sim, no deactivated aircraft', async () => {
    const r = await asRiley();
    expect(r.resources.map((x) => x.label)).toEqual([
      'NMS101',
      'NMS102',
      'NMSEDGE1',
      'NMSEDGE2',
      'NMSGRD',
      'NMSREL',
      'NMSSER',
      'Casey Example (CFI)',
    ]);
    const ids = r.resources.map((x) => x.id);
    expect(ids).not.toContain(env.simId);
    expect(ids).not.toContain(env.acOld);
  });

  it('an aircraft carries its tail #, make and model; an instructor its name and no make/model', async () => {
    const r = await asRiley();
    expect(r.resources.find((x) => x.id === env.ac101)).toEqual({
      id: env.ac101,
      kind: 'aircraft',
      label: 'NMS101',
      make: 'Cessna',
      model: '172S',
      grounded: false,
    });
    expect(r.resources.find((x) => x.id === env.ac102)).toMatchObject({ make: null, model: null });
    expect(r.resources.find((x) => x.id === env.instructor)).toEqual({
      id: env.instructor,
      kind: 'instructor',
      label: 'Casey Example (CFI)',
      make: null,
      model: null,
      grounded: false,
    });
  });

  it('grounded is the bare operator state: true while grounded, false once released; no reason', async () => {
    const r = await asRiley();
    expect(r.resources.find((x) => x.id === env.acGrounded)?.grounded).toBe(true);
    expect(r.resources.find((x) => x.id === env.acReleased)?.grounded).toBe(false);
    expect(r.resources.filter((x) => x.grounded).map((x) => x.label)).toEqual(['NMSGRD']);
    expect(JSON.stringify(r)).not.toContain('Oil leak');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MA3 — redaction (the point)
// ════════════════════════════════════════════════════════════════════════════

describe("MA3 — someone else's booking says when, never who", () => {
  it("another member's booking is EXACTLY { resourceId, startAt, endAt, kind } — no extra keys", async () => {
    const r = await asRiley();
    const other = startingAt(r, env.ac101, at(0, 9));
    expect(other).toBeDefined();
    expect(Object.keys(other!).sort()).toEqual(['endAt', 'kind', 'resourceId', 'startAt']);
    expect(other).toEqual({ resourceId: env.ac101, startAt: at(0, 9), endAt: at(0, 11), kind: 'booked' });
    expect(other!.mine).toBeUndefined();
  });

  it('a blackout is EXACTLY { resourceId, startAt, endAt, kind: "unavailable" } — no reason', async () => {
    const r = await asRiley();
    const blackout = startingAt(r, env.instructor, at(0, 7));
    expect(blackout).toEqual({
      resourceId: env.instructor,
      startAt: at(0, 7),
      endAt: at(0, 8),
      kind: 'unavailable',
    });
    expect(Object.keys(blackout!).sort()).toEqual(['endAt', 'kind', 'resourceId', 'startAt']);
  });

  it('every interval that is not mine has exactly the four keys', async () => {
    const r = await asRiley();
    const notMine = r.intervals.filter((i) => i.mine !== true);
    expect(notMine.length).toBeGreaterThan(0);
    for (const i of notMine) {
      expect(Object.keys(i).sort()).toEqual(['endAt', 'kind', 'resourceId', 'startAt']);
    }
  });

  it("nothing in the result names another member, their booking or its notes, series or ids", async () => {
    const r = await asRiley();
    const text = JSON.stringify(r);
    for (const secret of [
      env.beaId,
      'Bea',
      OTHER_NOTES,
      'Bea weekly block',
      env.otherResId,
      env.voidedPilotResId,
      env.seriesId,
      ...env.seriesOccurrenceIds,
      env.ownerAId, // the booker of all the owner-made bookings
      'Alice',
      env.cfiAId, // the instructor resource's user id
      BLACKOUT_REASON,
      'Voided check-out',
      'mistaken check-out',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("a series occurrence of someone else's shows as plain 'booked' on its aircraft", async () => {
    const r = await asRiley();
    expect(onResource(r, env.acSeries)).toEqual([
      { resourceId: env.acSeries, startAt: at(0, 8), endAt: at(0, 9), kind: 'booked' },
    ]);
  });

  it('symmetric: Bea sees her booking as hers (with notes) and Riley’s as plain busy time', async () => {
    const r = await listMemberAvailabilityWithDb(env.db, makeSession(env.orgAId, env.beaId, 'renter'), DAY);
    const hers = asMine(startingAt(r, env.ac101, at(0, 9)));
    expect(hers.notes).toBe(OTHER_NOTES);
    expect(hers.resourceLabels).toEqual(['NMS101']);
    expect(startingAt(r, env.ac101, at(0, 15))).toEqual({
      resourceId: env.ac101,
      startAt: at(0, 15),
      endAt: at(0, 17),
      kind: 'booked',
    });
    expect(JSON.stringify(r)).not.toContain('Riley');
  });

  it('a client-supplied userId is ignored: the caller is always the session user', async () => {
    const r = await listMemberAvailabilityWithDb(
      env.db,
      makeSession(env.orgAId, env.rileyId, 'renter'),
      { ...DAY, userId: env.beaId, memberUserId: env.beaId } as never,
    );
    expect(startingAt(r, env.ac101, at(0, 9))?.mine).toBeUndefined();
    expect(startingAt(r, env.ac101, at(0, 15))?.mine).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MA4 — mine detection (all three links)
// ════════════════════════════════════════════════════════════════════════════

describe('MA4 — mine: booker, booked for, dispatched pilot', () => {
  it('created_by = me → mine, with its notes and labels', async () => {
    const r = await asRiley();
    const mine = asMine(startingAt(r, env.ac102, at(0, 13)));
    expect(mine).toEqual({
      resourceId: env.ac102,
      startAt: at(0, 13),
      endAt: at(0, 14),
      kind: 'booked',
      mine: true,
      notes: 'Riley solo pattern work',
      resourceLabels: ['NMS102'],
    });
  });

  it('member_user_id = me → mine on the aircraft AND the instructor row; labels tail # first', async () => {
    const r = await asRiley();
    for (const resourceId of [env.ac101, env.instructor]) {
      const mine = asMine(startingAt(r, resourceId, at(0, 15)));
      expect(mine.notes).toBe('Riley dual lesson');
      expect(mine.resourceLabels).toEqual(['NMS101', 'Casey Example (CFI)']);
    }
  });

  it('a non-voided dispatch with pilot_user_id = me → mine', async () => {
    const r = await asRiley();
    const mine = asMine(startingAt(r, env.ac102, at(0, 18)));
    expect(mine.notes).toBe('Club ferry flight');
  });

  it('a VOIDED dispatch does not make it mine: plain busy time', async () => {
    const r = await asRiley();
    expect(startingAt(r, env.ac102, at(0, 20))).toEqual({
      resourceId: env.ac102,
      startAt: at(0, 20),
      endAt: at(0, 21),
      kind: 'booked',
    });
  });

  it('exactly those four of Riley’s intervals are mine', async () => {
    const r = await asRiley();
    const mine = r.intervals
      .filter((i) => i.mine === true)
      .map((i) => `${r.resources.find((x) => x.id === i.resourceId)?.label}@${i.startAt.getUTCHours()}`);
    expect(mine.sort()).toEqual(['Casey Example (CFI)@15', 'NMS101@15', 'NMS102@13', 'NMS102@18']);
  });

  it('staff: the owner sees the bookings it made as its own; the manager sees them redacted', async () => {
    const owner = await listMemberAvailabilityWithDb(
      env.db,
      makeSession(env.orgAId, env.ownerAId, 'owner'),
      DAY,
    );
    expect(asMine(startingAt(owner, env.ac101, at(0, 9))).notes).toBe(OTHER_NOTES);

    const manager = await listMemberAvailabilityWithDb(
      env.db,
      makeSession(env.orgAId, env.managerAId, 'manager'),
      DAY,
    );
    expect(startingAt(manager, env.ac101, at(0, 9))).toEqual({
      resourceId: env.ac101,
      startAt: at(0, 9),
      endAt: at(0, 11),
      kind: 'booked',
    });
  });

  it('intervals come in start order', async () => {
    const r = await asRiley();
    const starts = r.intervals.map((i) => i.startAt.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MA5 — cancelled bookings excluded
// ════════════════════════════════════════════════════════════════════════════

describe('MA5 — cancelled bookings free their time', () => {
  it('the cancelled 06:00 booking (made for Riley) is gone — not mine, not busy', async () => {
    const r = await asRiley();
    expect(startingAt(r, env.ac101, at(0, 6))).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('Cancelled early flight');
  });

  it('a deactivated aircraft and its booking are left out', async () => {
    const r = await asRiley();
    expect(onResource(r, env.acOld)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MA6 — window edges (half-open)
// ════════════════════════════════════════════════════════════════════════════

describe('MA6 — window edges are half-open [from, to)', () => {
  it('a booking ending exactly at `from` or starting exactly at `to` is out; ones touching inside are in', async () => {
    const r = await asRiley();
    expect(onResource(r, env.acEdge1).map((i) => [i.startAt, i.endAt])).toEqual([
      [at(0, 0), at(0, 1)],
      [at(0, 23), at(1, 0)],
    ]);
  });

  it('bookings straddling either edge are in, returned whole (not clipped)', async () => {
    const r = await asRiley();
    const booked = onResource(r, env.acEdge2).filter((i) => i.kind === 'booked');
    expect(booked.map((i) => [i.startAt, i.endAt])).toEqual([
      [at(-1, 23), at(0, 1)],
      [at(0, 23), at(1, 1)],
    ]);
  });

  it('blackouts follow the same rule: only the one inside the day', async () => {
    const r = await asRiley();
    expect(onResource(r, env.acEdge2).filter((i) => i.kind === 'unavailable')).toEqual([
      { resourceId: env.acEdge2, startAt: at(0, 12), endAt: at(0, 13), kind: 'unavailable' },
    ]);
  });

  it('the day before D sees only what reaches into it', async () => {
    const r = await asRiley({ from: at(-1, 0), to: at(0, 0) });
    expect(onResource(r, env.acEdge1).map((i) => [i.startAt, i.endAt])).toEqual([[at(-1, 22), at(0, 0)]]);
    expect(onResource(r, env.ac101)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MA7 — tenant isolation
// ════════════════════════════════════════════════════════════════════════════

describe('MA7 — tenant isolation', () => {
  it('org A never sees org B’s aircraft or bookings', async () => {
    const r = await asRiley();
    const text = JSON.stringify(r);
    expect(text).not.toContain(env.acBeta);
    expect(text).not.toContain('NBETA1');
    expect(text).not.toContain(env.betaResId);
  });

  it('org B sees only its own aircraft and its own booking (as mine) — none of org A', async () => {
    const r = await listMemberAvailabilityWithDb(env.db, makeSession(env.orgBId, env.boId, 'renter'), DAY);
    expect(r.resources.map((x) => x.label)).toEqual(['NBETA1']);
    expect(r.intervals).toHaveLength(1);
    expect(asMine(r.intervals[0]).notes).toBe('Bo club flight');
    const text = JSON.stringify(r);
    for (const id of [env.ac101, env.ac102, env.instructor, env.acEdge2, env.otherResId]) {
      expect(text).not.toContain(id);
    }
    expect(text).not.toContain('NMS');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MA8 — window validation
// ════════════════════════════════════════════════════════════════════════════

describe('MA8 — the window is validated', () => {
  const riley = () => makeSession(env.orgAId, env.rileyId, 'renter');

  it('to must be after from', async () => {
    await expect(listMemberAvailabilityWithDb(env.db, riley(), { from: DAY.to, to: DAY.from })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(listMemberAvailabilityWithDb(env.db, riley(), { from: DAY.from, to: DAY.from })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('at most 31 days (31 is fine)', async () => {
    await expect(
      listMemberAvailabilityWithDb(env.db, riley(), { from: at(0, 0), to: at(31, 0) }),
    ).resolves.toBeDefined();
    await expect(
      listMemberAvailabilityWithDb(env.db, riley(), { from: at(0, 0), to: at(31, 1) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('invalid or missing dates are refused', async () => {
    await expect(
      listMemberAvailabilityWithDb(env.db, riley(), { from: new Date('nope'), to: DAY.to }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      listMemberAvailabilityWithDb(env.db, riley(), { from: '2031-03-10', to: '2031-03-11' } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(listMemberAvailabilityWithDb(env.db, riley(), undefined as never)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('the capability gate runs before validation (a cfi gets Forbidden, not a validation error)', async () => {
    await expect(
      listMemberAvailabilityWithDb(env.db, makeSession(env.orgAId, env.cfiAId, 'cfi'), undefined as never),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MA9 — empties
// ════════════════════════════════════════════════════════════════════════════

describe('MA9 — empties', () => {
  it('a day with nothing booked → every resource listed, no intervals', async () => {
    const r = await asRiley({ from: at(5, 0), to: at(6, 0) });
    expect(r.intervals).toEqual([]);
    expect(r.resources.length).toBe(8);
  });

  it('an org with no aircraft or instructors → { resources: [], intervals: [] }', async () => {
    const r = await listMemberAvailabilityWithDb(env.db, makeSession(env.orgCId, env.cleoId, 'renter'), DAY);
    expect(r).toEqual({ resources: [], intervals: [] });
  });
});
