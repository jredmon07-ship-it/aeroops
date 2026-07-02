/**
 * reschedule-api.test.ts — API integration + property suite for SCHED-2c
 * (Slice 2c reschedule). ADR-0006 §6 + Addendum.
 *
 * Reschedule = atomic cancel-original + recreate through the shared
 * gatedCreateOccurrence; throw-to-rollback keeps the original intact on any
 * gate refusal or race. These tests prove that atomicity end-to-end against the
 * real EXCLUDE constraint + RLS (pglite + btree_gist).
 *
 * Covers spec §6:
 *   1  happy: original cancelled, new booked new window series_id NULL, 3 audits
 *   2  refused-conflict → ORIGINAL INTACT (full rollback)
 *   3  refused-policy → intact
 *   4  conflict_and_policy → intact
 *   5  not_found cross-org
 *   6  overlapping-self slot succeeds (cancel frees window first)
 *   7  zero-delta same-slot succeeds
 *   8  multi-resource: target conflicts only on instructor → whole reschedule
 *      refused, neither moved
 *   9  resource swap → ok
 *   10 series detach → new row series_id NULL, listSeriesOccurrences excludes it
 *   11 validation end<=start throws
 *   12 cross-org/inactive newResourceIds throws + original intact
 *   13 already-cancelled original → not_found
 *   14 authz (no create cap → Forbidden, null → Unauthenticated)
 *   15 PROPERTY: reschedule never double-books
 *   16 PROPERTY: atomicity (ok:false → DB byte-identical; ok:true → exactly one
 *      cancelled + one new booked)
 *   17 RACE: competing booked row in target window before INSERT → conflict,
 *      original preserved
 *
 * Setup mirrors recurrence-api.test.ts: createTestClient() →
 * applyMigrationSql([0000–0004], loads btree_gist) → seedTwoOrgs → setTestAppRole.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import * as fc from 'fast-check';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
} from '@aeroops/db';
import { auditLog, reservation, reservationResource } from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient, AnyDb } from '@aeroops/db';

import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createSeriesWithDb } from '../scheduling/create-series.js';
import { listSeriesOccurrencesWithDb } from '../scheduling/list-series-occurrences.js';
import { createBlackoutWithDb } from '../scheduling/blackout-commands.js';
import { rescheduleReservationWithDb } from '../scheduling/reschedule-reservation.js';
import { ValidationError } from '../scheduling/internal.js';
import * as internalModule from '../scheduling/internal.js';
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
  // 0005 required: 0006 references dispatch_ticket(id, org_id) (FK candidate key).
  readFileSync(resolve(__dirname, '../../../db/migrations/0005_dispatch.sql'), 'utf-8'),
  // 0006 required: gatedCreateOccurrence's warn-only grounding step (ADR-0008
  // §2.3) reads aircraft_grounding on the success path; the table must exist.
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
  readFileSync(resolve(__dirname, '../../../db/migrations/0016_booking_request_convert.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0017_booking_retention.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0018_dispatch_ticket_correction.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0019_billing_records.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0020_demo_reset_state.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0021_qbo_integration.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0022_billing_ledger.sql'), 'utf-8'),
];

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

// A deterministic "now": 2026-01-05T00:00:00Z (Monday). All test windows live
// well after this so minAdvance policies are clean unless a test sets one.
const BASE_NOW = Date.UTC(2026, 0, 5);

// Windows used across tests (all far in the future relative to BASE_NOW).
const W1_start = new Date('2026-03-02T10:00:00Z');
const W1_end = new Date('2026-03-02T11:00:00Z');
const W2_start = new Date('2026-03-02T14:00:00Z');
const W2_end = new Date('2026-03-02T15:00:00Z');
// W1b overlaps W1 (self-overlap target).
const W1b_start = new Date('2026-03-02T10:30:00Z');
const W1b_end = new Date('2026-03-02T11:30:00Z');

let sharedEnv: TestEnv;
let tailCounter = 0;
function uniqueTail(): string {
  tailCounter += 1;
  return `NR${String(tailCounter).padStart(4, '0')}`;
}

async function mkAircraft(db: AnyDb, sess: AppSession, name: string) {
  return createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: name,
    tailNumber: uniqueTail(),
  });
}
async function mkInstructor(db: AnyDb, sess: AppSession, name: string, instructorUserId: string) {
  return createResourceWithDb(db, sess, {
    kind: 'instructor',
    displayName: name,
    instructorUserId,
  });
}

// Snapshot helper: capture the full reservation + reservation_resource + audit
// state for an org so atomicity tests can assert byte-identical rollback.
async function snapshotOrg(db: AnyDb, orgId: string) {
  return withOrgContext(db, orgId, async (tx) => {
    const resv = await (tx as AnyDb).select().from(reservation).execute();
    const join = await (tx as AnyDb).select().from(reservationResource).execute();
    const audit = await (tx as AnyDb).select().from(auditLog).execute();
    // Sort deterministically for comparison.
    const norm = (rows: any[]) =>
      JSON.stringify(
        rows
          .map((r) => JSON.parse(JSON.stringify(r)))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      );
    return { resv: norm(resv), join: norm(join), audit: norm(audit) };
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

afterEach(() => {
  vi.restoreAllMocks();
});

// Helpers to read booked join rows / audit rows for a reservation.
async function bookedResourceIds(db: AnyDb, orgId: string, reservationId: string) {
  return withOrgContext(db, orgId, async (tx) => {
    const rows = await (tx as AnyDb)
      .select()
      .from(reservationResource)
      .where(eq(reservationResource.reservationId, reservationId))
      .execute();
    return rows.filter((r: any) => r.status === 'booked').map((r: any) => r.resourceId);
  });
}
async function reservationRow(db: AnyDb, orgId: string, reservationId: string) {
  return withOrgContext(db, orgId, async (tx) => {
    const rows = await (tx as AnyDb)
      .select()
      .from(reservation)
      .where(eq(reservation.id, reservationId))
      .execute();
    return rows[0];
  });
}
async function auditRowsFor(db: AnyDb, orgId: string, entityId: string) {
  return withOrgContext(db, orgId, async (tx) => {
    const rows = await (tx as AnyDb)
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, entityId))
      .execute();
    return rows;
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// 1 — HAPPY PATH
// ════════════════════════════════════════════════════════════════════════════════

describe('1 — happy reschedule', () => {
  it('original cancelled, new booked at new window, series_id NULL, audit linkage', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const ac = await mkAircraft(db, sess, 'N-Happy');

    const created = await createReservationWithDb(
      db,
      sess,
      { startAt: W1_start, endAt: W1_end, resourceIds: [ac.id], notes: 'lesson 1' },
      { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');
    const originalId = created.reservation.id;

    const result = await rescheduleReservationWithDb(
      db,
      sess,
      { reservationId: originalId, newStartAt: W2_start, newEndAt: W2_end },
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const newId = result.reservation.id;
    expect(newId).not.toBe(originalId);
    expect(result.reservation.startAt.getTime()).toBe(W2_start.getTime());
    expect(result.reservation.endAt.getTime()).toBe(W2_end.getTime());
    // Notes preserved.
    expect(result.reservation.notes).toBe('lesson 1');

    // Original is cancelled.
    const orig = await reservationRow(db, orgAId, originalId);
    expect(orig!.status).toBe('cancelled');
    expect(orig!.cancelledBy).toBe(userAId);

    // New row booked at the new window, series_id NULL.
    const fresh = await reservationRow(db, orgAId, newId);
    expect(fresh!.status).toBe('booked');
    expect(fresh!.seriesId).toBeNull();

    // Exactly the new window is booked on the resource.
    const booked = await bookedResourceIds(db, orgAId, newId);
    expect(booked).toEqual([ac.id]);

    // Audit linkage: reservation.cancelled (original), reservation.created (new),
    // reservation.rescheduled (new). 3 rows total across the two entities.
    const origAudit = await auditRowsFor(db, orgAId, originalId);
    const newAudit = await auditRowsFor(db, orgAId, newId);
    const cancelled = origAudit.filter((r: any) => r.action === 'reservation.cancelled');
    const createdAudit = newAudit.filter((r: any) => r.action === 'reservation.created');
    const rescheduled = newAudit.filter((r: any) => r.action === 'reservation.rescheduled');
    expect(cancelled).toHaveLength(1);
    expect(createdAudit).toHaveLength(1);
    expect(rescheduled).toHaveLength(1);
    expect((cancelled[0] as any).metadata).toMatchObject({ reason: 'reschedule', rescheduledTo: newId });
    expect((rescheduled[0] as any).metadata).toMatchObject({ rescheduledFrom: originalId });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 / 3 / 4 — REFUSAL → ORIGINAL INTACT (full rollback)
// ════════════════════════════════════════════════════════════════════════════════

describe('2/3/4 — refusal leaves original intact (throw-to-rollback)', () => {
  it('2 — refused-conflict: original still booked, no new row, no new audit', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const ac = await mkAircraft(db, sess, 'N-Conf');

    // Occupy the TARGET window with a blocker on the same aircraft.
    const blocker = await createReservationWithDb(
      db, sess, { startAt: W2_start, endAt: W2_end, resourceIds: [ac.id] }, { now: BASE_NOW },
    );
    if (!blocker.ok) throw new Error('blocker create failed');

    // Original sits at W1.
    const created = await createReservationWithDb(
      db, sess, { startAt: W1_start, endAt: W1_end, resourceIds: [ac.id] }, { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');
    const originalId = created.reservation.id;

    const before = await snapshotOrg(db, orgAId);

    const result = await rescheduleReservationWithDb(
      db, sess,
      { reservationId: originalId, newStartAt: W2_start, newEndAt: W2_end },
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('conflict');

    // Original STILL booked at its original window.
    const orig = await reservationRow(db, orgAId, originalId);
    expect(orig!.status).toBe('booked');
    expect(await bookedResourceIds(db, orgAId, originalId)).toEqual([ac.id]);

    // DB byte-identical to pre-call (no new reservation, no new audit row).
    const after = await snapshotOrg(db, orgAId);
    expect(after).toEqual(before);
  });

  it('3 — refused-policy: original intact', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const ac = await mkAircraft(db, sess, 'N-Pol');

    // Blackout covers the TARGET window (forces a policy refusal there).
    await createBlackoutWithDb(db, sess, {
      resourceId: ac.id,
      startAt: W2_start,
      endAt: W2_end,
      reason: 'maintenance',
    });

    const created = await createReservationWithDb(
      db, sess, { startAt: W1_start, endAt: W1_end, resourceIds: [ac.id] }, { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');
    const originalId = created.reservation.id;

    const before = await snapshotOrg(db, orgAId);
    const result = await rescheduleReservationWithDb(
      db, sess,
      { reservationId: originalId, newStartAt: W2_start, newEndAt: W2_end },
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('policy');

    const orig = await reservationRow(db, orgAId, originalId);
    expect(orig!.status).toBe('booked');
    const after = await snapshotOrg(db, orgAId);
    expect(after).toEqual(before);
  });

  it('4 — conflict_and_policy via blocker-then-blackout: original intact', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const ac = await mkAircraft(db, sess, 'N-Both2');

    // 1) Book the target window FIRST (commits cleanly — no blackout yet).
    const blocker = await createReservationWithDb(
      db, sess, { startAt: W2_start, endAt: W2_end, resourceIds: [ac.id] }, { now: BASE_NOW },
    );
    if (!blocker.ok) throw new Error('blocker create failed');
    // 2) THEN add a blackout over the same window → target now fails both gates.
    await createBlackoutWithDb(db, sess, {
      resourceId: ac.id, startAt: W2_start, endAt: W2_end, reason: 'mx',
    });

    const created = await createReservationWithDb(
      db, sess, { startAt: W1_start, endAt: W1_end, resourceIds: [ac.id] }, { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');
    const originalId = created.reservation.id;

    const before = await snapshotOrg(db, orgAId);
    const result = await rescheduleReservationWithDb(
      db, sess,
      { reservationId: originalId, newStartAt: W2_start, newEndAt: W2_end },
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('conflict_and_policy');

    const orig = await reservationRow(db, orgAId, originalId);
    expect(orig!.status).toBe('booked');
    const after = await snapshotOrg(db, orgAId);
    expect(after).toEqual(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5 — NOT FOUND (cross-org)
// ════════════════════════════════════════════════════════════════════════════════

describe('5 — not_found', () => {
  it('cross-org reservationId → not_found, no write', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');
    const acA = await mkAircraft(db, sessA, 'N-OrgA');

    const created = await createReservationWithDb(
      db, sessA, { startAt: W1_start, endAt: W1_end, resourceIds: [acA.id] }, { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');

    // Org B tries to reschedule org A's reservation.
    const result = await rescheduleReservationWithDb(
      db, sessB,
      { reservationId: created.reservation.id, newStartAt: W2_start, newEndAt: W2_end },
      { now: BASE_NOW },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not_found');
    expect(result.reason).toBe('not_found');

    // Original (org A) untouched.
    const orig = await reservationRow(db, orgAId, created.reservation.id);
    expect(orig!.status).toBe('booked');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 6 — OVERLAPPING-SELF SLOT SUCCEEDS (highest value)
// ════════════════════════════════════════════════════════════════════════════════

describe('6 — overlapping-self slot', () => {
  it('reschedule onto a window that overlaps the original succeeds (cancel frees first)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const ac = await mkAircraft(db, sess, 'N-Self');

    const created = await createReservationWithDb(
      db, sess, { startAt: W1_start, endAt: W1_end, resourceIds: [ac.id] }, { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');
    const originalId = created.reservation.id;

    // Target W1b overlaps W1 on the SAME aircraft → must succeed because the
    // cancel frees the original's window before the recreate.
    const result = await rescheduleReservationWithDb(
      db, sess,
      { reservationId: originalId, newStartAt: W1b_start, newEndAt: W1b_end },
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.reservation.startAt.getTime()).toBe(W1b_start.getTime());

    const orig = await reservationRow(db, orgAId, originalId);
    expect(orig!.status).toBe('cancelled');
    expect(await bookedResourceIds(db, orgAId, result.reservation.id)).toEqual([ac.id]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 7 — ZERO-DELTA SAME SLOT
// ════════════════════════════════════════════════════════════════════════════════

describe('7 — zero-delta', () => {
  it('reschedule to the identical window succeeds', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const ac = await mkAircraft(db, sess, 'N-Zero');

    const created = await createReservationWithDb(
      db, sess, { startAt: W1_start, endAt: W1_end, resourceIds: [ac.id] }, { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');

    const result = await rescheduleReservationWithDb(
      db, sess,
      { reservationId: created.reservation.id, newStartAt: W1_start, newEndAt: W1_end },
      { now: BASE_NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.reservation.id).not.toBe(created.reservation.id);
    expect(result.reservation.startAt.getTime()).toBe(W1_start.getTime());
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 8 — MULTI-RESOURCE all-or-nothing
// ════════════════════════════════════════════════════════════════════════════════

describe('8 — multi-resource all-or-nothing', () => {
  it('target conflicts only on the instructor → whole reschedule refused, neither moved', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const ac = await mkAircraft(db, sess, 'N-Multi');
    const inst = await mkInstructor(db, sess, 'CFI-Multi', userAId);

    // Original holds BOTH aircraft + instructor at W1.
    const created = await createReservationWithDb(
      db, sess, { startAt: W1_start, endAt: W1_end, resourceIds: [ac.id, inst.id] }, { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');
    const originalId = created.reservation.id;

    // The INSTRUCTOR is busy in the target window (aircraft is free there).
    const instBlocker = await createReservationWithDb(
      db, sess, { startAt: W2_start, endAt: W2_end, resourceIds: [inst.id] }, { now: BASE_NOW },
    );
    if (!instBlocker.ok) throw new Error('inst blocker create failed');

    const before = await snapshotOrg(db, orgAId);
    const result = await rescheduleReservationWithDb(
      db, sess,
      { reservationId: originalId, newStartAt: W2_start, newEndAt: W2_end },
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('conflict');

    // Original STILL holds BOTH resources at W1 (neither moved).
    const orig = await reservationRow(db, orgAId, originalId);
    expect(orig!.status).toBe('booked');
    const stillBooked = await bookedResourceIds(db, orgAId, originalId);
    expect(stillBooked.sort()).toEqual([ac.id, inst.id].sort());

    const after = await snapshotOrg(db, orgAId);
    expect(after).toEqual(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 9 — RESOURCE SWAP
// ════════════════════════════════════════════════════════════════════════════════

describe('9 — resource swap', () => {
  it('swapping to a free aircraft via newResourceIds succeeds', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const acOld = await mkAircraft(db, sess, 'N-SwapOld');
    const acNew = await mkAircraft(db, sess, 'N-SwapNew');

    const created = await createReservationWithDb(
      db, sess, { startAt: W1_start, endAt: W1_end, resourceIds: [acOld.id] }, { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');

    const result = await rescheduleReservationWithDb(
      db, sess,
      {
        reservationId: created.reservation.id,
        newStartAt: W2_start,
        newEndAt: W2_end,
        newResourceIds: [acNew.id],
      },
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(await bookedResourceIds(db, orgAId, result.reservation.id)).toEqual([acNew.id]);
    // Old aircraft no longer booked anywhere (original cancelled).
    const orig = await reservationRow(db, orgAId, created.reservation.id);
    expect(orig!.status).toBe('cancelled');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 10 — SERIES DETACH
// ════════════════════════════════════════════════════════════════════════════════

describe('10 — series detach', () => {
  it('rescheduling a series occurrence detaches it (series_id NULL); listSeriesOccurrences excludes it', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const ac = await mkAircraft(db, sess, 'N-Series');

    const series = await createSeriesWithDb(
      db, sess,
      {
        weekdays: [1],
        intervalWeeks: 1,
        end: { kind: 'count', count: 3 },
        localStartTime: '10:00',
        durationMinutes: 60,
        tz: 'UTC',
        resourceIds: [ac.id],
      },
      { now: BASE_NOW },
    );
    expect(series.ok).toBe(true);
    const seriesId = series.series.id;
    const firstOcc = series.occurrences.find((o) => o.result === 'created');
    expect(firstOcc).toBeDefined();
    const occId = firstOcc!.reservationId!;

    // Sanity: listSeriesOccurrences includes it before reschedule.
    const beforeList = await listSeriesOccurrencesWithDb(db, sess, { seriesId });
    expect(beforeList.ok).toBe(true);
    if (!beforeList.ok) throw new Error('expected ok');
    expect(beforeList.occurrences.some((o) => o.id === occId)).toBe(true);

    // Reschedule that occurrence to a free, non-series window.
    const target = new Date('2026-04-06T10:00:00Z');
    const targetEnd = new Date('2026-04-06T11:00:00Z');
    const result = await rescheduleReservationWithDb(
      db, sess,
      { reservationId: occId, newStartAt: target, newEndAt: targetEnd },
      { now: BASE_NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    // New row has series_id NULL.
    const fresh = await reservationRow(db, orgAId, result.reservation.id);
    expect(fresh!.seriesId).toBeNull();

    // listSeriesOccurrences no longer returns the NEW row; original shows cancelled.
    const afterList = await listSeriesOccurrencesWithDb(db, sess, { seriesId });
    if (!afterList.ok) throw new Error('expected ok');
    expect(afterList.occurrences.some((o) => o.id === result.reservation.id)).toBe(false);
    const origInList = afterList.occurrences.find((o) => o.id === occId);
    expect(origInList).toBeDefined();
    expect(origInList!.status).toBe('cancelled');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 11 — VALIDATION
// ════════════════════════════════════════════════════════════════════════════════

describe('11 — validation', () => {
  it('newEndAt <= newStartAt throws ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const ac = await mkAircraft(db, sess, 'N-Val');
    const created = await createReservationWithDb(
      db, sess, { startAt: W1_start, endAt: W1_end, resourceIds: [ac.id] }, { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');

    await expect(
      rescheduleReservationWithDb(
        db, sess,
        { reservationId: created.reservation.id, newStartAt: W2_end, newEndAt: W2_start },
        { now: BASE_NOW },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 12 — CROSS-ORG / INACTIVE newResourceIds throws, original intact
// ════════════════════════════════════════════════════════════════════════════════

describe('12 — bad newResourceIds', () => {
  it('cross-org newResourceId throws ValidationError + original intact', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');
    const acA = await mkAircraft(db, sessA, 'N-XOrgA');
    const acB = await mkAircraft(db, sessB, 'N-XOrgB');

    const created = await createReservationWithDb(
      db, sessA, { startAt: W1_start, endAt: W1_end, resourceIds: [acA.id] }, { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');
    const originalId = created.reservation.id;

    const before = await snapshotOrg(db, orgAId);
    await expect(
      rescheduleReservationWithDb(
        db, sessA,
        {
          reservationId: originalId,
          newStartAt: W2_start,
          newEndAt: W2_end,
          newResourceIds: [acB.id], // belongs to org B — invisible to org A
        },
        { now: BASE_NOW },
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // Original intact (the cancel rolled back when ValidationError threw).
    const orig = await reservationRow(db, orgAId, originalId);
    expect(orig!.status).toBe('booked');
    const after = await snapshotOrg(db, orgAId);
    expect(after).toEqual(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 13 — ALREADY-CANCELLED ORIGINAL
// ════════════════════════════════════════════════════════════════════════════════

describe('13 — already-cancelled original', () => {
  it('rescheduling a cancelled reservation → not_found', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const ac = await mkAircraft(db, sess, 'N-Cancelled');
    const created = await createReservationWithDb(
      db, sess, { startAt: W1_start, endAt: W1_end, resourceIds: [ac.id] }, { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');
    const originalId = created.reservation.id;

    // First reschedule cancels the original (original now cancelled).
    const first = await rescheduleReservationWithDb(
      db, sess, { reservationId: originalId, newStartAt: W2_start, newEndAt: W2_end }, { now: BASE_NOW },
    );
    expect(first.ok).toBe(true);

    // Rescheduling the now-cancelled ORIGINAL again → not_found.
    const second = await rescheduleReservationWithDb(
      db, sess,
      { reservationId: originalId, newStartAt: W1_start, newEndAt: W1_end },
      { now: BASE_NOW },
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected not_found');
    expect(second.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 14 — AUTHZ
// ════════════════════════════════════════════════════════════════════════════════

describe('14 — authz', () => {
  it('no create capability → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const ownerSess = makeSession(orgAId, userAId, 'owner');
    const ac = await mkAircraft(db, ownerSess, 'N-Authz');
    const created = await createReservationWithDb(
      db, ownerSess, { startAt: W1_start, endAt: W1_end, resourceIds: [ac.id] }, { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');

    // 'renter' lacks schedule:create_reservation.
    const viewerSess = makeSession(orgAId, userAId, 'renter');
    await expect(
      rescheduleReservationWithDb(
        db, viewerSess,
        { reservationId: created.reservation.id, newStartAt: W2_start, newEndAt: W2_end },
        { now: BASE_NOW },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(
      rescheduleReservationWithDb(
        db, null,
        { reservationId: '00000000-0000-0000-0000-000000000001', newStartAt: W2_start, newEndAt: W2_end },
        { now: BASE_NOW },
      ),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 15 / 16 — PROPERTY: never double-books + atomicity
// ════════════════════════════════════════════════════════════════════════════════

describe('15/16 — PROPERTY: reschedule never double-books + atomicity', () => {
  it('random existing + target → no two booked join rows share resource+overlapping window; ok:false byte-identical; ok:true exactly one cancelled + one new booked', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // existing blocker window offsets (minutes from base)
          blockStart: fc.integer({ min: 0, max: 180 }),
          blockDur: fc.integer({ min: 15, max: 60 }),
          // original window
          origStart: fc.integer({ min: 0, max: 180 }),
          origDur: fc.integer({ min: 15, max: 60 }),
          // target window
          tgtStart: fc.integer({ min: 0, max: 180 }),
          tgtDur: fc.integer({ min: 15, max: 60 }),
          // which resource the blocker uses (0 or 1)
          blockRes: fc.integer({ min: 0, max: 1 }),
        }),
        async (g) => {
          const { db, pglite } = await createTestClient();
          await applyMigrationSql({ pglite }, MIGRATION_SQL);
          const seed = await seedTwoOrgs(db);
          await setTestAppRole({ pglite });
          const orgId = seed.orgAId;
          const sess = makeSession(orgId, seed.userAId, 'owner');

          const res: string[] = [];
          for (let i = 0; i < 2; i++) {
            const r = await createResourceWithDb(db, sess, {
              kind: 'aircraft',
              displayName: `N-PROP-${i}`,
              tailNumber: `NP${i}${Math.floor(Math.random() * 9000 + 1000)}`,
            });
            res.push(r.id);
          }

          const BASE = Date.UTC(2026, 5, 1, 6, 0, 0);
          const ONE_MIN = 60_000;
          const win = (off: number, dur: number) => ({
            startAt: new Date(BASE + off * ONE_MIN),
            endAt: new Date(BASE + (off + dur) * ONE_MIN),
          });
          const PROP_NOW = Date.UTC(2026, 0, 1);

          // Seed a blocker on res[blockRes].
          const bw = win(g.blockStart, g.blockDur);
          await createReservationWithDb(
            db, sess, { startAt: bw.startAt, endAt: bw.endAt, resourceIds: [res[g.blockRes]!] }, { now: PROP_NOW },
          );

          // Seed the original on res[0] at its own window (always res[0]).
          const ow = win(g.origStart, g.origDur);
          const origCreate = await createReservationWithDb(
            db, sess, { startAt: ow.startAt, endAt: ow.endAt, resourceIds: [res[0]!] }, { now: PROP_NOW },
          );
          if (!origCreate.ok) return true; // original window collided the blocker — skip this draw

          const before = await snapshotOrg(db, orgId);
          const cancelledBefore = (await withOrgContext(db, orgId, (tx) =>
            (tx as AnyDb).select().from(reservation).execute(),
          )).filter((r: any) => r.status === 'cancelled').length;

          const tw = win(g.tgtStart, g.tgtDur);
          const result = await rescheduleReservationWithDb(
            db, sess,
            { reservationId: origCreate.reservation.id, newStartAt: tw.startAt, newEndAt: tw.endAt },
            { now: PROP_NOW },
          );

          if (!result.ok) {
            // Atomicity: byte-identical to pre-call.
            const after = await snapshotOrg(db, orgId);
            if (JSON.stringify(after) !== JSON.stringify(before)) return false;
          } else {
            // Exactly one new cancelled (the original) + one new booked (the new).
            const resvRows = await withOrgContext(db, orgId, (tx) =>
              (tx as AnyDb).select().from(reservation).execute(),
            );
            const cancelledAfter = resvRows.filter((r: any) => r.status === 'cancelled').length;
            if (cancelledAfter !== cancelledBefore + 1) return false;
            const newRow = resvRows.find((r: any) => r.id === result.reservation.id);
            if (!newRow || newRow.status !== 'booked') return false;
          }

          // Invariant: committed booked windows per resource are pairwise non-overlapping.
          const joinRows = await withOrgContext(db, orgId, (tx) =>
            (tx as AnyDb).select().from(reservationResource).execute(),
          );
          const resvRows = await withOrgContext(db, orgId, (tx) =>
            (tx as AnyDb).select().from(reservation).execute(),
          );
          const resvById = new Map(resvRows.map((r: any) => [r.id, r]));
          const byRes = new Map<string, Array<{ s: number; e: number }>>();
          for (const j of joinRows.filter((r: any) => r.status === 'booked')) {
            const rv = resvById.get((j as any).reservationId) as any;
            if (!rv) continue;
            const arr = byRes.get((j as any).resourceId) ?? [];
            arr.push({ s: rv.startAt.getTime(), e: rv.endAt.getTime() });
            byRes.set((j as any).resourceId, arr);
          }
          for (const [, ws] of byRes) {
            for (let i = 0; i < ws.length; i++)
              for (let k = i + 1; k < ws.length; k++)
                if (Math.max(ws[i]!.s, ws[k]!.s) < Math.min(ws[i]!.e, ws[k]!.e)) return false;
          }
          return true;
        },
      ),
      { numRuns: 12 },
    );
  }, 180_000);
});

// ════════════════════════════════════════════════════════════════════════════════
// 17 — RACE: competing booked row commits into the target before the INSERT
// ════════════════════════════════════════════════════════════════════════════════

describe('17 — race: OccurrenceRaceError (23P01) during recreate → conflict, original preserved', () => {
  it('competitor holds the target window; gatedCreateOccurrence throws OccurrenceRaceError → original preserved', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const ac = await mkAircraft(db, sess, 'N-Race');

    // Original at W1.
    const created = await createReservationWithDb(
      db, sess, { startAt: W1_start, endAt: W1_end, resourceIds: [ac.id] }, { now: BASE_NOW },
    );
    if (!created.ok) throw new Error('seed create failed');
    const originalId = created.reservation.id;

    // Pre-seed a COMMITTED competitor that holds the TARGET window (W2) on the
    // same aircraft. This is the row that wins the race; reProbeInFreshTx will
    // find it. (pglite is single-connection, so we cannot open a second live tx
    // from inside the reschedule tx — we commit the winner up front instead.)
    const competitor = await createReservationWithDb(
      db, sess, { startAt: W2_start, endAt: W2_end, resourceIds: [ac.id] }, { now: BASE_NOW },
    );
    if (!competitor.ok) throw new Error('competitor create failed');

    // Spy on gatedCreateOccurrence (the live binding imported by
    // reschedule-reservation.ts): throw OccurrenceRaceError directly — exactly
    // what the real gated body does when its INSERT raises 23P01 because a
    // concurrent commit won the race. This deterministically drives the
    // reschedule's catch-OUTSIDE-tx → reProbeInFreshTx path (mirrors recurrence
    // 15b's sanctioned spy approach) and proves the outer-tx rollback preserves
    // the original after the cancel was issued in-tx.
    vi.spyOn(internalModule, 'gatedCreateOccurrence').mockImplementation(
      async (_tx, _sessionArg, _dbArg, input) => {
        throw new internalModule.OccurrenceRaceError(
          input.startAt,
          input.endAt,
          input.resourceIds,
          new Error('simulated 23P01'),
        );
      },
    );

    const result = await rescheduleReservationWithDb(
      db, sess,
      { reservationId: originalId, newStartAt: W2_start, newEndAt: W2_end },
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    // reProbeInFreshTx sees the committed competitor → rich conflict.
    expect(result.reason).toBe('conflict');
    if (result.reason !== 'conflict') throw new Error('expected conflict');
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts.some((c) => c.reservationId === competitor.reservation.id)).toBe(true);

    vi.restoreAllMocks();

    // Original PRESERVED: its in-tx cancel rolled back when the OccurrenceRace-
    // Error poisoned + rolled back the outer tx.
    const orig = await reservationRow(db, orgAId, originalId);
    expect(orig!.status).toBe('booked');
    expect(await bookedResourceIds(db, orgAId, originalId)).toEqual([ac.id]);
  });
});
