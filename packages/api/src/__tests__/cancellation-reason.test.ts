/**
 * cancellation-reason.test.ts — reservation cancellation reasons + the
 * cancellations report (migration 0042).
 *
 * Applies migrations 0000–0042 (0042 adds reservation.cancellation_reason).
 *
 * COVERAGE:
 *   PURE: leadTimeBucketFor boundary classification (<24h / 1-7d / >7d).
 *   PERSIST: cancelReservation with a reason writes cancellation_reason + puts
 *     the reason in the cancel audit metadata.
 *   ABSENT = BYTE-IDENTICAL: cancelReservation with no reason leaves
 *     cancellation_reason NULL and the audit metadata {} (unchanged from before).
 *   VALIDATION: an over-length reason (>500) ⇒ ValidationError.
 *   CANCEL-SERIES: a reason threads through to EVERY future occurrence's
 *     cancellation_reason + per-occurrence audit metadata + the series audit.
 *   REPORT: getCancellationsReport totals + per-row fields + the three lead-time
 *     buckets are computed correctly.
 *   CAPS: getCancellationsReport needs reporting:access (renter ⇒ Forbidden,
 *     null ⇒ Unauthenticated).
 *   T-ISO: a report is org-scoped — org A cancellations never appear in org B's
 *     report and vice-versa.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq, and } from 'drizzle-orm';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  loadMigrationSql,
  reservation,
  auditLog,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { createSeriesWithDb } from '../scheduling/create-series.js';
import { cancelReservationWithDb } from '../scheduling/cancel-reservation.js';
import { cancelSeriesWithDb } from '../scheduling/cancel-series.js';
import {
  getCancellationsReportWithDb,
  leadTimeBucketFor,
} from '../reporting/get-cancellations-report.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

const MIGRATION_SQL = loadMigrationSql('0042');

const MS_H = 60 * 60 * 1000;
const MS_D = 24 * MS_H;

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

/** Create a fresh aircraft + a future reservation on it. Returns reservationId. */
async function seedReservation(
  db: PgliteTestClient,
  sess: AppSession,
  label: string,
  startInMs: number,
): Promise<string> {
  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `AC ${label}`,
    tailNumber: `N-${label}`,
  });
  const startAt = new Date(Date.now() + startInMs);
  const endAt = new Date(startAt.getTime() + MS_H);
  const r = await createReservationWithDb(db, sess, {
    startAt,
    endAt,
    resourceIds: [aircraft.id],
  });
  if (!r.ok) throw new Error(`seedReservation ${label}: create refused (${JSON.stringify(r)})`);
  return r.reservation.id;
}

let env: TestEnv;

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
}, 60_000);

// ════════════════════════════════════════════════════════════════════════════
// PURE — lead-time bucket boundaries
// ════════════════════════════════════════════════════════════════════════════

