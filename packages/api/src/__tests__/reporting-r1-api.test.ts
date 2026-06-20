/**
 * reporting-r1-api.test.ts — Integration tests for Slice R1.1 (Operational Reports).
 *
 * Tests the 5 new report reads + pure helpers in reporting/internal.ts.
 * Applies migrations 0000–0013 via pglite.
 *
 * TWO SEEDED ORGS (A and B). Org B is seeded with MORE of every metric so that
 * T-ISO-* tests catch any missing org scoping.
 *
 * COVERAGE:
 *   Pure helpers:
 *     resolveReportRange — 5 keys, to exclusive, deterministic.
 *     chooseGranularity — day for 7d/30d; week for 90d/180d/365d.
 *     bucketStartUtc — day floor UTC midnight; week floor UTC Monday;
 *                      DST wall-clock date proves UTC stability.
 *     enumerateBuckets — day: exact count; week: span check; empty range.
 *     safeAvg — happy, den=0→0, 1dp rounding.
 *
 *   getUtilizationTrend:
 *     - hand-computed bucket totals + avgHoursPerFlight
 *     - zero-fill (gap days)
 *     - voided/open excluded
 *     - half-open boundary
 *     - empty org → all 0s no NaN; avgHoursPerFlight=0 (safeAvg guard)
 *     - granularity selection per range key
 *     - T-ISO-UTILTREND: org-A session sees only org-A data
 *     - authz + bad range
 *
 *   getHoursByTail:
 *     - hours DESC, tail ASC ordering
 *     - zero-flight active tail → 0/0
 *     - inactive excluded
 *     - T-ISO-HOURSBYTAIL (the LEFT JOIN isolation)
 *     - 180d/365d widened range keys accepted
 *     - authz + bad range
 *
 *   getReservationsVsFlightsTrend:
 *     - cancelled reservations counted in reservationsCreated
 *     - flights closed series correct
 *     - zero-fill both series
 *     - totals correct
 *     - T-ISO-RESVFLIGHTS
 *     - authz + bad range
 *
 *   getTrainingThroughput:
 *     - hand-computed enrollmentsCreatedInRange / completedInRange /
 *       lessonsRecordedInRange (voided excluded) / activeEnrollmentCount
 *     - empty org → all 0s no NaN
 *     - T-ISO-TRAINING
 *     - accountant (reporting:access-only) gets full data
 *     - authz + bad range
 *
 *   getMaintenanceTrend:
 *     - hand-computed squawksOpened/Resolved/WOsOpened/WOsCompleted
 *     - openSquawkCount snapshot
 *     - groundedAircraftCount snapshot (loadGroundingProbe reuse)
 *     - empty org → all 0s no NaN
 *     - T-ISO-MAINT
 *     - authz + bad range
 *
 *   Capability: accountant (reporting:access-only) passes on all 5.
 *   mechanic/renter/student → Forbidden on all 5.
 *   null → Unauthenticated on all 5.
 *
 * WHY NO PROPERTY TESTS: aggregation functions are I/O-bound; per spec §5 R1.1,
 *   "NO property tests (aggregation is I/O)".
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
import type { PgliteTestClient } from '@aeroops/db';
import { sql as drizzleSql } from 'drizzle-orm';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { deactivateResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { cancelReservationWithDb } from '../scheduling/cancel-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { voidDispatchWithDb } from '../dispatch/void-dispatch.js';
import { groundAircraftWithDb } from '../maintenance/ground-aircraft.js';
import { reportSquawkWithDb } from '../maintenance/report-squawk.js';
import { updateSquawkStatusWithDb } from '../maintenance/update-squawk-status.js';
import { openWorkOrderWithDb } from '../maintenance/open-work-order.js';
import { completeWorkOrderWithDb } from '../maintenance/complete-work-order.js';
import { createCourseWithDb } from '../training/create-course.js';
import { addCourseLessonWithDb } from '../training/add-course-lesson.js';
import { enrollMemberWithDb } from '../training/enroll-member.js';
import { setEnrollmentStatusWithDb } from '../training/set-enrollment-status.js';
import { recordLessonWithDb } from '../training/record-lesson.js';
import { voidLessonRecordWithDb } from '../training/void-lesson-record.js';

import { getUtilizationTrendWithDb } from '../reporting/get-utilization-trend.js';
import { getHoursByTailWithDb } from '../reporting/get-hours-by-tail.js';
import { getReservationsVsFlightsTrendWithDb } from '../reporting/get-reservations-vs-flights-trend.js';
import { getTrainingThroughputWithDb } from '../reporting/get-training-throughput.js';
import { getMaintenanceTrendWithDb } from '../reporting/get-maintenance-trend.js';

import {
  resolveReportRange,
  chooseGranularity,
  bucketStartUtc,
  enumerateBuckets,
  safeAvg,
} from '../reporting/internal.js';

import { ValidationError } from '../scheduling/internal.js';
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
];

// ── Shared helpers ────────────────────────────────────────────────────────────

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

// Future dates for reservations (outside 30d window; avoids booking-policy conflicts).
const FUTURE_D = '2027-06-01';
const TS = {
  W1s: new Date(`${FUTURE_D}T08:00:00Z`),
  W1e: new Date(`${FUTURE_D}T10:00:00Z`),
  W2s: new Date(`${FUTURE_D}T12:00:00Z`),
  W2e: new Date(`${FUTURE_D}T14:00:00Z`),
  W3s: new Date(`${FUTURE_D}T15:00:00Z`),
  W3e: new Date(`${FUTURE_D}T16:00:00Z`),
  W4s: new Date(`${FUTURE_D}T17:00:00Z`),
  W4e: new Date(`${FUTURE_D}T18:00:00Z`),
  W5s: new Date(`${FUTURE_D}T19:00:00Z`),
  W5e: new Date(`${FUTURE_D}T20:00:00Z`),
  W6s: new Date(`${FUTURE_D}T21:00:00Z`),
  W6e: new Date(`${FUTURE_D}T22:00:00Z`),
};

/** Backdate a dispatch ticket's closed_at to a past date. */
async function backdateDispatchClose(
  db: PgliteTestClient,
  orgId: string,
  ticketId: string,
  date: Date,
): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    await tx.execute(drizzleSql`UPDATE dispatch_ticket SET closed_at = ${date} WHERE id = ${ticketId}`);
  });
}

/** Backdate a reservation's created_at to a past date. */
async function backdateReservationCreated(
  db: PgliteTestClient,
  orgId: string,
  reservationId: string,
  date: Date,
): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    await tx.execute(drizzleSql`UPDATE reservation SET created_at = ${date} WHERE id = ${reservationId}`);
  });
}

/** Backdate squawk reported_at / resolved_at. */
async function backdateSquawk(
  db: PgliteTestClient,
  orgId: string,
  squawkId: string,
  reportedAt: Date,
  resolvedAt?: Date,
): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    if (resolvedAt) {
      await tx.execute(drizzleSql`UPDATE squawk SET reported_at = ${reportedAt}, resolved_at = ${resolvedAt} WHERE id = ${squawkId}`);
    } else {
      await tx.execute(drizzleSql`UPDATE squawk SET reported_at = ${reportedAt} WHERE id = ${squawkId}`);
    }
  });
}

/** Backdate work order opened_at / signed_off_at. */
async function backdateWorkOrder(
  db: PgliteTestClient,
  orgId: string,
  workOrderId: string,
  openedAt: Date,
  signedOffAt?: Date,
): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    if (signedOffAt) {
      await tx.execute(drizzleSql`UPDATE work_order SET opened_at = ${openedAt}, signed_off_at = ${signedOffAt} WHERE id = ${workOrderId}`);
    } else {
      await tx.execute(drizzleSql`UPDATE work_order SET opened_at = ${openedAt} WHERE id = ${workOrderId}`);
    }
  });
}

/** Backdate enrollment enrolled_at / status_changed_at. */
async function backdateEnrollment(
  db: PgliteTestClient,
  orgId: string,
  enrollmentId: string,
  enrolledAt: Date,
  statusChangedAt?: Date,
): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    if (statusChangedAt) {
      await tx.execute(drizzleSql`UPDATE enrollment SET enrolled_at = ${enrolledAt}, status_changed_at = ${statusChangedAt} WHERE id = ${enrollmentId}`);
    } else {
      await tx.execute(drizzleSql`UPDATE enrollment SET enrolled_at = ${enrolledAt} WHERE id = ${enrollmentId}`);
    }
  });
}

/** Backdate lesson_record completed_at. */
async function backdateLessonRecord(
  db: PgliteTestClient,
  orgId: string,
  lessonRecordId: string,
  completedAt: Date,
): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    await tx.execute(drizzleSql`UPDATE lesson_record SET completed_at = ${completedAt} WHERE id = ${lessonRecordId}`);
  });
}

