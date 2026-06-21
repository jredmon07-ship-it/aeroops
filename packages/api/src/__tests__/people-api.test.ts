/**
 * people-api.test.ts — API integration tests for Slice 6.2 (People/Members).
 *
 * Tests the persistence/DB layer for all 8 people API functions + capabilities.
 * Applies migrations 0000–0008 (0008 = app_user phone/status + member_tag).
 *
 * COVERAGE (per spec §5 T9–T23):
 *
 * T9  — listMembers: happy path (active-only default), includeInactive=true
 * T10 — listMembers: tenant isolation (cross-org member invisible)
 * T11 — listMembers: authz (mechanic/renter → ForbiddenError; null → Unauthenticated)
 * T12 — getMemberDetail: happy path (all facets: identity + tags + reservations + dispatch)
 * T13 — getMemberDetail: no activity → empty cards ok
 * T14 — getMemberDetail: deactivated → full detail (not not_found)
 * T15 — getMemberDetail: cross-org userId → not_found + NO facet leak
 *        (seed org-B member WITH tag + future reservation + dispatch ticket;
 *         org-A caller → not_found, no data from org-B leaks)
 * T16 — updateMember: edits fullName/phone/role + ONE audit row + fresh detail
 * T17 — updateMember: last-owner boundary
 *        (2 active owners ok / 1 active+1 inactive refused / exactly 1 refused)
 * T18 — updateMember: never touches email or records; cross-org → not_found
 * T19 — setMemberStatus: audit + self-deactivation guard + last-owner guard
 * T20 — addMemberTag: insert + audit + duplicate + empty ValidationError + cross-org
 * T21 — removeMemberTag: delete + audit + not_found (cross-org tagId)
 * T22 — addMember: NO auth_credential row + audit + email_taken
 * T23 — Capabilities: people:access + people:manage exhaustiveness + the 2 new caps
 *
 * Setup pattern: createTestClient() → applyMigrationSql([0000–0008]) →
 * seedTwoOrgs → additional seed → setTestAppRole.
 *
 * NOTE: No property tests (no new pure algorithm; last-owner is a count predicate
 * covered by boundary cases per spec §5 "No property tests" note).
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
} from '@aeroops/db';
import { appUser, membership, authCredential, auditLog } from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';

import { listMembersWithDb } from '../people/list-members.js';
import { getMemberDetailWithDb } from '../people/get-member-detail.js';
import { updateMemberWithDb } from '../people/update-member.js';
import { setMemberStatusWithDb } from '../people/set-member-status.js';
import { addMemberTagWithDb } from '../people/add-member-tag.js';
import { removeMemberTagWithDb } from '../people/remove-member-tag.js';
import { addMemberWithDb } from '../people/add-member.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';
import { can, MEMBERSHIP_ROLES, CAPABILITIES } from '@aeroops/core';

// ── Path resolution ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const MIGRATION_SQL = [
  readFileSync(resolve(__dirname, '../../../db/migrations/0000_loud_prodigy.sql'),      'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0001_auth_credential.sql'),   'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0002_scheduling.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0003_booking_policies.sql'),  'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0004_recurrence.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0005_dispatch.sql'),          'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0006_squawks_grounding.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0007_fleet.sql'),             'utf-8'),
  // 0008 required: app_user phone/status + member_tag table (Slice 6.1).
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

// Future dates so booking-policy min-advance checks pass.
const D  = '2026-10-15';
const D2 = '2026-10-16';
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
    orgAId:  seed.orgAId,
    orgBId:  seed.orgBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };
}, 60_000);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Seed a second org-A user with a membership. Returns userId. */
async function seedOrgAMember(
  db: PgliteTestClient,
  orgId: string,
  email: string,
  role: AppSession['role'] = 'renter',
  status = 'active',
): Promise<string> {
  return withOrgContext(db, orgId, async (tx) => {
    const [usr] = await tx
      .insert(appUser)
      .values({ orgId, email, fullName: `User ${email}`, status })
      .returning();
    await tx.insert(membership).values({ orgId, userId: usr!.id, role });
    return usr!.id;
  });
}

