/**
 * org-field-status.test.ts — integration suite for getOrgFieldStatus (ops
 * status bar) + unit tests for the pure flight-category / raw-METAR helpers.
 *
 * NO REAL HTTP: every test injects a FAKE WeatherProvider into the WithDb
 * form (mirrors weather-api.test.ts) — this suite must never reach the
 * network. The clock is injected (nowMs) so solar events are deterministic.
 *
 * COVERAGE:
 *   - CAPS: app:access — EVERY authenticated role succeeds (renter/student
 *     included); null session ⇒ Unauthenticated.
 *   - UNAVAILABLE: a location with neither ICAO nor coords ⇒ { available:false }.
 *   - HAPPY PATH: station + raw METAR + category + temp/wind parsed from the
 *     raw text + sunrise/sunset ISO strings for the base coords.
 *   - FAIL SOFT: throwing provider / null provider ⇒ available:true with null
 *     weather fields (sun still present) — NEVER an error to the UI.
 *   - CACHE: second call within the TTL does not re-fetch; reset helper works.
 *   - T-ISO: org A resolves org A's station, org B resolves org B's — never
 *     the other org's, under enforced RLS.
 *   - PRIMARY LOCATION: the home base of the most active aircraft wins.
 *   - PURE: deriveFlightCategory standard boundaries (LIFR <500ft/<1sm,
 *     IFR 500–999/<3, MVFR 1000–3000/3–5, VFR >3000/>5) +
 *     parseTempCFromRaw / parseWindDirDegFromRaw tokenizers.
 *
 * COMPLIANCE: advisory display only — never a go/no-go, weather-briefing, or
 * dispatch determination (see get-org-field-status.ts header).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  location,
  resource,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import { deriveFlightCategory } from '@aeroops/core';
import type { ParsedMetar } from '@aeroops/core';

import {
  getOrgFieldStatusWithDb,
  parseTempCFromRaw,
  parseWindDirDegFromRaw,
  __resetOrgFieldStatusCacheForTests,
} from '../weather/get-org-field-status.js';
import type { WeatherProvider } from '../weather/provider.js';
import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { UnauthenticatedError } from '../auth/session.js';
import type { AppSession } from '../auth/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../db/migrations');

/** All up-migrations in numeric order (mirrors weather-api.test.ts). */
function readAllMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
}

// ─── Shared env ───────────────────────────────────────────────────────────────

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

// Deterministic clock: 2026-07-03 16:00Z (a normal mid-latitude summer day).
const NOW_MS = Date.UTC(2026, 6, 3, 16, 0, 0);

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

  // Give org A's base (KABC) coordinates — roughly KOSU. Org B's base (KBCD)
  // stays coordinate-less: station-only, no solar events.
  await withOrgContext(env.db, env.orgAId, async (tx) => {
    await tx
      .update(location)
      .set({ latitude: '40.08000', longitude: '-83.07000' })
      .where(eq(location.id, env.locationAId));
  });
}, 120_000);

beforeEach(() => {
  __resetOrgFieldStatusCacheForTests();
});

let tagCounter = 0;

/** Seed an active aircraft home-based at the given location. */
async function seedAircraft(
  orgId: string,
  userId: string,
  homeBaseLocationId: string | null,
): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const tag = `FS${tagCounter++}`;
  const ac = await createResourceWithDb(env.db, sess, {
    kind: 'aircraft',
    displayName: `N-${tag}`,
    tailNumber: `N${tag}`,
  });
  if (homeBaseLocationId) {
    await withOrgContext(env.db, orgId, async (tx) => {
      await tx.update(resource).set({ homeBaseLocationId }).where(eq(resource.id, ac.id));
    });
  }
  return ac.id;
}

// ─── Fake providers (NO real HTTP anywhere in this suite) ─────────────────────

const SAMPLE_METAR: ParsedMetar = {
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
  constructor(private readonly byStation: Record<string, ParsedMetar | null> = { KABC: SAMPLE_METAR }) {}
  async fetchMetar(icaoId: string): Promise<ParsedMetar | null> {
    this.calls.push(icaoId);
    return this.byStation[icaoId] ?? null;
  }
}