/** Create an aircraft + open + close dispatch, optionally backdating closed_at. */
async function seedClosedFlight(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tailNumber: string,
  hobbsOut: number,
  hobbsIn: number,
  slotStart = TS.W1s,
  slotEnd   = TS.W1e,
  closedAt?: Date,
): Promise<{ aircraftId: string; ticketId: string; reservationId: string }> {
  const sess = makeSession(orgId, userId, 'owner');
  const ac = await createResourceWithDb(db, sess, {
    kind: 'aircraft', displayName: `N-${tailNumber}`, tailNumber,
  });
  const r = await createReservationWithDb(db, sess, {
    startAt: slotStart, endAt: slotEnd, resourceIds: [ac.id],
  });
  if (!r.ok) throw new Error(`seed reservation failed: ${r.reason}`);
  const o = await openDispatchWithDb(db, sess, {
    reservationId: r.reservation.id, resourceId: ac.id,
    pilotUserId: userId, hobbsOut, tachOut: hobbsOut,
  });
  if (!o.ok) throw new Error(`seed open failed`);
  const c = await closeDispatchWithDb(db, sess, { ticketId: o.ticket.id, hobbsIn, tachIn: hobbsIn });
  if (!c.ok) throw new Error(`seed close failed`);
  if (closedAt) await backdateDispatchClose(db, orgId, o.ticket.id, closedAt);
  return { aircraftId: ac.id, ticketId: o.ticket.id, reservationId: r.reservation.id };
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 0 — Pure helper unit tests
// ══════════════════════════════════════════════════════════════════════════════

describe('Pure helpers: resolveReportRange', () => {
  const NOW = new Date('2026-06-20T12:00:00Z');

  it('7d: from = now - 7 days, to = now (exclusive)', () => {
    const { from, to } = resolveReportRange('7d', NOW);
    expect(to.getTime()).toBe(NOW.getTime());
    expect(from.getTime()).toBe(NOW.getTime() - 7 * 86_400_000);
  });

  it('30d: window = 30 days exactly', () => {
    const { from, to } = resolveReportRange('30d', NOW);
    expect(to.getTime() - from.getTime()).toBe(30 * 86_400_000);
  });

  it('90d: window = 90 days exactly', () => {
    const { from, to } = resolveReportRange('90d', NOW);
    expect(to.getTime() - from.getTime()).toBe(90 * 86_400_000);
  });

  it('180d: window = 180 days exactly', () => {
    const { from, to } = resolveReportRange('180d', NOW);
    expect(to.getTime() - from.getTime()).toBe(180 * 86_400_000);
  });

  it('365d: window = 365 days exactly', () => {
    const { from, to } = resolveReportRange('365d', NOW);
    expect(to.getTime() - from.getTime()).toBe(365 * 86_400_000);
  });

  it('to is exclusive (equals now)', () => {
    const { to } = resolveReportRange('30d', NOW);
    expect(to.getTime()).toBe(NOW.getTime());
  });

  it('deterministic: same now → same result', () => {
    const r1 = resolveReportRange('90d', NOW);
    const r2 = resolveReportRange('90d', NOW);
    expect(r1.from.getTime()).toBe(r2.from.getTime());
    expect(r1.to.getTime()).toBe(r2.to.getTime());
  });
});

describe('Pure helpers: chooseGranularity', () => {
  it('7d → day', ()  => expect(chooseGranularity('7d')).toBe('day'));
  it('30d → day', () => expect(chooseGranularity('30d')).toBe('day'));
  it('90d → week', () => expect(chooseGranularity('90d')).toBe('week'));
  it('180d → week', () => expect(chooseGranularity('180d')).toBe('week'));
  it('365d → week', () => expect(chooseGranularity('365d')).toBe('week'));
});

describe('Pure helpers: bucketStartUtc', () => {
  it('day: floors to UTC midnight on same calendar day', () => {
    const d = new Date('2026-06-20T15:30:45.123Z');
    const bs = bucketStartUtc(d, 'day');
    expect(bs.toISOString()).toBe('2026-06-20T00:00:00.000Z');
  });

  it('day: already at midnight stays at midnight', () => {
    const d = new Date('2026-06-20T00:00:00.000Z');
    const bs = bucketStartUtc(d, 'day');
    expect(bs.toISOString()).toBe('2026-06-20T00:00:00.000Z');
  });

  it('week: Monday returns same day 00:00 UTC', () => {
    // 2026-06-15 is a Monday
    const d = new Date('2026-06-15T10:00:00Z');
    const bs = bucketStartUtc(d, 'week');
    expect(bs.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });

  it('week: Wednesday returns preceding Monday 00:00 UTC', () => {
    // 2026-06-17 is a Wednesday → bucket start 2026-06-15 (Monday)
    const d = new Date('2026-06-17T23:59:59Z');
    const bs = bucketStartUtc(d, 'week');
    expect(bs.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });

  it('week: Sunday returns preceding Monday 00:00 UTC (6 days back)', () => {
    // 2026-06-21 is a Sunday → bucket start 2026-06-15 (Monday)
    const d = new Date('2026-06-21T12:00:00Z');
    const bs = bucketStartUtc(d, 'week');
    expect(bs.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });

  it('DST wall-clock stability: US daylight/standard transition date → UTC unchanged', () => {
    // 2026-03-08 02:00 is when US clocks spring forward. In UTC this date is
    // 2026-03-08. The UTC bucket should be 2026-03-08T00:00:00Z regardless of
    // any local wall-clock DST jump.
    // If we pick a time right around the transition (01:30 UTC = before clock change):
    const d = new Date('2026-03-08T01:30:00Z'); // UTC Sunday at 01:30
    // getUTCDay() for 2026-03-08 = Sunday = 0 → daysToMonday = 6
    // Monday = 2026-03-02T00:00:00Z
    const weekBucket = bucketStartUtc(d, 'week');
    expect(weekBucket.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    // Day bucket should be 2026-03-08T00:00:00Z (UTC midnight, not local midnight)
    const dayBucket = bucketStartUtc(d, 'day');
    expect(dayBucket.toISOString()).toBe('2026-03-08T00:00:00.000Z');
  });
});

describe('Pure helpers: enumerateBuckets', () => {
  it('day: 7d window starting exactly at midnight → exactly 7 buckets', () => {
    // When both from and to are exactly at midnight, we get exactly N buckets.
    const now = new Date('2026-06-20T00:00:00Z');
    const from = new Date(now.getTime() - 7 * 86_400_000);
    const to = now;
    const buckets = enumerateBuckets(from, to, 'day');
    expect(buckets.length).toBe(7);
  });

  it('day: 7d window with non-midnight now → 7 or 8 buckets (boundary)', () => {
    const now = new Date('2026-06-20T12:00:00Z');
    const from = new Date(now.getTime() - 7 * 86_400_000);
    const to = now;
    const buckets = enumerateBuckets(from, to, 'day');
    expect(buckets.length).toBeGreaterThanOrEqual(7);
    expect(buckets.length).toBeLessThanOrEqual(8);
  });

  it('day: 30d window starting exactly at midnight → exactly 30 buckets', () => {
    // When from = exactly 30 days before midnight-aligned now, we get exactly 30 day-buckets.
    const now = new Date('2026-06-20T00:00:00Z');
    const from = new Date(now.getTime() - 30 * 86_400_000);
    const to = now;
    const buckets = enumerateBuckets(from, to, 'day');
    expect(buckets.length).toBe(30);
  });

  it('day: 30d window with non-midnight now → 30 or 31 buckets (boundary)', () => {
    // When from is at 12:00 UTC 30 days ago, the first bucket is midnight 30d ago,
    // the last is midnight today (still < to=12:00 today). That's 31 buckets.
    const now = new Date('2026-06-20T12:00:00Z');
    const from = new Date(now.getTime() - 30 * 86_400_000);
    const to = now;
    const buckets = enumerateBuckets(from, to, 'day');
    expect(buckets.length).toBeGreaterThanOrEqual(30);
    expect(buckets.length).toBeLessThanOrEqual(31);
  });

  it('week: 90d window → at least 12 and at most 14 buckets', () => {
    const now = new Date('2026-06-20T12:00:00Z');
    const from = new Date(now.getTime() - 90 * 86_400_000);
    const to = now;
    const buckets = enumerateBuckets(from, to, 'week');
    expect(buckets.length).toBeGreaterThanOrEqual(12);
    expect(buckets.length).toBeLessThanOrEqual(14);
  });

  it('week: 365d window → at most 53 buckets', () => {
    const now = new Date('2026-06-20T12:00:00Z');
    const from = new Date(now.getTime() - 365 * 86_400_000);
    const to = now;
    const buckets = enumerateBuckets(from, to, 'week');
    expect(buckets.length).toBeLessThanOrEqual(53);
  });

  it('empty range (from = to = UTC midnight) → [] (bucket start equals to, not emitted)', () => {
    // When from=to=midnight, bucketStartUtc(from)=midnight is NOT < to=midnight, so no buckets.
    const d = new Date('2026-06-20T00:00:00Z');
    const buckets = enumerateBuckets(d, d, 'day');
    expect(buckets.length).toBe(0);
  });

  it('all buckets are UTC-aligned (toISOString ends in T00:00:00.000Z for day)', () => {
    const now = new Date('2026-06-20T12:00:00Z');
    const from = new Date(now.getTime() - 7 * 86_400_000);
    const buckets = enumerateBuckets(from, now, 'day');
    for (const b of buckets) {
      expect(b.toISOString()).toMatch(/T00:00:00\.000Z$/);
    }
  });

  it('buckets are ordered ascending', () => {
    const now = new Date('2026-06-20T12:00:00Z');
    const from = new Date(now.getTime() - 30 * 86_400_000);
    const buckets = enumerateBuckets(from, now, 'day');
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]!.getTime()).toBeGreaterThan(buckets[i - 1]!.getTime());
    }
  });
});

describe('Pure helpers: safeAvg', () => {
  it('den=0 → 0 (no NaN, no Infinity)', () => {
    expect(safeAvg(5, 0)).toBe(0);
    expect(safeAvg(0, 0)).toBe(0);
    expect(Number.isNaN(safeAvg(0, 0))).toBe(false);
  });

  it('1.5 / 1 → 1.5', () => {
    expect(safeAvg(1.5, 1)).toBe(1.5);
  });

  it('3.0 / 2 → 1.5', () => {
    expect(safeAvg(3.0, 2)).toBe(1.5);
  });

  it('rounds to 1dp: 1.05 / 1 → 1.1 (or 1.0 per rounding)', () => {
    // Math.round(1.05 * 10) / 10 = Math.round(10.5) / 10 = 11/10 = 1.1 in JS
    const result = safeAvg(1.05, 1);
    expect(result).toBe(Math.round(1.05 * 10) / 10);
  });

  it('5.0 / 2 → 2.5', () => {
    expect(safeAvg(5.0, 2)).toBe(2.5);
  });

  it('result is always a number (not NaN, not Infinity)', () => {
    expect(Number.isNaN(safeAvg(0, 10))).toBe(false);
    expect(Number.isFinite(safeAvg(100, 7))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SHARED TEST DB SETUP
// ══════════════════════════════════════════════════════════════════════════════

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
}

let sharedEnv: TestEnv;

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });
  sharedEnv = {
    db, pglite,
    orgAId: seed.orgAId, orgBId: seed.orgBId,
    userAId: seed.userAId, userBId: seed.userBId,
  };
}, 60_000);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — AUTHZ: all 5 fns
// ══════════════════════════════════════════════════════════════════════════════

describe('AUTHZ: null → Unauthenticated on all 5 fns', () => {
  it('getUtilizationTrend: null → Unauthenticated', async () => {
    const { db } = sharedEnv;
    await expect(getUtilizationTrendWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
  it('getHoursByTail: null → Unauthenticated', async () => {
    const { db } = sharedEnv;
    await expect(getHoursByTailWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
  it('getReservationsVsFlightsTrend: null → Unauthenticated', async () => {
    const { db } = sharedEnv;
    await expect(getReservationsVsFlightsTrendWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
  it('getTrainingThroughput: null → Unauthenticated', async () => {
    const { db } = sharedEnv;
    await expect(getTrainingThroughputWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
  it('getMaintenanceTrend: null → Unauthenticated', async () => {
    const { db } = sharedEnv;
    await expect(getMaintenanceTrendWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('AUTHZ: mechanic/renter/student → Forbidden on all 5 fns', () => {
  const DENIED_ROLES: AppSession['role'][] = ['mechanic', 'renter', 'student'];
  const FNS = [
    { name: 'getUtilizationTrend',            fn: (db: PgliteTestClient, s: AppSession) => getUtilizationTrendWithDb(db, s) },
    { name: 'getHoursByTail',                  fn: (db: PgliteTestClient, s: AppSession) => getHoursByTailWithDb(db, s) },
    { name: 'getReservationsVsFlightsTrend',   fn: (db: PgliteTestClient, s: AppSession) => getReservationsVsFlightsTrendWithDb(db, s) },
    { name: 'getTrainingThroughput',           fn: (db: PgliteTestClient, s: AppSession) => getTrainingThroughputWithDb(db, s) },
    { name: 'getMaintenanceTrend',             fn: (db: PgliteTestClient, s: AppSession) => getMaintenanceTrendWithDb(db, s) },
  ];

  for (const role of DENIED_ROLES) {
    for (const { name, fn } of FNS) {
      it(`${role} → Forbidden on ${name}`, async () => {
        const { db, orgAId, userAId } = sharedEnv;
        const sess = makeSession(orgAId, userAId, role);
        await expect(fn(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
      });
    }
  }
});

describe('AUTHZ: accountant (reporting:access-only) passes all 5 — fixes dashboard fail-closed nit', () => {
  it('accountant → getUtilizationTrend resolves', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'accountant');
    const result = await getUtilizationTrendWithDb(db, sess);
    expect(result).toBeDefined();
    expect(Array.isArray(result.buckets)).toBe(true);
  });
  it('accountant → getHoursByTail resolves', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'accountant');
    const rows = await getHoursByTailWithDb(db, sess);
    expect(Array.isArray(rows)).toBe(true);
  });
  it('accountant → getReservationsVsFlightsTrend resolves', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'accountant');
    const result = await getReservationsVsFlightsTrendWithDb(db, sess);
    expect(result).toBeDefined();
  });
  it('accountant → getTrainingThroughput resolves', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'accountant');
    const result = await getTrainingThroughputWithDb(db, sess);
    expect(result).toBeDefined();
  });
  it('accountant → getMaintenanceTrend resolves', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'accountant');
    const result = await getMaintenanceTrendWithDb(db, sess);
    expect(result).toBeDefined();
  });
});

describe('VALIDATION: bad range → ValidationError on all 5 fns', () => {
  const FNS = [
    { name: 'getUtilizationTrend',            fn: (db: PgliteTestClient, s: AppSession, r: string) => getUtilizationTrendWithDb(db, s, { range: r }) },
    { name: 'getHoursByTail',                  fn: (db: PgliteTestClient, s: AppSession, r: string) => getHoursByTailWithDb(db, s, { range: r }) },
    { name: 'getReservationsVsFlightsTrend',   fn: (db: PgliteTestClient, s: AppSession, r: string) => getReservationsVsFlightsTrendWithDb(db, s, { range: r }) },
    { name: 'getTrainingThroughput',           fn: (db: PgliteTestClient, s: AppSession, r: string) => getTrainingThroughputWithDb(db, s, { range: r }) },
    { name: 'getMaintenanceTrend',             fn: (db: PgliteTestClient, s: AppSession, r: string) => getMaintenanceTrendWithDb(db, s, { range: r }) },
  ];

  for (const { name, fn } of FNS) {
    it(`${name}: range="bad" → ValidationError`, async () => {
      const { db, orgAId, userAId } = sharedEnv;
      const sess = makeSession(orgAId, userAId, 'owner');
      await expect(fn(db, sess, 'bad')).rejects.toBeInstanceOf(ValidationError);
    });
    it(`${name}: range="1d" → ValidationError`, async () => {
      const { db, orgAId, userAId } = sharedEnv;
      const sess = makeSession(orgAId, userAId, 'owner');
      await expect(fn(db, sess, '1d')).rejects.toBeInstanceOf(ValidationError);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — getUtilizationTrend
// ══════════════════════════════════════════════════════════════════════════════

describe('getUtilizationTrend: happy path + hand-computed values', () => {
  /**
   * HAND-COMPUTED SAMPLE:
   *   Flight A: hobbsOut=100, hobbsIn=102.0 → 2.0h, closed 5 days ago
   *   Flight B: hobbsOut=200, hobbsIn=201.5 → 1.5h, closed 5 days ago (same bucket as A)
   *   Flight C: hobbsOut=300, hobbsIn=300.5 → 0.5h, closed 20 days ago (different bucket)
   *
   *   30d range, day granularity:
   *     totalFlights       = 3
   *     totalFlightHours   = 2.0 + 1.5 + 0.5 = 4.0
   *     avgHoursPerFlight  = safeAvg(4.0, 3) = 1.3 (Math.round(4.0/3*10)/10=1.3)
   *     bucket at "5 days ago": flightCount=2, flightHours=3.5
   *     bucket at "20 days ago": flightCount=1, flightHours=0.5
   *     all other 28 buckets: flightCount=0, flightHours=0
   */

  let utilDb: PgliteTestClient;
  let utilOrgId: string;
  let utilUserId: string;
  const fiveDaysAgo  = new Date(Date.now() - 5  * 86_400_000);
  const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000);

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    utilDb = db;
    utilOrgId  = seed.orgAId;
    utilUserId = seed.userAId;

    // Flight A: 2.0h, 5 days ago
    const a = await seedClosedFlight(utilDb, utilOrgId, utilUserId, 'UTILA', 100, 102.0, TS.W1s, TS.W1e);
    await backdateDispatchClose(utilDb, utilOrgId, a.ticketId, fiveDaysAgo);

    // Flight B: 1.5h, 5 days ago (same bucket as A — different aircraft)
    const b = await seedClosedFlight(utilDb, utilOrgId, utilUserId, 'UTILB', 200, 201.5, TS.W2s, TS.W2e);
    await backdateDispatchClose(utilDb, utilOrgId, b.ticketId, fiveDaysAgo);

    // Flight C: 0.5h, 20 days ago (different bucket)
    const c = await seedClosedFlight(utilDb, utilOrgId, utilUserId, 'UTILC', 300, 300.5, TS.W3s, TS.W3e);
    await backdateDispatchClose(utilDb, utilOrgId, c.ticketId, twentyDaysAgo);
  }, 120_000);

  it('totalFlights = 3', async () => {
    const sess = makeSession(utilOrgId, utilUserId, 'owner');
    const r = await getUtilizationTrendWithDb(utilDb, sess, { range: '30d' });
    expect(r.totalFlights).toBe(3);
  });

  it('totalFlightHours = 4.0 (2.0 + 1.5 + 0.5, rounded to 1dp)', async () => {
    const sess = makeSession(utilOrgId, utilUserId, 'owner');
    const r = await getUtilizationTrendWithDb(utilDb, sess, { range: '30d' });
    expect(r.totalFlightHours).toBeCloseTo(4.0, 1);
  });

  it('avgHoursPerFlight = safeAvg(4.0, 3) ≈ 1.3', async () => {
    const sess = makeSession(utilOrgId, utilUserId, 'owner');
    const r = await getUtilizationTrendWithDb(utilDb, sess, { range: '30d' });
    // Math.round(4.0/3*10)/10 = Math.round(13.333)/10 = 13/10 = 1.3
    expect(r.avgHoursPerFlight).toBeCloseTo(1.3, 1);
  });

  it('granularity = "day" for 30d range', async () => {
    const sess = makeSession(utilOrgId, utilUserId, 'owner');
    const r = await getUtilizationTrendWithDb(utilDb, sess, { range: '30d' });
    expect(r.granularity).toBe('day');
  });

  it('granularity = "week" for 90d range', async () => {
    const sess = makeSession(utilOrgId, utilUserId, 'owner');
    const r = await getUtilizationTrendWithDb(utilDb, sess, { range: '90d' });
    expect(r.granularity).toBe('week');
  });

  it('30d → at least 30, at most 31 buckets (zero-fill; day granularity)', async () => {
    // 30d window at day granularity: from=now-30d floored to midnight.
    // Depending on time-of-day, this produces 30 or 31 buckets (both valid per spec).
    const sess = makeSession(utilOrgId, utilUserId, 'owner');
    const r = await getUtilizationTrendWithDb(utilDb, sess, { range: '30d' });
    expect(r.buckets.length).toBeGreaterThanOrEqual(30);
    expect(r.buckets.length).toBeLessThanOrEqual(31);
  });

  it('zero-fill: all-but-2 buckets have flightCount=0, flightHours=0', async () => {
    const sess = makeSession(utilOrgId, utilUserId, 'owner');
    const r = await getUtilizationTrendWithDb(utilDb, sess, { range: '30d' });
    const nonZeroBuckets = r.buckets.filter((b) => b.flightCount > 0);
    // We seeded 2 non-zero buckets (5d-ago + 20d-ago); all others should be 0.
    expect(nonZeroBuckets.length).toBe(2);
    const zeroBuckets = r.buckets.filter((b) => b.flightCount === 0);
    for (const b of zeroBuckets) {
      expect(Number.isNaN(b.flightHours)).toBe(false);
      expect(b.flightHours).toBe(0);
    }
  });

  it('5-days-ago bucket: flightCount=2, flightHours=3.5', async () => {
    const sess = makeSession(utilOrgId, utilUserId, 'owner');
    const r = await getUtilizationTrendWithDb(utilDb, sess, { range: '30d' });
    // Find the bucket matching fiveDaysAgo UTC midnight
    const fiveBucketKey = new Date(Date.UTC(
      fiveDaysAgo.getUTCFullYear(),
      fiveDaysAgo.getUTCMonth(),
      fiveDaysAgo.getUTCDate(),
    )).toISOString();
    const bucket = r.buckets.find((b) => b.bucketStart.toISOString() === fiveBucketKey);
    expect(bucket).toBeDefined();
    expect(bucket?.flightCount).toBe(2);
    expect(bucket?.flightHours).toBeCloseTo(3.5, 1);
  });

  it('20-days-ago bucket: flightCount=1, flightHours=0.5', async () => {
    const sess = makeSession(utilOrgId, utilUserId, 'owner');
    const r = await getUtilizationTrendWithDb(utilDb, sess, { range: '30d' });
    const twentyBucketKey = new Date(Date.UTC(
      twentyDaysAgo.getUTCFullYear(),
      twentyDaysAgo.getUTCMonth(),
      twentyDaysAgo.getUTCDate(),
    )).toISOString();
    const bucket = r.buckets.find((b) => b.bucketStart.toISOString() === twentyBucketKey);
    expect(bucket).toBeDefined();
    expect(bucket?.flightCount).toBe(1);
    expect(bucket?.flightHours).toBeCloseTo(0.5, 1);
  });

  it('half-open: 7d range excludes 20d-ago flight (outside window)', async () => {
    const sess = makeSession(utilOrgId, utilUserId, 'owner');
    const r = await getUtilizationTrendWithDb(utilDb, sess, { range: '7d' });
    // Only flights A and B (5 days ago) should be within 7d
    expect(r.totalFlights).toBe(2);
  });

  it('range object: key, from < to, to close to now', async () => {
    const sess = makeSession(utilOrgId, utilUserId, 'owner');
    const r = await getUtilizationTrendWithDb(utilDb, sess, { range: '30d' });
    expect(r.range.key).toBe('30d');
    expect(r.range.from.getTime()).toBeLessThan(r.range.to.getTime());
    expect(Math.abs(r.range.to.getTime() - Date.now())).toBeLessThan(5000);
  });

  it('default range (omitted) → 30d', async () => {
    const sess = makeSession(utilOrgId, utilUserId, 'owner');
    const r = await getUtilizationTrendWithDb(utilDb, sess, {});
    expect(r.range.key).toBe('30d');
  });
}, 120_000);

describe('getUtilizationTrend: voided + open excluded', () => {
  it('voided + open tickets do NOT count; only closed does', async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    const sess = makeSession(seed.orgAId, seed.userAId, 'owner');
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);

    // Aircraft 1: open ticket (not counted)
    const acOpen = await createResourceWithDb(db, sess, { kind: 'aircraft', displayName: 'OPEN', tailNumber: 'RVOPEN' });
    const rOpen = await createReservationWithDb(db, sess, { startAt: TS.W1s, endAt: TS.W1e, resourceIds: [acOpen.id] });
    if (!rOpen.ok) throw new Error('rOpen failed');
    await openDispatchWithDb(db, sess, { reservationId: rOpen.reservation.id, resourceId: acOpen.id, pilotUserId: seed.userAId, hobbsOut: 100, tachOut: 100 });

    // Aircraft 2: voided ticket (not counted)
    const acVoid = await createResourceWithDb(db, sess, { kind: 'aircraft', displayName: 'VOID', tailNumber: 'RVVOID' });
    const rVoid = await createReservationWithDb(db, sess, { startAt: TS.W2s, endAt: TS.W2e, resourceIds: [acVoid.id] });
    if (!rVoid.ok) throw new Error('rVoid failed');
    const oVoid = await openDispatchWithDb(db, sess, { reservationId: rVoid.reservation.id, resourceId: acVoid.id, pilotUserId: seed.userAId, hobbsOut: 200, tachOut: 200 });
    if (!oVoid.ok) throw new Error('oVoid failed');
    await voidDispatchWithDb(db, sess, { ticketId: oVoid.ticket.id, reason: 'test' });

    // Aircraft 3: closed ticket (COUNTED)
    const { ticketId } = await seedClosedFlight(db, seed.orgAId, seed.userAId, 'RVCLSD', 300, 301.0, TS.W3s, TS.W3e);
    await backdateDispatchClose(db, seed.orgAId, ticketId, fiveDaysAgo);

    const r = await getUtilizationTrendWithDb(db, sess, { range: '30d' });
    expect(r.totalFlights).toBe(1);
    expect(r.totalFlightHours).toBeCloseTo(1.0, 1);
  }, 60_000);
});

describe('getUtilizationTrend: empty org → all zeros, no NaN, avgHoursPerFlight=0', () => {
  it('empty org → totalFlights=0, avgHoursPerFlight=0 (safeAvg guard)', async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    const sess = makeSession(seed.orgAId, seed.userAId, 'owner');
    const r = await getUtilizationTrendWithDb(db, sess, { range: '30d' });
    expect(r.totalFlights).toBe(0);
    expect(r.totalFlightHours).toBe(0);
    expect(r.avgHoursPerFlight).toBe(0); // safeAvg(0, 0) = 0
    expect(Number.isNaN(r.avgHoursPerFlight)).toBe(false);
    // 30d/day → 30 or 31 buckets depending on time-of-day (both valid).
    expect(r.buckets.length).toBeGreaterThanOrEqual(30);
    expect(r.buckets.length).toBeLessThanOrEqual(31);
    for (const b of r.buckets) {
      expect(Number.isNaN(b.flightCount)).toBe(false);
      expect(Number.isNaN(b.flightHours)).toBe(false);
      expect(b.flightCount).toBe(0);
      expect(b.flightHours).toBe(0);
    }
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — T-ISO: Tenant isolation for all 5 fns
// ══════════════════════════════════════════════════════════════════════════════

describe('T-ISO: Tenant isolation — all 5 R1.1 report fns', () => {
  /**
   * Org A: 1 closed flight (1.5h), 1 open squawk, 1 active enrollment
   * Org B: 3 closed flights (2h each = 6h), 3 open squawks, 3 active enrollments, 1 grounded aircraft
   * Org-A session must return ONLY org-A values.
   */

  let isoDb: PgliteTestClient;
  let isoOrgAId: string;
  let isoOrgBId: string;
  let isoUserAId: string;
  let isoUserBId: string;

  // Org A aircraft ID (for T-ISO-HOURSBYTAIL LEFT JOIN check)
  let isoAcAId: string;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });

    isoDb = db;
    isoOrgAId = seed.orgAId;
    isoOrgBId = seed.orgBId;
    isoUserAId = seed.userAId;
    isoUserBId = seed.userBId;

    const sessA = makeSession(isoOrgAId, isoUserAId, 'owner');
    const sessB = makeSession(isoOrgBId, isoUserBId, 'owner');
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);

    // Org A: 1 flight (1.5h)
    const { aircraftId: acAId, ticketId: ticketAId, reservationId: rAId } = await seedClosedFlight(
      isoDb, isoOrgAId, isoUserAId, 'ISOA1', 100, 101.5, TS.W1s, TS.W1e,
    );
    isoAcAId = acAId;
    await backdateDispatchClose(isoDb, isoOrgAId, ticketAId, fiveDaysAgo);
    await backdateReservationCreated(isoDb, isoOrgAId, rAId, fiveDaysAgo);

    // Org B: 3 flights (2h each)
    for (let i = 1; i <= 3; i++) {
      const slots = [
        [TS.W1s, TS.W1e], [TS.W2s, TS.W2e], [TS.W3s, TS.W3e],
      ][i - 1]!;
      const { ticketId, reservationId } = await seedClosedFlight(
        isoDb, isoOrgBId, isoUserBId, `ISOB${i}`, 200, 202.0, slots[0], slots[1],
      );
      await backdateDispatchClose(isoDb, isoOrgBId, ticketId, fiveDaysAgo);
      await backdateReservationCreated(isoDb, isoOrgBId, reservationId, fiveDaysAgo);
    }

    // Org A: 1 open squawk
    await reportSquawkWithDb(isoDb, sessA, { resourceId: acAId, title: 'ISO-SQ-A', severity: 'low' });

    // Org B: 3 open squawks (more than A)
    for (let i = 1; i <= 3; i++) {
      const acBExtra = await createResourceWithDb(isoDb, sessB, {
        kind: 'aircraft', displayName: `N-SQB${i}`, tailNumber: `ISOSQB${i}`,
      });
      await reportSquawkWithDb(isoDb, sessB, { resourceId: acBExtra.id, title: `ISO-SQ-B${i}`, severity: 'low' });
    }

    // Org B: 1 grounded aircraft (org A has none)
    const acBGnd = await createResourceWithDb(isoDb, sessB, {
      kind: 'aircraft', displayName: 'N-GND-ISO-B', tailNumber: 'ISOGNDB',
    });
    await groundAircraftWithDb(isoDb, sessB, { resourceId: acBGnd.id, reason: 'ISO test' });

    // Org A: 1 active enrollment
    const courseA = await createCourseWithDb(isoDb, sessA, { title: 'ISO Course A' });
    if (!courseA.ok) throw new Error('courseA failed');
    const eA = await enrollMemberWithDb(isoDb, sessA, { courseId: courseA.course.courseId, studentUserId: isoUserAId });
    if (!eA.ok) throw new Error('eA failed');
    await backdateEnrollment(isoDb, isoOrgAId, eA.enrollment.enrollmentId, fiveDaysAgo);

    // Org B: 3 active enrollments (more than A)
    for (let i = 1; i <= 3; i++) {
      const courseB = await createCourseWithDb(isoDb, sessB, { title: `ISO Course B${i}` });
      if (!courseB.ok) throw new Error(`courseB${i} failed`);
      const eB = await enrollMemberWithDb(isoDb, sessB, { courseId: courseB.course.courseId, studentUserId: isoUserBId });
      if (!eB.ok) throw new Error(`eB${i} failed`);
      await backdateEnrollment(isoDb, isoOrgBId, eB.enrollment.enrollmentId, fiveDaysAgo);
    }
  }, 180_000);

  it('T-ISO-UTILTREND: org-A sees 1 flight (NOT org-B\'s 3)', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const r = await getUtilizationTrendWithDb(isoDb, sess, { range: '30d' });
    expect(r.totalFlights).toBe(1);
    expect(r.totalFlightHours).toBeCloseTo(1.5, 1);
  });

  it('T-ISO-UTILTREND: org-B session sees 3 flights (confirms B has MORE)', async () => {
    const sess = makeSession(isoOrgBId, isoUserBId, 'owner');
    const r = await getUtilizationTrendWithDb(isoDb, sess, { range: '30d' });
    expect(r.totalFlights).toBe(3);
  });

  it('T-ISO-HOURSBYTAIL (LEFT JOIN): org-A session sees only org-A tail', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const rows = await getHoursByTailWithDb(isoDb, sess, { range: '30d' });
    const tails = rows.map((r) => r.tailNumber);
    expect(tails).toContain('ISOA1');
    // Org-B tails must NOT appear
    expect(tails.some((t) => t.startsWith('ISOB'))).toBe(false);
    expect(rows.length).toBe(1);
    expect(rows[0]?.flightHours).toBeCloseTo(1.5, 1);
  });

  it('T-ISO-HOURSBYTAIL: org-B session sees 3+ tails with MORE hours', async () => {
    const sess = makeSession(isoOrgBId, isoUserBId, 'owner');
    const rows = await getHoursByTailWithDb(isoDb, sess, { range: '30d' });
    const tails = rows.map((r) => r.tailNumber);
    expect(tails.some((t) => t.startsWith('ISOB'))).toBe(true);
    // Org-A's ISOA1 must NOT appear
    expect(tails).not.toContain('ISOA1');
  });

  it('T-ISO-RESVFLIGHTS: org-A session reservationsCreated = 1', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const r = await getReservationsVsFlightsTrendWithDb(isoDb, sess, { range: '30d' });
    expect(r.totalReservationsCreated).toBe(1);
    expect(r.totalFlightsClosed).toBe(1);
  });

  it('T-ISO-RESVFLIGHTS: org-B session sees 3 (confirms isolation)', async () => {
    const sess = makeSession(isoOrgBId, isoUserBId, 'owner');
    const r = await getReservationsVsFlightsTrendWithDb(isoDb, sess, { range: '30d' });
    expect(r.totalReservationsCreated).toBe(3);
    expect(r.totalFlightsClosed).toBe(3);
  });

  it('T-ISO-TRAINING: org-A session sees 1 enrollment created (NOT org-B\'s 3)', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const r = await getTrainingThroughputWithDb(isoDb, sess, { range: '30d' });
    expect(r.enrollmentsCreatedInRange).toBe(1);
    expect(r.activeEnrollmentCount).toBe(1);
  });

  it('T-ISO-TRAINING: org-B session sees 3 enrollments (confirms B has MORE)', async () => {
    const sess = makeSession(isoOrgBId, isoUserBId, 'owner');
    const r = await getTrainingThroughputWithDb(isoDb, sess, { range: '30d' });
    expect(r.enrollmentsCreatedInRange).toBe(3);
    expect(r.activeEnrollmentCount).toBe(3);
  });

  it('T-ISO-MAINT: org-A sees 1 open squawk (NOT org-B\'s 3)', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const r = await getMaintenanceTrendWithDb(isoDb, sess, { range: '30d' });
    expect(r.openSquawkCount).toBe(1);
  });

  it('T-ISO-MAINT: org-A sees 0 grounded aircraft (NOT org-B\'s 1)', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const r = await getMaintenanceTrendWithDb(isoDb, sess, { range: '30d' });
    expect(r.groundedAircraftCount).toBe(0);
  });

  it('T-ISO-MAINT: org-B sees 1 grounded aircraft', async () => {
    const sess = makeSession(isoOrgBId, isoUserBId, 'owner');
    const r = await getMaintenanceTrendWithDb(isoDb, sess, { range: '30d' });
    expect(r.groundedAircraftCount).toBe(1);
  });
}, 180_000);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — getHoursByTail
// ══════════════════════════════════════════════════════════════════════════════

describe('getHoursByTail: ordering + zero-flight + inactive + widened range', () => {
  let htDb: PgliteTestClient;
  let htOrgId: string;
  let htUserId: string;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    htDb = db;
    htOrgId = seed.orgAId;
    htUserId = seed.userAId;

    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);

    // Tail A: 3.0h (highest)
    const a = await seedClosedFlight(htDb, htOrgId, htUserId, 'HTA', 100, 103.0, TS.W1s, TS.W1e);
    await backdateDispatchClose(htDb, htOrgId, a.ticketId, fiveDaysAgo);

    // Tail B: 1.5h (middle)
    const b = await seedClosedFlight(htDb, htOrgId, htUserId, 'HTB', 200, 201.5, TS.W2s, TS.W2e);
    await backdateDispatchClose(htDb, htOrgId, b.ticketId, fiveDaysAgo);

    // Tail C: 0h (no dispatch — zero-flight tail)
    const sess = makeSession(htOrgId, htUserId, 'owner');
    await createResourceWithDb(htDb, sess, { kind: 'aircraft', displayName: 'N-HTC', tailNumber: 'HTC' });

    // Tail D: INACTIVE — should not appear
    const acD = await createResourceWithDb(htDb, sess, { kind: 'aircraft', displayName: 'N-HTD', tailNumber: 'HTD' });
    await deactivateResourceWithDb(htDb, sess, { resourceId: acD.id });
  }, 120_000);

  it('returns 3 rows (3 active aircraft; inactive excluded)', async () => {
    const sess = makeSession(htOrgId, htUserId, 'owner');
    const rows = await getHoursByTailWithDb(htDb, sess, { range: '30d' });
    expect(rows.length).toBe(3);
    const tails = rows.map((r) => r.tailNumber);
    expect(tails).not.toContain('HTD'); // inactive
  });

  it('ordered hours DESC: HTA (3.0h) first, HTB (1.5h) second, HTC (0h) third', async () => {
    const sess = makeSession(htOrgId, htUserId, 'owner');
    const rows = await getHoursByTailWithDb(htDb, sess, { range: '30d' });
    expect(rows[0]?.tailNumber).toBe('HTA');
    expect(rows[1]?.tailNumber).toBe('HTB');
    expect(rows[2]?.tailNumber).toBe('HTC');
  });

  it('HTA: flightCount=1, flightHours=3.0', async () => {
    const sess = makeSession(htOrgId, htUserId, 'owner');
    const rows = await getHoursByTailWithDb(htDb, sess, { range: '30d' });
    const row = rows.find((r) => r.tailNumber === 'HTA');
    expect(row?.flightCount).toBe(1);
    expect(row?.flightHours).toBeCloseTo(3.0, 1);
  });

  it('HTC (zero-flight): flightCount=0, flightHours=0, not NaN', async () => {
    const sess = makeSession(htOrgId, htUserId, 'owner');
    const rows = await getHoursByTailWithDb(htDb, sess, { range: '30d' });
    const row = rows.find((r) => r.tailNumber === 'HTC');
    expect(row).toBeDefined();
    expect(row?.flightCount).toBe(0);
    expect(row?.flightHours).toBe(0);
    expect(Number.isNaN(row?.flightHours)).toBe(false);
  });

  it('accepts widened range keys: 180d resolves', async () => {
    const sess = makeSession(htOrgId, htUserId, 'owner');
    const rows = await getHoursByTailWithDb(htDb, sess, { range: '180d' });
    expect(Array.isArray(rows)).toBe(true);
  });

  it('accepts widened range keys: 365d resolves', async () => {
    const sess = makeSession(htOrgId, htUserId, 'owner');
    const rows = await getHoursByTailWithDb(htDb, sess, { range: '365d' });
    expect(Array.isArray(rows)).toBe(true);
  });
}, 120_000);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — getReservationsVsFlightsTrend
// ══════════════════════════════════════════════════════════════════════════════

