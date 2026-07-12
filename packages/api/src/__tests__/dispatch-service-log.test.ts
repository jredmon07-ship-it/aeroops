/**
 * dispatch-service-log.test.ts — Integration tests for the line-ops service log
 * (migration 0044) + the FC-parity Aircraft report.
 *
 * Applies migrations 0000–0044 (0044 = dispatch_service_log). PGlite + WithDb.
 * Two-org seed for tenant isolation.
 *
 * COVERAGE:
 *   CAPS: dispatch:create required for recordDispatchService; non-dispatch roles
 *         Forbidden; null → Unauthenticated. reporting:access for the report.
 *   CLOSED-ONLY: open ticket → not_closed; unknown ticket → not_found.
 *   VALIDATION: oil/fuel bounds + decimals; at-least-one CHECK (zod refine).
 *   APPEND + AUDIT: INSERT persists oil/fuel/note; ONE 'dispatch.service_recorded'.
 *   LATEST-WINS: a second service row supersedes the first (effective = latest).
 *   REPORT MATH: per-tail flights/hours/oil/fuel sums; zero-service tail = 0/0.
 *   T-ISO: org B cannot read org A's service; the report never leaks cross-org.
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
import {
  recordDispatchServiceWithDb,
  getDispatchServiceForTicketsWithDb,
} from '../dispatch/record-dispatch-service.js';
import { getAircraftReportWithDb } from '../reporting/get-aircraft-report.js';
import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

const MIGRATION_SQL = loadMigrationSql('0044');

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

const SLOT_START = new Date('2026-08-01T08:00:00Z');
const SLOT_END = new Date('2026-08-01T10:00:00Z');

let env: TestEnv;

let tailSuffix = 0;
function nextTail(prefix: string): string {
  tailSuffix += 1;
  return `${prefix}${tailSuffix}`;
}

/** Create aircraft + reservation in the given org. */
async function seedAircraftAndReservation(
  orgId: string,
  userId: string,
  tailPrefix: string,
  start = SLOT_START,
  end = SLOT_END,
): Promise<{ aircraftId: string; reservationId: string }> {
  const sess = makeSession(orgId, userId, 'owner');
  const tail = nextTail(tailPrefix);
  const aircraft = await createResourceWithDb(env.db, sess, {
    kind: 'aircraft',
    displayName: `Test ${tail}`,
    tailNumber: `N${tail}`,
  });
  const rResult = await createReservationWithDb(env.db, sess, {
    startAt: start,
    endAt: end,
    resourceIds: [aircraft.id],
  });
  if (!rResult.ok) throw new Error(`seedAircraftAndReservation failed: ${rResult.reason}`);
  return { aircraftId: aircraft.id, reservationId: rResult.reservation.id };
}

/** Open + close a dispatch ticket. Returns ticketId + aircraftId. */
async function seedClosedTicket(
  orgId: string,
  userId: string,
  tailPrefix: string,
  hobbsOut = 100.0,
  tachOut = 50.0,
  hobbsIn = 102.0,
  tachIn = 52.0,
): Promise<{ ticketId: string; aircraftId: string }> {
  const { aircraftId, reservationId } = await seedAircraftAndReservation(orgId, userId, tailPrefix);
  const sess = makeSession(orgId, userId, 'owner');
  const openR = await openDispatchWithDb(env.db, sess, {
    reservationId,
    resourceId: aircraftId,
    pilotUserId: userId,
    hobbsOut,
    tachOut,
  });
  if (!openR.ok) throw new Error(`openDispatch failed: ${openR.reason}`);
  const closeR = await closeDispatchWithDb(env.db, sess, {
    ticketId: openR.ticket.id,
    hobbsIn,
    tachIn,
  });
  if (!closeR.ok) throw new Error(`closeDispatch failed: ${closeR.reason}`);
  return { ticketId: closeR.ticket.id, aircraftId };
}

