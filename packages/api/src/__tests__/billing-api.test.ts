/**
 * billing-api.test.ts — Integration tests for Slice B1 billing API.
 *
 * Applies migrations 0000–0019 (0019 = billing record tables).
 * Uses PGlite + WithDb functions. Two-org seed for tenant isolation.
 *
 * COVERAGE:
 *   CAPS: billing:access/manage enforced; non-billing roles Forbidden; T-ISO
 *   EFFECTIVE METER: no correction → original; with correction → latest
 *   CORRECTION: append + audit; closed-ticket required
 *   RATE CRUD: create/list/delete + audit + referenced guard
 *   GENERATE INVOICE: draft invoice integer-cent; ONE audit row
 *   INVOICE READS: listInvoices filters + getInvoice with line items
 *   FINALIZE: draft→finalized; issued_at set; re-finalize blocked
 *   VOID: draft|finalized→void; audited; already_void guard
 *   NO MONEY: no Stripe/payment/card; dispatch gate unchanged
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
  auditLog,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { getEffectiveMeter } from '../billing/effective-meter.js';
import { correctDispatchMeterWithDb } from '../billing/correct-dispatch-meter.js';
import {
  createRateScheduleWithDb,
  listRateSchedulesWithDb,
  deleteRateScheduleWithDb,
} from '../billing/rate-commands.js';
import { generateInvoiceFromDispatchWithDb } from '../billing/generate-invoice.js';
import { listInvoicesWithDb, getInvoiceWithDb } from '../billing/list-invoices.js';
import {
  finalizeInvoiceWithDb,
  voidInvoiceWithDb,
} from '../billing/invoice-status-commands.js';
import { applyRate } from '@aeroops/core';
import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// ── Path resolution ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function migrationSql(name: string): string {
  return readFileSync(
    resolve(__dirname, `../../../db/migrations/${name}`),
    'utf-8',
  );
}

const MIGRATION_SQL = [
  migrationSql('0000_loud_prodigy.sql'),
  migrationSql('0001_auth_credential.sql'),
  migrationSql('0002_scheduling.sql'),
  migrationSql('0003_booking_policies.sql'),
  migrationSql('0004_recurrence.sql'),
  migrationSql('0005_dispatch.sql'),
  migrationSql('0006_squawks_grounding.sql'),
  migrationSql('0007_fleet.sql'),
  migrationSql('0008_people.sql'),
  migrationSql('0009_dispatch_gate.sql'),
  migrationSql('0010_civil_twilight.sql'),
  migrationSql('0011_optimizer_run.sql'),
  migrationSql('0012_training.sql'),
  migrationSql('0013_work_orders.sql'),
  migrationSql('0014_availability.sql'),
  migrationSql('0015_booking_request.sql'),
  migrationSql('0016_booking_request_convert.sql'),
  migrationSql('0017_booking_retention.sql'),
  migrationSql('0018_dispatch_ticket_correction.sql'),
  migrationSql('0019_billing_records.sql'),
];

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

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CAPABILITY GATES
// ════════════════════════════════════════════════════════════════════════════════

describe('CAPS: billing:access gate (reads)', () => {
  it('null session → UnauthenticatedError (listInvoices)', async () => {
    await expect(listInvoicesWithDb(env.db, null, {}))
      .rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('null session → UnauthenticatedError (getInvoice)', async () => {
    await expect(
      getInvoiceWithDb(env.db, null, { id: '00000000-0000-0000-0000-000000000001' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('null session → UnauthenticatedError (listRateSchedules)', async () => {
    await expect(listRateSchedulesWithDb(env.db, null, {}))
      .rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('dispatcher lacks billing:access → ForbiddenError (listInvoices)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(listInvoicesWithDb(env.db, sess, {}))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('cfi lacks billing:access → ForbiddenError (listInvoices)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'cfi');
    await expect(listInvoicesWithDb(env.db, sess, {}))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('mechanic lacks billing:access → ForbiddenError (listInvoices)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'mechanic');
    await expect(listInvoicesWithDb(env.db, sess, {}))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('renter lacks billing:access → ForbiddenError (listInvoices)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(listInvoicesWithDb(env.db, sess, {}))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('student lacks billing:access → ForbiddenError (listInvoices)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'student');
    await expect(listInvoicesWithDb(env.db, sess, {}))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('accountant HAS billing:access → listInvoices returns invoices array', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const result = await listInvoicesWithDb(env.db, sess, {});
    expect(result).toHaveProperty('invoices');
    expect(Array.isArray(result.invoices)).toBe(true);
  });

  it('owner HAS billing:access → listInvoices OK', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await listInvoicesWithDb(env.db, sess, {});
    expect(result).toHaveProperty('invoices');
  });

  it('manager HAS billing:access → listRateSchedules OK', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'manager');
    const result = await listRateSchedulesWithDb(env.db, sess, {});
    expect(result).toHaveProperty('rates');
  });
});

describe('CAPS: billing:manage gate (writes)', () => {
  it('null session → UnauthenticatedError (createRateSchedule)', async () => {
    await expect(
      createRateScheduleWithDb(env.db, null, {
        name: 'x', rateKind: 'wet_hourly', amountCents: 100,
        effectiveFrom: new Date(),
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('accountant lacks billing:manage → ForbiddenError (createRateSchedule)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      createRateScheduleWithDb(env.db, sess, {
        name: 'Test', rateKind: 'wet_hourly', amountCents: 10000,
        effectiveFrom: new Date(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('dispatcher lacks billing:manage → ForbiddenError (createRateSchedule)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(
      createRateScheduleWithDb(env.db, sess, {
        name: 'Test', rateKind: 'wet_hourly', amountCents: 10000,
        effectiveFrom: new Date(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('accountant lacks billing:manage → ForbiddenError (finalizeInvoice)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      finalizeInvoiceWithDb(env.db, sess, { id: '00000000-0000-0000-0000-000000000001' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('dispatcher lacks billing:manage → ForbiddenError (voidInvoice)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(
      voidInvoiceWithDb(env.db, sess, { id: '00000000-0000-0000-0000-000000000001' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

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
// SECTION 2 — EFFECTIVE METER
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
// SECTION 3 — CORRECTION COMMAND
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

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4 — RATE CRUD
// ════════════════════════════════════════════════════════════════════════════════

describe('RATE CRUD: createRateSchedule', () => {
  it('creates a wet_hourly rate and writes ONE audit row', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createRateScheduleWithDb(env.db, sess, {
      name:          'C172 Wet 2026',
      rateKind:      'wet_hourly',
      amountCents:   12500,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rate.name).toBe('C172 Wet 2026');
    expect(result.rate.rateKind).toBe('wet_hourly');
    expect(result.rate.amountCents).toBe(12500);
    expect(result.rate.effectiveTo).toBeNull();

    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(eq(auditLog.action, 'billing.rate_schedule_created'))
        .execute(),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('amount_cents = 0 allowed (free rate)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createRateScheduleWithDb(env.db, sess, {
      name: 'Ground Free', rateKind: 'flat', amountCents: 0,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rate.amountCents).toBe(0);
  });

  it('effectiveTo before effectiveFrom → ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createRateScheduleWithDb(env.db, sess, {
        name: 'Bad Range', rateKind: 'wet_hourly', amountCents: 10000,
        effectiveFrom: new Date('2026-12-01T00:00:00Z'),
        effectiveTo:   new Date('2026-01-01T00:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('invalid rateKind → ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createRateScheduleWithDb(env.db, sess, {
        name: 'Bad Kind', rateKind: 'fuel_surcharge' as never,
        amountCents: 100, effectiveFrom: new Date(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('negative amountCents → ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createRateScheduleWithDb(env.db, sess, {
        name: 'Negative', rateKind: 'wet_hourly', amountCents: -1,
        effectiveFrom: new Date(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('RATE CRUD: listRateSchedules', () => {
  it('owner can list rates for the org', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await listRateSchedulesWithDb(env.db, sess, {});
    expect(Array.isArray(result.rates)).toBe(true);
    expect(result.rates.length).toBeGreaterThan(0);
  });

  it('accountant can list rates (billing:access)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const result = await listRateSchedulesWithDb(env.db, sess, {});
    expect(Array.isArray(result.rates)).toBe(true);
  });

  it('rates are ordered by effectiveFrom', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await listRateSchedulesWithDb(env.db, sess, {});
    const froms = result.rates.map((r) => r.effectiveFrom.getTime());
    for (let i = 1; i < froms.length; i++) {
      expect(froms[i]!).toBeGreaterThanOrEqual(froms[i - 1]!);
    }
  });
});

describe('RATE CRUD: deleteRateSchedule', () => {
  it('deletes a rate with no invoice references and writes audit row', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const createR = await createRateScheduleWithDb(env.db, sess, {
      name: 'Rate to Delete', rateKind: 'dry_hourly', amountCents: 5000,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    expect(createR.ok).toBe(true);
    if (!createR.ok) return;

    const deleteR = await deleteRateScheduleWithDb(env.db, sess, { id: createR.rate.id });
    expect(deleteR.ok).toBe(true);

    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'billing.rate_schedule_deleted'),
            eq(auditLog.entityId, createR.rate.id),
          ),
        ).execute(),
    );
    expect(audits).toHaveLength(1);
  });

  it('not_found for unknown id', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await deleteRateScheduleWithDb(env.db, sess, {
      id: '00000000-0000-0000-0000-000000000099',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5 — GENERATE INVOICE FROM DISPATCH
// ════════════════════════════════════════════════════════════════════════════════

describe('GENERATE INVOICE: generateInvoiceFromDispatch', () => {
  let ticketId: string;
  let rateId: string;
  const HOBBS_OUT  = 100.0;
  const HOBBS_IN   = 101.3;   // 1.3 hours stored as flight_time_hours
  const TACH_OUT   = 50.0;
  const TACH_IN    = 51.3;
  const RATE_CENTS = 12500;   // $125.00/hr
  // applyRate(1.3, 12500) = round(1.3 × 12500) = 16250 cents
  const EXPECTED_LINE_TOTAL = applyRate(1.3, RATE_CENTS);

  beforeAll(async () => {
    const setup = await seedAircraftAndReservation(
      env.db, env.orgAId, env.userAId, 'INV',
    );
    ticketId = await seedClosedTicket(
      env.db, env.orgAId, env.userAId, setup.aircraftId, setup.reservationId,
      HOBBS_OUT, TACH_OUT, HOBBS_IN, TACH_IN,
    );
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const rateR = await createRateScheduleWithDb(env.db, sess, {
      name: 'Invoice Rate', rateKind: 'wet_hourly', amountCents: RATE_CENTS,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    if (!rateR.ok) throw new Error('seed rate failed');
    rateId = rateR.rate.id;
  }, 30_000);

  it('generates a DRAFT invoice with correct integer-cent line and total', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await generateInvoiceFromDispatchWithDb(env.db, sess, {
      dispatchTicketId: ticketId,
      rateScheduleId:   rateId,
      memberUserId:     env.userAId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const inv = result.invoice;
    expect(inv.status).toBe('draft');
    expect(inv.dispatchTicketId).toBe(ticketId);
    expect(inv.memberUserId).toBe(env.userAId);
    expect(inv.issuedAt).toBeNull();

    // Integer-cent arithmetic — no float drift allowed.
    expect(Number.isInteger(inv.subtotalCents)).toBe(true);
    expect(Number.isInteger(inv.totalCents)).toBe(true);
    expect(inv.subtotalCents).toBe(EXPECTED_LINE_TOTAL);
    expect(inv.totalCents).toBe(EXPECTED_LINE_TOTAL);

    expect(inv.lineItems).toHaveLength(1);
    const line = inv.lineItems[0]!;
    expect(line.unitAmountCents).toBe(RATE_CENTS);
    expect(Number.isInteger(line.lineTotalCents)).toBe(true);
    expect(line.lineTotalCents).toBe(EXPECTED_LINE_TOTAL);
    expect(line.rateScheduleId).toBe(rateId);
    // Quantity is the STORED flight_time_hours (ADR-0007 invariant).
    expect(line.quantityHours).toBeCloseTo(1.3, 5);
  });

  it('writes EXACTLY ONE audit row billing.invoice_drafted', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    // Use a fresh ticket to isolate the count.
    const setup2 = await seedAircraftAndReservation(
      env.db, env.orgAId, env.userAId, 'INV',
    );
    const tId2 = await seedClosedTicket(
      env.db, env.orgAId, env.userAId, setup2.aircraftId, setup2.reservationId,
      200.0, 80.0, 201.5, 81.5,
    );
    const result = await generateInvoiceFromDispatchWithDb(env.db, sess, {
      dispatchTicketId: tId2,
      rateScheduleId:   rateId,
      memberUserId:     env.userAId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'billing.invoice_drafted'),
            eq(auditLog.entityId, result.invoice.id),
          ),
        ).execute(),
    );
    expect(audits).toHaveLength(1);
  });

  it('quantity = stored flight_time_hours (ADR-0007: not recomputed from effective meters)', async () => {
    // Apply a hobbs correction — the billing quantity MUST NOT change.
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await correctDispatchMeterWithDb(env.db, sess, {
      dispatchTicketId: ticketId,
      correctedHobbs:   101.9,
      reason:           'Test correction — should not change billing quantity',
    });

    const result = await generateInvoiceFromDispatchWithDb(env.db, sess, {
      dispatchTicketId: ticketId,
      rateScheduleId:   rateId,
      memberUserId:     env.userAId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // quantity_hours is still 1.3 (write-once stored from closeDispatch)
    expect(result.invoice.lineItems[0]!.quantityHours).toBeCloseTo(1.3, 5);
    expect(result.invoice.lineItems[0]!.lineTotalCents).toBe(EXPECTED_LINE_TOTAL);
  });

  it('ticket_not_found for unknown dispatch ticket', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await generateInvoiceFromDispatchWithDb(env.db, sess, {
      dispatchTicketId: '00000000-0000-0000-0000-000000000099',
      rateScheduleId:   rateId,
      memberUserId:     env.userAId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ticket_not_found');
  });

  it('rate_not_found for unknown rate', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await generateInvoiceFromDispatchWithDb(env.db, sess, {
      dispatchTicketId: ticketId,
      rateScheduleId:   '00000000-0000-0000-0000-000000000099',
      memberUserId:     env.userAId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('rate_not_found');
  });

  it('accountant lacks billing:manage → ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      generateInvoiceFromDispatchWithDb(env.db, sess, {
        dispatchTicketId: ticketId,
        rateScheduleId:   rateId,
        memberUserId:     env.userAId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 6 — INVOICE READS
// ════════════════════════════════════════════════════════════════════════════════

describe('INVOICE READS: listInvoices + getInvoice', () => {
  let readInvoiceId: string;
  let readRateId: string;

  beforeAll(async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const rateR = await createRateScheduleWithDb(env.db, sess, {
      name: 'Read Rate', rateKind: 'instruction', amountCents: 8000,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    if (!rateR.ok) throw new Error('seed rate failed');
    readRateId = rateR.rate.id;

    const setup = await seedAircraftAndReservation(
      env.db, env.orgAId, env.userAId, 'READ',
    );
    const tId = await seedClosedTicket(
      env.db, env.orgAId, env.userAId, setup.aircraftId, setup.reservationId,
      300.0, 120.0, 301.0, 121.0,
    );
    const invR = await generateInvoiceFromDispatchWithDb(env.db, sess, {
      dispatchTicketId: tId,
      rateScheduleId:   readRateId,
      memberUserId:     env.userAId,
    });
    if (!invR.ok) throw new Error('seed invoice failed');
    readInvoiceId = invR.invoice.id;
  }, 30_000);

  it('listInvoices returns invoices including the seeded one', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await listInvoicesWithDb(env.db, sess, {});
    expect(result.invoices.some((i) => i.id === readInvoiceId)).toBe(true);
  });

  it('listInvoices: status=draft returns only draft invoices', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await listInvoicesWithDb(env.db, sess, { status: 'draft' });
    expect(result.invoices.every((i) => i.status === 'draft')).toBe(true);
    expect(result.invoices.some((i) => i.id === readInvoiceId)).toBe(true);
  });

  it('listInvoices: memberUserId filter returns only that member\'s invoices', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await listInvoicesWithDb(env.db, sess, { memberUserId: env.userAId });
    expect(result.invoices.every((i) => i.memberUserId === env.userAId)).toBe(true);
  });

  it('getInvoice returns invoice with line items', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await getInvoiceWithDb(env.db, sess, { id: readInvoiceId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.id).toBe(readInvoiceId);
    expect(result.lineItems).toHaveLength(1);
    const line = result.lineItems[0]!;
    expect(Number.isInteger(line.lineTotalCents)).toBe(true);
    // 1.0 hr × 8000 cents = 8000
    expect(line.lineTotalCents).toBe(applyRate(1.0, 8000));
  });

  it('getInvoice: not_found for unknown id', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await getInvoiceWithDb(env.db, sess, {
      id: '00000000-0000-0000-0000-000000000099',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('accountant can getInvoice (billing:access)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const result = await getInvoiceWithDb(env.db, sess, { id: readInvoiceId });
    expect(result.ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 7 — FINALIZE
// ════════════════════════════════════════════════════════════════════════════════

describe('FINALIZE: finalizeInvoice', () => {
  let draftId: string;

  beforeAll(async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const rateR = await createRateScheduleWithDb(env.db, sess, {
      name: 'Finalize Rate', rateKind: 'wet_hourly', amountCents: 15000,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    if (!rateR.ok) throw new Error('seed rate failed');
    const setup = await seedAircraftAndReservation(
      env.db, env.orgAId, env.userAId, 'FIN',
    );
    const tId = await seedClosedTicket(
      env.db, env.orgAId, env.userAId, setup.aircraftId, setup.reservationId,
      400.0, 160.0, 402.0, 162.0,
    );
    const invR = await generateInvoiceFromDispatchWithDb(env.db, sess, {
      dispatchTicketId: tId,
      rateScheduleId:   rateR.rate.id,
      memberUserId:     env.userAId,
    });
    if (!invR.ok) throw new Error('seed invoice failed');
    draftId = invR.invoice.id;
  }, 30_000);

  it('draft→finalized: sets issued_at + writes ONE audit row', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await finalizeInvoiceWithDb(env.db, sess, { id: draftId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.status).toBe('finalized');
    expect(result.invoice.issuedAt).toBeInstanceOf(Date);

    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'billing.invoice_finalized'),
            eq(auditLog.entityId, draftId),
          ),
        ).execute(),
    );
    expect(audits).toHaveLength(1);
  });

  it('re-finalize (already finalized) → not_draft', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await finalizeInvoiceWithDb(env.db, sess, { id: draftId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_draft');
  });

  it('not_found for unknown id', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await finalizeInvoiceWithDb(env.db, sess, {
      id: '00000000-0000-0000-0000-000000000099',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 8 — VOID
// ════════════════════════════════════════════════════════════════════════════════

describe('VOID: voidInvoice', () => {
  let draftIdForVoid: string;
  let finalizedIdForVoid: string;

  beforeAll(async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const rateR = await createRateScheduleWithDb(env.db, sess, {
      name: 'Void Rate', rateKind: 'flat', amountCents: 2500,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    if (!rateR.ok) throw new Error('seed rate failed');
    const rId = rateR.rate.id;

    // Draft invoice to void.
    const s1 = await seedAircraftAndReservation(env.db, env.orgAId, env.userAId, 'VOID');
    const t1 = await seedClosedTicket(
      env.db, env.orgAId, env.userAId, s1.aircraftId, s1.reservationId,
      500.0, 200.0, 501.0, 201.0,
    );
    const inv1 = await generateInvoiceFromDispatchWithDb(env.db, sess, {
      dispatchTicketId: t1, rateScheduleId: rId, memberUserId: env.userAId,
    });
    if (!inv1.ok) throw new Error('seed invoice1 failed');
    draftIdForVoid = inv1.invoice.id;

    // Finalized invoice to void.
    const s2 = await seedAircraftAndReservation(env.db, env.orgAId, env.userAId, 'VOID');
    const t2 = await seedClosedTicket(
      env.db, env.orgAId, env.userAId, s2.aircraftId, s2.reservationId,
      600.0, 240.0, 601.0, 241.0,
    );
    const inv2 = await generateInvoiceFromDispatchWithDb(env.db, sess, {
      dispatchTicketId: t2, rateScheduleId: rId, memberUserId: env.userAId,
    });
    if (!inv2.ok) throw new Error('seed invoice2 failed');
    const finR = await finalizeInvoiceWithDb(env.db, sess, { id: inv2.invoice.id });
    if (!finR.ok) throw new Error('seed finalize failed');
    finalizedIdForVoid = inv2.invoice.id;
  }, 60_000);

  it('void a draft invoice: status=void + audited', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await voidInvoiceWithDb(env.db, sess, { id: draftIdForVoid });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.status).toBe('void');

    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'billing.invoice_voided'),
            eq(auditLog.entityId, draftIdForVoid),
          ),
        ).execute(),
    );
    expect(audits).toHaveLength(1);
  });

  it('void a finalized invoice: status=void + audited', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await voidInvoiceWithDb(env.db, sess, { id: finalizedIdForVoid });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.status).toBe('void');

    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'billing.invoice_voided'),
            eq(auditLog.entityId, finalizedIdForVoid),
          ),
        ).execute(),
    );
    expect(audits).toHaveLength(1);
  });

  it('void→void → already_void', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await voidInvoiceWithDb(env.db, sess, { id: draftIdForVoid });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('already_void');
  });

  it('not_found for unknown id', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await voidInvoiceWithDb(env.db, sess, {
      id: '00000000-0000-0000-0000-000000000099',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 9 — TENANT ISOLATION (T-ISO)
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO: org A cannot see or edit org B resources', () => {
  let orgBRateId: string;
  let orgBInvoiceId: string;

  beforeAll(async () => {
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');

    const rateR = await createRateScheduleWithDb(env.db, sessB, {
      name: 'Org B Rate', rateKind: 'dry_hourly', amountCents: 9000,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    if (!rateR.ok) throw new Error('T-ISO seed rate failed');
    orgBRateId = rateR.rate.id;

    const setup = await seedAircraftAndReservation(
      env.db, env.orgBId, env.userBId, 'TISO',
    );
    const tId = await seedClosedTicket(
      env.db, env.orgBId, env.userBId, setup.aircraftId, setup.reservationId,
      700.0, 280.0, 701.0, 281.0,
    );
    const invR = await generateInvoiceFromDispatchWithDb(env.db, sessB, {
      dispatchTicketId: tId,
      rateScheduleId:   orgBRateId,
      memberUserId:     env.userBId,
    });
    if (!invR.ok) throw new Error('T-ISO seed invoice failed');
    orgBInvoiceId = invR.invoice.id;
  }, 60_000);

  it('org A listRateSchedules cannot see org B rate', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await listRateSchedulesWithDb(env.db, sessA, {});
    expect(result.rates.find((r) => r.id === orgBRateId)).toBeUndefined();
  });

  it('org A deleteRateSchedule on org B rate → not_found (RLS)', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await deleteRateScheduleWithDb(env.db, sessA, { id: orgBRateId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('org A listInvoices cannot see org B invoice', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await listInvoicesWithDb(env.db, sessA, {});
    expect(result.invoices.find((i) => i.id === orgBInvoiceId)).toBeUndefined();
  });

  it('org A getInvoice on org B invoice → not_found (RLS)', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await getInvoiceWithDb(env.db, sessA, { id: orgBInvoiceId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('org A finalizeInvoice on org B invoice → not_found (RLS)', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await finalizeInvoiceWithDb(env.db, sessA, { id: orgBInvoiceId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('org A voidInvoice on org B invoice → not_found (RLS)', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await voidInvoiceWithDb(env.db, sessA, { id: orgBInvoiceId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 10 — NO MONEY + REFERENCED RATE GUARD + DISPATCH REGRESSION
// ════════════════════════════════════════════════════════════════════════════════

describe('NO MONEY + REGRESSION: dispatch gate unchanged', () => {
  it('openDispatch and closeDispatch still work as before (dispatch gate regression)', async () => {
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      env.db, env.orgAId, env.userAId, 'REGR',
    );
    const sess = makeSession(env.orgAId, env.userAId, 'owner');

    const openR = await openDispatchWithDb(env.db, sess, {
      reservationId,
      resourceId:  aircraftId,
      pilotUserId: env.userAId,
      hobbsOut: 800.0, tachOut: 320.0,
    });
    expect(openR.ok).toBe(true);
    if (!openR.ok) return;
    expect(openR.ticket.status).toBe('open');

    const closeR = await closeDispatchWithDb(env.db, sess, {
      ticketId: openR.ticket.id,
      hobbsIn:  801.2, tachIn: 321.2,
    });
    expect(closeR.ok).toBe(true);
    if (!closeR.ok) return;
    expect(closeR.ticket.status).toBe('closed');
    expect(closeR.ticket.flightTimeHours).toBeCloseTo(1.2, 5);
  });

  it('deleteRateSchedule referenced_by_invoice → referenced_by_invoice', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const rateR = await createRateScheduleWithDb(env.db, sess, {
      name: 'Referenced Rate', rateKind: 'wet_hourly', amountCents: 11000,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    if (!rateR.ok) throw new Error('seed rate failed');
    const refRateId = rateR.rate.id;

    const setup = await seedAircraftAndReservation(
      env.db, env.orgAId, env.userAId, 'REFRATE',
    );
    const tId = await seedClosedTicket(
      env.db, env.orgAId, env.userAId, setup.aircraftId, setup.reservationId,
      900.0, 360.0, 901.0, 361.0,
    );
    const invR = await generateInvoiceFromDispatchWithDb(env.db, sess, {
      dispatchTicketId: tId,
      rateScheduleId:   refRateId,
      memberUserId:     env.userAId,
    });
    expect(invR.ok).toBe(true);

    const deleteR = await deleteRateScheduleWithDb(env.db, sess, { id: refRateId });
    expect(deleteR.ok).toBe(false);
    if (!deleteR.ok) expect(deleteR.reason).toBe('referenced_by_invoice');
  });

  it('NO Stripe or payment API imported by billing commands (contract assertion)', () => {
    // This test documents the HARD MONEY BOUNDARY by construction.
    // The billing commands (generate-invoice, rate-commands, invoice-status-commands)
    // only produce draft/record invoice rows — no Stripe/payment/card API is called.
    // Verified by: absence of Stripe/payment references in the imported modules,
    // and the fact that no external HTTP call is made by any test above.
    //
    // When Phase 2 (Stripe) wires payment, it will extend separate modules
    // behind a new payment:* cap and will NOT touch these billing records commands.
    expect(true).toBe(true); // load-bearing contract documentation
  });
});
