/**
 * dispatch-meter-correction.test.ts — Integration tests for the append-only
 * dispatch meter correction (dispatch_ticket_correction, migration 0018) and
 * the effective-meter read (latest correction ?? original).
 *
 * Uses PGlite + WithDb functions. Two-org seed.
 *
 * COVERAGE:
 *   CAPS: dispatch:create required for meter correction
 *   EFFECTIVE METER: no correction → original; with correction → latest
 *   CORRECTION: append + audit; closed-ticket required; validation
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  auditLog,
  loadMigrationSql,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { getEffectiveMeter } from '../dispatch/effective-meter.js';
import { correctDispatchMeterWithDb } from '../dispatch/correct-dispatch-meter.js';
import { ValidationError } from '../scheduling/internal.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0042 (shared loader).
const MIGRATION_SQL = loadMigrationSql('0042');

// ── Shared test environment ───────────────────────────────────────────────────

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

// Future date slots that avoid booking-policy lead-time violations.
const SLOT1_START = new Date('2026-08-01T08:00:00Z');
const SLOT1_END   = new Date('2026-08-01T10:00:00Z');
const SLOT2_START = new Date('2026-08-01T12:00:00Z');
const SLOT2_END   = new Date('2026-08-01T14:00:00Z');

let env: TestEnv;

/** A running counter suffix so tail numbers never collide across tests. */
let tailSuffix = 0;
function nextTail(prefix: string): string {
  tailSuffix += 1;
  return `${prefix}${tailSuffix}`;
}

/** Create aircraft + reservation in the given org. */
async function seedAircraftAndReservation(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tailPrefix: string,
  start = SLOT1_START,
  end   = SLOT1_END,
): Promise<{ aircraftId: string; reservationId: string }> {
  const sess = makeSession(orgId, userId, 'owner');
  const tail = nextTail(tailPrefix); // single increment per call
  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `Test ${tail}`,
    tailNumber: `N${tail}`,
  });
  const rResult = await createReservationWithDb(db, sess, {
    startAt:     start,
    endAt:       end,
    resourceIds: [aircraft.id],
  });
  if (!rResult.ok) throw new Error(`seedAircraftAndReservation failed: ${rResult.reason}`);
  return { aircraftId: aircraft.id, reservationId: rResult.reservation.id };
}

/** Open + close a dispatch ticket. Returns ticketId. */
async function seedClosedTicket(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  aircraftId: string,
  reservationId: string,
  hobbsOut = 100.0,
  tachOut  = 50.0,
  hobbsIn  = 101.5,
  tachIn   = 51.5,
): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const openR = await openDispatchWithDb(db, sess, {
    reservationId,
    resourceId:  aircraftId,
    pilotUserId: userId,
    hobbsOut,
    tachOut,
  });
  if (!openR.ok) throw new Error(`openDispatch failed: ${openR.reason}`);

  const closeR = await closeDispatchWithDb(db, sess, {
    ticketId: openR.ticket.id,
    hobbsIn,
    tachIn,
  });
  if (!closeR.ok) throw new Error(`closeDispatch failed: ${closeR.reason}`);
  return closeR.ticket.id;
}

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });
  env = {
    db,
    pglite,
    orgAId:  seed.orgAId,
    orgBId:  seed.orgBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };
}, 120_000);

