/**
 * logbook-api.test.ts — API integration tests for Slice P2: Pilot Logbook
 * (derived, read-only + CSV export).
 *
 * Applies migrations 0000–0037 (Slice P2-LOG2 added logbook_annotation +
 * resource.category/aircraft_class — 0037 — which readPilotLog now joins;
 * the annotation command itself is covered in logbook-annotation.test.ts).
 *
 * COVERAGE (per slice-p2-logbook.md §6):
 *   Happy path getMyPilotLog: closed tickets DESC by closed_at, entry shape.
 *   flightTimeHours === deriveFlightTime for every entry.
 *   Running total: tenths-exact cumulative; grand total == sum; newest carries total.
 *   Voided + open tickets excluded.
 *   Self-scope: caller A never sees caller B's flights (same org).
 *   T-ISO (adversarial): cross-org pilot_user_id collision never leaks; staff
 *     getPilotLog for a foreign-org userId → not_found.
 *   Date filtering: from inclusive / to exclusive; from>to and non-ISO → ValidationError.
 *   Empty history: {entries:[],totalHours:0}; staff path ok:true empty (not not_found).
 *   Staff caps: getPilotLog/exportPilotLogCsv require people:access;
 *     getMyPilotLog/exportMyPilotLogCsv require portal:access.
 *   CSV export: header+rows; round-trips via parseCsv; deterministic filename.
 *   Audit: exactly one 'pilot_log.exported' row per export; correct self/entryCount;
 *     no PII in metadata. Non-export reads write zero audit rows.
 *   Frozen guard: this suite imports deriveFlightTime + openDispatchWithDb/
 *     closeDispatchWithDb ONLY to seed fixtures — it never edits
 *     dispatch/open-dispatch.ts, dispatch/close-dispatch.ts, or
 *     gatedCreateOccurrence (verify via `git diff` on those three files — must
 *     stay empty for this slice).
 *
 * Setup mirrors documents-api.test.ts: createTestClient() →
 * applyMigrationSql([0000–0030]) → seedTwoOrgs → setTestAppRole.
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
  appUser,
  membership,
  auditLog,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import { sql as drizzleSql } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';
import { parseCsv, deriveFlightTime } from '@aeroops/core';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { voidDispatchWithDb } from '../dispatch/void-dispatch.js';
import { updateAircraftWithDb } from '../fleet/update-aircraft.js';

import { getMyPilotLogWithDb } from '../logbook/get-my-pilot-log.js';
import { getPilotLogWithDb } from '../logbook/get-pilot-log.js';
import { exportMyPilotLogCsvWithDb } from '../logbook/export-my-pilot-log-csv.js';
import { exportPilotLogCsvWithDb } from '../logbook/export-pilot-log-csv.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// ── Path resolution ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function migrationSql(name: string): string {
  return readFileSync(resolve(__dirname, `../../../db/migrations/${name}`), 'utf-8');
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
  migrationSql('0020_demo_reset_state.sql'),
  migrationSql('0021_qbo_integration.sql'),
  migrationSql('0022_billing_ledger.sql'),
  migrationSql('0023_stripe_foundation.sql'),
  migrationSql('0024_payment_methods_autopay.sql'),
  migrationSql('0025_recurring_dues.sql'),
  migrationSql('0026_notifications.sql'),
  migrationSql('0027_data_import.sql'),
  migrationSql('0028_calendar_feed.sql'),
  migrationSql('0029_maintenance_due.sql'),
  migrationSql('0030_documents.sql'),
  migrationSql('0031_pos_sales.sql'),
  migrationSql('0032_lesson_signature.sql'),
  migrationSql('0033_mobile_session.sql'),
  migrationSql('0034_block_time.sql'),
  migrationSql('0035_study_grant.sql'),
  migrationSql('0036_member_message.sql'),
  // Slice P2-LOG2: readPilotLog now LEFT JOINs logbook_annotation +
  // resource.category/aircraft_class — 0037 is required for these reads.
  migrationSql('0037_logbook_annotation.sql'),
  migrationSql('0038_stage_check_enforcement.sql'),
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

// Reservation windows — future slots so booking-policy min-advance checks pass.
const D = '2026-07-15';
let tagCounter = 0;

let sharedEnv: TestEnv;

/** Seed a second org member with a membership. Returns userId. */
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

