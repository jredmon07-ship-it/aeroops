/**
 * reporting-time-zone.test.ts — report windows and buckets in the viewer's
 * time zone ([VERIFY-R1-TZ], reporting/zoned-window.ts).
 *
 * The bug: the dashboard's activity chart and the Reports trends bucketed by
 * UTC day, so on the UTC-hosted demo a flight closed at 20:00 CST counted on
 * the next day and "last 30 days" began at a UTC midnight. Every range-based
 * reporting read now takes an optional `timeZone`.
 *
 * Every DB test pins the clock: NOW = 2026-11-16T12:00Z (Mon Nov 16, 06:00 CST).
 * Chicago's 30 days are then Oct 18 – Nov 16 local, starting 2026-10-18T05:00Z
 * (CDT), and cross the Nov 1 fall-back (02:00 CDT → 01:00 CST; Nov 1 is 25 h).
 *
 * Org A's closed flights (each on its own aircraft):
 *   N1TZ  2026-11-16T02:00Z  Sun Nov 15 20:00 CST   1.5 h  (the evening flight)
 *   N2TZ  2026-10-18T04:30Z  Sat Oct 17 23:30 CDT   1.0 h  CFI-flown, before Chicago's window
 *   N3TZ  2026-10-18T05:30Z  Sun Oct 18 00:30 CDT   2.0 h  CFI-flown, just inside it
 *   N4TZ  2026-11-01T06:30Z  Nov 1 01:30 CDT        0.5 h  first 01:30
 *   N5TZ  2026-11-01T07:30Z  Nov 1 01:30 CST        0.5 h  the repeated 01:30
 *   N6TZ  2026-11-02T05:30Z  Sun Nov 1 23:30 CST    0.5 h  the 25th hour of Nov 1
 * One reservation was created at 2026-11-16T02:00Z (the evening flight's);
 * every other reservation was created long before the windows. Two
 * cancellations at 2026-10-18T04:30Z and 05:30Z. Org B has its own evening
 * flight + reservation at the same instant (tenant isolation).
 *
 * COVERAGE:
 *   Pure: zone fallback; calendar day in a zone; first instant of a day (DST
 *     fall-back 25 h / spring-forward 23 h; Havana's repeated midnight; Beirut's
 *     skipped midnight); "last N days" from local midnight (incl. now exactly
 *     at midnight); day / week / month buckets in zone; 30 buckets across the
 *     Nov 1 fall-back; unknown zone = UTC; no zone = the original UTC window;
 *     fast-check properties (every instant in exactly its day's bucket; a
 *     7d/30d window always has exactly 7/30 day buckets).
 *   DB: the evening flight counts on Nov 15 in Chicago, Nov 16 in UTC
 *     (reservations-vs-flights + utilization trends); exactly 30 buckets;
 *     Nov 1 is one 25-hour bucket; week buckets on local Mondays; unknown zone
 *     = UTC; no timeZone = the rolling UTC window, no `timeZone` key; the
 *     range reads (dashboard metrics, aircraft utilization, hours by tail,
 *     aircraft report, instructor utilization, cancellations, training,
 *     maintenance) start "last 30 days" at Chicago's midnight; org B's rows
 *     never reach org A.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  loadMigrationSql,
  appUser,
  membership,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import { sql as drizzleSql } from 'drizzle-orm';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { cancelReservationWithDb } from '../scheduling/cancel-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';

import { getReservationsVsFlightsTrendWithDb } from '../reporting/get-reservations-vs-flights-trend.js';
import { getUtilizationTrendWithDb } from '../reporting/get-utilization-trend.js';
import { getOrgDashboardMetricsWithDb } from '../reporting/get-org-dashboard-metrics.js';
import { getAircraftUtilizationWithDb } from '../reporting/get-aircraft-utilization.js';
import { getHoursByTailWithDb } from '../reporting/get-hours-by-tail.js';
import { getAircraftReportWithDb } from '../reporting/get-aircraft-report.js';
import { getInstructorUtilizationWithDb } from '../reporting/get-instructor-utilization.js';
import { getCancellationsReportWithDb } from '../reporting/get-cancellations-report.js';
import { getTrainingThroughputWithDb } from '../reporting/get-training-throughput.js';
import { getMaintenanceTrendWithDb } from '../reporting/get-maintenance-trend.js';

import { resolveReportRange, resolveRange, enumerateBuckets } from '../reporting/internal.js';
import {
  resolveReportTimeZone,
  zonedCalendarDay,
  startOfZonedDay,
  addCalendarDays,
  floorCalendarDay,
  resolveZonedReportRange,
  enumerateZonedBuckets,
  zonedReportWindow,
  reportRangeHeader,
  reportBucketStarts,
  timestamptzArrayLiteral,
} from '../reporting/zoned-window.js';

import type { AppSession } from '../auth/types.js';

// Every up migration: the write paths seeded here insert whatever columns the
// current schema has.
const MIGRATION_SQL = loadMigrationSql();

const CHI = 'America/Chicago';
const UNKNOWN = 'Mars/Olympus_Mons';
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The pinned clock: Mon Nov 16 2026, 06:00 CST. */
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const clock = { now: NOW };

