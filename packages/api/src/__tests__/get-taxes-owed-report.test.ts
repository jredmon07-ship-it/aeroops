/**
 * get-taxes-owed-report.test.ts — Integration tests for getTaxesOwedReport.
 *
 * Applies migrations 0000–0040 via the shared loader (0031 = product_catalog).
 *
 * The schema models NO tax (0031, [VERIFY-P2-A]) — so taxCents is ALWAYS a
 * documented 0. This report surfaces the finalized POS taxable BASE
 * (taxableGrossCents) over the range, bucketed by period, with a 0 tax figure.
 *
 * COVERAGE:
 *   CAPS: billing:access required. accountant passes; dispatcher / renter ⇒
 *     Forbidden; null ⇒ Unauthenticated.
 *   HAPPY: taxableGrossCents = Σ finalized POS line totals; a DRAFT sale is not
 *     counted; totalTaxCents == 0 (and every bucket taxCents == 0).
 *   T-ISO: org-A never sees org-B's POS gross; org B sees only its own.
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

import { getTaxesOwedReportWithDb } from '../billing/get-taxes-owed-report.js';
import { createProductCatalogItemWithDb } from '../billing/product-catalog-commands.js';
import { createCounterSaleWithDb } from '../billing/counter-sale.js';
import { finalizeInvoiceWithDb } from '../billing/invoice-status-commands.js';

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

async function createProduct(
  db: PgliteTestClient,
  orgId: string,
  ownerUserId: string,
  name: string,
  unitPriceCents: number,
): Promise<string> {
  const sess = makeSession(orgId, ownerUserId, 'owner');
  const r = await createProductCatalogItemWithDb(db, sess, { name, unitPriceCents });
  if (!r.ok) throw new Error('createProduct failed');
  return r.item.id;
}

async function sell(
  db: PgliteTestClient,
  orgId: string,
  ownerUserId: string,
  memberId: string,
  lines: Array<{ catalogItemId: string; quantity: number }>,
  finalize: boolean,
): Promise<void> {
  const sess = makeSession(orgId, ownerUserId, 'owner');
  const sale = await createCounterSaleWithDb(db, sess, { memberId, lines });
  if (!sale.ok) throw new Error(`counter sale failed: ${sale.reason}`);
  if (finalize) {
    const fin = await finalizeInvoiceWithDb(db, sess, { id: sale.invoice.id });
    if (!fin.ok) throw new Error(`finalize failed: ${fin.reason}`);
  }
}

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

  // ── Org A ── Headset x2 @ $150 (finalized) + a DRAFT Chart x5 (excluded).
  const buyerA = await seedMember(db, env.orgAId, 'BuyerA', 'renter');
  const pHeadsetA = await createProduct(db, env.orgAId, env.userAId, 'Headset X', 15_000);
  const pChartA = await createProduct(db, env.orgAId, env.userAId, 'Sectional Chart', 999);
  await sell(db, env.orgAId, env.userAId, buyerA, [{ catalogItemId: pHeadsetA, quantity: 2 }], true);
  await sell(db, env.orgAId, env.userAId, buyerA, [{ catalogItemId: pChartA, quantity: 5 }], false);

  // ── Org B ── Widget x4 @ $50 (finalized).
  const buyerB = await seedMember(db, env.orgBId, 'BuyerB', 'renter');
  const pWidgetB = await createProduct(db, env.orgBId, env.userBId, 'B Widget', 5_000);
  await sell(db, env.orgBId, env.userBId, buyerB, [{ catalogItemId: pWidgetB, quantity: 4 }], true);
}, 180_000);

// ════════════════════════════════════════════════════════════════════════════════
// CAPS
// ════════════════════════════════════════════════════════════════════════════════

describe('caps', () => {
  it('null session ⇒ Unauthenticated', async () => {
    await expect(getTaxesOwedReportWithDb(env.db, null, { range: '30d' })).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('accountant (billing:access) ⇒ allowed', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const r = await getTaxesOwedReportWithDb(env.db, sess, { range: '30d' });
    expect(Array.isArray(r.buckets)).toBe(true);
  });

  it('dispatcher (no billing:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(getTaxesOwedReportWithDb(env.db, sess, { range: '30d' })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('renter (no billing:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(getTaxesOwedReportWithDb(env.db, sess, { range: '30d' })).rejects.toThrow(
      ForbiddenError,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// HAPPY PATH
// ════════════════════════════════════════════════════════════════════════════════

describe('getTaxesOwedReport — org A', () => {
  it('taxableGross = finalized POS lines (draft excluded); tax is 0 everywhere', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getTaxesOwedReportWithDb(env.db, sess, { range: '30d' });

    // Headset x2 @ $150.00 = $300.00 finalized. The x5 Chart draft is excluded.
    expect(r.totalTaxableGrossCents).toBe(30_000);
    expect(r.totalTaxCents).toBe(0);
    expect(r.buckets.every((b) => b.taxCents === 0)).toBe(true);
    // The gross lands in exactly one bucket and sums to the total.
    expect(r.buckets.reduce((acc, b) => acc + b.taxableGrossCents, 0)).toBe(30_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// TENANT ISOLATION
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO', () => {
  it('org-A never sees org-B POS gross', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getTaxesOwedReportWithDb(env.db, sess, { range: '30d' });
    expect(r.totalTaxableGrossCents).toBe(30_000); // NOT 30000 + 20000
  });

  it('org-B sees only its own POS gross', async () => {
    const sess = makeSession(env.orgBId, env.userBId, 'owner');
    const r = await getTaxesOwedReportWithDb(env.db, sess, { range: '30d' });
    expect(r.totalTaxableGrossCents).toBe(20_000);
    expect(r.totalTaxCents).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════════════════════

describe('validation', () => {
  it('bad range key ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(getTaxesOwedReportWithDb(env.db, sess, { range: 'bad' })).rejects.toThrow(
      ValidationError,
    );
  });
});
