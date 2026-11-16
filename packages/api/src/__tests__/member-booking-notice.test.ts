/**
 * member-booking-notice.test.ts — 'reservation.for_member': the e-mail a
 * member gets when club staff book, move or cancel a booking FOR them
 * (reservation.member_user_id, migration 0051).
 *
 * pglite + *WithDb forms; every migration through 0051. Every send uses a
 * FAKE EmailProvider — never a real HTTP call.
 *
 * COVERAGE:
 *   1. TEMPLATE (pure) — booked / moved / cancelled, one-off and recurring:
 *      who made the change, tail numbers and instructor names (never ids),
 *      times in the given zone WITH its short name (never bare UTC; an
 *      unknown zone says "UTC" explicitly), the reason only when given, a DST
 *      change and midnight named, HTML escaping, no FAA language.
 *   2. READ — getMemberBookingNoticeContext: labels, member, status, stored
 *      cancellation reason, the moved-from row's old window, who is acting,
 *      the org's name; request order; junk ids skipped; RLS (another org's
 *      booking is not returned); schedule:access gate.
 *   3. SERIES READ — getMemberSeriesNoticeContext: the rule (weekdays, every
 *      N weeks, zone) and the upcoming booked occurrences; empty once
 *      cancelled; another org's series → null.
 *   4. SEND — the facts read → sendNotification → one e-mail to the member's
 *      address, a 'sent' log row; opted out → one 'skipped' row, no e-mail.
 *   5. PREFS — renters and students see the new event (default on) and can
 *      turn it off.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  loadMigrationSql,
  appUser,
  membership,
  notificationLog,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { renderNotificationTemplate } from '../notifications/templates.js';
import type { ReservationForMemberData } from '../notifications/email-event-types.js';
import { NOTIFICATION_EVENT_TYPES } from '../notifications/email-event-types.js';
import {
  getMemberBookingNoticeContextWithDb,
  getMemberSeriesNoticeContextWithDb,
} from '../notifications/member-booking-notice.js';
import { sendNotificationWithDb } from '../notifications/send-notification.js';
import { getMyNotificationPrefsWithDb, setMyNotificationPrefWithDb } from '../notifications/prefs.js';
import type { EmailProvider, SendEmailInput, SendEmailResult } from '../notifications/email-provider.js';
import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { cancelReservationWithDb } from '../scheduling/cancel-reservation.js';
import { rescheduleReservationWithDb } from '../scheduling/reschedule-reservation.js';
import { createSeriesWithDb } from '../scheduling/create-series.js';
import { cancelSeriesWithDb } from '../scheduling/cancel-series.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

const MIGRATION_SQL = loadMigrationSql('0051');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ── Fake EmailProvider — NO real HTTP call, ever ──────────────────────────────

class FakeEmailProvider implements EmailProvider {
  sends: SendEmailInput[] = [];
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.sends.push(input);
    return { id: `fake_${this.sends.length}` };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// 1. Template — pure
// ════════════════════════════════════════════════════════════════════════════════

/** Mon Nov 16 2026, 16:00–17:30 UTC = 10:00–11:30 CST in Chicago. */
const BASE = {
  aircraft: ['N4471K'],
  instructors: ['Casey Reed (CFI)'],
  otherResources: [] as string[],
  startAt: new Date('2026-11-16T16:00:00Z'),
  endAt: new Date('2026-11-16T17:30:00Z'),
  timeZone: 'America/Chicago',
  changedBy: 'Dana Ruiz',
  orgName: 'Bravo Flying Club',
};

function render(data: ReservationForMemberData) {
  return renderNotificationTemplate('reservation.for_member', data);
}

/** Every part of the e-mail, for the checks that apply to all of it. */
function allOf(r: { subject: string; text: string; html: string }): string {
  return `${r.subject}\n${r.text}\n${r.html}`;
}

