/**
 * dashboard.test.ts — Slice 0.3 getDashboardSummary pglite integration tests.
 *
 * COVERAGE:
 *
 *   1. Org A session → gets A's orgName, orgSlug, and A's locationCount.
 *   2. Org B session → gets B's orgName, orgSlug, and B's locationCount.
 *   3. Org A session NEVER sees Org B data (orgName/locationCount isolation).
 *   4. org_id-from-session invariant: session with orgId=A but slug='beta' still
 *      scopes to Org A (slug is nav-only; orgId is the real gate).
 *   5. Student-role session gets correct isolated org data (RBAC ⟂ tenant-scoping).
 *   6. Missing session → UnauthenticatedError (delegated from withSessionOrgContextWithDb).
 *
 * SETUP:
 *   - Shared PGlite instance; both migrations applied once in beforeAll.
 *   - seedTwoOrgs gives us two orgs, each with 1 location.
 *   - We seed a student membership for the student-role test (test 5).
 *   - setTestAppRole before assertions so RLS is enforced.
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
  withOrgContext,
} from '@aeroops/db';
import { appUser, membership } from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import { getDashboardSummaryWithDb } from '../dashboard/get-dashboard-summary.js';
import { UnauthenticatedError } from '../auth/session.js';
import type { AppSession } from '../auth/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_0000 = readFileSync(
  resolve(__dirname, '../../../db/migrations/0000_loud_prodigy.sql'),
  'utf-8',
);
const MIGRATION_0001 = readFileSync(
  resolve(__dirname, '../../../db/migrations/0001_auth_credential.sql'),
  'utf-8',
);
// 0002–0008 required: Drizzle ORM INSERT on app_user now emits phone+status columns.
const MIGRATIONS_0002_0008 = [
  readFileSync(resolve(__dirname, '../../../db/migrations/0002_scheduling.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0003_booking_policies.sql'),  'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0004_recurrence.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0005_dispatch.sql'),          'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0006_squawks_grounding.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0007_fleet.sql'),             'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0008_people.sql'),            'utf-8'),
  // 0009 required: dispatch_requirement + dispatch_config tables (Slice 3c / ADR-0009).
  // openDispatch now queries dispatch_requirement; tables must exist in test DB.
  readFileSync(resolve(__dirname, '../../../db/migrations/0009_dispatch_gate.sql'),    'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0010_civil_twilight.sql'),    'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0011_optimizer_run.sql'),    'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0012_training.sql'),           'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0013_work_orders.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0014_availability.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0015_booking_request.sql'),  'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0016_booking_request_convert.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0017_booking_retention.sql'),        'utf-8'),
];

// ─── Test state ───────────────────────────────────────────────────────────────
let db: PgliteTestClient;
let pglite: PGlite;
let orgAId: string;
let orgBId: string;
let userAId: string;
let userBId: string;
let studentUserId: string;

// ─── beforeAll ────────────────────────────────────────────────────────────────
beforeAll(async () => {
  ({ db, pglite } = await createTestClient());
  await applyMigrationSql({ pglite }, [MIGRATION_0000, MIGRATION_0001, ...MIGRATIONS_0002_0008]);

  const seed = await seedTwoOrgs(db);
  orgAId = seed.orgAId;
  orgBId = seed.orgBId;
  userAId = seed.userAId;
  userBId = seed.userBId;

  // Seed a student user for test 5 — within Org A's context.
  // We must do this as superuser (before setTestAppRole) so RLS doesn't block it.
  const studentData = await withOrgContext(db, orgAId, async (tx) => {
    const [usr] = await tx
      .insert(appUser)
      .values({ orgId: orgAId, email: 'student@alpha.example', fullName: 'Sam Student' })
      .returning();

    const [mem] = await tx
      .insert(membership)
      .values({ orgId: orgAId, userId: usr!.id, role: 'student' })
      .returning();

    return { userId: usr!.id, membershipId: mem!.id };
  });
  studentUserId = studentData.userId;

  // Drop to app role so RLS is enforced for all assertions.
  await setTestAppRole({ pglite });
}, 60_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(
  orgId: string,
  slug: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug, role, user: { email: 'test@example.com' } };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Org A session → A's data
// ═════════════════════════════════════════════════════════════════════════════

describe('1. Org A session returns A data', () => {
  it('returns orgName = Alpha Flight School', async () => {
    const session = makeSession(orgAId, 'alpha', userAId);
    const summary = await getDashboardSummaryWithDb(db, session);
    expect(summary.orgName).toBe('Alpha Flight School');
  });

  it('returns orgSlug = alpha', async () => {
    const session = makeSession(orgAId, 'alpha', userAId);
    const summary = await getDashboardSummaryWithDb(db, session);
    expect(summary.orgSlug).toBe('alpha');
  });

  it('returns locationCount = 1 (seeded by seedTwoOrgs)', async () => {
    const session = makeSession(orgAId, 'alpha', userAId);
    const summary = await getDashboardSummaryWithDb(db, session);
    expect(summary.locationCount).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Org B session → B's data
// ═════════════════════════════════════════════════════════════════════════════

describe('2. Org B session returns B data', () => {
  it('returns orgName = Beta Flying Club', async () => {
    const session = makeSession(orgBId, 'beta', userBId);
    const summary = await getDashboardSummaryWithDb(db, session);
    expect(summary.orgName).toBe('Beta Flying Club');
  });

  it('returns orgSlug = beta', async () => {
    const session = makeSession(orgBId, 'beta', userBId);
    const summary = await getDashboardSummaryWithDb(db, session);
    expect(summary.orgSlug).toBe('beta');
  });

  it('returns locationCount = 1 for Org B', async () => {
    const session = makeSession(orgBId, 'beta', userBId);
    const summary = await getDashboardSummaryWithDb(db, session);
    expect(summary.locationCount).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Org A session NEVER sees Org B data (isolation)
// ═════════════════════════════════════════════════════════════════════════════

describe('3. Tenant isolation — Org A session cannot see Org B data', () => {
  it('orgName is Alpha, not Beta', async () => {
    const session = makeSession(orgAId, 'alpha', userAId);
    const summary = await getDashboardSummaryWithDb(db, session);
    expect(summary.orgName).not.toBe('Beta Flying Club');
    expect(summary.orgName).toBe('Alpha Flight School');
  });

  it('orgSlug is alpha, not beta', async () => {
    const session = makeSession(orgAId, 'alpha', userAId);
    const summary = await getDashboardSummaryWithDb(db, session);
    expect(summary.orgSlug).not.toBe('beta');
    expect(summary.orgSlug).toBe('alpha');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. org_id-from-session invariant
//    session with orgId=A but slug='beta' still scopes to Org A.
// ═════════════════════════════════════════════════════════════════════════════

describe('4. org_id-from-session invariant (slug is nav-only)', () => {
  it('session orgId=A, slug=beta → returns Alpha data (orgId wins, not slug)', async () => {
    // Deliberately mismatched slug — in production the middleware prevents this,
    // but the data layer must scope to orgId regardless.
    const session = makeSession(orgAId, 'beta', userAId);
    const summary = await getDashboardSummaryWithDb(db, session);

    // Must scope to Org A (orgId=A), not Org B (slug=beta).
    expect(summary.orgName).toBe('Alpha Flight School');
    expect(summary.orgSlug).toBe('alpha');
    expect(summary.locationCount).toBe(1);
  });

  it('session orgId=B, slug=alpha → returns Beta data', async () => {
    const session = makeSession(orgBId, 'alpha', userBId);
    const summary = await getDashboardSummaryWithDb(db, session);
    expect(summary.orgName).toBe('Beta Flying Club');
    expect(summary.orgSlug).toBe('beta');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Student-role session — RBAC ⟂ tenant-scoping
//    A student can read their own org's data (app:access);
//    the dashboard summary does not require org:manage_settings.
// ═════════════════════════════════════════════════════════════════════════════

describe('5. Student-role session — correct isolated org data (RBAC ⟂ tenant-scoping)', () => {
  it('student gets Org A name (not denied by role)', async () => {
    const session = makeSession(orgAId, 'alpha', studentUserId, 'student');
    const summary = await getDashboardSummaryWithDb(db, session);
    expect(summary.orgName).toBe('Alpha Flight School');
  });

  it('student gets Org A slug', async () => {
    const session = makeSession(orgAId, 'alpha', studentUserId, 'student');
    const summary = await getDashboardSummaryWithDb(db, session);
    expect(summary.orgSlug).toBe('alpha');
  });

  it('student locationCount reflects Org A only (not Org B)', async () => {
    const session = makeSession(orgAId, 'alpha', studentUserId, 'student');
    const summary = await getDashboardSummaryWithDb(db, session);
    // seedTwoOrgs creates 1 location per org. Student sees only Org A's.
    expect(summary.locationCount).toBe(1);
  });

  it('student cannot see Org B name (cross-org isolation holds regardless of role)', async () => {
    const session = makeSession(orgAId, 'alpha', studentUserId, 'student');
    const summary = await getDashboardSummaryWithDb(db, session);
    expect(summary.orgName).not.toBe('Beta Flying Club');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Missing session → UnauthenticatedError
// ═════════════════════════════════════════════════════════════════════════════

describe('6. Missing/incomplete session → UnauthenticatedError', () => {
  it('null session → UnauthenticatedError', async () => {
    await expect(getDashboardSummaryWithDb(db, null)).rejects.toThrow(UnauthenticatedError);
  });

  it('undefined session → UnauthenticatedError', async () => {
    await expect(getDashboardSummaryWithDb(db, undefined)).rejects.toThrow(UnauthenticatedError);
  });

  it('session missing orgId → UnauthenticatedError', async () => {
    const badSession = makeSession('', 'alpha', userAId);
    await expect(getDashboardSummaryWithDb(db, badSession)).rejects.toThrow(UnauthenticatedError);
  });

  it('session missing userId → UnauthenticatedError', async () => {
    const badSession = makeSession(orgAId, 'alpha', '');
    await expect(getDashboardSummaryWithDb(db, badSession)).rejects.toThrow(UnauthenticatedError);
  });
});
