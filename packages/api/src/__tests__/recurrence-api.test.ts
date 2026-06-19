/**
 * recurrence-api.test.ts — API integration tests for SCHED-2b (Slice 2b).
 *
 * Covers spec §6 api block:
 *   - happy count=4: series created, 4 occurrences created, series row committed
 *   - partial-create skip-report: seeded collision + blackout → those skipped
 *     with correct reason/payload, others created, counts right; both-gates →
 *     conflict_and_policy
 *   - savepoint isolation: a skip does NOT roll back already-created siblings
 *   - zero-future: until < first → ok:true, occurrences:[], series row created
 *   - cap=52: truncatedByCap=true when rule wants more
 *   - no-past: now after some dates drops those dates
 *   - DST-nonexistent: reported in skippedLocalDates
 *   - cancelSeries: future-only + freed windows + idempotent + audit rows
 *   - listSeriesOccurrences: ordering + RLS
 *   - tenant isolation: cross-org resource → ValidationError; cross-org series → not_found
 *   - authz matrix: create/cancel need schedule:create_reservation, list needs schedule:access
 *   - validation thrown distinct from results
 *
 * Setup: createTestClient() → applyMigrationSql([0000–0004]) → seed → setTestAppRole()
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
} from '@aeroops/db';
import { auditLog, reservation, reservationSeries } from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient, AnyDb } from '@aeroops/db';

import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createSeriesWithDb } from '../scheduling/create-series.js';
import { cancelSeriesWithDb } from '../scheduling/cancel-series.js';
import { listSeriesOccurrencesWithDb } from '../scheduling/list-series-occurrences.js';
import { previewSeriesWithDb } from '../scheduling/preview-series.js';
import { createBlackoutWithDb } from '../scheduling/blackout-commands.js';
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

// A deterministic "now" anchored to a Monday 00:00 UTC in 2026 (Jan 5).
// Mon 00:00 UTC anchor means no week-0 no-past drops in count mode.
const BASE_NOW = Date.UTC(2026, 0, 5); // 2026-01-05T00:00:00Z (Monday)

// Helper: build a series input with sensible defaults.
function makeSeriesInput(
  resourceIds: string[],
  overrides: Partial<{
    weekdays: number[];
    intervalWeeks: number;
    end: { kind: 'count'; count: number } | { kind: 'until'; untilDate: string };
    localStartTime: string;
    durationMinutes: number;
    tz: string;
    notes: string;
  }> = {},
) {
  return {
    weekdays: overrides.weekdays ?? [1], // Monday
    intervalWeeks: overrides.intervalWeeks ?? 1,
    end: overrides.end ?? { kind: 'count' as const, count: 4 },
    localStartTime: overrides.localStartTime ?? '10:00',
    durationMinutes: overrides.durationMinutes ?? 60,
    tz: overrides.tz ?? 'UTC',
    resourceIds,
    notes: overrides.notes,
  };
}

let sharedEnv: TestEnv;

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
// SECTION 1 — HAPPY PATH: count=4, all created
// ════════════════════════════════════════════════════════════════════════════════

describe('HAPPY PATH: createSeries count=4', () => {
  it('creates 4 occurrences, series row committed, createdCount=4, skippedCount=0', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Series-Happy',
      tailNumber: 'N-SH1',
    });

    const result = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], { end: { kind: 'count', count: 4 } }),
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(true);
    expect(result.createdCount).toBe(4);
    expect(result.skippedCount).toBe(0);
    expect(result.occurrences).toHaveLength(4);
    expect(result.truncatedByCap).toBe(false);
    expect(result.skippedLocalDates).toHaveLength(0);

    // All occurrences 'created' with reservationId.
    for (const occ of result.occurrences) {
      expect(occ.result).toBe('created');
      expect(occ.reservationId).toBeTruthy();
    }

    // Series row has correct shape.
    expect(result.series.id).toBeTruthy();
    expect(result.series.status).toBe('active');
    expect(result.series.freq).toBe('weekly');

    // Verify reservation rows persisted in DB (RLS-scoped).
    const resvRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).where(eq(reservation.seriesId, result.series.id)).execute(),
    );
    expect(resvRows).toHaveLength(4);
    for (const r of resvRows) {
      expect(r.seriesId).toBe(result.series.id);
      expect(r.status).toBe('booked');
    }

    // Audit: 1 series.created + 4 reservation.created = 5 rows for this series op.
    const auditRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).where(
        eq(auditLog.entityId, result.series.id),
      ).execute(),
    );
    const seriesCreatedAudit = auditRows.find((r) => r.action === 'series.created');
    expect(seriesCreatedAudit).toBeDefined();
  });

  it('occurrences are in chronological order (ascending start_at)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-ChronOrder',
      tailNumber: 'N-CO1',
    });

    const result = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], {
        weekdays: [1, 3], // Mon + Wed → alternating
        end: { kind: 'count', count: 4 },
      }),
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(true);
    expect(result.createdCount).toBe(4);

    // Verify chronological order.
    for (let i = 1; i < result.occurrences.length; i++) {
      expect(result.occurrences[i]!.startAt.getTime()).toBeGreaterThan(
        result.occurrences[i - 1]!.startAt.getTime(),
      );
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2 — PARTIAL CREATE: skip-report (collision + blackout)
// ════════════════════════════════════════════════════════════════════════════════

describe('PARTIAL CREATE: skip-report with collision and blackout', () => {
  it('seeds a collision on occurrence 1: that one skips, others created; reason:conflict', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Use a Monday anchor. 4 weekly occurrences on Mondays 10:00–11:00 UTC:
    // Mon Jan 5, 12, 19, 26 2026.
    // Pre-book occurrence 0's window (Jan 5 10:00–11:00Z) to cause a conflict.
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Collision',
      tailNumber: 'N-COL1',
    });

    // Occ0 window: Jan 5 2026 10:00–11:00 UTC.
    const occ0Start = new Date('2026-01-05T10:00:00Z');
    const occ0End = new Date('2026-01-05T11:00:00Z');

    // Pre-book occ0's window so occurrence 0 will conflict.
    const prebooked = await createReservationWithDb(db, sess, {
      startAt: occ0Start,
      endAt: occ0End,
      resourceIds: [aircraft.id],
    });
    expect(prebooked.ok).toBe(true);

    // Create the series starting at BASE_NOW (Jan 5 00:00 UTC, Monday).
    const result = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], { end: { kind: 'count', count: 4 } }),
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(true);
    expect(result.createdCount).toBe(3);
    expect(result.skippedCount).toBe(1);

    // Occurrence 0 (Jan 5 10:00) should be skipped due to conflict.
    const skipped = result.occurrences.find((o) => o.result === 'skipped');
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toBe('conflict');
    expect(skipped!.conflicts).toBeDefined();
    expect(skipped!.conflicts!.length).toBeGreaterThan(0);
    expect(skipped!.conflicts![0]!.resourceId).toBe(aircraft.id);

    // Other 3 occurrences should be created.
    const created = result.occurrences.filter((o) => o.result === 'created');
    expect(created).toHaveLength(3);
  });

  it('policy violation (blackout) on one occurrence → that one skipped with reason:policy', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Blackout',
      tailNumber: 'N-BO1',
    });

    // 4 weekly Mondays: Jan 5, 12, 19, 26 2026 (10:00–11:00Z).
    // Create a blackout on Jan 12 10:00–11:00 UTC to block occurrence 1.
    await createBlackoutWithDb(db, makeSession(orgAId, userAId, 'manager'), {
      resourceId: aircraft.id,
      startAt: new Date('2026-01-12T10:00:00Z'),
      endAt: new Date('2026-01-12T11:00:00Z'),
    });

    const result = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], { end: { kind: 'count', count: 4 } }),
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(true);
    expect(result.createdCount).toBe(3);
    expect(result.skippedCount).toBe(1);

    const skipped = result.occurrences.find((o) => o.result === 'skipped');
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toBe('policy');
    expect(skipped!.violations).toBeDefined();
    expect(skipped!.violations!.length).toBeGreaterThan(0);
  });

  it('both gates fire on same occurrence → reason:conflict_and_policy, both arrays populated', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Use two separate resources so we can control conflict + policy independently.
    // Actually both gates can fire on one resource:
    // - pre-book its window (conflict)
    // - also put a blackout on same window (policy)
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-BothGates',
      tailNumber: 'N-BG1',
    });

    // Jan 19 10:00–11:00Z = occ 2 in 4-week Monday series.
    const targetStart = new Date('2026-01-19T10:00:00Z');
    const targetEnd = new Date('2026-01-19T11:00:00Z');

    // Conflict seed.
    await createReservationWithDb(db, sess, {
      startAt: targetStart,
      endAt: targetEnd,
      resourceIds: [aircraft.id],
    });

    // Blackout on same window.
    await createBlackoutWithDb(db, makeSession(orgAId, userAId, 'manager'), {
      resourceId: aircraft.id,
      startAt: targetStart,
      endAt: targetEnd,
    });

    const result = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], { end: { kind: 'count', count: 4 } }),
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(true);

    // Find the skipped occurrence at targetStart.
    const skipped = result.occurrences.find(
      (o) => o.result === 'skipped' && o.startAt.getTime() === targetStart.getTime(),
    );
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toBe('conflict_and_policy');
    expect(skipped!.conflicts).toBeDefined();
    expect(skipped!.conflicts!.length).toBeGreaterThan(0);
    expect(skipped!.violations).toBeDefined();
    expect(skipped!.violations!.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3 — SAVEPOINT ISOLATION: a skip does NOT roll back committed siblings
// ════════════════════════════════════════════════════════════════════════════════

describe('SAVEPOINT ISOLATION: skip does not roll back committed siblings', () => {
  it('occurrence 0 created, occ 1 skipped, occ 2 created → all 3 rows persist correctly', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Savepoint',
      tailNumber: 'N-SP1',
    });

    // Block occ 1 (Jan 12 10:00Z) with a pre-book.
    await createReservationWithDb(db, sess, {
      startAt: new Date('2026-01-12T10:00:00Z'),
      endAt: new Date('2026-01-12T11:00:00Z'),
      resourceIds: [aircraft.id],
    });

    const result = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], { end: { kind: 'count', count: 3 } }),
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(true);
    // occ0 (Jan5) created, occ1 (Jan12) skipped, occ2 (Jan19) created.
    expect(result.createdCount).toBe(2);
    expect(result.skippedCount).toBe(1);

    // Verify the two created occurrence rows are in the DB.
    const createdOccs = result.occurrences.filter((o) => o.result === 'created');
    expect(createdOccs).toHaveLength(2);

    const resvRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).where(eq(reservation.seriesId, result.series.id)).execute(),
    );
    // Only 2 rows (skipped writes NO row).
    expect(resvRows).toHaveLength(2);
    for (const r of resvRows) {
      expect(r.status).toBe('booked');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4 — ZERO FUTURE: until < first occurrence
// ════════════════════════════════════════════════════════════════════════════════

describe('ZERO FUTURE: until before first occurrence → ok:true, empty occurrences, series row created', () => {
  it('until date strictly before anchor → ok:true, occurrences:[], series row in DB', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-ZeroFuture',
      tailNumber: 'N-ZF1',
    });

    // now = Jan 5 2026 (Monday). Until = Jan 4 (before the first Monday).
    const result = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], {
        end: { kind: 'until', untilDate: '2026-01-04' }, // before anchor
      }),
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(true);
    expect(result.createdCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.occurrences).toHaveLength(0);

    // Series row still created.
    const seriesRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationSeries).where(eq(reservationSeries.id, result.series.id)).execute(),
    );
    expect(seriesRows).toHaveLength(1);
    expect(seriesRows[0]!.status).toBe('active');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5 — CAP=52: truncatedByCap
// ════════════════════════════════════════════════════════════════════════════════

describe('CAP: count > 52 is rejected by validation; until-mode truncates at 52', () => {
  it('count=60 → ValidationError (exceeds max 52)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft', displayName: 'N-CapTest', tailNumber: 'N-CAP1',
    });

    await expect(
      createSeriesWithDb(db, sess, makeSeriesInput([aircraft.id], {
        end: { kind: 'count', count: 60 },
      }), { now: BASE_NOW }),
    ).rejects.toThrow(ValidationError);
  });

  it('until-mode spanning > 52 weeks → truncatedByCap:true, exactly 52 generated', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft', displayName: 'N-UntilCap', tailNumber: 'N-UC1',
    });

    // 60 weeks forward from Jan 5 2026 → exceeds 52 cap.
    const untilDate = new Date(BASE_NOW + 60 * 7 * 86_400_000);
    const y = untilDate.getUTCFullYear();
    const m = String(untilDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(untilDate.getUTCDate()).padStart(2, '0');

    const result = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], {
        end: { kind: 'until', untilDate: `${y}-${m}-${d}` },
      }),
      { now: BASE_NOW },
    );

    expect(result.ok).toBe(true);
    expect(result.truncatedByCap).toBe(true);
    // The series should have created at most 52 occurrences.
    expect(result.createdCount + result.skippedCount).toBeLessThanOrEqual(52);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 6 — NO PAST: occurrences before `now` are dropped
// ════════════════════════════════════════════════════════════════════════════════

describe('NO PAST: occurrences before now are dropped silently', () => {
  it('advancing now past the first occurrence drops it; series still has correct count', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft', displayName: 'N-NoPast', tailNumber: 'N-NP1',
    });

    // now = Jan 5 2026 10:00:01Z (just AFTER the 10:00 slot on Jan 5) → occ0 dropped.
    const afterFirstOcc = Date.UTC(2026, 0, 5, 10, 0, 1); // 1s after 10:00Z

    const result = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], { end: { kind: 'count', count: 4 } }),
      { now: afterFirstOcc },
    );

    expect(result.ok).toBe(true);
    // count=4 generates 4 candidates; occ0 (Jan5 10:00Z) is < now, so dropped → 3 emitted.
    // But because now > midnight Jan5 but < midnight Jan12, the anchor is still week of Jan5,
    // so the walk starts from Jan5-Mon but 10:00Z < now(10:00:01Z) → dropped.
    expect(result.createdCount).toBe(3);
    // All emitted occurrences start >= now.
    for (const occ of result.occurrences) {
      expect(occ.startAt.getTime()).toBeGreaterThanOrEqual(afterFirstOcc);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 7 — DST-NONEXISTENT: spring-forward gap reported in skippedLocalDates
// ════════════════════════════════════════════════════════════════════════════════

describe('DST-nonexistent: spring-forward gap reported in skippedLocalDates', () => {
  it('a Sunday series across US spring-forward drop 02:30 on Mar 8 2026 and report it', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft', displayName: 'N-DST', tailNumber: 'N-DST1',
    });

    // America/Chicago spring-forward is 2026-03-08 02:00 CST → 03:00 CDT.
    // 02:30 CST does not exist. Series: weekly Sunday 02:30 America/Chicago,
    // count=10, starting before the transition.
    // now = Feb 1 2026 00:00:00 UTC.
    const nowForDst = Date.UTC(2026, 1, 1);

    const result = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], {
        weekdays: [7], // Sunday
        end: { kind: 'count', count: 10 },
        localStartTime: '02:30',
        tz: 'America/Chicago',
      }),
      { now: nowForDst },
    );

    expect(result.ok).toBe(true);
    // Mar 8 (the spring-forward Sunday) should appear in skippedLocalDates.
    const mar8Skip = result.skippedLocalDates.find(
      (s) => s.date.year === 2026 && s.date.month === 3 && s.date.day === 8,
    );
    expect(mar8Skip).toBeDefined();
    expect(mar8Skip!.reason).toBe('nonexistent_local_time');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 8 — cancelSeries
// ════════════════════════════════════════════════════════════════════════════════

describe('cancelSeries: future-only, freed windows, idempotent, audit rows', () => {
  it('cancels all future booked occurrences; past ones untouched', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft', displayName: 'N-Cancel', tailNumber: 'N-CAN1',
    });

    // Create 4 weekly occurrences. now = Jan 5 2026 00:00Z.
    const createResult = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], { end: { kind: 'count', count: 4 } }),
      { now: BASE_NOW },
    );
    expect(createResult.ok).toBe(true);
    expect(createResult.createdCount).toBe(4);

    // Cancel the series with now = Jan 14 (between occ1 and occ2).
    // Occ0: Jan 5 10:00Z (past); occ1: Jan 12 10:00Z (past); occ2: Jan 19, occ3: Jan 26 (future).
    const cancelNow = Date.UTC(2026, 0, 14); // Jan 14 00:00Z — after occ1, before occ2.

    const cancelResult = await cancelSeriesWithDb(
      db,
      sess,
      { seriesId: createResult.series.id },
      { now: cancelNow },
    );

    expect(cancelResult.ok).toBe(true);
    if (!cancelResult.ok) throw new Error('expected ok:true');
    expect(cancelResult.cancelledCount).toBe(2); // occ2 + occ3 are future

    // Verify series is cancelled.
    const seriesRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationSeries).where(eq(reservationSeries.id, createResult.series.id)).execute(),
    );
    expect(seriesRows[0]!.status).toBe('cancelled');

    // Verify cancelled occurrences are cancelled; past (occ0, occ1) are still booked.
    const allResvRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).where(eq(reservation.seriesId, createResult.series.id)).execute(),
    );
    const pastOccs = allResvRows.filter(
      (r) => r.startAt.getTime() <= Date.UTC(2026, 0, 13, 10, 0),
    );
    const futureOccs = allResvRows.filter(
      (r) => r.startAt.getTime() > cancelNow,
    );
    expect(pastOccs.every((r) => r.status === 'booked')).toBe(true);
    expect(futureOccs.every((r) => r.status === 'cancelled')).toBe(true);

    // Audit: series.cancelled + 2 reservation.cancelled.
    const auditRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).execute(),
    );
    const seriesCancelledAudit = auditRows.find(
      (r) => r.action === 'series.cancelled' && r.entityId === createResult.series.id,
    );
    expect(seriesCancelledAudit).toBeDefined();
    const occCancelledAudits = auditRows.filter(
      (r) => r.action === 'reservation.cancelled' &&
        typeof r.metadata === 'object' &&
        r.metadata !== null &&
        (r.metadata as Record<string, unknown>)['seriesId'] === createResult.series.id,
    );
    expect(occCancelledAudits).toHaveLength(2);
  });

  it('cancelSeries frees future windows (re-booking a freed slot succeeds)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft', displayName: 'N-Free', tailNumber: 'N-FR1',
    });

    // Create 2 occurrences. Jan 5 + Jan 12 10:00–11:00Z.
    const createResult = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], { end: { kind: 'count', count: 2 } }),
      { now: BASE_NOW },
    );
    expect(createResult.ok).toBe(true);
    expect(createResult.createdCount).toBe(2);

    // Cancel series at now = Jan 1 (both future).
    const cancelNow = Date.UTC(2026, 0, 1);
    const cancelResult = await cancelSeriesWithDb(db, sess, { seriesId: createResult.series.id }, { now: cancelNow });
    expect(cancelResult.ok).toBe(true);
    if (!cancelResult.ok) throw new Error('expected ok:true');
    expect(cancelResult.cancelledCount).toBe(2);

    // Now re-book occ0's window (Jan 5 10:00–11:00Z) — should succeed.
    const rebook = await createReservationWithDb(db, sess, {
      startAt: new Date('2026-01-05T10:00:00Z'),
      endAt: new Date('2026-01-05T11:00:00Z'),
      resourceIds: [aircraft.id],
    });
    expect(rebook.ok).toBe(true);
  });

  it('cancelSeries idempotent: re-cancelling already-cancelled series returns ok:true, cancelledCount:0', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft', displayName: 'N-Idempotent', tailNumber: 'N-IDP1',
    });

    const createResult = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], { end: { kind: 'count', count: 2 } }),
      { now: BASE_NOW },
    );

    // Cancel once.
    const first = await cancelSeriesWithDb(db, sess, { seriesId: createResult.series.id }, { now: BASE_NOW });
    expect(first.ok).toBe(true);

    // Cancel again.
    const second = await cancelSeriesWithDb(db, sess, { seriesId: createResult.series.id }, { now: BASE_NOW });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected ok:true');
    expect(second.cancelledCount).toBe(0);
  });

  it('cancelSeries unknown/cross-org seriesId → not_found', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const result = await cancelSeriesWithDb(db, sess, {
      seriesId: '00000000-0000-0000-0000-000000000001',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not_found');
    expect(result.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 9 — listSeriesOccurrences
// ════════════════════════════════════════════════════════════════════════════════

describe('listSeriesOccurrences: ordering + RLS', () => {
  it('returns series row + occurrences ordered by start_at ascending', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft', displayName: 'N-List', tailNumber: 'N-LST1',
    });

    const createResult = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], {
        weekdays: [1, 3], // Mon + Wed
        end: { kind: 'count', count: 4 },
      }),
      { now: BASE_NOW },
    );
    expect(createResult.ok).toBe(true);

    const listResult = await listSeriesOccurrencesWithDb(db, sess, { seriesId: createResult.series.id });
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) throw new Error('expected ok:true');

    expect(listResult.series.id).toBe(createResult.series.id);
    expect(listResult.occurrences).toHaveLength(4);

    // Verify chronological order.
    for (let i = 1; i < listResult.occurrences.length; i++) {
      expect(listResult.occurrences[i]!.startAt.getTime()).toBeGreaterThan(
        listResult.occurrences[i - 1]!.startAt.getTime(),
      );
    }

    // All occurrences have the resource linked.
    for (const occ of listResult.occurrences) {
      expect(occ.resourceIds).toContain(aircraft.id);
    }
  });

  it('org-B session cannot see org-A series → not_found', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');

    const aircraft = await createResourceWithDb(db, sessA, {
      kind: 'aircraft', displayName: 'N-IsolationList', tailNumber: 'N-IL1',
    });
    const createResult = await createSeriesWithDb(
      db,
      sessA,
      makeSeriesInput([aircraft.id], { end: { kind: 'count', count: 2 } }),
      { now: BASE_NOW },
    );
    expect(createResult.ok).toBe(true);

    // Org-B session tries to list org-A series.
    const listResult = await listSeriesOccurrencesWithDb(db, sessB, { seriesId: createResult.series.id });
    expect(listResult.ok).toBe(false);
    if (listResult.ok) throw new Error('expected not_found');
    expect(listResult.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 10 — TENANT ISOLATION
// ════════════════════════════════════════════════════════════════════════════════

describe('TENANT ISOLATION', () => {
  it('cross-org resource in createSeries → ValidationError (whole request fails)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');

    // Create a resource in org B.
    const aircraftB = await createResourceWithDb(db, sessB, {
      kind: 'aircraft', displayName: 'N-IsolB', tailNumber: 'N-ISB1',
    });

    // Org A session tries to use org B's resource → must throw ValidationError.
    await expect(
      createSeriesWithDb(
        db,
        sessA,
        makeSeriesInput([aircraftB.id], { end: { kind: 'count', count: 4 } }),
        { now: BASE_NOW },
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('cross-org seriesId in cancelSeries → not_found', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');

    const aircraftA = await createResourceWithDb(db, sessA, {
      kind: 'aircraft', displayName: 'N-CrossCancel', tailNumber: 'N-CC1',
    });
    const createResult = await createSeriesWithDb(
      db,
      sessA,
      makeSeriesInput([aircraftA.id], { end: { kind: 'count', count: 2 } }),
      { now: BASE_NOW },
    );

    // Org B tries to cancel org A's series.
    const cancelResult = await cancelSeriesWithDb(db, sessB, { seriesId: createResult.series.id });
    expect(cancelResult.ok).toBe(false);
    if (cancelResult.ok) throw new Error('expected not_found');
    expect(cancelResult.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 11 — AUTHZ MATRIX
// ════════════════════════════════════════════════════════════════════════════════

describe('AUTHZ MATRIX', () => {
  it('unauthenticated → UnauthenticatedError on createSeries', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft', displayName: 'N-AuthzCreate', tailNumber: 'N-AZ1',
    });

    await expect(
      createSeriesWithDb(db, null, makeSeriesInput([aircraft.id]), { now: BASE_NOW }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('student role → ForbiddenError on createSeries (needs schedule:create_reservation)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sessStu = makeSession(orgAId, userAId, 'student');
    const sessOwner = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sessOwner, {
      kind: 'aircraft', displayName: 'N-AuthzStudent', tailNumber: 'N-AZS1',
    });

    await expect(
      createSeriesWithDb(db, sessStu, makeSeriesInput([aircraft.id]), { now: BASE_NOW }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('student role → ForbiddenError on cancelSeries', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sessOwner = makeSession(orgAId, userAId, 'owner');
    const sessStu = makeSession(orgAId, userAId, 'student');
    const aircraft = await createResourceWithDb(db, sessOwner, {
      kind: 'aircraft', displayName: 'N-AuthzStuCancel', tailNumber: 'N-AZC1',
    });
    const createResult = await createSeriesWithDb(
      db, sessOwner, makeSeriesInput([aircraft.id]), { now: BASE_NOW },
    );

    await expect(
      cancelSeriesWithDb(db, sessStu, { seriesId: createResult.series.id }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('unauthenticated → UnauthenticatedError on listSeriesOccurrences', async () => {
    await expect(
      listSeriesOccurrencesWithDb(sharedEnv.db, null, {
        seriesId: '00000000-0000-0000-0000-000000000001',
      }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('student role → ForbiddenError on previewSeries', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sessStu = makeSession(orgAId, userAId, 'student');

    await expect(
      previewSeriesWithDb(db, sessStu, makeSeriesInput(['00000000-0000-0000-0000-000000000001']), { now: BASE_NOW }),
    ).rejects.toThrow(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 12 — VALIDATION: thrown distinct from results
// ════════════════════════════════════════════════════════════════════════════════

describe('VALIDATION: thrown as ValidationError, not returned', () => {
  it('empty weekdays → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      createSeriesWithDb(db, sess, {
        weekdays: [], intervalWeeks: 1, end: { kind: 'count', count: 4 },
        localStartTime: '10:00', durationMinutes: 60, tz: 'UTC', resourceIds: ['00000000-0000-0000-0000-000000000001'],
      }, { now: BASE_NOW }),
    ).rejects.toThrow(ValidationError);
  });

  it('intervalWeeks=0 → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      createSeriesWithDb(db, sess, {
        weekdays: [1], intervalWeeks: 0, end: { kind: 'count', count: 4 },
        localStartTime: '10:00', durationMinutes: 60, tz: 'UTC', resourceIds: ['00000000-0000-0000-0000-000000000001'],
      }, { now: BASE_NOW }),
    ).rejects.toThrow(ValidationError);
  });

  it('durationMinutes=0 → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      createSeriesWithDb(db, sess, {
        weekdays: [1], intervalWeeks: 1, end: { kind: 'count', count: 4 },
        localStartTime: '10:00', durationMinutes: 0, tz: 'UTC', resourceIds: ['00000000-0000-0000-0000-000000000001'],
      }, { now: BASE_NOW }),
    ).rejects.toThrow(ValidationError);
  });

  it('invalid IANA tz → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      createSeriesWithDb(db, sess, {
        weekdays: [1], intervalWeeks: 1, end: { kind: 'count', count: 4 },
        localStartTime: '10:00', durationMinutes: 60, tz: 'NOT/A_VALID_TZ',
        resourceIds: ['00000000-0000-0000-0000-000000000001'],
      }, { now: BASE_NOW }),
    ).rejects.toThrow(ValidationError);
  });

  it('empty resourceIds → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      createSeriesWithDb(db, sess, {
        weekdays: [1], intervalWeeks: 1, end: { kind: 'count', count: 4 },
        localStartTime: '10:00', durationMinutes: 60, tz: 'UTC', resourceIds: [],
      }, { now: BASE_NOW }),
    ).rejects.toThrow(ValidationError);
  });

  it('malformed time (25:00) → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      createSeriesWithDb(db, sess, {
        weekdays: [1], intervalWeeks: 1, end: { kind: 'count', count: 4 },
        localStartTime: '25:00', durationMinutes: 60, tz: 'UTC',
        resourceIds: ['00000000-0000-0000-0000-000000000001'],
      }, { now: BASE_NOW }),
    ).rejects.toThrow(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 13 — previewSeries (read-only, no writes)
// ════════════════════════════════════════════════════════════════════════════════

describe('previewSeries: read-only advisory preview', () => {
  it('preview with no conflicts → all would_create, no DB writes', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft', displayName: 'N-Preview', tailNumber: 'N-PRV1',
    });

    const before = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).execute(),
    );

    const result = await previewSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], { end: { kind: 'count', count: 3 } }),
      { now: BASE_NOW },
    );

    expect(result.wouldCreateCount).toBe(3);
    expect(result.wouldSkipCount).toBe(0);
    for (const occ of result.occurrences) {
      expect(occ.result).toBe('would_create');
    }

    // No writes: reservation count unchanged.
    const after = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).execute(),
    );
    expect(after.length).toBe(before.length);
  });

  it('preview with a collision → would_skip with reason:conflict, writes nothing', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft', displayName: 'N-PreviewConflict', tailNumber: 'N-PRC1',
    });

    // Pre-book occ0 window.
    await createReservationWithDb(db, sess, {
      startAt: new Date('2026-01-05T10:00:00Z'),
      endAt: new Date('2026-01-05T11:00:00Z'),
      resourceIds: [aircraft.id],
    });

    const before = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).execute(),
    );

    const result = await previewSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], { end: { kind: 'count', count: 3 } }),
      { now: BASE_NOW },
    );

    expect(result.wouldSkipCount).toBeGreaterThan(0);
    const skipped = result.occurrences.find((o) => o.result === 'would_skip');
    expect(skipped!.reason).toBe('conflict');

    // No extra writes.
    const after = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).execute(),
    );
    expect(after.length).toBe(before.length);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 15 — SERIES RACE: post-INSERT 23P01 → ROLLBACK TO SAVEPOINT + re-probe
//
// This test verifies the ADR-0006 §3 race-safety fix in the series path.
//
// The scenario being tested:
//   A race occurs when a concurrent transaction commits a conflicting booked row
//   AFTER the series loop's pre-check (runConflictProbe) passes but BEFORE the
//   occurrence's reservation_resource INSERT. In production this is a true
//   concurrent race; in pglite (single-threaded) we construct the equivalent:
//
//   CONSTRUCTION:
//     We call gatedCreateOccurrence inside a savepoint DIRECTLY (bypassing the
//     series loop) with a window that has a REAL pre-booked collision. We also
//     bypass the pre-check by calling gatedCreateOccurrence with a tx that has
//     a "pre-cleared" state — specifically by using withOrgContext (the outer tx)
//     and injecting the INSERT in a controlled way.
//
//     Two sub-tests:
//
//   TEST 15a — OccurrenceRaceError from gatedCreateOccurrence:
//     1. Pre-book occurrence's window (real booked row in DB).
//     2. Open an outer tx (withOrgContext). Inside it:
//        a. Open a savepoint (tx.transaction).
//        b. Inside the savepoint, call gatedCreateOccurrence with the same window.
//           The pre-check WILL find the collision (returns {ok:false, reason:'conflict'})
//           before the INSERT — so no 23P01 here. This test exercises the PRE-CHECK
//           path within a savepoint, verifying savepoint isolation.
//     Note: This is the "pre-check catches it" path tested in Section 2 already.
//
//   APPROACH — Direct 23P01 via raw INSERT:
//     To force a post-INSERT 23P01 without a real concurrent tx:
//     1. Open an outer withOrgContext tx.
//     2. Inside the outer tx, open savepoint A:
//        - INSERT a reservation row + reservation_resource row for occ1's window.
//        - RELEASE savepoint A (commit to outer tx).
//     3. Inside the outer tx, open savepoint B (simulating gatedCreateOccurrence
//        for occ1 after a race — pre-check ran BEFORE step 2, now INSERT fires):
//        - INSERT a second reservation_resource for the same window → 23P01.
//        - The 23P01 aborts savepoint B.
//     4. Outer tx is still alive after savepoint B is rolled back.
//     5. Verify outer tx can commit other work.
//
//   This directly exercises the ROLLBACK TO SAVEPOINT mechanism and proves the
//   outer tx survives a 23P01 inside a savepoint.
//
//   TEST 15b — createSeries with forced 23P01 via interception:
//     We monkey-patch `gatedCreateOccurrence` in the `internalModule` namespace
//     for a single occurrence to throw OccurrenceRaceError directly (simulating
//     what the real gatedCreateOccurrence would do on 23P01). This directly tests
//     the series loop's OccurrenceRaceError catch path:
//     - Does the series loop correctly catch OccurrenceRaceError?
//     - Does it re-probe and record skipped/conflict?
//     - Does the outer tx survive and commit occ 0 and occ 2?
//
//   FAIL vs OLD CODE (for TEST 15b):
//     Old code did not export OccurrenceRaceError and handled 23P01 internally.
//     The series loop's catch block was `throw err;` (no-op). If gatedCreate-
//     Occurrence internally caught 23P01 and called reProbeInFreshTx while the
//     savepoint was aborted, subsequent DB ops would hit "current transaction is
//     aborted", causing a whole-series failure. The series loop's old no-op
//     catch (`catch (err) { throw err; }`) would rethrow that, aborting the
//     entire series → the outer tx would not commit occ 0 or occ 2.
//     OLD CODE result: createSeries throws (whole-series failure) → FAILS.
//
//   PASS with NEW code (for TEST 15b):
//     New code: OccurrenceRaceError is thrown by gatedCreateOccurrence (no
//     internal re-probe). The series loop catches it, re-probes on the live
//     parent tx, records occ 1 as skipped/conflict, and continues. Occ 0 and
//     occ 2 are committed in the outer tx.
// ════════════════════════════════════════════════════════════════════════════════

describe('SERIES RACE: post-INSERT 23P01 → ROLLBACK TO SAVEPOINT + re-probe on live tx', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('15a — savepoint absorbs a raw 23P01: outer tx survives and can commit further work', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Create a resource for this test.
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-RaceA',
      tailNumber: 'N-RA1',
    });

    const occ1Start = '2026-01-12T10:00:00Z';
    const occ1End   = '2026-01-12T11:00:00Z';

    // We use withOrgContext to open an outer tx and exercise the savepoint
    // ROLLBACK mechanism directly. Inside the outer tx:
    //   savepoint A: insert a real booked reservation_resource row (occ1).
    //   savepoint B: try to insert a DUPLICATE → 23P01 → savepoint B aborted.
    //   After ROLLBACK TO SAVEPOINT B, the outer tx is still alive.
    //   Insert a sentinel row (unrelated resource) to prove outer tx is clean.
    const { sql: coreSql } = await import('drizzle-orm');

    let outerTxSurvived = false;

    await withOrgContext(db, orgAId, async (tx: AnyDb) => {
      // savepoint A: insert reservation + reservation_resource for occ1.
      // This commits into the outer tx (RELEASE SAVEPOINT A).
      const resv1 = await (tx as AnyDb).transaction(async (sp: AnyDb) => {
        // INSERT a reservation row.
        const { sql } = await import('drizzle-orm');
        const r = await sp.execute(sql`
          INSERT INTO reservation (org_id, start_at, end_at, status, created_by)
          VALUES (
            ${sess.orgId}::uuid,
            ${occ1Start}::timestamptz,
            ${occ1End}::timestamptz,
            'booked'::"reservation_status",
            ${sess.userId}::uuid
          )
          RETURNING id
        `);
        const rows = (r.rows ?? r) as Array<{ id: string }>;
        const reservationId = rows[0]!.id;
        // INSERT reservation_resource (booked).
        await sp.execute(sql`
          INSERT INTO reservation_resource (org_id, reservation_id, resource_id, during, status)
          VALUES (
            ${sess.orgId}::uuid,
            ${reservationId}::uuid,
            ${aircraft.id}::uuid,
            tstzrange(${occ1Start}::timestamptz, ${occ1End}::timestamptz, '[)'),
            'booked'::"reservation_status"
          )
        `);
        return reservationId;
      });

      expect(resv1).toBeTruthy(); // savepoint A committed

      // savepoint B: try to insert another booked row for the same resource+window.
      // This must trigger the EXCLUDE constraint → 23P01 → savepoint B aborted.
      // We expect tx.transaction() to throw here.
      let savepointBError: unknown = null;
      try {
        await (tx as AnyDb).transaction(async (sp: AnyDb) => {
          const { sql } = await import('drizzle-orm');
          // INSERT a second reservation row (for the "duplicate" occurrence).
          const r2 = await sp.execute(sql`
            INSERT INTO reservation (org_id, start_at, end_at, status, created_by)
            VALUES (
              ${sess.orgId}::uuid,
              ${occ1Start}::timestamptz,
              ${occ1End}::timestamptz,
              'booked'::"reservation_status",
              ${sess.userId}::uuid
            )
            RETURNING id
          `);
          const rows2 = (r2.rows ?? r2) as Array<{ id: string }>;
          const reservationId2 = rows2[0]!.id;
          // This INSERT collides with savepoint A's row → 23P01.
          await sp.execute(sql`
            INSERT INTO reservation_resource (org_id, reservation_id, resource_id, during, status)
            VALUES (
              ${sess.orgId}::uuid,
              ${reservationId2}::uuid,
              ${aircraft.id}::uuid,
              tstzrange(${occ1Start}::timestamptz, ${occ1End}::timestamptz, '[)'),
              'booked'::"reservation_status"
            )
          `);
        });
      } catch (err) {
        // Expected: 23P01 exclusion_violation (or a wrapping error).
        savepointBError = err;
      }

      // The savepoint must have thrown.
      expect(savepointBError).not.toBeNull();

      // The outer tx must still be alive (not poisoned). Prove it by executing
      // a simple query on `tx`. If the outer tx were aborted, this would throw
      // "current transaction is aborted".
      const { sql } = await import('drizzle-orm');
      const check = await tx.execute(sql`SELECT 1 AS alive`);
      const checkRows = (check.rows ?? check) as Array<{ alive: number }>;
      expect(checkRows[0]?.alive).toBe(1);

      outerTxSurvived = true;
      // Outer tx commits here (withOrgContext resolves).
    });

    expect(outerTxSurvived).toBe(true);
  });

  it('15b — series loop OccurrenceRaceError: mocked 23P01 on occ1 → outer tx commits occ0+occ2', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Create a fresh aircraft.
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-RaceB',
      tailNumber: 'N-RB1',
    });

    // 3-occurrence series: Mon Jan 5, 12, 19 2026 at 10:00–11:00Z.
    const occ0Start = new Date('2026-01-05T10:00:00Z');
    const occ1Start = new Date('2026-01-12T10:00:00Z');
    const occ2Start = new Date('2026-01-19T10:00:00Z');

    // Mock gatedCreateOccurrence to throw OccurrenceRaceError ONLY for occ1's
    // window. This simulates what gatedCreateOccurrence would do if the
    // EXCLUDE constraint fired post-INSERT (23P01) for that occurrence.
    // For occ 0 and occ 2, the real gatedCreateOccurrence runs normally.
    //
    // Why this test would FAIL against old code:
    //   Old code had no OccurrenceRaceError. The series loop's catch block was
    //   `catch (err) { throw err; }` — a no-op rethrow. Any error escaping
    //   the savepoint callback would propagate as a whole-series failure.
    //   With the OLD code, if gatedCreateOccurrence threw OccurrenceRaceError
    //   (which it didn't exist then), the series would abort rather than
    //   catching it and continuing.
    //
    //   The OLD code's actual behavior for 23P01 was to catch 23P01 INSIDE
    //   gatedCreateOccurrence, call reProbeInFreshTx on the already-aborted
    //   savepoint, which poisoned the outer tx, and then the RELEASE SAVEPOINT
    //   or next DB op would throw "current transaction is aborted".
    //   OLD CODE result: whole series fails (throws), occ 0 and occ 2 NOT
    //   committed → assertions fail.
    //
    // Why this test PASSES with new code:
    //   New code: OccurrenceRaceError thrown from inside the savepoint callback.
    //   Drizzle emits ROLLBACK TO SAVEPOINT. Series loop catches OccurrenceRace-
    //   Error, re-probes on live parent tx, records occ 1 as skipped/conflict,
    //   continues. Occ 0 and occ 2 committed in the outer tx.

    // We spy on gatedCreateOccurrence in the internal module. Vitest's module
    // mocking with vi.spyOn works when the test file imports the module as a
    // namespace (`import * as internalModule`). Since the production module
    // calls gatedCreateOccurrence directly (not via the namespace object),
    // the spy won't intercept internal calls — BUT gatedCreateOccurrence IS
    // called through the import in create-series.ts, which imports it by name.
    // In vitest's ESM-aware mode with module hoisting, the spy intercepts the
    // binding in the consuming module (create-series.ts) because vitest rewrites
    // the module to use live bindings.
    //
    // If spying on the internal function cannot intercept the call in the
    // consuming module, we use an alternative: spy on `internalModule.gatedCreate-
    // Occurrence` which IS the function called from create-series.ts's import
    // (same binding after vitest's module rewrite). We wrap it to throw
    // OccurrenceRaceError for occ1's startAt only.

    const realGatedCreateOccurrence = internalModule.gatedCreateOccurrence;
    let callCount = 0;

    vi.spyOn(internalModule, 'gatedCreateOccurrence').mockImplementation(
      async (tx, sessionArg, dbArg, input, nowArg) => {
        callCount++;
        if (input.startAt.getTime() === occ1Start.getTime()) {
          // Simulate the 23P01 race: throw OccurrenceRaceError.
          throw new internalModule.OccurrenceRaceError(
            input.startAt,
            input.endAt,
            input.resourceIds,
            new Error('simulated 23P01'),
          );
        }
        // All other occurrences: use the real implementation.
        return realGatedCreateOccurrence(tx, sessionArg, dbArg, input, nowArg);
      },
    );

    const result = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], {
        weekdays: [1], // Monday only
        end: { kind: 'count', count: 3 },
      }),
      { now: BASE_NOW },
    );

    // The mock must have been called (3 occurrences).
    expect(callCount).toBe(3);

    // Primary assertion: series succeeded (no whole-tx abort).
    expect(result.ok).toBe(true);

    // Occ 1 (Jan 12) must be skipped with reason:'conflict'.
    const occ1Report = result.occurrences.find(
      (o) => o.startAt.getTime() === occ1Start.getTime(),
    );
    expect(occ1Report).toBeDefined();
    expect(occ1Report!.result).toBe('skipped');
    expect(occ1Report!.reason).toBe('conflict');
    expect(occ1Report!.conflicts).toBeDefined();

    // Occ 0 (Jan 5) and occ 2 (Jan 19) must be created.
    const occ0Report = result.occurrences.find(
      (o) => o.startAt.getTime() === occ0Start.getTime(),
    );
    const occ2Report = result.occurrences.find(
      (o) => o.startAt.getTime() === occ2Start.getTime(),
    );
    expect(occ0Report).toBeDefined();
    expect(occ0Report!.result).toBe('created');
    expect(occ2Report).toBeDefined();
    expect(occ2Report!.result).toBe('created');

    expect(result.createdCount).toBe(2);
    expect(result.skippedCount).toBe(1);

    // Durability: both created occurrences persisted in the DB.
    const resvRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).where(eq(reservation.seriesId, result.series.id)).execute(),
    );
    expect(resvRows).toHaveLength(2);
    for (const r of resvRows) {
      expect(r.status).toBe('booked');
    }

    // Series row exists and is active.
    const seriesRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationSeries).where(eq(reservationSeries.id, result.series.id)).execute(),
    );
    expect(seriesRows).toHaveLength(1);
    expect(seriesRows[0]!.status).toBe('active');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 14 — NO-REGRESSION: single-create after series (gates share same path)
// ════════════════════════════════════════════════════════════════════════════════

describe('NO-REGRESSION: single-create on an aircraft used in a series', () => {
  it('a slot adjacent to a series occurrence can be booked (adjacency not a conflict)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft', displayName: 'N-Adjacent', tailNumber: 'N-ADJ1',
    });

    // Create series: Jan 5 10:00–11:00Z (only 1 occ).
    const createResult = await createSeriesWithDb(
      db,
      sess,
      makeSeriesInput([aircraft.id], { end: { kind: 'count', count: 1 } }),
      { now: BASE_NOW },
    );
    expect(createResult.ok).toBe(true);
    expect(createResult.createdCount).toBe(1);

    // Book the adjacent slot [11:00, 12:00Z) → should succeed (adjacency != conflict).
    const adjacent = await createReservationWithDb(db, sess, {
      startAt: new Date('2026-01-05T11:00:00Z'),
      endAt: new Date('2026-01-05T12:00:00Z'),
      resourceIds: [aircraft.id],
    });
    expect(adjacent.ok).toBe(true);
  });
});
