/**
 * logbook-annotation.test.ts — Integration tests for Slice P2-LOG2:
 * pilot-logbook flight-condition annotations + aircraft category/class.
 *
 * Applies migrations 0000–0037 (0037 adds the append-only logbook_annotation
 * table + resource.category / resource.aircraft_class).
 *
 * COVERAGE:
 *   CAPS: null session ⇒ Unauthenticated; mechanic/accountant (neither
 *     portal:access nor people:access) ⇒ Forbidden.
 *   SELF vs STAFF SCOPING: a renter annotates their OWN closed flight; a
 *     renter annotating ANOTHER pilot's ticket ⇒ not_found (anti-enumeration);
 *     a dispatcher (people:access, NO portal:access) annotates any in-org
 *     pilot's ticket; pilot_user_id is snapshotted from the ticket.
 *   CLOSED-ONLY: open ticket ⇒ not_closed; voided ticket ⇒ not_closed.
 *   LATEST-WINS: a second annotation supersedes the first in the log read;
 *     both rows persist (append-only).
 *   VALIDATION: negative / >99.9 / not-a-tenth hours ⇒ ValidationError;
 *     all-empty annotation ⇒ ValidationError.
 *   READS: getMyPilotLog / getPilotLog carry the effective annotation +
 *     category/aircraftClass (via updateAircraft).
 *   CSV: both exports include the Night / Instrument / XC / CategoryClass /
 *     Remarks columns with correct values.
 *   AUDIT: exactly one 'logbook.flight_annotated' row per annotate call.
 *   T-ISO: an org-B session cannot annotate an org-A ticket (not_found;
 *     nothing persisted).
 *
 * COMPLIANCE: annotations are PILOT/OPERATOR-ENTERED data — not an FAA
 * logbook of record; no computed §61.51/§61.57 currency determination.
 * FROZEN GUARD: this suite imports openDispatchWithDb/closeDispatchWithDb
 * ONLY to seed fixtures — the frozen dispatch paths are never edited.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  appUser,
  membership,
  auditLog,
  logbookAnnotation,
  loadMigrationSql,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';
import { parseCsv } from '@aeroops/core';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { voidDispatchWithDb } from '../dispatch/void-dispatch.js';
import { updateAircraftWithDb } from '../fleet/update-aircraft.js';

import { annotateFlightWithDb } from '../logbook/annotate-flight.js';
import { getMyPilotLogWithDb } from '../logbook/get-my-pilot-log.js';
import { getPilotLogWithDb } from '../logbook/get-pilot-log.js';
import { exportMyPilotLogCsvWithDb } from '../logbook/export-my-pilot-log-csv.js';
import { exportPilotLogCsvWithDb } from '../logbook/export-pilot-log-csv.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0038 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0038');

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

// Reservation windows — future slots so booking-policy min-advance checks pass.
const D = '2026-08-15';
let tagCounter = 0;

let env: TestEnv;

/** Seed an org member with a membership. Returns userId. */
async function seedOrgMember(
  db: PgliteTestClient,
  orgId: string,
  email: string,
  role: AppSession['role'] = 'renter',
): Promise<string> {
  return withOrgContext(db, orgId, async (tx) => {
    const [usr] = await tx
      .insert(appUser)
      .values({ orgId, email, fullName: `User ${email}`, status: 'active' })
      .returning();
    await tx.insert(membership).values({ orgId, userId: usr!.id, role });
    return usr!.id;
  });
}

