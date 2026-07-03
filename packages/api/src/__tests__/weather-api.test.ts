/**
 * weather-api.test.ts — integration suite for getMetarForAircraft (Slice W1,
 * METAR weather — display-only, informational).
 *
 * NO REAL HTTP: every test injects a FAKE WeatherProvider (recorded/synthetic
 * ParsedMetar values) into the `WithDb` test form — this suite must never
 * reach the network.
 *
 * COVERAGE:
 *   - Returns weather for an aircraft whose home base carries an ICAO.
 *   - Returns null for an aircraft with no home base / no ICAO (graceful).
 *   - Returns null when the provider throws/errors (best-effort — the read
 *     never surfaces the error to the caller).
 *   - requireCapability('schedule:access') enforced (unauthenticated + forbidden).
 *   - Tenant isolation: a cross-org resourceId resolves to null, never a peek
 *     or a 500; org A's ICAO is never visible from org B's session.
 *   - Non-aircraft resource (instructor) → null.
 *
 * Setup mirrors demo-reset.test.ts: createTestClient() → apply ALL migrations
 * (readdirSync, numeric order) → seedTwoOrgs → setTestAppRole.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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
import { resource } from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import type { ParsedMetar } from '@aeroops/core';

import { getMetarForAircraftWithDb } from '../weather/get-metar-for-aircraft.js';
import type { WeatherProvider } from '../weather/provider.js';
import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { ForbiddenError } from '../auth/require-capability.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ValidationError } from '../scheduling/internal.js';
import type { AppSession } from '../auth/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../db/migrations');

/** All up-migrations in numeric order (mirrors demo/bootstrap.ts readMigrations). */
function readAllMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
}

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
  await applyMigrationSql({ pglite }, readAllMigrations());
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

function db(): PgliteTestClient {
  return env.db;
}

let tagCounter = 0;

/** Seed an aircraft resource, optionally linked to a home-base location. */
async function seedAircraft(
  orgId: string,
  userId: string,
  homeBaseLocationId: string | null,
): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const tag = `W${tagCounter++}`;
  const ac = await createResourceWithDb(db(), sess, {
    kind: 'aircraft',
    displayName: `N-${tag}`,
    tailNumber: `N${tag}`,
  });
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

/** Seed an instructor resource (never has a home-base ICAO of relevance). */
async function seedInstructor(orgId: string, userId: string): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const tag = `INS${tagCounter++}`;
  const ins = await createResourceWithDb(db(), sess, {
    kind: 'instructor',
    displayName: `Instructor ${tag}`,
    instructorUserId: userId,
  });
  return ins.id;
}

// ─── Fake providers (NO real HTTP anywhere in this suite) ─────────────────────

const SAMPLE_WEATHER: ParsedMetar = {
  flightCategory: 'VFR',
  windKt: 8,
  gustKt: null,
  visibilitySM: 10,
  ceilingFt: null,
  rawText: 'METAR KABC 031951Z 20008KT 10SM CLR 20/10 A2992',
  observedAt: Date.UTC(2026, 6, 3, 19, 51, 0),
};

class RecordingFakeProvider implements WeatherProvider {
  calls: string[] = [];
  async fetchMetar(icaoId: string): Promise<ParsedMetar | null> {
    this.calls.push(icaoId);
    return icaoId === 'KABC' ? SAMPLE_WEATHER : null;
  }
}

