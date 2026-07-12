/**
 * availability-api.test.ts — Slice AV1.2 resource operating-hours API suite.
 *
 * Verifies the additive availability gate wired into the FROZEN gatedCreateOccurrence
 * (warn → ok:true + availabilityWarnings; block → { ok:false, reason:'availability' }),
 * the CRUD surface, the previewAvailability read-only indicator, the config flags,
 * tenant isolation, precedence ordering, all 4 write paths, multi-resource, DST, and —
 * critically — that the create path is BYTE-IDENTICAL when the gate is disabled or the
 * resource has no windows (the headline INERT guarantee).
 *
 * Setup mirrors twilight-api.test.ts: createTestClient → applyMigrationSql(0000..0014)
 * → seedTwoOrgs → setTestAppRole.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  loadMigrationSql,
} from '@aeroops/db';
import { auditLog, dispatchConfig, location, reservation, resource, resourceAvailabilityWindow } from '@aeroops/db';
import { computeSolarEvents } from '@aeroops/core';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { createSeriesWithDb } from '../scheduling/create-series.js';
import { rescheduleReservationWithDb } from '../scheduling/reschedule-reservation.js';
import { runAutoScheduleWithDb } from '../scheduling/auto-schedule.js';
import {
  listAvailabilityWindowsWithDb,
  createAvailabilityWindowWithDb,
  deleteAvailabilityWindowWithDb,
} from '../scheduling/availability-commands.js';
import { previewAvailabilityWithDb } from '../scheduling/preview-availability.js';
import { updateDispatchConfigWithDb } from '../dispatch-gate/config.js';
import { ForbiddenError } from '../auth/require-capability.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ValidationError } from '../scheduling/internal.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0038 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0038');

// ── Fixed candidate date: Wednesday 2026-06-17 (ISO weekday 3), all-UTC windows ──
const WED = 3;
// In-hours candidate: 14:00–15:00 UTC, inside a 13:00–17:00 UTC operating-hours window.
const IN_START = new Date(Date.parse('2026-06-17T14:00:00Z'));
const IN_END = new Date(Date.parse('2026-06-17T15:00:00Z'));
// Out-of-hours candidate: 18:00–19:00 UTC (after the 13:00–17:00 window closes).
const OUT_START = new Date(Date.parse('2026-06-17T18:00:00Z'));
const OUT_END = new Date(Date.parse('2026-06-17T19:00:00Z'));

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  locationAId: string;
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
    db, pglite,
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    locationAId: seed.locationAId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };
}, 60_000);

// ── Helpers ─────────────────────────────────────────────────────────────────────

function db(): PgliteTestClient { return env.db; }

async function setAvailabilityConfig(
  orgId: string,
  cfg: { enabled: boolean; mode?: 'warn' | 'block' },
): Promise<void> {
  await withOrgContext(env.db, orgId, async (tx) => {
    await tx.delete(dispatchConfig);
    await tx.insert(dispatchConfig).values({
      orgId,
      availabilityConstraintEnabled: cfg.enabled,
      availabilityMode: cfg.mode ?? 'warn',
    });
  });
}

async function clearConfig(orgId: string): Promise<void> {
  await withOrgContext(env.db, orgId, async (tx) => { await tx.delete(dispatchConfig); });
}

/** Set BOTH availability AND twilight config fields in one upsert (for precedence tests). */
async function setBothConfigs(
  orgId: string,
  cfg: { availabilityEnabled: boolean; availabilityMode: 'warn' | 'block'; twilightEnabled: boolean; twilightMode: 'warn' | 'block' },
): Promise<void> {
  await withOrgContext(env.db, orgId, async (tx) => {
    await tx.delete(dispatchConfig);
    await tx.insert(dispatchConfig).values({
      orgId,
      availabilityConstraintEnabled: cfg.availabilityEnabled,
      availabilityMode: cfg.availabilityMode,
      twilightConstraintEnabled: cfg.twilightEnabled,
      twilightMode: cfg.twilightMode,
    });
  });
}

/** Set location coordinates (for twilight gate activation). */
async function setCoords(orgId: string, locationId: string, lat: number, lon: number): Promise<void> {
  await withOrgContext(env.db, orgId, async (tx) => {
    await tx.update(location).set({ latitude: String(lat), longitude: String(lon) }).where(eq(location.id, locationId));
  });
}