describe('getReservationsVsFlightsTrend: cancelled counted + zero-fill + totals', () => {
  /**
   * HAND-COMPUTED:
   *   - 2 reservations created 5 days ago:
   *       R1 = active (not cancelled)
   *       R2 = cancelled (still counts in reservationsCreated)
   *   - 1 flight closed 5 days ago (only R1 had a dispatch)
   *
   *   30d, day granularity:
   *     totalReservationsCreated = 2 (incl. cancelled)
   *     totalFlightsClosed = 1
   *     5-days-ago bucket: reservationsCreated=2, flightsClosed=1
   *     all others: 0/0
   */

  let rvDb: PgliteTestClient;
  let rvOrgId: string;
  let rvUserId: string;
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    rvDb = db;
    rvOrgId = seed.orgAId;
    rvUserId = seed.userAId;

    const sess = makeSession(rvOrgId, rvUserId, 'owner');

    // Aircraft for the flight
    const ac1 = await createResourceWithDb(rvDb, sess, { kind: 'aircraft', displayName: 'N-RV1', tailNumber: 'RV1' });
    const ac2 = await createResourceWithDb(rvDb, sess, { kind: 'aircraft', displayName: 'N-RV2', tailNumber: 'RV2' });

    // R1: active reservation + closed flight
    const r1 = await createReservationWithDb(rvDb, sess, { startAt: TS.W1s, endAt: TS.W1e, resourceIds: [ac1.id] });
    if (!r1.ok) throw new Error('r1 failed');
    await backdateReservationCreated(rvDb, rvOrgId, r1.reservation.id, fiveDaysAgo);
    const o1 = await openDispatchWithDb(rvDb, sess, { reservationId: r1.reservation.id, resourceId: ac1.id, pilotUserId: rvUserId, hobbsOut: 100, tachOut: 100 });
    if (!o1.ok) throw new Error('o1 failed');
    const c1 = await closeDispatchWithDb(rvDb, sess, { ticketId: o1.ticket.id, hobbsIn: 101.0, tachIn: 101.0 });
    if (!c1.ok) throw new Error('c1 failed');
    await backdateDispatchClose(rvDb, rvOrgId, o1.ticket.id, fiveDaysAgo);

    // R2: cancelled reservation (COUNTS in reservationsCreated, NO flight)
    const r2 = await createReservationWithDb(rvDb, sess, { startAt: TS.W2s, endAt: TS.W2e, resourceIds: [ac2.id] });
    if (!r2.ok) throw new Error('r2 failed');
    await cancelReservationWithDb(rvDb, sess, { reservationId: r2.reservation.id });
    await backdateReservationCreated(rvDb, rvOrgId, r2.reservation.id, fiveDaysAgo);
  }, 120_000);

  it('totalReservationsCreated = 2 (incl. cancelled)', async () => {
    const sess = makeSession(rvOrgId, rvUserId, 'owner');
    const r = await getReservationsVsFlightsTrendWithDb(rvDb, sess, { range: '30d' });
    expect(r.totalReservationsCreated).toBe(2);
  });

  it('totalFlightsClosed = 1', async () => {
    const sess = makeSession(rvOrgId, rvUserId, 'owner');
    const r = await getReservationsVsFlightsTrendWithDb(rvDb, sess, { range: '30d' });
    expect(r.totalFlightsClosed).toBe(1);
  });

  it('30d → at least 30 and at most 31 buckets (zero-filled; day granularity)', async () => {
    const sess = makeSession(rvOrgId, rvUserId, 'owner');
    const r = await getReservationsVsFlightsTrendWithDb(rvDb, sess, { range: '30d' });
    expect(r.buckets.length).toBeGreaterThanOrEqual(30);
    expect(r.buckets.length).toBeLessThanOrEqual(31);
  });

  it('zero-fill: all-but-1 buckets have both series = 0', async () => {
    const sess = makeSession(rvOrgId, rvUserId, 'owner');
    const r = await getReservationsVsFlightsTrendWithDb(rvDb, sess, { range: '30d' });
    // 1 non-zero bucket (5d-ago with reservationsCreated=2, flightsClosed=1)
    const nonZero = r.buckets.filter((b) => b.reservationsCreated > 0 || b.flightsClosed > 0);
    expect(nonZero.length).toBe(1);
  });

  it('5-days-ago bucket: reservationsCreated=2, flightsClosed=1', async () => {
    const sess = makeSession(rvOrgId, rvUserId, 'owner');
    const r = await getReservationsVsFlightsTrendWithDb(rvDb, sess, { range: '30d' });
    const fiveBucketKey = new Date(Date.UTC(
      fiveDaysAgo.getUTCFullYear(), fiveDaysAgo.getUTCMonth(), fiveDaysAgo.getUTCDate(),
    )).toISOString();
    const bucket = r.buckets.find((b) => b.bucketStart.toISOString() === fiveBucketKey);
    expect(bucket?.reservationsCreated).toBe(2);
    expect(bucket?.flightsClosed).toBe(1);
  });

  it('granularity = "day" for 30d', async () => {
    const sess = makeSession(rvOrgId, rvUserId, 'owner');
    const r = await getReservationsVsFlightsTrendWithDb(rvDb, sess, { range: '30d' });
    expect(r.granularity).toBe('day');
  });
}, 120_000);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — getTrainingThroughput
// ══════════════════════════════════════════════════════════════════════════════

