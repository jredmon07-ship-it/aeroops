/**
 * get-items-sold-report.test.ts — Integration tests for getItemsSoldReport.
 *
 * Applies migrations 0000–0040 via the shared loader (0031 = product_catalog).
 *
 * COVERAGE:
 *   CAPS: billing:access required. accountant passes; dispatcher / renter
 *     (no billing:access) ⇒ Forbidden; null ⇒ Unauthenticated.
 *   HAPPY: per-product qty + gross over FINALIZED counter sales; a DRAFT sale
 *     is NOT counted; a never-sold catalog product appears with 0/$0.00; an
 *     ad-hoc (non-catalog) line does not create a product row; taxCents == 0.
 *   ORDER: grossCents DESC, name ASC.
 *   TOTALS: totalQtySold / totalGrossCents / totalTaxCents.
 *   T-ISO: org-A session never sees an org-B product/sale; org B sees only its own.
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

import { getItemsSoldReportWithDb } from '../billing/get-items-sold-report.js';
import { createProductCatalogItemWithDb } from '../billing/product-catalog-commands.js';
import { createCounterSaleWithDb } from '../billing/counter-sale.js';
import { finalizeInvoiceWithDb } from '../billing/invoice-status-commands.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';
import type { MembershipRole } from '@aeroops/core';

const MIGRATION_SQL = loadMigrationSql('0040');

// ── Shared env ────────────────────────────────────────────────────────────────

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
  await withOrgContext(db, orgId, (tx) =>
    tx.insert(membership).values({ orgId, userId: row.id, role }),
  );
  return row.id;
}

async function createProduct(
  db: PgliteTestClient,
  orgId: string,
  ownerUserId: string,
  name: string,
  unitPriceCents: number,
  sku?: string,
): Promise<string> {
  const sess = makeSession(orgId, ownerUserId, 'owner');
  const r = await createProductCatalogItemWithDb(db, sess, { name, unitPriceCents, sku });
  if (!r.ok) throw new Error('createProduct failed');
  return r.item.id;
}

/** Create a counter sale and (optionally) finalize it. */
async function sell(
  db: PgliteTestClient,
  orgId: string,
  ownerUserId: string,
  memberId: string,
  lines: Array<
    | { catalogItemId: string; quantity: number }
    | { name: string; unitPriceCents: number; quantity: number }
  >,
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

// Seeded product ids.
let pHeadsetA = '';
let pChartA = '';
let pLogbookA = ''; // never sold
let pWidgetB = '';

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

  // ── Org A ──
  const buyerA = await seedMember(db, env.orgAId, 'BuyerA', 'renter');
  pHeadsetA = await createProduct(db, env.orgAId, env.userAId, 'Headset X', 15_000, 'HS-X');
  pChartA = await createProduct(db, env.orgAId, env.userAId, 'Sectional Chart', 999);
  pLogbookA = await createProduct(db, env.orgAId, env.userAId, 'Pilot Logbook', 2_500);

  // Sale 1 (FINALIZED): Headset x2 + Chart x1 + an ad-hoc "Coffee" line.
  await sell(
    db,
    env.orgAId,
    env.userAId,
    buyerA,
    [
      { catalogItemId: pHeadsetA, quantity: 2 },
      { catalogItemId: pChartA, quantity: 1 },
      { name: 'Coffee', unitPriceCents: 300, quantity: 1 },
    ],
    true,
  );

  // Sale 2 (FINALIZED): Headset x1.
  await sell(db, env.orgAId, env.userAId, buyerA, [{ catalogItemId: pHeadsetA, quantity: 1 }], true);

  // Sale 3 (DRAFT — NOT finalized): Chart x5 — must NOT count.
  await sell(db, env.orgAId, env.userAId, buyerA, [{ catalogItemId: pChartA, quantity: 5 }], false);

  // ── Org B (isolation fixture) ──
  const buyerB = await seedMember(db, env.orgBId, 'BuyerB', 'renter');
  pWidgetB = await createProduct(db, env.orgBId, env.userBId, 'B Widget', 5_000);
  await sell(db, env.orgBId, env.userBId, buyerB, [{ catalogItemId: pWidgetB, quantity: 4 }], true);
}, 180_000);

