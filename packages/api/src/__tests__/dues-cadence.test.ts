/**
 * dues-cadence.test.ts — cadence extension of the recurring-dues engine
 * (migration 0050: quarterly / semiannual / annual + anchor_month).
 *
 * env0050 — migrations through 0050 (cadence live).
 * envAbsent — through 0049 (anchor_month absent → only monthly; non-monthly
 *             create refused; monthly billing byte-identical).
 *
 * Money invariant preserved: a MONTHLY schedule bills in every period exactly
 * as before this slice; non-monthly schedules bill only in their due months,
 * and the period_key stays "YYYY-MM" so dues_run idempotency is unchanged.
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
import { generateDuesInvoicesWithDb } from '../billing/generate-dues-invoices.js';
import type { AppSession } from '../auth/types.js';

const MIGRATION_SQL_0050 = loadMigrationSql('0050');
const MIGRATION_SQL_0049 = loadMigrationSql('0049');

interface Env {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  userAId: string;
}
function makeSession(orgId: string, userId: string, role: AppSession['role'] = 'owner'): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

let tag = 0;
async function seedMember(db: PgliteTestClient, orgId: string): Promise<string> {
  tag += 1;
  const rows = await withOrgContext(db, orgId, (tx) =>
    tx.insert(appUser).values({ orgId, email: `cad${tag}@example.test`, fullName: `Cad ${tag}` }).returning({ id: appUser.id }),
  );
  const id = rows[0]!.id;
  await withOrgContext(db, orgId, (tx) => tx.insert(membership).values({ orgId, userId: id, role: 'renter' }));
  return id;
}

describe('dues cadence (migration 0050 applied)', () => {
  let env: Env;
  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL_0050);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    env = { db, pglite, orgAId: seed.orgAId, userAId: seed.userAId };
  }, 120_000);

  it('annual dues bill ONLY in the anchor month, once per year', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const member = await seedMember(env.db, env.orgAId);
    const r = await createDuesScheduleWithDb(env.db, sess, {
      memberUserId: member,
      amountCents: 60000,
      dayOfMonth: 1,
      cadence: 'annual',
      anchorMonth: 7,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schedule.cadence).toBe('annual');
      expect(r.schedule.anchorMonth).toBe(7);
    }

    // July: due → created. But other schedules from prior tests may exist; scope
    // to THIS schedule via the created scheduleIds.
    const jul = await generateDuesInvoicesWithDb(env.db, sess, { periodKey: '2026-07' });
    expect(jul.created.some((c) => c.scheduleId === (r.ok ? r.schedule.id : ''))).toBe(true);

    // August: not due → this schedule is skipped, not billed.
    const aug = await generateDuesInvoicesWithDb(env.db, sess, { periodKey: '2026-08' });
    const id = r.ok ? r.schedule.id : '';
    expect(aug.created.some((c) => c.scheduleId === id)).toBe(false);
    expect(aug.skipped.some((s) => s.scheduleId === id && s.reason === 'not_due_this_period')).toBe(true);

    // Re-running July is idempotent for this schedule (already_run, not double-billed).
    const julAgain = await generateDuesInvoicesWithDb(env.db, sess, { periodKey: '2026-07' });
    expect(julAgain.skipped.some((s) => s.scheduleId === id && s.reason === 'already_run')).toBe(true);
  });

  it('quarterly dues bill every 3rd month from the anchor', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const member = await seedMember(env.db, env.orgAId);
    const r = await createDuesScheduleWithDb(env.db, sess, {
      memberUserId: member,
      amountCents: 15000,
      dayOfMonth: 1,
      cadence: 'quarterly',
      anchorMonth: 1, // Jan, Apr, Jul, Oct
    });
    if (!r.ok) throw new Error('create failed');
    const id = r.schedule.id;

    const apr = await generateDuesInvoicesWithDb(env.db, sess, { periodKey: '2026-04' });
    expect(apr.created.some((c) => c.scheduleId === id)).toBe(true);

    const may = await generateDuesInvoicesWithDb(env.db, sess, { periodKey: '2026-05' });
    expect(may.skipped.some((s) => s.scheduleId === id && s.reason === 'not_due_this_period')).toBe(true);
  });

  it('monthly is byte-identical: billed in every month', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const member = await seedMember(env.db, env.orgAId);
    const r = await createDuesScheduleWithDb(env.db, sess, {
      memberUserId: member,
      amountCents: 13000,
      dayOfMonth: 1,
      cadence: 'monthly',
    });
    if (!r.ok) throw new Error('create failed');
    const id = r.schedule.id;
    expect(r.schedule.anchorMonth).toBeNull();

    for (const period of ['2026-02', '2026-03', '2026-11']) {
      const res = await generateDuesInvoicesWithDb(env.db, sess, { periodKey: period });
      expect(res.created.some((c) => c.scheduleId === id)).toBe(true);
    }
  });

  it('rejects a period key with an out-of-range month', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    await expect(generateDuesInvoicesWithDb(env.db, sess, { periodKey: '2026-13' })).rejects.toThrow();
    await expect(generateDuesInvoicesWithDb(env.db, sess, { periodKey: '2026-00' })).rejects.toThrow();
  });

  it('rejects a non-monthly cadence with no anchor (validation)', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const member = await seedMember(env.db, env.orgAId);
    await expect(
      createDuesScheduleWithDb(env.db, sess, {
        memberUserId: member,
        amountCents: 100,
        dayOfMonth: 1,
        cadence: 'annual',
      }),
    ).rejects.toThrow();
  });
});

describe('dues cadence — graceful absence (0050 not applied)', () => {
  let env: Env;
  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL_0049);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    env = { db, pglite, orgAId: seed.orgAId, userAId: seed.userAId };
  }, 120_000);

  it('non-monthly create is refused (cadence_not_available); monthly still works', async () => {
    const sess = makeSession(env.orgAId, env.userAId);
    const member = await seedMember(env.db, env.orgAId);

    const annual = await createDuesScheduleWithDb(env.db, sess, {
      memberUserId: member,
      amountCents: 60000,
      dayOfMonth: 1,
      cadence: 'annual',
      anchorMonth: 7,
    });
    expect(annual).toEqual({ ok: false, reason: 'cadence_not_available' });

    const monthly = await createDuesScheduleWithDb(env.db, sess, {
      memberUserId: member,
      amountCents: 13000,
      dayOfMonth: 1,
      cadence: 'monthly',
    });
    expect(monthly.ok).toBe(true);
    // And it bills every month exactly as before 0050.
    const feb = await generateDuesInvoicesWithDb(env.db, sess, { periodKey: '2026-02' });
    if (monthly.ok) expect(feb.created.some((c) => c.scheduleId === monthly.schedule.id)).toBe(true);
  });
});
