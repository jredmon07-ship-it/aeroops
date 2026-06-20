/**
 * dispatch-gate-api.test.ts — Integration tests for Slice 3c dispatch gate API.
 *
 * Tests the persistence/DB layer for:
 *   - getResourceRequiredTags / addResourceRequiredTag / removeResourceRequiredTag
 *   - getDispatchConfig / updateDispatchConfig
 *   - openDispatch additive arms: eligibility (block/warn/no-rules) + balance
 *   - Tenant isolation (cross-org → not_found)
 *   - Grounded PRECEDES ineligible
 *   - Audit exactness (one per mutation; refusals write zero)
 *   - All existing open-dispatch tests remain byte-identical
 *
 * Applies migrations 0000–0009 (migration 0009 = dispatch_gate tables).
 *
 * Setup mirrors dispatch-api.test.ts: createTestClient() →
 * applyMigrationSql([0000–0009]) → seedTwoOrgs → additional seed → setTestAppRole.
 *
 * [VERIFY-3c-A]: requiredTag is FREE-TEXT; no FAA/currency/medical meaning.
 * [VERIFY-3c-MONEY]: balanceCheckEnabled is a stub flag; no dollar/Stripe/money.
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
  withPlatformAdminContext,
  seedTwoOrgs,
} from '@aeroops/db';
import {
  appUser,
  membership,
  resource,
  reservation,
  reservationResource,
  auditLog,
  memberTag,
  dispatchRequirement,
  dispatchConfig,
  aircraftGrounding,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { groundAircraftWithDb } from '../maintenance/ground-aircraft.js';
import {
  getResourceRequiredTagsWithDb,
  addResourceRequiredTagWithDb,
  removeResourceRequiredTagWithDb,
} from '../dispatch-gate/requirements.js';
import {
  getDispatchConfigWithDb,
  updateDispatchConfigWithDb,
} from '../dispatch-gate/config.js';
import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';
import type { BalanceSeam, BalanceCheckRequest, BalanceCheckResult } from '@aeroops/core';

// ── Path resolution ───────────────────────────────────────────────────────────
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
  readFileSync(resolve(__dirname, '../../../db/migrations/0014_availability.sql'),     'utf-8'),
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

const D = '2026-09-15';
const T = {
  W1_start: new Date(`${D}T08:00:00Z`),
  W1_end:   new Date(`${D}T10:00:00Z`),
  W2_start: new Date(`${D}T12:00:00Z`),
  W2_end:   new Date(`${D}T14:00:00Z`),
};

let sharedEnv: TestEnv;

/** Helper: create aircraft + booked reservation in org A. */
async function seedAircraftAndReservation(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tag: string,
  start = T.W1_start,
  end = T.W1_end,
): Promise<{ aircraftId: string; reservationId: string }> {
  const sess = makeSession(orgId, userId, 'owner');
  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `N-GATE-${tag}`,
    tailNumber: `NG${tag}`,
  });
  const rResult = await createReservationWithDb(db, sess, {
    startAt: start,
    endAt: end,
    resourceIds: [aircraft.id],
  });
  if (!rResult.ok) throw new Error(`seed reservation failed: ${rResult.reason}`);
  return { aircraftId: aircraft.id, reservationId: rResult.reservation.id };
}

/** Helper: add a member_tag to a pilot. */
async function seedMemberTag(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tagValue: string,
  actorId: string,
): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    await tx.insert(memberTag).values({
      orgId,
      userId,
      tag: tagValue,
      createdBy: actorId,
    });
  });
}

/** Helper: count audit rows for an entity+action in org. */
async function countAuditRows(
  db: PgliteTestClient,
  orgId: string,
  action: string,
): Promise<number> {
  const result = await withOrgContext(db, orgId, (tx) =>
    tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action))),
  );
  return result.length;
}

/** Fake balance seam that always returns below_minimum. */
const fakeBelowMinimumSeam: BalanceSeam = {
  async check(_req: BalanceCheckRequest): Promise<BalanceCheckResult> {
    return { ok: false, reason: 'below_minimum' };
  },
};

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

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1 — getResourceRequiredTags
// ════════════════════════════════════════════════════════════════════════════════