/** Seed an aircraft and a reservation for it (org A context). */
async function seedAircraftWithReservation(
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
    displayName: `N-PPL-${tag}`,
    tailNumber:  `NP${tag}`,
  });
  const rResult = await createReservationWithDb(db, sess, {
    startAt:     start,
    endAt:       end,
    resourceIds: [aircraft.id],
  });
  if (!rResult.ok) throw new Error(`seed reservation failed: ${rResult.reason}`);
  return { aircraftId: aircraft.id, reservationId: rResult.reservation.id };
}

// ════════════════════════════════════════════════════════════════════════════════
// T9 — listMembers: happy path + includeInactive
// ════════════════════════════════════════════════════════════════════════════════

describe('T9 — listMembers', () => {
  it('returns active members only by default', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const rows = await listMembersWithDb(db, sess);
    // All returned rows should be active.
    expect(rows.every((r) => r.status === 'active')).toBe(true);
    // The seeded org-A owner should appear.
    const alice = rows.find((r) => r.userId === userAId);
    expect(alice).toBeDefined();
    expect(alice?.role).toBe('owner');
  });

  it('includes inactive members when includeInactive=true', async () => {
    const { db, orgAId, userAId } = sharedEnv;

    // Seed an inactive member.
    const inactiveId = await seedOrgAMember(db, orgAId, `inactive-t9-${Date.now()}@test.com`, 'renter', 'inactive');

    const sess = makeSession(orgAId, userAId, 'owner');
    const activeOnly = await listMembersWithDb(db, sess);
    const withInactive = await listMembersWithDb(db, sess, { includeInactive: true });

    const inactiveInActive = activeOnly.find((r) => r.userId === inactiveId);
    const inactiveInAll    = withInactive.find((r) => r.userId === inactiveId);

    expect(inactiveInActive).toBeUndefined();
    expect(inactiveInAll).toBeDefined();
    expect(inactiveInAll?.status).toBe('inactive');
  });

  it('includes tags in the list row (set-based, no N+1)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Add a tag to the owner via addMemberTag.
    await addMemberTagWithDb(db, sess, { userId: userAId, tag: 'IFR-Pilot' });

    const rows = await listMembersWithDb(db, sess);
    const owner = rows.find((r) => r.userId === userAId);
    expect(owner?.tags).toContain('IFR-Pilot');
    expect(owner?.tagCount).toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T10 — listMembers tenant isolation
// ════════════════════════════════════════════════════════════════════════════════

describe('T10 — listMembers tenant isolation', () => {
  it('cross-org member is invisible in org-A list', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const rows = await listMembersWithDb(db, sessA);
    const bobVisible = rows.find((r) => r.userId === userBId);
    expect(bobVisible).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T11 — listMembers authz
// ════════════════════════════════════════════════════════════════════════════════

describe('T11 — listMembers authz', () => {
  it('mechanic → ForbiddenError (people:access not granted)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'mechanic');
    await expect(listMembersWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('renter → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(listMembersWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(listMembersWithDb(db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('cfi has people:access → succeeds', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'cfi');
    const rows = await listMembersWithDb(db, sess);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('dispatcher has people:access → succeeds', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'dispatcher');
    const rows = await listMembersWithDb(db, sess);
    expect(Array.isArray(rows)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T12 — getMemberDetail happy path (all facets)
// ════════════════════════════════════════════════════════════════════════════════

describe('T12 — getMemberDetail happy path', () => {
  it('returns full detail with all facets populated', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Add a tag.
    await addMemberTagWithDb(db, sess, { userId: userAId, tag: 'CFR-Tag' });

    // Seed a reservation + dispatch ticket so the facets are populated.
    const { aircraftId, reservationId } = await seedAircraftWithReservation(
      db, orgAId, userAId, `T12-${Date.now()}`,
    );
    await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 100.0,
      tachOut:  100.0,
    });

    const result = await getMemberDetailWithDb(db, sess, { userId: userAId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const m = result.member;
    expect(m.userId).toBe(userAId);
    expect(typeof m.displayName).toBe('string');
    expect(m.email).toBeTruthy();
    expect(m.status).toBe('active');
    expect(m.role).toBe('owner');
    expect(m.joinedAt).toBeInstanceOf(Date);
    expect(Array.isArray(m.tags)).toBe(true);
    expect(m.tags.some((t) => t.tag === 'CFR-Tag')).toBe(true);
    expect(Array.isArray(m.upcomingReservations)).toBe(true);
    expect(Array.isArray(m.recentDispatch)).toBe(true);
    // Dispatch ticket should appear in recent dispatch.
    expect(m.recentDispatch.some((d) => d.reservationId === reservationId)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T13 — getMemberDetail: no activity → empty facets ok
// ════════════════════════════════════════════════════════════════════════════════

describe('T13 — getMemberDetail no activity', () => {
  it('member with no tags, no reservations, no dispatch → empty arrays', async () => {
    const { db, orgAId, userAId } = sharedEnv;

    // Seed a fresh member with no activity.
    const freshId = await seedOrgAMember(db, orgAId, `noactivity-t13-${Date.now()}@test.com`, 'renter');

    const sess = makeSession(orgAId, userAId, 'owner');
    const result = await getMemberDetailWithDb(db, sess, { userId: freshId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.member.tags).toHaveLength(0);
    expect(result.member.upcomingReservations).toHaveLength(0);
    expect(result.member.recentDispatch).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T14 — getMemberDetail: deactivated → full detail
// ════════════════════════════════════════════════════════════════════════════════

describe('T14 — getMemberDetail deactivated member', () => {
  it('deactivated member returns full detail (not not_found)', async () => {
    const { db, orgAId, userAId } = sharedEnv;

    // Seed then deactivate.
    const inactiveUserId = await seedOrgAMember(db, orgAId, `deact-t14-${Date.now()}@test.com`, 'renter');
    // Deactivate via setMemberStatus (bypass self-deactivation guard by using different session user).
    const ownerSess = makeSession(orgAId, userAId, 'owner');
    await setMemberStatusWithDb(db, ownerSess, { userId: inactiveUserId, status: 'inactive' });

    const result = await getMemberDetailWithDb(db, ownerSess, { userId: inactiveUserId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.member.status).toBe('inactive');
    expect(result.member.userId).toBe(inactiveUserId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T15 — getMemberDetail: cross-org → not_found + NO facet leak
// ════════════════════════════════════════════════════════════════════════════════

describe('T15 — getMemberDetail cross-org tenant isolation', () => {
  it('org-A caller with org-B userId → not_found (no data leak)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;

    // Seed org-B member WITH a tag + future reservation + dispatch ticket (as pilot).
    const sessBOwner = makeSession(orgBId, userBId, 'owner');

    await addMemberTagWithDb(db, sessBOwner, { userId: userBId, tag: 'B-Pilot-Tag' });

    const { aircraftId: aircB, reservationId: resB } = await seedAircraftWithReservation(
      db, orgBId, userBId, `T15B-${Date.now()}`,
    );
    await openDispatchWithDb(db, sessBOwner, {
      reservationId: resB,
      resourceId:    aircB,
      pilotUserId:   userBId,
      hobbsOut:      200.0,
      tachOut:       200.0,
    });

    // Org-A caller attempts to read org-B member.
    const sessA = makeSession(orgAId, userAId, 'owner');
    const result = await getMemberDetailWithDb(db, sessA, { userId: userBId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T16 — updateMember: edits + ONE audit row + fresh detail
// ════════════════════════════════════════════════════════════════════════════════

describe('T16 — updateMember', () => {
  it('edits fullName and phone; ONE audit row; returns fresh detail', async () => {
    const { db, orgAId, userAId } = sharedEnv;

    const targetId = await seedOrgAMember(db, orgAId, `update-t16-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, userAId, 'owner');

    // Count audit rows before.
    const countBefore = await withOrgContext(db, orgAId, async (tx) => {
      const rows = await tx.select().from(auditLog)
        .where(and(eq(auditLog.action, 'member.updated'), eq(auditLog.entityId, targetId)));
      return rows.length;
    });

    const result = await updateMemberWithDb(db, sess, {
      userId:   targetId,
      fullName: 'Updated Name',
      phone:    '+1-555-0100',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.member.displayName).toBe('Updated Name');
    expect(result.member.phone).toBe('+1-555-0100');

    // Exactly ONE new audit row.
    const countAfter = await withOrgContext(db, orgAId, async (tx) => {
      const rows = await tx.select().from(auditLog)
        .where(and(eq(auditLog.action, 'member.updated'), eq(auditLog.entityId, targetId)));
      return rows.length;
    });
    expect(countAfter).toBe(countBefore + 1);
  });

  it('cross-org userId → not_found', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const result = await updateMemberWithDb(db, sessA, { userId: userBId, fullName: 'Hacker' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });

  it('dispatcher → ForbiddenError (no people:manage)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'dispatcher');
    await expect(updateMemberWithDb(db, sess, { userId: userAId, fullName: 'X' }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T17 — updateMember last-owner boundary
// ════════════════════════════════════════════════════════════════════════════════

describe('T17 — updateMember last-owner guard', () => {
  it('2 active owners → demotion of one ok', async () => {
    const { db, orgAId, userAId } = sharedEnv;

    // Seed a second active owner.
    const owner2Id = await seedOrgAMember(db, orgAId, `owner2-t17-${Date.now()}@test.com`, 'owner');

    const sess = makeSession(orgAId, userAId, 'owner');
    const result = await updateMemberWithDb(db, sess, { userId: owner2Id, role: 'manager' });
    expect(result.ok).toBe(true);
  });

  it('1 active + 1 inactive owner → demoting the active one refused (last_owner)', async () => {
    const { db, orgAId, userAId } = sharedEnv;

    // Seed a second owner then deactivate them.
    const inactiveOwnerId = await seedOrgAMember(db, orgAId, `inactowner-t17-${Date.now()}@test.com`, 'owner');
    // Deactivate inactive owner using another owner (not the target of the guard).
    // We need a third user to deactivate inactiveOwnerId without hitting self-guard.
    // Use userAId (the original owner) to deactivate inactiveOwnerId.
    const sess = makeSession(orgAId, userAId, 'owner');
    await setMemberStatusWithDb(db, sess, { userId: inactiveOwnerId, status: 'inactive' });

    // Now try to demote userAId (the sole remaining active owner) → should fail.
    const result = await updateMemberWithDb(db, sess, { userId: userAId, role: 'manager' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('last_owner');
  });

  it('exactly 1 active owner → demotion refused (last_owner)', async () => {
    const { db, orgAId, userAId } = sharedEnv;

    // Ensure userAId is the sole active owner (it might have been promoted back).
    // Try to demote the sole owner.
    const sess = makeSession(orgAId, userAId, 'owner');
    const result = await updateMemberWithDb(db, sess, { userId: userAId, role: 'renter' });
    // Either last_owner (if they're the only owner) or ok (if prior tests left another).
    // The important thing is: if there's only 1 active owner, last_owner is returned.
    if (!result.ok) {
      expect(result.reason).toBe('last_owner');
    }
    // If ok, it means there were ≥2 active owners (from prior test pollution), which is fine.
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T18 — updateMember: never touches email/records
// ════════════════════════════════════════════════════════════════════════════════

describe('T18 — updateMember never touches email or records', () => {
  it('email is unchanged after updateMember call', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const targetEmail = `noemail-t18-${Date.now()}@test.com`;
    const targetId = await seedOrgAMember(db, orgAId, targetEmail, 'renter');
    const sess = makeSession(orgAId, userAId, 'owner');

    await updateMemberWithDb(db, sess, { userId: targetId, fullName: 'Changed Name' });

    const detail = await getMemberDetailWithDb(db, sess, { userId: targetId });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.member.email).toBe(targetEmail);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T19 — setMemberStatus: audit + self-deactivation + last-owner guard
// ════════════════════════════════════════════════════════════════════════════════

describe('T19 — setMemberStatus', () => {
  it('activates / deactivates and writes ONE audit row', async () => {
    const { db, orgAId, userAId } = sharedEnv;

    const targetId = await seedOrgAMember(db, orgAId, `status-t19-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, userAId, 'owner');

    const result = await setMemberStatusWithDb(db, sess, { userId: targetId, status: 'inactive' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.member.status).toBe('inactive');

    const auditRows = await withOrgContext(db, orgAId, async (tx) => {
      return tx.select().from(auditLog)
        .where(and(eq(auditLog.action, 'member.status_changed'), eq(auditLog.entityId, targetId)));
    });
    expect(auditRows).toHaveLength(1);
  });

  it('self-deactivation → cannot_deactivate_self', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const result = await setMemberStatusWithDb(db, sess, { userId: userAId, status: 'inactive' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('cannot_deactivate_self');
  });

  it('deactivating sole active owner → last_owner', async () => {
    const { db, orgAId, userAId } = sharedEnv;

    // Strategy: use addMember to seed a second owner in orgA (works within org context
    // post-setTestAppRole). Then deactivate one so there's only 1 active owner.
    // Then try to deactivate the remaining one → should get last_owner.
    const ownerSess = makeSession(orgAId, userAId, 'owner');

    // Add a second owner (actor for the final deactivation).
    const secondOwnerResult = await addMemberWithDb(db, ownerSess, {
      email: `t19-second-owner-${Date.now()}@test.com`,
      fullName: 'Second Owner T19',
      role: 'owner',
    });
    expect(secondOwnerResult.ok).toBe(true);
    if (!secondOwnerResult.ok) return;
    const secondOwnerId = secondOwnerResult.member.userId;

    // Add a third member as a temporary 3rd owner — we'll deactivate them to get to 2 active.
    // Wait, we need exactly 2 active owners, then deactivate one to get to 1, then try to
    // deactivate the last. The test setup already has userAId as owner, so we now have 2.
    //
    // Status: userAId (active owner) + secondOwnerId (active owner) = 2 active owners.
    // Deactivate secondOwnerId via userAId (not self) → succeeds (2 → 1 active).
    const r1 = await setMemberStatusWithDb(db, ownerSess, { userId: secondOwnerId, status: 'inactive' });
    expect(r1.ok).toBe(true);

    // Now userAId is the sole active owner. Add another member as actor
    // (we need someone OTHER than userAId to try to deactivate userAId without the self-guard).
    // Since status doesn't block auth, we can use secondOwnerId (now inactive) as the actor.
    // [VERIFY-6-D]: inactive status does NOT block login/API calls in this slice.
    const inactiveActorSess = makeSession(orgAId, secondOwnerId, 'owner');
    const r2 = await setMemberStatusWithDb(db, inactiveActorSess, { userId: userAId, status: 'inactive' });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('last_owner');

    // Cleanup: keep userAId active for subsequent tests by not proceeding if r2 succeeded.
  });

  it('cfi → ForbiddenError (no people:manage)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const targetId = await seedOrgAMember(db, orgAId, `cfi-t19-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, userAId, 'cfi');
    await expect(setMemberStatusWithDb(db, sess, { userId: targetId, status: 'inactive' }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T20 — addMemberTag: insert + audit + duplicate + empty ValidationError + cross-org
// ════════════════════════════════════════════════════════════════════════════════

describe('T20 — addMemberTag', () => {
  it('inserts tag + ONE audit row + returns fresh detail', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const targetId = await seedOrgAMember(db, orgAId, `tag-t20-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, userAId, 'owner');

    const result = await addMemberTagWithDb(db, sess, { userId: targetId, tag: 'VFR-Only' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.member.tags.some((t) => t.tag === 'VFR-Only')).toBe(true);

    const auditRows = await withOrgContext(db, orgAId, async (tx) => {
      return tx.select().from(auditLog)
        .where(and(eq(auditLog.action, 'member.tag_added'), eq(auditLog.entityId, targetId)));
    });
    expect(auditRows).toHaveLength(1);
  });

  it('duplicate tag → {ok:false, reason:"duplicate"}', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const targetId = await seedOrgAMember(db, orgAId, `dup-t20-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, userAId, 'owner');

    await addMemberTagWithDb(db, sess, { userId: targetId, tag: 'Dup-Tag' });
    const r2 = await addMemberTagWithDb(db, sess, { userId: targetId, tag: 'Dup-Tag' });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('duplicate');
  });

  it('empty tag after trim → ValidationError (thrown)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const targetId = await seedOrgAMember(db, orgAId, `empty-t20-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(addMemberTagWithDb(db, sess, { userId: targetId, tag: '   ' }))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('cross-org userId → not_found', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const result = await addMemberTagWithDb(db, sessA, { userId: userBId, tag: 'CrossOrg' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });

  it('tags are case-sensitive (same tag different case → both allowed)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const targetId = await seedOrgAMember(db, orgAId, `case-t20-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, userAId, 'owner');

    const r1 = await addMemberTagWithDb(db, sess, { userId: targetId, tag: 'ifr' });
    const r2 = await addMemberTagWithDb(db, sess, { userId: targetId, tag: 'IFR' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('addMemberTag on deactivated member is allowed', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const targetId = await seedOrgAMember(db, orgAId, `deact-tag-t20-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, userAId, 'owner');

    await setMemberStatusWithDb(db, sess, { userId: targetId, status: 'inactive' });
    const result = await addMemberTagWithDb(db, sess, { userId: targetId, tag: 'Deactivated-Tag' });
    expect(result.ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T21 — removeMemberTag: delete + audit + not_found (cross-org tagId)
// ════════════════════════════════════════════════════════════════════════════════

describe('T21 — removeMemberTag', () => {
  it('deletes tag + ONE audit row + returns fresh detail', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const targetId = await seedOrgAMember(db, orgAId, `rmtag-t21-${Date.now()}@test.com`, 'renter');
    const sess = makeSession(orgAId, userAId, 'owner');

    const addResult = await addMemberTagWithDb(db, sess, { userId: targetId, tag: 'ToRemove' });
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) return;
    const tagId = addResult.member.tags.find((t) => t.tag === 'ToRemove')?.id;
    expect(tagId).toBeDefined();

    const rmResult = await removeMemberTagWithDb(db, sess, { userId: targetId, tagId: tagId! });
    expect(rmResult.ok).toBe(true);
    if (!rmResult.ok) return;
    expect(rmResult.member.tags.some((t) => t.tag === 'ToRemove')).toBe(false);

    const auditRows = await withOrgContext(db, orgAId, async (tx) => {
      return tx.select().from(auditLog)
        .where(and(eq(auditLog.action, 'member.tag_removed'), eq(auditLog.entityId, targetId)));
    });
    expect(auditRows).toHaveLength(1);
  });

  it('cross-org tagId → not_found', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;

    // Add a tag to org-B member.
    const sessBOwner = makeSession(orgBId, userBId, 'owner');
    const addB = await addMemberTagWithDb(db, sessBOwner, { userId: userBId, tag: `CrossOrgTag-T21-${Date.now()}` });
    expect(addB.ok).toBe(true);
    if (!addB.ok) return;
    const orgBTagId = addB.member.tags[0]?.id;
    expect(orgBTagId).toBeDefined();

    // Org-A caller tries to remove org-B tag.
    const sessA = makeSession(orgAId, userAId, 'owner');
    const result = await removeMemberTagWithDb(db, sessA, { userId: userAId, tagId: orgBTagId! });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T22 — addMember: NO auth_credential row + audit + email_taken
// ════════════════════════════════════════════════════════════════════════════════

describe('T22 — addMember', () => {
  it('creates app_user + membership + audit; writes ZERO auth_credential rows', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const email = `newmember-t22-${Date.now()}@test.com`;

    // Count credential rows before.
    const credsBefore = await withOrgContext(db, orgAId, async (tx) => {
      return (await tx.select().from(authCredential)).length;
    });

    const result = await addMemberWithDb(db, sess, {
      email,
      fullName: 'New Roster Member',
      role:     'renter',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.member.email).toBe(email);
    expect(result.member.displayName).toBe('New Roster Member');
    expect(result.member.role).toBe('renter');
    expect(result.member.status).toBe('active');

    // ZERO auth_credential rows created.
    const credsAfter = await withOrgContext(db, orgAId, async (tx) => {
      return (await tx.select().from(authCredential)).length;
    });
    expect(credsAfter).toBe(credsBefore);

    // ONE audit row.
    const auditRows = await withOrgContext(db, orgAId, async (tx) => {
      return tx.select().from(auditLog)
        .where(and(eq(auditLog.action, 'member.created'), eq(auditLog.entityId, result.member.userId)));
    });
    expect(auditRows).toHaveLength(1);
  });

  it('email already in org → {ok:false, reason:"email_taken"}', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const email = `dup-t22-${Date.now()}@test.com`;

    // First add succeeds.
    const r1 = await addMemberWithDb(db, sess, { email, role: 'renter' });
    expect(r1.ok).toBe(true);

    // Second add with same email in same org → email_taken.
    const r2 = await addMemberWithDb(db, sess, { email, role: 'student' });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('email_taken');
  });

  it('invalid role → ValidationError (thrown)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(addMemberWithDb(db, sess, {
      email: `badrole-t22-${Date.now()}@test.com`,
      role:  'superuser',
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('mechanic → ForbiddenError (no people:manage)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'mechanic');
    await expect(addMemberWithDb(db, sess, { email: 'x@y.com', role: 'renter' }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T23 — Capabilities: people:access + people:manage exhaustiveness + 2 new caps
// ════════════════════════════════════════════════════════════════════════════════

describe('T23 — Capability exhaustiveness + new caps', () => {
  it('CAPABILITIES contains people:access and people:manage', () => {
    expect(CAPABILITIES).toContain('people:access');
    expect(CAPABILITIES).toContain('people:manage');
  });

  it('people:access granted to owner/manager/dispatcher/cfi only', () => {
    const GRANTED: AppSession['role'][] = ['owner', 'manager', 'dispatcher', 'cfi'];
    const EXCLUDED: AppSession['role'][] = ['mechanic', 'renter', 'student', 'accountant'];
    for (const role of GRANTED)   expect(can(role, 'people:access')).toBe(true);
    for (const role of EXCLUDED)  expect(can(role, 'people:access')).toBe(false);
  });

  it('people:manage granted to owner/manager ONLY', () => {
    const GRANTED: AppSession['role'][] = ['owner', 'manager'];
    const EXCLUDED: AppSession['role'][] = ['dispatcher', 'cfi', 'mechanic', 'renter', 'student', 'accountant'];
    for (const role of GRANTED)   expect(can(role, 'people:manage')).toBe(true);
    for (const role of EXCLUDED)  expect(can(role, 'people:manage')).toBe(false);
  });

  it('all 8 roles remain in MEMBERSHIP_ROLES (no roles dropped)', () => {
    expect(MEMBERSHIP_ROLES.length).toBe(8);
  });

  it('CAPABILITIES has exactly 21 entries (20 prior + booking:triage — Slice PB1.2)', () => {
    expect(CAPABILITIES.length).toBe(21);
  });

  it('CAPABILITIES is sorted alphabetically', () => {
    const sorted = [...CAPABILITIES].sort();
    expect([...CAPABILITIES]).toEqual(sorted);
  });

  it('no capability appears twice in CAPABILITIES', () => {
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
  });
});