const iso = (d: Date): string => d.toISOString();

function makeSession(orgId: string, userId: string, role: AppSession['role'] = 'owner'): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 0 — pure helpers (no DB)
// ══════════════════════════════════════════════════════════════════════════════

describe('resolveReportTimeZone', () => {
  it('keeps a zone Intl knows', () => {
    expect(resolveReportTimeZone(CHI)).toBe(CHI);
    expect(resolveReportTimeZone('UTC')).toBe('UTC');
  });

  it('an unknown or empty zone falls back to UTC', () => {
    expect(resolveReportTimeZone(UNKNOWN)).toBe('UTC');
    expect(resolveReportTimeZone('')).toBe('UTC');
    expect(resolveReportTimeZone('not a zone')).toBe('UTC');
  });
});

describe('zonedCalendarDay', () => {
  it('20:00 CST on Nov 15 is Nov 15 in Chicago and Nov 16 in UTC', () => {
    const t = new Date('2026-11-16T02:00:00Z');
    expect(zonedCalendarDay(t, CHI)).toBe('2026-11-15');
    expect(zonedCalendarDay(t, 'UTC')).toBe('2026-11-16');
  });
});

describe('startOfZonedDay (DST-safe local midnight)', () => {
  it('Chicago fall-back: Nov 1 starts 05:00Z (CDT), Nov 2 06:00Z (CST) — a 25-hour day', () => {
    const nov1 = startOfZonedDay('2026-11-01', CHI);
    const nov2 = startOfZonedDay('2026-11-02', CHI);
    expect(iso(nov1)).toBe('2026-11-01T05:00:00.000Z');
    expect(iso(nov2)).toBe('2026-11-02T06:00:00.000Z');
    expect(nov2.getTime() - nov1.getTime()).toBe(25 * HOUR);
  });

  it('Chicago spring-forward: Mar 8 starts 06:00Z (CST), Mar 9 05:00Z (CDT) — a 23-hour day', () => {
    const mar8 = startOfZonedDay('2026-03-08', CHI);
    const mar9 = startOfZonedDay('2026-03-09', CHI);
    expect(iso(mar8)).toBe('2026-03-08T06:00:00.000Z');
    expect(iso(mar9)).toBe('2026-03-09T05:00:00.000Z');
    expect(mar9.getTime() - mar8.getTime()).toBe(23 * HOUR);
  });

  it('a repeated midnight (Havana fall-back) starts the day at the FIRST midnight', () => {
    // Cuba leaves DST at 01:00 CDT on 2026-11-01: 00:00–00:59 happens twice.
    // Postgres would resolve '2026-11-01 00:00' Havana to the later 05:00Z.
    expect(iso(startOfZonedDay('2026-11-01', 'America/Havana'))).toBe('2026-11-01T04:00:00.000Z');
  });

  it('a skipped midnight (Beirut spring-forward) starts the day at the jump', () => {
    // Lebanon jumps 00:00 → 01:00 on 2026-03-29: the day begins at 01:00 EEST.
    const start = startOfZonedDay('2026-03-29', 'Asia/Beirut');
    expect(iso(start)).toBe('2026-03-28T22:00:00.000Z');
    expect(zonedCalendarDay(start, 'Asia/Beirut')).toBe('2026-03-29');
  });

  it('UTC days start at UTC midnight', () => {
    expect(iso(startOfZonedDay('2026-11-16', 'UTC'))).toBe('2026-11-16T00:00:00.000Z');
  });
});