describe('getTrainingThroughput: hand-computed counts', () => {
  /**
   * HAND-COMPUTED:
   *   enrollmentsCreatedInRange:   2 (active E1 + completed E2 both enrolled 5d ago)
   *   enrollmentsCompletedInRange: 1 (E2 completed status_changed_at 5d ago)
   *   lessonsRecordedInRange:      2 (L1 recorded + L3 recorded; L2 voided excluded)
   *   activeEnrollmentCount:       1 (only E1 still active; E2 is completed)
   */

  let trDb: PgliteTestClient;
  let trOrgId: string;
  let trUserId: string;
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    trDb = db;
    trOrgId = seed.orgAId;
    trUserId = seed.userAId;

    const sess = makeSession(trOrgId, trUserId, 'owner');

    // Course with lessons (addCourseLesson auto-assigns position; no 'order' param).
    // Each call returns the updated CourseDetail with all lessons so far.
    const course = await createCourseWithDb(trDb, sess, { title: 'TR Course' });
    if (!course.ok) throw new Error('course failed');
    const l1Result = await addCourseLessonWithDb(trDb, sess, { courseId: course.course.courseId, title: 'Lesson 1' });
    if (!l1Result.ok) throw new Error('l1 failed');
    const l2Result = await addCourseLessonWithDb(trDb, sess, { courseId: course.course.courseId, title: 'Lesson 2' });
    if (!l2Result.ok) throw new Error('l2 failed');
    const l3Result = await addCourseLessonWithDb(trDb, sess, { courseId: course.course.courseId, title: 'Lesson 3' });
    if (!l3Result.ok) throw new Error('l3 failed');

    // Extract lesson IDs from the latest returned course detail (l3Result has all 3 lessons).
    const l1Id = l3Result.course.lessons[0]!.lessonId;
    const l2Id = l3Result.course.lessons[1]!.lessonId;
    const l3Id = l3Result.course.lessons[2]!.lessonId;

    // Enrollment 1: active, enrolled 5 days ago (on a separate course so no UNIQUE conflict)
    const course2 = await createCourseWithDb(trDb, sess, { title: 'TR Course 2' });
    if (!course2.ok) throw new Error('course2 failed');
    const e1 = await enrollMemberWithDb(trDb, sess, { courseId: course2.course.courseId, studentUserId: trUserId });
    if (!e1.ok) throw new Error('e1 failed');
    await backdateEnrollment(trDb, trOrgId, e1.enrollment.enrollmentId, fiveDaysAgo);

    // Enrollment 2: will be completed, but we record lessons FIRST (recordLesson requires
    // status='active'; we then complete the enrollment and backdate everything).
    const e2 = await enrollMemberWithDb(trDb, sess, { courseId: course.course.courseId, studentUserId: trUserId });
    if (!e2.ok) throw new Error('e2 failed');

    // Record lessons BEFORE completing enrollment 2 (recordLesson requires active status):
    //   L1: recorded (COUNTS)
    //   L2: recorded then voided (DOES NOT count in lessonsRecordedInRange)
    //   L3: recorded (COUNTS)
    const rec1 = await recordLessonWithDb(trDb, sess, {
      enrollmentId: e2.enrollment.enrollmentId,
      lessonId: l1Id,
      instructorUserId: trUserId,
    });
    if (!rec1.ok) throw new Error('rec1 failed');
    // enrollment.records is newest-first; [0] is the just-recorded L1 record.
    const rec1RecordId = rec1.enrollment.records[0]?.id;
    if (rec1RecordId) await backdateLessonRecord(trDb, trOrgId, rec1RecordId, fiveDaysAgo);

    const rec2 = await recordLessonWithDb(trDb, sess, {
      enrollmentId: e2.enrollment.enrollmentId,
      lessonId: l2Id,
      instructorUserId: trUserId,
    });
    if (!rec2.ok) throw new Error('rec2 failed');
    const rec2Record = rec2.enrollment.records.find((r) => r.lessonId === l2Id && r.status === 'recorded');
    if (rec2Record) {
      await backdateLessonRecord(trDb, trOrgId, rec2Record.id, fiveDaysAgo);
      // voidLessonRecord takes 'recordId' (not lessonRecordId).
      const v2 = await voidLessonRecordWithDb(trDb, sess, { recordId: rec2Record.id, voidedReason: 'test void' });
      if (!v2.ok) throw new Error('v2 failed');
    }

    const rec3 = await recordLessonWithDb(trDb, sess, {
      enrollmentId: e2.enrollment.enrollmentId,
      lessonId: l3Id,
      instructorUserId: trUserId,
    });
    if (!rec3.ok) throw new Error('rec3 failed');
    const rec3Record = rec3.enrollment.records.find((r) => r.lessonId === l3Id && r.status === 'recorded');
    if (rec3Record) await backdateLessonRecord(trDb, trOrgId, rec3Record.id, fiveDaysAgo);

    // Now complete enrollment 2 and backdate both enrolled_at and status_changed_at to 5d ago.
    const setComp = await setEnrollmentStatusWithDb(trDb, sess, { enrollmentId: e2.enrollment.enrollmentId, status: 'completed' });
    if (!setComp.ok) throw new Error('setComp failed');
    await backdateEnrollment(trDb, trOrgId, e2.enrollment.enrollmentId, fiveDaysAgo, fiveDaysAgo);
  }, 120_000);

  it('enrollmentsCreatedInRange = 2 (active E1 + completed E2)', async () => {
    const sess = makeSession(trOrgId, trUserId, 'owner');
    const r = await getTrainingThroughputWithDb(trDb, sess, { range: '30d' });
    expect(r.enrollmentsCreatedInRange).toBe(2);
  });

  it('enrollmentsCompletedInRange = 1 (E2 completed in range)', async () => {
    const sess = makeSession(trOrgId, trUserId, 'owner');
    const r = await getTrainingThroughputWithDb(trDb, sess, { range: '30d' });
    expect(r.enrollmentsCompletedInRange).toBe(1);
  });

  it('lessonsRecordedInRange = 2 (L1+L3 recorded; voided L2 excluded)', async () => {
    const sess = makeSession(trOrgId, trUserId, 'owner');
    const r = await getTrainingThroughputWithDb(trDb, sess, { range: '30d' });
    expect(r.lessonsRecordedInRange).toBe(2);
  });

  it('activeEnrollmentCount = 1 (snapshot; E2 is completed, not active)', async () => {
    const sess = makeSession(trOrgId, trUserId, 'owner');
    const r = await getTrainingThroughputWithDb(trDb, sess, { range: '30d' });
    expect(r.activeEnrollmentCount).toBe(1);
  });

  it('all counts are numbers, not NaN', async () => {
    const sess = makeSession(trOrgId, trUserId, 'owner');
    const r = await getTrainingThroughputWithDb(trDb, sess, { range: '30d' });
    expect(Number.isNaN(r.enrollmentsCreatedInRange)).toBe(false);
    expect(Number.isNaN(r.enrollmentsCompletedInRange)).toBe(false);
    expect(Number.isNaN(r.lessonsRecordedInRange)).toBe(false);
    expect(Number.isNaN(r.activeEnrollmentCount)).toBe(false);
  });
}, 120_000);