class ThrowingFakeProvider implements WeatherProvider {
  async fetchMetar(): Promise<ParsedMetar | null> {
    throw new Error('simulated provider outage');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1 — happy path: aircraft with a home-base ICAO
// ════════════════════════════════════════════════════════════════════════════

describe('getMetarForAircraft: aircraft with a home-base ICAO', () => {
  it('returns the parsed weather from the injected provider (seed base carries ICAO KABC)', async () => {
    const { orgAId, userAId, locationAId } = env;
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);
    const provider = new RecordingFakeProvider();

    const result = await getMetarForAircraftWithDb(db(), sess, { resourceId: acId }, provider);

    expect(result).toEqual(SAMPLE_WEATHER);
    expect(provider.calls).toEqual(['KABC']); // Org A's seeded base ICAO
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — graceful empty states
// ════════════════════════════════════════════════════════════════════════════

describe('getMetarForAircraft: graceful empty states (never throws for missing data)', () => {
  it('aircraft with NO home base → null (no ICAO to look up)', async () => {
    const { orgAId, userAId } = env;
    const acId = await seedAircraft(orgAId, userAId, null);
    const sess = makeSession(orgAId, userAId);
    const provider = new RecordingFakeProvider();

    const result = await getMetarForAircraftWithDb(db(), sess, { resourceId: acId }, provider);

    expect(result).toBeNull();
    expect(provider.calls).toEqual([]); // never called — no ICAO to fetch
  });

  it('a non-aircraft resource (instructor) → null', async () => {
    const { orgAId, userAId, locationAId } = env;
    const insId = await seedInstructor(orgAId, userAId);
    void locationAId;
    const sess = makeSession(orgAId, userAId);
    const provider = new RecordingFakeProvider();

    const result = await getMetarForAircraftWithDb(db(), sess, { resourceId: insId }, provider);

    expect(result).toBeNull();
    expect(provider.calls).toEqual([]);
  });

  it('unknown/garbage resourceId (still a valid UUID) → null, not a 500', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    const provider = new RecordingFakeProvider();

    const result = await getMetarForAircraftWithDb(
      db(),
      sess,
      { resourceId: '00000000-0000-0000-0000-000000000000' },
      provider,
    );

    expect(result).toBeNull();
  });

  it('malformed resourceId (not a UUID) → throws ValidationError', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    await expect(
      getMetarForAircraftWithDb(db(), sess, { resourceId: 'not-a-uuid' }, new RecordingFakeProvider()),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3 — best-effort: a provider failure never breaks the caller
// ════════════════════════════════════════════════════════════════════════════

describe('getMetarForAircraft: best-effort on provider failure', () => {
  it('provider throws → resolves null, never rejects', async () => {
    const { orgAId, userAId, locationAId } = env;
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    await expect(
      getMetarForAircraftWithDb(db(), sess, { resourceId: acId }, new ThrowingFakeProvider()),
    ).resolves.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4 — capability gate
// ════════════════════════════════════════════════════════════════════════════

describe('getMetarForAircraft: requireCapability(schedule:access)', () => {
  it('rejects an unauthenticated session', async () => {
    const { orgAId, userAId, locationAId } = env;
    const acId = await seedAircraft(orgAId, userAId, locationAId);
    await expect(
      getMetarForAircraftWithDb(db(), null, { resourceId: acId }, new RecordingFakeProvider()),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('every role with schedule:access succeeds; a role lacking it is forbidden', async () => {
    const { orgAId, userAId, locationAId } = env;
    const acId = await seedAircraft(orgAId, userAId, locationAId);

    // 'mechanic' lacks schedule:access.
    const mech = makeSession(orgAId, userAId, 'mechanic');
    await expect(
      getMetarForAircraftWithDb(db(), mech, { resourceId: acId }, new RecordingFakeProvider()),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // 'cfi' has schedule:access.
    const cfi = makeSession(orgAId, userAId, 'cfi');
    const provider = new RecordingFakeProvider();
    const result = await getMetarForAircraftWithDb(db(), cfi, { resourceId: acId }, provider);
    expect(result).toEqual(SAMPLE_WEATHER);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 5 — tenant isolation
// ════════════════════════════════════════════════════════════════════════════

describe('getMetarForAircraft: tenant isolation', () => {
  it('org B session cannot resolve org A\'s aircraft/ICAO — null, not a peek', async () => {
    const { orgAId, orgBId, userAId, userBId, locationAId } = env;
    const acA = await seedAircraft(orgAId, userAId, locationAId);
    const sessB = makeSession(orgBId, userBId);
    const provider = new RecordingFakeProvider();

    const result = await getMetarForAircraftWithDb(db(), sessB, { resourceId: acA }, provider);

    expect(result).toBeNull();
    expect(provider.calls).toEqual([]); // RLS makes org A's row invisible — never even attempted a fetch
  });

  it('org A and org B each resolve only their own seeded base ICAO', async () => {
    const { orgAId, orgBId, userAId, userBId, locationAId, locationBId } = env;
    const acA = await seedAircraft(orgAId, userAId, locationAId);
    const acB = await seedAircraft(orgBId, userBId, locationBId);

    const providerA = new RecordingFakeProvider();
    const resultA = await getMetarForAircraftWithDb(
      db(),
      makeSession(orgAId, userAId),
      { resourceId: acA },
      providerA,
    );
    expect(providerA.calls).toEqual(['KABC']);
    expect(resultA).toEqual(SAMPLE_WEATHER);

    const providerB = new RecordingFakeProvider();
    const resultB = await getMetarForAircraftWithDb(
      db(),
      makeSession(orgBId, userBId),
      { resourceId: acB },
      providerB,
    );
    expect(providerB.calls).toEqual(['KBCD']);
    // KBCD isn't SAMPLE_WEATHER's key in RecordingFakeProvider → null (still
    // proves org B's OWN icao — 'KBCD' — was resolved, not org A's 'KABC').
    expect(resultB).toBeNull();
  });
});