describe('getResourceRequiredTags', () => {
  it('returns empty list for aircraft with no requirements', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId } = await seedAircraftAndReservation(db, orgAId, userAId, 'GGET1');
    const result = await getResourceRequiredTagsWithDb(db, sess, { resourceId: aircraftId });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tags).toHaveLength(0);
  });

  it('returns not_found for unknown resourceId', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const result = await getResourceRequiredTagsWithDb(db, sess, {
      resourceId: '00000000-0000-0000-0000-000000000099',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('returns not_found for cross-org resourceId (tenant isolation)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessB = makeSession(orgBId, userBId, 'owner');
    // Create an aircraft in org A
    const { aircraftId } = await seedAircraftAndReservation(db, orgAId, userAId, 'GISO1');
    // Query from org B — should not_found
    const result = await getResourceRequiredTagsWithDb(db, sessB, { resourceId: aircraftId });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('returns not_found for non-aircraft resource kind', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    // Create a non-aircraft resource (instructor) — kind != 'aircraft'
    const instr = await createResourceWithDb(db, sess, {
      kind: 'instructor',
      displayName: 'Gate Instructor',
      instructorUserId: userAId,
    });
    const result = await getResourceRequiredTagsWithDb(db, sess, { resourceId: instr.id });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('authz: null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(
      getResourceRequiredTagsWithDb(db, null, { resourceId: '00000000-0000-0000-0000-000000000001' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('authz: renter role (no dispatch:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(
      getResourceRequiredTagsWithDb(db, sess, { resourceId: '00000000-0000-0000-0000-000000000001' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2 — addResourceRequiredTag
// ════════════════════════════════════════════════════════════════════════════════

describe('addResourceRequiredTag', () => {
  it('happy path: adds a tag, returns fresh list + one audit row', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId } = await seedAircraftAndReservation(db, orgAId, userAId, 'GADD1');

    const before = await countAuditRows(db, orgAId, 'dispatch.requirement_added');

    const result = await addResourceRequiredTagWithDb(db, sess, {
      resourceId: aircraftId,
      requiredTag: 'PPL',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tags).toHaveLength(1);
      expect(result.tags[0]?.requiredTag).toBe('PPL');
      expect(result.tags[0]?.createdBy).toBe(userAId);
    }

    const after = await countAuditRows(db, orgAId, 'dispatch.requirement_added');
    expect(after - before).toBe(1);
  });

  it('trims whitespace from tag before insert', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId } = await seedAircraftAndReservation(db, orgAId, userAId, 'GADD2');

    const result = await addResourceRequiredTagWithDb(db, sess, {
      resourceId: aircraftId,
      requiredTag: '  IFR  ',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tags[0]?.requiredTag).toBe('IFR');
  });

  it('empty tag after trim → ValidationError (thrown)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId } = await seedAircraftAndReservation(db, orgAId, userAId, 'GADD3');

    await expect(
      addResourceRequiredTagWithDb(db, sess, { resourceId: aircraftId, requiredTag: '   ' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('duplicate tag on same aircraft → returned duplicate (not thrown)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId } = await seedAircraftAndReservation(db, orgAId, userAId, 'GADD4');

    await addResourceRequiredTagWithDb(db, sess, { resourceId: aircraftId, requiredTag: 'MULTI' });
    const result = await addResourceRequiredTagWithDb(db, sess, {
      resourceId: aircraftId,
      requiredTag: 'MULTI',
    });

    expect(result).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('non-aircraft resource → not_found', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    // Use an instructor resource (not aircraft)
    const instr = await createResourceWithDb(db, sess, {
      kind: 'instructor',
      displayName: 'Gate Instructor 2',
      instructorUserId: userAId,
    });
    const result = await addResourceRequiredTagWithDb(db, sess, {
      resourceId: instr.id,
      requiredTag: 'PPL',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('cross-org resourceId → not_found (tenant isolation)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessB = makeSession(orgBId, userBId, 'owner');
    const { aircraftId } = await seedAircraftAndReservation(db, orgAId, userAId, 'GISO2');
    const result = await addResourceRequiredTagWithDb(db, sessB, {
      resourceId: aircraftId,
      requiredTag: 'PPL',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('authz: cfi role (no dispatch:manage_requirements) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'cfi');
    await expect(
      addResourceRequiredTagWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        requiredTag: 'PPL',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('authz: dispatcher role (has dispatch:manage_requirements) → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'dispatcher');
    // Will get not_found (bogus resource) but must not throw ForbiddenError
    const result = await addResourceRequiredTagWithDb(db, sess, {
      resourceId: '00000000-0000-0000-0000-000000000001',
      requiredTag: 'PPL',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('duplicate add does NOT produce an audit row', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId } = await seedAircraftAndReservation(db, orgAId, userAId, 'GADD5');

    await addResourceRequiredTagWithDb(db, sess, { resourceId: aircraftId, requiredTag: 'AUDIT_DUP' });
    const beforeDup = await countAuditRows(db, orgAId, 'dispatch.requirement_added');
    await addResourceRequiredTagWithDb(db, sess, { resourceId: aircraftId, requiredTag: 'AUDIT_DUP' });
    const afterDup = await countAuditRows(db, orgAId, 'dispatch.requirement_added');
    expect(afterDup).toBe(beforeDup); // no new audit row for duplicate
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3 — removeResourceRequiredTag
// ════════════════════════════════════════════════════════════════════════════════

describe('removeResourceRequiredTag', () => {
  it('happy path: removes a tag, returns fresh list + one audit row', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId } = await seedAircraftAndReservation(db, orgAId, userAId, 'GREM1');

    // Add two tags
    await addResourceRequiredTagWithDb(db, sess, { resourceId: aircraftId, requiredTag: 'TagX' });
    const addResult = await addResourceRequiredTagWithDb(db, sess, {
      resourceId: aircraftId,
      requiredTag: 'TagY',
    });
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) throw new Error('setup failed');
    const tagXRow = addResult.ok ? addResult.tags.find((t) => t.requiredTag === 'TagX') : undefined;
    expect(tagXRow).toBeDefined();
    const tagXId = tagXRow!.id;

    const beforeRemove = await countAuditRows(db, orgAId, 'dispatch.requirement_removed');

    const result = await removeResourceRequiredTagWithDb(db, sess, {
      resourceId: aircraftId,
      requirementId: tagXId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tags.map((t) => t.requiredTag)).not.toContain('TagX');
      expect(result.tags.map((t) => t.requiredTag)).toContain('TagY');
    }

    const afterRemove = await countAuditRows(db, orgAId, 'dispatch.requirement_removed');
    expect(afterRemove - beforeRemove).toBe(1);
  });

  it('unknown requirementId → not_found (returned)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId } = await seedAircraftAndReservation(db, orgAId, userAId, 'GREM2');

    const result = await removeResourceRequiredTagWithDb(db, sess, {
      resourceId: aircraftId,
      requirementId: '00000000-0000-0000-0000-000000000099',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('cross-org requirementId → not_found (tenant isolation)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');

    const { aircraftId } = await seedAircraftAndReservation(db, orgAId, userAId, 'GISO3');
    const addResult = await addResourceRequiredTagWithDb(db, sessA, {
      resourceId: aircraftId,
      requiredTag: 'CrossOrgTag',
    });
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) throw new Error('setup');
    const reqId = addResult.tags[0]!.id;

    // Org B tries to remove org A's requirement
    const result = await removeResourceRequiredTagWithDb(db, sessB, {
      resourceId: aircraftId,
      requirementId: reqId,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('authz: cfi → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'cfi');
    await expect(
      removeResourceRequiredTagWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        requirementId: '00000000-0000-0000-0000-000000000002',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('not_found remove produces zero audit rows', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId } = await seedAircraftAndReservation(db, orgAId, userAId, 'GREM3');

    const before = await countAuditRows(db, orgAId, 'dispatch.requirement_removed');
    await removeResourceRequiredTagWithDb(db, sess, {
      resourceId: aircraftId,
      requirementId: '00000000-0000-0000-0000-000000000099',
    });
    const after = await countAuditRows(db, orgAId, 'dispatch.requirement_removed');
    expect(after).toBe(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4 — getDispatchConfig
// ════════════════════════════════════════════════════════════════════════════════

describe('getDispatchConfig', () => {
  it('returns defaults when no config row exists', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const config = await getDispatchConfigWithDb(db, sess);
    expect(config.eligibilityMode).toBe('block');
    expect(config.balanceCheckEnabled).toBe(false);
  });

  it('authz: accountant (no dispatch:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'accountant');
    await expect(getDispatchConfigWithDb(db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5 — updateDispatchConfig
// ════════════════════════════════════════════════════════════════════════════════

describe('updateDispatchConfig', () => {
  it('creates config row and returns updated values + one audit row', async () => {
    const { db, orgBId, userBId } = sharedEnv;
    const sess = makeSession(orgBId, userBId, 'owner');

    const beforeAudit = await countAuditRows(db, orgBId, 'dispatch.config_updated');

    const result = await updateDispatchConfigWithDb(db, sess, { eligibilityMode: 'warn' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.eligibilityMode).toBe('warn');
      expect(result.config.balanceCheckEnabled).toBe(false); // preserved default
    }

    const afterAudit = await countAuditRows(db, orgBId, 'dispatch.config_updated');
    expect(afterAudit - beforeAudit).toBe(1);
  });

  it('second update (upsert) preserves the unprovided field', async () => {
    const { db, orgBId, userBId } = sharedEnv;
    const sess = makeSession(orgBId, userBId, 'owner');

    // First: set both
    await updateDispatchConfigWithDb(db, sess, { eligibilityMode: 'warn', balanceCheckEnabled: true });
    // Second: only change mode, balance should be preserved
    const result = await updateDispatchConfigWithDb(db, sess, { eligibilityMode: 'block' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.eligibilityMode).toBe('block');
      expect(result.config.balanceCheckEnabled).toBe(true); // preserved
    }
  });

  it('audit metadata does NOT contain any dollar value', async () => {
    const { db, orgBId, userBId } = sharedEnv;
    const sess = makeSession(orgBId, userBId, 'owner');

    await updateDispatchConfigWithDb(db, sess, { eligibilityMode: 'warn' });

    // Fetch the last audit row for config_updated in orgB
    const rows = await withOrgContext(db, orgBId, (tx) =>
      tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgBId), eq(auditLog.action, 'dispatch.config_updated'))),
    );

    expect(rows.length).toBeGreaterThan(0);
    const meta = JSON.stringify(rows[rows.length - 1]!.metadata);
    // No dollar/money/amount/minimum/stripe fields
    expect(meta).not.toMatch(/dollar|amount|minimum|stripe|balance_minimum|price/i);
  });

  it('invalid eligibilityMode value → ValidationError (thrown)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      updateDispatchConfigWithDb(db, sess, { eligibilityMode: 'invalid' as 'block' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('authz: cfi → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'cfi');
    await expect(
      updateDispatchConfigWithDb(db, sess, { eligibilityMode: 'warn' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 6 — openDispatch eligibility arm
// ════════════════════════════════════════════════════════════════════════════════

describe('openDispatch eligibility gate', () => {
  it('no requirements → ok (byte-identical happy path, no pilot-tag query needed)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db, orgAId, userAId, 'GELI1',
    );

    const result = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 100,
      tachOut: 100,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.eligibilityWarnings).toBeUndefined();
    }
  });

  it('block mode + pilot missing required tag → ineligible (no ticket, no audit)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db, orgAId, userAId, 'GELI2', T.W2_start, T.W2_end,
    );

    // Add requirement to aircraft
    await addResourceRequiredTagWithDb(db, sess, { resourceId: aircraftId, requiredTag: 'PPL' });

    // Set mode to block (default; make explicit)
    await updateDispatchConfigWithDb(db, sess, { eligibilityMode: 'block' });

    const beforeTickets = await withOrgContext(db, orgAId, (tx) =>
      tx.select({ id: dispatchRequirement.id }).from(dispatchRequirement),
    );

    const beforeOpen = await countAuditRows(db, orgAId, 'dispatch.opened');

    const result = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 200,
      tachOut: 200,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ineligible');
      if (result.reason === 'ineligible') {
        expect(result.missingTags).toContain('PPL');
      }
    }

    // No ticket inserted, no audit for dispatch.opened
    const afterOpen = await countAuditRows(db, orgAId, 'dispatch.opened');
    expect(afterOpen).toBe(beforeOpen);
  });

  it('block mode + pilot HAS required tag → ok', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db, orgAId, userAId, 'GELI3',
    );

    // Requirement on aircraft
    await addResourceRequiredTagWithDb(db, sess, { resourceId: aircraftId, requiredTag: 'PPL' });
    // Pilot has the tag
    await seedMemberTag(db, orgAId, userAId, 'PPL', userAId);

    const result = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 300,
      tachOut: 300,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.eligibilityWarnings).toBeUndefined();
  });

  it('warn mode + pilot missing tag → ok + eligibilityWarnings (no blocking)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db, orgAId, userAId, 'GELI4',
    );

    // Requirement on aircraft
    await addResourceRequiredTagWithDb(db, sess, { resourceId: aircraftId, requiredTag: 'ATP' });

    // Set warn mode
    await updateDispatchConfigWithDb(db, sess, { eligibilityMode: 'warn' });

    const result = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 400,
      tachOut: 400,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.eligibilityWarnings).toEqual(['ATP']);
    }

    // Ticket WAS inserted (warn mode allows through)
    const afterOpen = await countAuditRows(db, orgAId, 'dispatch.opened');
    expect(afterOpen).toBeGreaterThan(0);
  });

  it('case-sensitive: tag "mycert" does NOT satisfy requirement "MyCERT"', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db, orgAId, userAId, 'GELI5',
    );

    // Require the mixed-case form
    await addResourceRequiredTagWithDb(db, sess, { resourceId: aircraftId, requiredTag: 'MyCERT' });
    await updateDispatchConfigWithDb(db, sess, { eligibilityMode: 'block' });
    // Pilot has all-lowercase form (different string — case-sensitive mismatch)
    await seedMemberTag(db, orgAId, userAId, 'mycert', userAId);

    const result = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 500,
      tachOut: 500,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ineligible');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 7 — openDispatch balance arm
// ════════════════════════════════════════════════════════════════════════════════

describe('openDispatch balance gate', () => {
  it('flag off → balance seam NOT consulted (stub ok with flag off)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db, orgAId, userAId, 'GBAL1',
    );
    // Ensure flag is off (default)
    await updateDispatchConfigWithDb(db, sess, { balanceCheckEnabled: false });

    // Use a fake seam that would return below_minimum — but flag is off so it shouldn't be called
    let seamCalled = false;
    const trackingSeam: BalanceSeam = {
      async check(_req): Promise<BalanceCheckResult> {
        seamCalled = true;
        return { ok: false, reason: 'below_minimum' };
      },
    };

    const result = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 600,
      tachOut: 600,
    }, trackingSeam);

    expect(seamCalled).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('flag on + stub → ok (Phase 1: stub always returns ok)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db, orgAId, userAId, 'GBAL2',
    );
    // Enable flag
    await updateDispatchConfigWithDb(db, sess, { balanceCheckEnabled: true });

    // Uses default stubBalanceSeam (always ok)
    const result = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 700,
      tachOut: 700,
    });

    expect(result.ok).toBe(true);
  });

  it('flag on + fake seam returning below_minimum → balance_block (no ticket, no audit)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db, orgAId, userAId, 'GBAL3',
    );
    // Enable flag
    await updateDispatchConfigWithDb(db, sess, { balanceCheckEnabled: true });

    const beforeOpen = await countAuditRows(db, orgAId, 'dispatch.opened');

    const result = await openDispatchWithDb(
      db,
      sess,
      {
        reservationId,
        resourceId: aircraftId,
        pilotUserId: userAId,
        hobbsOut: 800,
        tachOut: 800,
      },
      fakeBelowMinimumSeam,
    );

    expect(result).toEqual({ ok: false, reason: 'balance_block' });

    // No ticket inserted, no dispatch.opened audit
    const afterOpen = await countAuditRows(db, orgAId, 'dispatch.opened');
    expect(afterOpen).toBe(beforeOpen);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Grounded PRECEDES ineligible
// ════════════════════════════════════════════════════════════════════════════════

describe('grounded precedes eligibility check', () => {
  it('grounded aircraft + unmet requirement → returns grounded (not ineligible)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db, orgAId, userAId, 'GGRD1',
    );

    // Add a requirement the pilot does NOT satisfy
    await addResourceRequiredTagWithDb(db, sess, { resourceId: aircraftId, requiredTag: 'ATP' });
    await updateDispatchConfigWithDb(db, sess, { eligibilityMode: 'block' });

    // Ground the aircraft
    const groundResult = await groundAircraftWithDb(db, sess, {
      resourceId: aircraftId,
      reason: 'Scheduled maintenance',
    });
    expect(groundResult.ok).toBe(true);

    // openDispatch should return 'grounded' (not 'ineligible')
    const result = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 900,
      tachOut: 900,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('grounded');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 9 — Tenant isolation for pilot tags
// ════════════════════════════════════════════════════════════════════════════════

describe('tenant isolation: pilot tags never cross orgs', () => {
  it('pilot tag in orgB does NOT satisfy requirement in orgA', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');

    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db, orgAId, userAId, 'GTEN1',
    );

    // Unique requirement tag that userA in orgA definitely does not hold
    const ISOLATION_TAG = 'TENANT_ISOLATION_XYZ_UNIQUE_TAG_9273';

    // Requirement on org A aircraft
    await addResourceRequiredTagWithDb(db, sessA, { resourceId: aircraftId, requiredTag: ISOLATION_TAG });
    await updateDispatchConfigWithDb(db, sessA, { eligibilityMode: 'block' });

    // Give the tag ONLY to userB in orgB (different org — must NOT bleed through to orgA)
    await seedMemberTag(db, orgBId, userBId, ISOLATION_TAG, userBId);

    // Attempt to dispatch with orgA's pilot (userA) who has NO such tag in orgA
    const result = await openDispatchWithDb(db, sessA, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 1000,
      tachOut: 1000,
    });

    // userA in orgA has no ISOLATION_TAG → ineligible (orgB tag did NOT bleed through)
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ineligible');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Audit exactness
// ════════════════════════════════════════════════════════════════════════════════

describe('audit exactness', () => {
  it('one audit row per addResourceRequiredTag, zero for refusals', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId } = await seedAircraftAndReservation(db, orgAId, userAId, 'GAUD1');

    const before = await countAuditRows(db, orgAId, 'dispatch.requirement_added');

    // Successful add
    await addResourceRequiredTagWithDb(db, sess, { resourceId: aircraftId, requiredTag: 'AuditTag1' });
    expect(await countAuditRows(db, orgAId, 'dispatch.requirement_added')).toBe(before + 1);

    // Duplicate add — no new audit row
    await addResourceRequiredTagWithDb(db, sess, { resourceId: aircraftId, requiredTag: 'AuditTag1' });
    expect(await countAuditRows(db, orgAId, 'dispatch.requirement_added')).toBe(before + 1);
  });

  it('ineligible openDispatch writes zero audit rows', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db, orgAId, userAId, 'GAUD2',
    );
    await addResourceRequiredTagWithDb(db, sess, { resourceId: aircraftId, requiredTag: 'AUDIT_INELIGIBLE' });
    await updateDispatchConfigWithDb(db, sess, { eligibilityMode: 'block' });

    const beforeOpen = await countAuditRows(db, orgAId, 'dispatch.opened');
    await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 1100,
      tachOut: 1100,
    });
    expect(await countAuditRows(db, orgAId, 'dispatch.opened')).toBe(beforeOpen);
  });

  it('balance_block openDispatch writes zero audit rows', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      db, orgAId, userAId, 'GAUD3',
    );
    await updateDispatchConfigWithDb(db, sess, { balanceCheckEnabled: true });

    const beforeOpen = await countAuditRows(db, orgAId, 'dispatch.opened');
    await openDispatchWithDb(
      db,
      sess,
      {
        reservationId,
        resourceId: aircraftId,
        pilotUserId: userAId,
        hobbsOut: 1200,
        tachOut: 1200,
      },
      fakeBelowMinimumSeam,
    );
    expect(await countAuditRows(db, orgAId, 'dispatch.opened')).toBe(beforeOpen);
  });
});
