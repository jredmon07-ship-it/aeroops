/**
 * location-commands.test.ts — API integration tests for base-location
 * create/update (self-serve base-airport management).
 *
 * COVERAGE:
 *   CAP    — fleet:manage granted/denied per role matrix.
 *   create — happy path (coords stored, ONE audit row, listLocations reflects it).
 *   create — validation: lat without lon rejected; out-of-range lat/lon rejected;
 *            ICAO uppercased.
 *   create — authz: cfi (no fleet:manage) → ForbiddenError; null → Unauthenticated.
 *   create — tenant isolation: a location made in orgA is invisible to orgB.
 *   update — happy path (name + coords set, then coords cleared; ONE audit row).
 *   update — not_found: cross-org id → not_found (RLS isolation).
 *   update — validation: lone latitude → ValidationError.
 *   update — authz: cfi → ForbiddenError.
 *
 * Migrations 0000–0010 (0010 adds location.latitude/longitude + paired CHECK).
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

import { createLocationWithDb } from '../fleet/location-commands.js';
import { updateLocationWithDb } from '../fleet/location-commands.js';
import { listLocationsWithDb } from '../fleet/list-locations.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';
import { can } from '@aeroops/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_SQL = [
  '0000_loud_prodigy.sql',
  '0001_auth_credential.sql',
  '0002_scheduling.sql',
  '0003_booking_policies.sql',
  '0004_recurrence.sql',
  '0005_dispatch.sql',
  '0006_squawks_grounding.sql',
  '0007_fleet.sql',
  '0008_people.sql',
  '0009_dispatch_gate.sql',
  '0010_civil_twilight.sql',
].map((f) => readFileSync(resolve(__dirname, `../../../db/migrations/${f}`), 'utf-8'));

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
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

async function countAudit(
  db: PgliteTestClient,
  orgId: string,
  action: string,
  entityId: string,
): Promise<number> {
  return withOrgContext(db, orgId, async (tx) => {
    const rows = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));
    return rows.length;
  });
}

// ── CAP matrix ────────────────────────────────────────────────────────────────

describe('location writes — fleet:manage cap matrix', () => {
  const GRANTED = ['owner', 'manager', 'dispatcher', 'mechanic'] as const;
  const DENIED = ['cfi', 'renter', 'student', 'accountant'] as const;
  for (const role of GRANTED) {
    it(`${role} HAS fleet:manage`, () => expect(can(role, 'fleet:manage')).toBe(true));
  }
  for (const role of DENIED) {
    it(`${role} does NOT have fleet:manage`, () => expect(can(role, 'fleet:manage')).toBe(false));
  }
});

// ── createLocation ──────────────────────────────────────────────────────────────

describe('createLocation', () => {
  it('creates a location with coords, ONE audit row, reflected in listLocations', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');

    const result = await createLocationWithDb(db, sess, {
      name: 'North Field',
      icao: 'kaus',
      latitude: 30.1975,
      longitude: -97.6664,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.location.name).toBe('North Field');
    expect(result.location.icao).toBe('KAUS'); // uppercased
    expect(result.location.latitude).toBeCloseTo(30.1975, 4);
    expect(result.location.longitude).toBeCloseTo(-97.6664, 4);

    expect(await countAudit(db, orgAId, 'location.created', result.location.id)).toBe(1);

    const list = await listLocationsWithDb(db, sess);
    const found = list.find((l) => l.id === result.location.id);
    expect(found).toBeDefined();
    expect(found!.latitude).toBeCloseTo(30.1975, 4);
  });

  it('creates a coordinate-less location (name + icao only)', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');
    const result = await createLocationWithDb(db, sess, { name: 'Grass Strip' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.location.latitude).toBeNull();
    expect(result.location.longitude).toBeNull();
  });

  it('rejects latitude without longitude (unmatched pair)', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      createLocationWithDb(db, sess, { name: 'Bad', latitude: 40 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects out-of-range latitude (>90)', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      createLocationWithDb(db, sess, { name: 'Bad', latitude: 91, longitude: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects out-of-range longitude (>180)', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      createLocationWithDb(db, sess, { name: 'Bad', latitude: 0, longitude: 181 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('denies cfi (no fleet:manage) with ForbiddenError', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'cfi');
    await expect(
      createLocationWithDb(db, sess, { name: 'X', latitude: 0, longitude: 0 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('denies a null session with UnauthenticatedError', async () => {
    const { db } = env;
    await expect(
      createLocationWithDb(db, null, { name: 'X' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('tenant isolation: a location created in orgA is invisible to orgB', async () => {
    const { db, orgAId, userAId, orgBId, userBId } = env;
    const created = await createLocationWithDb(db, makeSession(orgAId, userAId, 'owner'), {
      name: 'Org A Secret Base',
      latitude: 10,
      longitude: 10,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const orgBList = await listLocationsWithDb(db, makeSession(orgBId, userBId, 'owner'));
    expect(orgBList.find((l) => l.id === created.location.id)).toBeUndefined();
  });
});

// ── updateLocation ──────────────────────────────────────────────────────────────

describe('updateLocation', () => {
  it('updates name + sets coords, then clears coords; ONE audit row per call', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');

    const created = await createLocationWithDb(db, sess, { name: 'Editable' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.location.id;

    // Set name + coords.
    const upd1 = await updateLocationWithDb(db, sess, {
      locationId: id,
      name: 'Editable Renamed',
      latitude: 45.5,
      longitude: -122.6,
    });
    expect(upd1.ok).toBe(true);
    if (!upd1.ok) return;
    expect(upd1.location.name).toBe('Editable Renamed');
    expect(upd1.location.latitude).toBeCloseTo(45.5, 4);

    // Clear coords (both null together).
    const upd2 = await updateLocationWithDb(db, sess, {
      locationId: id,
      latitude: null,
      longitude: null,
    });
    expect(upd2.ok).toBe(true);
    if (!upd2.ok) return;
    expect(upd2.location.latitude).toBeNull();
    expect(upd2.location.longitude).toBeNull();
    expect(upd2.location.name).toBe('Editable Renamed'); // untouched

    // Two update calls → two audit rows.
    expect(await countAudit(db, orgAId, 'location.updated', id)).toBe(2);
  });

  it('cross-org location id → not_found (RLS isolation)', async () => {
    const { db, orgAId, userAId, orgBId, userBId } = env;
    const created = await createLocationWithDb(db, makeSession(orgAId, userAId, 'owner'), {
      name: 'Only In A',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await updateLocationWithDb(db, makeSession(orgBId, userBId, 'owner'), {
      locationId: created.location.id,
      name: 'Hijack',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });

  it('rejects a lone latitude on update with ValidationError', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');
    const created = await createLocationWithDb(db, sess, { name: 'Coord Update' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await expect(
      updateLocationWithDb(db, sess, { locationId: created.location.id, latitude: 12 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('denies cfi with ForbiddenError', async () => {
    const { db, orgAId, userAId } = env;
    const owner = makeSession(orgAId, userAId, 'owner');
    const created = await createLocationWithDb(db, owner, { name: 'Locked' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await expect(
      updateLocationWithDb(db, makeSession(orgAId, userAId, 'cfi'), {
        locationId: created.location.id,
        name: 'Nope',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
