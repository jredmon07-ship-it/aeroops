/**
 * fleet-api.test.ts — API integration tests for Fleet (Slice 5.2).
 *
 * Tests the persistence/DB layer for fleet reads + aircraft identity edit.
 * Applies migrations 0000–0007 (migration 0007 = fleet columns + location
 * composite key + composite FK).
 *
 * COVERAGE (per spec §5 T8–T25 + cap T26):
 *
 * T26 — CAPABILITIES:
 *   fleet:access granted/denied per role matrix
 *   fleet:manage granted/denied per role matrix (cfi denied manage)
 *   renter/student/accountant denied both
 *
 * T8  — listAircraft happy path: active-only default
 * T9  — listAircraft tenant isolation: cross-org aircraft invisible
 * T10 — listAircraft authz: renter/student → ForbiddenError; null → UnauthenticatedError
 * T11 — listAircraft includeInactive includes inactive aircraft
 * T12 — getAircraftDetail happy (all facets: identity + homeBase + grounding +
 *        squawks + dispatch + current meters + upcoming reservations)
 * T13 — getAircraftDetail per-facet tenant isolation: cross-org id → not_found
 * T14 — getAircraftDetail non-aircraft resource → not_found
 * T15 — getAircraftDetail no dispatch history → empty list + null meters
 * T16 — getAircraftDetail only open/voided tickets → null current meters + non-empty list
 * T17 — getAircraftDetail grounded aircraft (grounding facet populated)
 * T18 — getAircraftDetail no home base → homeBase null
 * T19 — getAircraftDetail authz: renter → ForbiddenError; null → UnauthenticatedError
 * T20 — updateAircraft happy: fields updated + ONE audit row + fresh detail
 * T21 — updateAircraft ONE audit row per call (not zero, not two)
 * T22 — updateAircraft non-editable fields (tailNumber, kind, active) unwritable
 * T23 — updateAircraft target not found (cross-org or non-aircraft) → not_found
 * T24 — updateAircraft invalid_home_base (cross-org location id)
 * T25 — updateAircraft authz: cfi denied fleet:manage → ForbiddenError
 * T25b — updateAircraft year out of range → ValidationError
 * T25c — listLocations RLS: only same-org locations returned
 * T25d — listLocations authz: renter → ForbiddenError; null → UnauthenticatedError
 *
 * Setup pattern: createTestClient() → applyMigrationSql([0000–0007]) →
 * seedTwoOrgs → additional seed → setTestAppRole.
 */

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
  loadMigrationSql,
} from '@aeroops/db';
import { auditLog, location } from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { voidDispatchWithDb } from '../dispatch/void-dispatch.js';
import { groundAircraftWithDb } from '../maintenance/ground-aircraft.js';
import { reportSquawkWithDb } from '../maintenance/report-squawk.js';

import { listAircraftWithDb, listAircraftPageWithDb } from '../fleet/list-aircraft.js';
import { getAircraftDetailWithDb } from '../fleet/get-aircraft-detail.js';
import { updateAircraftWithDb } from '../fleet/update-aircraft.js';
import { listLocationsWithDb } from '../fleet/list-locations.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';
import { can } from '@aeroops/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// All up migrations through 0038 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0042');

// ── Shared test env ──────────────────────────────────────────────────────────

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

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

// Future dates so booking-policy min-advance checks pass.
const D  = '2026-09-15';
const D2 = '2026-09-16';
const T = {
  W1_start: new Date(`${D}T08:00:00Z`),
  W1_end:   new Date(`${D}T10:00:00Z`),
  W2_start: new Date(`${D2}T08:00:00Z`),
  W2_end:   new Date(`${D2}T10:00:00Z`),
};