/** Create a fresh aircraft + reservation, then open + close a dispatch ticket. Returns the ticket id. */
async function openCloseFlight(
  db: PgliteTestClient,
  sess: AppSession,
  pilotUserId: string,
  hobbsOut: number,
  hobbsIn: number,
): Promise<{ ticketId: string; aircraftId: string }> {
  tagCounter += 1;
  const tag = `LOG${tagCounter}`;
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

/** Create a fresh aircraft + reservation, open a dispatch ticket, then VOID it (never closed). */
async function openVoidFlight(
  db: PgliteTestClient,
  sess: AppSession,
  pilotUserId: string,
  hobbsOut: number,
): Promise<string> {
  tagCounter += 1;
  const tag = `LOGV${tagCounter}`;
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

  const voidResult = await voidDispatchWithDb(db, sess, {
    ticketId: openResult.ticket.id,
    reason: 'test void',
  });
  if (!voidResult.ok) throw new Error(`seed void failed: ${voidResult.reason}`);

  return openResult.ticket.id;
}

/** Create a fresh aircraft + reservation and open a dispatch ticket that stays OPEN. */
async function openOnlyFlight(
  db: PgliteTestClient,
  sess: AppSession,
  pilotUserId: string,
  hobbsOut: number,
): Promise<string> {
  tagCounter += 1;
  const tag = `LOGO${tagCounter}`;
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

/** Backdate a ticket's closed_at for date-bounds testing (ISO string + ::timestamptz — never a raw JS Date). */
async function backdateClosedAt(
  db: PgliteTestClient,
  orgId: string,
  ticketId: string,
  date: Date,
): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    await tx.execute(
      drizzleSql`UPDATE dispatch_ticket SET closed_at = ${date.toISOString()}::timestamptz WHERE id = ${ticketId}`,
    );
  });
}

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

// ════════════════════════════════════════════════════════════════════════════════
// HAPPY PATH: getMyPilotLog
// ════════════════════════════════════════════════════════════════════════════════

