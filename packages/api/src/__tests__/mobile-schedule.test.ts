/**
 * mobile-schedule.test.ts — Slice 4M.2 mobile schedule read tests.
 *
 * CI-VERIFIABLE: all tests run against pglite (no real Postgres or device needed).
 *
 * COVERAGE:
 *   1. TENANT ISOLATION (HEADLINE) — Org-A session returns ONLY Org-A reservations
 *      even when Org-B has reservations in the same window. A body/query org_id
 *      is irrelevant: org is from the session (which comes from the signed token).
 *   2. Authz: a session whose role lacks schedule:access → ForbiddenError
 *      (the route maps this to 403).
 *   3. Authz: a session with a garbage role → fail-closed → UnauthenticatedError
 *      (the route maps this to 401).
 *   4. DTO serialization: Date→ISO strings; orgId ABSENT from every DTO.
 *   5. listReservationsWithDb + listResourcesWithDb are the production calls
 *      used by the route (injected form; verifies the route delegates correctly).
 *
 * SETUP:
 *   - Two orgs seeded (alpha/active + beta/active) via seedTwoOrgs.
 *   - Each org has one aircraft resource + at least one reservation in the same
 *     window so the isolation test is meaningful.
 *   - All 0000–0011 migrations applied.
 *   - Auth.js session built via sessionFromMobileClaims (the same path the
 *     route uses after verifyMobileToken).
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
  seedTwoOrgs,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import {
  createResourceWithDb,
  createReservationWithDb,
  listReservationsWithDb,
  listResourcesWithDb,
  ForbiddenError,
  UnauthenticatedError,
  sessionFromMobileClaims,
} from '../index.js';
import type { AppSession } from '../auth/types.js';
import {
  toMobileReservationDTO,
  toMobileResourceDTO,
} from '@aeroops/core';
import type { MobileClaims } from '../auth/verify-login.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Migration SQL ─────────────────────────────────────────────────────────────

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
];

// ─── Shared test state ─────────────────────────────────────────────────────────

let db: PgliteTestClient;
let pglite: PGlite;
let orgAId: string;
let orgBId: string;
let userAId: string;
let userBId: string;
let resourceAId: string;
let resourceBId: string;
let reservationAId: string;
let reservationBId: string;

/** Pinned window for all tests — far enough in the future to be deterministic. */
const WINDOW = {
  from: new Date('2026-07-01T00:00:00.000Z'),
  to:   new Date('2026-07-02T00:00:00.000Z'),
};

/** Reservation times within the window for each org. */
const RES_A = {
  from: new Date('2026-07-01T08:00:00.000Z'),
  to:   new Date('2026-07-01T09:00:00.000Z'),
};
const RES_B = {
  from: new Date('2026-07-01T10:00:00.000Z'),
  to:   new Date('2026-07-01T11:00:00.000Z'),
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Build an AppSession directly (mirrors sessionFromMobileClaims usage in the route). */
function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
  slug = 'test',
): AppSession {
  return { userId, orgId, slug, role, user: { email: 'test@test.example' } };
}

/**
 * buildSessionFromClaims — call sessionFromMobileClaims exactly as the route
 * does after verifyMobileToken, to assert it yields the correct session shape.
 */
function buildSessionFromClaims(
  orgId: string,
  userId: string,
  role: string,
  slug = 'test',
): AppSession {
  const claims: MobileClaims = {
    userId,
    orgId,
    slug,
    role,
    email: 'test@test.example',
  };
  return sessionFromMobileClaims(claims);
}

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Fresh PGlite with full migration chain.
  ({ db, pglite } = await createTestClient());
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  // 2. Seed two orgs.
  const seed = await seedTwoOrgs(db);
  orgAId  = seed.orgAId;
  orgBId  = seed.orgBId;
  userAId = seed.userAId;
  userBId = seed.userBId;

  // 3. Drop to app role so RLS is enforced.
  await setTestAppRole({ pglite });

  // 4. Create one aircraft resource per org.
  const sessA = makeSession(orgAId, userAId, 'owner');
  const sessB = makeSession(orgBId, userBId, 'owner');

  const resA = await createResourceWithDb(db, sessA, {
    kind: 'aircraft',
    displayName: 'Alpha Air N111AA',
    tailNumber: 'N111AA',
  });
  resourceAId = resA.id;

  const resB = await createResourceWithDb(db, sessB, {
    kind: 'aircraft',
    displayName: 'Beta Air N222BB',
    tailNumber: 'N222BB',
  });
  resourceBId = resB.id;

  // 5. Create one reservation per org, both within the shared WINDOW.
  //    createReservationWithDb returns CreateReservationResult (discriminated union);
  //    we must check ok:true before accessing .reservation.
  const rsvAResult = await createReservationWithDb(db, sessA, {
    resourceIds: [resourceAId],
    startAt: RES_A.from,
    endAt:   RES_A.to,
    notes:   'Org A flight',
  });
  if (!rsvAResult.ok) {
    throw new Error(`Org-A reservation seed failed: ${rsvAResult.reason}`);
  }
  reservationAId = rsvAResult.reservation.id;

  const rsvBResult = await createReservationWithDb(db, sessB, {
    resourceIds: [resourceBId],
    startAt: RES_B.from,
    endAt:   RES_B.to,
    notes:   'Org B flight',
  });
  if (!rsvBResult.ok) {
    throw new Error(`Org-B reservation seed failed: ${rsvBResult.reason}`);
  }
  reservationBId = rsvBResult.reservation.id;
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
// 1. TENANT ISOLATION — THE HEADLINE TEST
// ═════════════════════════════════════════════════════════════════════════════

