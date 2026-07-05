/**
 * onboarding-api.test.ts — API integration tests for the guided-setup checklist.
 *
 * Covers getOnboardingStatus (derived read, NO onboarding table):
 *   - AUTHZ: org:manage_settings — owner/manager pass; dispatcher/cfi/mechanic/
 *     renter/student/accountant refused; null → Unauthenticated.
 *   - Reality: 0 aircraft → aircraft step not done; add aircraft → done + count.
 *   - essentialDone flips ONLY when aircraft AND >1 active member exist.
 *   - base_airport requires BOTH latitude and longitude (coords), not just ICAO.
 *   - rates / policies / payments steps reflect real config.
 *   - percentComplete math (doneCount / totalCount).
 *   - T-ISO: org-B config never leaks into org-A's counts.
 *   - Brand-new empty org → sensible all-incomplete checklist (people has the
 *     sole seeded owner → not done; nothing NaN/null).
 *
 * Setup mirrors reporting-api.test.ts: createTestClient() → applyMigrationSql
 * (0000–0023, through stripe_customer) → seedTwoOrgs → setTestAppRole.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { getOnboardingStatusWithDb } from '../onboarding/get-onboarding-status.js';
import type { OnboardingStatus, OnboardingStepKey } from '../onboarding/get-onboarding-status.js';

import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';
import { can, MEMBERSHIP_ROLES } from '@aeroops/core';

// ── Path resolution ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_SQL = [
  '0000_loud_prodigy',
  '0001_auth_credential',
  '0002_scheduling',
  '0003_booking_policies',
  '0004_recurrence',
  '0005_dispatch',
  '0006_squawks_grounding',
  '0007_fleet',
  '0008_people',
  '0009_dispatch_gate',
  '0010_civil_twilight',
  '0011_optimizer_run',
  '0012_training',
  '0013_work_orders',
  '0014_availability',
  '0015_booking_request',
  '0016_booking_request_convert',
  '0017_booking_retention',
  '0018_dispatch_ticket_correction',
  '0019_billing_records',
  '0020_demo_reset_state',
  '0021_qbo_integration',
  '0022_billing_ledger',
  '0023_stripe_foundation',
].map((name) => readFileSync(resolve(__dirname, `../../../db/migrations/${name}.sql`), 'utf-8'));

// ── Session helper ─────────────────────────────────────────────────────────────

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

// ── State-building helpers (all RLS-scoped via withOrgContext / createResource) ──

async function addAircraft(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tail: string,
): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const ac = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `N-${tail}`,
    tailNumber: tail,
  });
  return ac.id;
}

async function addActiveMember(
  db: PgliteTestClient,
  orgId: string,
  email: string,
): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO app_user (org_id, email, full_name, status)
      VALUES (${orgId}, ${email}, ${email}, 'active')
    `);
  });
}

async function setBaseCoords(db: PgliteTestClient, orgId: string): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    await tx.execute(sql`
      UPDATE location
      SET latitude = ${'40.07800'}, longitude = ${'-83.07300'}
      WHERE org_id = ${orgId}
    `);
  });
}

async function addRate(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO rate_schedule
        (org_id, name, rate_kind, amount_cents, effective_from, created_by)
      VALUES
        (${orgId}, ${'C172 Wet Hourly'}, ${'wet_hourly'}, ${15000}, ${'2027-01-01T00:00:00Z'}::timestamptz, ${userId})
    `);
  });
}

async function addPolicy(
  db: PgliteTestClient,
  orgId: string,
  resourceId: string,
): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO booking_policy (org_id, resource_id, max_duration_minutes)
      VALUES (${orgId}, ${resourceId}, ${240})
    `);
  });
}

async function connectQbo(db: PgliteTestClient, orgId: string): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO qbo_connection (org_id, realm_id, status)
      VALUES (${orgId}, ${'realm-123'}, 'connected')
    `);
  });
}

/** Convenience: pull a single step out of the checklist by key. */
function step(status: OnboardingStatus, key: OnboardingStepKey) {
  const s = status.steps.find((x) => x.key === key);
  if (!s) throw new Error(`step ${key} missing`);
  return s;
}

/** Spin up a fresh, isolated two-org DB so per-scenario counts are deterministic. */
async function freshEnv() {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });
  return { db, seed };
}

// ── Shared env (authz + brand-new baseline) ─────────────────────────────────────

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
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

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CAPABILITY: org:manage_settings matrix
// ══════════════════════════════════════════════════════════════════════════════

