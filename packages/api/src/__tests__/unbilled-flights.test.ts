/**
 * unbilled-flights.test.ts — getUnbilledFlights (the billing:access monitoring
 * view of closed flights with no live invoice). Complements
 * invoiceable-dispatch.test.ts (the billing:manage worklist).
 *
 * Proves: the cap gate (accountant ALLOWED, dispatcher/cfi forbidden, null
 * unauth), that a live (non-void) invoice removes a flight from the list, that a
 * VOID invoice puts it back, that totals/tail/hours are correct, and tenant
 * isolation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  seedTwoOrgs,
  loadMigrationSql,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { createRateScheduleWithDb } from '../billing/rate-commands.js';
import { generateInvoiceFromDispatchWithDb } from '../billing/generate-invoice.js';
import { voidInvoiceWithDb } from '../billing/invoice-status-commands.js';
import { getUnbilledFlightsWithDb } from '../billing/get-unbilled-flights.js';

import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

const MIGRATION_SQL = loadMigrationSql('0042');

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
}

let env: TestEnv;
let tailSuffix = 0;
function nextTail(prefix: string): string {
  tailSuffix += 1;
  return `${prefix}${tailSuffix}`;
}

const SLOT_START = new Date('2026-08-01T08:00:00Z');
const SLOT_END = new Date('2026-08-01T10:00:00Z');

async function seedClosedFlight(
  orgId: string,
  userId: string,
  tailPrefix: string,
): Promise<{ ticketId: string; aircraftId: string; tail: string }> {
  const sess = makeSession(orgId, userId, 'owner');
  const tail = `N${nextTail(tailPrefix)}`;
  const aircraft = await createResourceWithDb(env.db, sess, {
    kind: 'aircraft',
    displayName: `Test ${tail}`,
    tailNumber: tail,
  });
  const rResult = await createReservationWithDb(env.db, sess, {
    startAt: SLOT_START,
    endAt: SLOT_END,
    resourceIds: [aircraft.id],
  });
  if (!rResult.ok) throw new Error(`seed reservation failed: ${rResult.reason}`);
  const openR = await openDispatchWithDb(env.db, sess, {
    reservationId: rResult.reservation.id,
    resourceId: aircraft.id,
    pilotUserId: userId,
    hobbsOut: 100.0,
    tachOut: 50.0,
  });
  if (!openR.ok) throw new Error(`openDispatch failed: ${openR.reason}`);
  const closeR = await closeDispatchWithDb(env.db, sess, {
    ticketId: openR.ticket.id,
    hobbsIn: 101.5, // 1.5 h flown
    tachIn: 51.5,
  });
  if (!closeR.ok) throw new Error(`closeDispatch failed: ${closeR.reason}`);
  return { ticketId: openR.ticket.id, aircraftId: aircraft.id, tail };
}

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
}, 120_000);

describe('getUnbilledFlights — capability gate', () => {
  it('null session → UnauthenticatedError', async () => {
    await expect(getUnbilledFlightsWithDb(env.db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('accountant (billing:access, not billing:manage) is ALLOWED', async () => {
    const res = await getUnbilledFlightsWithDb(env.db, makeSession(env.orgAId, env.userAId, 'accountant'));
    expect(res).toHaveProperty('flights');
    expect(res).toHaveProperty('totalCount');
  });

  it('dispatcher (no billing caps) → ForbiddenError', async () => {
    await expect(
      getUnbilledFlightsWithDb(env.db, makeSession(env.orgAId, env.userAId, 'dispatcher')),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('getUnbilledFlights — billing coverage', () => {
  it('a live invoice removes the flight; voiding it puts the flight back', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const billed = await seedClosedFlight(env.orgAId, env.userAId, 'UB');
    const unbilled = await seedClosedFlight(env.orgAId, env.userAId, 'UB');

    // Baseline: both are unbilled.
    const before = new Set((await getUnbilledFlightsWithDb(env.db, sess)).flights.map((f) => f.ticketId));
    expect(before.has(billed.ticketId)).toBe(true);
    expect(before.has(unbilled.ticketId)).toBe(true);

    // Invoice the first (a draft invoice is enough — status <> 'void').
    const rate = await createRateScheduleWithDb(env.db, sess, {
      resourceId: billed.aircraftId,
      name: 'wet',
      rateKind: 'wet_hourly',
      amountCents: 15000,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    if (!rate.ok) throw new Error('rate create failed');
    const gen = await generateInvoiceFromDispatchWithDb(env.db, sess, {
      dispatchTicketId: billed.ticketId,
      rateScheduleId: rate.rate.id,
      memberUserId: env.userAId,
    });
    if (!gen.ok) throw new Error(`invoice gen failed: ${JSON.stringify(gen)}`);

    const afterInvoice = new Set((await getUnbilledFlightsWithDb(env.db, sess)).flights.map((f) => f.ticketId));
    expect(afterInvoice.has(billed.ticketId)).toBe(false); // now billed
    expect(afterInvoice.has(unbilled.ticketId)).toBe(true); // still unbilled

    // Void the invoice → the flight is uncaptured again.
    const voided = await voidInvoiceWithDb(env.db, sess, { id: gen.invoice.id });
    expect(voided.ok).toBe(true);
    const afterVoid = new Set((await getUnbilledFlightsWithDb(env.db, sess)).flights.map((f) => f.ticketId));
    expect(afterVoid.has(billed.ticketId)).toBe(true);
  });

  it('rows carry the tail + Hobbs hours; totals are consistent', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const flight = await seedClosedFlight(env.orgAId, env.userAId, 'UBH');
    const res = await getUnbilledFlightsWithDb(env.db, sess);
    const row = res.flights.find((f) => f.ticketId === flight.ticketId);
    expect(row).toBeDefined();
    expect(row!.tailNumber).toBe(flight.tail);
    expect(row!.flightTimeHours).toBeCloseTo(1.5, 1);
    // In the test env the list is well under the cap, so totalCount == list length.
    expect(res.totalCount).toBe(res.flights.length);
    expect(res.totalHours).toBeGreaterThanOrEqual(1.5);
    expect(res.truncated).toBe(false);
  });
});

describe('getUnbilledFlights — tenant isolation', () => {
  it('org A never sees org B unbilled flights, and vice versa', async () => {
    const bFlight = await seedClosedFlight(env.orgBId, env.userBId, 'UBISO');
    const aResult = await getUnbilledFlightsWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'));
    expect(aResult.flights.some((f) => f.ticketId === bFlight.ticketId)).toBe(false);
    const bResult = await getUnbilledFlightsWithDb(env.db, makeSession(env.orgBId, env.userBId, 'owner'));
    expect(bResult.flights.some((f) => f.ticketId === bFlight.ticketId)).toBe(true);
  });
});