describe('calendar days', () => {
  it('addCalendarDays rolls months and years', () => {
    expect(addCalendarDays('2026-11-16', -29)).toBe('2026-10-18');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addCalendarDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('floorCalendarDay: day, ISO week (Monday), month', () => {
    expect(floorCalendarDay('2026-11-15', 'day')).toBe('2026-11-15');
    expect(floorCalendarDay('2026-11-15', 'week')).toBe('2026-11-09'); // Sunday → its Monday
    expect(floorCalendarDay('2026-11-16', 'week')).toBe('2026-11-16'); // Monday stays
    expect(floorCalendarDay('2026-11-15', 'month')).toBe('2026-11-01');
  });
});

describe('resolveZonedReportRange — "last N days" from local midnight', () => {
  it('Chicago 30d: Oct 18 00:00 CDT up to now', () => {
    const r = resolveZonedReportRange('30d', new Date(NOW), CHI);
    expect(iso(r.from)).toBe('2026-10-18T05:00:00.000Z');
    expect(r.to.getTime()).toBe(NOW);
    expect(r.timeZone).toBe(CHI);
  });

  it('UTC 30d: Oct 18 00:00Z up to now', () => {
    const r = resolveZonedReportRange('30d', new Date(NOW), 'UTC');
    expect(iso(r.from)).toBe('2026-10-18T00:00:00.000Z');
    expect(r.timeZone).toBe('UTC');
  });

  it('7d and 90d in Chicago start at local midnight 6 and 89 days back', () => {
    expect(iso(resolveZonedReportRange('7d', new Date(NOW), CHI).from)).toBe('2026-11-10T06:00:00.000Z');
    expect(iso(resolveZonedReportRange('90d', new Date(NOW), CHI).from)).toBe('2026-08-19T05:00:00.000Z');
  });

  it('now exactly at local midnight: the 30 complete days before it (today is empty)', () => {
    const midnight = new Date('2026-11-16T06:00:00.000Z'); // Nov 16 00:00 CST
    const r = resolveZonedReportRange('30d', midnight, CHI);
    expect(iso(r.from)).toBe('2026-10-17T05:00:00.000Z');
    const buckets = enumerateZonedBuckets(r.from, r.to, 'day', CHI);
    expect(buckets).toHaveLength(30);
    expect(buckets.at(-1)?.day).toBe('2026-11-15');
  });

  it('an unknown zone reads as UTC', () => {
    const r = resolveZonedReportRange('30d', new Date(NOW), UNKNOWN);
    expect(r).toEqual(resolveZonedReportRange('30d', new Date(NOW), 'UTC'));
  });
});

describe('enumerateZonedBuckets — zero-fill in the zone', () => {
  it('a 30-day window across the Nov 1 fall-back has exactly 30 day buckets', () => {
    const { from, to } = resolveZonedReportRange('30d', new Date(NOW), CHI);
    const buckets = enumerateZonedBuckets(from, to, 'day', CHI);
    expect(buckets).toHaveLength(30);
    expect(buckets[0]?.day).toBe('2026-10-18');
    expect(buckets.at(-1)?.day).toBe('2026-11-16');
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]!;
      // Each bucket starts at its own local midnight…
      expect(b.start.getTime()).toBe(startOfZonedDay(b.day, CHI).getTime());
      // …and the days are consecutive.
      if (i > 0) expect(b.day).toBe(addCalendarDays(buckets[i - 1]!.day, 1));
    }
    const nov1 = buckets.findIndex((b) => b.day === '2026-11-01');
    expect(buckets[nov1 + 1]!.start.getTime() - buckets[nov1]!.start.getTime()).toBe(25 * HOUR);
  });

  it('a 30-day window across the Mar 8 spring-forward has 30 buckets; Mar 8 is 23 h', () => {
    const now = new Date('2026-03-20T17:00:00.000Z'); // Mar 20 12:00 CDT
    const { from, to } = resolveZonedReportRange('30d', now, CHI);
    const buckets = enumerateZonedBuckets(from, to, 'day', CHI);
    expect(buckets).toHaveLength(30);
    const mar8 = buckets.findIndex((b) => b.day === '2026-03-08');
    expect(buckets[mar8 + 1]!.start.getTime() - buckets[mar8]!.start.getTime()).toBe(23 * HOUR);
  });

  it('week buckets start on local Mondays at local midnight', () => {
    const { from, to } = resolveZonedReportRange('90d', new Date(NOW), CHI);
    const buckets = enumerateZonedBuckets(from, to, 'week', CHI);
    expect(buckets).toHaveLength(14); // Mon Aug 17 … Mon Nov 16
    expect(buckets[0]?.day).toBe('2026-08-17');
    expect(buckets.at(-1)?.day).toBe('2026-11-16');
    for (const b of buckets) {
      expect(new Date(`${b.day}T00:00:00Z`).getUTCDay()).toBe(1); // Monday
      expect(b.start.getTime()).toBe(startOfZonedDay(b.day, CHI).getTime());
    }
    const oct26 = buckets.find((b) => b.day === '2026-10-26')!;
    const nov2 = buckets.find((b) => b.day === '2026-11-02')!;
    expect(iso(oct26.start)).toBe('2026-10-26T05:00:00.000Z'); // CDT
    expect(iso(nov2.start)).toBe('2026-11-02T06:00:00.000Z'); // CST
    expect(nov2.start.getTime() - oct26.start.getTime()).toBe(7 * DAY + HOUR);
  });

  it('month buckets start on the local 1st; 22:00 CDT on Oct 31 is October', () => {
    const { from, to } = resolveZonedReportRange('90d', new Date(NOW), CHI);
    const buckets = enumerateZonedBuckets(from, to, 'month', CHI);
    expect(buckets.map((b) => b.day)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01']);
    expect(buckets.map((b) => iso(b.start))).toEqual([
      '2026-08-01T05:00:00.000Z',
      '2026-09-01T05:00:00.000Z',
      '2026-10-01T05:00:00.000Z',
      '2026-11-01T05:00:00.000Z',
    ]);
    const lateOct31 = new Date('2026-11-01T03:00:00Z');
    expect(floorCalendarDay(zonedCalendarDay(lateOct31, CHI), 'month')).toBe('2026-10-01');
    expect(floorCalendarDay(zonedCalendarDay(lateOct31, 'UTC'), 'month')).toBe('2026-11-01');
  });

  it('month buckets roll over the year', () => {
    const buckets = enumerateZonedBuckets(
      new Date('2026-12-15T12:00:00Z'),
      new Date('2027-02-02T12:00:00Z'),
      'month',
      CHI,
    );
    expect(buckets.map((b) => b.day)).toEqual(['2026-12-01', '2027-01-01', '2027-02-01']);
  });

  it('an unknown zone buckets as UTC; an empty window has no buckets', () => {
    const { from, to } = resolveZonedReportRange('30d', new Date(NOW), 'UTC');
    expect(enumerateZonedBuckets(from, to, 'day', UNKNOWN)).toEqual(
      enumerateZonedBuckets(from, to, 'day', 'UTC'),
    );
    expect(enumerateZonedBuckets(to, to, 'day', CHI)).toEqual([]);
  });
});

describe('no timeZone: the original rolling UTC window and buckets', () => {
  it('zonedReportWindow without a zone is resolveReportRange / resolveRange', () => {
    const now = new Date(NOW);
    expect(zonedReportWindow('30d', now, undefined, resolveReportRange)).toEqual({
      ...resolveReportRange('30d', now),
      timeZone: null,
    });
    expect(zonedReportWindow('7d', now, undefined, resolveRange)).toEqual({
      ...resolveRange('7d', now),
      timeZone: null,
    });
  });

  it('its range header has no timeZone key; a zoned one echoes the zone', () => {
    const now = new Date(NOW);
    const legacy = zonedReportWindow('30d', now, undefined, resolveReportRange);
    expect(Object.keys(reportRangeHeader('30d', legacy))).toEqual(['key', 'from', 'to']);
    const zoned = zonedReportWindow('30d', now, CHI, resolveReportRange);
    expect(reportRangeHeader('30d', zoned).timeZone).toBe(CHI);
  });

  it('its bucket starts are enumerateBuckets (UTC midnights)', () => {
    const legacy = zonedReportWindow('30d', new Date(NOW), undefined, resolveReportRange);
    expect(reportBucketStarts(legacy, 'day')).toEqual(enumerateBuckets(legacy.from, legacy.to, 'day'));
  });
});

describe('timestamptzArrayLiteral', () => {
  it('renders ISO instants as one Postgres array literal', () => {
    expect(
      timestamptzArrayLiteral([new Date('2026-11-15T06:00:00Z'), new Date('2026-11-16T06:00:00Z')]),
    ).toBe('{2026-11-15T06:00:00.000Z,2026-11-16T06:00:00.000Z}');
    expect(timestamptzArrayLiteral([])).toBe('{}');
  });
});

describe('properties (fast-check)', () => {
  // DST at 02:00 (Chicago, London), a repeated / skipped midnight (Havana,
  // Beirut), a 30-minute shift (Lord Howe), :30 / :45 offsets.
  const ZONES = [
    'UTC',
    CHI,
    'America/Havana',
    'Asia/Beirut',
    'Europe/London',
    'Australia/Lord_Howe',
    'Pacific/Chatham',
    'Asia/Kolkata',
    'America/St_Johns',
  ];
  const instant = fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2040, 0, 1) });

  it('every instant lies in exactly its own day bucket: start ≤ t < next start', () => {
    fc.assert(
      fc.property(instant, fc.constantFrom(...ZONES), (t, zone) => {
        const day = zonedCalendarDay(new Date(t), zone);
        const start = startOfZonedDay(day, zone).getTime();
        const next = startOfZonedDay(addCalendarDays(day, 1), zone).getTime();
        expect(start).toBeLessThanOrEqual(t);
        expect(t).toBeLessThan(next);
        expect(zonedCalendarDay(new Date(start), zone)).toBe(day);
      }),
      { numRuns: 300 },
    );
  });

  it('a 7d / 30d window always has exactly 7 / 30 day buckets, the last holding now', () => {
    fc.assert(
      fc.property(
        instant,
        fc.constantFrom(...ZONES),
        fc.constantFrom(['7d', 7] as const, ['30d', 30] as const),
        (t, zone, [key, days]) => {
          const { from, to } = resolveZonedReportRange(key, new Date(t), zone);
          const buckets = enumerateZonedBuckets(from, to, 'day', zone);
          expect(buckets).toHaveLength(days);
          expect(buckets[0]!.start.getTime()).toBe(from.getTime());
          expect(buckets.at(-1)!.day).toBe(zonedCalendarDay(new Date(t - 1), zone));
        },
      ),
      { numRuns: 150 },
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SHARED TEST DB — the scenario in the header
// ══════════════════════════════════════════════════════════════════════════════

interface Env {
  db: PgliteTestClient;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
  cfiId: string;
}

let env: Env;

const LONG_AGO = new Date('2026-01-15T12:00:00Z');
const EVENING = new Date('2026-11-16T02:00:00Z');

/** An aircraft + a future reservation on it + an open/closed dispatch, closed at `closedAt`. */
async function seedFlight(
  db: PgliteTestClient,
  orgId: string,
  ownerId: string,
  opts: { tail: string; hobbsOut: number; hobbsIn: number; closedAt: Date; pilotUserId?: string },
): Promise<{ reservationId: string }> {
  const sess = makeSession(orgId, ownerId);
  const ac = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `Aircraft ${opts.tail}`,
    tailNumber: opts.tail,
  });
  const r = await createReservationWithDb(db, sess, {
    startAt: new Date('2027-06-01T08:00:00Z'),
    endAt: new Date('2027-06-01T10:00:00Z'),
    resourceIds: [ac.id],
  });
  if (!r.ok) throw new Error(`seed reservation failed: ${r.reason}`);
  const o = await openDispatchWithDb(db, sess, {
    reservationId: r.reservation.id,
    resourceId: ac.id,
    pilotUserId: opts.pilotUserId ?? ownerId,
    hobbsOut: opts.hobbsOut,
    tachOut: opts.hobbsOut,
  });
  if (!o.ok) throw new Error('seed open failed');
  const c = await closeDispatchWithDb(db, sess, {
    ticketId: o.ticket.id,
    hobbsIn: opts.hobbsIn,
    tachIn: opts.hobbsIn,
  });
  if (!c.ok) throw new Error('seed close failed');
  await withOrgContext(db, orgId, async (tx) => {
    await tx.execute(
      drizzleSql`UPDATE dispatch_ticket SET closed_at = ${opts.closedAt} WHERE id = ${o.ticket.id}`,
    );
  });
  return { reservationId: r.reservation.id };
}

/** A future reservation on a new aircraft, cancelled, with cancelled_at set to `at`. */
async function seedCancellation(
  db: PgliteTestClient,
  orgId: string,
  ownerId: string,
  tail: string,
  at: Date,
): Promise<void> {
  const sess = makeSession(orgId, ownerId);
  const ac = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `Aircraft ${tail}`,
    tailNumber: tail,
  });
  const r = await createReservationWithDb(db, sess, {
    startAt: new Date('2027-06-02T08:00:00Z'),
    endAt: new Date('2027-06-02T10:00:00Z'),
    resourceIds: [ac.id],
  });
  if (!r.ok) throw new Error(`seed reservation failed: ${r.reason}`);
  const cancelled = await cancelReservationWithDb(db, sess, { reservationId: r.reservation.id });
  if (!cancelled.ok) throw new Error('seed cancel failed');
  await withOrgContext(db, orgId, async (tx) => {
    await tx.execute(
      drizzleSql`UPDATE reservation SET cancelled_at = ${at} WHERE id = ${r.reservation.id}`,
    );
  });
}

