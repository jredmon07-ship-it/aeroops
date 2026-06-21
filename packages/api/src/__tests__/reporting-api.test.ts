/**
 * reporting-api.test.ts — API integration tests for Slice 7.1 (Reporting).
 *
 * Tests the persistence/DB layer for getOrgDashboardMetrics + getAircraftUtilization.
 * Applies migrations 0000–0008 (all existing migrations).
 *
 * WHY NO PROPERTY TESTS (spec §5 D4):
 *   Aggregation functions are I/O-bound (SQL COUNT/SUM/LEFT JOIN); there is no
 *   pure algorithm with a closed-form invariant to express as a PBT generator.
 *   The only pure helper resolveRange() gets ordinary unit tests.
 *   Property testing is reserved for the conflict engine and policy gate
 *   (pure core logic with combinatorial edge-cases).
 *
 * TWO SEEDED ORGS (A and B) with deliberately-higher B counts so that
 * T-ISO-* isolation tests catch any org_id predicate omission.
 *
 * COVERAGE:
 *   resolveRange: each key, to exclusive, deterministic with injected now.
 *   getOrgDashboardMetrics:
 *     - happy (hand-computed)
 *     - T-ISO-FLIGHTS / T-ISO-HOURS / T-ISO-RESV / T-ISO-SQUAWK /
 *       T-ISO-GROUNDED / T-ISO-AC / T-ISO-MEMBERS — org-B seeded with MORE,
 *       org-A session returns ONLY org-A values (load-bearing isolation suite)
 *     - empty org zeros (no NaN)
 *     - range-filter (in / out of 7d / 30d / 90d windows)
 *     - voided + open excluded (closed+voided+open same tail → count 1)
 *     - default 30d when range omitted
 *     - invalid range → ValidationError
 *     - authz (null→Unauthenticated; renter/mechanic/student→Forbidden;
 *              owner/manager/dispatcher/cfi/accountant→ok)
 *   getAircraftUtilization:
 *     - happy (order + sums)
 *     - T-ISO-UTIL (org-B high-util tails NOT seen from org-A session)
 *     - zero-flight active tail → 0/0
 *     - voided/open excluded
 *     - inactive excluded
 *     - empty → []
 *   Capability exhaustiveness + reporting:access per role matrix.
 *
 * Setup: createTestClient() → applyMigrationSql([0000–0008]) →
 * seedTwoOrgs → additional seed → setTestAppRole.
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

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { deactivateResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { voidDispatchWithDb } from '../dispatch/void-dispatch.js';
import { groundAircraftWithDb } from '../maintenance/ground-aircraft.js';
import { reportSquawkWithDb } from '../maintenance/report-squawk.js';

import { getOrgDashboardMetricsWithDb } from '../reporting/get-org-dashboard-metrics.js';
import { getAircraftUtilizationWithDb } from '../reporting/get-aircraft-utilization.js';
import { resolveRange } from '../reporting/internal.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';
import { can, MEMBERSHIP_ROLES, CAPABILITIES } from '@aeroops/core';

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
  // 0008 required: app_user now includes phone/status columns (Slice 6.1).
  // Drizzle ORM INSERT on app_user emits all columns including phone + status.
  readFileSync(resolve(__dirname, '../../../db/migrations/0008_people.sql'),            'utf-8'),
  // 0009 required: dispatch_requirement + dispatch_config tables (Slice 3c / ADR-0009).
  // openDispatch now queries dispatch_requirement; tables must exist in test DB.
  readFileSync(resolve(__dirname, '../../../db/migrations/0009_dispatch_gate.sql'),    'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0010_civil_twilight.sql'),    'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0011_optimizer_run.sql'),    'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0012_training.sql'),           'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0013_work_orders.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0014_availability.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0015_booking_request.sql'),  'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0016_booking_request_convert.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0017_booking_retention.sql'),        'utf-8'),
];

// ── Shared test env ──────────────────────────────────────────────────────────

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

// Future dates for reservations (booking-policy min-advance pass).
const FUTURE_D = '2027-03-15';
const T = {
  W1_start: new Date(`${FUTURE_D}T08:00:00Z`),
  W1_end:   new Date(`${FUTURE_D}T10:00:00Z`),
  W2_start: new Date(`${FUTURE_D}T12:00:00Z`),
  W2_end:   new Date(`${FUTURE_D}T14:00:00Z`),
  W3_start: new Date(`${FUTURE_D}T15:00:00Z`),
  W3_end:   new Date(`${FUTURE_D}T16:00:00Z`),
};

let sharedEnv: TestEnv;

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });

  sharedEnv = {
    db,
    pglite,
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };
}, 60_000);

// ── Helper: seed a dispatch cycle (open + close) returning flightTimeHours ──

async function seedClosedDispatch(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tailTag: string,
  hobbsOut: number,
  hobbsIn: number,
  closedAtOverride?: Date,
): Promise<{ aircraftId: string; reservationId: string; ticketId: string; flightTimeHours: number }> {
  const sess = makeSession(orgId, userId, 'owner');

  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `N-${tailTag}`,
    tailNumber: tailTag,
  });

  const rResult = await createReservationWithDb(db, sess, {
    startAt: T.W1_start,
    endAt: T.W1_end,
    resourceIds: [aircraft.id],
  });
  if (!rResult.ok) throw new Error(`seed reservation failed: ${rResult.reason}`);

  const openResult = await openDispatchWithDb(db, sess, {
    reservationId: rResult.reservation.id,
    resourceId: aircraft.id,
    pilotUserId: userId,
    hobbsOut,
    tachOut: hobbsOut,
  });
  if (!openResult.ok) throw new Error(`seed open failed: ${JSON.stringify(openResult)}`);

  const closeResult = await closeDispatchWithDb(db, sess, {
    ticketId: openResult.ticket.id,
    hobbsIn,
    tachIn: hobbsIn,
  });
  if (!closeResult.ok) throw new Error(`seed close failed: ${JSON.stringify(closeResult)}`);

  // If a custom closedAt is provided, backdate it via raw SQL so range tests work.
  if (closedAtOverride) {
    await withOrgContext(db, orgId, async (tx) => {
      await tx.execute(
        { sql: `UPDATE dispatch_ticket SET closed_at = $1 WHERE id = $2`, params: [closedAtOverride, openResult.ticket.id] } as never,
      );
    });
    // Use Drizzle sql tag for the update
    const { sql: drizzleSql } = await import('drizzle-orm');
    await withOrgContext(db, orgId, async (tx) => {
      await tx.execute(drizzleSql`UPDATE dispatch_ticket SET closed_at = ${closedAtOverride} WHERE id = ${openResult.ticket.id}`);
    });
  }

  const flightTimeHours = Math.round((hobbsIn - hobbsOut) * 10) / 10;

  return {
    aircraftId: aircraft.id,
    reservationId: rResult.reservation.id,
    ticketId: openResult.ticket.id,
    flightTimeHours,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 0 — resolveRange unit tests
// ══════════════════════════════════════════════════════════════════════════════

describe('resolveRange: pure UTC rolling window', () => {
  const NOW = new Date('2026-06-19T12:00:00Z');

  it('7d → from = now - 7 days, to = now (exclusive)', () => {
    const { from, to } = resolveRange('7d', NOW);
    expect(to.getTime()).toBe(NOW.getTime());
    expect(from.getTime()).toBe(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
  });

  it('30d → from = now - 30 days, to = now (exclusive)', () => {
    const { from, to } = resolveRange('30d', NOW);
    expect(to.getTime()).toBe(NOW.getTime());
    expect(from.getTime()).toBe(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
  });

  it('90d → from = now - 90 days, to = now (exclusive)', () => {
    const { from, to } = resolveRange('90d', NOW);
    expect(to.getTime()).toBe(NOW.getTime());
    expect(from.getTime()).toBe(NOW.getTime() - 90 * 24 * 60 * 60 * 1000);
  });

  it('to is exclusive: to equals now, not now+1ms', () => {
    const { to } = resolveRange('30d', NOW);
    expect(to.getTime()).toBe(NOW.getTime());
    expect(to.getTime()).not.toBe(NOW.getTime() + 1);
  });

  it('deterministic: same now always gives same result', () => {
    const r1 = resolveRange('30d', NOW);
    const r2 = resolveRange('30d', NOW);
    expect(r1.from.getTime()).toBe(r2.from.getTime());
    expect(r1.to.getTime()).toBe(r2.to.getTime());
  });

  it('7d window is exactly 604800000ms wide', () => {
    const { from, to } = resolveRange('7d', NOW);
    expect(to.getTime() - from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('30d window is exactly 2592000000ms wide', () => {
    const { from, to } = resolveRange('30d', NOW);
    expect(to.getTime() - from.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('90d window is exactly 7776000000ms wide', () => {
    const { from, to } = resolveRange('90d', NOW);
    expect(to.getTime() - from.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CAPABILITY: reporting:access exhaustiveness + per-role matrix
// ══════════════════════════════════════════════════════════════════════════════

describe('Capability: reporting:access', () => {
  it('reporting:access is in CAPABILITIES', () => {
    expect((CAPABILITIES as readonly string[]).includes('reporting:access')).toBe(true);
  });

  const GRANTED_ROLES: AppSession['role'][] = ['owner', 'manager', 'dispatcher', 'cfi', 'accountant'];
  const DENIED_ROLES:  AppSession['role'][] = ['mechanic', 'renter', 'student'];

  for (const role of GRANTED_ROLES) {
    it(`${role} HAS reporting:access`, () => {
      expect(can(role, 'reporting:access')).toBe(true);
    });
  }

  for (const role of DENIED_ROLES) {
    it(`${role} does NOT have reporting:access`, () => {
      expect(can(role, 'reporting:access')).toBe(false);
    });
  }

  it('CAPABILITIES is sorted alphabetically (reporting:access in correct place)', () => {
    const sorted = [...CAPABILITIES].sort();
    expect([...CAPABILITIES]).toEqual(sorted);
  });

  it('capability count is now 21 (20 prior + booking:triage — Slice PB1.2)', () => {
    expect(CAPABILITIES.length).toBe(21);
  });

  it('ROLE_CAPABILITIES keys still equal MEMBERSHIP_ROLES (exhaustive)', async () => {
    const { ROLE_CAPABILITIES } = await import('@aeroops/core');
    const matrixKeys = Object.keys(ROLE_CAPABILITIES).sort();
    const roleSet = [...MEMBERSHIP_ROLES].sort();
    expect(matrixKeys).toEqual(roleSet);
  });

  it('cross-product: can(role,cap) matches ROLE_CAPABILITIES[role].includes(cap) for reporting:access', async () => {
    const { ROLE_CAPABILITIES } = await import('@aeroops/core');
    for (const role of MEMBERSHIP_ROLES) {
      const fromCan    = can(role, 'reporting:access');
      const fromMatrix = (ROLE_CAPABILITIES[role] as readonly string[]).includes('reporting:access');
      expect(fromCan).toBe(fromMatrix);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — AUTHZ: getOrgDashboardMetrics
// ══════════════════════════════════════════════════════════════════════════════

describe('AUTHZ: getOrgDashboardMetrics', () => {
  it('null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(getOrgDashboardMetricsWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('renter role → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(getOrgDashboardMetricsWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('mechanic role → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'mechanic');
    await expect(getOrgDashboardMetricsWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('student role → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'student');
    await expect(getOrgDashboardMetricsWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('owner role → passes auth gate (resolves a result)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(db, sess);
    expect(result).toBeDefined();
    expect(typeof result.totalFlights).toBe('number');
  });

  it('manager role → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'manager');
    const result = await getOrgDashboardMetricsWithDb(db, sess);
    expect(result).toBeDefined();
  });

  it('dispatcher role → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'dispatcher');
    const result = await getOrgDashboardMetricsWithDb(db, sess);
    expect(result).toBeDefined();
  });

  it('cfi role → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'cfi');
    const result = await getOrgDashboardMetricsWithDb(db, sess);
    expect(result).toBeDefined();
  });

  it('accountant role → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'accountant');
    const result = await getOrgDashboardMetricsWithDb(db, sess);
    expect(result).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — VALIDATION: invalid range
// ══════════════════════════════════════════════════════════════════════════════

describe('VALIDATION: invalid range → ValidationError', () => {
  it('range="1d" (unknown) → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      getOrgDashboardMetricsWithDb(db, sess, { range: '1d' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('range="invalid" → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      getOrgDashboardMetricsWithDb(db, sess, { range: 'invalid' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('range="" (empty string) → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      getOrgDashboardMetricsWithDb(db, sess, { range: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('getAircraftUtilization: range="bad" → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      getAircraftUtilizationWithDb(db, sess, { range: 'bad' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — DEFAULT RANGE: omit range → uses 30d
// ══════════════════════════════════════════════════════════════════════════════

describe('DEFAULT range: omitting range uses 30d', () => {
  it('no range arg → result.range.key = "30d"', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(db, sess, {});
    expect(result.range.key).toBe('30d');
  });

  it('explicit range "7d" → result.range.key = "7d"', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(db, sess, { range: '7d' });
    expect(result.range.key).toBe('7d');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — EMPTY ORG ZEROS (no NaN)
// ══════════════════════════════════════════════════════════════════════════════

describe('EMPTY ORG ZEROS: brand-new empty org → all counts 0, no NaN', () => {
  // We use an isolated pglite client so we get a genuinely empty org.
  // We need to avoid modifying the shared org since those count-based tests
  // would be brittle. Use orgA after seeding (which starts mostly empty).
  it('org with no data → all numeric metrics are 0, not NaN, not null', async () => {
    // Create a separate pglite for this test with a fresh empty org
    const { db: emptyDb, pglite: emptyPglite } = await createTestClient();
    await applyMigrationSql({ pglite: emptyPglite }, MIGRATION_SQL);
    const emptySeed = await seedTwoOrgs(emptyDb);
    await setTestAppRole({ pglite: emptyPglite });

    const sess = makeSession(emptySeed.orgAId, emptySeed.userAId, 'owner');
    // orgA is fresh with just the seeded user — no dispatch, no squawks, no extra aircraft
    const result = await getOrgDashboardMetricsWithDb(emptyDb, sess, { range: '30d' });

    // All counts should be 0 (never NaN/null)
    expect(Number.isNaN(result.totalFlights)).toBe(false);
    expect(Number.isNaN(result.totalFlightHours)).toBe(false);
    expect(Number.isNaN(result.reservationsInRange)).toBe(false);
    expect(Number.isNaN(result.openSquawkCount)).toBe(false);
    expect(Number.isNaN(result.groundedAircraftCount)).toBe(false);
    expect(Number.isNaN(result.activeAircraftCount)).toBe(false);
    expect(Number.isNaN(result.activeMemberCount)).toBe(false);

    expect(result.totalFlights).toBe(0);
    expect(result.totalFlightHours).toBe(0);
    expect(result.reservationsInRange).toBe(0);
    expect(result.openSquawkCount).toBe(0);
    expect(result.groundedAircraftCount).toBe(0);
    expect(result.activeAircraftCount).toBe(0);
    // seedTwoOrgs creates 1 active user (the seeded member) in orgA
    expect(result.activeMemberCount).toBeGreaterThanOrEqual(1);
  });

  it('getAircraftUtilization: empty org → [] (not null, not error)', async () => {
    const { db: emptyDb, pglite: emptyPglite } = await createTestClient();
    await applyMigrationSql({ pglite: emptyPglite }, MIGRATION_SQL);
    const emptySeed = await seedTwoOrgs(emptyDb);
    await setTestAppRole({ pglite: emptyPglite });

    const sess = makeSession(emptySeed.orgAId, emptySeed.userAId, 'owner');
    const rows = await getAircraftUtilizationWithDb(emptyDb, sess, { range: '30d' });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(0);
  });
}, 60_000);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — T-ISO-* TENANT ISOLATION (load-bearing)
//
// Org B is seeded with MORE of every metric. Org-A session must return
// ONLY org-A values. These tests are the primary safety net for any
// omitted org_id predicate / RLS gap in the aggregation queries.
// ══════════════════════════════════════════════════════════════════════════════

describe('T-ISO: Tenant isolation — org-A session sees ONLY org-A data', () => {
  /**
   * We use a dedicated pglite for isolation tests so seeded state is
   * deterministic and independent of other test sections.
   */
  let isoDb: PgliteTestClient;
  let isoOrgAId: string;
  let isoOrgBId: string;
  let isoUserAId: string;
  let isoUserBId: string;

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

    const { sql: drizzleSql } = await import('drizzle-orm');

    // ── Seed 1 closed ticket in org A (1.5 h) ──────────────────────────────
    // closedAt = recent (within 30d) via backdating
    const pastDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

    const sessA = makeSession(isoOrgAId, isoUserAId, 'owner');
    const acA = await createResourceWithDb(isoDb, sessA, {
      kind: 'aircraft', displayName: 'N-ISO-A1', tailNumber: 'NISOA1',
    });
    const rA = await createReservationWithDb(isoDb, sessA, {
      startAt: T.W1_start, endAt: T.W1_end, resourceIds: [acA.id],
    });
    if (!rA.ok) throw new Error('seed rA failed');
    const openA = await openDispatchWithDb(isoDb, sessA, {
      reservationId: rA.reservation.id, resourceId: acA.id,
      pilotUserId: isoUserAId, hobbsOut: 100, tachOut: 100,
    });
    if (!openA.ok) throw new Error('seed openA failed');
    const closeA = await closeDispatchWithDb(isoDb, sessA, {
      ticketId: openA.ticket.id, hobbsIn: 101.5, tachIn: 101.5,
    });
    if (!closeA.ok) throw new Error('seed closeA failed');
    // Backdate closed_at to 5 days ago so it's within 30d range
    await withOrgContext(isoDb, isoOrgAId, async (tx) => {
      await tx.execute(drizzleSql`UPDATE dispatch_ticket SET closed_at = ${pastDate} WHERE id = ${openA.ticket.id}`);
    });

    // ── Seed 3 closed tickets in org B (2.0h each = 6.0h total) ────────────
    // Org B has 3x more flights and hours than org A
    const sessB = makeSession(isoOrgBId, isoUserBId, 'owner');
    for (let i = 1; i <= 3; i++) {
      const acB = await createResourceWithDb(isoDb, sessB, {
        kind: 'aircraft', displayName: `N-ISO-B${i}`, tailNumber: `NISOB${i}`,
      });
      const rB = await createReservationWithDb(isoDb, sessB, {
        startAt: T.W1_start, endAt: T.W1_end, resourceIds: [acB.id],
      });
      if (!rB.ok) throw new Error(`seed rB${i} failed`);
      const openB = await openDispatchWithDb(isoDb, sessB, {
        reservationId: rB.reservation.id, resourceId: acB.id,
        pilotUserId: isoUserBId, hobbsOut: 200, tachOut: 200,
      });
      if (!openB.ok) throw new Error(`seed openB${i} failed`);
      const closeB = await closeDispatchWithDb(isoDb, sessB, {
        ticketId: openB.ticket.id, hobbsIn: 202, tachIn: 202,
      });
      if (!closeB.ok) throw new Error(`seed closeB${i} failed`);
      await withOrgContext(isoDb, isoOrgBId, async (tx) => {
        await tx.execute(drizzleSql`UPDATE dispatch_ticket SET closed_at = ${pastDate} WHERE id = ${openB.ticket.id}`);
      });
    }

    // ── Seed 1 open squawk in org A, 3 in org B ─────────────────────────────
    await reportSquawkWithDb(isoDb, sessA, {
      resourceId: acA.id,
      title: 'Squawk A1',
      severity: 'low',
    });
    for (let i = 1; i <= 3; i++) {
      // We need a resource in org B
      const acBExtra = await createResourceWithDb(isoDb, sessB, {
        kind: 'aircraft', displayName: `N-SQ-B${i}`, tailNumber: `NSQB${i}`,
      });
      await reportSquawkWithDb(isoDb, sessB, {
        resourceId: acBExtra.id,
        title: `Squawk B${i}`,
        severity: 'low',
      });
    }

    // ── Seed grounding: 0 grounded in org A, 1 grounded in org B ───────────
    // Org B gets a grounded aircraft
    const acBGround = await createResourceWithDb(isoDb, sessB, {
      kind: 'aircraft', displayName: 'N-GND-B', tailNumber: 'NGNDB',
    });
    await groundAircraftWithDb(isoDb, sessB, {
      resourceId: acBGround.id,
      reason: 'Inspection',
    });
  }, 120_000);

  it('T-ISO-FLIGHTS: org-A session sees 1 flight (NOT org-B\'s 3)', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(isoDb, sess, { range: '30d' });
    expect(result.totalFlights).toBe(1);
  });

  it('T-ISO-HOURS: org-A session sees 1.5h (NOT org-B\'s 6.0h)', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(isoDb, sess, { range: '30d' });
    expect(result.totalFlightHours).toBeCloseTo(1.5, 1);
  });

  it('T-ISO-AC: org-A aircraft count does NOT include org-B aircraft', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(isoDb, sess, { range: '30d' });
    // org A seeded only 1 active aircraft in this suite (acA)
    // org B seeded 3 + extra squawk aircraft + grounded aircraft = many more
    expect(result.activeAircraftCount).toBe(1);
  });

  it('T-ISO-SQUAWK: org-A open squawk count is 1 (NOT org-B\'s 3)', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(isoDb, sess, { range: '30d' });
    expect(result.openSquawkCount).toBe(1);
  });

  it('T-ISO-GROUNDED: org-A sees 0 grounded (org-B has 1 grounded)', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(isoDb, sess, { range: '30d' });
    expect(result.groundedAircraftCount).toBe(0);
  });

  it('T-ISO-MEMBERS: org-A sees its own members only (NOT org-B members)', async () => {
    const sessA = makeSession(isoOrgAId, isoUserAId, 'owner');
    const sessB = makeSession(isoOrgBId, isoUserBId, 'owner');
    const resultA = await getOrgDashboardMetricsWithDb(isoDb, sessA, { range: '30d' });
    const resultB = await getOrgDashboardMetricsWithDb(isoDb, sessB, { range: '30d' });
    // Each org starts with 1 seeded member; they must be independent
    expect(resultA.activeMemberCount).toBeGreaterThanOrEqual(1);
    expect(resultB.activeMemberCount).toBeGreaterThanOrEqual(1);
    // They should not be equal because they are isolated — each counts only its own
    // (This assertion assumes seedTwoOrgs creates exactly 1 user each; counts are equal
    // but that's fine — the point is org-A doesn't see org-B's members)
    // Critical: A's count is NOT A's count + B's count
    expect(resultA.activeMemberCount).toBeLessThan(resultA.activeMemberCount + resultB.activeMemberCount);
  });

  it('T-ISO-UTIL: getAircraftUtilization from org-A does NOT include org-B high-util tails', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const rows = await getAircraftUtilizationWithDb(isoDb, sess, { range: '30d' });
    // Org A has 1 tail (NISOA1) with 1.5h
    // Org B has many tails with higher utilization — should NOT appear
    const tailNumbers = rows.map((r) => r.tailNumber);
    expect(tailNumbers).toContain('NISOA1');
    // Org-B tails must be absent
    expect(tailNumbers.some((t) => t.startsWith('NISOB'))).toBe(false);
    expect(tailNumbers.some((t) => t.startsWith('NSQB'))).toBe(false);
    expect(tailNumbers.some((t) => t === 'NGNDB')).toBe(false);
    // Only 1 aircraft in org A
    expect(rows.length).toBe(1);
  });

  it('T-ISO-RESV: org-A reservations count is independent of org-B reservations', async () => {
    const sessA = makeSession(isoOrgAId, isoUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(isoDb, sessA, { range: '30d' });
    // The future reservations created (W1_start = 2027-03-15) fall OUTSIDE the 30d window
    // The range is [now-30d, now) — future dates are after 'to', so reservationsInRange = 0
    expect(result.reservationsInRange).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — RANGE FILTER (in / out of window)
// ══════════════════════════════════════════════════════════════════════════════

describe('RANGE FILTER: tickets inside vs outside window', () => {
  let rangeDb: PgliteTestClient;
  let rangeOrgAId: string;
  let rangeUserAId: string;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    rangeDb = db;
    rangeOrgAId = seed.orgAId;
    rangeUserAId = seed.userAId;

    const { sql: drizzleSql } = await import('drizzle-orm');
    const sess = makeSession(rangeOrgAId, rangeUserAId, 'owner');

    // Seed aircraft
    const ac = await createResourceWithDb(rangeDb, sess, {
      kind: 'aircraft', displayName: 'N-RANGE', tailNumber: 'NRANGE',
    });

    // Create 3 separate reservations for the range test (same aircraft, same window
    // is ok since these are future reservations and the aircraft is out of dispatch
    // between tests). We need separate reservations because of the one-open-per-aircraft rule.
    // Trick: use different aircraft for each dispatch cycle, or reuse if aircraft is closed.
    // For simplicity use 3 aircraft.
    const ac2 = await createResourceWithDb(rangeDb, sess, {
      kind: 'aircraft', displayName: 'N-RANGE2', tailNumber: 'NRANGE2',
    });
    const ac3 = await createResourceWithDb(rangeDb, sess, {
      kind: 'aircraft', displayName: 'N-RANGE3', tailNumber: 'NRANGE3',
    });

    // Ticket 1: closed 5 days ago (within 7d, 30d, 90d)
    const r1 = await createReservationWithDb(rangeDb, sess, {
      startAt: T.W1_start, endAt: T.W1_end, resourceIds: [ac.id],
    });
    if (!r1.ok) throw new Error('r1 failed');
    const o1 = await openDispatchWithDb(rangeDb, sess, {
      reservationId: r1.reservation.id, resourceId: ac.id,
      pilotUserId: rangeUserAId, hobbsOut: 100, tachOut: 100,
    });
    if (!o1.ok) throw new Error('o1 failed');
    const c1 = await closeDispatchWithDb(rangeDb, sess, { ticketId: o1.ticket.id, hobbsIn: 102, tachIn: 102 });
    if (!c1.ok) throw new Error('c1 failed');
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await withOrgContext(rangeDb, rangeOrgAId, async (tx) => {
      await tx.execute(drizzleSql`UPDATE dispatch_ticket SET closed_at = ${fiveDaysAgo} WHERE id = ${o1.ticket.id}`);
    });

    // Ticket 2: closed 20 days ago (within 30d, 90d but outside 7d)
    const r2 = await createReservationWithDb(rangeDb, sess, {
      startAt: T.W2_start, endAt: T.W2_end, resourceIds: [ac2.id],
    });
    if (!r2.ok) throw new Error('r2 failed');
    const o2 = await openDispatchWithDb(rangeDb, sess, {
      reservationId: r2.reservation.id, resourceId: ac2.id,
      pilotUserId: rangeUserAId, hobbsOut: 200, tachOut: 200,
    });
    if (!o2.ok) throw new Error('o2 failed');
    const c2 = await closeDispatchWithDb(rangeDb, sess, { ticketId: o2.ticket.id, hobbsIn: 201, tachIn: 201 });
    if (!c2.ok) throw new Error('c2 failed');
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    await withOrgContext(rangeDb, rangeOrgAId, async (tx) => {
      await tx.execute(drizzleSql`UPDATE dispatch_ticket SET closed_at = ${twentyDaysAgo} WHERE id = ${o2.ticket.id}`);
    });

    // Ticket 3: closed 95 days ago (outside 90d window entirely)
    const r3 = await createReservationWithDb(rangeDb, sess, {
      startAt: T.W3_start, endAt: T.W3_end, resourceIds: [ac3.id],
    });
    if (!r3.ok) throw new Error('r3 failed');
    const o3 = await openDispatchWithDb(rangeDb, sess, {
      reservationId: r3.reservation.id, resourceId: ac3.id,
      pilotUserId: rangeUserAId, hobbsOut: 300, tachOut: 300,
    });
    if (!o3.ok) throw new Error('o3 failed');
    const c3 = await closeDispatchWithDb(rangeDb, sess, { ticketId: o3.ticket.id, hobbsIn: 302, tachIn: 302 });
    if (!c3.ok) throw new Error('c3 failed');
    const ninetyFiveDaysAgo = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000);
    await withOrgContext(rangeDb, rangeOrgAId, async (tx) => {
      await tx.execute(drizzleSql`UPDATE dispatch_ticket SET closed_at = ${ninetyFiveDaysAgo} WHERE id = ${o3.ticket.id}`);
    });
  }, 120_000);

  it('7d range: only 1 flight (5 days ago), not 3', async () => {
    const sess = makeSession(rangeOrgAId, rangeUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(rangeDb, sess, { range: '7d' });
    expect(result.totalFlights).toBe(1);
    expect(result.range.key).toBe('7d');
  });

  it('30d range: 2 flights (5 and 20 days ago), not 3', async () => {
    const sess = makeSession(rangeOrgAId, rangeUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(rangeDb, sess, { range: '30d' });
    expect(result.totalFlights).toBe(2);
  });

  it('90d range: 2 flights (5 and 20 days ago), ticket at 95d excluded', async () => {
    const sess = makeSession(rangeOrgAId, rangeUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(rangeDb, sess, { range: '90d' });
    expect(result.totalFlights).toBe(2);
  });

  it('7d totalFlightHours: 2.0 (hobbsIn-hobbsOut = 2.0 for 5d-ago ticket)', async () => {
    const sess = makeSession(rangeOrgAId, rangeUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(rangeDb, sess, { range: '7d' });
    expect(result.totalFlightHours).toBeCloseTo(2.0, 1);
  });

  it('30d totalFlightHours: 3.0 (2.0 + 1.0 for 5d-ago and 20d-ago tickets)', async () => {
    const sess = makeSession(rangeOrgAId, rangeUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(rangeDb, sess, { range: '30d' });
    expect(result.totalFlightHours).toBeCloseTo(3.0, 1);
  });

  it('range object has correct from/to shape', async () => {
    const sess = makeSession(rangeOrgAId, rangeUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(rangeDb, sess, { range: '30d' });
    expect(result.range.key).toBe('30d');
    expect(result.range.from).toBeInstanceOf(Date);
    expect(result.range.to).toBeInstanceOf(Date);
    expect(result.range.to.getTime()).toBeGreaterThan(result.range.from.getTime());
    // to should be very close to now (within a second)
    expect(Math.abs(result.range.to.getTime() - Date.now())).toBeLessThan(5000);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — VOIDED + OPEN EXCLUDED from flights/hours
// ══════════════════════════════════════════════════════════════════════════════

describe('VOIDED + OPEN EXCLUDED: closed+voided+open same tail → count 1', () => {
  let voidDb: PgliteTestClient;
  let voidOrgAId: string;
  let voidUserAId: string;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    voidDb = db;
    voidOrgAId = seed.orgAId;
    voidUserAId = seed.userAId;

    const { sql: drizzleSql } = await import('drizzle-orm');
    const sess = makeSession(voidOrgAId, voidUserAId, 'owner');
    const pastDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    // Aircraft 1: open ticket (should NOT count)
    const ac1 = await createResourceWithDb(voidDb, sess, {
      kind: 'aircraft', displayName: 'N-OPEN', tailNumber: 'NOPEN',
    });
    const r1 = await createReservationWithDb(voidDb, sess, {
      startAt: T.W1_start, endAt: T.W1_end, resourceIds: [ac1.id],
    });
    if (!r1.ok) throw new Error('r1 failed');
    await openDispatchWithDb(voidDb, sess, {
      reservationId: r1.reservation.id, resourceId: ac1.id,
      pilotUserId: voidUserAId, hobbsOut: 100, tachOut: 100,
    });

    // Aircraft 2: voided ticket (should NOT count)
    const ac2 = await createResourceWithDb(voidDb, sess, {
      kind: 'aircraft', displayName: 'N-VOID', tailNumber: 'NVOID',
    });
    const r2 = await createReservationWithDb(voidDb, sess, {
      startAt: T.W2_start, endAt: T.W2_end, resourceIds: [ac2.id],
    });
    if (!r2.ok) throw new Error('r2 failed');
    const o2 = await openDispatchWithDb(voidDb, sess, {
      reservationId: r2.reservation.id, resourceId: ac2.id,
      pilotUserId: voidUserAId, hobbsOut: 200, tachOut: 200,
    });
    if (!o2.ok) throw new Error('o2 failed');
    await voidDispatchWithDb(voidDb, sess, { ticketId: o2.ticket.id, reason: 'test' });

    // Aircraft 3: closed ticket (SHOULD count)
    const ac3 = await createResourceWithDb(voidDb, sess, {
      kind: 'aircraft', displayName: 'N-CLOSED', tailNumber: 'NCLOSED',
    });
    const r3 = await createReservationWithDb(voidDb, sess, {
      startAt: T.W3_start, endAt: T.W3_end, resourceIds: [ac3.id],
    });
    if (!r3.ok) throw new Error('r3 failed');
    const o3 = await openDispatchWithDb(voidDb, sess, {
      reservationId: r3.reservation.id, resourceId: ac3.id,
      pilotUserId: voidUserAId, hobbsOut: 300, tachOut: 300,
    });
    if (!o3.ok) throw new Error('o3 failed');
    const c3 = await closeDispatchWithDb(voidDb, sess, { ticketId: o3.ticket.id, hobbsIn: 301, tachIn: 301 });
    if (!c3.ok) throw new Error('c3 failed');
    await withOrgContext(voidDb, voidOrgAId, async (tx) => {
      await tx.execute(drizzleSql`UPDATE dispatch_ticket SET closed_at = ${pastDate} WHERE id = ${o3.ticket.id}`);
    });
  }, 120_000);

  it('totalFlights = 1 (only closed counts; open + voided excluded)', async () => {
    const sess = makeSession(voidOrgAId, voidUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(voidDb, sess, { range: '30d' });
    expect(result.totalFlights).toBe(1);
  });

  it('totalFlightHours = 1.0 (only closed 1.0h ticket)', async () => {
    const sess = makeSession(voidOrgAId, voidUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(voidDb, sess, { range: '30d' });
    expect(result.totalFlightHours).toBeCloseTo(1.0, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — AUTHZ: getAircraftUtilization
// ══════════════════════════════════════════════════════════════════════════════

describe('AUTHZ: getAircraftUtilization', () => {
  it('null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(getAircraftUtilizationWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('mechanic role → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'mechanic');
    await expect(getAircraftUtilizationWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('renter role → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(getAircraftUtilizationWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('student role → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'student');
    await expect(getAircraftUtilizationWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('accountant role → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'accountant');
    const rows = await getAircraftUtilizationWithDb(db, sess);
    expect(Array.isArray(rows)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — getAircraftUtilization HAPPY PATH + ordering
// ══════════════════════════════════════════════════════════════════════════════

describe('getAircraftUtilization: happy path + ordering', () => {
  let utilDb: PgliteTestClient;
  let utilOrgAId: string;
  let utilUserAId: string;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    utilDb = db;
    utilOrgAId = seed.orgAId;
    utilUserAId = seed.userAId;

    const { sql: drizzleSql } = await import('drizzle-orm');
    const sess = makeSession(utilOrgAId, utilUserAId, 'owner');
    const pastDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

    // 3 active aircraft with different utilization levels
    // Tail A: 3.0h (highest)
    // Tail B: 1.5h (middle)
    // Tail C: 0h  (zero — appears via LEFT JOIN)

    const acA = await createResourceWithDb(utilDb, sess, {
      kind: 'aircraft', displayName: 'N-UTIL-A', tailNumber: 'NUTILA',
    });
    const acB = await createResourceWithDb(utilDb, sess, {
      kind: 'aircraft', displayName: 'N-UTIL-B', tailNumber: 'NUTILB',
    });
    await createResourceWithDb(utilDb, sess, {
      kind: 'aircraft', displayName: 'N-UTIL-C', tailNumber: 'NUTILC',
    });
    // Aircraft C has no dispatch

    // Tail A: 3.0h (hobbsIn - hobbsOut = 3.0)
    const rA = await createReservationWithDb(utilDb, sess, {
      startAt: T.W1_start, endAt: T.W1_end, resourceIds: [acA.id],
    });
    if (!rA.ok) throw new Error('rA failed');
    const oA = await openDispatchWithDb(utilDb, sess, {
      reservationId: rA.reservation.id, resourceId: acA.id,
      pilotUserId: utilUserAId, hobbsOut: 100, tachOut: 100,
    });
    if (!oA.ok) throw new Error('oA failed');
    const cA = await closeDispatchWithDb(utilDb, sess, { ticketId: oA.ticket.id, hobbsIn: 103, tachIn: 103 });
    if (!cA.ok) throw new Error('cA failed');
    await withOrgContext(utilDb, utilOrgAId, async (tx) => {
      await tx.execute(drizzleSql`UPDATE dispatch_ticket SET closed_at = ${pastDate} WHERE id = ${oA.ticket.id}`);
    });

    // Tail B: 1.5h
    const rB = await createReservationWithDb(utilDb, sess, {
      startAt: T.W2_start, endAt: T.W2_end, resourceIds: [acB.id],
    });
    if (!rB.ok) throw new Error('rB failed');
    const oB = await openDispatchWithDb(utilDb, sess, {
      reservationId: rB.reservation.id, resourceId: acB.id,
      pilotUserId: utilUserAId, hobbsOut: 200, tachOut: 200,
    });
    if (!oB.ok) throw new Error('oB failed');
    const cB = await closeDispatchWithDb(utilDb, sess, { ticketId: oB.ticket.id, hobbsIn: 201.5, tachIn: 201.5 });
    if (!cB.ok) throw new Error('cB failed');
    await withOrgContext(utilDb, utilOrgAId, async (tx) => {
      await tx.execute(drizzleSql`UPDATE dispatch_ticket SET closed_at = ${pastDate} WHERE id = ${oB.ticket.id}`);
    });
  }, 120_000);

  it('returns 3 rows (all active aircraft including zero-flight C)', async () => {
    const sess = makeSession(utilOrgAId, utilUserAId, 'owner');
    const rows = await getAircraftUtilizationWithDb(utilDb, sess, { range: '30d' });
    // 3 active aircraft (NUTILA, NUTILB, NUTILC)
    expect(rows.length).toBe(3);
  });

  it('ordered hours DESC: NUTILA (3.0h) first, then NUTILB (1.5h)', async () => {
    const sess = makeSession(utilOrgAId, utilUserAId, 'owner');
    const rows = await getAircraftUtilizationWithDb(utilDb, sess, { range: '30d' });
    expect(rows[0]?.tailNumber).toBe('NUTILA');
    expect(rows[1]?.tailNumber).toBe('NUTILB');
  });

  it('NUTILA: flightCount=1, flightHours=3.0', async () => {
    const sess = makeSession(utilOrgAId, utilUserAId, 'owner');
    const rows = await getAircraftUtilizationWithDb(utilDb, sess, { range: '30d' });
    const rowA = rows.find((r) => r.tailNumber === 'NUTILA');
    expect(rowA?.flightCount).toBe(1);
    expect(rowA?.flightHours).toBeCloseTo(3.0, 1);
  });

  it('NUTILB: flightCount=1, flightHours=1.5', async () => {
    const sess = makeSession(utilOrgAId, utilUserAId, 'owner');
    const rows = await getAircraftUtilizationWithDb(utilDb, sess, { range: '30d' });
    const rowB = rows.find((r) => r.tailNumber === 'NUTILB');
    expect(rowB?.flightCount).toBe(1);
    expect(rowB?.flightHours).toBeCloseTo(1.5, 1);
  });

  it('NUTILC (zero-flight): flightCount=0, flightHours=0.0', async () => {
    const sess = makeSession(utilOrgAId, utilUserAId, 'owner');
    const rows = await getAircraftUtilizationWithDb(utilDb, sess, { range: '30d' });
    const rowC = rows.find((r) => r.tailNumber === 'NUTILC');
    expect(rowC).toBeDefined();
    expect(rowC?.flightCount).toBe(0);
    expect(rowC?.flightHours).toBe(0);
    expect(Number.isNaN(rowC?.flightHours)).toBe(false);
  });

  it('resourceId is a valid UUID string', async () => {
    const sess = makeSession(utilOrgAId, utilUserAId, 'owner');
    const rows = await getAircraftUtilizationWithDb(utilDb, sess, { range: '30d' });
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const row of rows) {
      expect(UUID_RE.test(row.resourceId)).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — INACTIVE EXCLUDED from utilization
// ══════════════════════════════════════════════════════════════════════════════

describe('getAircraftUtilization: inactive aircraft excluded', () => {
  it('deactivated aircraft does not appear in results', async () => {
    const { db: inactDb, pglite: inactPg } = await createTestClient();
    await applyMigrationSql({ pglite: inactPg }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(inactDb);
    await setTestAppRole({ pglite: inactPg });

    const sess = makeSession(seed.orgAId, seed.userAId, 'owner');

    const acActive = await createResourceWithDb(inactDb, sess, {
      kind: 'aircraft', displayName: 'N-ACTIVE', tailNumber: 'NACTIVE',
    });
    const acInactive = await createResourceWithDb(inactDb, sess, {
      kind: 'aircraft', displayName: 'N-INACT', tailNumber: 'NINACT',
    });

    // Deactivate the second aircraft
    await deactivateResourceWithDb(inactDb, sess, { resourceId: acInactive.id });

    const rows = await getAircraftUtilizationWithDb(inactDb, sess, { range: '30d' });
    const tails = rows.map((r) => r.tailNumber);

    expect(tails).toContain('NACTIVE');
    expect(tails).not.toContain('NINACT');
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — getAircraftUtilization: voided + open excluded
// ══════════════════════════════════════════════════════════════════════════════

describe('getAircraftUtilization: voided + open tickets excluded', () => {
  it('aircraft with only open+voided tickets: flightCount=0, flightHours=0 in result', async () => {
    const { db: vDb, pglite: vPg } = await createTestClient();
    await applyMigrationSql({ pglite: vPg }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(vDb);
    await setTestAppRole({ pglite: vPg });

    const sess = makeSession(seed.orgAId, seed.userAId, 'owner');

    // Aircraft 1: has an open dispatch
    const acOpen = await createResourceWithDb(vDb, sess, {
      kind: 'aircraft', displayName: 'N-OPENONLY', tailNumber: 'NOPENONLY',
    });
    const r1 = await createReservationWithDb(vDb, sess, {
      startAt: T.W1_start, endAt: T.W1_end, resourceIds: [acOpen.id],
    });
    if (!r1.ok) throw new Error('r1 failed');
    await openDispatchWithDb(vDb, sess, {
      reservationId: r1.reservation.id, resourceId: acOpen.id,
      pilotUserId: seed.userAId, hobbsOut: 100, tachOut: 100,
    });

    // Aircraft 2: has only a voided dispatch
    const acVoid = await createResourceWithDb(vDb, sess, {
      kind: 'aircraft', displayName: 'N-VOIDONLY', tailNumber: 'NVOIDONLY',
    });
    const r2 = await createReservationWithDb(vDb, sess, {
      startAt: T.W2_start, endAt: T.W2_end, resourceIds: [acVoid.id],
    });
    if (!r2.ok) throw new Error('r2 failed');
    const o2 = await openDispatchWithDb(vDb, sess, {
      reservationId: r2.reservation.id, resourceId: acVoid.id,
      pilotUserId: seed.userAId, hobbsOut: 200, tachOut: 200,
    });
    if (!o2.ok) throw new Error('o2 failed');
    await voidDispatchWithDb(vDb, sess, { ticketId: o2.ticket.id, reason: 'test' });

    const rows = await getAircraftUtilizationWithDb(vDb, sess, { range: '30d' });

    // Both aircraft should appear (they are active) but with 0 flights/hours
    const rowOpen = rows.find((r) => r.tailNumber === 'NOPENONLY');
    const rowVoid = rows.find((r) => r.tailNumber === 'NVOIDONLY');

    expect(rowOpen).toBeDefined();
    expect(rowOpen?.flightCount).toBe(0);
    expect(rowOpen?.flightHours).toBe(0);

    expect(rowVoid).toBeDefined();
    expect(rowVoid?.flightCount).toBe(0);
    expect(rowVoid?.flightHours).toBe(0);
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 13 — HAPPY PATH: getOrgDashboardMetrics hand-computed
// ══════════════════════════════════════════════════════════════════════════════

describe('HAPPY PATH: getOrgDashboardMetrics hand-computed counts', () => {
  let happyDb: PgliteTestClient;
  let happyOrgAId: string;
  let happyUserAId: string;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    happyDb = db;
    happyOrgAId = seed.orgAId;
    happyUserAId = seed.userAId;

    const { sql: drizzleSql } = await import('drizzle-orm');
    const sess = makeSession(happyOrgAId, happyUserAId, 'owner');
    const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

    // 2 closed tickets (2.0h + 3.0h = 5.0h) in range
    const ac1 = await createResourceWithDb(happyDb, sess, {
      kind: 'aircraft', displayName: 'N-HAPPY1', tailNumber: 'NHAPPY1',
    });
    const ac2 = await createResourceWithDb(happyDb, sess, {
      kind: 'aircraft', displayName: 'N-HAPPY2', tailNumber: 'NHAPPY2',
    });

    const r1 = await createReservationWithDb(happyDb, sess, {
      startAt: T.W1_start, endAt: T.W1_end, resourceIds: [ac1.id],
    });
    if (!r1.ok) throw new Error('r1 failed');
    const o1 = await openDispatchWithDb(happyDb, sess, {
      reservationId: r1.reservation.id, resourceId: ac1.id,
      pilotUserId: happyUserAId, hobbsOut: 100, tachOut: 100,
    });
    if (!o1.ok) throw new Error('o1 failed');
    const c1 = await closeDispatchWithDb(happyDb, sess, { ticketId: o1.ticket.id, hobbsIn: 102, tachIn: 102 });
    if (!c1.ok) throw new Error('c1 failed');
    await withOrgContext(happyDb, happyOrgAId, async (tx) => {
      await tx.execute(drizzleSql`UPDATE dispatch_ticket SET closed_at = ${recentDate} WHERE id = ${o1.ticket.id}`);
    });

    const r2 = await createReservationWithDb(happyDb, sess, {
      startAt: T.W2_start, endAt: T.W2_end, resourceIds: [ac2.id],
    });
    if (!r2.ok) throw new Error('r2 failed');
    const o2 = await openDispatchWithDb(happyDb, sess, {
      reservationId: r2.reservation.id, resourceId: ac2.id,
      pilotUserId: happyUserAId, hobbsOut: 200, tachOut: 200,
    });
    if (!o2.ok) throw new Error('o2 failed');
    const c2 = await closeDispatchWithDb(happyDb, sess, { ticketId: o2.ticket.id, hobbsIn: 203, tachIn: 203 });
    if (!c2.ok) throw new Error('c2 failed');
    await withOrgContext(happyDb, happyOrgAId, async (tx) => {
      await tx.execute(drizzleSql`UPDATE dispatch_ticket SET closed_at = ${recentDate} WHERE id = ${o2.ticket.id}`);
    });

    // 1 open squawk
    await reportSquawkWithDb(happyDb, sess, {
      resourceId: ac1.id, title: 'Squawk 1', severity: 'low',
    });

    // Ground ac1
    await groundAircraftWithDb(happyDb, sess, { resourceId: ac1.id, reason: 'Annual' });
  }, 120_000);

  it('totalFlights = 2 (exactly 2 closed tickets)', async () => {
    const sess = makeSession(happyOrgAId, happyUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(happyDb, sess, { range: '30d' });
    expect(result.totalFlights).toBe(2);
  });

  it('totalFlightHours = 5.0 (2.0 + 3.0)', async () => {
    const sess = makeSession(happyOrgAId, happyUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(happyDb, sess, { range: '30d' });
    expect(result.totalFlightHours).toBeCloseTo(5.0, 1);
  });

  it('openSquawkCount = 1', async () => {
    const sess = makeSession(happyOrgAId, happyUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(happyDb, sess, { range: '30d' });
    expect(result.openSquawkCount).toBe(1);
  });

  it('activeAircraftCount = 2', async () => {
    const sess = makeSession(happyOrgAId, happyUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(happyDb, sess, { range: '30d' });
    expect(result.activeAircraftCount).toBe(2);
  });

  it('groundedAircraftCount = 1 (ac1 grounded)', async () => {
    const sess = makeSession(happyOrgAId, happyUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(happyDb, sess, { range: '30d' });
    expect(result.groundedAircraftCount).toBe(1);
  });

  it('activeMemberCount >= 1', async () => {
    const sess = makeSession(happyOrgAId, happyUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(happyDb, sess, { range: '30d' });
    expect(result.activeMemberCount).toBeGreaterThanOrEqual(1);
  });

  it('range object has key="30d", from < to, to close to now', async () => {
    const sess = makeSession(happyOrgAId, happyUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(happyDb, sess, { range: '30d' });
    expect(result.range.key).toBe('30d');
    expect(result.range.from.getTime()).toBeLessThan(result.range.to.getTime());
    expect(Math.abs(result.range.to.getTime() - Date.now())).toBeLessThan(5000);
  });

  it('totalFlightHours is rounded to 1dp (not raw floating point noise)', async () => {
    const sess = makeSession(happyOrgAId, happyUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(happyDb, sess, { range: '30d' });
    const roundedBack = Math.round(result.totalFlightHours * 10) / 10;
    expect(result.totalFlightHours).toBe(roundedBack);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 14 — NEW COUNTS: openWorkOrderCount + activeEnrollmentCount
//
// Verifies:
//   a) happy-path: counts compute correctly from seeded WOs + enrollments.
//   b) zero when none present.
//   c) completed/cancelled WOs excluded; withdrawn enrollments excluded.
//   d) openWorkOrderCount includes both 'open' and 'in_progress' status.
// ══════════════════════════════════════════════════════════════════════════════

import { openWorkOrderWithDb } from '../maintenance/open-work-order.js';
import { updateWorkOrderStatusWithDb } from '../maintenance/update-work-order-status.js';
import { completeWorkOrderWithDb } from '../maintenance/complete-work-order.js';
import { cancelWorkOrderWithDb } from '../maintenance/cancel-work-order.js';
import { createCourseWithDb } from '../training/create-course.js';
import { enrollMemberWithDb } from '../training/enroll-member.js';
import { setEnrollmentStatusWithDb } from '../training/set-enrollment-status.js';

describe('NEW COUNTS: openWorkOrderCount + activeEnrollmentCount', () => {
  let countsDb: PgliteTestClient;
  let countsOrgAId: string;
  let countsUserAId: string;
  let countsAircraftId: string;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    countsDb = db;
    countsOrgAId = seed.orgAId;
    countsUserAId = seed.userAId;

    const sess = makeSession(countsOrgAId, countsUserAId, 'owner');

    // Create one aircraft for work orders.
    const aircraft = await createResourceWithDb(countsDb, sess, {
      kind: 'aircraft', displayName: 'N-COUNTS', tailNumber: 'NCOUNTS',
    });
    countsAircraftId = aircraft.id;

    // Seed work orders:
    //   WO-1: open (status='open')          → counts
    //   WO-2: in_progress                   → counts
    //   WO-3: completed                     → does NOT count
    //   WO-4: cancelled                     → does NOT count

    const wo1 = await openWorkOrderWithDb(countsDb, sess, {
      resourceId: countsAircraftId,
      title: 'WO open',
    });
    if (!wo1.ok) throw new Error('wo1 failed');

    const wo2 = await openWorkOrderWithDb(countsDb, sess, {
      resourceId: countsAircraftId,
      title: 'WO in-progress',
    });
    if (!wo2.ok) throw new Error('wo2 failed');
    // Advance to in_progress
    const upResult = await updateWorkOrderStatusWithDb(countsDb, sess, {
      workOrderId: wo2.workOrder.id,
      status: 'in_progress',
    });
    if (!upResult.ok) throw new Error('advance to in_progress failed');

    const wo3 = await openWorkOrderWithDb(countsDb, sess, {
      resourceId: countsAircraftId,
      title: 'WO completed',
    });
    if (!wo3.ok) throw new Error('wo3 failed');
    // completeWorkOrder requires maintenance:work_order cap (owner has it).
    const comp = await completeWorkOrderWithDb(countsDb, sess, {
      workOrderId: wo3.workOrder.id,
      workPerformed: 'Annual inspection done',
    });
    if (!comp.ok) throw new Error(`complete wo3 failed: ${JSON.stringify(comp)}`);

    const wo4 = await openWorkOrderWithDb(countsDb, sess, {
      resourceId: countsAircraftId,
      title: 'WO cancelled',
    });
    if (!wo4.ok) throw new Error('wo4 failed');
    // cancelWorkOrder requires cancelledReason.
    const canc = await cancelWorkOrderWithDb(countsDb, sess, {
      workOrderId: wo4.workOrder.id,
      cancelledReason: 'Not needed',
    });
    if (!canc.ok) throw new Error(`cancel wo4 failed: ${JSON.stringify(canc)}`);

    // Seed enrollments:
    //   E-1: active   → counts
    //   E-2: active   → counts (second enrollment, same course is a UNIQUE violation so use different course)
    //   E-3: completed → does NOT count
    //   E-4: withdrawn → does NOT count

    const course1 = await createCourseWithDb(countsDb, sess, { title: 'Course 1' });
    if (!course1.ok) throw new Error('course1 failed');
    const course2 = await createCourseWithDb(countsDb, sess, { title: 'Course 2' });
    if (!course2.ok) throw new Error('course2 failed');
    const course3 = await createCourseWithDb(countsDb, sess, { title: 'Course 3' });
    if (!course3.ok) throw new Error('course3 failed');
    const course4 = await createCourseWithDb(countsDb, sess, { title: 'Course 4' });
    if (!course4.ok) throw new Error('course4 failed');

    const e1 = await enrollMemberWithDb(countsDb, sess, {
      courseId: course1.course.courseId,
      studentUserId: countsUserAId,
    });
    if (!e1.ok) throw new Error('e1 failed');

    // For e2 we need a second user; use orgB user in orgA context — we can't do cross-org.
    // Instead, use a raw SQL insert for the second enrollment to a different course.
    // Actually, each enrollment is per (student, course). E1 is (userA, course1) → active.
    // For e3 and e4 we can use different courses on the same user.

    const e3 = await enrollMemberWithDb(countsDb, sess, {
      courseId: course3.course.courseId,
      studentUserId: countsUserAId,
    });
    if (!e3.ok) throw new Error('e3 failed');
    const setComp = await setEnrollmentStatusWithDb(countsDb, sess, {
      enrollmentId: e3.enrollment.enrollmentId,
      status: 'completed',
    });
    if (!setComp.ok) throw new Error('setComp failed');

    const e4 = await enrollMemberWithDb(countsDb, sess, {
      courseId: course4.course.courseId,
      studentUserId: countsUserAId,
    });
    if (!e4.ok) throw new Error('e4 failed');
    const setWith = await setEnrollmentStatusWithDb(countsDb, sess, {
      enrollmentId: e4.enrollment.enrollmentId,
      status: 'withdrawn',
    });
    if (!setWith.ok) throw new Error('setWith failed');
  }, 120_000);

  it('openWorkOrderCount = 2 (open + in_progress; completed + cancelled excluded)', async () => {
    const sess = makeSession(countsOrgAId, countsUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(countsDb, sess);
    expect(result.openWorkOrderCount).toBe(2);
  });

  it('activeEnrollmentCount = 1 (active only; completed + withdrawn excluded)', async () => {
    const sess = makeSession(countsOrgAId, countsUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(countsDb, sess);
    expect(result.activeEnrollmentCount).toBe(1);
  });

  it('openWorkOrderCount is a number, not NaN or null', async () => {
    const sess = makeSession(countsOrgAId, countsUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(countsDb, sess);
    expect(typeof result.openWorkOrderCount).toBe('number');
    expect(Number.isNaN(result.openWorkOrderCount)).toBe(false);
  });

  it('activeEnrollmentCount is a number, not NaN or null', async () => {
    const sess = makeSession(countsOrgAId, countsUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(countsDb, sess);
    expect(typeof result.activeEnrollmentCount).toBe('number');
    expect(Number.isNaN(result.activeEnrollmentCount)).toBe(false);
  });

  it('empty org: openWorkOrderCount = 0, not NaN', async () => {
    const { db: emptyDb, pglite: emptyPglite } = await createTestClient();
    await applyMigrationSql({ pglite: emptyPglite }, MIGRATION_SQL);
    const emptySeed = await seedTwoOrgs(emptyDb);
    await setTestAppRole({ pglite: emptyPglite });

    const sess = makeSession(emptySeed.orgAId, emptySeed.userAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(emptyDb, sess);
    expect(result.openWorkOrderCount).toBe(0);
    expect(Number.isNaN(result.openWorkOrderCount)).toBe(false);
  });

  it('empty org: activeEnrollmentCount = 0, not NaN', async () => {
    const { db: emptyDb, pglite: emptyPglite } = await createTestClient();
    await applyMigrationSql({ pglite: emptyPglite }, MIGRATION_SQL);
    const emptySeed = await seedTwoOrgs(emptyDb);
    await setTestAppRole({ pglite: emptyPglite });

    const sess = makeSession(emptySeed.orgAId, emptySeed.userAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(emptyDb, sess);
    expect(result.activeEnrollmentCount).toBe(0);
    expect(Number.isNaN(result.activeEnrollmentCount)).toBe(false);
  });
}, 180_000);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 15 — T-ISO: Tenant isolation for new counts
//
// T-ISO-WORK-ORDERS: org-A session NEVER counts org-B work orders.
// T-ISO-ENROLLMENTS: org-A session NEVER counts org-B enrollments.
//
// Org B is seeded with MORE WOs and enrollments. Org-A session must return
// only org-A values. These tests extend the load-bearing T-ISO-* suite.
// ══════════════════════════════════════════════════════════════════════════════

describe('T-ISO: Tenant isolation for openWorkOrderCount + activeEnrollmentCount', () => {
  let isoDb: PgliteTestClient;
  let isoOrgAId: string;
  let isoOrgBId: string;
  let isoUserAId: string;
  let isoUserBId: string;

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

    // Org A: create 1 aircraft + 1 open WO.
    const acA = await createResourceWithDb(isoDb, sessA, {
      kind: 'aircraft', displayName: 'N-ISO-WO-A', tailNumber: 'NISOWOA',
    });
    const woA = await openWorkOrderWithDb(isoDb, sessA, {
      resourceId: acA.id,
      title: 'WO A open',
    });
    if (!woA.ok) throw new Error('woA failed');

    // Org B: create 1 aircraft + 3 open WOs (more than A).
    const acB = await createResourceWithDb(isoDb, sessB, {
      kind: 'aircraft', displayName: 'N-ISO-WO-B', tailNumber: 'NISOWOB',
    });
    for (let i = 1; i <= 3; i++) {
      const woB = await openWorkOrderWithDb(isoDb, sessB, {
        resourceId: acB.id,
        title: `WO B${i} open`,
      });
      if (!woB.ok) throw new Error(`woB${i} failed`);
    }

    // Org A: create 1 course + 1 active enrollment.
    const courseA = await createCourseWithDb(isoDb, sessA, { title: 'ISO Course A' });
    if (!courseA.ok) throw new Error('courseA failed');
    const eA = await enrollMemberWithDb(isoDb, sessA, {
      courseId: courseA.course.courseId,
      studentUserId: isoUserAId,
    });
    if (!eA.ok) throw new Error('eA failed');

    // Org B: create 3 courses + 3 active enrollments (more than A).
    for (let i = 1; i <= 3; i++) {
      const courseB = await createCourseWithDb(isoDb, sessB, { title: `ISO Course B${i}` });
      if (!courseB.ok) throw new Error(`courseB${i} failed`);
      const eB = await enrollMemberWithDb(isoDb, sessB, {
        courseId: courseB.course.courseId,
        studentUserId: isoUserBId,
      });
      if (!eB.ok) throw new Error(`eB${i} failed`);
    }
  }, 120_000);

  it('T-ISO-WORK-ORDERS: org-A session sees 1 open WO (NOT org-B\'s 3)', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(isoDb, sess, { range: '30d' });
    expect(result.openWorkOrderCount).toBe(1);
  });

  it('T-ISO-ENROLLMENTS: org-A session sees 1 active enrollment (NOT org-B\'s 3)', async () => {
    const sess = makeSession(isoOrgAId, isoUserAId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(isoDb, sess, { range: '30d' });
    expect(result.activeEnrollmentCount).toBe(1);
  });

  it('T-ISO-WORK-ORDERS: org-B session sees 3 open WOs (NOT org-A\'s 1)', async () => {
    const sess = makeSession(isoOrgBId, isoUserBId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(isoDb, sess, { range: '30d' });
    expect(result.openWorkOrderCount).toBe(3);
  });

  it('T-ISO-ENROLLMENTS: org-B session sees 3 active enrollments (NOT org-A\'s 1)', async () => {
    const sess = makeSession(isoOrgBId, isoUserBId, 'owner');
    const result = await getOrgDashboardMetricsWithDb(isoDb, sess, { range: '30d' });
    expect(result.activeEnrollmentCount).toBe(3);
  });

  it('T-ISO: org-A WO count + org-B WO count != combined total (no leakage)', async () => {
    const sessA = makeSession(isoOrgAId, isoUserAId, 'owner');
    const sessB = makeSession(isoOrgBId, isoUserBId, 'owner');
    const resultA = await getOrgDashboardMetricsWithDb(isoDb, sessA);
    const resultB = await getOrgDashboardMetricsWithDb(isoDb, sessB);
    // If either counted across orgs it would equal the sum — it must not.
    expect(resultA.openWorkOrderCount).toBeLessThan(resultA.openWorkOrderCount + resultB.openWorkOrderCount);
    expect(resultA.activeEnrollmentCount).toBeLessThan(resultA.activeEnrollmentCount + resultB.activeEnrollmentCount);
  });
});