let sharedEnv: TestEnv;

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });

  sharedEnv = {
    db,
    pglite,
    orgAId:     seed.orgAId,
    orgBId:     seed.orgBId,
    locationAId: seed.locationAId,
    locationBId: seed.locationBId,
    userAId:    seed.userAId,
    userBId:    seed.userBId,
  };
}, 60_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedAircraft(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tag: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `N-FLEET-${tag}`,
    tailNumber: `NF${tag}`,
    ...extra,
  });
  return aircraft.id;
}

async function seedReservationWithAircraft(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tag: string,
  start = T.W1_start,
  end   = T.W1_end,
): Promise<{ aircraftId: string; reservationId: string }> {
  const sess = makeSession(orgId, userId, 'owner');
  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `N-FLEET-${tag}`,
    tailNumber: `NF${tag}`,
  });
  const rResult = await createReservationWithDb(db, sess, {
    startAt: start,
    endAt: end,
    resourceIds: [aircraft.id],
  });
  if (!rResult.ok) throw new Error(`seed reservation failed: ${rResult.reason}`);
  return { aircraftId: aircraft.id, reservationId: rResult.reservation.id };
}

async function seedLocation(
  db: PgliteTestClient,
  orgId: string,
  name: string,
  icao: string | null = null,
): Promise<string> {
  const [loc] = await withOrgContext(db, orgId, async (tx) => {
    return tx
      .insert(location)
      .values({ orgId, name, icao: icao ?? undefined })
      .returning({ id: location.id });
  });
  return loc!.id;
}

// ════════════════════════════════════════════════════════════════════════════════
// T26 — CAPABILITIES matrix
// ════════════════════════════════════════════════════════════════════════════════