describe('Capability: org:manage_settings', () => {
  const GRANTED: AppSession['role'][] = ['owner', 'manager'];
  const DENIED: AppSession['role'][] = [
    'dispatcher',
    'cfi',
    'mechanic',
    'renter',
    'student',
    'accountant',
  ];

  for (const role of GRANTED) {
    it(`${role} HAS org:manage_settings`, () => {
      expect(can(role, 'org:manage_settings')).toBe(true);
    });
  }
  for (const role of DENIED) {
    it(`${role} does NOT have org:manage_settings`, () => {
      expect(can(role, 'org:manage_settings')).toBe(false);
    });
  }

  it('cross-product: can(role,cap) matches ROLE_CAPABILITIES for org:manage_settings', async () => {
    const { ROLE_CAPABILITIES } = await import('@aeroops/core');
    for (const role of MEMBERSHIP_ROLES) {
      const fromCan = can(role, 'org:manage_settings');
      const fromMatrix = (ROLE_CAPABILITIES[role] as readonly string[]).includes(
        'org:manage_settings',
      );
      expect(fromCan).toBe(fromMatrix);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — AUTHZ: getOnboardingStatus
// ══════════════════════════════════════════════════════════════════════════════

describe('AUTHZ: getOnboardingStatus', () => {
  it('null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(getOnboardingStatusWithDb(db, null)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('owner → passes gate (resolves a checklist)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const result = await getOnboardingStatusWithDb(db, makeSession(orgAId, userAId, 'owner'));
    expect(result.steps).toHaveLength(6);
  });

  it('manager → passes gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const result = await getOnboardingStatusWithDb(db, makeSession(orgAId, userAId, 'manager'));
    expect(result).toBeDefined();
  });

  for (const role of ['dispatcher', 'cfi', 'mechanic', 'renter', 'student', 'accountant'] as const) {
    it(`${role} → ForbiddenError`, async () => {
      const { db, orgAId, userAId } = sharedEnv;
      await expect(
        getOnboardingStatusWithDb(db, makeSession(orgAId, userAId, role)),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — BRAND-NEW ORG: sensible all-incomplete checklist
// ══════════════════════════════════════════════════════════════════════════════

describe('Brand-new empty org', () => {
  it('fresh seeded org → nothing done except (people has sole owner → NOT done)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const status = await getOnboardingStatusWithDb(db, makeSession(orgAId, userAId, 'owner'));

    // Structure
    expect(status.steps.map((s) => s.key)).toEqual([
      'aircraft',
      'people',
      'base_airport',
      'rates',
      'policies',
      'payments',
    ]);

    // Essentials
    expect(step(status, 'aircraft').done).toBe(false);
    expect(step(status, 'aircraft').count).toBe(0);
    expect(step(status, 'aircraft').essential).toBe(true);

    // Sole seeded owner → memberCount === 1 → NOT done (needs >1)
    expect(step(status, 'people').count).toBe(1);
    expect(step(status, 'people').done).toBe(false);
    expect(step(status, 'people').essential).toBe(true);

    // Optionals all undone
    for (const key of ['base_airport', 'rates', 'policies', 'payments'] as const) {
      expect(step(status, key).done).toBe(false);
      expect(step(status, key).essential).toBe(false);
    }

    // Aggregates — no NaN/null
    expect(status.essentialDone).toBe(false);
    expect(status.optionalDone).toBe(false);
    expect(status.essentialCount).toBe(0);
    expect(status.essentialTotal).toBe(2);
    expect(status.doneCount).toBe(0);
    expect(status.totalCount).toBe(6);
    expect(status.percentComplete).toBe(0);
    expect(Number.isNaN(status.percentComplete)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — REALITY: steps reflect what the org has configured
// ══════════════════════════════════════════════════════════════════════════════

describe('Steps reflect reality', () => {
  it('add aircraft → aircraft step done + count reflects it', async () => {
    const { db, seed } = await freshEnv();
    const sess = makeSession(seed.orgAId, seed.userAId, 'owner');

    let status = await getOnboardingStatusWithDb(db, sess);
    expect(step(status, 'aircraft').done).toBe(false);

    await addAircraft(db, seed.orgAId, seed.userAId, 'N101AB');
    await addAircraft(db, seed.orgAId, seed.userAId, 'N202CD');

    status = await getOnboardingStatusWithDb(db, sess);
    expect(step(status, 'aircraft').done).toBe(true);
    expect(step(status, 'aircraft').count).toBe(2);
  });

  it('essentialDone flips ONLY when aircraft AND >1 active member exist', async () => {
    const { db, seed } = await freshEnv();
    const sess = makeSession(seed.orgAId, seed.userAId, 'owner');

    // Start: neither
    expect((await getOnboardingStatusWithDb(db, sess)).essentialDone).toBe(false);

    // Aircraft only → still not essentialDone (people not yet >1)
    await addAircraft(db, seed.orgAId, seed.userAId, 'N101AB');
    let status = await getOnboardingStatusWithDb(db, sess);
    expect(step(status, 'aircraft').done).toBe(true);
    expect(step(status, 'people').done).toBe(false);
    expect(status.essentialDone).toBe(false);

    // Add a second active member → people done → essentialDone true
    await addActiveMember(db, seed.orgAId, 'newpilot@alpha.example');
    status = await getOnboardingStatusWithDb(db, sess);
    expect(step(status, 'people').count).toBe(2);
    expect(step(status, 'people').done).toBe(true);
    expect(status.essentialDone).toBe(true);
    expect(status.essentialCount).toBe(2);
  });

  it('base_airport requires BOTH coords (ICAO-only seeded location is not enough)', async () => {
    const { db, seed } = await freshEnv();
    const sess = makeSession(seed.orgAId, seed.userAId, 'owner');

    // Seeded location has an ICAO but no lat/long → not done
    let status = await getOnboardingStatusWithDb(db, sess);
    expect(step(status, 'base_airport').done).toBe(false);
    expect(step(status, 'base_airport').count).toBe(0);

    // Add coords → done
    await setBaseCoords(db, seed.orgAId);
    status = await getOnboardingStatusWithDb(db, sess);
    expect(step(status, 'base_airport').done).toBe(true);
    expect(step(status, 'base_airport').count).toBe(1);
  });

  it('rates + policies + payments reflect config; percentComplete tracks doneCount', async () => {
    const { db, seed } = await freshEnv();
    const sess = makeSession(seed.orgAId, seed.userAId, 'owner');

    // Rate
    await addRate(db, seed.orgAId, seed.userAId);
    // Policy (needs an aircraft to attach to)
    const acId = await addAircraft(db, seed.orgAId, seed.userAId, 'N303EF');
    await addPolicy(db, seed.orgAId, acId);
    // Payments via QBO connected
    await connectQbo(db, seed.orgAId);

    const status = await getOnboardingStatusWithDb(db, sess);
    expect(step(status, 'rates').done).toBe(true);
    expect(step(status, 'rates').count).toBe(1);
    expect(step(status, 'policies').done).toBe(true);
    expect(step(status, 'policies').count).toBe(1);
    expect(step(status, 'payments').done).toBe(true);
    expect(step(status, 'payments').count).toBe(1);

    // Done so far: aircraft, rates, policies, payments = 4 of 6.
    // (people still 1 → not done; base_airport no coords → not done)
    expect(status.doneCount).toBe(4);
    expect(status.totalCount).toBe(6);
    expect(status.percentComplete).toBe(Math.round((4 / 6) * 100)); // 67
    expect(status.optionalDone).toBe(false); // base_airport still undone
  });

  it('everything configured → 100% + optionalDone + essentialDone', async () => {
    const { db, seed } = await freshEnv();
    const sess = makeSession(seed.orgAId, seed.userAId, 'owner');

    const acId = await addAircraft(db, seed.orgAId, seed.userAId, 'N404GH');
    await addActiveMember(db, seed.orgAId, 'second@alpha.example');
    await setBaseCoords(db, seed.orgAId);
    await addRate(db, seed.orgAId, seed.userAId);
    await addPolicy(db, seed.orgAId, acId);
    await connectQbo(db, seed.orgAId);

    const status = await getOnboardingStatusWithDb(db, sess);
    expect(status.steps.every((s) => s.done)).toBe(true);
    expect(status.essentialDone).toBe(true);
    expect(status.optionalDone).toBe(true);
    expect(status.doneCount).toBe(6);
    expect(status.percentComplete).toBe(100);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — TENANT ISOLATION (T-ISO)
// ══════════════════════════════════════════════════════════════════════════════

describe('T-ISO: org-B config never leaks into org-A counts', () => {
  it('org-B fully configured; org-A session still sees an all-incomplete checklist', async () => {
    const { db, seed } = await freshEnv();

    // Load org B up with everything.
    const acB = await addAircraft(db, seed.orgBId, seed.userBId, 'N999ZZ');
    await addActiveMember(db, seed.orgBId, 'extra@beta.example');
    await setBaseCoords(db, seed.orgBId);
    await addRate(db, seed.orgBId, seed.userBId);
    await addPolicy(db, seed.orgBId, acB);
    await connectQbo(db, seed.orgBId);

    // Org A session must be unaffected.
    const statusA = await getOnboardingStatusWithDb(
      db,
      makeSession(seed.orgAId, seed.userAId, 'owner'),
    );
    expect(step(statusA, 'aircraft').count).toBe(0);
    expect(step(statusA, 'people').count).toBe(1); // only org-A's seeded owner
    expect(step(statusA, 'base_airport').count).toBe(0);
    expect(step(statusA, 'rates').count).toBe(0);
    expect(step(statusA, 'policies').count).toBe(0);
    expect(step(statusA, 'payments').count).toBe(0);
    expect(statusA.doneCount).toBe(0);
    expect(statusA.percentComplete).toBe(0);

    // And org B genuinely IS fully configured (proves the isolation is real,
    // not just both-empty).
    const statusB = await getOnboardingStatusWithDb(
      db,
      makeSession(seed.orgBId, seed.userBId, 'owner'),
    );
    expect(statusB.percentComplete).toBe(100);
  });
});