// ════════════════════════════════════════════════════════════════════════════════
// CAPS
// ════════════════════════════════════════════════════════════════════════════════

describe('caps', () => {
  it('null session ⇒ Unauthenticated', async () => {
    await expect(getItemsSoldReportWithDb(env.db, null, { range: '30d' })).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('accountant (billing:access) ⇒ allowed', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const r = await getItemsSoldReportWithDb(env.db, sess, { range: '30d' });
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('dispatcher (no billing:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(getItemsSoldReportWithDb(env.db, sess, { range: '30d' })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('renter (no billing:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(getItemsSoldReportWithDb(env.db, sess, { range: '30d' })).rejects.toThrow(
      ForbiddenError,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// HAPPY PATH
// ════════════════════════════════════════════════════════════════════════════════

describe('getItemsSoldReport — org A', () => {
  it('per-product qty + gross over finalized sales (draft excluded); taxCents=0', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getItemsSoldReportWithDb(env.db, sess, { range: '30d' });

    const byId = new Map(r.rows.map((row) => [row.productId, row]));

    // Headset: 2 (sale1) + 1 (sale2) = 3 units; 3 × $150.00 = $450.00.
    expect(byId.get(pHeadsetA)).toMatchObject({ qtySold: 3, grossCents: 45_000, taxCents: 0 });
    // Chart: 1 finalized (the x5 draft does NOT count).
    expect(byId.get(pChartA)).toMatchObject({ qtySold: 1, grossCents: 999, taxCents: 0 });
    // Logbook never sold → zero row still present.
    expect(byId.get(pLogbookA)).toMatchObject({ qtySold: 0, grossCents: 0, taxCents: 0 });
  });

  it('sku is surfaced', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getItemsSoldReportWithDb(env.db, sess, { range: '30d' });
    expect(r.rows.find((row) => row.productId === pHeadsetA)!.sku).toBe('HS-X');
  });

  it('the ad-hoc "Coffee" line is NOT a product row', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getItemsSoldReportWithDb(env.db, sess, { range: '30d' });
    expect(r.rows.some((row) => row.productName === 'Coffee')).toBe(false);
  });

  it('ordered grossCents DESC, name ASC (Headset, Chart, Logbook)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getItemsSoldReportWithDb(env.db, sess, { range: '30d' });
    expect(r.rows.map((row) => row.productId)).toEqual([pHeadsetA, pChartA, pLogbookA]);
  });

  it('totals: qty=4, gross=45999, tax=0', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getItemsSoldReportWithDb(env.db, sess, { range: '30d' });
    expect(r.totalQtySold).toBe(4);
    expect(r.totalGrossCents).toBe(45_999);
    expect(r.totalTaxCents).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// TENANT ISOLATION
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO', () => {
  it('org-A session never sees the org-B product', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getItemsSoldReportWithDb(env.db, sess, { range: '30d' });
    expect(r.rows.some((row) => row.productId === pWidgetB)).toBe(false);
    expect(r.rows.some((row) => row.productName === 'B Widget')).toBe(false);
  });

  it('org-B session sees only its own product with its own totals', async () => {
    const sess = makeSession(env.orgBId, env.userBId, 'owner');
    const r = await getItemsSoldReportWithDb(env.db, sess, { range: '30d' });
    expect(r.rows.map((row) => row.productId)).toEqual([pWidgetB]);
    expect(r.rows[0]).toMatchObject({ qtySold: 4, grossCents: 20_000 });
    expect(r.totalGrossCents).toBe(20_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════════════════════

describe('validation', () => {
  it('bad range key ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      getItemsSoldReportWithDb(env.db, sess, { range: 'last-week' }),
    ).rejects.toThrow(ValidationError);
  });
});