describe('1. template — reservation.for_member', () => {
  it('booked: who booked it, the tail number and instructor, and the time in Chicago with "CST"', () => {
    const r = render({ ...BASE, change: 'booked' });
    expect(r.subject).toBe('Booked for you: N4471K, Mon, Nov 16, 10:00 CST');
    expect(r.text).toBe(
      'Dana Ruiz booked this for you at Bravo Flying Club.\n\n' +
        'When: Mon, Nov 16, 2026, 10:00–11:30 CST\n' +
        'Aircraft: N4471K\n' +
        'Instructor: Casey Reed (CFI)\n\n' +
        'Questions about this booking? Contact Bravo Flying Club.\n',
    );
    expect(r.html).toContain('When: Mon, Nov 16, 2026, 10:00–11:30 CST');
    // Never the UTC clock (16:00) nor a bare "UTC" when the zone is known.
    expect(allOf(r)).not.toContain('16:00');
    expect(allOf(r)).not.toContain('UTC');
  });

  it('moved: the old and the new times; an aircraft that changed says what it was', () => {
    const r = render({
      ...BASE,
      change: 'moved',
      aircraft: ['N733RB'],
      startAt: new Date('2026-11-17T20:00:00Z'),
      endAt: new Date('2026-11-17T21:30:00Z'),
      previous: {
        startAt: BASE.startAt,
        endAt: BASE.endAt,
        aircraft: ['N4471K'],
        instructors: ['Casey Reed (CFI)'],
        otherResources: [],
      },
    });
    expect(r.subject).toBe('Booking moved: N733RB, now Tue, Nov 17, 14:00 CST');
    expect(r.text).toContain('Dana Ruiz moved a booking made for you at Bravo Flying Club.');
    expect(r.text).toContain('Was: Mon, Nov 16, 2026, 10:00–11:30 CST\nNow: Tue, Nov 17, 2026, 14:00–15:30 CST');
    expect(r.text).toContain('Aircraft: N733RB (was N4471K)');
    // The instructor did not change: no "(was …)".
    expect(r.text).toContain('Instructor: Casey Reed (CFI)\n');
  });

  it('moved, same aircraft: the resource lines carry no "(was …)"', () => {
    const r = render({
      ...BASE,
      change: 'moved',
      startAt: new Date('2026-11-17T20:00:00Z'),
      endAt: new Date('2026-11-17T21:30:00Z'),
      previous: { startAt: BASE.startAt, endAt: BASE.endAt },
    });
    expect(r.text).toContain('Aircraft: N4471K\n');
    expect(r.text).not.toContain('(was');
  });

  it('cancelled: says so, with the reason staff gave', () => {
    const r = render({ ...BASE, change: 'cancelled', reason: '  Weather below club minimums  ' });
    expect(r.subject).toBe('Booking cancelled: N4471K, Mon, Nov 16, 10:00 CST');
    expect(r.text).toContain('Dana Ruiz cancelled a booking made for you at Bravo Flying Club.');
    expect(r.text).toContain('When: Mon, Nov 16, 2026, 10:00–11:30 CST');
    expect(r.text).toContain('Reason: Weather below club minimums\n');
  });

  it('cancelled without a reason: no Reason line', () => {
    expect(render({ ...BASE, change: 'cancelled', reason: null }).text).not.toContain('Reason');
    expect(render({ ...BASE, change: 'cancelled', reason: '   ' }).text).not.toContain('Reason');
  });

  it('a recurring series is ONE e-mail: count, weekdays and time, first and last dates', () => {
    const r = render({
      ...BASE,
      change: 'booked',
      startAt: new Date('2026-11-17T16:00:00Z'),
      endAt: new Date('2026-11-17T17:30:00Z'),
      series: { count: 10, weekdays: [4, 2], intervalWeeks: 1, lastStartAt: new Date('2026-12-17T16:00:00Z') },
    });
    expect(r.subject).toBe('Recurring booking for you: N4471K, 10 bookings from Tue, Nov 17');
    expect(r.text).toBe(
      'Dana Ruiz set up a recurring booking for you at Bravo Flying Club: 10 bookings.\n\n' +
        'Repeats: every Tuesday and Thursday, 10:00–11:30 CST\n' +
        'First: Tue, Nov 17, 2026, 10:00–11:30 CST\n' +
        'Last: Thu, Dec 17, 2026, 10:00–11:30 CST\n' +
        'Aircraft: N4471K\n' +
        'Instructor: Casey Reed (CFI)\n\n' +
        'Questions about this booking? Contact Bravo Flying Club.\n',
    );
  });

  it('a cancelled series: the upcoming count, from / through, every 2 weeks, the reason', () => {
    const r = render({
      ...BASE,
      change: 'cancelled',
      reason: 'Aircraft sold',
      startAt: new Date('2026-11-17T16:00:00Z'),
      endAt: new Date('2026-11-17T17:30:00Z'),
      series: { count: 3, weekdays: [2], intervalWeeks: 2, lastStartAt: new Date('2026-12-15T16:00:00Z') },
    });
    expect(r.subject).toBe('Recurring booking cancelled: N4471K, 3 bookings from Tue, Nov 17');
    expect(r.text).toContain('Dana Ruiz cancelled a recurring booking made for you at Bravo Flying Club: 3 upcoming bookings.');
    expect(r.text).toContain('Repeats: every 2 weeks on Tuesday, 10:00–11:30 CST');
    expect(r.text).toContain('From: Tue, Nov 17, 2026, 10:00–11:30 CST');
    expect(r.text).toContain('Through: Tue, Dec 15, 2026, 10:00–11:30 CST');
    expect(r.text).toContain('Reason: Aircraft sold');
  });

  it('a series across the end of daylight time names both zones', () => {
    const r = render({
      ...BASE,
      change: 'booked',
      startAt: new Date('2026-10-27T15:00:00Z'), // 10:00 CDT
      endAt: new Date('2026-10-27T16:30:00Z'),
      series: { count: 3, weekdays: [2], intervalWeeks: 1, lastStartAt: new Date('2026-11-10T16:00:00Z') }, // 10:00 CST
    });
    expect(r.text).toContain('Repeats: every Tuesday, 10:00–11:30 CDT/CST');
    expect(r.text).toContain('First: Tue, Oct 27, 2026, 10:00–11:30 CDT');
    expect(r.text).toContain('Last: Tue, Nov 10, 2026, 10:00–11:30 CST');
  });

  it('a booking past midnight names both days', () => {
    const r = render({
      ...BASE,
      change: 'booked',
      startAt: new Date('2026-11-16T04:00:00Z'),
      endAt: new Date('2026-11-16T07:00:00Z'),
    });
    expect(r.text).toContain('When: Sun, Nov 15, 2026, 22:00 – Mon, Nov 16, 2026, 01:00 CST');
  });

  it('another zone is written in that zone: Berlin', () => {
    const r = render({ ...BASE, change: 'booked', timeZone: 'Europe/Berlin' });
    expect(r.text).toContain('When: Mon, Nov 16, 2026, 17:00–18:30 GMT+1');
  });

  it('an unknown zone falls back to UTC, and says "UTC" — never a bare clock time', () => {
    const r = render({ ...BASE, change: 'booked', timeZone: 'Mars/Olympus_Mons' });
    expect(r.text).toContain('When: Mon, Nov 16, 2026, 16:00–17:30 UTC');
    expect(r.subject).toBe('Booked for you: N4471K, Mon, Nov 16, 16:00 UTC');
  });

  it('every variant: no ids anywhere, every time followed by its zone, no FAA determination language', () => {
    const variants: ReservationForMemberData[] = [
      { ...BASE, change: 'booked' },
      { ...BASE, change: 'moved', previous: { startAt: new Date('2026-11-15T16:00:00Z'), endAt: new Date('2026-11-15T17:00:00Z') } },
      { ...BASE, change: 'cancelled', reason: 'Instructor out sick' },
      { ...BASE, change: 'booked', series: { count: 4, weekdays: [1], intervalWeeks: 1, lastStartAt: new Date('2026-12-07T16:00:00Z') } },
      { ...BASE, change: 'cancelled', reason: null, series: { count: 2, weekdays: [1], intervalWeeks: 1, lastStartAt: new Date('2026-11-23T16:00:00Z') } },
    ];
    for (const data of variants) {
      const r = render(data);
      const everything = allOf(r);
      expect(everything).not.toMatch(UUID_RE);
      // Every HH:MM in the plain text is followed (after an optional range end) by a zone.
      for (const line of r.text.split('\n').filter((l) => /\d\d:\d\d/.test(l))) {
        expect(line).toMatch(/\d\d:\d\d (CST|CDT|CDT\/CST)$/);
      }
      const lower = everything.toLowerCase();
      for (const word of ['faa', 'airworth', 'currency', 'part 61', 'part 141', 'legal to fly']) {
        expect(lower).not.toContain(word);
      }
    }
  });

  it('html escapes operator-entered text (staff name, labels, reason)', () => {
    const r = render({
      ...BASE,
      change: 'cancelled',
      changedBy: 'Dana <b>Ruiz</b>',
      aircraft: ['N1 & "Co"'],
      reason: '<script>alert(1)</script>',
    });
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<b>');
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.html).toContain('N1 &amp; &quot;Co&quot;');
    // The plain-text part carries it verbatim.
    expect(r.text).toContain('Reason: <script>alert(1)</script>');
  });

  it('the subject stays one line even when a label carries a line break', () => {
    const r = render({ ...BASE, change: 'booked', aircraft: ['N4471K\r\nBcc: x@example.test'] });
    expect(r.subject).toBe('Booked for you: N4471K Bcc: x@example.test, Mon, Nov 16, 10:00 CST');
    expect(r.subject).not.toMatch(/[\r\n]/);
  });

  it('no aircraft (a ground lesson): leads with the instructor; an empty org name is left out', () => {
    const r = render({ ...BASE, change: 'booked', aircraft: [], orgName: '' });
    expect(r.subject).toBe('Booked for you: Casey Reed (CFI), Mon, Nov 16, 10:00 CST');
    expect(r.text).toContain('Dana Ruiz booked this for you.\n');
    expect(r.text).not.toContain('Aircraft');
    expect(r.text).toContain('Questions about this booking? Contact your club.');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Shared DB environment (sections 2–5)
// ════════════════════════════════════════════════════════════════════════════════

/** One UTC hour on a fixed future day (no booking policy here, so any day books). */
const at = (day: number, hour: number) => new Date(Date.UTC(2031, 0, day, hour, 0, 0));

function makeSession(orgId: string, userId: string, role: AppSession['role'] = 'owner'): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

interface Env {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  /** Org-A owner "Alice Alpha" — the staff member making changes. */
  ownerAId: string;
  ownerBId: string;
  /** Org-A renter the bookings are for. */
  rileyId: string;
  rileyEmail: string;
  /** Org-A student. */
  studentId: string;
  aircraftId: string;
  instructorId: string;
}

let env: Env;

async function seedMember(
  db: PgliteTestClient,
  orgId: string,
  email: string,
  fullName: string,
  role: AppSession['role'],
): Promise<string> {
  return withOrgContext(db, orgId, async (tx) => {
    const [usr] = await tx.insert(appUser).values({ orgId, email, fullName }).returning();
    await tx.insert(membership).values({ orgId, userId: usr!.id, role });
    return usr!.id;
  });
}

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });

  const rileyEmail = 'riley.member@alpha.example';
  const rileyId = await seedMember(db, seed.orgAId, rileyEmail, 'Riley Member', 'renter');
  const studentId = await seedMember(db, seed.orgAId, 'sam.student@alpha.example', 'Sam Student', 'student');
  const cfiId = await seedMember(db, seed.orgAId, 'casey.cfi@alpha.example', 'Casey Reed', 'cfi');

  const owner = makeSession(seed.orgAId, seed.userAId, 'owner');
  const aircraft = await createResourceWithDb(db, owner, {
    kind: 'aircraft',
    displayName: 'Cessna 172 (club)',
    tailNumber: 'N4471K',
  });
  const instructor = await createResourceWithDb(db, owner, {
    kind: 'instructor',
    displayName: 'Casey Reed (CFI)',
    instructorUserId: cfiId,
  });

  env = {
    db,
    pglite,
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    ownerAId: seed.userAId,
    ownerBId: seed.userBId,
    rileyId,
    rileyEmail,
    studentId,
    aircraftId: aircraft.id,
    instructorId: instructor.id,
  };
}, 120_000);

