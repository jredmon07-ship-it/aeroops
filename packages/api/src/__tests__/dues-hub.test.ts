/**
 * dues-hub.test.ts — org-level recurring-billing hub (listOrgDuesSchedules +
 * applyStandardDuesSchedule, migration 0050).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  appUser,
  membership,
  loadMigrationSql,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { createDuesScheduleWithDb } from '../billing/dues-schedule-commands.js';
import { listOrgDuesSchedulesWithDb } from '../billing/list-org-dues-schedules.js';
import { applyStandardDuesScheduleWithDb } from '../billing/apply-standard-dues.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

const MIGRATION_SQL = loadMigrationSql('0050');

interface Env {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  userAId: string;
  orgBId: string;
  userBId: string;
}
function makeSession(orgId: string, userId: string, role: AppSession['role'] = 'owner'): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

let tag = 0;
async function seedMember(db: PgliteTestClient, orgId: string, name: string): Promise<string> {
  tag += 1;
  const rows = await withOrgContext(db, orgId, (tx) =>
    tx.insert(appUser).values({ orgId, email: `hub${tag}@example.test`, fullName: name }).returning({ id: appUser.id }),
  );
  const id = rows[0]!.id;
  await withOrgContext(db, orgId, (tx) => tx.insert(membership).values({ orgId, userId: id, role: 'renter' }));
  return id;
}

let env: Env;
beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });
  env = { db, pglite, orgAId: seed.orgAId, userAId: seed.userAId, orgBId: seed.orgBId, userBId: seed.userBId };
}, 120_000);

describe('listOrgDuesSchedules', () => {
  it('lists active schedules across the org with member names, tenant-isolated', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const zoe = await seedMember(env.db, env.orgAId, 'Zoe Aviator');
    const amy = await seedMember(env.db, env.orgAId, 'Amy Pilot');
    await createDuesScheduleWithDb(env.db, sess, { memberUserId: zoe, amountCents: 13000, dayOfMonth: 1, memo: 'Dues' });
    await createDuesScheduleWithDb(env.db, sess, {
      memberUserId: amy,
      amountCents: 60000,
      dayOfMonth: 1,
      cadence: 'annual',
      anchorMonth: 7,
    });

    // Another org's schedule must NOT appear.
    const sessB = makeSession(env.orgBId, env.userBId);
    const otherMember = await seedMember(env.db, env.orgBId, 'Other Org Member');
    await createDuesScheduleWithDb(env.db, sessB, { memberUserId: otherMember, amountCents: 9900, dayOfMonth: 1 });

    const res = await listOrgDuesSchedulesWithDb(env.db, sess);
    const names = res.schedules.map((s) => s.memberName);
    expect(names).toContain('Amy Pilot');
    expect(names).toContain('Zoe Aviator');
    expect(names).not.toContain('Other Org Member');
    // Sorted by member name; the annual one carries its cadence + anchor.
    const amySched = res.schedules.find((s) => s.memberName === 'Amy Pilot');
    expect(amySched?.cadence).toBe('annual');
    expect(amySched?.anchorMonth).toBe(7);
  });

  it('billing:access is required', async () => {
    await expect(
      listOrgDuesSchedulesWithDb(env.db, makeSession(env.orgAId, env.userAId, 'mechanic')),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('applyStandardDuesSchedule', () => {
  it('creates a schedule for every active member without one, and is idempotent', async () => {
    // Fresh org via the second seed org to avoid cross-test coupling.
    const bulk = await createTestClient();
    await applyMigrationSql({ pglite: bulk.pglite }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(bulk.db);
    await setTestAppRole({ pglite: bulk.pglite });
    const sess = makeSession(seed.orgAId, seed.userAId);

    // seedTwoOrgs gives org A one owner user; add two more members.
    tag += 100;
    const m1 = await (async () => {
      const rows = await withOrgContext(bulk.db, seed.orgAId, (tx) =>
        tx.insert(appUser).values({ orgId: seed.orgAId, email: 'b1@x.test', fullName: 'Bulk One' }).returning({ id: appUser.id }),
      );
      const id = rows[0]!.id;
      await withOrgContext(bulk.db, seed.orgAId, (tx) => tx.insert(membership).values({ orgId: seed.orgAId, userId: id, role: 'renter' }));
      return id;
    })();
    void m1;
    await withOrgContext(bulk.db, seed.orgAId, async (tx) => {
      const rows = await tx.insert(appUser).values({ orgId: seed.orgAId, email: 'b2@x.test', fullName: 'Bulk Two' }).returning({ id: appUser.id });
      await tx.insert(membership).values({ orgId: seed.orgAId, userId: rows[0]!.id, role: 'renter' });
    });

    const first = await applyStandardDuesScheduleWithDb(bulk.db, sess, {
      amountCents: 12000,
      dayOfMonth: 1,
      memo: 'Standard dues',
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.createdCount).toBeGreaterThanOrEqual(2);

    // Re-running assigns nobody new (idempotent) and now reports them as skipped.
    const second = await applyStandardDuesScheduleWithDb(bulk.db, sess, {
      amountCents: 12000,
      dayOfMonth: 1,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.createdCount).toBe(0);
      expect(second.skippedExistingCount).toBeGreaterThanOrEqual(2);
    }

    const list = await listOrgDuesSchedulesWithDb(bulk.db, sess);
    expect(list.schedules.length).toBeGreaterThanOrEqual(2);
  });

  it('billing:manage required; refuses non-monthly without an anchor', async () => {
    await expect(
      applyStandardDuesScheduleWithDb(env.db, makeSession(env.orgAId, env.userAId, 'accountant'), {
        amountCents: 100,
        dayOfMonth: 1,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      applyStandardDuesScheduleWithDb(env.db, makeSession(env.orgAId, env.userAId), {
        amountCents: 100,
        dayOfMonth: 1,
        cadence: 'annual',
      }),
    ).rejects.toThrow();
  });
});
