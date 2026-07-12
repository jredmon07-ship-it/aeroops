/**
 * issue-ledger-adjustment.test.ts — Integration tests for the FC-parity
 * credit-memo / adjustment commands (issueCreditMemo / issueAdjustment).
 *
 * Applies migrations 0000–0034 (0034 widens ledger_entry.entry_type to include
 * 'credit_memo' and 'adjustment').
 *
 * COVERAGE:
 *   CAPS: billing:manage required; billing:access-only (accountant) ⇒ Forbidden;
 *     non-billing role ⇒ Forbidden; null session ⇒ Unauthenticated.
 *   CREDIT MEMO: posts ONE 'credit_memo' CREDIT that RAISES the derived balance;
 *     unknown member ⇒ member_not_found; validation on amount (zero/negative/
 *     non-integer/int4-overflow); memo optional.
 *   ADJUSTMENT: debit LOWERS the balance, credit RAISES it; memo REQUIRED
 *     (min 5 chars); unknown member ⇒ member_not_found.
 *   APPEND-ONLY / DERIVED: balance is always recomputed from the ledger, never
 *     stored; a memo + adjustment net correctly against a manual payment.
 *   T-ISO: org B cannot post a credit memo or adjustment against an org A member.
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

import {
  issueCreditMemoWithDb,
  issueAdjustmentWithDb,
} from '../billing/issue-ledger-adjustment.js';
import {
  getMemberBalanceWithDb,
  listLedgerEntriesWithDb,
} from '../billing/ledger-account.js';
import { recordManualPaymentWithDb } from '../billing/record-manual-payment.js';

import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0034 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0034');

// ── Shared test environment ───────────────────────────────────────────────────

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

let env: TestEnv;
let memberSuffix = 0;

/** Insert a fresh app_user + membership in the given org. Returns userId. */
async function seedMember(db: PgliteTestClient, orgId: string, tag: string): Promise<string> {
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
  await withOrgContext(db, orgId, (tx) =>
    tx.insert(membership).values({ orgId, userId: row.id, role: 'renter' }),
  );
  return row.id;
}

async function balanceOf(orgId: string, ownerUserId: string, memberUserId: string): Promise<number> {
  const r = await getMemberBalanceWithDb(env.db, makeSession(orgId, ownerUserId, 'owner'), {
    memberUserId,
  });
  if (!r.ok) throw new Error(`balanceOf: ${r.reason}`);
  return r.balanceCents;
}

// ── Setup ───────────────────────────────────────────────────────────────────

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
}, 120_000);

// ════════════════════════════════════════════════════════════════════════════════
// CAPS
// ════════════════════════════════════════════════════════════════════════════════

