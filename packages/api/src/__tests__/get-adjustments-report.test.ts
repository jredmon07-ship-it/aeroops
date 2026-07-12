/**
 * get-adjustments-report.test.ts — Integration tests for getAdjustmentsReport.
 *
 * Applies migrations 0000–0040 via the shared loader.
 *
 * COVERAGE:
 *   CAPS: billing:access required. accountant passes; dispatcher / renter ⇒
 *     Forbidden; null ⇒ Unauthenticated.
 *   HAPPY: one row per credit_memo/adjustment; type + direction + memo + who
 *     surfaced; a 'payment' entry is NOT included; totalCredit/totalDebit math.
 *   T-ISO: org-A session never sees an org-B correction; org B sees only its own.
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

import { getAdjustmentsReportWithDb } from '../billing/get-adjustments-report.js';
import { issueCreditMemoWithDb, issueAdjustmentWithDb } from '../billing/issue-ledger-adjustment.js';
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

  // ── Org A ── a credit memo + a debit adjustment + a payment (must be excluded).
  memberA = await seedMember(db, env.orgAId, 'CorrA', 'renter');
  const sessA = makeSession(env.orgAId, env.userAId, 'owner');

  const cm = await issueCreditMemoWithDb(db, sessA, {
    memberUserId: memberA,
    amountCents: 5_000,
    memo: 'overcharge refund',
  });
  if (!cm.ok) throw new Error('credit memo failed');

  const adj = await issueAdjustmentWithDb(db, sessA, {
    memberUserId: memberA,
    amountCents: 1_200,
    direction: 'debit',
    memo: 'late fee correction',
  });
  if (!adj.ok) throw new Error('adjustment failed');

  // A payment — must NOT appear in the adjustments report.
  const pay = await recordManualPaymentWithDb(db, sessA, {
    memberUserId: memberA,
    amountCents: 7_777,
    methodNote: 'NOT-A-CORRECTION',
  });
  if (!pay.ok) throw new Error('payment failed');

  // ── Org B ── one adjustment (isolation fixture).
  memberB = await seedMember(db, env.orgBId, 'CorrB', 'renter');
  const sessB = makeSession(env.orgBId, env.userBId, 'owner');
  const adjB = await issueAdjustmentWithDb(db, sessB, {
    memberUserId: memberB,
    amountCents: 42_000,
    direction: 'credit',
    memo: 'B-only goodwill credit',
  });
  if (!adjB.ok) throw new Error('adjustment B failed');
}, 180_000);

// ════════════════════════════════════════════════════════════════════════════════
// CAPS
// ════════════════════════════════════════════════════════════════════════════════

describe('caps', () => {
  it('null session ⇒ Unauthenticated', async () => {
    await expect(getAdjustmentsReportWithDb(env.db, null, { range: '30d' })).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('accountant (billing:access) ⇒ allowed', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const r = await getAdjustmentsReportWithDb(env.db, sess, { range: '30d' });
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('dispatcher (no billing:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(getAdjustmentsReportWithDb(env.db, sess, { range: '30d' })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('renter (no billing:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(getAdjustmentsReportWithDb(env.db, sess, { range: '30d' })).rejects.toThrow(
      ForbiddenError,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// HAPPY PATH
// ════════════════════════════════════════════════════════════════════════════════

describe('getAdjustmentsReport — org A', () => {
  it('rows for credit_memo + adjustment only (payment excluded); totals by direction', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getAdjustmentsReportWithDb(env.db, sess, { range: '30d' });

    expect(r.count).toBe(2);
    expect(r.rows.some((row) => row.entryType === 'credit_memo')).toBe(true);
    expect(r.rows.some((row) => row.entryType === 'adjustment')).toBe(true);
    // A 'payment' must never leak into the correction report.
    expect(r.rows.some((row) => row.memo === 'NOT-A-CORRECTION' || (row.amountCents as number) === 7_777)).toBe(false);

    // credit_memo is a credit ($50.00); adjustment is a debit ($12.00).
    expect(r.totalCreditCents).toBe(5_000);
    expect(r.totalDebitCents).toBe(1_200);

    const cm = r.rows.find((row) => row.entryType === 'credit_memo')!;
    expect(cm.direction).toBe('credit');
    expect(cm.memo).toBe('overcharge refund');
    // "who" resolves to the acting owner's name/email.
    expect(cm.createdByName).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// TENANT ISOLATION
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO', () => {
  it('org-A session never sees the org-B correction', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getAdjustmentsReportWithDb(env.db, sess, { range: '30d' });
    expect(r.rows.some((row) => row.memberUserId === memberB)).toBe(false);
    expect(r.rows.some((row) => row.memo === 'B-only goodwill credit')).toBe(false);
    expect(r.totalCreditCents).toBe(5_000);
  });

  it('org-B session sees only its own correction', async () => {
    const sess = makeSession(env.orgBId, env.userBId, 'owner');
    const r = await getAdjustmentsReportWithDb(env.db, sess, { range: '30d' });
    expect(r.count).toBe(1);
    expect(r.rows[0]!.memo).toBe('B-only goodwill credit');
    expect(r.totalCreditCents).toBe(42_000);
    expect(r.totalDebitCents).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════════════════════

describe('validation', () => {
  it('bad range key ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(getAdjustmentsReportWithDb(env.db, sess, { range: 'nope' })).rejects.toThrow(
      ValidationError,
    );
  });
});