describe('getTrainingThroughput: empty org → all 0s no NaN', () => {
  it('empty org → all counts 0, no NaN', async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    const sess = makeSession(seed.orgAId, seed.userAId, 'owner');
    const r = await getTrainingThroughputWithDb(db, sess, { range: '30d' });
    expect(r.enrollmentsCreatedInRange).toBe(0);
    expect(r.enrollmentsCompletedInRange).toBe(0);
    expect(r.lessonsRecordedInRange).toBe(0);
    expect(r.activeEnrollmentCount).toBe(0);
    expect(Number.isNaN(r.enrollmentsCreatedInRange)).toBe(false);
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — getMaintenanceTrend
// ══════════════════════════════════════════════════════════════════════════════

describe('getMaintenanceTrend: hand-computed counts', () => {
  /**
   * HAND-COMPUTED (all backdated to 5 days ago to fall in 30d window):
   *   squawksOpenedInRange:    2 (SQ1 + SQ2 reported 5d ago)
   *   squawksResolvedInRange:  1 (SQ1 resolved 5d ago; SQ2 remains open)
   *   workOrdersOpenedInRange: 2 (WO1 opened 5d ago + WO2 opened 5d ago)
   *   workOrdersCompletedInRange: 1 (WO2 completed/signed-off 5d ago; WO1 open)
   *   openSquawkCount (snapshot): 1 (SQ2 still open)
   *   groundedAircraftCount:   1 (aircraft grounded)
   */

  let mDb: PgliteTestClient;
  let mOrgId: string;
  let mUserId: string;
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    mDb = db;
    mOrgId = seed.orgAId;
    mUserId = seed.userAId;

    const sess = makeSession(mOrgId, mUserId, 'owner');

    // Aircraft for squawks + work orders + grounding
    const ac = await createResourceWithDb(mDb, sess, { kind: 'aircraft', displayName: 'N-MAINT', tailNumber: 'MAINT1' });
    const acId = ac.id;

    // SQ1: reported + resolved 5d ago
    const sq1 = await reportSquawkWithDb(mDb, sess, { resourceId: acId, title: 'SQ1', severity: 'low' });
    if (!sq1.ok) throw new Error('sq1 failed');
    const sq1Id = sq1.squawk.id;
    await updateSquawkStatusWithDb(mDb, sess, { squawkId: sq1Id, status: 'resolved', resolutionNotes: 'fixed' });
    await backdateSquawk(mDb, mOrgId, sq1Id, fiveDaysAgo, fiveDaysAgo);

    // SQ2: reported 5d ago, still open (not resolved)
    const sq2 = await reportSquawkWithDb(mDb, sess, { resourceId: acId, title: 'SQ2', severity: 'high' });
    if (!sq2.ok) throw new Error('sq2 failed');
    await backdateSquawk(mDb, mOrgId, sq2.squawk.id, fiveDaysAgo);

    // WO1: opened 5d ago, still open (not completed)
    const wo1 = await openWorkOrderWithDb(mDb, sess, { resourceId: acId, title: 'WO1' });
    if (!wo1.ok) throw new Error('wo1 failed');
    await backdateWorkOrder(mDb, mOrgId, wo1.workOrder.id, fiveDaysAgo);

    // WO2: opened + completed 5d ago
    const ac2 = await createResourceWithDb(mDb, sess, { kind: 'aircraft', displayName: 'N-MAINT2', tailNumber: 'MAINT2' });
    const wo2 = await openWorkOrderWithDb(mDb, sess, { resourceId: ac2.id, title: 'WO2' });
    if (!wo2.ok) throw new Error('wo2 failed');
    const comp = await completeWorkOrderWithDb(mDb, sess, { workOrderId: wo2.workOrder.id, workPerformed: 'done' });
    if (!comp.ok) throw new Error('comp failed');
    await backdateWorkOrder(mDb, mOrgId, wo2.workOrder.id, fiveDaysAgo, fiveDaysAgo);

    // Ground the first aircraft (point-in-time snapshot)
    await groundAircraftWithDb(mDb, sess, { resourceId: acId, reason: 'Inspection' });
  }, 120_000);

  it('squawksOpenedInRange = 2 (SQ1 + SQ2 reported 5d ago)', async () => {
    const sess = makeSession(mOrgId, mUserId, 'owner');
    const r = await getMaintenanceTrendWithDb(mDb, sess, { range: '30d' });
    expect(r.squawksOpenedInRange).toBe(2);
  });

  it('squawksResolvedInRange = 1 (only SQ1 resolved in range)', async () => {
    const sess = makeSession(mOrgId, mUserId, 'owner');
    const r = await getMaintenanceTrendWithDb(mDb, sess, { range: '30d' });
    expect(r.squawksResolvedInRange).toBe(1);
  });

  it('workOrdersOpenedInRange = 2', async () => {
    const sess = makeSession(mOrgId, mUserId, 'owner');
    const r = await getMaintenanceTrendWithDb(mDb, sess, { range: '30d' });
    expect(r.workOrdersOpenedInRange).toBe(2);
  });

  it('workOrdersCompletedInRange = 1 (only WO2 completed in range)', async () => {
    const sess = makeSession(mOrgId, mUserId, 'owner');
    const r = await getMaintenanceTrendWithDb(mDb, sess, { range: '30d' });
    expect(r.workOrdersCompletedInRange).toBe(1);
  });

  it('openSquawkCount (snapshot) = 1 (SQ2 still open)', async () => {
    const sess = makeSession(mOrgId, mUserId, 'owner');
    const r = await getMaintenanceTrendWithDb(mDb, sess, { range: '30d' });
    expect(r.openSquawkCount).toBe(1);
  });

  it('groundedAircraftCount (snapshot via loadGroundingProbe) = 1', async () => {
    const sess = makeSession(mOrgId, mUserId, 'owner');
    const r = await getMaintenanceTrendWithDb(mDb, sess, { range: '30d' });
    expect(r.groundedAircraftCount).toBe(1);
  });

  it('all counts are numbers, not NaN', async () => {
    const sess = makeSession(mOrgId, mUserId, 'owner');
    const r = await getMaintenanceTrendWithDb(mDb, sess, { range: '30d' });
    const fields = [r.squawksOpenedInRange, r.squawksResolvedInRange, r.workOrdersOpenedInRange, r.workOrdersCompletedInRange, r.openSquawkCount, r.groundedAircraftCount];
    for (const f of fields) {
      expect(Number.isNaN(f)).toBe(false);
      expect(typeof f).toBe('number');
    }
  });
}, 120_000);

describe('getMaintenanceTrend: empty org → all 0s no NaN', () => {
  it('empty org → all counts 0, no NaN', async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    const sess = makeSession(seed.orgAId, seed.userAId, 'owner');
    const r = await getMaintenanceTrendWithDb(db, sess, { range: '30d' });
    expect(r.squawksOpenedInRange).toBe(0);
    expect(r.squawksResolvedInRange).toBe(0);
    expect(r.workOrdersOpenedInRange).toBe(0);
    expect(r.workOrdersCompletedInRange).toBe(0);
    expect(r.openSquawkCount).toBe(0);
    expect(r.groundedAircraftCount).toBe(0);
    for (const f of Object.values(r)) {
      if (typeof f === 'number') expect(Number.isNaN(f)).toBe(false);
    }
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Range keys: all 5 accepted by all fns + default '30d'
// ══════════════════════════════════════════════════════════════════════════════

describe('Range keys: all 5 keys accepted by all fns; default = 30d', () => {
  const ALL_RANGES = ['7d', '30d', '90d', '180d', '365d'] as const;

  for (const range of ALL_RANGES) {
    it(`getUtilizationTrend accepts ${range}`, async () => {
      const { db, orgAId, userAId } = sharedEnv;
      const sess = makeSession(orgAId, userAId, 'owner');
      const r = await getUtilizationTrendWithDb(db, sess, { range });
      expect(r.range.key).toBe(range);
    });

    it(`getHoursByTail accepts ${range}`, async () => {
      const { db, orgAId, userAId } = sharedEnv;
      const sess = makeSession(orgAId, userAId, 'owner');
      const rows = await getHoursByTailWithDb(db, sess, { range });
      expect(Array.isArray(rows)).toBe(true);
    });

    it(`getReservationsVsFlightsTrend accepts ${range}`, async () => {
      const { db, orgAId, userAId } = sharedEnv;
      const sess = makeSession(orgAId, userAId, 'owner');
      const r = await getReservationsVsFlightsTrendWithDb(db, sess, { range });
      expect(r.range.key).toBe(range);
    });

    it(`getTrainingThroughput accepts ${range}`, async () => {
      const { db, orgAId, userAId } = sharedEnv;
      const sess = makeSession(orgAId, userAId, 'owner');
      const r = await getTrainingThroughputWithDb(db, sess, { range });
      expect(r.range.key).toBe(range);
    });

    it(`getMaintenanceTrend accepts ${range}`, async () => {
      const { db, orgAId, userAId } = sharedEnv;
      const sess = makeSession(orgAId, userAId, 'owner');
      const r = await getMaintenanceTrendWithDb(db, sess, { range });
      expect(r.range.key).toBe(range);
    });
  }

  it('getUtilizationTrend: omitted range → key="30d"', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const r = await getUtilizationTrendWithDb(db, sess, {});
    expect(r.range.key).toBe('30d');
  });

  it('getTrainingThroughput: omitted range → key="30d"', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const r = await getTrainingThroughputWithDb(db, sess, {});
    expect(r.range.key).toBe('30d');
  });
});