class ThrowingFakeProvider implements WeatherProvider {
  async fetchMetar(): Promise<ParsedMetar | null> {
    throw new Error('simulated provider outage');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 0 — unavailable arm (run FIRST: temporarily strip org A's ICAO
// while it still has no coords... coords were set in beforeAll, so use a
// dedicated strip-both flow and restore)
// ════════════════════════════════════════════════════════════════════════════

describe('getOrgFieldStatus: unavailable', () => {
  it('a base with neither ICAO nor coordinates ⇒ { available: false }', async () => {
    // Strip everything from org A's only location, verify, then restore.
    await withOrgContext(env.db, env.orgAId, async (tx) => {
      await tx
        .update(location)
        .set({ icao: null, latitude: null, longitude: null })
        .where(eq(location.id, env.locationAId));
    });

    const sess = makeSession(env.orgAId, env.userAId);
    const provider = new RecordingFakeProvider();
    const result = await getOrgFieldStatusWithDb(env.db, sess, provider, NOW_MS);

    expect(result).toEqual({ available: false });
    expect(provider.calls).toEqual([]);

    await withOrgContext(env.db, env.orgAId, async (tx) => {
      await tx
        .update(location)
        .set({ icao: 'KABC', latitude: '40.08000', longitude: '-83.07000' })
        .where(eq(location.id, env.locationAId));
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1 — caps
// ════════════════════════════════════════════════════════════════════════════

describe('getOrgFieldStatus: caps (app:access — every role)', () => {
  it('null session ⇒ Unauthenticated', async () => {
    await expect(
      getOrgFieldStatusWithDb(env.db, null, new RecordingFakeProvider(), NOW_MS),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('every role (renter/student/accountant included) can read the field status', async () => {
    const roles: AppSession['role'][] = [
      'owner',
      'manager',
      'dispatcher',
      'cfi',
      'mechanic',
      'renter',
      'student',
      'accountant',
    ];
    for (const role of roles) {
      __resetOrgFieldStatusCacheForTests();
      const sess = makeSession(env.orgAId, env.userAId, role);
      const result = await getOrgFieldStatusWithDb(env.db, sess, new RecordingFakeProvider(), NOW_MS);
      expect(result.available).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — happy path
// ════════════════════════════════════════════════════════════════════════════

describe('getOrgFieldStatus: happy path', () => {
  it('returns station + raw METAR + category + temp/wind + today sunrise/sunset', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const provider = new RecordingFakeProvider();

    const result = await getOrgFieldStatusWithDb(env.db, sess, provider, NOW_MS);

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.locationName).toBe('Alpha Main Base');
    expect(result.stationId).toBe('KABC');
    expect(result.rawMetar).toBe(SAMPLE_METAR.rawText);
    expect(result.flightCategory).toBe('VFR');
    expect(result.windKt).toBe(8);
    expect(result.gustKt).toBeNull();
    // Parsed from the raw text: '20008KT' + '20/10'.
    expect(result.windDirDeg).toBe(200);
    expect(result.tempC).toBe(20);
    expect(result.observedAt).toBe(new Date(SAMPLE_METAR.observedAt!).toISOString());
    expect(provider.calls).toEqual(['KABC']);

    // Sunrise/sunset: valid ISO instants on the injected clock's calendar day,
    // sunrise strictly before sunset (lat 40 in July — a normal day).
    expect(result.sunriseUtc).toMatch(/^2026-07-03T\d{2}:\d{2}:\d{2}/);
    expect(result.sunsetUtc).toMatch(/^2026-07-0[34]T\d{2}:\d{2}:\d{2}/);
    expect(new Date(result.sunriseUtc!).getTime()).toBeLessThan(
      new Date(result.sunsetUtc!).getTime(),
    );
  });

  it('a station-only base (no coords — org B) gets weather but null sunrise/sunset', async () => {
    const sess = makeSession(env.orgBId, env.userBId);
    const provider = new RecordingFakeProvider({ KBCD: { ...SAMPLE_METAR, rawText: 'METAR KBCD 031951Z 36012G18KT 3SM OVC008 M05/M07 A2992' } });

    const result = await getOrgFieldStatusWithDb(env.db, sess, provider, NOW_MS);

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.stationId).toBe('KBCD');
    expect(result.sunriseUtc).toBeNull();
    expect(result.sunsetUtc).toBeNull();
    // Gusty north wind + below-zero temp parsed from the raw text.
    expect(result.windDirDeg).toBe(360);
    expect(result.tempC).toBe(-5);
    expect(provider.calls).toEqual(['KBCD']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3 — fail soft
// ════════════════════════════════════════════════════════════════════════════

describe('getOrgFieldStatus: fail soft (weather outage never breaks the shell)', () => {
  it('throwing provider ⇒ available:true, null weather fields, sun still present', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const result = await getOrgFieldStatusWithDb(env.db, sess, new ThrowingFakeProvider(), NOW_MS);

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.stationId).toBe('KABC');
    expect(result.rawMetar).toBeNull();
    expect(result.flightCategory).toBeNull();
    expect(result.tempC).toBeNull();
    expect(result.windDirDeg).toBeNull();
    expect(result.windKt).toBeNull();
    expect(result.observedAt).toBeNull();
    // Solar events are independent of the weather outage.
    expect(result.sunriseUtc).not.toBeNull();
    expect(result.sunsetUtc).not.toBeNull();
  });

  it('provider resolving null (unknown station) ⇒ same graceful null-weather shape', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const provider = new RecordingFakeProvider({}); // knows no stations
    const result = await getOrgFieldStatusWithDb(env.db, sess, provider, NOW_MS);

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.rawMetar).toBeNull();
    expect(result.flightCategory).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4 — short in-process cache
// ════════════════════════════════════════════════════════════════════════════

describe('getOrgFieldStatus: METAR cache', () => {
  it('a second call within the TTL does NOT re-fetch; reset forces a re-fetch', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const provider = new RecordingFakeProvider();

    await getOrgFieldStatusWithDb(env.db, sess, provider, NOW_MS);
    await getOrgFieldStatusWithDb(env.db, sess, provider, NOW_MS + 1_000);
    expect(provider.calls).toEqual(['KABC']); // one fetch, second call served from cache

    // Past the TTL (5 min) → re-fetch.
    await getOrgFieldStatusWithDb(env.db, sess, provider, NOW_MS + 6 * 60_000);
    expect(provider.calls).toEqual(['KABC', 'KABC']);

    __resetOrgFieldStatusCacheForTests();
    await getOrgFieldStatusWithDb(env.db, sess, provider, NOW_MS + 6 * 60_000 + 1_000);
    expect(provider.calls).toEqual(['KABC', 'KABC', 'KABC']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 5 — T-ISO (tenant isolation, both directions)
// ════════════════════════════════════════════════════════════════════════════

describe('T-ISO — each org resolves ONLY its own base station', () => {
  it('org A resolves KABC, org B resolves KBCD — never the other way', async () => {
    const providerA = new RecordingFakeProvider();
    const resultA = await getOrgFieldStatusWithDb(
      env.db,
      makeSession(env.orgAId, env.userAId),
      providerA,
      NOW_MS,
    );
    expect(resultA.available).toBe(true);
    if (resultA.available) expect(resultA.stationId).toBe('KABC');
    expect(providerA.calls).toEqual(['KABC']);

    __resetOrgFieldStatusCacheForTests();
    const providerB = new RecordingFakeProvider();
    const resultB = await getOrgFieldStatusWithDb(
      env.db,
      makeSession(env.orgBId, env.userBId),
      providerB,
      NOW_MS,
    );
    expect(resultB.available).toBe(true);
    if (resultB.available) expect(resultB.stationId).toBe('KBCD');
    expect(providerB.calls).toEqual(['KBCD']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 6 — primary-location selection (most home-based active aircraft wins)
// ════════════════════════════════════════════════════════════════════════════

describe('getOrgFieldStatus: primary-location selection', () => {
  it('the location that is home base to the MOST active aircraft wins', async () => {
    // Org A currently has one location (KABC). Add a second (KZZZ) and home-
    // base TWO aircraft there vs ONE at KABC — KZZZ becomes primary.
    const kzzzRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .insert(location)
        .values({
          orgId: env.orgAId,
          name: 'Alpha Satellite Base',
          icao: 'KZZZ',
          latitude: '41.00000',
          longitude: '-84.00000',
        })
        .returning({ id: location.id }),
    );
    const kzzzId = kzzzRows[0]!.id;

    await seedAircraft(env.orgAId, env.userAId, env.locationAId);
    await seedAircraft(env.orgAId, env.userAId, kzzzId);
    await seedAircraft(env.orgAId, env.userAId, kzzzId);

    const provider = new RecordingFakeProvider({ KZZZ: SAMPLE_METAR });
    const result = await getOrgFieldStatusWithDb(
      env.db,
      makeSession(env.orgAId, env.userAId),
      provider,
      NOW_MS,
    );

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.stationId).toBe('KZZZ');
    expect(result.locationName).toBe('Alpha Satellite Base');
    expect(provider.calls).toEqual(['KZZZ']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 7 — pure helpers
// ════════════════════════════════════════════════════════════════════════════

describe('deriveFlightCategory: standard AWC/FAA boundaries', () => {
  it('ceiling boundaries: LIFR <500, IFR 500–999, MVFR 1000–3000, VFR >3000', () => {
    // Visibility held comfortably VFR (10sm) so ceiling alone governs.
    expect(deriveFlightCategory(499, 10)).toBe('LIFR');
    expect(deriveFlightCategory(500, 10)).toBe('IFR');
    expect(deriveFlightCategory(999, 10)).toBe('IFR');
    expect(deriveFlightCategory(1000, 10)).toBe('MVFR');
    expect(deriveFlightCategory(3000, 10)).toBe('MVFR');
    expect(deriveFlightCategory(3001, 10)).toBe('VFR');
  });

  it('visibility boundaries: LIFR <1, IFR 1–<3, MVFR 3–5, VFR >5', () => {
    // No ceiling reported (unlimited) so visibility alone governs.
    expect(deriveFlightCategory(null, 0.75)).toBe('LIFR');
    expect(deriveFlightCategory(null, 1)).toBe('IFR');
    expect(deriveFlightCategory(null, 2.5)).toBe('IFR');
    expect(deriveFlightCategory(null, 3)).toBe('MVFR');
    expect(deriveFlightCategory(null, 5)).toBe('MVFR');
    expect(deriveFlightCategory(null, 6)).toBe('VFR');
  });

  it('the WORSE dimension governs; both unknown ⇒ UNKNOWN', () => {
    expect(deriveFlightCategory(400, 10)).toBe('LIFR'); // ceiling worse
    expect(deriveFlightCategory(5000, 0.5)).toBe('LIFR'); // visibility worse
    expect(deriveFlightCategory(1500, 2)).toBe('IFR'); // vis IFR beats ceiling MVFR
    expect(deriveFlightCategory(null, null)).toBe('UNKNOWN');
  });
});

describe('parseWindDirDegFromRaw / parseTempCFromRaw (pure, fail-soft)', () => {
  it('reads direction from dddssKT and dddssGggKT groups; VRB ⇒ null', () => {
    expect(parseWindDirDegFromRaw('METAR KABC 031951Z 20008KT 10SM CLR 20/10 A2992')).toBe(200);
    expect(parseWindDirDegFromRaw('KABC 031951Z 36012G18KT 3SM OVC008 M05/M07')).toBe(360);
    expect(parseWindDirDegFromRaw('KABC 031951Z VRB03KT 10SM CLR 20/10')).toBeNull();
    expect(parseWindDirDegFromRaw('no wind group here')).toBeNull();
    expect(parseWindDirDegFromRaw(null)).toBeNull();
  });

  it('reads temperature from the temp/dew group; M prefix negative; RVR/fractions never match', () => {
    expect(parseTempCFromRaw('METAR KABC 031951Z 20008KT 10SM CLR 20/10 A2992')).toBe(20);
    expect(parseTempCFromRaw('KABC 031951Z 36012KT 3SM OVC008 M05/M07 A2992')).toBe(-5);
    expect(parseTempCFromRaw('KABC 031951Z 00000KT M1/4SM R28L/2600FT FG VV002')).toBeNull();
    expect(parseTempCFromRaw('nothing to see')).toBeNull();
    expect(parseTempCFromRaw(null)).toBeNull();
  });
});