/** Clear location coordinates. */
async function clearCoords(orgId: string, locationId: string): Promise<void> {
  await withOrgContext(env.db, orgId, async (tx) => {
    await tx.update(location).set({ latitude: null, longitude: null }).where(eq(location.id, locationId));
  });
}

let acCounter = 0;
async function seedAircraft(orgId: string, userId: string): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const tag = `AV${acCounter++}`;
  const ac = await createResourceWithDb(db(), sess, {
    kind: 'aircraft',
    displayName: `N-${tag}`,
    tailNumber: `N${tag}`,
  });
  return ac.id;
}

// A second bookable resource (instructor — requires instructorUserId) used for the
// multi-resource tests.
let instrCounter = 0;
async function seedInstructor(orgId: string, userId: string): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const tag = `IN${instrCounter++}`;
  const r = await createResourceWithDb(db(), sess, {
    kind: 'instructor',
    displayName: `Instructor ${tag}`,
    instructorUserId: userId,
  });
  return r.id;
}

/** Insert a window directly (RLS-scoped). Returns the window id. */
async function addWindow(
  orgId: string,
  userId: string,
  resourceId: string,
  dayOfWeek: number,
  startMinute: number,
  endMinute: number,
  tz = 'UTC',
): Promise<string> {
  return withOrgContext(env.db, orgId, async (tx) => {
    const rows = await tx
      .insert(resourceAvailabilityWindow)
      .values({ orgId, resourceId, dayOfWeek, startMinute, endMinute, tz, createdBy: userId })
      .returning({ id: resourceAvailabilityWindow.id });
    return rows[0]!.id;
  });
}

async function countAudit(orgId: string): Promise<number> {
  return withOrgContext(env.db, orgId, async (tx) => (await tx.select().from(auditLog).execute()).length);
}
async function countReservations(orgId: string): Promise<number> {
  return withOrgContext(env.db, orgId, async (tx) => (await tx.select().from(reservation).execute()).length);
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1 — INERT → create path BYTE-IDENTICAL (the headline guarantee)
// ════════════════════════════════════════════════════════════════════════════════

describe('availability: disabled (no config) → byte-identical create path', () => {
  it('out-of-hours booking succeeds with NO availabilityWarnings + exactly one audit row', async () => {
    const { orgAId, userAId } = env;
    await clearConfig(orgAId);
    const acId = await seedAircraft(orgAId, userAId);
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 17 * 60); // 13:00–17:00 UTC
    const sess = makeSession(orgAId, userAId);

    const auditBefore = await countAudit(orgAId);
    const result = await createReservationWithDb(db(), sess, {
      startAt: OUT_START, endAt: OUT_END, resourceIds: [acId],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.availabilityWarnings).toBeUndefined();
    expect(result.twilightWarnings).toBeUndefined();
    expect(result.groundingWarnings).toBeUndefined();
    // ok:true shape byte-identical: no availability key present at all.
    expect(Object.prototype.hasOwnProperty.call(result, 'availabilityWarnings')).toBe(false);

    expect((await countAudit(orgAId)) - auditBefore).toBe(1);
  });
});

describe('availability: enabled but resource has NO windows → inert', () => {
  it('out-of-hours booking succeeds with no availabilityWarnings', async () => {
    const { orgAId, userAId } = env;
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'block' });
    const acId = await seedAircraft(orgAId, userAId); // NO windows added
    const sess = makeSession(orgAId, userAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: OUT_START, endAt: OUT_END, resourceIds: [acId],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.availabilityWarnings).toBeUndefined();
    await clearConfig(orgAId);
  });
});

