/**
 * dispatch-api.test.ts — API integration tests for DISPATCH-3a.
 *
 * Tests the persistence/DB layer for the dispatch write paths and board read.
 * Applies migrations 0000–0005 (migration 0005 = dispatch_ticket table).
 *
 * COVERAGE (per §6 api block):
 *   HAPPY: openDispatch + audit + status open
 *   NOT_FOUND: cross-org reservation / unknown id / cancelled reservation
 *   VALIDATION: resource not on reservation / non-aircraft / inactive → ValidationError
 *   VALIDATION: pilot not an org member → ValidationError
 *   ONE-OPEN BACKSTOP: 2nd open same aircraft → already_open with openTicketId
 *   VOID FREES AIRCRAFT: open → void → re-open succeeds
 *   CLOSE HAPPY: derives + persists flight_time + status closed + audit
 *   CLOSE in<out: ValidationError, no write, stays open
 *   RE-CLOSE: not_open
 *   CONCURRENCY GUARD: UPDATE WHERE status='open' (0 rows → not_open)
 *   RLS ISOLATION: cross-org ticket invisible
 *   AUTHZ: no dispatch:create → Forbidden; null → Unauthenticated; renter → Forbidden
 *   READS: getDispatchForReservation mapping + RLS
 *   AUDIT: exactly one dispatch.opened / dispatch.closed / dispatch.voided per op
 *
 * Setup mirrors reschedule-api.test.ts: createTestClient() →
 * applyMigrationSql([0000–0005]) → seedTwoOrgs → additional seed → setTestAppRole.
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
  withPlatformAdminContext,
  seedTwoOrgs,
} from '@aeroops/db';
import { appUser, membership, resource, reservation, reservationResource, auditLog, dispatchTicket } from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { cancelReservationWithDb } from '../scheduling/cancel-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { voidDispatchWithDb } from '../dispatch/void-dispatch.js';
import {
  getDispatchForReservationWithDb,
  listDispatchPilotsWithDb,
} from '../dispatch/list-dispatch.js';
import { deriveFlightTime } from '@aeroops/core';
import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// ── Path resolution ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_SQL = [
  readFileSync(resolve(__dirname, '../../../db/migrations/0000_loud_prodigy.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0001_auth_credential.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0002_scheduling.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0003_booking_policies.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0004_recurrence.sql'), 'utf-8'),
  // 0005 required: dispatch_ticket table + enum + RLS + partial-UNIQUE backstop.
  readFileSync(resolve(__dirname, '../../../db/migrations/0005_dispatch.sql'), 'utf-8'),
  // 0006 required: openDispatch now calls loadGroundingProbe (grounding block, ADR-0008).
  // aircraft_grounding table must exist even in the dispatch test harness.
  readFileSync(resolve(__dirname, '../../../db/migrations/0006_squawks_grounding.sql'), 'utf-8'),
  // 0007 required: resource schema now includes fleet columns (Slice 5.1).
  // Drizzle ORM INSERT emits all columns so they must exist in the test DB.
  readFileSync(resolve(__dirname, '../../../db/migrations/0007_fleet.sql'), 'utf-8'),
  // 0008 required: app_user now includes phone/status columns (Slice 6.1).
  // Drizzle ORM INSERT on app_user emits all columns including phone + status.
  readFileSync(resolve(__dirname, '../../../db/migrations/0008_people.sql'), 'utf-8'),
  // 0009 required: dispatch_requirement + dispatch_config tables (Slice 3c / ADR-0009).
  // openDispatch now queries dispatch_requirement; tables must exist in test DB.
  readFileSync(resolve(__dirname, '../../../db/migrations/0009_dispatch_gate.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0010_civil_twilight.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0011_optimizer_run.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0012_training.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0013_work_orders.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0014_availability.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0015_booking_request.sql'),  'utf-8'),
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

// Reservation window — a future slot so booking-policy min-advance checks pass.
const D = '2026-07-15';
const T = {
  W1_start: new Date(`${D}T08:00:00Z`),
  W1_end:   new Date(`${D}T10:00:00Z`),
  W2_start: new Date(`${D}T12:00:00Z`),
  W2_end:   new Date(`${D}T14:00:00Z`),
};

let sharedEnv: TestEnv;

/**
 * seedReservationWithAircraft — creates a new aircraft + booked reservation
 * in orgA and returns { aircraftId, reservationId }.
 * Must be called as superuser (before setTestAppRole) or inside a withOrgContext
 * block that runs at superuser level. We call this in beforeAll/test setup
 * when the role is still superuser.
 */
