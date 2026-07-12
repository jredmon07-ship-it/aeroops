/**
 * invoiceable-dispatch.test.ts — API integration tests for the
 * "flights ready to invoice" worklist (listInvoiceableDispatch).
 *
 * COVERAGE:
 *   CAP    — null → UnauthenticatedError; accountant (billing:access, no
 *            billing:manage) / dispatcher / cfi → ForbiddenError; owner → array.
 *   happy  — a CLOSED ticket appears with tail/pilot/flightTimeHours/closedAt.
 *   filter — an OPEN ticket does NOT appear (only closed).
 *   filter — a ticket that ALREADY has a (non-void) invoice is EXCLUDED
 *            (the already-invoiced case, so it can't be double-invoiced).
 *   T-ISO  — a closed ticket in orgA is invisible to orgB's worklist.
 *
 * Migrations 0000–0019 (0019 = invoice + rate_schedule tables).
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
import { listInvoiceableDispatchWithDb } from '../billing/list-invoiceable-dispatch.js';

import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0038 (shared loader — replaces the old hand list).
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

async function seedAircraftAndReservation(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tailPrefix: string,
): Promise<{ aircraftId: string; reservationId: string; tail: string }> {
  const sess = makeSession(orgId, userId, 'owner');
  const tail = nextTail(tailPrefix);
  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `Test ${tail}`,
    tailNumber: `N${tail}`,
  });
  const rResult = await createReservationWithDb(db, sess, {
    startAt: SLOT_START,
    endAt: SLOT_END,
    resourceIds: [aircraft.id],
  });
  if (!rResult.ok) throw new Error(`seed reservation failed: ${rResult.reason}`);
  return { aircraftId: aircraft.id, reservationId: rResult.reservation.id, tail: `N${tail}` };
}

async function seedClosedTicket(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  aircraftId: string,
  reservationId: string,
): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const openR = await openDispatchWithDb(db, sess, {
    reservationId,
    resourceId: aircraftId,
    pilotUserId: userId,
    hobbsOut: 100.0,
    tachOut: 50.0,
  });
  if (!openR.ok) throw new Error(`openDispatch failed: ${openR.reason}`);
  const closeR = await closeDispatchWithDb(db, sess, {
    ticketId: openR.ticket.id,
    hobbsIn: 101.5,
    tachIn: 51.5,
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
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };
}, 120_000);

// ── CAP gate ────────────────────────────────────────────────────────────────────

describe('listInvoiceableDispatch — billing:manage gate', () => {
  it('null session → UnauthenticatedError', async () => {
    await expect(listInvoiceableDispatchWithDb(env.db, null)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('accountant (billing:access, NOT billing:manage) → ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(listInvoiceableDispatchWithDb(env.db, sess)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('dispatcher (no billing caps) → ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(listInvoiceableDispatchWithDb(env.db, sess)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('cfi → ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'cfi');
    await expect(listInvoiceableDispatchWithDb(env.db, sess)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('owner (billing:manage) → array', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const rows = await listInvoiceableDispatchWithDb(env.db, sess);
    expect(Array.isArray(rows)).toBe(true);
  });
});

// ── behaviour ─────────────────────────────────────────────────────────────────

describe('listInvoiceableDispatch — behaviour', () => {
  it('a CLOSED ticket appears with tail/pilot/flight-time/closedAt', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId, tail } = await seedAircraftAndReservation(
      db,
      orgAId,
      userAId,
      'RDY',
    );
    const ticketId = await seedClosedTicket(db, orgAId, userAId, aircraftId, reservationId);

    const rows = await listInvoiceableDispatchWithDb(db, sess);
    const found = rows.find((r) => r.dispatchTicketId === ticketId);
    expect(found).toBeDefined();
    expect(found!.tailNumber).toBe(tail);
    expect(found!.pilotUserId).toBe(userAId);
    expect(found!.flightTimeHours).toBeCloseTo(1.5, 2); // 101.5 - 100.0
    expect(found!.closedAt).toBeInstanceOf(Date);
  });

  it('an OPEN ticket does NOT appear (closed-only)', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db,
      orgAId,
      userAId,
      'OPN',
    );
    const openR = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 200.0,
      tachOut: 100.0,
    });
    if (!openR.ok) throw new Error('openDispatch failed');

    const rows = await listInvoiceableDispatchWithDb(db, sess);
    expect(rows.find((r) => r.dispatchTicketId === openR.ticket.id)).toBeUndefined();
  });

  it('a ticket that ALREADY has an invoice is EXCLUDED (no double-invoice)', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db,
      orgAId,
      userAId,
      'INV',
    );
    const ticketId = await seedClosedTicket(db, orgAId, userAId, aircraftId, reservationId);

    // Present before invoicing.
    const before = await listInvoiceableDispatchWithDb(db, sess);
    expect(before.find((r) => r.dispatchTicketId === ticketId)).toBeDefined();

    // Generate a DRAFT invoice from it.
    const rateR = await createRateScheduleWithDb(db, sess, {
      name: 'Wet hourly',
      rateKind: 'wet_hourly',
      amountCents: 15000,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    if (!rateR.ok) throw new Error('createRateSchedule failed');
    const invR = await generateInvoiceFromDispatchWithDb(db, sess, {
      dispatchTicketId: ticketId,
      rateScheduleId: rateR.rate.id,
      memberUserId: userAId,
    });
    expect(invR.ok).toBe(true);

    // Now excluded from the worklist.
    const after = await listInvoiceableDispatchWithDb(db, sess);
    expect(after.find((r) => r.dispatchTicketId === ticketId)).toBeUndefined();
  });

  it('tenant isolation: a closed ticket in orgA is invisible to orgB', async () => {
    const { db, orgAId, userAId, orgBId, userBId } = env;
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db,
      orgAId,
      userAId,
      'ISO',
    );
    const ticketId = await seedClosedTicket(db, orgAId, userAId, aircraftId, reservationId);

    const orgBRows = await listInvoiceableDispatchWithDb(
      db,
      makeSession(orgBId, userBId, 'owner'),
    );
    expect(orgBRows.find((r) => r.dispatchTicketId === ticketId)).toBeUndefined();
  });
});