/** A member with membership role 'cfi'. */
async function seedCfi(db: PgliteTestClient, orgId: string): Promise<string> {
  const rows = await withOrgContext(db, orgId, (tx) =>
    tx
      .insert(appUser)
      .values({ orgId, email: 'cfi.tz@example.com', fullName: 'Casey Instructor' })
      .returning({ id: appUser.id }),
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('seedCfi: no row');
  await withOrgContext(db, orgId, (tx) => tx.insert(membership).values({ orgId, userId: id, role: 'cfi' }));
  return id;
}

/** Every reservation in the org was created long ago, except `recentId` (created at EVENING). */
async function pinReservationCreatedAt(db: PgliteTestClient, orgId: string, recentId: string): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    await tx.execute(drizzleSql`UPDATE reservation SET created_at = ${LONG_AGO}`);
    await tx.execute(drizzleSql`UPDATE reservation SET created_at = ${EVENING} WHERE id = ${recentId}`);
  });
}

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });
  const { orgAId, orgBId, userAId, userBId } = seed;
  const cfiId = await seedCfi(db, orgAId);

  const evening = await seedFlight(db, orgAId, userAId, {
    tail: 'N1TZ', hobbsOut: 100, hobbsIn: 101.5, closedAt: EVENING,
  });
  await seedFlight(db, orgAId, userAId, {
    tail: 'N2TZ', hobbsOut: 200, hobbsIn: 201, closedAt: new Date('2026-10-18T04:30:00Z'), pilotUserId: cfiId,
  });
  await seedFlight(db, orgAId, userAId, {
    tail: 'N3TZ', hobbsOut: 300, hobbsIn: 302, closedAt: new Date('2026-10-18T05:30:00Z'), pilotUserId: cfiId,
  });
  await seedFlight(db, orgAId, userAId, {
    tail: 'N4TZ', hobbsOut: 400, hobbsIn: 400.5, closedAt: new Date('2026-11-01T06:30:00Z'),
  });
  await seedFlight(db, orgAId, userAId, {
    tail: 'N5TZ', hobbsOut: 500, hobbsIn: 500.5, closedAt: new Date('2026-11-01T07:30:00Z'),
  });
  await seedFlight(db, orgAId, userAId, {
    tail: 'N6TZ', hobbsOut: 600, hobbsIn: 600.5, closedAt: new Date('2026-11-02T05:30:00Z'),
  });
  await seedCancellation(db, orgAId, userAId, 'N7TZ', new Date('2026-10-18T04:30:00Z'));
  await seedCancellation(db, orgAId, userAId, 'N8TZ', new Date('2026-10-18T05:30:00Z'));
  await pinReservationCreatedAt(db, orgAId, evening.reservationId);

  // Org B: its own evening flight + reservation at the same instant.
  const eveningB = await seedFlight(db, orgBId, userBId, {
    tail: 'N9TZ', hobbsOut: 900, hobbsIn: 902, closedAt: EVENING,
  });
  await pinReservationCreatedAt(db, orgBId, eveningB.reservationId);

  env = { db, orgAId, orgBId, userAId, userBId, cfiId };
}, 60_000);