describe('caps', () => {
  it('issueCreditMemo: null session ⇒ Unauthenticated', async () => {
    await expect(
      issueCreditMemoWithDb(env.db, null, { memberUserId: env.userAId, amountCents: 1000 }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('issueCreditMemo: accountant (billing:access, no manage) ⇒ Forbidden', async () => {
    const member = await seedMember(env.db, env.orgAId, 'CapCm');
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      issueCreditMemoWithDb(env.db, sess, { memberUserId: member, amountCents: 1000 }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('issueAdjustment: dispatcher (no billing cap) ⇒ Forbidden', async () => {
    const member = await seedMember(env.db, env.orgAId, 'CapAdj');
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(
      issueAdjustmentWithDb(env.db, sess, {
        memberUserId: member,
        amountCents: 1000,
        direction: 'debit',
        memo: 'late fee',
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('issueAdjustment: null session ⇒ Unauthenticated', async () => {
    await expect(
      issueAdjustmentWithDb(env.db, null, {
        memberUserId: env.userAId,
        amountCents: 1000,
        direction: 'credit',
        memo: 'goodwill',
      }),
    ).rejects.toThrow(UnauthenticatedError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// CREDIT MEMO
// ════════════════════════════════════════════════════════════════════════════════

describe('issueCreditMemo', () => {
  it('posts ONE credit_memo CREDIT that raises the balance', async () => {
    const member = await seedMember(env.db, env.orgAId, 'Cm');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');

    const r = await issueCreditMemoWithDb(env.db, sess, {
      memberUserId: member,
      amountCents: 5000,
      memo: 'overcharge correction',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.entryType).toBe('credit_memo');
    expect(r.entry.direction).toBe('credit');
    expect(r.entry.amountCents).toBe(5000);
    expect(r.entry.memo).toBe('overcharge correction');
    expect(r.balanceCentsAfter).toBe(5000);

    expect(await balanceOf(env.orgAId, env.userAId, member)).toBe(5000);

    const entriesR = await listLedgerEntriesWithDb(env.db, sess, { memberUserId: member });
    expect(entriesR.ok).toBe(true);
    if (!entriesR.ok) return;
    expect(entriesR.entries).toHaveLength(1);
    expect(entriesR.entries[0]!.entryType).toBe('credit_memo');
  });

  it('memo is optional', async () => {
    const member = await seedMember(env.db, env.orgAId, 'CmNoMemo');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await issueCreditMemoWithDb(env.db, sess, { memberUserId: member, amountCents: 2500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.memo).toBeNull();
  });

  it('unknown member ⇒ member_not_found (nothing persisted)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await issueCreditMemoWithDb(env.db, sess, {
      memberUserId: '00000000-0000-0000-0000-000000000000',
      amountCents: 1000,
    });
    expect(r).toEqual({ ok: false, reason: 'member_not_found' });
  });

  it('rejects zero / negative / non-integer / overflow amounts', async () => {
    const member = await seedMember(env.db, env.orgAId, 'CmBad');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    for (const amountCents of [0, -100, 12.5, 2_147_483_648]) {
      await expect(
        issueCreditMemoWithDb(env.db, sess, { memberUserId: member, amountCents }),
      ).rejects.toThrow();
    }
    // Nothing was persisted by the failed attempts.
    expect(await balanceOf(env.orgAId, env.userAId, member)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// ADJUSTMENT
// ════════════════════════════════════════════════════════════════════════════════

describe('issueAdjustment', () => {
  it('debit LOWERS the balance', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AdjDebit');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await issueAdjustmentWithDb(env.db, sess, {
      memberUserId: member,
      amountCents: 3000,
      direction: 'debit',
      memo: 'manual late fee assessment',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.entryType).toBe('adjustment');
    expect(r.entry.direction).toBe('debit');
    expect(r.balanceCentsAfter).toBe(-3000);
    expect(await balanceOf(env.orgAId, env.userAId, member)).toBe(-3000);
  });

  it('credit RAISES the balance', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AdjCredit');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await issueAdjustmentWithDb(env.db, sess, {
      memberUserId: member,
      amountCents: 4200,
      direction: 'credit',
      memo: 'goodwill credit for the delay',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.direction).toBe('credit');
    expect(r.balanceCentsAfter).toBe(4200);
  });

  it('memo is REQUIRED (min 5 chars) — short/empty memo throws', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AdjMemo');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      issueAdjustmentWithDb(env.db, sess, {
        memberUserId: member,
        amountCents: 1000,
        direction: 'debit',
        memo: 'x',
      }),
    ).rejects.toThrow();
    await expect(
      issueAdjustmentWithDb(env.db, sess, {
        memberUserId: member,
        amountCents: 1000,
        direction: 'debit',
      }),
    ).rejects.toThrow();
  });

  it('unknown member ⇒ member_not_found', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await issueAdjustmentWithDb(env.db, sess, {
      memberUserId: '00000000-0000-0000-0000-000000000000',
      amountCents: 1000,
      direction: 'credit',
      memo: 'never applied',
    });
    expect(r).toEqual({ ok: false, reason: 'member_not_found' });
  });

  it('a payment, a debit adjustment, and a credit memo net correctly (balance is DERIVED)', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AdjNet');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await recordManualPaymentWithDb(env.db, sess, { memberUserId: member, amountCents: 10000 });
    await issueAdjustmentWithDb(env.db, sess, {
      memberUserId: member,
      amountCents: 2500,
      direction: 'debit',
      memo: 'fuel surcharge correction',
    });
    await issueCreditMemoWithDb(env.db, sess, { memberUserId: member, amountCents: 500, memo: 'rounding' });
    // 10000 - 2500 + 500 = 8000
    expect(await balanceOf(env.orgAId, env.userAId, member)).toBe(8000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T-ISO — tenant isolation
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO — tenant isolation', () => {
  it('org B cannot issue a credit memo against an org A member', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoCmA');
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const r = await issueCreditMemoWithDb(env.db, sessB, { memberUserId: memberA, amountCents: 1000 });
    expect(r).toEqual({ ok: false, reason: 'member_not_found' });
    // The org A member's balance is untouched.
    expect(await balanceOf(env.orgAId, env.userAId, memberA)).toBe(0);
  });

  it('org B cannot issue an adjustment against an org A member', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoAdjA');
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const r = await issueAdjustmentWithDb(env.db, sessB, {
      memberUserId: memberA,
      amountCents: 1000,
      direction: 'debit',
      memo: 'cross-org attempt',
    });
    expect(r).toEqual({ ok: false, reason: 'member_not_found' });
  });
});