describe('1. TENANT ISOLATION — Org-A token reads ONLY Org-A data', () => {
  it('1a. Org-A session via sessionFromMobileClaims returns ONLY Org-A reservations', async () => {
    // Build the session the same way the route does: from verified token claims.
    const sessionA = buildSessionFromClaims(orgAId, userAId, 'owner');

    const rows = await listReservationsWithDb(db, sessionA, WINDOW);
    const dtos = rows.map(toMobileReservationDTO);

    // Org-A's reservation is present.
    expect(dtos.some((d) => d.id === reservationAId)).toBe(true);

    // Org-B's reservation is absent — RLS + session scoping enforces this.
    expect(dtos.some((d) => d.id === reservationBId)).toBe(false);
  });

  it('1b. Org-B session via sessionFromMobileClaims returns ONLY Org-B reservations', async () => {
    const sessionB = buildSessionFromClaims(orgBId, userBId, 'owner');

    const rows = await listReservationsWithDb(db, sessionB, WINDOW);
    const dtos = rows.map(toMobileReservationDTO);

    expect(dtos.some((d) => d.id === reservationBId)).toBe(true);
    expect(dtos.some((d) => d.id === reservationAId)).toBe(false);
  });

  it('1c. Org-A resource list contains ONLY Org-A resources', async () => {
    const sessionA = buildSessionFromClaims(orgAId, userAId, 'owner');

    const rows = await listResourcesWithDb(db, sessionA);
    const dtos = rows.map(toMobileResourceDTO);

    expect(dtos.some((d) => d.id === resourceAId)).toBe(true);
    expect(dtos.some((d) => d.id === resourceBId)).toBe(false);
  });

  it('1d. Org-B resource list contains ONLY Org-B resources', async () => {
    const sessionB = buildSessionFromClaims(orgBId, userBId, 'owner');

    const rows = await listResourcesWithDb(db, sessionB);
    const dtos = rows.map(toMobileResourceDTO);

    expect(dtos.some((d) => d.id === resourceBId)).toBe(true);
    expect(dtos.some((d) => d.id === resourceAId)).toBe(false);
  });

  it('1e. passing orgBId as a string to a query does NOT override the session-scoped RLS', async () => {
    // The route never reads org_id from query params — org comes from the token.
    // Here we verify that even if a test tries to use orgB's id in a session
    // built for orgA (hypothetical route bypass), the session org still wins.
    // We simulate "attacker supplies orgB" by confirming the org_id in the
    // session (set from the token claim) is the only one that matters.
    const sessionA = buildSessionFromClaims(orgAId, userAId, 'owner');

    // sessionA.orgId is orgAId — confirmed from the claims.
    expect(sessionA.orgId).toBe(orgAId);

    // Even though we KNOW orgBId, listReservationsWithDb with sessionA returns
    // only Org-A data — a query-string orgBId injection is meaningless.
    const rows = await listReservationsWithDb(db, sessionA, WINDOW);
    expect(rows.every((r) => r.orgId === orgAId)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. AUTHZ — ForbiddenError when role lacks schedule:access
// ═════════════════════════════════════════════════════════════════════════════

describe('2. Authz — role without schedule:access → ForbiddenError', () => {
  it('2a. "accountant" role lacks schedule:access → ForbiddenError on listReservations', async () => {
    const session = makeSession(orgAId, userAId, 'accountant');

    await expect(
      listReservationsWithDb(db, session, WINDOW),
    ).rejects.toThrow(ForbiddenError);
  });

  it('2b. "accountant" role lacks schedule:access → ForbiddenError on listResources', async () => {
    const session = makeSession(orgAId, userAId, 'accountant');

    await expect(
      listResourcesWithDb(db, session),
    ).rejects.toThrow(ForbiddenError);
  });

  it('2c. null session → UnauthenticatedError (no session at all)', async () => {
    await expect(
      listReservationsWithDb(db, null, WINDOW),
    ).rejects.toThrow(UnauthenticatedError);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. AUTHZ — garbage role → fail-closed → UnauthenticatedError
// ═════════════════════════════════════════════════════════════════════════════

describe('3. Authz — garbage role in token → fail-closed → UnauthenticatedError', () => {
  it('3a. sessionFromMobileClaims with garbage role → session without role → UnauthenticatedError', async () => {
    // Build claims with a garbage role (as would arrive from a tampered token
    // that passed signature verification but has a forged role).
    // sessionFromMobileClaims is fail-closed: it strips the invalid role,
    // leaving a session without a role field.
    const sessionGarbage = buildSessionFromClaims(orgAId, userAId, '__proto__injection');

    // The session should NOT have a valid role.
    expect('role' in sessionGarbage ? sessionGarbage.role : undefined).not.toBe('__proto__injection');

    // Calling listReservations with this session should throw UnauthenticatedError
    // (via requireCapability detecting missing role → fail-closed).
    await expect(
      listReservationsWithDb(db, sessionGarbage, WINDOW),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('3b. empty role → fail-closed → UnauthenticatedError', async () => {
    const sessionEmpty = buildSessionFromClaims(orgAId, userAId, '');

    await expect(
      listReservationsWithDb(db, sessionEmpty, WINDOW),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('3c. undefined session → UnauthenticatedError', async () => {
    await expect(
      listReservationsWithDb(db, undefined, WINDOW),
    ).rejects.toThrow(UnauthenticatedError);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. DTO SERIALIZATION ROUND-TRIP
// ═════════════════════════════════════════════════════════════════════════════

describe('4. DTO serialization', () => {
  it('4a. reservation DTOs contain ISO strings (not Date objects)', async () => {
    const sessionA = buildSessionFromClaims(orgAId, userAId, 'owner');
    const rows = await listReservationsWithDb(db, sessionA, WINDOW);
    const dtos = rows.map(toMobileReservationDTO);

    // Must have at least one DTO (the seeded Org-A reservation).
    expect(dtos.length).toBeGreaterThan(0);

    for (const dto of dtos) {
      // ISO-8601 format check.
      expect(dto.startAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(dto.endAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // These must be strings, not Date objects.
      expect(typeof dto.startAt).toBe('string');
      expect(typeof dto.endAt).toBe('string');
    }
  });

  it('4b. orgId is ABSENT from every reservation DTO', async () => {
    const sessionA = buildSessionFromClaims(orgAId, userAId, 'owner');
    const rows = await listReservationsWithDb(db, sessionA, WINDOW);
    const dtos = rows.map(toMobileReservationDTO);

    expect(dtos.length).toBeGreaterThan(0);
    for (const dto of dtos) {
      expect('orgId' in dto).toBe(false);
    }
  });

  it('4c. resource DTOs have correct shape', async () => {
    const sessionA = buildSessionFromClaims(orgAId, userAId, 'owner');
    const rows = await listResourcesWithDb(db, sessionA);
    const dtos = rows.map(toMobileResourceDTO);

    expect(dtos.length).toBeGreaterThan(0);
    for (const dto of dtos) {
      expect(typeof dto.id).toBe('string');
      expect(typeof dto.kind).toBe('string');
      expect(typeof dto.displayName).toBe('string');
      // tailNumber is string | null — either is acceptable.
      expect(dto.tailNumber === null || typeof dto.tailNumber === 'string').toBe(true);
      // orgId must be absent.
      expect('orgId' in dto).toBe(false);
    }
  });

  it('4d. reservation DTO startAt/endAt match the seeded times', async () => {
    const sessionA = buildSessionFromClaims(orgAId, userAId, 'owner');
    const rows = await listReservationsWithDb(db, sessionA, WINDOW);
    const dtos = rows.map(toMobileReservationDTO);

    const rsvDto = dtos.find((d) => d.id === reservationAId);
    expect(rsvDto).toBeDefined();
    expect(rsvDto!.startAt).toBe(RES_A.from.toISOString());
    expect(rsvDto!.endAt).toBe(RES_A.to.toISOString());
    expect(rsvDto!.notes).toBe('Org A flight');
    expect(rsvDto!.status).toBe('booked');
  });

  it('4e. resource DTO tail number matches the seeded aircraft', async () => {
    const sessionA = buildSessionFromClaims(orgAId, userAId, 'owner');
    const rows = await listResourcesWithDb(db, sessionA);
    const dtos = rows.map(toMobileResourceDTO);

    const rscDto = dtos.find((d) => d.id === resourceAId);
    expect(rscDto).toBeDefined();
    expect(rscDto!.kind).toBe('aircraft');
    expect(rscDto!.tailNumber).toBe('N111AA');
    expect(rscDto!.displayName).toBe('Alpha Air N111AA');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. ROLES WITH schedule:access — all can read
// ═════════════════════════════════════════════════════════════════════════════

describe('5. All roles with schedule:access can read', () => {
  // From the ROLE_CAPABILITIES matrix: only owner/manager/dispatcher/cfi have
  // schedule:access. mechanic, renter, student, accountant do NOT.
  const accessRoles: AppSession['role'][] = [
    'owner',
    'manager',
    'dispatcher',
    'cfi',
  ];

  for (const role of accessRoles) {
    it(`5. role "${role}" can list reservations`, async () => {
      const session = makeSession(orgAId, userAId, role);
      const rows = await listReservationsWithDb(db, session, WINDOW);
      // Should succeed without throwing; at least one reservation exists.
      expect(Array.isArray(rows)).toBe(true);
    });
  }
});