/** Create a fresh aircraft + reservation, then open + close a dispatch ticket. */
async function openCloseFlight(
  db: PgliteTestClient,
  sess: AppSession,
  pilotUserId: string,
  hobbsOut: number,
  hobbsIn: number,
): Promise<{ ticketId: string; aircraftId: string }> {
  tagCounter += 1;
  const tag = `ANN${tagCounter}`;
  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `N-${tag}`,
    tailNumber: `N${tag}`,
  });
  const start = new Date(`${D}T${String(8 + (tagCounter % 10)).padStart(2, '0')}:00:00Z`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const rResult = await createReservationWithDb(db, sess, {
    startAt: start,
    endAt: end,
    resourceIds: [aircraft.id],
  });
  if (!rResult.ok) throw new Error(`seed reservation failed: ${rResult.reason}`);

  const openResult = await openDispatchWithDb(db, sess, {
    reservationId: rResult.reservation.id,
    resourceId: aircraft.id,
    pilotUserId,
    hobbsOut,
    tachOut: hobbsOut,
  });
  if (!openResult.ok) throw new Error(`seed open failed: ${openResult.reason}`);

  const closeResult = await closeDispatchWithDb(db, sess, {
    ticketId: openResult.ticket.id,
    hobbsIn,
    tachIn: hobbsIn,
  });
  if (!closeResult.ok) throw new Error(`seed close failed: ${closeResult.reason}`);

  return { ticketId: openResult.ticket.id, aircraftId: aircraft.id };
}