const sessA = (): AppSession => makeSession(env.orgAId, env.userAId);
const sessB = (): AppSession => makeSession(env.orgBId, env.userBId);

/** The bucket starting at `startIso`, or a failure naming the starts there are. */
function bucketAt<T extends { bucketStart: Date }>(buckets: T[], startIso: string): T {
  const b = buckets.find((x) => iso(x.bucketStart) === startIso);
  if (!b) throw new Error(`no bucket at ${startIso}: ${buckets.map((x) => iso(x.bucketStart)).join(', ')}`);
  return b;
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — the dashboard chart / Reports trend: reservations vs flights
// ══════════════════════════════════════════════════════════════════════════════

describe('getReservationsVsFlightsTrend in the viewer\'s zone', () => {
  it('America/Chicago: the 20:00 CST flight and booking count on Nov 15', async () => {
    const r = await getReservationsVsFlightsTrendWithDb(env.db, sessA(), { range: '30d', timeZone: CHI }, clock);

    expect(r.range.timeZone).toBe(CHI);
    expect(iso(r.range.from)).toBe('2026-10-18T05:00:00.000Z');
    expect(r.range.to.getTime()).toBe(NOW);
    expect(r.buckets).toHaveLength(30);
    expect(iso(r.buckets[0]!.bucketStart)).toBe('2026-10-18T05:00:00.000Z');
    expect(iso(r.buckets.at(-1)!.bucketStart)).toBe('2026-11-16T06:00:00.000Z');

    expect(bucketAt(r.buckets, '2026-11-15T06:00:00.000Z')).toMatchObject({ flightsClosed: 1, reservationsCreated: 1 });
    expect(bucketAt(r.buckets, '2026-11-16T06:00:00.000Z')).toMatchObject({ flightsClosed: 0, reservationsCreated: 0 });
    // 23:30 CDT on Oct 17 is before Chicago's first midnight: not counted.
    expect(r.totalFlightsClosed).toBe(5);
    expect(r.totalReservationsCreated).toBe(1);
  });

  it('UTC: the same flight and booking count on Nov 16', async () => {
    const r = await getReservationsVsFlightsTrendWithDb(env.db, sessA(), { range: '30d', timeZone: 'UTC' }, clock);

    expect(r.range.timeZone).toBe('UTC');
    expect(iso(r.range.from)).toBe('2026-10-18T00:00:00.000Z');
    expect(r.buckets).toHaveLength(30);
    expect(bucketAt(r.buckets, '2026-11-16T00:00:00.000Z')).toMatchObject({ flightsClosed: 1, reservationsCreated: 1 });
    expect(bucketAt(r.buckets, '2026-11-15T00:00:00.000Z')).toMatchObject({ flightsClosed: 0, reservationsCreated: 0 });
    expect(r.totalFlightsClosed).toBe(6);
  });

  it('the 25-hour Nov 1 is one Chicago bucket (01:30 twice, and 23:30 CST)', async () => {
    const chi = await getReservationsVsFlightsTrendWithDb(env.db, sessA(), { range: '30d', timeZone: CHI }, clock);
    expect(bucketAt(chi.buckets, '2026-11-01T05:00:00.000Z').flightsClosed).toBe(3);
    expect(bucketAt(chi.buckets, '2026-11-02T06:00:00.000Z').flightsClosed).toBe(0);

    const utc = await getReservationsVsFlightsTrendWithDb(env.db, sessA(), { range: '30d', timeZone: 'UTC' }, clock);
    expect(bucketAt(utc.buckets, '2026-11-01T00:00:00.000Z').flightsClosed).toBe(2);
    expect(bucketAt(utc.buckets, '2026-11-02T00:00:00.000Z').flightsClosed).toBe(1);
  });

  it('90d: week buckets start on Chicago Mondays; Sunday-evening flights stay in their local week', async () => {
    const chi = await getReservationsVsFlightsTrendWithDb(env.db, sessA(), { range: '90d', timeZone: CHI }, clock);
    expect(chi.granularity).toBe('week');
    expect(chi.buckets).toHaveLength(14);
    expect(bucketAt(chi.buckets, '2026-10-12T05:00:00.000Z').flightsClosed).toBe(2); // Sat 23:30 + Sun 00:30
    expect(bucketAt(chi.buckets, '2026-10-26T05:00:00.000Z').flightsClosed).toBe(3); // all of Sun Nov 1
    expect(bucketAt(chi.buckets, '2026-11-09T06:00:00.000Z')).toMatchObject({ flightsClosed: 1, reservationsCreated: 1 });
    expect(bucketAt(chi.buckets, '2026-11-16T06:00:00.000Z').flightsClosed).toBe(0);

    const utc = await getReservationsVsFlightsTrendWithDb(env.db, sessA(), { range: '90d', timeZone: 'UTC' }, clock);
    expect(bucketAt(utc.buckets, '2026-10-26T00:00:00.000Z').flightsClosed).toBe(2);
    expect(bucketAt(utc.buckets, '2026-11-02T00:00:00.000Z').flightsClosed).toBe(1);
    expect(bucketAt(utc.buckets, '2026-11-16T00:00:00.000Z').flightsClosed).toBe(1);
  });

  it('an unknown zone falls back to UTC', async () => {
    const unknown = await getReservationsVsFlightsTrendWithDb(env.db, sessA(), { range: '30d', timeZone: UNKNOWN }, clock);
    const utc = await getReservationsVsFlightsTrendWithDb(env.db, sessA(), { range: '30d', timeZone: 'UTC' }, clock);
    expect(unknown).toEqual(utc);
    expect(unknown.range.timeZone).toBe('UTC');
  });

  it('no timeZone: the rolling UTC window [now − 30d, now), UTC days, no timeZone key', async () => {
    const r = await getReservationsVsFlightsTrendWithDb(env.db, sessA(), { range: '30d' }, clock);

    expect(r.range).toEqual({ key: '30d', from: new Date(NOW - 30 * DAY), to: new Date(NOW) });
    expect(r.buckets.map((b) => b.bucketStart)).toEqual(
      enumerateBuckets(new Date(NOW - 30 * DAY), new Date(NOW), 'day'),
    );
    expect(r.buckets).toHaveLength(31);
    expect(bucketAt(r.buckets, '2026-11-16T00:00:00.000Z')).toMatchObject({ flightsClosed: 1, reservationsCreated: 1 });
    expect(r.totalFlightsClosed).toBe(6);
  });

  it('T-ISO: org B\'s evening flight never reaches org A, and org B sees its own on Nov 15', async () => {
    const a = await getReservationsVsFlightsTrendWithDb(env.db, sessA(), { range: '30d', timeZone: CHI }, clock);
    expect(bucketAt(a.buckets, '2026-11-15T06:00:00.000Z').flightsClosed).toBe(1);

    const b = await getReservationsVsFlightsTrendWithDb(env.db, sessB(), { range: '30d', timeZone: CHI }, clock);
    expect(bucketAt(b.buckets, '2026-11-15T06:00:00.000Z')).toMatchObject({ flightsClosed: 1, reservationsCreated: 1 });
    expect(b.totalFlightsClosed).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Reports: fleet utilization over time
// ══════════════════════════════════════════════════════════════════════════════

describe('getUtilizationTrend in the viewer\'s zone', () => {
  it('Chicago: the evening flight\'s 1.5 h land on Nov 15; totals start at local midnight', async () => {
    const r = await getUtilizationTrendWithDb(env.db, sessA(), { range: '30d', timeZone: CHI }, clock);
    expect(r.buckets).toHaveLength(30);
    expect(bucketAt(r.buckets, '2026-11-15T06:00:00.000Z')).toMatchObject({ flightCount: 1, flightHours: 1.5 });
    expect(bucketAt(r.buckets, '2026-11-01T05:00:00.000Z')).toMatchObject({ flightCount: 3, flightHours: 1.5 });
    expect(bucketAt(r.buckets, '2026-10-18T05:00:00.000Z')).toMatchObject({ flightCount: 1, flightHours: 2 });
    expect(r.totalFlights).toBe(5);
    expect(r.totalFlightHours).toBe(5);
    expect(r.range.timeZone).toBe(CHI);
  });

  it('UTC: the same 1.5 h land on Nov 16', async () => {
    const r = await getUtilizationTrendWithDb(env.db, sessA(), { range: '30d', timeZone: 'UTC' }, clock);
    expect(bucketAt(r.buckets, '2026-11-16T00:00:00.000Z')).toMatchObject({ flightCount: 1, flightHours: 1.5 });
    expect(bucketAt(r.buckets, '2026-10-18T00:00:00.000Z')).toMatchObject({ flightCount: 2, flightHours: 3 });
    expect(r.totalFlights).toBe(6);
    expect(r.totalFlightHours).toBe(6);
  });

  it('no timeZone: unchanged rolling UTC output', async () => {
    const r = await getUtilizationTrendWithDb(env.db, sessA(), { range: '30d' }, clock);
    expect(r.range).toEqual({ key: '30d', from: new Date(NOW - 30 * DAY), to: new Date(NOW) });
    expect(r.buckets).toHaveLength(31);
    expect(bucketAt(r.buckets, '2026-11-16T00:00:00.000Z')).toMatchObject({ flightCount: 1, flightHours: 1.5 });
    expect(r.totalFlights).toBe(6);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — range reads: "last 30 days" starts at the viewer's midnight
// ══════════════════════════════════════════════════════════════════════════════

describe('range reads start "last 30 days" at local midnight', () => {
  it('getOrgDashboardMetrics: KPI totals match the Chicago chart; UTC and no-zone count the 23:30 CDT flight', async () => {
    const chi = await getOrgDashboardMetricsWithDb(env.db, sessA(), { range: '30d', timeZone: CHI }, clock);
    expect(chi.range).toEqual({
      key: '30d',
      from: new Date('2026-10-18T05:00:00.000Z'),
      to: new Date(NOW),
      timeZone: CHI,
    });
    expect(chi.totalFlights).toBe(5);
    expect(chi.totalFlightHours).toBe(5);

    const utc = await getOrgDashboardMetricsWithDb(env.db, sessA(), { range: '30d', timeZone: 'UTC' }, clock);
    expect(utc.totalFlights).toBe(6);

    const legacy = await getOrgDashboardMetricsWithDb(env.db, sessA(), { range: '30d' }, clock);
    expect(legacy.range).toEqual({ key: '30d', from: new Date(NOW - 30 * DAY), to: new Date(NOW) });
    expect(legacy.totalFlights).toBe(6);
  });

  it('getOrgDashboardMetrics 7d in Chicago starts Nov 10 00:00 CST', async () => {
    const r = await getOrgDashboardMetricsWithDb(env.db, sessA(), { range: '7d', timeZone: CHI }, clock);
    expect(iso(r.range.from)).toBe('2026-11-10T06:00:00.000Z');
    expect(r.totalFlights).toBe(1);
  });

  it('getAircraftUtilization / getHoursByTail / getAircraftReport: N2TZ\'s 23:30 CDT flight is outside Chicago\'s 30 days', async () => {
    const flightsOf = (rows: Array<{ tailNumber: string; flightCount: number }>, tail: string) =>
      rows.find((r) => r.tailNumber === tail)?.flightCount;

    const utilChi = await getAircraftUtilizationWithDb(env.db, sessA(), { range: '30d', timeZone: CHI }, clock);
    const utilUtc = await getAircraftUtilizationWithDb(env.db, sessA(), { range: '30d', timeZone: 'UTC' }, clock);
    const utilLegacy = await getAircraftUtilizationWithDb(env.db, sessA(), { range: '30d' }, clock);
    expect(flightsOf(utilChi, 'N2TZ')).toBe(0);
    expect(flightsOf(utilChi, 'N3TZ')).toBe(1);
    expect(flightsOf(utilUtc, 'N2TZ')).toBe(1);
    expect(flightsOf(utilLegacy, 'N2TZ')).toBe(1);

    const tailsChi = await getHoursByTailWithDb(env.db, sessA(), { range: '30d', timeZone: CHI }, clock);
    const tailsUtc = await getHoursByTailWithDb(env.db, sessA(), { range: '30d', timeZone: 'UTC' }, clock);
    expect(flightsOf(tailsChi, 'N2TZ')).toBe(0);
    expect(flightsOf(tailsUtc, 'N2TZ')).toBe(1);

    const reportChi = await getAircraftReportWithDb(env.db, sessA(), { range: '30d', timeZone: CHI }, clock);
    const reportUtc = await getAircraftReportWithDb(env.db, sessA(), { range: '30d', timeZone: 'UTC' }, clock);
    expect(flightsOf(reportChi, 'N2TZ')).toBe(0);
    expect(flightsOf(reportUtc, 'N2TZ')).toBe(1);
  });

  it('getInstructorUtilization: the CFI flew 1 flight in Chicago\'s 30 days, 2 in UTC\'s', async () => {
    const cfiRow = (rows: Array<{ instructorUserId: string; flightCount: number; flightHours: number }>) =>
      rows.find((r) => r.instructorUserId === env.cfiId);

    const chi = await getInstructorUtilizationWithDb(env.db, sessA(), { range: '30d', timeZone: CHI }, clock);
    expect(cfiRow(chi)).toMatchObject({ flightCount: 1, flightHours: 2 });

    const utc = await getInstructorUtilizationWithDb(env.db, sessA(), { range: '30d', timeZone: 'UTC' }, clock);
    expect(cfiRow(utc)).toMatchObject({ flightCount: 2, flightHours: 3 });

    const legacy = await getInstructorUtilizationWithDb(env.db, sessA(), { range: '30d' }, clock);
    expect(cfiRow(legacy)).toMatchObject({ flightCount: 2, flightHours: 3 });
  });

  it('getCancellationsReport: a 23:30 CDT cancellation is outside Chicago\'s 30 days', async () => {
    const chi = await getCancellationsReportWithDb(env.db, sessA(), { range: '30d', timeZone: CHI }, clock);
    expect(chi.totalCount).toBe(1);
    expect(chi.range.timeZone).toBe(CHI);
    expect(iso(chi.range.from)).toBe('2026-10-18T05:00:00.000Z');

    const utc = await getCancellationsReportWithDb(env.db, sessA(), { range: '30d', timeZone: 'UTC' }, clock);
    expect(utc.totalCount).toBe(2);

    const legacy = await getCancellationsReportWithDb(env.db, sessA(), { range: '30d' }, clock);
    expect(legacy.totalCount).toBe(2);
    expect('timeZone' in legacy.range).toBe(false);
  });

  it('getTrainingThroughput / getMaintenanceTrend: same window and zone echo; unknown zone → UTC', async () => {
    const training = await getTrainingThroughputWithDb(env.db, sessA(), { range: '30d', timeZone: CHI }, clock);
    expect(training.range).toEqual({
      key: '30d',
      from: new Date('2026-10-18T05:00:00.000Z'),
      to: new Date(NOW),
      timeZone: CHI,
    });

    const maintenance = await getMaintenanceTrendWithDb(env.db, sessA(), { range: '30d', timeZone: UNKNOWN }, clock);
    expect(maintenance.range).toEqual({
      key: '30d',
      from: new Date('2026-10-18T00:00:00.000Z'),
      to: new Date(NOW),
      timeZone: 'UTC',
    });

    const legacy = await getTrainingThroughputWithDb(env.db, sessA(), { range: '30d' }, clock);
    expect(legacy.range).toEqual({ key: '30d', from: new Date(NOW - 30 * DAY), to: new Date(NOW) });
  });
});