async function seedReservationWithAircraft(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tag: string,
  start = T.W1_start,
  end = T.W1_end,
): Promise<{ aircraftId: string; reservationId: string }> {
  const sess = makeSession(orgId, userId, 'owner');

  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `N-${tag}`,
    tailNumber: `N${tag}`,
  });

  const rResult = await createReservationWithDb(db, sess, { startAt: start, endAt: end, resourceIds: [aircraft.id] });
  if (!rResult.ok) throw new Error(`seed reservation failed: ${rResult.reason}`);

  return { aircraftId: aircraft.id, reservationId: rResult.reservation.id };
}

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const seed = await seedTwoOrgs(db);
  // Note: we do NOT call setTestAppRole here — we need to seed additional data
  // (resources, reservations) before dropping to the app role. Each test that
  // needs to seed calls seedReservationWithAircraft while still superuser.

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

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1 — AUTHZ
// ════════════════════════════════════════════════════════════════════════════════

describe('AUTHZ: openDispatch capability gates', () => {
  it('null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(
      openDispatchWithDb(db, null, {
        reservationId: '00000000-0000-0000-0000-000000000001',
        resourceId:    '00000000-0000-0000-0000-000000000002',
        pilotUserId:   '00000000-0000-0000-0000-000000000003',
        hobbsOut: 100,
        tachOut:  100,
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('renter role (no dispatch:create) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(
      openDispatchWithDb(db, sess, {
        reservationId: '00000000-0000-0000-0000-000000000001',
        resourceId:    '00000000-0000-0000-0000-000000000002',
        pilotUserId:   '00000000-0000-0000-0000-000000000003',
        hobbsOut: 100,
        tachOut:  100,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('student role (no dispatch:create) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'student');
    await expect(
      openDispatchWithDb(db, sess, {
        reservationId: '00000000-0000-0000-0000-000000000001',
        resourceId:    '00000000-0000-0000-0000-000000000002',
        pilotUserId:   '00000000-0000-0000-0000-000000000003',
        hobbsOut: 100,
        tachOut:  100,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('mechanic role (no dispatch:create) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'mechanic');
    await expect(
      openDispatchWithDb(db, sess, {
        reservationId: '00000000-0000-0000-0000-000000000001',
        resourceId:    '00000000-0000-0000-0000-000000000002',
        pilotUserId:   '00000000-0000-0000-0000-000000000003',
        hobbsOut: 100,
        tachOut:  100,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('dispatcher role (has dispatch:create) → passes auth gate (gets not_found for bogus input)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'dispatcher');
    const result = await openDispatchWithDb(db, sess, {
      reservationId: '00000000-0000-0000-0000-000000000001',
      resourceId:    '00000000-0000-0000-0000-000000000002',
      pilotUserId:   '00000000-0000-0000-0000-000000000003',
      hobbsOut: 100,
      tachOut:  100,
    });
    // Passes auth; gets not_found (no such reservation in org).
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('cfi role (has dispatch:create) → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'cfi');
    const result = await openDispatchWithDb(db, sess, {
      reservationId: '00000000-0000-0000-0000-000000000001',
      resourceId:    '00000000-0000-0000-0000-000000000002',
      pilotUserId:   '00000000-0000-0000-0000-000000000003',
      hobbsOut: 100,
      tachOut:  100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('listDispatchPilots: cfi (dispatch:access, NOT schedule:manage_resources) → returns members', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'cfi');
    const pilots = await listDispatchPilotsWithDb(db, sess);
    // CFI can load the pilot picker; the seeded org member is present.
    expect(Array.isArray(pilots)).toBe(true);
    expect(pilots.some((p) => p.userId === userAId)).toBe(true);
  });

  it('listDispatchPilots: renter (no dispatch:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(listDispatchPilotsWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('listDispatchPilots: null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(listDispatchPilotsWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('closeDispatch: null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(
      closeDispatchWithDb(db, null, {
        ticketId: '00000000-0000-0000-0000-000000000001',
        hobbsIn: 101,
        tachIn:  101,
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('closeDispatch: renter → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(
      closeDispatchWithDb(db, sess, {
        ticketId: '00000000-0000-0000-0000-000000000001',
        hobbsIn: 101,
        tachIn:  101,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('voidDispatch: null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(
      voidDispatchWithDb(db, null, {
        ticketId: '00000000-0000-0000-0000-000000000001',
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('voidDispatch: renter → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(
      voidDispatchWithDb(db, sess, {
        ticketId: '00000000-0000-0000-0000-000000000001',
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('getDispatchForReservation: null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(
      getDispatchForReservationWithDb(db, null, {
        reservationIds: ['00000000-0000-0000-0000-000000000001'],
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('getDispatchForReservation: renter (no dispatch:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(
      getDispatchForReservationWithDb(db, sess, {
        reservationIds: ['00000000-0000-0000-0000-000000000001'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2 — VALIDATION ERRORS
// ════════════════════════════════════════════════════════════════════════════════

describe('VALIDATION: openDispatch input schema', () => {
  it('negative meter → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      openDispatchWithDb(db, sess, {
        reservationId: '00000000-0000-0000-0000-000000000001',
        resourceId:    '00000000-0000-0000-0000-000000000002',
        pilotUserId:   '00000000-0000-0000-0000-000000000003',
        hobbsOut: -1,
        tachOut:   100,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('meter with 2 decimal places → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      openDispatchWithDb(db, sess, {
        reservationId: '00000000-0000-0000-0000-000000000001',
        resourceId:    '00000000-0000-0000-0000-000000000002',
        pilotUserId:   '00000000-0000-0000-0000-000000000003',
        hobbsOut: 100.12,
        tachOut:  100,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('non-UUID reservationId → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      openDispatchWithDb(db, sess, {
        reservationId: 'not-a-uuid',
        resourceId:    '00000000-0000-0000-0000-000000000002',
        pilotUserId:   '00000000-0000-0000-0000-000000000003',
        hobbsOut: 100,
        tachOut:  100,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('closeDispatch: hobbsIn with 2 decimal places → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      closeDispatchWithDb(db, sess, {
        ticketId: '00000000-0000-0000-0000-000000000001',
        hobbsIn: 100.23,
        tachIn:  100,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3 — HAPPY PATH: openDispatch
// ════════════════════════════════════════════════════════════════════════════════

describe('HAPPY PATH: openDispatch', () => {
  it('opens a ticket → ok:true, status=open, audit row written', async () => {
    const { db, pglite, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Seed a fresh reservation (as the app role — createResourceWithDb/createReservationWithDb are gated)
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-HAPPY-OPEN',
      tailNumber: 'NHAPPYOPEN',
    });

    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const reservationId = rResult.reservation.id;

    // Count audit rows before
    const auditBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityType, 'dispatch_ticket')).execute(),
    );

    const result = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 1234.5,
      tachOut:  1100.2,
      notes: 'Test flight',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ticket = result.ticket;
    expect(ticket.status).toBe('open');
    expect(ticket.reservationId).toBe(reservationId);
    expect(ticket.resourceId).toBe(aircraft.id);
    expect(ticket.pilotUserId).toBe(userAId);
    expect(ticket.hobbsOut).toBeCloseTo(1234.5);
    expect(ticket.tachOut).toBeCloseTo(1100.2);
    expect(ticket.hobbsIn).toBeNull();
    expect(ticket.tachIn).toBeNull();
    expect(ticket.flightTimeHours).toBeNull();
    expect(ticket.notes).toBe('Test flight');
    expect(ticket.openedBy).toBe(userAId);
    expect(ticket.openedAt).toBeInstanceOf(Date);
    expect(ticket.closedBy).toBeNull();
    expect(ticket.closedAt).toBeNull();

    // Exactly one audit row written
    const auditAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityType, 'dispatch_ticket')).execute(),
    );
    expect(auditAfter.length - auditBefore.length).toBe(1);
    const auditRow = auditAfter[auditAfter.length - 1]!;
    expect(auditRow.action).toBe('dispatch.opened');
    expect(auditRow.entityId).toBe(ticket.id);
    expect((auditRow.metadata as Record<string, unknown>)['reservationId']).toBe(reservationId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4 — NOT_FOUND CASES
// ════════════════════════════════════════════════════════════════════════════════

describe('NOT_FOUND: openDispatch', () => {
  it('unknown reservation id → not_found', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const result = await openDispatchWithDb(db, sess, {
      reservationId: '00000000-0000-0000-0000-000000000001',
      resourceId:    '00000000-0000-0000-0000-000000000002',
      pilotUserId:   userAId,
      hobbsOut: 100,
      tachOut:  100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('cross-org reservation id (orgB id used in orgA session) → not_found', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;

    // Create a reservation in org B
    const sessB = makeSession(orgBId, userBId, 'owner');
    const aircraftB = await createResourceWithDb(db, sessB, {
      kind: 'aircraft',
      displayName: 'N-CROSS-ORG',
      tailNumber: 'NCROSSORG',
    });
    const rB = await createReservationWithDb(db, sessB, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraftB.id],
    });
    expect(rB.ok).toBe(true);
    if (!rB.ok) return;

    // Try to open dispatch in org A using org B's reservation id
    const sessA = makeSession(orgAId, userAId, 'owner');
    const result = await openDispatchWithDb(db, sessA, {
      reservationId: rB.reservation.id,
      resourceId:    aircraftB.id,
      pilotUserId:   userAId,
      hobbsOut: 100,
      tachOut:  100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('cancelled reservation → not_found', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-CANCELLED',
      tailNumber: 'NCANCELLED',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    // Cancel the reservation first
    const cancelResult = await cancelReservationWithDb(db, sess, {
      reservationId: rResult.reservation.id,
    });
    expect(cancelResult.ok).toBe(true);

    // Now try to open dispatch
    const result = await openDispatchWithDb(db, sess, {
      reservationId: rResult.reservation.id,
      resourceId:    aircraft.id,
      pilotUserId:   userAId,
      hobbsOut: 100,
      tachOut:  100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5 — RESOURCE VALIDATION
// ════════════════════════════════════════════════════════════════════════════════

describe('VALIDATION: resource checks in openDispatch', () => {
  it('resourceId not on the reservation → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft1 = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-RES1',
      tailNumber: 'NRES1',
    });
    const aircraft2 = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-RES2',
      tailNumber: 'NRES2',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft1.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    // aircraft2 is NOT on the reservation
    await expect(
      openDispatchWithDb(db, sess, {
        reservationId: rResult.reservation.id,
        resourceId:    aircraft2.id,
        pilotUserId:   userAId,
        hobbsOut: 100,
        tachOut:  100,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('non-aircraft resource (instructor) → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const instructor = await createResourceWithDb(db, sess, {
      kind: 'instructor',
      displayName: 'CFI Smith',
      instructorUserId: userAId,
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [instructor.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    await expect(
      openDispatchWithDb(db, sess, {
        reservationId: rResult.reservation.id,
        resourceId:    instructor.id,
        pilotUserId:   userAId,
        hobbsOut: 100,
        tachOut:  100,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('inactive aircraft → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-INACTIVE',
      tailNumber: 'NINACT',
    });

    // Create reservation while active
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W2_start,
      endAt: T.W2_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    // Deactivate the resource
    // We must do this as superuser context since deactivateResource goes through its own auth
    // Instead, update directly since we're at app role — use deactivateResourceWithDb
    const { deactivateResourceWithDb } = await import('../scheduling/resource-commands.js');
    await deactivateResourceWithDb(db, sess, { resourceId: aircraft.id });

    await expect(
      openDispatchWithDb(db, sess, {
        reservationId: rResult.reservation.id,
        resourceId:    aircraft.id,
        pilotUserId:   userAId,
        hobbsOut: 100,
        tachOut:  100,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('pilotUserId not an org member → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-PILOT-CHECK',
      tailNumber: 'NPILOT',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const nonMemberPilotId = '00000000-0000-0000-0000-999999999999';
    await expect(
      openDispatchWithDb(db, sess, {
        reservationId: rResult.reservation.id,
        resourceId:    aircraft.id,
        pilotUserId:   nonMemberPilotId,
        hobbsOut: 100,
        tachOut:  100,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 6 — ONE-OPEN BACKSTOP
// ════════════════════════════════════════════════════════════════════════════════

describe('ONE-OPEN BACKSTOP: second open same aircraft → already_open', () => {
  it('2nd openDispatch on same aircraft → {ok:false, reason:already_open, openTicketId}', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-ONE-OPEN',
      tailNumber: 'NONEOPEN',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;
    const reservationId = rResult.reservation.id;

    // First open — should succeed
    const first = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 100,
      tachOut: 100,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstTicketId = first.ticket.id;

    // Create a second reservation for the same aircraft (different window)
    // Note: the aircraft is already in an open dispatch, so we don't need a new reservation;
    // the partial-UNIQUE index fires on the INSERT, not on the reservation.
    // We can try to open on the SAME reservationId and resourceId again.
    const second = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 105,
      tachOut: 103,
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('already_open');
    if (second.reason !== 'already_open') return;
    expect(second.openTicketId).toBe(firstTicketId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 7 — VOID FREES AIRCRAFT
// ════════════════════════════════════════════════════════════════════════════════

describe('VOID FREES AIRCRAFT: open → void → re-open succeeds', () => {
  it('voidDispatch on open ticket → ok:true; re-open succeeds (aircraft freed)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-VOID-FREE',
      tailNumber: 'NVOIDFREE',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;
    const reservationId = rResult.reservation.id;

    // Open
    const openResult = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 100,
      tachOut: 100,
    });
    expect(openResult.ok).toBe(true);
    if (!openResult.ok) return;
    const ticketId = openResult.ticket.id;

    // Count audit rows before void
    const auditBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.entityType, 'dispatch_ticket'), eq(auditLog.entityId, ticketId)))
        .execute(),
    );
    expect(auditBefore.length).toBe(1); // dispatch.opened

    // Void
    const voidResult = await voidDispatchWithDb(db, sess, {
      ticketId,
      reason: 'Mistaken check-out',
    });
    expect(voidResult.ok).toBe(true);

    // Verify audit row
    const auditAfterVoid = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.entityType, 'dispatch_ticket'), eq(auditLog.entityId, ticketId)))
        .execute(),
    );
    expect(auditAfterVoid.length).toBe(2); // opened + voided
    const voidAudit = auditAfterVoid.find((r) => r.action === 'dispatch.voided');
    expect(voidAudit).toBeDefined();
    expect((voidAudit!.metadata as Record<string, unknown>)['reason']).toBe('Mistaken check-out');

    // Re-open should succeed (aircraft freed from partial-UNIQUE index)
    const reOpenResult = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 101,
      tachOut: 101,
    });
    expect(reOpenResult.ok).toBe(true);
    if (!reOpenResult.ok) return;
    expect(reOpenResult.ticket.status).toBe('open');
    expect(reOpenResult.ticket.hobbsOut).toBeCloseTo(101);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 8 — CLOSE DISPATCH (HAPPY + EDGE CASES)
// ════════════════════════════════════════════════════════════════════════════════

describe('HAPPY PATH: closeDispatch', () => {
  it('closes a ticket → status=closed, meters set, flightTimeHours derived, audit row written', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-CLOSE-HAPPY',
      tailNumber: 'NCLOSEHAPPY',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const openResult = await openDispatchWithDb(db, sess, {
      reservationId: rResult.reservation.id,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 500.3,
      tachOut: 420.1,
    });
    expect(openResult.ok).toBe(true);
    if (!openResult.ok) return;
    const ticketId = openResult.ticket.id;

    const hobbsIn = 501.8;
    const tachIn = 421.3;
    const expectedFlightTime = deriveFlightTime(500.3, hobbsIn);

    const closeResult = await closeDispatchWithDb(db, sess, {
      ticketId,
      hobbsIn,
      tachIn,
    });

    expect(closeResult.ok).toBe(true);
    if (!closeResult.ok) return;

    const closed = closeResult.ticket;
    expect(closed.status).toBe('closed');
    expect(closed.hobbsOut).toBeCloseTo(500.3);
    expect(closed.tachOut).toBeCloseTo(420.1);
    expect(closed.hobbsIn).toBeCloseTo(hobbsIn);
    expect(closed.tachIn).toBeCloseTo(tachIn);
    expect(closed.flightTimeHours).toBeCloseTo(expectedFlightTime);
    expect(closed.closedBy).toBe(userAId);
    expect(closed.closedAt).toBeInstanceOf(Date);

    // Verify audit row
    const audits = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.entityType, 'dispatch_ticket'), eq(auditLog.entityId, ticketId)))
        .execute(),
    );
    expect(audits.length).toBe(2); // opened + closed
    const closeAudit = audits.find((r) => r.action === 'dispatch.closed');
    expect(closeAudit).toBeDefined();
    const meta = closeAudit!.metadata as Record<string, unknown>;
    expect(meta['hobbsIn']).toBeCloseTo(hobbsIn);
    expect(meta['tachIn']).toBeCloseTo(tachIn);
    expect(meta['flightTimeHours']).toBeCloseTo(expectedFlightTime);
    expect(meta['basis']).toBe('hobbs');
  });

  it('ground check-out (hobbsIn === hobbsOut) → flightTimeHours = 0', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-GROUND',
      tailNumber: 'NGROUND',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const openResult = await openDispatchWithDb(db, sess, {
      reservationId: rResult.reservation.id,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 200.0,
      tachOut: 150.0,
    });
    expect(openResult.ok).toBe(true);
    if (!openResult.ok) return;

    const closeResult = await closeDispatchWithDb(db, sess, {
      ticketId: openResult.ticket.id,
      hobbsIn: 200.0, // equal to out → 0 hours
      tachIn: 150.5,
    });

    expect(closeResult.ok).toBe(true);
    if (!closeResult.ok) return;
    expect(closeResult.ticket.flightTimeHours).toBe(0);
  });
});

describe('EDGE CASE: closeDispatch in<out → ValidationError, stays open', () => {
  it('hobbsIn < hobbsOut → ValidationError, no write, ticket still open', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-IN-LT-OUT',
      tailNumber: 'NINLTOUT',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const openResult = await openDispatchWithDb(db, sess, {
      reservationId: rResult.reservation.id,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 300.0,
      tachOut: 200.0,
    });
    expect(openResult.ok).toBe(true);
    if (!openResult.ok) return;
    const ticketId = openResult.ticket.id;

    // hobbsIn < hobbsOut — should throw ValidationError
    await expect(
      closeDispatchWithDb(db, sess, {
        ticketId,
        hobbsIn: 299.5, // LESS THAN hobbsOut=300
        tachIn: 200.5,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Verify ticket is still open (no write happened)
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select({ status: dispatchTicket.status })
        .from(dispatchTicket)
        .where(eq(dispatchTicket.id, ticketId))
        .execute(),
    );
    expect(rows[0]?.status).toBe('open');
  });

  it('tachIn < tachOut → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-TACH-LT',
      tailNumber: 'NTACHLT',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const openResult = await openDispatchWithDb(db, sess, {
      reservationId: rResult.reservation.id,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 300.0,
      tachOut: 200.0,
    });
    expect(openResult.ok).toBe(true);
    if (!openResult.ok) return;

    await expect(
      closeDispatchWithDb(db, sess, {
        ticketId: openResult.ticket.id,
        hobbsIn: 300.5,
        tachIn: 199.5, // LESS THAN tachOut=200
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('EDGE CASE: re-close/re-void → not_open', () => {
  it('closeDispatch on already-closed ticket → not_open', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-RECLOSE',
      tailNumber: 'NRECLOSE',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const openResult = await openDispatchWithDb(db, sess, {
      reservationId: rResult.reservation.id,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 100,
      tachOut: 100,
    });
    expect(openResult.ok).toBe(true);
    if (!openResult.ok) return;
    const ticketId = openResult.ticket.id;

    // Close once
    const closeResult = await closeDispatchWithDb(db, sess, {
      ticketId,
      hobbsIn: 101,
      tachIn: 101,
    });
    expect(closeResult.ok).toBe(true);

    // Try to close again
    const reCloseResult = await closeDispatchWithDb(db, sess, {
      ticketId,
      hobbsIn: 102,
      tachIn: 102,
    });
    expect(reCloseResult.ok).toBe(false);
    if (!reCloseResult.ok) expect(reCloseResult.reason).toBe('not_open');
  });

  it('voidDispatch on already-voided ticket → not_open', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-REVOID',
      tailNumber: 'NREVOID',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const openResult = await openDispatchWithDb(db, sess, {
      reservationId: rResult.reservation.id,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 100,
      tachOut: 100,
    });
    expect(openResult.ok).toBe(true);
    if (!openResult.ok) return;

    const ticketId = openResult.ticket.id;

    // Void once
    await voidDispatchWithDb(db, sess, { ticketId, reason: 'first void' });

    // Void again
    const reVoidResult = await voidDispatchWithDb(db, sess, { ticketId, reason: 'second void' });
    expect(reVoidResult.ok).toBe(false);
    if (!reVoidResult.ok) expect(reVoidResult.reason).toBe('not_open');
  });

  it('voidDispatch on closed ticket → not_open', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-VOID-CLOSED',
      tailNumber: 'NVOIDCLOSED',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const openResult = await openDispatchWithDb(db, sess, {
      reservationId: rResult.reservation.id,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 100,
      tachOut: 100,
    });
    expect(openResult.ok).toBe(true);
    if (!openResult.ok) return;
    const ticketId = openResult.ticket.id;

    // Close
    await closeDispatchWithDb(db, sess, { ticketId, hobbsIn: 101, tachIn: 101 });

    // Void a closed ticket
    const voidResult = await voidDispatchWithDb(db, sess, { ticketId, reason: 'try void closed' });
    expect(voidResult.ok).toBe(false);
    if (!voidResult.ok) expect(voidResult.reason).toBe('not_open');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 9 — CONCURRENCY GUARD
// ════════════════════════════════════════════════════════════════════════════════

describe('CONCURRENCY GUARD: closeDispatch UPDATE WHERE status=open', () => {
  it('simulates concurrent close: first wins, second gets not_open', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-CONC-GUARD',
      tailNumber: 'NCONCGUARD',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const openResult = await openDispatchWithDb(db, sess, {
      reservationId: rResult.reservation.id,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 100,
      tachOut: 100,
    });
    expect(openResult.ok).toBe(true);
    if (!openResult.ok) return;
    const ticketId = openResult.ticket.id;

    // First close — succeeds
    const firstClose = await closeDispatchWithDb(db, sess, {
      ticketId,
      hobbsIn: 101,
      tachIn: 101,
    });
    expect(firstClose.ok).toBe(true);

    // Second close — ticket is now 'closed', UPDATE WHERE status='open' finds 0 rows → not_open
    const secondClose = await closeDispatchWithDb(db, sess, {
      ticketId,
      hobbsIn: 102,
      tachIn: 102,
    });
    expect(secondClose.ok).toBe(false);
    if (!secondClose.ok) expect(secondClose.reason).toBe('not_open');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 10 — RLS ISOLATION
// ════════════════════════════════════════════════════════════════════════════════

describe('RLS ISOLATION: cross-org ticket invisible', () => {
  it('closeDispatch on ticket in orgB using orgA session → not_found', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;

    // Create and open a ticket in org B
    const sessB = makeSession(orgBId, userBId, 'owner');
    const aircraftB = await createResourceWithDb(db, sessB, {
      kind: 'aircraft',
      displayName: 'N-RLS-B',
      tailNumber: 'NRLSB',
    });
    const rB = await createReservationWithDb(db, sessB, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraftB.id],
    });
    expect(rB.ok).toBe(true);
    if (!rB.ok) return;

    const openB = await openDispatchWithDb(db, sessB, {
      reservationId: rB.reservation.id,
      resourceId: aircraftB.id,
      pilotUserId: userBId,
      hobbsOut: 100,
      tachOut: 100,
    });
    expect(openB.ok).toBe(true);
    if (!openB.ok) return;
    const ticketBId = openB.ticket.id;

    // Try to close from org A — RLS blocks it
    const sessA = makeSession(orgAId, userAId, 'owner');
    const result = await closeDispatchWithDb(db, sessA, {
      ticketId: ticketBId,
      hobbsIn: 101,
      tachIn: 101,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('voidDispatch on ticket in orgB using orgA session → not_found', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;

    const sessB = makeSession(orgBId, userBId, 'owner');
    const aircraftB = await createResourceWithDb(db, sessB, {
      kind: 'aircraft',
      displayName: 'N-RLS-VOID-B',
      tailNumber: 'NRLSVOIODB',
    });
    const rB = await createReservationWithDb(db, sessB, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraftB.id],
    });
    expect(rB.ok).toBe(true);
    if (!rB.ok) return;

    const openB = await openDispatchWithDb(db, sessB, {
      reservationId: rB.reservation.id,
      resourceId: aircraftB.id,
      pilotUserId: userBId,
      hobbsOut: 100,
      tachOut: 100,
    });
    expect(openB.ok).toBe(true);
    if (!openB.ok) return;

    const sessA = makeSession(orgAId, userAId, 'owner');
    const result = await voidDispatchWithDb(db, sessA, {
      ticketId: openB.ticket.id,
      reason: 'Cross-org attack',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 11 — getDispatchForReservation READS
// ════════════════════════════════════════════════════════════════════════════════

describe('READS: getDispatchForReservation', () => {
  it('returns null for reservation with no ticket', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-READ-NONE',
      tailNumber: 'NREADNONE',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const map = await getDispatchForReservationWithDb(db, sess, {
      reservationIds: [rResult.reservation.id],
    });

    expect(map.size).toBe(1);
    expect(map.get(rResult.reservation.id)).toBeNull();
  });

  it('returns the open ticket for a reservation with an open dispatch', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-READ-OPEN',
      tailNumber: 'NREADOPEN',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const openResult = await openDispatchWithDb(db, sess, {
      reservationId: rResult.reservation.id,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 100,
      tachOut: 100,
    });
    expect(openResult.ok).toBe(true);
    if (!openResult.ok) return;

    const map = await getDispatchForReservationWithDb(db, sess, {
      reservationIds: [rResult.reservation.id],
    });

    const ticket = map.get(rResult.reservation.id);
    expect(ticket).not.toBeNull();
    expect(ticket?.status).toBe('open');
    expect(ticket?.id).toBe(openResult.ticket.id);
  });

  it('voided ticket is excluded (returns null)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-READ-VOID',
      tailNumber: 'NREADVOID',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const openResult = await openDispatchWithDb(db, sess, {
      reservationId: rResult.reservation.id,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 100,
      tachOut: 100,
    });
    expect(openResult.ok).toBe(true);
    if (!openResult.ok) return;

    await voidDispatchWithDb(db, sess, {
      ticketId: openResult.ticket.id,
      reason: 'Test void',
    });

    const map = await getDispatchForReservationWithDb(db, sess, {
      reservationIds: [rResult.reservation.id],
    });

    // Voided ticket excluded → null
    expect(map.get(rResult.reservation.id)).toBeNull();
  });

  it('mixed bag: some reservations have tickets, some do not', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft1 = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-MIX-1',
      tailNumber: 'NMIX1',
    });
    const aircraft2 = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-MIX-2',
      tailNumber: 'NMIX2',
    });

    const r1 = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft1.id],
    });
    const r2 = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft2.id],
    });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    // Open dispatch only on r1
    const openR1 = await openDispatchWithDb(db, sess, {
      reservationId: r1.reservation.id,
      resourceId: aircraft1.id,
      pilotUserId: userAId,
      hobbsOut: 100,
      tachOut: 100,
    });
    expect(openR1.ok).toBe(true);

    const map = await getDispatchForReservationWithDb(db, sess, {
      reservationIds: [r1.reservation.id, r2.reservation.id],
    });

    expect(map.size).toBe(2);
    expect(map.get(r1.reservation.id)?.status).toBe('open');
    expect(map.get(r2.reservation.id)).toBeNull();
  });

  it('RLS: orgB reservations not returned in orgA session', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;

    // Create reservation + open ticket in org B
    const sessB = makeSession(orgBId, userBId, 'owner');
    const aircraftB = await createResourceWithDb(db, sessB, {
      kind: 'aircraft',
      displayName: 'N-RLS-READ-B',
      tailNumber: 'NRLSREADB',
    });
    const rB = await createReservationWithDb(db, sessB, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraftB.id],
    });
    expect(rB.ok).toBe(true);
    if (!rB.ok) return;

    await openDispatchWithDb(db, sessB, {
      reservationId: rB.reservation.id,
      resourceId: aircraftB.id,
      pilotUserId: userBId,
      hobbsOut: 100,
      tachOut: 100,
    });

    // Query from org A with orgB's reservation id
    const sessA = makeSession(orgAId, userAId, 'owner');
    const map = await getDispatchForReservationWithDb(db, sessA, {
      reservationIds: [rB.reservation.id],
    });

    // RLS: org B's ticket is invisible from org A session
    expect(map.get(rB.reservation.id)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 12 — AUDIT INVARIANTS
// ════════════════════════════════════════════════════════════════════════════════

describe('AUDIT INVARIANTS', () => {
  it('refused openDispatch (not_found) writes NO audit row', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const auditBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(eq(auditLog.action, 'dispatch.opened'))
        .execute(),
    );

    await openDispatchWithDb(db, sess, {
      reservationId: '00000000-0000-0000-0000-000000000001',
      resourceId:    '00000000-0000-0000-0000-000000000002',
      pilotUserId:   userAId,
      hobbsOut: 100,
      tachOut: 100,
    }); // returns not_found

    const auditAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(eq(auditLog.action, 'dispatch.opened'))
        .execute(),
    );
    expect(auditAfter.length).toBe(auditBefore.length); // no new rows
  });

  it('refused closeDispatch (not_open) writes NO audit row', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-AUDIT-REFUSE',
      tailNumber: 'NAUDITREFUSE',
    });
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(rResult.ok).toBe(true);
    if (!rResult.ok) return;

    const openResult = await openDispatchWithDb(db, sess, {
      reservationId: rResult.reservation.id,
      resourceId: aircraft.id,
      pilotUserId: userAId,
      hobbsOut: 100,
      tachOut: 100,
    });
    expect(openResult.ok).toBe(true);
    if (!openResult.ok) return;
    const ticketId = openResult.ticket.id;

    // Close first
    await closeDispatchWithDb(db, sess, { ticketId, hobbsIn: 101, tachIn: 101 });

    const auditBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.entityType, 'dispatch_ticket'), eq(auditLog.entityId, ticketId)))
        .execute(),
    );
    expect(auditBefore.length).toBe(2); // opened + closed

    // Re-close: should return not_open, no new audit row
    await closeDispatchWithDb(db, sess, { ticketId, hobbsIn: 102, tachIn: 102 });

    const auditAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.entityType, 'dispatch_ticket'), eq(auditLog.entityId, ticketId)))
        .execute(),
    );
    expect(auditAfter.length).toBe(2); // unchanged
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 13 — deriveFlightTime integration (Hobbs derivation correctness)
// ════════════════════════════════════════════════════════════════════════════════

describe('FLIGHT TIME DERIVATION: closeDispatch uses deriveFlightTime', () => {
  it('flight_time_hours matches deriveFlightTime(hobbsOut, hobbsIn) for various pairs', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const pairs: [number, number][] = [
      [100.0, 101.5],   // 1.5h
      [999.9, 1001.2],  // 1.3h
      [0.0, 0.1],       // 0.1h
      [500.5, 500.5],   // 0.0h (ground)
    ];

    for (const [hobbsOut, hobbsIn] of pairs) {
      const aircraft = await createResourceWithDb(db, sess, {
        kind: 'aircraft',
        displayName: `N-DERIVE-${hobbsOut}`,
        tailNumber: `ND${Math.round(hobbsOut * 10)}`,
      });
      const rResult = await createReservationWithDb(db, sess, {
        startAt: T.W1_start,
        endAt: T.W1_end,
        resourceIds: [aircraft.id],
      });
      expect(rResult.ok).toBe(true);
      if (!rResult.ok) continue;

      const openResult = await openDispatchWithDb(db, sess, {
        reservationId: rResult.reservation.id,
        resourceId: aircraft.id,
        pilotUserId: userAId,
        hobbsOut,
        tachOut: hobbsOut,
      });
      expect(openResult.ok).toBe(true);
      if (!openResult.ok) continue;

      const closeResult = await closeDispatchWithDb(db, sess, {
        ticketId: openResult.ticket.id,
        hobbsIn,
        tachIn: hobbsIn,
      });
      expect(closeResult.ok).toBe(true);
      if (!closeResult.ok) continue;

      const expected = deriveFlightTime(hobbsOut, hobbsIn);
      expect(closeResult.ticket.flightTimeHours).toBeCloseTo(expected, 1);
    }
  });
});