/** Create a fresh aircraft + reservation and open a ticket that stays OPEN. */
async function openOnlyFlight(
  db: PgliteTestClient,
  sess: AppSession,
  pilotUserId: string,
  hobbsOut: number,
): Promise<string> {
  tagCounter += 1;
  const tag = `ANNO${tagCounter}`;
  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `N-${tag}`,
    tailNumber: `N${tag}`,
  });
  const start = new Date(`${D}T${String(8 + (tagCounter % 10)).padStart(2, '0')}:00:00Z`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const rResult = await createReservationWithDb(db, sess, {
    startAt: start,
    endAt: end,
    resourceIds: [aircraft.id],
  });
  if (!rResult.ok) throw new Error(`seed reservation failed: ${rResult.reason}`);

  const openResult = await openDispatchWithDb(db, sess, {
    reservationId: rResult.reservation.id,
    resourceId: aircraft.id,
    pilotUserId,
    hobbsOut,
    tachOut: hobbsOut,
  });
  if (!openResult.ok) throw new Error(`seed open failed: ${openResult.reason}`);

  return openResult.ticket.id;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

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
// CAPS
// ════════════════════════════════════════════════════════════════════════════════

describe('CAPS', () => {
  it('null session ⇒ Unauthenticated', async () => {
    await expect(
      annotateFlightWithDb(env.db, null, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000000',
        nightHours: 1.0,
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('mechanic (no portal:access, no people:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'mechanic');
    await expect(
      annotateFlightWithDb(env.db, sess, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000000',
        nightHours: 1.0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('accountant (no portal:access, no people:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      annotateFlightWithDb(env.db, sess, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000000',
        nightHours: 1.0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// HAPPY PATH — self annotation + reads carry it
// ════════════════════════════════════════════════════════════════════════════════

describe('HAPPY PATH: self annotation', () => {
  it('a renter annotates their OWN closed flight; the log reads carry it', async () => {
    const { db, orgAId } = env;
    const pilotId = await seedOrgMember(db, orgAId, `self-happy-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, env.userAId, 'owner');
    const { ticketId } = await openCloseFlight(db, staffSess, pilotId, 100.0, 101.5);

    const sessPilot = makeSession(orgAId, pilotId, 'renter');
    const result = await annotateFlightWithDb(db, sessPilot, {
      dispatchTicketId: ticketId,
      nightHours: 1.2,
      instrumentHours: 0.5,
      crossCountryHours: 1.5,
      remarks: 'KOSU-KCMH-KOSU night XC',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.annotation.dispatchTicketId).toBe(ticketId);
    expect(result.annotation.pilotUserId).toBe(pilotId); // snapshotted from ticket
    expect(result.annotation.nightHours).toBeCloseTo(1.2);
    expect(result.annotation.instrumentHours).toBeCloseTo(0.5);
    expect(result.annotation.crossCountryHours).toBeCloseTo(1.5);
    expect(result.annotation.remarks).toBe('KOSU-KCMH-KOSU night XC');
    expect(result.annotation.createdBy).toBe(pilotId);

    // Self read carries the effective annotation.
    const log = await getMyPilotLogWithDb(db, sessPilot);
    const entry = log.entries.find((e) => e.ticketId === ticketId);
    expect(entry).toBeDefined();
    expect(entry!.nightHours).toBeCloseTo(1.2);
    expect(entry!.instrumentHours).toBeCloseTo(0.5);
    expect(entry!.crossCountryHours).toBeCloseTo(1.5);
    expect(entry!.remarks).toBe('KOSU-KCMH-KOSU night XC');

    // Staff read carries it too.
    const staffResult = await getPilotLogWithDb(db, staffSess, { userId: pilotId });
    expect(staffResult.ok).toBe(true);
    if (!staffResult.ok) return;
    const staffEntry = staffResult.log.entries.find((e) => e.ticketId === ticketId);
    expect(staffEntry!.nightHours).toBeCloseTo(1.2);
  });

  it('un-annotated tickets read as all-null annotation fields', async () => {
    const { db, orgAId } = env;
    const pilotId = await seedOrgMember(db, orgAId, `self-null-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, env.userAId, 'owner');
    const { ticketId } = await openCloseFlight(db, staffSess, pilotId, 200.0, 200.5);

    const log = await getMyPilotLogWithDb(db, makeSession(orgAId, pilotId, 'renter'));
    const entry = log.entries.find((e) => e.ticketId === ticketId);
    expect(entry).toBeDefined();
    expect(entry!.nightHours).toBeNull();
    expect(entry!.instrumentHours).toBeNull();
    expect(entry!.crossCountryHours).toBeNull();
    expect(entry!.remarks).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SELF vs STAFF SCOPING
// ════════════════════════════════════════════════════════════════════════════════

describe('SELF vs STAFF SCOPING', () => {
  it("a renter annotating ANOTHER pilot's ticket ⇒ not_found (anti-enumeration)", async () => {
    const { db, orgAId } = env;
    const pilotA = await seedOrgMember(db, orgAId, `scope-a-${Date.now()}@test.com`, 'renter');
    const pilotB = await seedOrgMember(db, orgAId, `scope-b-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, env.userAId, 'owner');
    const { ticketId } = await openCloseFlight(db, staffSess, pilotA, 300.0, 300.5);

    const sessB = makeSession(orgAId, pilotB, 'renter');
    const result = await annotateFlightWithDb(db, sessB, {
      dispatchTicketId: ticketId,
      nightHours: 1.0,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it("a dispatcher (people:access, NO portal:access) annotates another pilot's ticket", async () => {
    const { db, orgAId } = env;
    const pilotId = await seedOrgMember(db, orgAId, `scope-staff-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, env.userAId, 'owner');
    const { ticketId } = await openCloseFlight(db, staffSess, pilotId, 400.0, 400.8);

    const dispatcherSess = makeSession(orgAId, env.userAId, 'dispatcher');
    const result = await annotateFlightWithDb(db, dispatcherSess, {
      dispatchTicketId: ticketId,
      crossCountryHours: 0.8,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // pilot_user_id snapshotted from the ticket, NOT the annotating staff user.
    expect(result.annotation.pilotUserId).toBe(pilotId);
    expect(result.annotation.createdBy).toBe(env.userAId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// CLOSED-TICKET-ONLY
// ════════════════════════════════════════════════════════════════════════════════

describe('CLOSED-TICKET-ONLY', () => {
  it('an OPEN ticket ⇒ not_closed', async () => {
    const { db, orgAId } = env;
    const pilotId = await seedOrgMember(db, orgAId, `open-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, env.userAId, 'owner');
    const openTicketId = await openOnlyFlight(db, staffSess, pilotId, 500.0);

    const result = await annotateFlightWithDb(db, staffSess, {
      dispatchTicketId: openTicketId,
      nightHours: 1.0,
    });
    expect(result).toEqual({ ok: false, reason: 'not_closed' });
  });

  it('a VOIDED ticket ⇒ not_closed', async () => {
    const { db, orgAId } = env;
    const pilotId = await seedOrgMember(db, orgAId, `voided-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, env.userAId, 'owner');
    const openTicketId = await openOnlyFlight(db, staffSess, pilotId, 600.0);
    const voidResult = await voidDispatchWithDb(db, staffSess, {
      ticketId: openTicketId,
      reason: 'test void',
    });
    expect(voidResult.ok).toBe(true);

    const result = await annotateFlightWithDb(db, staffSess, {
      dispatchTicketId: openTicketId,
      nightHours: 1.0,
    });
    expect(result).toEqual({ ok: false, reason: 'not_closed' });
  });

  it('a nonexistent ticket ⇒ not_found', async () => {
    const staffSess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await annotateFlightWithDb(env.db, staffSess, {
      dispatchTicketId: '00000000-0000-0000-0000-000000000000',
      nightHours: 1.0,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// LATEST-WINS (append-only)
// ════════════════════════════════════════════════════════════════════════════════

describe('LATEST-WINS: a newer annotation supersedes; history persists', () => {
  it('the log read shows the LATEST annotation; both rows exist (append-only)', async () => {
    const { db, orgAId } = env;
    const pilotId = await seedOrgMember(db, orgAId, `latest-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, env.userAId, 'owner');
    const { ticketId } = await openCloseFlight(db, staffSess, pilotId, 700.0, 701.0);
    const sessPilot = makeSession(orgAId, pilotId, 'renter');

    const first = await annotateFlightWithDb(db, sessPilot, {
      dispatchTicketId: ticketId,
      nightHours: 0.5,
      remarks: 'first pass',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Ensure a strictly later created_at for the superseding row —
    // timestamptz has microsecond precision, but a short pause makes the
    // ordering unambiguous even under coarse clocks.
    await new Promise((r) => setTimeout(r, 10));

    const second = await annotateFlightWithDb(db, sessPilot, {
      dispatchTicketId: ticketId,
      nightHours: 1.0,
      instrumentHours: 0.3,
      remarks: 'corrected pass',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // The effective annotation is the LATEST row — the second one.
    const log = await getMyPilotLogWithDb(db, sessPilot);
    const entry = log.entries.find((e) => e.ticketId === ticketId);
    expect(entry).toBeDefined();
    expect(entry!.nightHours).toBeCloseTo(1.0);
    expect(entry!.instrumentHours).toBeCloseTo(0.3);
    expect(entry!.remarks).toBe('corrected pass');
    // crossCountryHours was never set on the second row — the LATEST row
    // wins wholesale (no field-level merge across annotation rows).
    expect(entry!.crossCountryHours).toBeNull();

    // Append-only: BOTH rows persist.
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx
        .select()
        .from(logbookAnnotation)
        .where(eq(logbookAnnotation.dispatchTicketId, ticketId))
        .execute(),
    );
    expect(rows).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════════════════════

describe('VALIDATION', () => {
  it('negative hours ⇒ ValidationError', async () => {
    const staffSess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      annotateFlightWithDb(env.db, staffSess, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000000',
        nightHours: -0.5,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('hours > 99.9 ⇒ ValidationError', async () => {
    const staffSess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      annotateFlightWithDb(env.db, staffSess, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000000',
        crossCountryHours: 100.0,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('hours not a multiple of 0.1 ⇒ ValidationError', async () => {
    const staffSess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      annotateFlightWithDb(env.db, staffSess, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000000',
        instrumentHours: 1.25,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('no fields at all ⇒ ValidationError', async () => {
    const staffSess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      annotateFlightWithDb(env.db, staffSess, {
        dispatchTicketId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('non-UUID ticket id ⇒ ValidationError', async () => {
    const staffSess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      annotateFlightWithDb(env.db, staffSess, {
        dispatchTicketId: 'not-a-uuid',
        nightHours: 1.0,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// CATEGORY / CLASS on log rows
// ════════════════════════════════════════════════════════════════════════════════

describe('CATEGORY / CLASS: operator-entered identity flows to log rows', () => {
  it('updateAircraft sets category/aircraftClass; the log entry carries them', async () => {
    const { db, orgAId } = env;
    const pilotId = await seedOrgMember(db, orgAId, `catcls-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, env.userAId, 'owner');
    const { ticketId, aircraftId } = await openCloseFlight(db, staffSess, pilotId, 800.0, 800.5);

    const upd = await updateAircraftWithDb(db, staffSess, {
      resourceId: aircraftId,
      category: 'Airplane',
      aircraftClass: 'ASEL',
    });
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    expect(upd.aircraft.category).toBe('Airplane');
    expect(upd.aircraft.aircraftClass).toBe('ASEL');

    const log = await getMyPilotLogWithDb(db, makeSession(orgAId, pilotId, 'renter'));
    const entry = log.entries.find((e) => e.ticketId === ticketId);
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('Airplane');
    expect(entry!.aircraftClass).toBe('ASEL');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// CSV — annotation + category/class columns
// ════════════════════════════════════════════════════════════════════════════════

describe('CSV: exports include Night / Instrument / XC / CategoryClass / Remarks', () => {
  it('self export carries the annotated values; un-annotated cells are empty', async () => {
    const { db, orgAId } = env;
    const pilotId = await seedOrgMember(db, orgAId, `csv-ann-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, env.userAId, 'owner');
    const flight1 = await openCloseFlight(db, staffSess, pilotId, 900.0, 901.2);
    const flight2 = await openCloseFlight(db, staffSess, pilotId, 950.0, 950.5); // un-annotated

    await updateAircraftWithDb(db, staffSess, {
      resourceId: flight1.aircraftId,
      category: 'Airplane',
      aircraftClass: 'ASEL',
    });

    const sessPilot = makeSession(orgAId, pilotId, 'renter');
    const ann = await annotateFlightWithDb(db, sessPilot, {
      dispatchTicketId: flight1.ticketId,
      nightHours: 1.2,
      instrumentHours: 0.4,
      crossCountryHours: 1.0,
      remarks: 'annotated row',
    });
    expect(ann.ok).toBe(true);

    const result = await exportMyPilotLogCsvWithDb(db, sessPilot);
    const parsed = parseCsv(result.csv);
    expect(parsed.headers).toContain('Night');
    expect(parsed.headers).toContain('Instrument');
    expect(parsed.headers).toContain('XC');
    expect(parsed.headers).toContain('CategoryClass');
    expect(parsed.headers).toContain('Remarks');

    const row1 = parsed.rows.find((r) => r['Ticket ID'] === flight1.ticketId);
    expect(row1).toBeDefined();
    expect(row1!['Night']).toBe('1.2');
    expect(row1!['Instrument']).toBe('0.4');
    expect(row1!['XC']).toBe('1.0');
    expect(row1!['CategoryClass']).toBe('Airplane / ASEL');
    expect(row1!['Remarks']).toBe('annotated row');

    const row2 = parsed.rows.find((r) => r['Ticket ID'] === flight2.ticketId);
    expect(row2).toBeDefined();
    expect(row2!['Night']).toBe('');
    expect(row2!['Instrument']).toBe('');
    expect(row2!['XC']).toBe('');
    expect(row2!['Remarks']).toBe('');
  });

  it('staff export carries the annotation columns too', async () => {
    const { db, orgAId } = env;
    const pilotId = await seedOrgMember(db, orgAId, `csv-staff-ann-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, env.userAId, 'owner');
    const { ticketId } = await openCloseFlight(db, staffSess, pilotId, 960.0, 960.9);

    await annotateFlightWithDb(db, staffSess, {
      dispatchTicketId: ticketId,
      nightHours: 0.9,
    });

    const result = await exportPilotLogCsvWithDb(db, staffSess, { userId: pilotId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseCsv(result.csv);
    const row = parsed.rows.find((r) => r['Ticket ID'] === ticketId);
    expect(row).toBeDefined();
    expect(row!['Night']).toBe('0.9');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// AUDIT
// ════════════════════════════════════════════════════════════════════════════════

describe('AUDIT: exactly one logbook.flight_annotated row per annotate call', () => {
  it('writes one audit row with the annotation metadata', async () => {
    const { db, orgAId } = env;
    const pilotId = await seedOrgMember(db, orgAId, `audit-ann-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, env.userAId, 'owner');
    const { ticketId } = await openCloseFlight(db, staffSess, pilotId, 970.0, 970.5);

    const before = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.action, 'logbook.flight_annotated'), eq(auditLog.entityId, ticketId)))
        .execute(),
    );

    const sessPilot = makeSession(orgAId, pilotId, 'renter');
    const result = await annotateFlightWithDb(db, sessPilot, {
      dispatchTicketId: ticketId,
      nightHours: 0.5,
      remarks: 'audited',
    });
    expect(result.ok).toBe(true);

    const after = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.action, 'logbook.flight_annotated'), eq(auditLog.entityId, ticketId)))
        .execute(),
    );

    expect(after.length - before.length).toBe(1);
    const row = after[after.length - 1]!;
    expect(row.actorUserId).toBe(pilotId);
    const meta = row.metadata as Record<string, unknown>;
    expect(meta['pilotUserId']).toBe(pilotId);
    expect(meta['nightHours']).toBe(0.5);
    expect(meta['self']).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T-ISO — tenant isolation
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO — tenant isolation', () => {
  it("an org-B owner cannot annotate an org-A ticket (not_found; nothing persisted)", async () => {
    const { db, orgAId, orgBId } = env;
    const pilotA = await seedOrgMember(db, orgAId, `iso-a-${Date.now()}@test.com`, 'renter');
    const staffSessA = makeSession(orgAId, env.userAId, 'owner');
    const { ticketId } = await openCloseFlight(db, staffSessA, pilotA, 980.0, 980.5);

    const sessB = makeSession(orgBId, env.userBId, 'owner');
    const result = await annotateFlightWithDb(db, sessB, {
      dispatchTicketId: ticketId,
      nightHours: 1.0,
      remarks: 'cross-org attempt',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });

    // The org-A log is untouched.
    const log = await getMyPilotLogWithDb(db, makeSession(orgAId, pilotA, 'renter'));
    const entry = log.entries.find((e) => e.ticketId === ticketId);
    expect(entry).toBeDefined();
    expect(entry!.nightHours).toBeNull();
    expect(entry!.remarks).toBeNull();
  });

  it("a tampered session (orgB GUC + a real orgA userId) still cannot reach the orgA ticket", async () => {
    const { db, orgAId, orgBId } = env;
    const pilotA = await seedOrgMember(db, orgAId, `iso-tamper-${Date.now()}@test.com`, 'renter');
    const staffSessA = makeSession(orgAId, env.userAId, 'owner');
    const { ticketId } = await openCloseFlight(db, staffSessA, pilotA, 990.0, 990.5);

    // Attacker: org GUC = org B, userId = the REAL org-A pilot. RLS scopes
    // dispatch_ticket to org B → the ticket is invisible → not_found.
    const tamperedSess = makeSession(orgBId, pilotA, 'renter');
    const result = await annotateFlightWithDb(db, tamperedSess, {
      dispatchTicketId: ticketId,
      nightHours: 1.0,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});
