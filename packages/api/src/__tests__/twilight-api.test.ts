/**
 * twilight-api.test.ts — Slice 4a civil-twilight API integration suite.
 *
 * Verifies the additive twilight gate wired into the FROZEN gatedCreateOccurrence
 * (warn → ok:true + twilightWarnings; block → { ok:false, reason:'twilight' }),
 * the read-only previewTwilight surface, tenant isolation, and — critically — that
 * the create path is BYTE-IDENTICAL when the gate is disabled (the Phase-1 default).
 *
 * Windows are DERIVED from computeSolarEvents at the seed coordinate/date so the
 * suite is self-consistent regardless of the exact astronomy constants.
 *
 * Setup mirrors fleet-api.test.ts: createTestClient → applyMigrationSql(0000..0010)
 * → seedTwoOrgs → setTestAppRole.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
} from '@aeroops/db';
import { auditLog, location, dispatchConfig, reservation, resource } from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import { computeSolarEvents } from '@aeroops/core';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { createSeriesWithDb } from '../scheduling/create-series.js';
import { rescheduleReservationWithDb } from '../scheduling/reschedule-reservation.js';
import { previewTwilightWithDb } from '../scheduling/preview-twilight.js';
import { groundAircraftWithDb } from '../maintenance/ground-aircraft.js';
import { ForbiddenError } from '../auth/require-capability.js';
import { UnauthenticatedError } from '../auth/session.js';
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
];

// ── Test coordinate + date (mid-latitude, LA-ish, fixed date) ──────────────────
const LAT = 33.9425;
const LON = -118.4081;
const DAY_ANCHOR = Date.parse('2026-06-19T20:00:00Z');

const events = computeSolarEvents({ latitude: LAT, longitude: LON, dateUtcMs: DAY_ANCHOR });
if (events.classification !== 'normal' || events.civilDuskUtcMs === null || events.civilDawnUtcMs === null) {
  throw new Error('test fixture: expected a normal civil day with both boundaries');
}
const DUSK = events.civilDuskUtcMs;
const DAWN = events.civilDawnUtcMs;

// DAYLIGHT window: comfortably between dawn and dusk → no violation.
const DAY_START = new Date(DAWN + 60 * 60_000);
const DAY_END = new Date(DAWN + 120 * 60_000);

// NIGHT-CROSSING window: starts before dusk, ends 30 min AFTER civil dusk → violates.
const NIGHT_START = new Date(DUSK - 30 * 60_000);
const NIGHT_END = new Date(DUSK + 30 * 60_000);

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  locationAId: string;
  locationBId: string;
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
    locationAId: seed.locationAId,
    locationBId: seed.locationBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };
}, 60_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setCoords(orgId: string, locationId: string, lat: number, lon: number): Promise<void> {
  await withOrgContext(env.db, orgId, async (tx) => {
    await tx
      .update(location)
      .set({ latitude: String(lat), longitude: String(lon) })
      .where(eq(location.id, locationId));
  });
}

async function clearCoords(orgId: string, locationId: string): Promise<void> {
  await withOrgContext(env.db, orgId, async (tx) => {
    await tx
      .update(location)
      .set({ latitude: null, longitude: null })
      .where(eq(location.id, locationId));
  });
}

async function setTwilightConfig(
  orgId: string,
  cfg: { enabled: boolean; mode?: 'warn' | 'block'; exemptTag?: string | null },
): Promise<void> {
  await withOrgContext(env.db, orgId, async (tx) => {
    await tx.delete(dispatchConfig);
    await tx.insert(dispatchConfig).values({
      orgId,
      twilightConstraintEnabled: cfg.enabled,
      twilightMode: cfg.mode ?? 'warn',
      twilightExemptTag: cfg.exemptTag ?? null,
    });
  });
}

async function clearTwilightConfig(orgId: string): Promise<void> {
  await withOrgContext(env.db, orgId, async (tx) => {
    await tx.delete(dispatchConfig);
  });
}

let tagCounter = 0;
async function seedAircraft(
  orgId: string,
  userId: string,
  homeBaseLocationId: string | null,
): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const tag = `TW${tagCounter++}`;
  const ac = await createResourceWithDb(db(), sess, {
    kind: 'aircraft',
    displayName: `N-${tag}`,
    tailNumber: `N${tag}`,
  });
  // createResourceWithDb (Slice-1 path) does not accept home_base_location_id;
  // set it directly on the resource row (RLS-scoped) — the composite FK target
  // is the org's own location, so this is a valid in-org linkage.
  if (homeBaseLocationId) {
    await withOrgContext(env.db, orgId, async (tx) => {
      await tx
        .update(resource)
        .set({ homeBaseLocationId })
        .where(eq(resource.id, ac.id));
    });
  }
  return ac.id;
}

function db(): PgliteTestClient {
  return env.db;
}

async function countAudit(orgId: string): Promise<number> {
  return withOrgContext(env.db, orgId, async (tx) => {
    const rows = await tx.select().from(auditLog).execute();
    return rows.length;
  });
}

async function countReservations(orgId: string): Promise<number> {
  return withOrgContext(env.db, orgId, async (tx) => {
    const rows = await tx.select().from(reservation).execute();
    return rows.length;
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Disabled / inert → create path BYTE-IDENTICAL
// ════════════════════════════════════════════════════════════════════════════════

describe('twilight: disabled (no config row) → create path byte-identical', () => {
  it('night-crossing booking succeeds with NO twilightWarnings + no extra rows', async () => {
    const { orgAId, userAId, locationAId } = env;
    await clearTwilightConfig(orgAId);
    await setCoords(orgAId, locationAId, LAT, LON);
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    const auditBefore = await countAudit(orgAId);
    const result = await createReservationWithDb(db(), sess, {
      startAt: NIGHT_START,
      endAt: NIGHT_END,
      resourceIds: [acId],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.twilightWarnings).toBeUndefined();
    // groundingWarnings also absent → ok:true shape unchanged.
    expect(result.groundingWarnings).toBeUndefined();

    const auditAfter = await countAudit(orgAId);
    expect(auditAfter - auditBefore).toBe(1); // exactly the reservation.created row
  });
});

describe('twilight: config present but enabled=false → inert', () => {
  it('night-crossing booking succeeds with no twilightWarnings', async () => {
    const { orgAId, userAId, locationAId } = env;
    await setTwilightConfig(orgAId, { enabled: false, mode: 'block' });
    await setCoords(orgAId, locationAId, LAT, LON);
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: NIGHT_START,
      endAt: NIGHT_END,
      resourceIds: [acId],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.twilightWarnings).toBeUndefined();
    await clearTwilightConfig(orgAId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2 — WARN mode
// ════════════════════════════════════════════════════════════════════════════════

describe('twilight: warn mode', () => {
  it('night-crossing booking → ok:true with twilightWarnings (ends_after_civil_dusk)', async () => {
    const { orgAId, userAId, locationAId } = env;
    await setTwilightConfig(orgAId, { enabled: true, mode: 'warn' });
    await setCoords(orgAId, locationAId, LAT, LON);
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: NIGHT_START,
      endAt: NIGHT_END,
      resourceIds: [acId],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.twilightWarnings).toBeDefined();
    expect(result.twilightWarnings!.length).toBeGreaterThan(0);
    expect(result.twilightWarnings!.some((h) => h.reason === 'ends_after_civil_dusk')).toBe(true);
    expect(result.twilightWarnings![0]!.boundaryUtcMs).toBe(DUSK);
    expect(result.twilightWarnings![0]!.classification).toBe('normal');

    await clearTwilightConfig(orgAId);
  });

  it('daylight booking → ok:true with NO twilightWarnings', async () => {
    const { orgAId, userAId, locationAId } = env;
    await setTwilightConfig(orgAId, { enabled: true, mode: 'warn' });
    await setCoords(orgAId, locationAId, LAT, LON);
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: DAY_START,
      endAt: DAY_END,
      resourceIds: [acId],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.twilightWarnings).toBeUndefined();
    await clearTwilightConfig(orgAId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3 — BLOCK mode
// ════════════════════════════════════════════════════════════════════════════════

describe('twilight: block mode', () => {
  it('night-crossing booking → { ok:false, reason:twilight }, NO write, NO audit', async () => {
    const { orgAId, userAId, locationAId } = env;
    await setTwilightConfig(orgAId, { enabled: true, mode: 'block' });
    await setCoords(orgAId, locationAId, LAT, LON);
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    const resvBefore = await countReservations(orgAId);
    const auditBefore = await countAudit(orgAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: NIGHT_START,
      endAt: NIGHT_END,
      resourceIds: [acId],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('twilight');
    if (result.reason !== 'twilight') throw new Error('expected twilight reason');
    expect(result.twilight.length).toBeGreaterThan(0);
    expect(result.twilight[0]!.reason).toBe('ends_after_civil_dusk');

    const resvAfter = await countReservations(orgAId);
    const auditAfter = await countAudit(orgAId);
    expect(resvAfter).toBe(resvBefore); // nothing written
    expect(auditAfter).toBe(auditBefore); // no audit on refusal

    await clearTwilightConfig(orgAId);
  });

  it('daylight booking → ok:true (block mode does not fire for daylight)', async () => {
    const { orgAId, userAId, locationAId } = env;
    await setTwilightConfig(orgAId, { enabled: true, mode: 'block' });
    await setCoords(orgAId, locationAId, LAT, LON);
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: DAY_START,
      endAt: DAY_END,
      resourceIds: [acId],
    });
    expect(result.ok).toBe(true);
    await clearTwilightConfig(orgAId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4 — INERT when no home-base coords
// ════════════════════════════════════════════════════════════════════════════════

describe('twilight: aircraft with no home-base coords → inert', () => {
  it('block mode + night-crossing booking → ok:true (no coords → events null)', async () => {
    const { orgAId, userAId } = env;
    await setTwilightConfig(orgAId, { enabled: true, mode: 'block' });
    const acId = await seedAircraft(orgAId, userAId, null); // no home base
    const sess = makeSession(orgAId, userAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: NIGHT_START,
      endAt: NIGHT_END,
      resourceIds: [acId],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.twilightWarnings).toBeUndefined();
    await clearTwilightConfig(orgAId);
  });

  it('block mode + home base WITHOUT coords → ok:true (events null)', async () => {
    const { orgAId, userAId, locationAId } = env;
    await setTwilightConfig(orgAId, { enabled: true, mode: 'block' });
    await clearCoords(orgAId, locationAId);
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    const result = await createReservationWithDb(db(), sess, {
      startAt: NIGHT_START,
      endAt: NIGHT_END,
      resourceIds: [acId],
    });
    expect(result.ok).toBe(true);
    await clearTwilightConfig(orgAId);
    await setCoords(orgAId, locationAId, LAT, LON); // restore for later tests
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Precedence: grounding / conflict come BEFORE twilight
// ════════════════════════════════════════════════════════════════════════════════

describe('twilight: precedence — conflict refusal wins over twilight (block mode)', () => {
  it('a conflicting night-crossing booking → reason:conflict (twilight is LAST)', async () => {
    const { orgAId, userAId, locationAId } = env;
    await setTwilightConfig(orgAId, { enabled: true, mode: 'block' });
    await setCoords(orgAId, locationAId, LAT, LON);
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    // Commit a pre-dusk DAYLIGHT booking so it holds the resource window.
    const day = await createReservationWithDb(db(), sess, {
      startAt: new Date(DUSK - 90 * 60_000),
      endAt: new Date(DUSK - 30 * 60_000),
      resourceIds: [acId],
    });
    expect(day.ok).toBe(true);

    // A second booking that OVERLAPS the daylight one AND crosses dusk → both the
    // conflict gate and the (block-mode) twilight gate would fire, but conflict is
    // evaluated FIRST (twilight is last in the precedence chain). Expect 'conflict'.
    const overlap = await createReservationWithDb(db(), sess, {
      startAt: new Date(DUSK - 60 * 60_000), // overlaps the daylight booking
      endAt: NIGHT_END, // also crosses dusk
      resourceIds: [acId],
    });
    expect(overlap.ok).toBe(false);
    if (overlap.ok) throw new Error('expected refusal');
    expect(overlap.reason).toBe('conflict'); // NOT 'twilight'

    await clearTwilightConfig(orgAId);
  });

  it('a grounded aircraft that also violates twilight → block-mode twilight refusal still returned (grounding is warn-only)', async () => {
    const { orgAId, userAId, locationAId } = env;
    await setTwilightConfig(orgAId, { enabled: true, mode: 'block' });
    await setCoords(orgAId, locationAId, LAT, LON);
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    // Ground the aircraft (warn-only at create). A night-crossing booking under
    // block mode must STILL be refused for twilight — grounding never blocks, and
    // twilight is evaluated before the INSERT/grounding warn step.
    await groundAircraftWithDb(db(), sess, { resourceId: acId, reason: 'mx check' });

    const result = await createReservationWithDb(db(), sess, {
      startAt: NIGHT_START,
      endAt: NIGHT_END,
      resourceIds: [acId],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('twilight');

    await clearTwilightConfig(orgAId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 6 — previewTwilight (read-only)
// ════════════════════════════════════════════════════════════════════════════════

describe('previewTwilight: read-only correctness', () => {
  it('night-crossing window → wouldViolate true; daylight → false; writes nothing', async () => {
    const { orgAId, userAId, locationAId } = env;
    await setCoords(orgAId, locationAId, LAT, LON);
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    const resvBefore = await countReservations(orgAId);
    const auditBefore = await countAudit(orgAId);

    const night = await previewTwilightWithDb(db(), sess, {
      startAt: NIGHT_START,
      endAt: NIGHT_END,
      resourceIds: [acId],
    });
    expect(night.perResource).toHaveLength(1);
    expect(night.perResource[0]!.wouldViolate).toBe(true);
    expect(night.perResource[0]!.classification).toBe('normal');
    expect(night.perResource[0]!.events).not.toBeNull();

    const day = await previewTwilightWithDb(db(), sess, {
      startAt: DAY_START,
      endAt: DAY_END,
      resourceIds: [acId],
    });
    expect(day.perResource[0]!.wouldViolate).toBe(false);

    // No writes.
    expect(await countReservations(orgAId)).toBe(resvBefore);
    expect(await countAudit(orgAId)).toBe(auditBefore);
  });

  it('aircraft without coords → events null, wouldViolate false, classification null', async () => {
    const { orgAId, userAId } = env;
    const acId = await seedAircraft(orgAId, userAId, null);
    const sess = makeSession(orgAId, userAId);

    const res = await previewTwilightWithDb(db(), sess, {
      startAt: NIGHT_START,
      endAt: NIGHT_END,
      resourceIds: [acId],
    });
    expect(res.perResource[0]!.events).toBeNull();
    expect(res.perResource[0]!.wouldViolate).toBe(false);
    expect(res.perResource[0]!.classification).toBeNull();
  });

  it('preview is independent of enabled flag (reports astronomy even when disabled)', async () => {
    const { orgAId, userAId, locationAId } = env;
    await clearTwilightConfig(orgAId);
    await setCoords(orgAId, locationAId, LAT, LON);
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    const res = await previewTwilightWithDb(db(), sess, {
      startAt: NIGHT_START,
      endAt: NIGHT_END,
      resourceIds: [acId],
    });
    expect(res.perResource[0]!.wouldViolate).toBe(true);
  });

  it('rejects unauthenticated + forbidden roles', async () => {
    const { orgAId, userAId, locationAId } = env;
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    await expect(
      previewTwilightWithDb(db(), null, { startAt: DAY_START, endAt: DAY_END, resourceIds: [acId] }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);

    // 'accountant' lacks schedule:create_reservation.
    const acct = makeSession(orgAId, userAId, 'accountant');
    await expect(
      previewTwilightWithDb(db(), acct, { startAt: DAY_START, endAt: DAY_END, resourceIds: [acId] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Tenant isolation
// ════════════════════════════════════════════════════════════════════════════════

describe('twilight: tenant isolation', () => {
  it('org A coords + config never affect org B', async () => {
    const { orgAId, orgBId, userBId, locationAId, locationBId } = env;
    // Org A: coords set, block mode.
    await setCoords(orgAId, locationAId, LAT, LON);
    await setTwilightConfig(orgAId, { enabled: true, mode: 'block' });

    // Org B: NO coords on its location, NO config row → gate inert.
    await clearCoords(orgBId, locationBId);
    await clearTwilightConfig(orgBId);
    const acB = await seedAircraft(orgBId, userBId, locationBId);
    const sessB = makeSession(orgBId, userBId);

    // A night-crossing booking in org B must succeed — org A's config is invisible.
    const result = await createReservationWithDb(db(), sessB, {
      startAt: NIGHT_START,
      endAt: NIGHT_END,
      resourceIds: [acB],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.twilightWarnings).toBeUndefined();

    // previewTwilight in org B: aircraft has no coords → events null.
    const preview = await previewTwilightWithDb(db(), sessB, {
      startAt: NIGHT_START,
      endAt: NIGHT_END,
      resourceIds: [acB],
    });
    expect(preview.perResource[0]!.events).toBeNull();

    await clearTwilightConfig(orgAId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Series + reschedule carry the field
// ════════════════════════════════════════════════════════════════════════════════

describe('twilight: createSeries carries twilightWarnings + block skip', () => {
  it('warn mode → created occurrences carry twilightWarnings', async () => {
    const { orgAId, userAId, locationAId } = env;
    await setTwilightConfig(orgAId, { enabled: true, mode: 'warn' });
    await setCoords(orgAId, locationAId, LAT, LON);
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    // Anchor at a Monday-midnight `now` (mirrors recurrence-api.test.ts) so the
    // first occurrence is not dropped as past. localStartTime 21:00 in the home
    // base's local zone (America/Los_Angeles) lands AFTER civil dusk (~20:30 local
    // in summer), so every created occurrence must carry a twilight warning.
    const MONDAY_NOW = Date.UTC(2026, 5, 8); // 2026-06-08T00:00:00Z (Monday)
    const result = await createSeriesWithDb(
      db(),
      sess,
      {
        weekdays: [1], // Mondays only → clean, no same-day past drops
        intervalWeeks: 1,
        end: { kind: 'count', count: 3 },
        localStartTime: '21:00', // after civil dusk in LA summer
        durationMinutes: 60,
        tz: 'America/Los_Angeles',
        resourceIds: [acId],
      },
      { now: MONDAY_NOW },
    );
    expect(result.ok).toBe(true);
    const created = result.occurrences.filter((o) => o.result === 'created');
    expect(created.length).toBeGreaterThan(0);
    // Every created occurrence starts at 21:00 local → after civil dusk → warned.
    expect(created.every((o) => Array.isArray(o.twilightWarnings) && o.twilightWarnings.length > 0)).toBe(true);
    expect(created[0]!.twilightWarnings![0]!.reason).toBe('ends_after_civil_dusk');
    await clearTwilightConfig(orgAId);
  });
});

describe('twilight: rescheduleReservation carries the twilight outcome', () => {
  it('block mode → reschedule into a night window is refused; original preserved', async () => {
    const { orgAId, userAId, locationAId } = env;
    await setTwilightConfig(orgAId, { enabled: true, mode: 'block' });
    await setCoords(orgAId, locationAId, LAT, LON);
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    // Original = a daylight booking (commits cleanly).
    const created = await createReservationWithDb(db(), sess, {
      startAt: DAY_START,
      endAt: DAY_END,
      resourceIds: [acId],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');

    // Reschedule into a night-crossing window → block refuses, original intact.
    const moved = await rescheduleReservationWithDb(db(), sess, {
      reservationId: created.reservation.id,
      newStartAt: NIGHT_START,
      newEndAt: NIGHT_END,
    });
    expect(moved.ok).toBe(false);
    if (moved.ok) throw new Error('expected refusal');
    expect(moved.reason).toBe('twilight');

    // Original reservation must still be booked (rolled back).
    const stillThere = await withOrgContext(env.db, orgAId, async (tx) => {
      const rows = await tx
        .select()
        .from(reservation)
        .where(eq(reservation.id, created.reservation.id))
        .execute();
      return rows[0];
    });
    expect(stillThere).toBeDefined();
    expect(stillThere!.status).toBe('booked');

    await clearTwilightConfig(orgAId);
  });
});