describe('T26 — fleet capabilities matrix', () => {
  // fleet:access → owner/manager/dispatcher/cfi/mechanic
  const ACCESS_GRANTED = ['owner', 'manager', 'dispatcher', 'cfi', 'mechanic'] as const;
  const ACCESS_EXCLUDED = ['renter', 'student', 'accountant'] as const;

  // fleet:manage → owner/manager/dispatcher/mechanic (NOT cfi)
  const MANAGE_GRANTED  = ['owner', 'manager', 'dispatcher', 'mechanic'] as const;
  const MANAGE_EXCLUDED = ['cfi', 'renter', 'student', 'accountant'] as const;

  describe('fleet:access', () => {
    for (const role of ACCESS_GRANTED) {
      it(`${role} HAS fleet:access`, () => {
        expect(can(role, 'fleet:access')).toBe(true);
      });
    }
    for (const role of ACCESS_EXCLUDED) {
      it(`${role} does NOT have fleet:access`, () => {
        expect(can(role, 'fleet:access')).toBe(false);
      });
    }
  });

  describe('fleet:manage', () => {
    for (const role of MANAGE_GRANTED) {
      it(`${role} HAS fleet:manage`, () => {
        expect(can(role, 'fleet:manage')).toBe(true);
      });
    }
    for (const role of MANAGE_EXCLUDED) {
      it(`${role} does NOT have fleet:manage`, () => {
        expect(can(role, 'fleet:manage')).toBe(false);
      });
    }
  });

  it('renter/student/accountant denied BOTH fleet caps', () => {
    for (const role of ['renter', 'student', 'accountant'] as const) {
      expect(can(role, 'fleet:access')).toBe(false);
      expect(can(role, 'fleet:manage')).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T8-T11 — listAircraft
// ════════════════════════════════════════════════════════════════════════════════

describe('T8 — listAircraft happy path (active-only default)', () => {
  it('returns aircraft for session org, active only by default', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const id = await seedAircraft(db, orgAId, userAId, 'LIST01');
    const rows = await listAircraftWithDb(db, sess);

    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.tailNumber).toBe('NFLIST01');
    expect(row!.active).toBe(true);
    expect(typeof row!.grounded).toBe('boolean');
    expect(typeof row!.openSquawkCount).toBe('number');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T8b — listAircraftPage: keyset pagination (scale-hardening)
// ════════════════════════════════════════════════════════════════════════════════

describe('T8b — listAircraftPage keyset pagination', () => {
  it('paginates the whole fleet with a working nextCursor; last page has none', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Seed several aircraft with deterministic tail numbers.
    const stamp = `PG${Date.now() % 100000}`;
    for (let i = 0; i < 6; i++) {
      await seedAircraft(db, orgAId, userAId, `${stamp}${i}`);
    }

    // Full unbounded read = ground truth ordering.
    const all = await listAircraftWithDb(db, sess, { includeInactive: true });
    const total = all.length;
    expect(total).toBeGreaterThanOrEqual(6);

    const pageSize = 3;
    const seen: string[] = [];
    let cursor: import('../fleet/types.js').AircraftCursor | undefined;
    let pages = 0;
    for (;;) {
      const page = await listAircraftPageWithDb(db, sess, {
        includeInactive: true,
        limit: pageSize,
        ...(cursor ? { cursor } : {}),
      });
      pages++;
      expect(page.rows.length).toBeLessThanOrEqual(pageSize);
      for (const r of page.rows) seen.push(r.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (pages > 100) throw new Error('pagination did not terminate');
    }

    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toEqual(all.map((r) => r.id));
  });

  it('page rows carry the same enrichment (grounded / counts) as the unbounded read', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const page = await listAircraftPageWithDb(db, sess, { includeInactive: true, limit: 500 });
    for (const r of page.rows) {
      expect(typeof r.grounded).toBe('boolean');
      expect(typeof r.openSquawkCount).toBe('number');
      expect(typeof r.openWorkOrderCount).toBe('number');
    }
  });

  it('first page respects the requested limit and returns a nextCursor when more exist', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const first = await listAircraftPageWithDb(db, sess, { includeInactive: true, limit: 2 });
    expect(first.rows.length).toBe(2);
    expect(first.nextCursor).toBeDefined();
  });

  it('caps the page size at MAX (500)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const page = await listAircraftPageWithDb(db, sess, { includeInactive: true, limit: 100_000 });
    const all = await listAircraftWithDb(db, sess, { includeInactive: true });
    expect(page.rows.length).toBe(all.length);
    expect(page.nextCursor).toBeUndefined();
  });

  it('T-ISO — a cursor cannot cross orgs (org-B aircraft never leak into org-A paging)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const idB = await seedAircraft(db, orgBId, userBId, `ISOPG${Date.now() % 100000}`);

    let cursor: import('../fleet/types.js').AircraftCursor | undefined;
    const seen: string[] = [];
    for (;;) {
      const page = await listAircraftPageWithDb(db, sessA, {
        includeInactive: true,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      for (const r of page.rows) seen.push(r.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).not.toContain(idB);
  });

  it('enforces fleet:access (renter → ForbiddenError; null → Unauthenticated)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    await expect(
      listAircraftPageWithDb(db, makeSession(orgAId, userAId, 'renter')),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAircraftPageWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('T9 — listAircraft tenant isolation', () => {
  it('cross-org aircraft invisible (RLS-scoped)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');

    const idB = await seedAircraft(db, orgBId, userBId, 'ISOB01');
    const rowsA = await listAircraftWithDb(db, sessA);

    expect(rowsA.find((r) => r.id === idB)).toBeUndefined();

    const rowsB = await listAircraftWithDb(db, sessB);
    expect(rowsB.find((r) => r.id === idB)).toBeDefined();
  });
});

describe('T10 — listAircraft authz', () => {
  it('null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(listAircraftWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('renter (no fleet:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(listAircraftWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('student (no fleet:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'student');
    await expect(listAircraftWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('accountant (no fleet:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'accountant');
    await expect(listAircraftWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('mechanic (fleet:access) → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'mechanic');
    const rows = await listAircraftWithDb(db, sess);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('cfi (fleet:access) → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'cfi');
    const rows = await listAircraftWithDb(db, sess);
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe('T11 — listAircraft includeInactive', () => {
  it('inactive aircraft excluded by default, included when includeInactive=true', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Create + deactivate an aircraft.
    const id = await seedAircraft(db, orgAId, userAId, 'INACT01');
    // Deactivate directly in org context.
    await withOrgContext(db, orgAId, async (tx) => {
      const { resource: r } = await import('@aeroops/db');
      await tx.update(r).set({ active: false }).where(eq(r.id, id));
    });

    const activeOnly = await listAircraftWithDb(db, sess);
    expect(activeOnly.find((r) => r.id === id)).toBeUndefined();

    const withInactive = await listAircraftWithDb(db, sess, { includeInactive: true });
    const inactiveRow = withInactive.find((r) => r.id === id);
    expect(inactiveRow).toBeDefined();
    expect(inactiveRow!.active).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T12 — getAircraftDetail happy path (all facets)
// ════════════════════════════════════════════════════════════════════════════════

describe('T12 — getAircraftDetail happy path (all facets)', () => {
  it('aggregates identity + homeBase + grounding + squawks + dispatch + meters + upcoming', async () => {
    const { db, orgAId, userAId, locationAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Seed aircraft with home base.
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-DETAIL-FULL',
      tailNumber: 'NDTLFULL',
    });
    // Set home base via update.
    await updateAircraftWithDb(db, sess, {
      resourceId: aircraft.id,
      make: 'Cessna',
      model: '172',
      year: 1985,
      serialNumber: 'SN12345',
      homeBaseLocationId: locationAId,
    });

    // Seed a squawk.
    await reportSquawkWithDb(db, sess, {
      resourceId: aircraft.id,
      title: 'Oil pressure low',
      severity: 'high',
    });

    // Seed a completed dispatch (provides current meters).
    const rResult = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt:   T.W1_end,
      resourceIds: [aircraft.id],
    });
    if (!rResult.ok) throw new Error('seed reservation failed');
    const openResult = await openDispatchWithDb(db, sess, {
      reservationId: rResult.reservation.id,
      resourceId:    aircraft.id,
      pilotUserId:   userAId,
      hobbsOut: 100,
      tachOut:  100,
    });
    if (!openResult.ok) throw new Error('open dispatch failed');
    const closeResult = await closeDispatchWithDb(db, sess, {
      ticketId: openResult.ticket.id,
      hobbsIn: 101.2,
      tachIn:  101.1,
    });
    if (!closeResult.ok) throw new Error('close dispatch failed');

    // Seed an upcoming reservation.
    const upcomingResult = await createReservationWithDb(db, sess, {
      startAt: T.W2_start,
      endAt:   T.W2_end,
      resourceIds: [aircraft.id],
    });
    if (!upcomingResult.ok) throw new Error('upcoming reservation seed failed');

    const result = await getAircraftDetailWithDb(db, sess, { resourceId: aircraft.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const a = result.aircraft;

    // Identity.
    expect(a.id).toBe(aircraft.id);
    expect(a.tailNumber).toBe('NDTLFULL');
    expect(a.make).toBe('Cessna');
    expect(a.model).toBe('172');
    expect(a.year).toBe(1985);
    expect(a.serialNumber).toBe('SN12345');
    expect(a.hasHobbs).toBe(true);
    expect(a.hasTach).toBe(true);

    // Home base.
    expect(a.homeBase).not.toBeNull();
    expect(a.homeBase!.id).toBe(locationAId);
    expect(typeof a.homeBase!.name).toBe('string');

    // Grounding (not grounded).
    expect(a.grounding.grounded).toBe(false);

    // Squawks.
    expect(a.openSquawkCount).toBeGreaterThanOrEqual(1);
    expect(a.recentSquawks.length).toBeGreaterThanOrEqual(1);
    expect(a.recentSquawks[0]!.title).toBe('Oil pressure low');

    // Dispatch.
    expect(a.recentDispatch.length).toBeGreaterThanOrEqual(1);
    expect(a.recentDispatch[0]!.status).toBe('closed');

    // Current meters from latest closed ticket.
    expect(a.currentHobbs).toBeCloseTo(101.2, 1);
    expect(a.currentTach).toBeCloseTo(101.1, 1);
    expect(a.currentMetersAsOf).toBeInstanceOf(Date);

    // Upcoming reservations.
    expect(a.upcomingReservations.length).toBeGreaterThanOrEqual(1);
    expect(a.upcomingReservations[0]!.startAt).toBeInstanceOf(Date);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T13 — getAircraftDetail per-facet tenant isolation
// ════════════════════════════════════════════════════════════════════════════════

describe('T13 — getAircraftDetail per-facet tenant isolation', () => {
  it('cross-org aircraft id → not_found (no facet leak: grounding, squawk, dispatch, reservation)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');

    // Seed aircraft in org B with all four facets populated.
    // Order matters: dispatch must be opened BEFORE grounding (grounded aircraft
    // blocks openDispatch), so we seed dispatch+close first, then ground.
    const { aircraftId: idB, reservationId: resIdB } =
      await seedReservationWithAircraft(db, orgBId, userBId, 'ISOB02ISO', T.W1_start, T.W1_end);

    // Open squawk in org B.
    await reportSquawkWithDb(db, sessB, {
      resourceId: idB,
      title: 'ISO squawk',
      severity: 'low',
    });

    // Closed dispatch ticket in org B (provides current meters). Must run BEFORE
    // grounding since openDispatch rejects grounded aircraft.
    const openRes = await openDispatchWithDb(db, sessB, {
      reservationId: resIdB,
      resourceId: idB,
      pilotUserId: userBId,
      hobbsOut: 200,
      tachOut: 200,
    });
    if (!openRes.ok) throw new Error('ISO seed open dispatch failed');
    const closeRes = await closeDispatchWithDb(db, sessB, {
      ticketId: openRes.ticket.id,
      hobbsIn: 201,
      tachIn: 201,
    });
    if (!closeRes.ok) throw new Error('ISO seed close dispatch failed');

    // Grounding event in org B (after dispatch so the grounding check doesn't block).
    await groundAircraftWithDb(db, sessB, { resourceId: idB, reason: 'ISO grounding test' });

    // Future reservation in org B.
    const futureRes = await createReservationWithDb(db, sessB, {
      startAt: T.W2_start,
      endAt: T.W2_end,
      resourceIds: [idB],
    });
    if (!futureRes.ok) throw new Error('ISO seed future reservation failed');

    // Org A session must see not_found for org B's aircraft id — no facet leak.
    const result = await getAircraftDetailWithDb(db, sessA, { resourceId: idB });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T14 — getAircraftDetail non-aircraft → not_found
// ════════════════════════════════════════════════════════════════════════════════

describe('T14 — getAircraftDetail non-aircraft → not_found', () => {
  it('instructor resource id → not_found', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Create an instructor resource.
    const instructor = await createResourceWithDb(db, sess, {
      kind: 'instructor',
      displayName: 'Bob CFI',
      instructorUserId: userAId,
    });

    const result = await getAircraftDetailWithDb(db, sess, { resourceId: instructor.id });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T15 — getAircraftDetail no dispatch history → empty list + null meters
// ════════════════════════════════════════════════════════════════════════════════

describe('T15 — getAircraftDetail no dispatch history', () => {
  it('no tickets → recentDispatch empty, all meter fields null', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const id = await seedAircraft(db, orgAId, userAId, 'NODISP01');
    const result = await getAircraftDetailWithDb(db, sess, { resourceId: id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.aircraft.recentDispatch).toHaveLength(0);
    expect(result.aircraft.currentHobbs).toBeNull();
    expect(result.aircraft.currentTach).toBeNull();
    expect(result.aircraft.currentMetersAsOf).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T16 — getAircraftDetail only open/voided tickets → null current meters
// ════════════════════════════════════════════════════════════════════════════════

describe('T16 — getAircraftDetail only open/voided tickets → null current meters', () => {
  it('open ticket only → null meters, non-empty recentDispatch', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const { aircraftId, reservationId } = await seedReservationWithAircraft(
      db, orgAId, userAId, 'OPENONLY01',
    );

    // Open but do NOT close.
    await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 50,
      tachOut:  50,
    });

    const result = await getAircraftDetailWithDb(db, sess, { resourceId: aircraftId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.aircraft.recentDispatch.length).toBeGreaterThanOrEqual(1);
    expect(result.aircraft.currentHobbs).toBeNull();
    expect(result.aircraft.currentTach).toBeNull();
    expect(result.aircraft.currentMetersAsOf).toBeNull();
  });

  it('voided ticket only → null meters, non-empty recentDispatch', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const { aircraftId, reservationId } = await seedReservationWithAircraft(
      db, orgAId, userAId, 'VOIDONLY01',
    );

    const openResult = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 50,
      tachOut:  50,
    });
    if (!openResult.ok) throw new Error('open failed');
    await voidDispatchWithDb(db, sess, { ticketId: openResult.ticket.id, reason: 'test void' });

    const result = await getAircraftDetailWithDb(db, sess, { resourceId: aircraftId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.aircraft.recentDispatch.length).toBeGreaterThanOrEqual(1);
    expect(result.aircraft.currentHobbs).toBeNull();
    expect(result.aircraft.currentTach).toBeNull();
    expect(result.aircraft.currentMetersAsOf).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T17 — getAircraftDetail grounded aircraft
// ════════════════════════════════════════════════════════════════════════════════

describe('T17 — getAircraftDetail grounded aircraft', () => {
  it('grounded aircraft → grounding.grounded=true, reason populated', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const id = await seedAircraft(db, orgAId, userAId, 'GRND01');
    await groundAircraftWithDb(db, sess, {
      resourceId: id,
      reason: 'Gear not retracting',
    });

    const result = await getAircraftDetailWithDb(db, sess, { resourceId: id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.aircraft.grounding.grounded).toBe(true);
    expect(result.aircraft.grounding.reason).toBe('Gear not retracting');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T18 — getAircraftDetail no home base
// ════════════════════════════════════════════════════════════════════════════════

describe('T18 — getAircraftDetail no home base', () => {
  it('aircraft without homeBaseLocationId → homeBase null', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const id = await seedAircraft(db, orgAId, userAId, 'NOHOME01');
    const result = await getAircraftDetailWithDb(db, sess, { resourceId: id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.aircraft.homeBase).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T19 — getAircraftDetail authz
// ════════════════════════════════════════════════════════════════════════════════

describe('T19 — getAircraftDetail authz', () => {
  it('null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(
      getAircraftDetailWithDb(db, null, { resourceId: '00000000-0000-0000-0000-000000000001' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('renter → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(
      getAircraftDetailWithDb(db, sess, { resourceId: '00000000-0000-0000-0000-000000000001' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('invalid UUID → ValidationError (before any DB access)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      getAircraftDetailWithDb(db, sess, { resourceId: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T20 — updateAircraft happy path
// ════════════════════════════════════════════════════════════════════════════════

describe('T20 — updateAircraft happy path', () => {
  it('updates editable identity fields and returns fresh detail', async () => {
    const { db, orgAId, userAId, locationAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const id = await seedAircraft(db, orgAId, userAId, 'UPD01');

    const result = await updateAircraftWithDb(db, sess, {
      resourceId: id,
      make: 'Piper',
      model: 'Cherokee',
      year: 1975,
      serialNumber: 'SN99999',
      homeBaseLocationId: locationAId,
      hasHobbs: false,
      hasTach: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const a = result.aircraft;
    expect(a.make).toBe('Piper');
    expect(a.model).toBe('Cherokee');
    expect(a.year).toBe(1975);
    expect(a.serialNumber).toBe('SN99999');
    expect(a.homeBase!.id).toBe(locationAId);
    expect(a.hasHobbs).toBe(false);
    expect(a.hasTach).toBe(true);
    // Tail # and kind unchanged (non-editable).
    expect(a.tailNumber).toBe('NFUPD01');
  });

  it('can clear homeBase by setting homeBaseLocationId to null', async () => {
    const { db, orgAId, userAId, locationAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const id = await seedAircraft(db, orgAId, userAId, 'UPD02');

    // First set a home base.
    await updateAircraftWithDb(db, sess, {
      resourceId: id,
      homeBaseLocationId: locationAId,
    });

    // Then clear it.
    const result = await updateAircraftWithDb(db, sess, {
      resourceId: id,
      homeBaseLocationId: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aircraft.homeBase).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T21 — updateAircraft: exactly ONE audit row per call
// ════════════════════════════════════════════════════════════════════════════════

describe('T21 — updateAircraft ONE audit row per call', () => {
  it('exactly one aircraft.updated audit row written per updateAircraft call', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const id = await seedAircraft(db, orgAId, userAId, 'AUDIT01');

    // Count audit rows before.
    const before = await withOrgContext(db, orgAId, async (tx) => {
      return tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'aircraft.updated'),
            eq(auditLog.entityId, id),
          ),
        );
    });

    await updateAircraftWithDb(db, sess, {
      resourceId: id,
      make: 'Beechcraft',
    });

    const after = await withOrgContext(db, orgAId, async (tx) => {
      return tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'aircraft.updated'),
            eq(auditLog.entityId, id),
          ),
        );
    });

    expect(after.length - before.length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T22 — updateAircraft: non-editable fields unwritable
// ════════════════════════════════════════════════════════════════════════════════

describe('T22 — updateAircraft: non-editable fields unwritable', () => {
  it('tailNumber field in input is ignored (not in schema → ValidationError or ignored)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const id = await seedAircraft(db, orgAId, userAId, 'NOEDIT01');

    // The Zod schema does not accept tailNumber — it either throws ValidationError
    // or strips the field. Either way, the tail number is unchanged after the call.
    let resultOk = false;
    try {
      const result = await updateAircraftWithDb(db, sess, {
        resourceId: id,
        // tailNumber not in schema — extra field silently stripped by Zod.
        ...(({ tailNumber: 'HACKED' }) as Record<string, unknown>),
        make: 'Cessna',
      });
      resultOk = result.ok;
    } catch {
      // ValidationError also acceptable.
      resultOk = false;
    }

    // Either way, verify the tail # was not changed.
    const detail = await getAircraftDetailWithDb(db, sess, { resourceId: id });
    // Assert ok first so the test cannot pass vacuously if the re-read returns !ok.
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error('getAircraftDetail returned not_found unexpectedly');
    expect(detail.aircraft.tailNumber).toBe('NFNOEDIT01');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T23 — updateAircraft: target not found
// ════════════════════════════════════════════════════════════════════════════════

describe('T23 — updateAircraft target not found', () => {
  it('cross-org aircraft id → not_found', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');

    const idB = await seedAircraft(db, orgBId, userBId, 'NOTFND02');

    const result = await updateAircraftWithDb(db, sessA, {
      resourceId: idB,
      make: 'Cessna',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
    }
  });

  it('non-aircraft resource → not_found', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const instructor = await createResourceWithDb(db, sess, {
      kind: 'instructor',
      displayName: 'Bob CFI 2',
      instructorUserId: userAId,
    });

    const result = await updateAircraftWithDb(db, sess, {
      resourceId: instructor.id,
      make: 'Cessna',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T24 — updateAircraft invalid_home_base
// ════════════════════════════════════════════════════════════════════════════════

describe('T24 — updateAircraft invalid_home_base', () => {
  it('cross-org location id → invalid_home_base', async () => {
    const { db, orgAId, orgBId, userAId, userBId, locationBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');

    const id = await seedAircraft(db, orgAId, userAId, 'HOMEBAD01');

    // Try to set home base to org B's location from org A session.
    const result = await updateAircraftWithDb(db, sessA, {
      resourceId: id,
      homeBaseLocationId: locationBId,  // belongs to org B — invisible to org A
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_home_base');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T25 — updateAircraft authz
// ════════════════════════════════════════════════════════════════════════════════

describe('T25 — updateAircraft authz', () => {
  it('null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(
      updateAircraftWithDb(db, null, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        make: 'Cessna',
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('cfi (fleet:access but NOT fleet:manage) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'cfi');
    await expect(
      updateAircraftWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        make: 'Cessna',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('renter → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(
      updateAircraftWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        make: 'Cessna',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('mechanic (fleet:manage) → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'mechanic');
    // Should pass auth, then fail not_found (fake UUID).
    const result = await updateAircraftWithDb(db, sess, {
      resourceId: '00000000-0000-0000-0000-000000000001',
      make: 'Cessna',
    });
    // not_found (not a ForbiddenError)
    expect(result.ok).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T25b — updateAircraft year out of range → ValidationError
// ════════════════════════════════════════════════════════════════════════════════

describe('T25b — updateAircraft year range validation', () => {
  it('year < 1900 → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    await expect(
      updateAircraftWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        year: 1899,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('year > 2200 → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    await expect(
      updateAircraftWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        year: 2201,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('year = 1900 → passes validation (DB CHECK boundary)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const id = await seedAircraft(db, orgAId, userAId, 'YR1900');
    const result = await updateAircraftWithDb(db, sess, {
      resourceId: id,
      year: 1900,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.aircraft.year).toBe(1900);
  });

  it('year = 2200 → passes validation (DB CHECK boundary)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const id = await seedAircraft(db, orgAId, userAId, 'YR2200');
    const result = await updateAircraftWithDb(db, sess, {
      resourceId: id,
      year: 2200,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.aircraft.year).toBe(2200);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T25c — listLocations RLS
// ════════════════════════════════════════════════════════════════════════════════

describe('T25c — listLocations RLS', () => {
  it('returns only same-org locations (org A cannot see org B locations)', async () => {
    const { db, orgAId, orgBId, userAId, userBId, locationAId, locationBId } = sharedEnv;

    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');

    const locsA = await listLocationsWithDb(db, sessA);
    const locsB = await listLocationsWithDb(db, sessB);

    expect(locsA.find((l) => l.id === locationAId)).toBeDefined();
    expect(locsA.find((l) => l.id === locationBId)).toBeUndefined();

    expect(locsB.find((l) => l.id === locationBId)).toBeDefined();
    expect(locsB.find((l) => l.id === locationAId)).toBeUndefined();
  });

  it('returns LocationOption shape: id, name, icao', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const locs = await listLocationsWithDb(db, sess);
    expect(locs.length).toBeGreaterThanOrEqual(1);
    const loc = locs[0]!;
    expect(typeof loc.id).toBe('string');
    expect(typeof loc.name).toBe('string');
    // icao may be string or null.
    expect(loc.icao === null || typeof loc.icao === 'string').toBe(true);
  });

  it('returns locations ordered by name', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Add a second location with an earlier name.
    await seedLocation(db, orgAId, 'AAA First Airport');
    const locs = await listLocationsWithDb(db, sess);
    const names = locs.map((l) => l.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T25d — listLocations authz
// ════════════════════════════════════════════════════════════════════════════════

describe('T25d — listLocations authz', () => {
  it('null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(listLocationsWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('renter (no fleet:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(listLocationsWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('accountant (no fleet:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'accountant');
    await expect(listLocationsWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('mechanic (fleet:access) → returns list', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'mechanic');
    const locs = await listLocationsWithDb(db, sess);
    expect(Array.isArray(locs)).toBe(true);
  });
});