/** Open a ticket but leave it OPEN. Returns ticketId. */
async function seedOpenTicket(
  orgId: string,
  userId: string,
  tailPrefix: string,
): Promise<string> {
  const { aircraftId, reservationId } = await seedAircraftAndReservation(orgId, userId, tailPrefix);
  const sess = makeSession(orgId, userId, 'owner');
  const openR = await openDispatchWithDb(env.db, sess, {
    reservationId,
    resourceId: aircraftId,
    pilotUserId: userId,
    hobbsOut: 100.0,
    tachOut: 50.0,
  });
  if (!openR.ok) throw new Error(`openDispatch failed: ${openR.reason}`);
  return openR.ticket.id;
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

// ════════════════════════════════════════════════════════════════════════════════
// CAPABILITY GATES
// ════════════════════════════════════════════════════════════════════════════════

describe('CAPS: dispatch:create required for recordDispatchService', () => {
  it('null session → UnauthenticatedError', async () => {
    await expect(
      recordDispatchServiceWithDb(env.db, null, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000000',
        oilAddedQuarts: 1.0,
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('renter → Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(
      recordDispatchServiceWithDb(env.db, sess, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000000',
        oilAddedQuarts: 1.0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('accountant → Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      recordDispatchServiceWithDb(env.db, sess, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000000',
        fuelAddedGallons: 10.0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('mechanic → Forbidden (not in dispatch:create)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'mechanic');
    await expect(
      recordDispatchServiceWithDb(env.db, sess, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000000',
        fuelAddedGallons: 10.0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('dispatcher → allowed (reaches ticket lookup → not_found)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    const result = await recordDispatchServiceWithDb(env.db, sess, {
      dispatchTicketId: '11111111-1111-1111-1111-111111111111',
      oilAddedQuarts: 1.0,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('report: reporting:access — null → Unauthenticated', async () => {
    await expect(getAircraftReportWithDb(env.db, null, { range: '30d' })).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// CLOSED-ONLY
// ════════════════════════════════════════════════════════════════════════════════

describe('CLOSED-ONLY: only a closed ticket can carry a service log', () => {
  it('unknown ticket → not_found', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await recordDispatchServiceWithDb(env.db, sess, {
      dispatchTicketId: '22222222-2222-2222-2222-222222222222',
      oilAddedQuarts: 1.0,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('open (not closed) ticket → not_closed', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const ticketId = await seedOpenTicket(env.orgAId, env.userAId, 'OPEN');
    const result = await recordDispatchServiceWithDb(env.db, sess, {
      dispatchTicketId: ticketId,
      oilAddedQuarts: 1.0,
    });
    expect(result).toEqual({ ok: false, reason: 'not_closed' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════════════════════

describe('VALIDATION: bounds + at-least-one', () => {
  let ticketId: string;
  beforeAll(async () => {
    ({ ticketId } = await seedClosedTicket(env.orgAId, env.userAId, 'VAL'));
  });

  const sess = () => makeSession(env.orgAId, env.userAId, 'owner');

  it('no oil/fuel/note → ValidationError (at-least-one)', async () => {
    await expect(
      recordDispatchServiceWithDb(env.db, sess(), { dispatchTicketId: ticketId }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('oil > 99 → ValidationError', async () => {
    await expect(
      recordDispatchServiceWithDb(env.db, sess(), { dispatchTicketId: ticketId, oilAddedQuarts: 100 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('oil negative → ValidationError', async () => {
    await expect(
      recordDispatchServiceWithDb(env.db, sess(), { dispatchTicketId: ticketId, oilAddedQuarts: -1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('fuel > 999 → ValidationError', async () => {
    await expect(
      recordDispatchServiceWithDb(env.db, sess(), { dispatchTicketId: ticketId, fuelAddedGallons: 1000 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('oil with 2 decimals → ValidationError', async () => {
    await expect(
      recordDispatchServiceWithDb(env.db, sess(), { dispatchTicketId: ticketId, oilAddedQuarts: 1.25 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('note only (no oil/fuel) → allowed', async () => {
    const result = await recordDispatchServiceWithDb(env.db, sess(), {
      dispatchTicketId: ticketId,
      note: 'Topped off oil, checked tires.',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.service.note).toBe('Topped off oil, checked tires.');
      expect(result.service.oilAddedQuarts).toBeNull();
      expect(result.service.fuelAddedGallons).toBeNull();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// APPEND + AUDIT + LATEST-WINS
// ════════════════════════════════════════════════════════════════════════════════

describe('APPEND + AUDIT + LATEST-WINS', () => {
  it('records oil/fuel/note + ONE audit row; latest supersedes', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const { ticketId } = await seedClosedTicket(env.orgAId, env.userAId, 'SVC');

    const first = await recordDispatchServiceWithDb(env.db, sess, {
      dispatchTicketId: ticketId,
      oilAddedQuarts: 1.0,
      fuelAddedGallons: 20.0,
      note: 'first',
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.service.oilAddedQuarts).toBe(1.0);
      expect(first.service.fuelAddedGallons).toBe(20.0);
    }

    // Ensure a strictly later created_at so "latest by created_at" is
    // unambiguous (service logs, like meter corrections, order by created_at).
    await new Promise((r) => setTimeout(r, 5));

    // Second row supersedes (latest by created_at wins).
    const second = await recordDispatchServiceWithDb(env.db, sess, {
      dispatchTicketId: ticketId,
      oilAddedQuarts: 2.0,
      fuelAddedGallons: 25.5,
      note: 'corrected',
    });
    expect(second.ok).toBe(true);

    const effective = await getDispatchServiceForTicketsWithDb(env.db, sess, [ticketId]);
    const eff = effective.get(ticketId);
    expect(eff).toBeDefined();
    expect(eff?.oilAddedQuarts).toBe(2.0);
    expect(eff?.fuelAddedGallons).toBe(25.5);
    expect(eff?.note).toBe('corrected');

    // Exactly two audit rows for this ticket's service events.
    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'dispatch.service_recorded'),
            eq(auditLog.entityId, ticketId),
          ),
        ),
    );
    expect(audits.length).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// REPORT MATH
// ════════════════════════════════════════════════════════════════════════════════

describe('REPORT MATH: getAircraftReport per-tail sums', () => {
  it('sums latest oil/fuel per ticket over closed tickets; zero-service tail = 0/0', async () => {
    // Fresh org C-ish: reuse orgB (isolated) so orgA rows don't pollute counts.
    const org = env.orgBId;
    const user = env.userBId;
    const sess = makeSession(org, user, 'owner');

    // Aircraft X: two closed tickets, service on both.
    const t1 = await seedClosedTicket(org, user, 'RPTX', 100, 50, 101.5, 51.5); // 1.5h
    await recordDispatchServiceWithDb(env.db, sess, {
      dispatchTicketId: t1.ticketId,
      oilAddedQuarts: 1.0,
      fuelAddedGallons: 20.0,
    });
    // Second ticket on the SAME aircraft.
    const { reservationId: r2 } = await (async () => {
      const rr = await createReservationWithDb(env.db, sess, {
        startAt: new Date('2026-08-02T08:00:00Z'),
        endAt: new Date('2026-08-02T10:00:00Z'),
        resourceIds: [t1.aircraftId],
      });
      if (!rr.ok) throw new Error('res2 failed');
      return { reservationId: rr.reservation.id };
    })();
    const open2 = await openDispatchWithDb(env.db, sess, {
      reservationId: r2,
      resourceId: t1.aircraftId,
      pilotUserId: user,
      hobbsOut: 101.5,
      tachOut: 51.5,
    });
    if (!open2.ok) throw new Error('open2 failed');
    const close2 = await closeDispatchWithDb(env.db, sess, {
      ticketId: open2.ticket.id,
      hobbsIn: 103.0, // +1.5h
      tachIn: 53.0,
    });
    if (!close2.ok) throw new Error('close2 failed');
    // Service on ticket2 (latest-wins per ticket is covered deterministically in
    // the APPEND section; here we assert the per-tail SUM across two tickets).
    await recordDispatchServiceWithDb(env.db, sess, {
      dispatchTicketId: close2.ticket.id,
      oilAddedQuarts: 2.0,
      fuelAddedGallons: 30.0,
    });

    // Aircraft Y: one closed ticket, NO service log.
    const tY = await seedClosedTicket(org, user, 'RPTY', 200, 100, 201.0, 101.0); // 1.0h

    const report = await getAircraftReportWithDb(env.db, sess, { range: '365d' });

    const rowX = report.find((r) => r.resourceId === t1.aircraftId);
    const rowY = report.find((r) => r.resourceId === tY.aircraftId);

    expect(rowX).toBeDefined();
    expect(rowX?.flightCount).toBe(2);
    expect(rowX?.flightHours).toBe(3.0); // 1.5 + 1.5
    expect(rowX?.oilAddedQuarts).toBe(3.0); // 1.0 + 2.0 (latest)
    expect(rowX?.fuelAddedGallons).toBe(50.0); // 20.0 + 30.0 (latest)

    expect(rowY).toBeDefined();
    expect(rowY?.flightCount).toBe(1);
    expect(rowY?.flightHours).toBe(1.0);
    expect(rowY?.oilAddedQuarts).toBe(0); // no service log
    expect(rowY?.fuelAddedGallons).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// TENANT ISOLATION
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO: service logs never leak across orgs', () => {
  it('org B cannot read org A service; report never sees cross-org oil/fuel', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const { ticketId, aircraftId } = await seedClosedTicket(env.orgAId, env.userAId, 'ISO');
    await recordDispatchServiceWithDb(env.db, sessA, {
      dispatchTicketId: ticketId,
      oilAddedQuarts: 3.0,
      fuelAddedGallons: 40.0,
    });

    // org B reads by org A's ticket id → empty map (RLS isolates).
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const bView = await getDispatchServiceForTicketsWithDb(env.db, sessB, [ticketId]);
    expect(bView.size).toBe(0);

    // org B's report never contains org A's aircraft/oil/fuel.
    const bReport = await getAircraftReportWithDb(env.db, sessB, { range: '365d' });
    expect(bReport.find((r) => r.resourceId === aircraftId)).toBeUndefined();

    // org A DOES see its own service.
    const aView = await getDispatchServiceForTicketsWithDb(env.db, sessA, [ticketId]);
    expect(aView.get(ticketId)?.oilAddedQuarts).toBe(3.0);
    expect(aView.get(ticketId)?.fuelAddedGallons).toBe(40.0);
  });
});