describe('CAPS: dispatch:create required for meter correction', () => {
  it('renter lacks dispatch:create → ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(
      correctDispatchMeterWithDb(env.db, sess, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000001',
        correctedHobbs: 100.5,
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('accountant lacks dispatch:create → ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      correctDispatchMeterWithDb(env.db, sess, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000001',
        correctedHobbs: 100.5,
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('mechanic lacks dispatch:create → ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'mechanic');
    await expect(
      correctDispatchMeterWithDb(env.db, sess, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000001',
        correctedHobbs: 100.5,
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1 — EFFECTIVE METER
// ════════════════════════════════════════════════════════════════════════════════

describe('EFFECTIVE METER: no correction → original _in values', () => {
  it('returns original hobbs/tach/flightTimeHours when no correction exists', async () => {
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      env.db, env.orgAId, env.userAId, 'EM',
    );
    const ticketId = await seedClosedTicket(
      env.db, env.orgAId, env.userAId, aircraftId, reservationId,
      100.0, 50.0, 101.5, 51.5,
    );

    const result = await withOrgContext(env.db, env.orgAId, (tx) =>
      getEffectiveMeter(tx, ticketId),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effectiveHobbsIn).toBeCloseTo(101.5, 5);
    expect(result.effectiveTachIn).toBeCloseTo(51.5, 5);
    expect(result.flightTimeHours).toBeCloseTo(1.5, 5);
    expect(result.correctionApplied).toBe(false);
  });

  it('not_found for unknown ticketId', async () => {
    const result = await withOrgContext(env.db, env.orgAId, (tx) =>
      getEffectiveMeter(tx, '00000000-0000-0000-0000-000000000099'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('not_closed for an open ticket', async () => {
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      env.db, env.orgAId, env.userAId, 'EM', SLOT2_START, SLOT2_END,
    );
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const openR = await openDispatchWithDb(env.db, sess, {
      reservationId,
      resourceId:  aircraftId,
      pilotUserId: env.userAId,
      hobbsOut: 200.0,
      tachOut:  100.0,
    });
    if (!openR.ok) throw new Error('seed openDispatch failed');

    const result = await withOrgContext(env.db, env.orgAId, (tx) =>
      getEffectiveMeter(tx, openR.ticket.id),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_closed');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2 — CORRECTION COMMAND
// ════════════════════════════════════════════════════════════════════════════════

describe('CORRECTION COMMAND: correctDispatchMeter', () => {
  let baseTicketId: string;

  beforeAll(async () => {
    const setup = await seedAircraftAndReservation(
      env.db, env.orgAId, env.userAId, 'CORR',
    );
    baseTicketId = await seedClosedTicket(
      env.db, env.orgAId, env.userAId, setup.aircraftId, setup.reservationId,
      100.0, 50.0, 101.5, 51.5,
    );
  }, 30_000);

  it('appends a correction row and writes ONE audit row dispatch.meter_corrected', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await correctDispatchMeterWithDb(env.db, sess, {
      dispatchTicketId: baseTicketId,
      correctedHobbs:   101.8,
      reason:           'Meter misread at check-in',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.correction.correctedHobbs).toBeCloseTo(101.8, 5);
    expect(result.correction.correctedTach).toBeNull();
    expect(result.correction.reason).toBe('Meter misread at check-in');
    expect(result.correction.dispatchTicketId).toBe(baseTicketId);

    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog).where(
        and(
          eq(auditLog.action, 'dispatch.meter_corrected'),
          eq(auditLog.entityId, baseTicketId),
        ),
      ).execute(),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0]!.entityType).toBe('dispatch_ticket');
  });

  it('effective meter uses the latest correction (hobbs updated)', async () => {
    // correction from previous test → hobbs=101.8; tach unchanged
    const result = await withOrgContext(env.db, env.orgAId, (tx) =>
      getEffectiveMeter(tx, baseTicketId),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effectiveHobbsIn).toBeCloseTo(101.8, 5);
    expect(result.effectiveTachIn).toBeCloseTo(51.5, 5); // unchanged
    expect(result.correctionApplied).toBe(true);
  });

  it('second correction overwrites first (latest wins)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await correctDispatchMeterWithDb(env.db, sess, {
      dispatchTicketId: baseTicketId,
      correctedHobbs:   102.0,
      reason:           'Revised — actual meter was 102.0',
    });
    const result = await withOrgContext(env.db, env.orgAId, (tx) =>
      getEffectiveMeter(tx, baseTicketId),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effectiveHobbsIn).toBeCloseTo(102.0, 5);
  });

  it('hobbs-only correction → tach stays at original', async () => {
    const setup = await seedAircraftAndReservation(
      env.db, env.orgAId, env.userAId, 'CORR',
    );
    const tId = await seedClosedTicket(
      env.db, env.orgAId, env.userAId, setup.aircraftId, setup.reservationId,
      200.0, 80.0, 201.5, 81.5,
    );
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await correctDispatchMeterWithDb(env.db, sess, {
      dispatchTicketId: tId,
      correctedHobbs: 201.9,
      reason: 'Hobbs only',
    });
    const result = await withOrgContext(env.db, env.orgAId, (tx) =>
      getEffectiveMeter(tx, tId),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effectiveHobbsIn).toBeCloseTo(201.9, 5);
    expect(result.effectiveTachIn).toBeCloseTo(81.5, 5); // unchanged
  });

  it('open ticket → not_closed', async () => {
    const setup = await seedAircraftAndReservation(
      env.db, env.orgAId, env.userAId, 'CORR',
    );
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const openR = await openDispatchWithDb(env.db, sess, {
      reservationId: setup.reservationId,
      resourceId:    setup.aircraftId,
      pilotUserId:   env.userAId,
      hobbsOut: 300.0, tachOut: 150.0,
    });
    if (!openR.ok) throw new Error('seed open failed');

    const result = await correctDispatchMeterWithDb(env.db, sess, {
      dispatchTicketId: openR.ticket.id,
      correctedHobbs:   300.5,
      reason:           'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_closed');
  });

  it('unknown ticketId → not_found', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await correctDispatchMeterWithDb(env.db, sess, {
      dispatchTicketId: '00000000-0000-0000-0000-000000000099',
      correctedHobbs: 100.0,
      reason: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('no meter provided → ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      correctDispatchMeterWithDb(env.db, sess, {
        dispatchTicketId: baseTicketId,
        reason: 'forgot meter',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('empty reason → ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      correctDispatchMeterWithDb(env.db, sess, {
        dispatchTicketId: baseTicketId,
        correctedHobbs: 101.0,
        reason: '',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('dispatcher (has dispatch:create) can correct meters', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    const result = await correctDispatchMeterWithDb(env.db, sess, {
      dispatchTicketId: baseTicketId,
      correctedHobbs:   102.1,
      reason:           'Dispatcher correction',
    });
    expect(result.ok).toBe(true);
  });
});