function owner(): AppSession {
  return makeSession(env.orgAId, env.ownerAId, 'owner');
}

async function bookForRiley(day: number, hour: number, resourceIds = [env.aircraftId, env.instructorId]) {
  const r = await createReservationWithDb(env.db, owner(), {
    startAt: at(day, hour),
    endAt: at(day, hour + 1),
    resourceIds,
    memberUserId: env.rileyId,
  });
  if (!r.ok) throw new Error(`booking refused: ${r.reason}`);
  return r.reservation;
}

// ════════════════════════════════════════════════════════════════════════════════
// 2. getMemberBookingNoticeContext
// ════════════════════════════════════════════════════════════════════════════════

describe('2. getMemberBookingNoticeContext — the facts, read server-side', () => {
  it('a booking for a member: tail number + instructor name (no ids), the member, who is acting, the org', async () => {
    const created = await bookForRiley(3, 15);
    const ctx = await getMemberBookingNoticeContextWithDb(env.db, owner(), { reservationIds: [created.id] });

    expect(ctx.actorDisplayName).toBe('Alice Alpha');
    expect(ctx.orgName).toBe('Alpha Flight School');
    expect(ctx.bookings).toEqual([
      {
        reservationId: created.id,
        status: 'booked',
        startAt: at(3, 15),
        endAt: at(3, 16),
        memberUserId: env.rileyId,
        seriesId: null,
        cancellationReason: null,
        aircraft: ['N4471K'],
        instructors: ['Casey Reed (CFI)'],
        otherResources: [],
      },
    ]);
  });

  it('after a cancel: status cancelled, the stored (trimmed) reason, labels still there', async () => {
    const created = await bookForRiley(4, 15);
    await cancelReservationWithDb(env.db, owner(), { reservationId: created.id, reason: '  Weather  ' });
    const ctx = await getMemberBookingNoticeContextWithDb(env.db, owner(), { reservationIds: [created.id] });
    expect(ctx.bookings[0]).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'Weather',
      memberUserId: env.rileyId,
      aircraft: ['N4471K'],
    });
  });

  it('after a move: the moved-from row keeps the old window; the new row has the new one and the same member', async () => {
    const created = await bookForRiley(5, 15);
    const moved = await rescheduleReservationWithDb(env.db, owner(), {
      reservationId: created.id,
      newStartAt: at(6, 18),
      newEndAt: at(6, 19),
      newResourceIds: [env.aircraftId],
    });
    if (!moved.ok) throw new Error(moved.reason);

    const ctx = await getMemberBookingNoticeContextWithDb(env.db, owner(), {
      reservationIds: [created.id, moved.reservation.id],
    });
    const [before, after] = ctx.bookings;
    expect(before).toMatchObject({
      status: 'cancelled',
      startAt: at(5, 15),
      endAt: at(5, 16),
      memberUserId: env.rileyId,
      instructors: ['Casey Reed (CFI)'],
    });
    expect(after).toMatchObject({
      status: 'booked',
      startAt: at(6, 18),
      endAt: at(6, 19),
      memberUserId: env.rileyId,
      aircraft: ['N4471K'],
      instructors: [],
    });
  });

  it('request order is kept; junk and unknown ids are skipped', async () => {
    const a = await bookForRiley(7, 9, [env.aircraftId]);
    const b = await bookForRiley(7, 12, [env.aircraftId]);
    const ctx = await getMemberBookingNoticeContextWithDb(env.db, owner(), {
      reservationIds: [b.id, 'not-a-uuid', '00000000-0000-0000-0000-000000000000', a.id, b.id],
    });
    expect(ctx.bookings.map((x) => x.reservationId)).toEqual([b.id, a.id]);
  });

  it('a booking without a member reads memberUserId null', async () => {
    const r = await createReservationWithDb(env.db, owner(), {
      startAt: at(8, 9),
      endAt: at(8, 10),
      resourceIds: [env.aircraftId],
    });
    if (!r.ok) throw new Error(r.reason);
    const ctx = await getMemberBookingNoticeContextWithDb(env.db, owner(), { reservationIds: [r.reservation.id] });
    expect(ctx.bookings[0]?.memberUserId).toBeNull();
  });

  it('T-ISO: another org reads nothing of it (and its own actor and org name)', async () => {
    const created = await bookForRiley(9, 9);
    const ctx = await getMemberBookingNoticeContextWithDb(env.db, makeSession(env.orgBId, env.ownerBId, 'owner'), {
      reservationIds: [created.id],
    });
    expect(ctx.bookings).toEqual([]);
    expect(ctx.actorDisplayName).toBe('Bob Beta');
    expect(ctx.orgName).toBe('Beta Flying Club');
  });

  it('gate: schedule:access — a renter is refused, no session is unauthenticated', async () => {
    const created = await bookForRiley(10, 9);
    await expect(
      getMemberBookingNoticeContextWithDb(env.db, makeSession(env.orgAId, env.rileyId, 'renter'), {
        reservationIds: [created.id],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      getMemberBookingNoticeContextWithDb(env.db, null, { reservationIds: [created.id] }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3. getMemberSeriesNoticeContext
// ════════════════════════════════════════════════════════════════════════════════

describe('3. getMemberSeriesNoticeContext — a series and its upcoming bookings', () => {
  // Mon 2031-02-03 06:00 CST: the count is charged from the ISO week of `now`
  // (recurrence.ts), so a Monday anchor puts all four Tue/Thu dates ahead.
  const NOW = Date.UTC(2031, 1, 3, 12, 0, 0);

  async function seriesForRiley(localStartTime: string) {
    const result = await createSeriesWithDb(
      env.db,
      owner(),
      {
        weekdays: [2, 4],
        intervalWeeks: 1,
        end: { kind: 'count', count: 4 },
        localStartTime,
        durationMinutes: 90,
        tz: 'America/Chicago',
        resourceIds: [env.aircraftId],
        memberUserId: env.rileyId,
      },
      { now: NOW },
    );
    expect(result.createdCount).toBe(4);
    return result;
  }

  it('the rule (weekdays, every N weeks, zone) and every upcoming booking, earliest first, for the member', async () => {
    const created = await seriesForRiley('06:00');
    const ctx = await getMemberSeriesNoticeContextWithDb(env.db, owner(), { seriesId: created.series.id }, { now: NOW });
    if (!ctx) throw new Error('series not visible');

    expect(ctx.series).toEqual({
      id: created.series.id,
      status: 'active',
      weekdays: [2, 4],
      intervalWeeks: 1,
      timeZone: 'America/Chicago',
    });
    expect(ctx.upcoming).toHaveLength(4);
    expect(ctx.upcoming.map((b) => b.reservationId)).toEqual(
      created.occurrences.map((o) => o.reservationId),
    );
    for (const b of ctx.upcoming) {
      expect(b).toMatchObject({ status: 'booked', memberUserId: env.rileyId, aircraft: ['N4471K'], seriesId: created.series.id });
    }
    expect(ctx.actorDisplayName).toBe('Alice Alpha');
  });

  it('once cancelled: status cancelled, nothing upcoming', async () => {
    const created = await seriesForRiley('07:30');
    const cancelled = await cancelSeriesWithDb(env.db, owner(), { seriesId: created.series.id }, { now: NOW });
    expect(cancelled).toEqual({ ok: true, cancelledCount: 4 });
    const ctx = await getMemberSeriesNoticeContextWithDb(env.db, owner(), { seriesId: created.series.id }, { now: NOW });
    expect(ctx?.series.status).toBe('cancelled');
    expect(ctx?.upcoming).toEqual([]);
  });

  it('another org, or a junk id: null', async () => {
    const created = await seriesForRiley('09:00');
    expect(
      await getMemberSeriesNoticeContextWithDb(env.db, makeSession(env.orgBId, env.ownerBId, 'owner'), {
        seriesId: created.series.id,
      }),
    ).toBeNull();
    expect(await getMemberSeriesNoticeContextWithDb(env.db, owner(), { seriesId: 'nope' })).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4. Send — the read facts through sendNotification
// ════════════════════════════════════════════════════════════════════════════════

describe('4. sendNotification — reservation.for_member', () => {
  async function bookedNotice(day: number): Promise<ReservationForMemberData> {
    const created = await bookForRiley(day, 15);
    const ctx = await getMemberBookingNoticeContextWithDb(env.db, owner(), { reservationIds: [created.id] });
    const b = ctx.bookings[0]!;
    return {
      change: 'booked',
      aircraft: b.aircraft,
      instructors: b.instructors,
      otherResources: b.otherResources,
      startAt: b.startAt,
      endAt: b.endAt,
      timeZone: 'America/Chicago',
      changedBy: ctx.actorDisplayName,
      orgName: ctx.orgName,
    };
  }

  it('one e-mail to the member\'s address, naming the staff member and tail number; a sent log row', async () => {
    const provider = new FakeEmailProvider();
    const templateData = await bookedNotice(12);

    const result = await sendNotificationWithDb(
      env.db,
      owner(),
      { toUserId: env.rileyId, eventType: 'reservation.for_member', templateData },
      provider,
    );

    expect(result).toEqual({ sent: true });
    expect(provider.sends).toHaveLength(1);
    expect(provider.sends[0]!.to).toBe(env.rileyEmail);
    // Jan 12 2031, 15:00 UTC = 09:00 CST.
    expect(provider.sends[0]!.subject).toBe('Booked for you: N4471K, Sun, Jan 12, 09:00 CST');
    expect(provider.sends[0]!.text).toContain('Alice Alpha booked this for you at Alpha Flight School.');
    expect(provider.sends[0]!.text).not.toMatch(UUID_RE);

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(notificationLog)
        .where(and(eq(notificationLog.userId, env.rileyId), eq(notificationLog.eventType, 'reservation.for_member'))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', toEmail: env.rileyEmail, subject: provider.sends[0]!.subject });
  });

  it('a member who turned it off: one skipped log row, no e-mail', async () => {
    const studentSession = makeSession(env.orgAId, env.studentId, 'student');
    await setMyNotificationPrefWithDb(env.db, studentSession, { eventType: 'reservation.for_member', emailEnabled: false });
    const provider = new FakeEmailProvider();
    const templateData = await bookedNotice(13);

    const result = await sendNotificationWithDb(
      env.db,
      owner(),
      { toUserId: env.studentId, eventType: 'reservation.for_member', templateData },
      provider,
    );

    expect(result).toEqual({ sent: false, reason: 'opted_out' });
    expect(provider.sends).toHaveLength(0);
    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(notificationLog)
        .where(and(eq(notificationLog.userId, env.studentId), eq(notificationLog.eventType, 'reservation.for_member'))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('skipped');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5. Prefs — renters and students see it and can turn it off
// ════════════════════════════════════════════════════════════════════════════════

describe('5. notification prefs — "Bookings made for you"', () => {
  it('is a registered event type, listed right after reservation.created', () => {
    const i = NOTIFICATION_EVENT_TYPES.indexOf('reservation.for_member');
    expect(i).toBe(NOTIFICATION_EVENT_TYPES.indexOf('reservation.created') + 1);
  });

  it('a renter and a student see it (on by default) and can turn it off and on', async () => {
    for (const [userId, role] of [
      [await seedMember(env.db, env.orgAId, 'pref.renter@alpha.example', 'Pat Renter', 'renter'), 'renter'],
      [await seedMember(env.db, env.orgAId, 'pref.student@alpha.example', 'Pat Student', 'student'), 'student'],
    ] as const) {
      const sess = makeSession(env.orgAId, userId, role);
      const before = await getMyNotificationPrefsWithDb(env.db, sess);
      expect(before).toContainEqual({ eventType: 'reservation.for_member', emailEnabled: true });

      await expect(
        setMyNotificationPrefWithDb(env.db, sess, { eventType: 'reservation.for_member', emailEnabled: false }),
      ).resolves.toEqual({ ok: true, pref: { eventType: 'reservation.for_member', emailEnabled: false } });
      expect(await getMyNotificationPrefsWithDb(env.db, sess)).toContainEqual({
        eventType: 'reservation.for_member',
        emailEnabled: false,
      });

      await setMyNotificationPrefWithDb(env.db, sess, { eventType: 'reservation.for_member', emailEnabled: true });
      expect(await getMyNotificationPrefsWithDb(env.db, sess)).toContainEqual({
        eventType: 'reservation.for_member',
        emailEnabled: true,
      });
    }
  });
});