describe('HAPPY PATH: getMyPilotLog', () => {
  it('returns closed tickets DESC by closed_at with correct entry shape', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const f1 = await openCloseFlight(db, sess, userAId, 1000.0, 1001.5);
    const f2 = await openCloseFlight(db, sess, userAId, 2000.0, 2000.0); // ground check-out

    await updateAircraftWithDb(db, sess, {
      resourceId: f1.aircraftId,
      make: 'Cessna',
      model: '172',
    });

    const log = await getMyPilotLogWithDb(db, sess);

    const e1 = log.entries.find((e) => e.ticketId === f1.ticketId);
    const e2 = log.entries.find((e) => e.ticketId === f2.ticketId);
    expect(e1).toBeDefined();
    expect(e2).toBeDefined();

    expect(e1!.hobbsOut).toBeCloseTo(1000.0);
    expect(e1!.hobbsIn).toBeCloseTo(1001.5);
    expect(e1!.flightTimeHours).toBeCloseTo(1.5);
    expect(e1!.make).toBe('Cessna');
    expect(e1!.model).toBe('172');
    expect(e1!.date).toBeInstanceOf(Date);
    expect(typeof e1!.tail).toBe('string');

    expect(e2!.flightTimeHours).toBe(0);

    // DESC order by closed_at — f2 closed after f1 (created later in this test).
    const i1 = log.entries.findIndex((e) => e.ticketId === f1.ticketId);
    const i2 = log.entries.findIndex((e) => e.ticketId === f2.ticketId);
    expect(i2).toBeLessThan(i1);
  });

  it('flightTimeHours === deriveFlightTime(hobbsOut, hobbsIn) for every entry', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    await openCloseFlight(db, sess, userAId, 500.0, 502.3);
    await openCloseFlight(db, sess, userAId, 300.0, 300.1);

    const log = await getMyPilotLogWithDb(db, sess);
    for (const e of log.entries) {
      expect(e.flightTimeHours).toBeCloseTo(deriveFlightTime(e.hobbsOut, e.hobbsIn));
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// RUNNING TOTAL
// ════════════════════════════════════════════════════════════════════════════════

describe('RUNNING TOTAL: tenths-exact cumulative', () => {
  it('accumulates exactly for a run of 0.1-hour flights (no float drift)', async () => {
    const { db, orgAId } = sharedEnv;
    const pilotId = await seedOrgMember(db, orgAId, `rt-pilot-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, sharedEnv.userAId, 'owner');

    const N = 7;
    const tickets: string[] = [];
    for (let i = 0; i < N; i++) {
      const { ticketId } = await openCloseFlight(db, sess, pilotId, 100 + i, 100 + i + 0.1);
      tickets.push(ticketId);
    }

    const sessPilot = makeSession(orgAId, pilotId, 'renter');
    const log = await getMyPilotLogWithDb(db, sessPilot);

    expect(log.entries).toHaveLength(N);
    // Sum of entries === totalHours (exact, tenths grid).
    const sum = log.entries.reduce((acc, e) => acc + e.flightTimeHours, 0);
    expect(log.totalHours).toBeCloseTo(sum);
    expect(log.totalHours).toBeCloseTo(N * 0.1);

    // Newest row (index 0, DESC) carries the grand total.
    expect(log.entries[0]!.runningTotalHours).toBeCloseTo(log.totalHours);
    // Oldest row (last index) carries exactly one flight's worth.
    expect(log.entries[N - 1]!.runningTotalHours).toBeCloseTo(0.1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// EXCLUSIONS: voided + open tickets
// ════════════════════════════════════════════════════════════════════════════════

describe('EXCLUSIONS: voided and open tickets never appear', () => {
  it('a voided ticket is excluded from the log', async () => {
    const { db, orgAId } = sharedEnv;
    const pilotId = await seedOrgMember(db, orgAId, `void-pilot-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, sharedEnv.userAId, 'owner');

    const voidedTicketId = await openVoidFlight(db, sess, pilotId, 400.0);
    const { ticketId: closedTicketId } = await openCloseFlight(db, sess, pilotId, 500.0, 500.5);

    const sessPilot = makeSession(orgAId, pilotId, 'renter');
    const log = await getMyPilotLogWithDb(db, sessPilot);

    expect(log.entries.some((e) => e.ticketId === voidedTicketId)).toBe(false);
    expect(log.entries.some((e) => e.ticketId === closedTicketId)).toBe(true);
  });

  it('an open (not yet closed) ticket is excluded from the log', async () => {
    const { db, orgAId } = sharedEnv;
    const pilotId = await seedOrgMember(db, orgAId, `open-pilot-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, sharedEnv.userAId, 'owner');

    const openTicketId = await openOnlyFlight(db, sess, pilotId, 600.0);

    const sessPilot = makeSession(orgAId, pilotId, 'renter');
    const log = await getMyPilotLogWithDb(db, sessPilot);

    expect(log.entries.some((e) => e.ticketId === openTicketId)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SELF-SCOPE + T-ISO ADVERSARIAL
// ════════════════════════════════════════════════════════════════════════════════

describe('SELF-SCOPE: caller A never sees caller B flights (same org)', () => {
  it('two org-A pilots each see only their own closed tickets', async () => {
    const { db, orgAId } = sharedEnv;
    const pilotA = await seedOrgMember(db, orgAId, `selfscope-a-${Date.now()}@test.com`, 'renter');
    const pilotB = await seedOrgMember(db, orgAId, `selfscope-b-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, sharedEnv.userAId, 'owner');

    const { ticketId: ticketA } = await openCloseFlight(db, staffSess, pilotA, 700.0, 700.5);
    const { ticketId: ticketB } = await openCloseFlight(db, staffSess, pilotB, 800.0, 800.5);

    const logA = await getMyPilotLogWithDb(db, makeSession(orgAId, pilotA, 'renter'));
    const logB = await getMyPilotLogWithDb(db, makeSession(orgAId, pilotB, 'renter'));

    expect(logA.entries.some((e) => e.ticketId === ticketA)).toBe(true);
    expect(logA.entries.some((e) => e.ticketId === ticketB)).toBe(false);

    expect(logB.entries.some((e) => e.ticketId === ticketB)).toBe(true);
    expect(logB.entries.some((e) => e.ticketId === ticketA)).toBe(false);
  });
});

describe('T-ISO (adversarial): cross-org isolation', () => {
  it('a tampered session (orgB GUC + a real orgA userId) never leaks orgA flights', async () => {
    const { db, orgAId, orgBId, userAId } = sharedEnv;
    const staffSessA = makeSession(orgAId, userAId, 'owner');
    await openCloseFlight(db, staffSessA, userAId, 900.0, 900.5);

    // Attacker session: org GUC = org B, but userId = a REAL org-A user id
    // ("identical pilot_user_id" cross-org scenario). RLS scopes dispatch_ticket
    // rows to org B only — no org-A row exists with this pilot_user_id in org B
    // (composite FK ties pilot_user_id to its own org), so the result is empty.
    const tamperedSess = makeSession(orgBId, userAId, 'owner');
    const log = await getMyPilotLogWithDb(db, tamperedSess);
    expect(log.entries).toHaveLength(0);
    expect(log.totalHours).toBe(0);
  });

  it('staff getPilotLog for a foreign-org userId → not_found (no rows)', async () => {
    const { db, orgAId, orgBId, userBId } = sharedEnv;
    const sessB = makeSession(orgBId, userBId, 'owner');
    await openCloseFlight(db, sessB, userBId, 1100.0, 1100.5);

    const sessA = makeSession(orgAId, sharedEnv.userAId, 'owner');
    const result = await getPilotLogWithDb(db, sessA, { userId: userBId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// DATE FILTERING
// ════════════════════════════════════════════════════════════════════════════════

describe('DATE FILTERING: from inclusive / to exclusive', () => {
  it('bounds narrow the result; out-of-range excluded', async () => {
    const { db, orgAId } = sharedEnv;
    const pilotId = await seedOrgMember(db, orgAId, `datebound-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, sharedEnv.userAId, 'owner');

    const { ticketId: early } = await openCloseFlight(db, sess, pilotId, 10, 10.5);
    const { ticketId: middle } = await openCloseFlight(db, sess, pilotId, 20, 20.5);
    const { ticketId: late } = await openCloseFlight(db, sess, pilotId, 30, 30.5);

    await backdateClosedAt(db, orgAId, early, new Date('2026-01-01T00:00:00Z'));
    await backdateClosedAt(db, orgAId, middle, new Date('2026-02-01T00:00:00Z'));
    await backdateClosedAt(db, orgAId, late, new Date('2026-03-01T00:00:00Z'));

    const sessPilot = makeSession(orgAId, pilotId, 'renter');

    // [from, to) covering only `middle`.
    const log = await getMyPilotLogWithDb(db, sessPilot, {
      from: '2026-01-15T00:00:00.000Z',
      to: '2026-02-15T00:00:00.000Z',
    });
    expect(log.entries.map((e) => e.ticketId)).toEqual([middle]);

    // from is inclusive — exact boundary match included.
    const logInclusive = await getMyPilotLogWithDb(db, sessPilot, {
      from: '2026-02-01T00:00:00.000Z',
      to: '2026-02-15T00:00:00.000Z',
    });
    expect(logInclusive.entries.map((e) => e.ticketId)).toEqual([middle]);

    // to is exclusive — exact boundary match excluded.
    const logExclusive = await getMyPilotLogWithDb(db, sessPilot, {
      from: '2026-01-15T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });
    expect(logExclusive.entries).toHaveLength(0);
  });

  it('from > to → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      getMyPilotLogWithDb(db, sess, {
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('non-ISO date string → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      getMyPilotLogWithDb(db, sess, { from: 'not-a-date' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('staff getPilotLog: non-ISO date + from>to → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      getPilotLogWithDb(db, sess, { userId: userAId, to: 'garbage' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      getPilotLogWithDb(db, sess, {
        userId: userAId,
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// EMPTY HISTORY
// ════════════════════════════════════════════════════════════════════════════════

describe('EMPTY HISTORY', () => {
  it('getMyPilotLog: a member with no closed tickets → {entries:[],totalHours:0}', async () => {
    const { db, orgAId } = sharedEnv;
    const freshPilot = await seedOrgMember(db, orgAId, `empty-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, freshPilot, 'renter');

    const log = await getMyPilotLogWithDb(db, sess);
    expect(log).toEqual({ entries: [], totalHours: 0 });
  });

  it('staff getPilotLog: in-org member with zero closed tickets → ok:true empty (not not_found)', async () => {
    const { db, orgAId } = sharedEnv;
    const freshPilot = await seedOrgMember(db, orgAId, `staff-empty-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, sharedEnv.userAId, 'owner');

    const result = await getPilotLogWithDb(db, sess, { userId: freshPilot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.log).toEqual({ entries: [], totalHours: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// STAFF CAPS
// ════════════════════════════════════════════════════════════════════════════════

describe('STAFF CAPS', () => {
  it('getPilotLog: student (portal:access only, no people:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'student');
    await expect(getPilotLogWithDb(db, sess, { userId: userAId })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('getPilotLog: renter (portal:access only) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(getPilotLogWithDb(db, sess, { userId: userAId })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('getPilotLog: dispatcher (has people:access) → passes auth (empty or found result)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'dispatcher');
    const result = await getPilotLogWithDb(db, sess, { userId: userAId });
    expect(result.ok).toBe(true);
  });

  it('exportPilotLogCsv: renter → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(exportPilotLogCsvWithDb(db, sess, { userId: userAId })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('getMyPilotLog: accountant (no portal:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'accountant');
    await expect(getMyPilotLogWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('getMyPilotLog: mechanic (no portal:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'mechanic');
    await expect(getMyPilotLogWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('getMyPilotLog: null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(getMyPilotLogWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('getPilotLog: null session → UnauthenticatedError', async () => {
    const { db, userAId } = sharedEnv;
    await expect(getPilotLogWithDb(db, null, { userId: userAId })).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// CSV EXPORT
// ════════════════════════════════════════════════════════════════════════════════

describe('CSV EXPORT', () => {
  it('exportMyPilotLogCsv: header + rows round-trip via parseCsv; deterministic filename', async () => {
    const { db, orgAId } = sharedEnv;
    const pilotId = await seedOrgMember(db, orgAId, `csv-self-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, sharedEnv.userAId, 'owner');
    await openCloseFlight(db, staffSess, pilotId, 1200.0, 1201.5);
    await openCloseFlight(db, staffSess, pilotId, 1300.0, 1300.0);

    const sess = makeSession(orgAId, pilotId, 'renter');
    const log = await getMyPilotLogWithDb(db, sess);
    const result = await exportMyPilotLogCsvWithDb(db, sess);

    expect(result.filename).toMatch(/^pilot-logbook-\d{8}\.csv$/);

    const parsed = parseCsv(result.csv);
    expect(parsed.headers).toEqual([
      'Date', 'Tail', 'Make', 'Model', 'Hobbs Out', 'Hobbs In',
      'Flight Time (hrs)', 'Running Total (hrs)',
      'Night', 'Instrument', 'XC', 'CategoryClass', 'Remarks',
      'Ticket ID',
    ]);
    expect(parsed.rows).toHaveLength(log.entries.length);
    for (let i = 0; i < log.entries.length; i++) {
      const e = log.entries[i]!;
      const row = parsed.rows[i]!;
      expect(row['Ticket ID']).toBe(e.ticketId);
      expect(row['Hobbs Out']).toBe(e.hobbsOut.toFixed(1));
      expect(row['Hobbs In']).toBe(e.hobbsIn.toFixed(1));
      expect(row['Flight Time (hrs)']).toBe(e.flightTimeHours.toFixed(1));
      expect(row['Running Total (hrs)']).toBe(e.runningTotalHours.toFixed(1));
      expect(row['Date']).toBe(e.date.toISOString());
    }
  });

  it('exportPilotLogCsv: staff export of a member with a comma/quote in tail → correctly escaped + round-trips', async () => {
    const { db, orgAId } = sharedEnv;
    const pilotId = await seedOrgMember(db, orgAId, `csv-staff-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, sharedEnv.userAId, 'owner');
    const { ticketId, aircraftId } = await openCloseFlight(db, staffSess, pilotId, 1400.0, 1400.7);

    // Force an unusual tail containing a comma + quote to exercise escaping.
    await withOrgContext(db, orgAId, async (tx) => {
      await tx.execute(
        drizzleSql`UPDATE resource SET tail_number = ${'N-1,"weird"'} WHERE id = ${aircraftId}`,
      );
    });

    const result = await exportPilotLogCsvWithDb(db, staffSess, { userId: pilotId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parseCsv(result.csv);
    const row = parsed.rows.find((r) => r['Ticket ID'] === ticketId);
    expect(row).toBeDefined();
    expect(row!['Tail']).toBe('N-1,"weird"');
  });

  it('exportPilotLogCsv: nonexistent/foreign userId → not_found', async () => {
    const { db, orgAId, orgBId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, sharedEnv.userAId, 'owner');
    const result = await exportPilotLogCsvWithDb(db, sessA, { userId: userBId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
    void orgBId;
  });

  it('empty history CSV export → header only, no data rows', async () => {
    const { db, orgAId } = sharedEnv;
    const freshPilot = await seedOrgMember(db, orgAId, `csv-empty-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, freshPilot, 'renter');
    const result = await exportMyPilotLogCsvWithDb(db, sess);
    const parsed = parseCsv(result.csv);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.headers.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// AUDIT
// ════════════════════════════════════════════════════════════════════════════════

describe('AUDIT: exactly one pilot_log.exported row per export; reads write none', () => {
  it('exportMyPilotLogCsv writes exactly one audit row with self:true + correct entryCount', async () => {
    const { db, orgAId } = sharedEnv;
    const pilotId = await seedOrgMember(db, orgAId, `audit-self-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, sharedEnv.userAId, 'owner');
    await openCloseFlight(db, staffSess, pilotId, 1500.0, 1500.5);
    await openCloseFlight(db, staffSess, pilotId, 1600.0, 1601.0);

    const sess = makeSession(orgAId, pilotId, 'renter');

    const before = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.action, 'pilot_log.exported'), eq(auditLog.entityId, pilotId)))
        .execute(),
    );

    await exportMyPilotLogCsvWithDb(db, sess);

    const after = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.action, 'pilot_log.exported'), eq(auditLog.entityId, pilotId)))
        .execute(),
    );

    expect(after.length - before.length).toBe(1);
    const row = after[after.length - 1]!;
    const meta = row.metadata as Record<string, unknown>;
    expect(meta['self']).toBe(true);
    expect(meta['entryCount']).toBe(2);
    // No PII: only ids/dates/counts.
    expect(Object.keys(meta).sort()).toEqual(['entryCount', 'from', 'self', 'to'].sort());
  });

  it('exportPilotLogCsv (staff) writes exactly one audit row with self:false', async () => {
    const { db, orgAId } = sharedEnv;
    const pilotId = await seedOrgMember(db, orgAId, `audit-staff-${Date.now()}@test.com`, 'renter');
    const staffSess = makeSession(orgAId, sharedEnv.userAId, 'owner');
    await openCloseFlight(db, staffSess, pilotId, 1700.0, 1700.5);

    const before = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.action, 'pilot_log.exported'), eq(auditLog.entityId, pilotId)))
        .execute(),
    );

    await exportPilotLogCsvWithDb(db, staffSess, { userId: pilotId });

    const after = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.action, 'pilot_log.exported'), eq(auditLog.entityId, pilotId)))
        .execute(),
    );

    expect(after.length - before.length).toBe(1);
    const row = after[after.length - 1]!;
    const meta = row.metadata as Record<string, unknown>;
    expect(meta['self']).toBe(false);
    expect(meta['entryCount']).toBe(1);
  });

  it('getMyPilotLog / getPilotLog (non-export reads) write zero audit rows', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const before = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(eq(auditLog.action, 'pilot_log.exported'))
        .execute(),
    );

    await getMyPilotLogWithDb(db, sess);
    await getPilotLogWithDb(db, sess, { userId: userAId });

    const after = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(eq(auditLog.action, 'pilot_log.exported'))
        .execute(),
    );

    expect(after.length).toBe(before.length);
  });
});
