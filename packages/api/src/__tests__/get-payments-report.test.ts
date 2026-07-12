/**
 * get-payments-report.test.ts — Integration tests for getPaymentsReport.
 *
 * Applies migrations 0000–0040 via the shared loader.
 *
 * COVERAGE:
 *   CAPS: billing:access required. accountant passes; dispatcher / renter ⇒
 *     Forbidden; null ⇒ Unauthenticated.
 *   HAPPY: one row per 'payment' credit; amount + reference (paymentId/memo)
 *     surfaced; newest-first; totalPaymentCents + paymentCount math.
 *   T-ISO: org-A session never sees an org-B payment; org B sees only its own.
 *   VALIDATION: a bad range key ⇒ ValidationError.
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

import { getPaymentsReportWithDb } from '../billing/get-payments-report.js';
import { recordManualPaymentWithDb } from '../billing/record-manual-payment.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';
import type { MembershipRole } from '@aeroops/core';

const MIGRATION_SQL = loadMigrationSql('0040');

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
}

function makeSession(orgId: string, userId: string, role: AppSession['role'] = 'owner'): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

let env: TestEnv;
let memberSuffix = 0;

async function seedMember(
  db: PgliteTestClient,
  orgId: string,
  tag: string,
  role: MembershipRole,
): Promise<string> {
  memberSuffix += 1;
  const label = `${tag}${memberSuffix}`;
  const rows = await withOrgContext(db, orgId, (tx) =>
    tx
      .insert(appUser)
      .values({ orgId, email: `${label.toLowerCase()}@example.test`, fullName: `Member ${label}` })
      .returning({ id: appUser.id }),
  );
  const row = rows[0];
  if (!row) throw new Error('seedMember: INSERT returned no row');
  await withOrgContext(db, orgId, (tx) => tx.insert(membership).values({ orgId, userId: row.id, role }));
  return row.id;
}

let memberA = '';
let memberB = '';

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

  // ── Org A ── two payments to one member.
  memberA = await seedMember(db, env.orgAId, 'PayerA', 'renter');
  const sessA = makeSession(env.orgAId, env.userAId, 'owner');
  const p1 = await recordManualPaymentWithDb(db, sessA, {
    memberUserId: memberA,
    amountCents: 10_000,
    methodNote: 'CHK-1001',
  });
  if (!p1.ok) throw new Error('payment 1 failed');
  const p2 = await recordManualPaymentWithDb(db, sessA, {
    memberUserId: memberA,
    amountCents: 2_550,
    memo: 'cash at desk',
  });
  if (!p2.ok) throw new Error('payment 2 failed');

  // ── Org B ── one payment (isolation fixture).
  memberB = await seedMember(db, env.orgBId, 'PayerB', 'renter');
  const sessB = makeSession(env.orgBId, env.userBId, 'owner');
  const pB = await recordManualPaymentWithDb(db, sessB, {
    memberUserId: memberB,
    amountCents: 99_900,
    methodNote: 'B-ONLY',
  });
  if (!pB.ok) throw new Error('payment B failed');
}, 180_000);

// ════════════════════════════════════════════════════════════════════════════════
// CAPS
// ════════════════════════════════════════════════════════════════════════════════

describe('caps', () => {
  it('null session ⇒ Unauthenticated', async () => {
    await expect(getPaymentsReportWithDb(env.db, null, { range: '30d' })).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('accountant (billing:access) ⇒ allowed', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const r = await getPaymentsReportWithDb(env.db, sess, { range: '30d' });
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('dispatcher (no billing:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(getPaymentsReportWithDb(env.db, sess, { range: '30d' })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('renter (no billing:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(getPaymentsReportWithDb(env.db, sess, { range: '30d' })).rejects.toThrow(
      ForbiddenError,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// HAPPY PATH
// ════════════════════════════════════════════════════════════════════════════════

describe('getPaymentsReport — org A', () => {
  it('one row per payment; amount + reference surfaced; totals + count', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getPaymentsReportWithDb(env.db, sess, { range: '30d' });

    expect(r.rows.length).toBe(2);
    expect(r.paymentCount).toBe(2);
    expect(r.totalPaymentCents).toBe(12_550);

    const amounts = r.rows.map((row) => row.amountCents).sort((a, b) => a - b);
    expect(amounts).toEqual([2_550, 10_000]);

    const byRef = new Map(r.rows.map((row) => [row.paymentId ?? row.memo, row]));
    expect(byRef.get('CHK-1001')!.amountCents).toBe(10_000);
    expect(byRef.get('cash at desk')!.amountCents).toBe(2_550);

    // Member name resolves.
    expect(r.rows.every((row) => row.memberName.startsWith('Member PayerA'))).toBe(true);
  });

  it('newest-first ordering', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getPaymentsReportWithDb(env.db, sess, { range: '30d' });
    for (let i = 1; i < r.rows.length; i++) {
      expect(r.rows[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(r.rows[i]!.createdAt.getTime());
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// TENANT ISOLATION
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO', () => {
  it('org-A session never sees the org-B payment', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getPaymentsReportWithDb(env.db, sess, { range: '30d' });
    expect(r.rows.some((row) => row.paymentId === 'B-ONLY')).toBe(false);
    expect(r.rows.some((row) => row.memberUserId === memberB)).toBe(false);
    expect(r.totalPaymentCents).toBe(12_550);
  });

  it('org-B session sees only its own payment', async () => {
    const sess = makeSession(env.orgBId, env.userBId, 'owner');
    const r = await getPaymentsReportWithDb(env.db, sess, { range: '30d' });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.paymentId).toBe('B-ONLY');
    expect(r.totalPaymentCents).toBe(99_900);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════════════════════

describe('validation', () => {
  it('bad range key ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(getPaymentsReportWithDb(env.db, sess, { range: 'last-week' })).rejects.toThrow(
      ValidationError,
    );
  });
});
