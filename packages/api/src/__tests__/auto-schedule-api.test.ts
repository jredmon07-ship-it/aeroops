/**
 * auto-schedule-api.test.ts — Slice 4b auto-scheduler API integration suite.
 *
 * Verifies runAutoSchedule + previewAutoSchedule:
 *   - every proposal commits via the FROZEN gatedCreateOccurrence (reservation +
 *     reservation_resource rows created; behaviourally NO bespoke INSERT)
 *   - refused-at-commit (seeded conflict before commit) → skipped + reason; rest commits
 *   - concurrent-race (overlapping proposals sharing a resource) → 23P01 → skip, no double-book
 *   - determinism (same input + seed → same proposals)
 *   - no-feasible → ok:true all-unschedulable (NOT an error)
 *   - the run-header row written + each created reservation audit carries
 *     metadata.optimizationRunId
 *   - authz (missing schedule:create_reservation → Forbidden on preview AND commit)
 *   - tenant isolation (run scoped to session org; availability/twilight never cross orgs)
 *   - previewAutoSchedule writes nothing (zero reservation/audit/run-header rows) and its
 *     wouldCreate/wouldSkip agree with a subsequent commit absent concurrent writes
 *
 * Setup mirrors recurrence-api.test.ts: createTestClient → applyMigrationSql(0000..0011)
 * → seedTwoOrgs → setTestAppRole.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import * as coreModule from '@aeroops/core';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
} from '@aeroops/db';
import {
  auditLog,
  reservation,
  reservationResource,
  scheduleOptimizationRun,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { runAutoScheduleWithDb } from '../scheduling/auto-schedule.js';
import { previewAutoScheduleWithDb } from '../scheduling/preview-auto-schedule.js';
import * as internalModule from '../scheduling/auto-schedule-internal.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_SQL = [
  readFileSync(resolve(__dirname, '../../../db/migrations/0000_loud_prodigy.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0001_auth_credential.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0002_scheduling.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0003_booking_policies.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0004_recurrence.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0005_dispatch.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0006_squawks_grounding.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0007_fleet.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0008_people.sql'), 'utf-8'),
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
];

// A deterministic clock + planning window (08:00..20:00 UTC on a fixed day).
const NOW = Date.UTC(2026, 5, 19, 6, 0, 0); // before the window
const WIN_START = Date.UTC(2026, 5, 19, 8, 0, 0);
const WIN_END = Date.UTC(2026, 5, 19, 20, 0, 0);
const SEED = 12345;

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
}

function makeSession(orgId: string, userId: string, role: AppSession['role'] = 'owner'): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

let env: TestEnv;

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
}, 60_000);

let tag = 0;
async function seedAircraft(orgId: string, userId: string): Promise<string> {
  const sess = makeSession(orgId, userId);
  const t = `AS${tag++}`;
  const ac = await createResourceWithDb(env.db, sess, {
    kind: 'aircraft',
    displayName: `N-${t}`,
    tailNumber: `N${t}`,
  });
  return ac.id;
}

async function seedInstructor(orgId: string, userId: string): Promise<string> {
  const sess = makeSession(orgId, userId);
  const t = `IN${tag++}`;
  const inst = await createResourceWithDb(env.db, sess, {
    kind: 'instructor',
    displayName: `CFI-${t}`,
    instructorUserId: userId,
  });
  return inst.id;
}

async function countReservations(orgId: string): Promise<number> {
  return withOrgContext(env.db, orgId, async (tx) => {
    const rows = await tx.select().from(reservation).execute();
    return rows.length;
  });
}

async function countRuns(orgId: string): Promise<number> {
  return withOrgContext(env.db, orgId, async (tx) => {
    const rows = await tx.select().from(scheduleOptimizationRun).execute();
    return rows.length;
  });
}

async function countResourceRows(orgId: string): Promise<number> {
  return withOrgContext(env.db, orgId, async (tx) => {
    const rows = await tx.select().from(reservationResource).execute();
    return rows.length;
  });
}

async function countAudit(orgId: string): Promise<number> {
  return withOrgContext(env.db, orgId, async (tx) => {
    const rows = await tx.select().from(auditLog).execute();
    return rows.length;
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1 — happy path: proposals commit via gatedCreateOccurrence
// ════════════════════════════════════════════════════════════════════════════════

describe('runAutoSchedule: proposals commit through the single write path', () => {
  it('creates reservations + reservation_resource rows for each placed demand', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    const ac = await seedAircraft(orgAId, userAId);

    const resvBefore = await countReservations(orgAId);
    const rrBefore = await countResourceRows(orgAId);

    const result = await runAutoScheduleWithDb(
      env.db,
      sess,
      {
        windowStartUtcMs: WIN_START,
        windowEndUtcMs: WIN_END,
        demands: [
          { id: 'd1', requiredResourceIds: [ac], durationMinutes: 60 },
          { id: 'd2', requiredResourceIds: [ac], durationMinutes: 60 },
        ],
      },
      { now: NOW, seed: SEED },
    );

    expect(result.ok).toBe(true);
    expect(result.createdCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(result.proposals.every((p) => p.result === 'created')).toBe(true);
    // No two placements overlap on the shared aircraft (proposer self-consistency).
    const [p1, p2] = result.proposals;
    expect(p1!.endAt.getTime()).toBeLessThanOrEqual(p2!.startAt.getTime());

    const resvAfter = await countReservations(orgAId);
    const rrAfter = await countResourceRows(orgAId);
    expect(resvAfter - resvBefore).toBe(2);
    // One reservation_resource row per (reservation × resource).
    expect(rrAfter - rrBefore).toBe(2);

    // Behaviourally proves the write path: each created reservation has a join row.
    for (const p of result.proposals) {
      if (p.result !== 'created') continue;
      const joinRows = await withOrgContext(env.db, orgAId, (tx) =>
        tx
          .select()
          .from(reservationResource)
          .where(eq(reservationResource.reservationId, p.reservationId!))
          .execute(),
      );
      expect(joinRows.length).toBe(1);
      expect(joinRows[0]!.resourceId).toBe(ac);
    }
  });

  it('multi-resource demand books both resources atomically', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    const ac = await seedAircraft(orgAId, userAId);
    const inst = await seedInstructor(orgAId, userAId);

    const result = await runAutoScheduleWithDb(
      env.db,
      sess,
      {
        windowStartUtcMs: WIN_START,
        windowEndUtcMs: WIN_END,
        demands: [{ id: 'm1', requiredResourceIds: [ac, inst], durationMinutes: 90 }],
      },
      { now: NOW, seed: SEED },
    );

    expect(result.createdCount).toBe(1);
    const p = result.proposals[0]!;
    expect(p.result).toBe('created');
    const joinRows = await withOrgContext(env.db, orgAId, (tx) =>
      tx
        .select()
        .from(reservationResource)
        .where(eq(reservationResource.reservationId, p.reservationId!))
        .execute(),
    );
    expect(joinRows.map((r) => r.resourceId).sort()).toEqual([ac, inst].sort());
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2 — run header + per-reservation audit tagging
// ════════════════════════════════════════════════════════════════════════════════

describe('runAutoSchedule: run header + optimizationRunId audit tagging', () => {
  it('writes ONE run header and tags each created reservation audit row', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    const ac = await seedAircraft(orgAId, userAId);

    const runsBefore = await countRuns(orgAId);
    const result = await runAutoScheduleWithDb(
      env.db,
      sess,
      {
        windowStartUtcMs: WIN_START,
        windowEndUtcMs: WIN_END,
        demands: [{ id: 'r1', requiredResourceIds: [ac], durationMinutes: 60 }],
      },
      { now: NOW, seed: SEED },
    );
    const runsAfter = await countRuns(orgAId);
    expect(runsAfter - runsBefore).toBe(1);

    // The run header carries the right counts + seed.
    const runRow = await withOrgContext(env.db, orgAId, (tx) =>
      tx
        .select()
        .from(scheduleOptimizationRun)
        .where(eq(scheduleOptimizationRun.id, result.runId))
        .execute(),
    );
    expect(runRow.length).toBe(1);
    expect(runRow[0]!.createdCount).toBe(1);
    expect(runRow[0]!.skippedCount).toBe(0);
    expect(runRow[0]!.seed).toBe(SEED);
    expect(runRow[0]!.requestedBy).toBe(userAId);

    // The created reservation's audit row carries metadata.optimizationRunId.
    const created = result.proposals.find((p) => p.result === 'created')!;
    const auditRows = await withOrgContext(env.db, orgAId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, created.reservationId!))
        .execute(),
    );
    const createdAudit = auditRows.find((a) => a.action === 'reservation.created');
    expect(createdAudit).toBeDefined();
    expect((createdAudit!.metadata as Record<string, unknown>).optimizationRunId).toBe(result.runId);

    // One run-header audit row too.
    const runAudit = await withOrgContext(env.db, orgAId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, result.runId))
        .execute(),
    );
    expect(runAudit.some((a) => a.action === 'optimization_run.created')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3 — refused at commit (reality drifted) → skip + rest commits
// ════════════════════════════════════════════════════════════════════════════════
//
// To exercise the commit-skip path deterministically we STUB buildAvailability so
// the pure proposer is handed a window that OVERLAPS a pre-seeded booking it could
// not have known about (reality drifted between planning + commit). The orchestrator
// then refuses that proposal at gatedCreateOccurrence (conflict / 23P01), reports it
// `skipped`, and commits the rest of the batch. This proves the SAME
// OccurrenceRaceError/ROLLBACK-TO-SAVEPOINT/re-probe loop as createSeries.

describe('runAutoSchedule: refused at commit → skipped, rest commits', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a proposal overlapping a pre-seeded booking is skipped; the rest commit', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    const acBusy = await seedAircraft(orgAId, userAId);
    const acFree = await seedAircraft(orgAId, userAId);

    // Pre-seed a booking on acBusy at [WIN_START, WIN_START+60m).
    await createReservationWithDb(env.db, sess, {
      startAt: new Date(WIN_START),
      endAt: new Date(WIN_START + 60 * 60_000),
      resourceIds: [acBusy],
    });

    // Stub availability so the proposer thinks the WHOLE span is free for BOTH
    // aircraft (i.e. it does NOT subtract the acBusy booking — simulating drift).
    vi.spyOn(internalModule, 'buildAvailability').mockResolvedValue([
      { resourceId: acBusy, startUtcMs: WIN_START, endUtcMs: WIN_END },
      { resourceId: acFree, startUtcMs: WIN_START, endUtcMs: WIN_END },
    ]);

    const result = await runAutoScheduleWithDb(
      env.db,
      sess,
      {
        windowStartUtcMs: WIN_START,
        windowEndUtcMs: WIN_END,
        demands: [
          // dBusy: only acBusy, earliest=WIN_START + tight bound → lands flush on the
          // pre-seeded booking → refused at commit.
          {
            id: 'dBusy',
            requiredResourceIds: [acBusy],
            durationMinutes: 60,
            earliestStartUtcMs: WIN_START,
            latestEndUtcMs: WIN_START + 60 * 60_000,
          },
          // dFree: acFree, free all day → commits.
          { id: 'dFree', requiredResourceIds: [acFree], durationMinutes: 60 },
        ],
      },
      { now: NOW, seed: SEED },
    );

    expect(result.ok).toBe(true);
    expect(result.createdCount).toBe(1);
    expect(result.skippedCount).toBe(1);

    const busyReport = result.proposals.find((p) => p.demandId === 'dBusy')!;
    expect(busyReport.result).toBe('skipped');
    expect(busyReport.reason).toBe('conflict');
    expect(busyReport.conflicts && busyReport.conflicts.length).toBeGreaterThan(0);

    const freeReport = result.proposals.find((p) => p.demandId === 'dFree')!;
    expect(freeReport.result).toBe('created');
    expect(freeReport.reservationId).toBeDefined();

    // Run header counts reflect the partial create.
    const runRow = await withOrgContext(env.db, orgAId, (tx) =>
      tx
        .select()
        .from(scheduleOptimizationRun)
        .where(eq(scheduleOptimizationRun.id, result.runId))
        .execute(),
    );
    expect(runRow[0]!.createdCount).toBe(1);
    expect(runRow[0]!.skippedCount).toBe(1);

    // No double-book on acBusy: still exactly the one pre-seeded booking.
    const busyJoinRows = await withOrgContext(env.db, orgAId, (tx) =>
      tx
        .select()
        .from(reservationResource)
        .where(eq(reservationResource.resourceId, acBusy))
        .execute(),
    );
    expect(busyJoinRows.length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4 — concurrent EXCLUDE race → skip, no double-book
// ════════════════════════════════════════════════════════════════════════════════
//
// Stub availability so the proposer emits TWO overlapping proposals on the SAME
// aircraft (it cannot do this normally — its output is self-consistent). At commit,
// the first proposal books the slot; the second hits the GiST EXCLUDE 23P01, the
// orchestrator catches OccurrenceRaceError, rolls back the savepoint, re-probes on
// the clean parent tx, and reports the loser `skipped`/conflict. NO double-book.

describe('runAutoSchedule: concurrent EXCLUDE race → skip, no double-book', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('two overlapping proposals on one aircraft → second refused by 23P01 → skip', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    const ac = await seedAircraft(orgAId, userAId);

    // Hand the proposer a full-span window; two tightly-bounded demands will be
    // placed at the SAME flush start (WIN_START) because each has the same earliest.
    vi.spyOn(internalModule, 'buildAvailability').mockResolvedValue([
      { resourceId: ac, startUtcMs: WIN_START, endUtcMs: WIN_END },
    ]);
    // Also stub proposeSchedule via the orchestrator's view is not possible (pure
    // import); instead we force overlap by giving both demands the SAME tight bound
    // so the greedy placer would normally serialize them — but the stub above gives
    // a single window, and we bypass the proposer's non-overlap guarantee by mocking
    // it to emit two overlapping proposals.
    vi.spyOn(coreModule, 'proposeSchedule').mockReturnValue({
      proposals: [
        { demandId: 'r1', resourceIds: [ac], startUtcMs: WIN_START, endUtcMs: WIN_START + 60 * 60_000 },
        { demandId: 'r2', resourceIds: [ac], startUtcMs: WIN_START, endUtcMs: WIN_START + 60 * 60_000 },
      ],
      unschedulable: [],
    });

    const result = await runAutoScheduleWithDb(
      env.db,
      sess,
      {
        windowStartUtcMs: WIN_START,
        windowEndUtcMs: WIN_END,
        demands: [
          { id: 'r1', requiredResourceIds: [ac], durationMinutes: 60 },
          { id: 'r2', requiredResourceIds: [ac], durationMinutes: 60 },
        ],
      },
      { now: NOW, seed: SEED },
    );

    expect(result.ok).toBe(true);
    expect(result.createdCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    const skipped = result.proposals.find((p) => p.result === 'skipped')!;
    expect(skipped.reason).toBe('conflict');
    expect(skipped.conflicts && skipped.conflicts.length).toBeGreaterThan(0);

    // EXCLUDE backstop: exactly one booked join row on the aircraft → no double-book.
    const joinRows = await withOrgContext(env.db, orgAId, (tx) =>
      tx
        .select()
        .from(reservationResource)
        .where(eq(reservationResource.resourceId, ac))
        .execute(),
    );
    expect(joinRows.filter((r) => r.status === 'booked').length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5 — determinism
// ════════════════════════════════════════════════════════════════════════════════

describe('runAutoSchedule: determinism', () => {
  it('same input + seed → identical placement windows', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    const ac = await seedAircraft(orgAId, userAId);

    const input = {
      windowStartUtcMs: WIN_START,
      windowEndUtcMs: WIN_END,
      demands: [
        { id: 'q1', requiredResourceIds: [ac], durationMinutes: 60, priority: 2 },
        { id: 'q2', requiredResourceIds: [ac], durationMinutes: 90, priority: 1 },
      ],
    };
    const r1 = await runAutoScheduleWithDb(env.db, sess, input, { now: NOW, seed: SEED });

    // Fresh aircraft, same relative inputs → same windows (modulo absolute times).
    const ac2 = await seedAircraft(orgAId, userAId);
    const input2 = { ...input, demands: input.demands.map((d) => ({ ...d, requiredResourceIds: [ac2] })) };
    const r2 = await runAutoScheduleWithDb(env.db, sess, input2, { now: NOW, seed: SEED });

    const windows1 = r1.proposals.map((p) => `${p.demandId}:${p.startAt.getTime()}-${p.endAt.getTime()}`);
    const windows2 = r2.proposals.map((p) => `${p.demandId}:${p.startAt.getTime()}-${p.endAt.getTime()}`);
    expect(windows1).toEqual(windows2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 6 — no feasible solution → ok:true all-unschedulable
// ════════════════════════════════════════════════════════════════════════════════

describe('runAutoSchedule: no feasible solution', () => {
  it('ok:true with all demands unschedulable (not an error)', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    const ac = await seedAircraft(orgAId, userAId);

    const result = await runAutoScheduleWithDb(
      env.db,
      sess,
      {
        windowStartUtcMs: WIN_START,
        windowEndUtcMs: WIN_END,
        // Duration longer than the whole window → no feasible window.
        demands: [{ id: 'big', requiredResourceIds: [ac], durationMinutes: 24 * 60 }],
      },
      { now: NOW, seed: SEED },
    );

    expect(result.ok).toBe(true);
    expect(result.createdCount).toBe(0);
    expect(result.unschedulable.map((u) => u.demandId)).toContain('big');
    // A run header is still written (with 0/0 counts).
    const runRow = await withOrgContext(env.db, orgAId, (tx) =>
      tx
        .select()
        .from(scheduleOptimizationRun)
        .where(eq(scheduleOptimizationRun.id, result.runId))
        .execute(),
    );
    expect(runRow[0]!.createdCount).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 7 — authz
// ════════════════════════════════════════════════════════════════════════════════

describe('auto-schedule: authz', () => {
  it('renter (no schedule:create_reservation) → Forbidden on commit AND preview', async () => {
    const { orgAId, userAId } = env;
    const ac = await seedAircraft(orgAId, userAId);
    const renter = makeSession(orgAId, userAId, 'renter');
    const input = {
      windowStartUtcMs: WIN_START,
      windowEndUtcMs: WIN_END,
      demands: [{ id: 'z1', requiredResourceIds: [ac], durationMinutes: 60 }],
    };

    await expect(runAutoScheduleWithDb(env.db, renter, input, { now: NOW, seed: SEED })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      previewAutoScheduleWithDb(env.db, renter, input, { now: NOW, seed: SEED }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 8 — tenant isolation
// ════════════════════════════════════════════════════════════════════════════════

describe('auto-schedule: tenant isolation', () => {
  it('a run is scoped to the session org; org B sees no rows from org A run', async () => {
    const { orgAId, userAId, orgBId } = env;
    const sess = makeSession(orgAId, userAId);
    const ac = await seedAircraft(orgAId, userAId);

    const runsBeforeB = await countRuns(orgBId);
    const result = await runAutoScheduleWithDb(
      env.db,
      sess,
      {
        windowStartUtcMs: WIN_START,
        windowEndUtcMs: WIN_END,
        demands: [{ id: 't1', requiredResourceIds: [ac], durationMinutes: 60 }],
      },
      { now: NOW, seed: SEED },
    );
    expect(result.createdCount).toBe(1);

    const runsAfterB = await countRuns(orgBId);
    expect(runsAfterB).toBe(runsBeforeB); // org B unchanged.

    // The run row is visible in org A only.
    const inA = await withOrgContext(env.db, orgAId, (tx) =>
      tx.select().from(scheduleOptimizationRun).where(eq(scheduleOptimizationRun.id, result.runId)).execute(),
    );
    expect(inA.length).toBe(1);
    const inB = await withOrgContext(env.db, orgBId, (tx) =>
      tx.select().from(scheduleOptimizationRun).where(eq(scheduleOptimizationRun.id, result.runId)).execute(),
    );
    expect(inB.length).toBe(0);
  });

  it('a demand referencing an out-of-org resource creates nothing (id not visible)', async () => {
    const { orgAId, userAId, orgBId, userBId } = env;
    const acB = await seedAircraft(orgBId, userBId); // belongs to org B
    const sessA = makeSession(orgAId, userAId);

    // org A asks to schedule org B's aircraft. The proposer has no availability for
    // it (RLS-scoped reads in org A see nothing for acB) → no feasible window.
    const result = await runAutoScheduleWithDb(
      env.db,
      sessA,
      {
        windowStartUtcMs: WIN_START,
        windowEndUtcMs: WIN_END,
        demands: [{ id: 'xorg', requiredResourceIds: [acB], durationMinutes: 60 }],
      },
      { now: NOW, seed: SEED },
    );
    expect(result.createdCount).toBe(0);
    expect(result.unschedulable.map((u) => u.demandId)).toContain('xorg');

    // Nothing was created in org B from org A's run.
    const acBResvCount = await withOrgContext(env.db, orgBId, (tx) =>
      tx
        .select()
        .from(reservationResource)
        .where(eq(reservationResource.resourceId, acB))
        .execute(),
    );
    expect(acBResvCount.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 9 — previewAutoSchedule writes nothing + agrees with commit
// ════════════════════════════════════════════════════════════════════════════════

describe('previewAutoSchedule: read-only + agrees with commit', () => {
  it('writes zero reservation / audit / run-header rows', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    const ac = await seedAircraft(orgAId, userAId);

    const resvBefore = await countReservations(orgAId);
    const auditBefore = await countAudit(orgAId);
    const runsBefore = await countRuns(orgAId);

    const preview = await previewAutoScheduleWithDb(
      env.db,
      sess,
      {
        windowStartUtcMs: WIN_START,
        windowEndUtcMs: WIN_END,
        demands: [
          { id: 'pv1', requiredResourceIds: [ac], durationMinutes: 60 },
          { id: 'pv2', requiredResourceIds: [ac], durationMinutes: 60 },
        ],
      },
      { now: NOW, seed: SEED },
    );

    expect(await countReservations(orgAId)).toBe(resvBefore);
    expect(await countAudit(orgAId)).toBe(auditBefore);
    expect(await countRuns(orgAId)).toBe(runsBefore);
    expect(preview.wouldCreateCount).toBe(2);
    expect(preview.wouldSkipCount).toBe(0);
  });

  it('wouldCreate/wouldSkip agree with a subsequent commit (no concurrent writes)', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    const ac = await seedAircraft(orgAId, userAId);

    const input = {
      windowStartUtcMs: WIN_START,
      windowEndUtcMs: WIN_END,
      demands: [
        { id: 'agree1', requiredResourceIds: [ac], durationMinutes: 60 },
        { id: 'agree2', requiredResourceIds: [ac], durationMinutes: 90 },
      ],
    };
    const preview = await previewAutoScheduleWithDb(env.db, sess, input, { now: NOW, seed: SEED });
    const commit = await runAutoScheduleWithDb(env.db, sess, input, { now: NOW, seed: SEED });

    expect(commit.createdCount).toBe(preview.wouldCreateCount);
    expect(commit.skippedCount).toBe(preview.wouldSkipCount);

    // Same demandIds → same proposed windows.
    const pvWindows = preview.proposals
      .map((p) => `${p.demandId}:${p.startAt.getTime()}-${p.endAt.getTime()}`)
      .sort();
    const cmWindows = commit.proposals
      .map((p) => `${p.demandId}:${p.startAt.getTime()}-${p.endAt.getTime()}`)
      .sort();
    expect(pvWindows).toEqual(cmWindows);
  });
});