describe('availability: config present but enabled=false → inert', () => {
  it('out-of-hours booking with windows present succeeds, no warnings', async () => {
    const { orgAId, userAId } = env;
    await setAvailabilityConfig(orgAId, { enabled: false, mode: 'block' });
    const acId = await seedAircraft(orgAId, userAId);
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 17 * 60);
    const sess = makeSession(orgAId, userAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: OUT_START, endAt: OUT_END, resourceIds: [acId],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.availabilityWarnings).toBeUndefined();
    await clearConfig(orgAId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2 — WARN mode
// ════════════════════════════════════════════════════════════════════════════════

describe('availability: warn mode', () => {
  it('out-of-hours booking → ok:true with availabilityWarnings, reservation created', async () => {
    const { orgAId, userAId } = env;
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'warn' });
    const acId = await seedAircraft(orgAId, userAId);
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 17 * 60);
    const sess = makeSession(orgAId, userAId);

    const resvBefore = await countReservations(orgAId);
    const result = await createReservationWithDb(db(), sess, {
      startAt: OUT_START, endAt: OUT_END, resourceIds: [acId],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.availabilityWarnings).toBeDefined();
    expect(result.availabilityWarnings!.length).toBeGreaterThan(0);
    // The whole 18:00–19:00 candidate is uncovered.
    expect(result.availabilityWarnings![0]!.startUtcMs).toBe(OUT_START.getTime());
    expect(result.availabilityWarnings![0]!.endUtcMs).toBe(OUT_END.getTime());
    expect((await countReservations(orgAId))).toBe(resvBefore + 1); // created
    await clearConfig(orgAId);
  });

  it('in-hours booking → ok:true with NO availabilityWarnings', async () => {
    const { orgAId, userAId } = env;
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'warn' });
    const acId = await seedAircraft(orgAId, userAId);
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 17 * 60);
    const sess = makeSession(orgAId, userAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: IN_START, endAt: IN_END, resourceIds: [acId],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.availabilityWarnings).toBeUndefined();
    await clearConfig(orgAId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3 — BLOCK mode
// ════════════════════════════════════════════════════════════════════════════════

describe('availability: block mode', () => {
  it('out-of-hours booking → { ok:false, reason:availability }, NO write, NO audit', async () => {
    const { orgAId, userAId } = env;
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'block' });
    const acId = await seedAircraft(orgAId, userAId);
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 17 * 60);
    const sess = makeSession(orgAId, userAId);

    const resvBefore = await countReservations(orgAId);
    const auditBefore = await countAudit(orgAId);
    const result = await createReservationWithDb(db(), sess, {
      startAt: OUT_START, endAt: OUT_END, resourceIds: [acId],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('availability');
    if (result.reason !== 'availability') throw new Error('expected availability reason');
    expect(result.availability.length).toBeGreaterThan(0);

    expect(await countReservations(orgAId)).toBe(resvBefore);
    expect(await countAudit(orgAId)).toBe(auditBefore);
    await clearConfig(orgAId);
  });

  it('in-hours booking → ok:true (block mode does not fire within hours)', async () => {
    const { orgAId, userAId } = env;
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'block' });
    const acId = await seedAircraft(orgAId, userAId);
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 17 * 60);
    const sess = makeSession(orgAId, userAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: IN_START, endAt: IN_END, resourceIds: [acId],
    });
    expect(result.ok).toBe(true);
    await clearConfig(orgAId);
  });

  it('union of two adjacent windows fully covers a spanning booking → ok', async () => {
    const { orgAId, userAId } = env;
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'block' });
    const acId = await seedAircraft(orgAId, userAId);
    // 13:00–14:30 and 14:30–17:00 → contiguous; booking 14:00–15:00 spans the seam.
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 14 * 60 + 30);
    await addWindow(orgAId, userAId, acId, WED, 14 * 60 + 30, 17 * 60);
    const sess = makeSession(orgAId, userAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: IN_START, endAt: IN_END, resourceIds: [acId],
    });
    expect(result.ok).toBe(true);
    await clearConfig(orgAId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Precedence ordering
// ════════════════════════════════════════════════════════════════════════════════

describe('availability: precedence', () => {
  it('conflict AND availability violation → conflict wins (availability never fires)', async () => {
    const { orgAId, userAId } = env;
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'block' });
    const acId = await seedAircraft(orgAId, userAId);
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 17 * 60);
    const sess = makeSession(orgAId, userAId);

    // First, book the OUT slot with availability DISABLED so the row exists.
    await clearConfig(orgAId);
    const first = await createReservationWithDb(db(), sess, {
      startAt: OUT_START, endAt: OUT_END, resourceIds: [acId],
    });
    expect(first.ok).toBe(true);

    // Re-enable block mode, then attempt the SAME out-of-hours slot → both conflict
    // (the existing booking) AND availability (out of hours) apply. Conflict wins.
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'block' });
    const result = await createReservationWithDb(db(), sess, {
      startAt: OUT_START, endAt: OUT_END, resourceIds: [acId],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('conflict');
    await clearConfig(orgAId);
  });

  it('twilight block AND availability block (no conflict) → reason:twilight (twilight evaluated before availability)', async () => {
    // Gate precedence: conflict → twilight → availability (AV1 coverage gap — NIT 3).
    // A booking BOTH outside operating hours AND crossing civil dusk under BLOCK mode
    // for both constraints must return reason='twilight' because twilight is checked
    // LAST in the chain before availability, i.e. it fires before availability.
    //
    // Setup mirrors twilight-api.test.ts: LA-ish coordinate + a night-crossing window
    // derived from computeSolarEvents so the test is self-consistent.
    const { orgAId, userAId, locationAId } = env;

    // Compute solar events for the test coordinate/date (same as twilight-api.test.ts).
    const LAT = 33.9425;
    const LON = -118.4081;
    const DAY_ANCHOR = Date.parse('2026-06-19T20:00:00Z');
    const events = computeSolarEvents({ latitude: LAT, longitude: LON, dateUtcMs: DAY_ANCHOR });
    if (events.classification !== 'normal' || events.civilDuskUtcMs === null) {
      throw new Error('test fixture: expected a normal civil day with dusk boundary');
    }
    const DUSK = events.civilDuskUtcMs;

    // NIGHT-CROSSING window: starts before dusk, ends 30 min after → twilight violation.
    const nightStart = new Date(DUSK - 30 * 60_000);
    const nightEnd   = new Date(DUSK + 30 * 60_000);

    // Set coords on the seed location so the twilight gate activates for this aircraft.
    await setCoords(orgAId, locationAId, LAT, LON);

    // Seed aircraft with home_base pointing at our coords-enabled location.
    const sess = makeSession(orgAId, userAId);
    const tag = `PREC${acCounter++}`;
    const ac = await createResourceWithDb(db(), sess, {
      kind: 'aircraft',
      displayName: `N-${tag}`,
      tailNumber: `N${tag}`,
    });
    // Link the aircraft to the seeded location so twilight gate has coords.
    await withOrgContext(env.db, orgAId, async (tx) => {
      await tx.update(resource).set({ homeBaseLocationId: locationAId }).where(eq(resource.id, ac.id));
    });

    // Add an operating-hours window for Wednesday (WED=3) that does NOT cover the
    // night-crossing window (window is 13:00–17:00 UTC; night slot is ~02:xx–03:xx UTC
    // relative to dawn — well outside 13:00–17:00). Both constraints will block.
    await addWindow(orgAId, userAId, ac.id, WED, 13 * 60, 17 * 60);

    // Enable BOTH twilight block AND availability block.
    await setBothConfigs(orgAId, {
      availabilityEnabled: true, availabilityMode: 'block',
      twilightEnabled: true,     twilightMode: 'block',
    });

    const result = await createReservationWithDb(db(), sess, {
      startAt: nightStart, endAt: nightEnd, resourceIds: [ac.id],
    });

    // Cleanup before asserting (so a failure doesn't leave dirty config).
    await clearConfig(orgAId);
    await clearCoords(orgAId, locationAId);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    // Twilight is evaluated BEFORE availability → reason must be 'twilight', NOT 'availability'.
    expect(result.reason).toBe('twilight');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Multi-resource
// ════════════════════════════════════════════════════════════════════════════════

describe('availability: multi-resource', () => {
  it('one resource out of its window in block mode → whole create blocked', async () => {
    const { orgAId, userAId } = env;
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'block' });
    const acId = await seedAircraft(orgAId, userAId);
    const instrId = await seedInstructor(orgAId, userAId);
    // Aircraft window covers the IN slot; instructor window does NOT (morning only).
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 17 * 60);
    await addWindow(orgAId, userAId, instrId, WED, 6 * 60, 10 * 60);
    const sess = makeSession(orgAId, userAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: IN_START, endAt: IN_END, resourceIds: [acId, instrId],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('availability');
    await clearConfig(orgAId);
  });

  it('one resource has windows (covers), the other has none → ok (inert per resource)', async () => {
    const { orgAId, userAId } = env;
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'block' });
    const acId = await seedAircraft(orgAId, userAId);
    const instrId = await seedInstructor(orgAId, userAId); // no windows → inert
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 17 * 60);
    const sess = makeSession(orgAId, userAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: IN_START, endAt: IN_END, resourceIds: [acId, instrId],
    });
    expect(result.ok).toBe(true);
    await clearConfig(orgAId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 6 — All write paths inherit the gate
// ════════════════════════════════════════════════════════════════════════════════

describe('availability: all write paths inherit the gate (block)', () => {
  it('createSeries: out-of-hours occurrence skipped with reason availability', async () => {
    const { orgAId, userAId } = env;
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'block' });
    const acId = await seedAircraft(orgAId, userAId);
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 17 * 60);
    const sess = makeSession(orgAId, userAId);

    // Weekly Wednesday series at 18:00 UTC (out of hours) for 60 min, 2 occurrences.
    const result = await createSeriesWithDb(db(), sess, {
      weekdays: [WED],
      intervalWeeks: 1,
      end: { kind: 'count', count: 2 },
      localStartTime: '18:00',
      durationMinutes: 60,
      tz: 'UTC',
      resourceIds: [acId],
    }, { now: Date.parse('2026-06-15T00:00:00Z') });

    expect(result.ok).toBe(true);
    expect(result.occurrences.length).toBeGreaterThan(0);
    expect(result.occurrences.every((o) => o.result === 'skipped' && o.reason === 'availability')).toBe(true);
    expect(result.occurrences[0]!.availability!.length).toBeGreaterThan(0);
    await clearConfig(orgAId);
  });

  it('rescheduleReservation: move into out-of-hours in block → refused, original intact', async () => {
    const { orgAId, userAId } = env;
    await clearConfig(orgAId);
    const acId = await seedAircraft(orgAId, userAId);
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 17 * 60);
    const sess = makeSession(orgAId, userAId);

    // Create an in-hours reservation (gate off), then enable block + move out of hours.
    const created = await createReservationWithDb(db(), sess, {
      startAt: IN_START, endAt: IN_END, resourceIds: [acId],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');

    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'block' });
    const resvBefore = await countReservations(orgAId);
    const result = await rescheduleReservationWithDb(db(), sess, {
      reservationId: created.reservation.id,
      newStartAt: OUT_START, newEndAt: OUT_END,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('availability');
    // Original intact (no net change in reservation count; original still booked).
    expect(await countReservations(orgAId)).toBe(resvBefore);
    await clearConfig(orgAId);
  });

  it('runAutoSchedule: block-mode intersection → no out-of-hours proposal placed there', async () => {
    const { orgAId, userAId } = env;
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'block' });
    const acId = await seedAircraft(orgAId, userAId);
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 17 * 60);
    const sess = makeSession(orgAId, userAId);

    // Base window = the WHOLE Wednesday (00:00–24:00 UTC); a 60-min demand.
    const base = Date.parse('2026-06-17T00:00:00Z');
    const result = await runAutoScheduleWithDb(db(), sess, {
      demands: [{ id: 'd1', requiredResourceIds: [acId], durationMinutes: 60 }],
      windowStartUtcMs: base,
      windowEndUtcMs: base + 24 * 3600_000,
    }, { now: Date.parse('2026-06-15T00:00:00Z'), seed: 1 });

    expect(result.ok).toBe(true);
    // Every created proposal must fall within 13:00–17:00 UTC (the operating hours).
    for (const p of result.proposals) {
      if (p.result === 'created') {
        expect(p.startAt.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-06-17T13:00:00Z'));
        expect(p.endAt.getTime()).toBeLessThanOrEqual(Date.parse('2026-06-17T17:00:00Z'));
      }
    }
    await clearConfig(orgAId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 7 — CRUD
// ════════════════════════════════════════════════════════════════════════════════

describe('availability CRUD', () => {
  it('create → list → delete happy path with audit rows', async () => {
    const { orgAId, userAId } = env;
    const acId = await seedAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);

    const auditBefore = await countAudit(orgAId);
    const created = await createAvailabilityWindowWithDb(db(), sess, {
      resourceId: acId, dayOfWeek: WED, startMinute: 13 * 60, endMinute: 17 * 60, tz: 'UTC',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');
    expect(created.windows.length).toBe(1);
    expect((await countAudit(orgAId)) - auditBefore).toBe(1);

    const listed = await listAvailabilityWindowsWithDb(db(), sess, { resourceId: acId });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.windows.length).toBe(1);
    const winId = listed.windows[0]!.id;

    const deleted = await deleteAvailabilityWindowWithDb(db(), sess, { windowId: winId });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) throw new Error('expected ok');
    expect(deleted.windows.length).toBe(0);
    expect((await countAudit(orgAId)) - auditBefore).toBe(2);
  });

  it('duplicate natural key → { ok:false, reason:duplicate }', async () => {
    const { orgAId, userAId } = env;
    const acId = await seedAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);
    const input = { resourceId: acId, dayOfWeek: WED, startMinute: 13 * 60, endMinute: 17 * 60, tz: 'UTC' };
    const a = await createAvailabilityWindowWithDb(db(), sess, input);
    expect(a.ok).toBe(true);
    const b = await createAvailabilityWindowWithDb(db(), sess, input);
    expect(b.ok).toBe(false);
    if (b.ok) throw new Error('expected duplicate');
    expect(b.reason).toBe('duplicate');
  });

  it('validation: endMinute <= startMinute throws ValidationError', async () => {
    const { orgAId, userAId } = env;
    const acId = await seedAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);
    await expect(createAvailabilityWindowWithDb(db(), sess, {
      resourceId: acId, dayOfWeek: WED, startMinute: 17 * 60, endMinute: 13 * 60, tz: 'UTC',
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('validation: dayOfWeek out of range throws', async () => {
    const { orgAId, userAId } = env;
    const acId = await seedAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);
    await expect(createAvailabilityWindowWithDb(db(), sess, {
      resourceId: acId, dayOfWeek: 8, startMinute: 0, endMinute: 60, tz: 'UTC',
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('validation: invalid IANA tz throws', async () => {
    const { orgAId, userAId } = env;
    const acId = await seedAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);
    await expect(createAvailabilityWindowWithDb(db(), sess, {
      resourceId: acId, dayOfWeek: WED, startMinute: 0, endMinute: 60, tz: 'Not/AZone',
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('delete unknown id → not_found', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    const r = await deleteAvailabilityWindowWithDb(db(), sess, {
      windowId: '00000000-0000-0000-0000-000000000000',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected not_found');
    expect(r.reason).toBe('not_found');
  });

  it('list unknown resource → not_found', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    const r = await listAvailabilityWindowsWithDb(db(), sess, {
      resourceId: '00000000-0000-0000-0000-000000000000',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected not_found');
    expect(r.reason).toBe('not_found');
  });

  it('authz: unauthenticated throws; insufficient role throws', async () => {
    const { orgAId, userAId } = env;
    const acId = await seedAircraft(orgAId, userAId);
    await expect(
      createAvailabilityWindowWithDb(db(), null, { resourceId: acId, dayOfWeek: WED, startMinute: 0, endMinute: 60, tz: 'UTC' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    const renter = makeSession(orgAId, userAId, 'renter');
    await expect(
      createAvailabilityWindowWithDb(db(), renter, { resourceId: acId, dayOfWeek: WED, startMinute: 0, endMinute: 60, tz: 'UTC' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('tenant isolation: org B cannot see org A windows; cross-org delete → not_found', async () => {
    const { orgAId, orgBId, userAId, userBId } = env;
    const acId = await seedAircraft(orgAId, userAId);
    const sessA = makeSession(orgAId, userAId);
    const created = await createAvailabilityWindowWithDb(db(), sessA, {
      resourceId: acId, dayOfWeek: WED, startMinute: 13 * 60, endMinute: 17 * 60, tz: 'UTC',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');
    const winId = created.windows[0]!.id;

    const sessB = makeSession(orgBId, userBId);
    // Org B listing org A's resource → not_found (resource not visible).
    const listB = await listAvailabilityWindowsWithDb(db(), sessB, { resourceId: acId });
    expect(listB.ok).toBe(false);
    // Org B deleting org A's window → not_found (window not visible).
    const delB = await deleteAvailabilityWindowWithDb(db(), sessB, { windowId: winId });
    expect(delB.ok).toBe(false);
    if (delB.ok) throw new Error('expected not_found');
    expect(delB.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Config update + audit
// ════════════════════════════════════════════════════════════════════════════════

describe('availability config', () => {
  it('updateDispatchConfig sets availability fields + writes one audit row', async () => {
    const { orgAId, userAId } = env;
    await clearConfig(orgAId);
    const sess = makeSession(orgAId, userAId);
    const auditBefore = await countAudit(orgAId);

    const r = await updateDispatchConfigWithDb(db(), sess, {
      availabilityConstraintEnabled: true, availabilityMode: 'block',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.config.availabilityConstraintEnabled).toBe(true);
    expect(r.config.availabilityMode).toBe('block');
    expect((await countAudit(orgAId)) - auditBefore).toBe(1);

    // No-op update writes nothing.
    const r2 = await updateDispatchConfigWithDb(db(), sess, {
      availabilityConstraintEnabled: true, availabilityMode: 'block',
    });
    expect(r2.ok).toBe(true);
    expect((await countAudit(orgAId)) - auditBefore).toBe(1); // unchanged
    await clearConfig(orgAId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 9 — previewAvailability (read-only, enabled-flag independent)
// ════════════════════════════════════════════════════════════════════════════════

describe('previewAvailability', () => {
  it('reports wouldViolate for out-of-hours candidate even when gate DISABLED, writes nothing', async () => {
    const { orgAId, userAId } = env;
    await clearConfig(orgAId); // gate disabled
    const acId = await seedAircraft(orgAId, userAId);
    await addWindow(orgAId, userAId, acId, WED, 13 * 60, 17 * 60);
    const sess = makeSession(orgAId, userAId);

    const auditBefore = await countAudit(orgAId);
    const resvBefore = await countReservations(orgAId);

    const out = await previewAvailabilityWithDb(db(), sess, {
      resourceIds: [acId], startAt: OUT_START, endAt: OUT_END,
    });
    expect(out.perResource[0]!.hasWindows).toBe(true);
    expect(out.perResource[0]!.wouldViolate).toBe(true);
    expect(out.perResource[0]!.hits.length).toBeGreaterThan(0);

    const inHrs = await previewAvailabilityWithDb(db(), sess, {
      resourceIds: [acId], startAt: IN_START, endAt: IN_END,
    });
    expect(inHrs.perResource[0]!.wouldViolate).toBe(false);

    // Read-only — nothing written.
    expect(await countAudit(orgAId)).toBe(auditBefore);
    expect(await countReservations(orgAId)).toBe(resvBefore);
  });

  it('resource with no windows → hasWindows:false, wouldViolate:false', async () => {
    const { orgAId, userAId } = env;
    const acId = await seedAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);
    const out = await previewAvailabilityWithDb(db(), sess, {
      resourceIds: [acId], startAt: OUT_START, endAt: OUT_END,
    });
    expect(out.perResource[0]!.hasWindows).toBe(false);
    expect(out.perResource[0]!.wouldViolate).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 10 — DST (spring-forward) snapping
// ════════════════════════════════════════════════════════════════════════════════

describe('availability: DST spring-forward', () => {
  it('a window crossing the spring-forward gap snaps and still covers a valid booking', async () => {
    // America/New_York spring-forward 2026: Sun 2026-03-08, 02:00→03:00 local.
    // ISO weekday of 2026-03-08 = Sunday = 7. Window 01:00–05:00 local spans the gap.
    // A booking at 03:30–04:30 local (post-gap) must be CONTAINED in the snapped window.
    const { orgAId, userAId } = env;
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'block' });
    const acId = await seedAircraft(orgAId, userAId);
    await addWindow(orgAId, userAId, acId, 7, 60, 5 * 60, 'America/New_York'); // 01:00–05:00 local Sun
    const sess = makeSession(orgAId, userAId);

    // 03:30 EDT = 07:30Z (post-gap, EDT = UTC-4). 04:30 EDT = 08:30Z.
    const start = new Date(Date.parse('2026-03-08T07:30:00Z'));
    const end = new Date(Date.parse('2026-03-08T08:30:00Z'));
    const result = await createReservationWithDb(db(), sess, {
      startAt: start, endAt: end, resourceIds: [acId],
    });
    expect(result.ok).toBe(true); // within the snapped operating-hours window
    await clearConfig(orgAId);
  });
});