describe('leadTimeBucketFor (pure)', () => {
  it('classifies notice on the correct side of each boundary', () => {
    expect(leadTimeBucketFor(-5 * MS_H)).toBe('lt24h'); // cancelled after start
    expect(leadTimeBucketFor(0)).toBe('lt24h');
    expect(leadTimeBucketFor(23 * MS_H)).toBe('lt24h');
    expect(leadTimeBucketFor(24 * MS_H)).toBe('d1_7'); // exactly 24h → 1-7d
    expect(leadTimeBucketFor(3 * MS_D)).toBe('d1_7');
    expect(leadTimeBucketFor(7 * MS_D)).toBe('d1_7'); // exactly 7d → 1-7d
    expect(leadTimeBucketFor(7 * MS_D + 1)).toBe('gt7d');
    expect(leadTimeBucketFor(20 * MS_D)).toBe('gt7d');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PERSIST + audit
// ════════════════════════════════════════════════════════════════════════════

describe('cancelReservation reason capture', () => {
  it('persists the reason + records it in the cancel audit metadata', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');
    const resvId = await seedReservation(db, sess, 'PERSIST', 2 * MS_D);

    const result = await cancelReservationWithDb(db, sess, {
      reservationId: resvId,
      reason: '  Weather — low ceilings  ',
    });
    expect(result.ok).toBe(true);

    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx
        .select({ reason: reservation.cancellationReason, status: reservation.status })
        .from(reservation)
        .where(eq(reservation.id, resvId)),
    );
    expect(rows[0]?.status).toBe('cancelled');
    expect(rows[0]?.reason).toBe('Weather — low ceilings'); // trimmed

    const audits = await withOrgContext(db, orgAId, (tx) =>
      tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'reservation.cancelled'), eq(auditLog.entityId, resvId))),
    );
    expect(audits).toHaveLength(1);
    expect((audits[0]?.metadata as Record<string, unknown>).reason).toBe('Weather — low ceilings');
  });

  it('with NO reason: column stays NULL and audit metadata stays {} (byte-identical)', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');
    const resvId = await seedReservation(db, sess, 'NOREASON', 2 * MS_D);

    const result = await cancelReservationWithDb(db, sess, { reservationId: resvId });
    expect(result.ok).toBe(true);

    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx
        .select({ reason: reservation.cancellationReason })
        .from(reservation)
        .where(eq(reservation.id, resvId)),
    );
    expect(rows[0]?.reason).toBeNull();

    const audits = await withOrgContext(db, orgAId, (tx) =>
      tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'reservation.cancelled'), eq(auditLog.entityId, resvId))),
    );
    expect(audits[0]?.metadata).toEqual({});
  });

  it('rejects an over-length reason (>500) with ValidationError', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');
    const resvId = await seedReservation(db, sess, 'TOOLONG', 2 * MS_D);
    await expect(
      cancelReservationWithDb(db, sess, { reservationId: resvId, reason: 'x'.repeat(501) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CANCEL-SERIES threads the reason
// ════════════════════════════════════════════════════════════════════════════

describe('cancelSeries reason threading', () => {
  it('applies the reason to every future occurrence + its audit rows', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'AC SERIES',
      tailNumber: 'N-SER1',
    });

    // Series far in the future so all occurrences are "future" (cancellable).
    const baseNow = Date.now();
    const created = await createSeriesWithDb(
      db,
      sess,
      {
        weekdays: [1],
        intervalWeeks: 1,
        end: { kind: 'count', count: 3 },
        localStartTime: '10:00',
        durationMinutes: 60,
        tz: 'UTC',
        resourceIds: [aircraft.id],
      },
      { now: baseNow },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const seriesId = created.series.id;

    const cancelled = await cancelSeriesWithDb(
      db,
      sess,
      { seriesId, reason: 'Instructor on leave' },
      { now: baseNow },
    );
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.cancelledCount).toBeGreaterThan(0);

    // Every cancelled occurrence carries the reason.
    const occ = await withOrgContext(db, orgAId, (tx) =>
      tx
        .select({ reason: reservation.cancellationReason, status: reservation.status })
        .from(reservation)
        .where(eq(reservation.seriesId, seriesId)),
    );
    const cancelledOcc = occ.filter((o) => o.status === 'cancelled');
    expect(cancelledOcc.length).toBe(cancelled.cancelledCount);
    for (const o of cancelledOcc) expect(o.reason).toBe('Instructor on leave');

    // Per-occurrence + series audit rows carry the reason.
    const seriesAudit = await withOrgContext(db, orgAId, (tx) =>
      tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'series.cancelled'), eq(auditLog.entityId, seriesId))),
    );
    expect((seriesAudit[0]?.metadata as Record<string, unknown>).reason).toBe('Instructor on leave');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REPORT — math + buckets + caps + T-ISO (isolated client for exact counts)
// ════════════════════════════════════════════════════════════════════════════

describe('getCancellationsReport', () => {
  let renv: TestEnv;
  let orgAResvIds: string[];
  let orgBResvId: string;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    renv = {
      db,
      pglite,
      orgAId: seed.orgAId,
      orgBId: seed.orgBId,
      userAId: seed.userAId,
      userBId: seed.userBId,
    };

    const sessA = makeSession(renv.orgAId, renv.userAId, 'owner');

    // Three cancellations, one per lead-time bucket.
    const idLt24 = await seedReservation(db, sessA, 'LT24', 12 * MS_H); // <24h
    const idD17 = await seedReservation(db, sessA, 'D17', 3 * MS_D); // 1-7d
    const idGt7 = await seedReservation(db, sessA, 'GT7', 10 * MS_D); // >7d
    orgAResvIds = [idLt24, idD17, idGt7];

    await cancelReservationWithDb(db, sessA, { reservationId: idLt24, reason: 'Sick' });
    await cancelReservationWithDb(db, sessA, { reservationId: idD17 }); // no reason
    await cancelReservationWithDb(db, sessA, { reservationId: idGt7, reason: 'Trip cancelled' });

    // One cancellation in org B (for isolation).
    const sessB = makeSession(renv.orgBId, renv.userBId, 'owner');
    orgBResvId = await seedReservation(db, sessB, 'BONLY', 2 * MS_D);
    await cancelReservationWithDb(db, sessB, { reservationId: orgBResvId, reason: 'Org B reason' });
  }, 60_000);

  it('totals + lead-time buckets are correct', async () => {
    const sessA = makeSession(renv.orgAId, renv.userAId, 'owner');
    const report = await getCancellationsReportWithDb(renv.db, sessA, { range: '30d' });

    expect(report.totalCount).toBe(3);
    expect(report.lt24hCount).toBe(1);
    expect(report.d1_7Count).toBe(1);
    expect(report.gt7dCount).toBe(1);
    expect(report.rows).toHaveLength(3);
  });

  it('per-row fields: tail, who-cancelled, reason (null when absent)', async () => {
    const sessA = makeSession(renv.orgAId, renv.userAId, 'owner');
    const report = await getCancellationsReportWithDb(renv.db, sessA, { range: '30d' });

    const byBucket = Object.fromEntries(report.rows.map((r) => [r.leadTimeBucket, r]));
    expect(byBucket.lt24h?.reason).toBe('Sick');
    expect(byBucket.lt24h?.resourceLabel).toBe('N-LT24');
    expect(byBucket.d1_7?.reason).toBeNull(); // no reason given
    expect(byBucket.gt7d?.reason).toBe('Trip cancelled');
    // cancelledByName resolves to the actor (seedTwoOrgs user has a name/email).
    expect(byBucket.lt24h?.cancelledByName).toBeTruthy();
    expect(byBucket.lt24h?.cancelledByName).not.toBe('—');
  });

  it('capability: reporting:access required', async () => {
    const { db, orgAId, userAId } = renv;
    await expect(
      getCancellationsReportWithDb(db, makeSession(orgAId, userAId, 'renter'), { range: '30d' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      getCancellationsReportWithDb(db, null, { range: '30d' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('tenant isolation: a report only contains its own org cancellations', async () => {
    const sessA = makeSession(renv.orgAId, renv.userAId, 'owner');
    const sessB = makeSession(renv.orgBId, renv.userBId, 'owner');

    const reportA = await getCancellationsReportWithDb(renv.db, sessA, { range: '30d' });
    const reportB = await getCancellationsReportWithDb(renv.db, sessB, { range: '30d' });

    const idsA = reportA.rows.map((r) => r.reservationId);
    const idsB = reportB.rows.map((r) => r.reservationId);

    expect(idsA).toEqual(expect.arrayContaining(orgAResvIds));
    expect(idsA).not.toContain(orgBResvId);

    expect(reportB.totalCount).toBe(1);
    expect(idsB).toEqual([orgBResvId]);
    for (const id of orgAResvIds) expect(idsB).not.toContain(id);
  });
});
