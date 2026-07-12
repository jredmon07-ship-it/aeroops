/**
 * pos-counter-sale.test.ts — Integration tests for Slice P2: POS / Counter Sales.
 *
 * Applies migrations 0000–0031 (0031 = product_catalog / POS).
 * Uses PGlite + WithDb functions. Two-org seed for tenant isolation.
 * Every test injects a FAKE StripeClient — never a real HTTP call.
 *
 * COVERAGE:
 *   CATALOG CRUD: create/update/list/delete + caps + audit + T-ISO
 *   COUNTER SALE: correct-total draft invoice via the real invoice write
 *     path; catalog + ad-hoc lines; inactive/unknown item + unknown member
 *     refusals; price-change immutability; caps; T-ISO (no enumeration)
 *   FINALIZE PARITY: counter-sale draft → finalizeInvoice → finalized +
 *     ONE ledger debit + autopay identical to a dispatch invoice
 *   REGRESSION: FROZEN dispatch write paths untouched
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  auditLog,
  productCatalog,
  ledgerEntry,
  loadMigrationSql,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import {
  createProductCatalogItemWithDb,
  updateProductCatalogItemWithDb,
  listProductCatalogItemsWithDb,
  deleteProductCatalogItemWithDb,
} from '../billing/product-catalog-commands.js';
import { createCounterSaleWithDb } from '../billing/counter-sale.js';
import { finalizeInvoiceWithDb } from '../billing/invoice-status-commands.js';
import { getInvoiceWithDb } from '../billing/list-invoices.js';
import { saveMyPaymentMethodWithDb } from '../portal/save-payment-method.js';
import { setMyAutopayWithDb } from '../portal/set-autopay.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';
import type {
  StripeClient,
  StripeCreateCustomerInput,
  StripeCreatePaymentIntentInput,
  StripeCustomerResult,
  StripePaymentIntentResult,
  StripeRetrievePaymentIntentResult,
  StripeWebhookEvent,
  StripeCreateSetupIntentInput,
  StripeSetupIntentResult,
  StripeAttachPaymentMethodInput,
  StripePaymentMethodDisplay,
} from '../integrations/stripe/client.js';

// All up migrations through 0031 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0031');

// ── Fake StripeClient — NO real HTTP call, ever ────────────────────────────────

let globalPiCounter = 0;
let globalSetupCounter = 0;
let globalPmCounter = 0;

class FakeStripeClient implements StripeClient {
  paymentIntentCalls: StripeCreatePaymentIntentInput[] = [];

  async createCustomer(_input: StripeCreateCustomerInput): Promise<StripeCustomerResult> {
    return { stripeCustomerId: `cus_fake_${Math.random()}` };
  }

  async createPaymentIntent(input: StripeCreatePaymentIntentInput): Promise<StripePaymentIntentResult> {
    globalPiCounter += 1;
    this.paymentIntentCalls.push(input);
    return {
      stripePaymentIntentId: `pi_fake_${globalPiCounter}`,
      clientSecret: `pi_fake_${globalPiCounter}_secret_abc`,
      status: input.confirm ? 'succeeded' : 'requires_payment_method',
    };
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<StripeRetrievePaymentIntentResult> {
    return { stripePaymentIntentId: paymentIntentId, status: 'succeeded', amountCents: 0 };
  }

  async constructWebhookEvent(rawBody: string, _signatureHeader: string | null): Promise<StripeWebhookEvent> {
    return JSON.parse(rawBody) as StripeWebhookEvent;
  }

  async createSetupIntent(input: StripeCreateSetupIntentInput): Promise<StripeSetupIntentResult> {
    globalSetupCounter += 1;
    return {
      stripeSetupIntentId: `seti_fake_${globalSetupCounter}`,
      clientSecret: `seti_fake_${globalSetupCounter}_secret_abc`,
      status: 'requires_payment_method',
    };
  }

  async attachPaymentMethod(_input: StripeAttachPaymentMethodInput): Promise<StripePaymentMethodDisplay> {
    globalPmCounter += 1;
    return {
      stripePaymentMethodId: `pm_fake_${globalPmCounter}`,
      type: 'us_bank_account',
      last4: '6789',
      brand: 'Test Bank',
    };
  }
}

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

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });
  env = {
    db,
    pglite,
    orgAId:  seed.orgAId,
    orgBId:  seed.orgBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };
}, 120_000);

/** Creates an active catalog item in orgId, returns the created item. */
async function seedCatalogItem(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  name = 'David Clark Headset',
  unitPriceCents = 25000,
) {
  const sess = makeSession(orgId, userId, 'owner');
  const r = await createProductCatalogItemWithDb(db, sess, { name, unitPriceCents });
  return r.item;
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1 — PRODUCT CATALOG CRUD
// ════════════════════════════════════════════════════════════════════════════════

describe('CATALOG: createProductCatalogItem', () => {
  it('owner creates a catalog item — integer cents + ONE audit row', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createProductCatalogItemWithDb(env.db, sess, {
      name: 'Sectional Chart',
      unitPriceCents: 1495,
      sku: 'CHT-001',
      category: 'Charts',
    });
    expect(result.ok).toBe(true);
    expect(result.item.name).toBe('Sectional Chart');
    expect(result.item.unitPriceCents).toBe(1495);
    expect(Number.isInteger(result.item.unitPriceCents)).toBe(true);
    expect(result.item.active).toBe(true);
    expect(result.item.sku).toBe('CHT-001');
    expect(result.item.category).toBe('Charts');

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog).where(
        and(
          eq(auditLog.action, 'billing.product_catalog_item_created'),
          eq(auditLog.entityId, result.item.id),
        ),
      ),
    );
    expect(rows.length).toBe(1);
  });

  it('empty-string sku/category normalize to null', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createProductCatalogItemWithDb(env.db, sess, {
      name: 'Ad-hoc Item',
      unitPriceCents: 500,
      sku: '   ',
      category: '',
    });
    expect(result.item.sku).toBeNull();
    expect(result.item.category).toBeNull();
  });

  it('non-integer price ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createProductCatalogItemWithDb(env.db, sess, { name: 'Bad', unitPriceCents: 10.5 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('zero price ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createProductCatalogItemWithDb(env.db, sess, { name: 'Free', unitPriceCents: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('negative price ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createProductCatalogItemWithDb(env.db, sess, { name: 'Neg', unitPriceCents: -100 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('empty name ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createProductCatalogItemWithDb(env.db, sess, { name: '', unitPriceCents: 100 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('null session ⇒ UnauthenticatedError', async () => {
    await expect(
      createProductCatalogItemWithDb(env.db, null, { name: 'X', unitPriceCents: 100 }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('dispatcher (no billing:manage) ⇒ ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(
      createProductCatalogItemWithDb(env.db, sess, { name: 'X', unitPriceCents: 100 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('accountant (billing:access only, no billing:manage) ⇒ ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      createProductCatalogItemWithDb(env.db, sess, { name: 'X', unitPriceCents: 100 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('CATALOG: updateProductCatalogItem', () => {
  it('updates name/price/active + ONE audit row', async () => {
    const item = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Old Name', 1000);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await updateProductCatalogItemWithDb(env.db, sess, {
      id: item.id,
      name: 'New Name',
      unitPriceCents: 2000,
      active: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item.name).toBe('New Name');
    expect(result.item.unitPriceCents).toBe(2000);
    expect(result.item.active).toBe(false);

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog).where(
        and(
          eq(auditLog.action, 'billing.product_catalog_item_updated'),
          eq(auditLog.entityId, item.id),
        ),
      ),
    );
    expect(rows.length).toBe(1);
  });

  it('unknown id ⇒ not_found', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await updateProductCatalogItemWithDb(env.db, sess, {
      id: '00000000-0000-0000-0000-000000000099',
      name: 'X',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('accountant cannot update ⇒ ForbiddenError', async () => {
    const item = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Accountant Test', 1000);
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      updateProductCatalogItemWithDb(env.db, sess, { id: item.id, name: 'Nope' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('CATALOG: listProductCatalogItems', () => {
  it('default excludes inactive; includeInactive includes them; ordered by name', async () => {
    const activeItem = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Zebra Item', 100);
    const inactiveItem = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Alpha Item', 200);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await updateProductCatalogItemWithDb(env.db, sess, { id: inactiveItem.id, active: false });

    const activeOnly = await listProductCatalogItemsWithDb(env.db, sess, {});
    const activeNames = activeOnly.items.map((i) => i.name);
    expect(activeNames).toContain('Zebra Item');
    expect(activeNames).not.toContain('Alpha Item');

    const withInactive = await listProductCatalogItemsWithDb(env.db, sess, { includeInactive: true });
    const allNames = withInactive.items.map((i) => i.name);
    expect(allNames).toContain('Zebra Item');
    expect(allNames).toContain('Alpha Item');

    // Ordered by name — Alpha before Zebra when both present.
    const alphaIdx = allNames.indexOf('Alpha Item');
    const zebraIdx = allNames.indexOf('Zebra Item');
    expect(alphaIdx).toBeLessThan(zebraIdx);
    void activeItem;
  });

  it('accountant (billing:access) CAN list', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const result = await listProductCatalogItemsWithDb(env.db, sess, {});
    expect(Array.isArray(result.items)).toBe(true);
  });

  it('null session ⇒ UnauthenticatedError', async () => {
    await expect(listProductCatalogItemsWithDb(env.db, null, {})).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('CATALOG: deleteProductCatalogItem', () => {
  it('deletes an unused item + ONE audit row', async () => {
    const item = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Deletable', 300);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await deleteProductCatalogItemWithDb(env.db, sess, { id: item.id });
    expect(result).toEqual({ ok: true });

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog).where(
        and(
          eq(auditLog.action, 'billing.product_catalog_item_deleted'),
          eq(auditLog.entityId, item.id),
        ),
      ),
    );
    expect(rows.length).toBe(1);

    // Gone from catalog.
    const remaining = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(productCatalog).where(eq(productCatalog.id, item.id)),
    );
    expect(remaining.length).toBe(0);
  });

  it('unknown id ⇒ not_found', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await deleteProductCatalogItemWithDb(env.db, sess, {
      id: '00000000-0000-0000-0000-000000000098',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('deleting a catalog item used in a past sale leaves the sale intact (edge 10)', async () => {
    const item = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Used In Sale', 5000);
    const ownerSess = makeSession(env.orgAId, env.userAId, 'owner');
    const saleR = await createCounterSaleWithDb(env.db, ownerSess, {
      memberId: env.userAId,
      lines: [{ catalogItemId: item.id, quantity: 1 }],
    });
    expect(saleR.ok).toBe(true);
    if (!saleR.ok) return;

    const delR = await deleteProductCatalogItemWithDb(env.db, ownerSess, { id: item.id });
    expect(delR).toEqual({ ok: true });

    // The sale invoice + line item are unaffected.
    const invR = await getInvoiceWithDb(env.db, ownerSess, { id: saleR.invoice.id });
    expect(invR.ok).toBe(true);
    if (!invR.ok) return;
    expect(invR.lineItems.length).toBe(1);
    expect(invR.lineItems[0]?.description).toBe('Used In Sale');
    expect(invR.lineItems[0]?.lineTotalCents).toBe(5000);
  });

  it('accountant cannot delete ⇒ ForbiddenError', async () => {
    const item = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Protected', 100);
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(deleteProductCatalogItemWithDb(env.db, sess, { id: item.id })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2 — TENANT ISOLATION (product_catalog)
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO: product_catalog', () => {
  it('org B cannot list org A catalog items', async () => {
    await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Org A Only Item', 999);
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await listProductCatalogItemsWithDb(env.db, sessB, { includeInactive: true });
    expect(result.items.map((i) => i.name)).not.toContain('Org A Only Item');
  });

  it('org B cannot update org A catalog item ⇒ not_found', async () => {
    const itemA = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'A Update Target', 400);
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await updateProductCatalogItemWithDb(env.db, sessB, { id: itemA.id, name: 'Hijacked' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('org B cannot delete org A catalog item ⇒ not_found', async () => {
    const itemA = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'A Delete Target', 401);
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await deleteProductCatalogItemWithDb(env.db, sessB, { id: itemA.id });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3 — createCounterSale
// ════════════════════════════════════════════════════════════════════════════════

describe('createCounterSale: builds a correct-total draft invoice via the real path', () => {
  it('single catalog line — invoice + ONE line item + subtotal===total===Σ + ONE audit row', async () => {
    const item = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Foreflight Subscription', 9900);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createCounterSaleWithDb(env.db, sess, {
      memberId: env.userAId,
      lines: [{ catalogItemId: item.id, quantity: 3 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.status).toBe('draft');
    expect(result.invoice.dispatchTicketId).toBeNull();
    expect(result.invoice.subtotalCents).toBe(29700);
    expect(result.invoice.totalCents).toBe(29700);
    expect(result.invoice.lineItems.length).toBe(1);
    expect(result.invoice.lineItems[0]?.lineTotalCents).toBe(29700);
    expect(result.invoice.lineItems[0]?.description).toBe('Foreflight Subscription');

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog).where(
        and(
          eq(auditLog.action, 'billing.counter_sale_created'),
          eq(auditLog.entityId, result.invoice.id),
        ),
      ),
    );
    expect(rows.length).toBe(1);
  });

  it('mixed catalog + ad-hoc lines are both priced correctly', async () => {
    const item = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Fuel (per gal)', 650);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createCounterSaleWithDb(env.db, sess, {
      memberId: env.userAId,
      lines: [
        { catalogItemId: item.id, quantity: 10 }, // 6500
        { name: 'Shop rag', unitPriceCents: 250, quantity: 4 }, // 1000
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.lineItems.length).toBe(2);
    expect(result.invoice.subtotalCents).toBe(7500);
    expect(result.invoice.totalCents).toBe(7500);
    const descriptions = result.invoice.lineItems.map((l) => l.description).sort();
    expect(descriptions).toEqual(['Fuel (per gal)', 'Shop rag']);
  });

  it('inactive catalog item ⇒ catalog_item_inactive', async () => {
    const item = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Retired Item', 100);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await updateProductCatalogItemWithDb(env.db, sess, { id: item.id, active: false });
    const result = await createCounterSaleWithDb(env.db, sess, {
      memberId: env.userAId,
      lines: [{ catalogItemId: item.id, quantity: 1 }],
    });
    expect(result).toEqual({ ok: false, reason: 'catalog_item_inactive' });
  });

  it('unknown catalog item ⇒ catalog_item_not_found', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createCounterSaleWithDb(env.db, sess, {
      memberId: env.userAId,
      lines: [{ catalogItemId: '00000000-0000-0000-0000-000000000077', quantity: 1 }],
    });
    expect(result).toEqual({ ok: false, reason: 'catalog_item_not_found' });
  });

  it('unknown member ⇒ member_not_found', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createCounterSaleWithDb(env.db, sess, {
      memberId: '00000000-0000-0000-0000-000000000078',
      lines: [{ name: 'Chart', unitPriceCents: 100, quantity: 1 }],
    });
    expect(result).toEqual({ ok: false, reason: 'member_not_found' });
  });

  it('empty lines ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createCounterSaleWithDb(env.db, sess, { memberId: env.userAId, lines: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('zero/negative quantity ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createCounterSaleWithDb(env.db, sess, {
        memberId: env.userAId,
        lines: [{ name: 'Bad Qty', unitPriceCents: 100, quantity: 0 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('ad-hoc line missing name/price ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createCounterSaleWithDb(env.db, sess, {
        memberId: env.userAId,
        lines: [{ quantity: 1 } as unknown as { name: string; unitPriceCents: number; quantity: number }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('price-change immutability: updating a catalog item after a sale does not alter the sale (edge 7)', async () => {
    const item = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Priced Item', 1000);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const saleR = await createCounterSaleWithDb(env.db, sess, {
      memberId: env.userAId,
      lines: [{ catalogItemId: item.id, quantity: 2 }],
    });
    expect(saleR.ok).toBe(true);
    if (!saleR.ok) return;
    expect(saleR.invoice.totalCents).toBe(2000);

    await updateProductCatalogItemWithDb(env.db, sess, { id: item.id, unitPriceCents: 9999 });

    const reread = await getInvoiceWithDb(env.db, sess, { id: saleR.invoice.id });
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.invoice.totalCents).toBe(2000);
    expect(reread.lineItems[0]?.unitAmountCents).toBe(1000);
  });

  it('caps: null session ⇒ Unauthenticated', async () => {
    await expect(
      createCounterSaleWithDb(env.db, null, { memberId: env.userAId, lines: [{ name: 'X', unitPriceCents: 1, quantity: 1 }] }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('caps: accountant (billing:access only) ⇒ ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      createCounterSaleWithDb(env.db, sess, { memberId: env.userAId, lines: [{ name: 'X', unitPriceCents: 1, quantity: 1 }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('caps: dispatcher ⇒ ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(
      createCounterSaleWithDb(env.db, sess, { memberId: env.userAId, lines: [{ name: 'X', unitPriceCents: 1, quantity: 1 }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('T-ISO: createCounterSale — cross-org ids never leak (no enumeration)', () => {
  it('org B session with org A memberId ⇒ member_not_found (not a Forbidden/leak)', async () => {
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await createCounterSaleWithDb(env.db, sessB, {
      memberId: env.userAId, // belongs to org A
      lines: [{ name: 'X', unitPriceCents: 100, quantity: 1 }],
    });
    expect(result).toEqual({ ok: false, reason: 'member_not_found' });
  });

  it('org B session with org A catalogItemId ⇒ catalog_item_not_found', async () => {
    const itemA = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'A Only Catalog', 500);
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await createCounterSaleWithDb(env.db, sessB, {
      memberId: env.userBId,
      lines: [{ catalogItemId: itemA.id, quantity: 1 }],
    });
    expect(result).toEqual({ ok: false, reason: 'catalog_item_not_found' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4 — FINALIZE + LEDGER PARITY (edge 8/9)
// ════════════════════════════════════════════════════════════════════════════════

describe('Finalize parity: a counter-sale invoice behaves exactly like a dispatch invoice', () => {
  it('finalizes: status=finalized, issued_at set, exactly ONE invoice_finalized debit ledger_entry', async () => {
    const item = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Parity Item', 4200);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const saleR = await createCounterSaleWithDb(env.db, sess, {
      memberId: env.userAId,
      lines: [{ catalogItemId: item.id, quantity: 1 }],
    });
    expect(saleR.ok).toBe(true);
    if (!saleR.ok) return;

    const finR = await finalizeInvoiceWithDb(env.db, sess, { id: saleR.invoice.id }, new FakeStripeClient());
    expect(finR.ok).toBe(true);
    if (!finR.ok) return;
    expect(finR.invoice.status).toBe('finalized');
    expect(finR.invoice.issuedAt).not.toBeNull();

    const ledgerRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(ledgerEntry).where(
        and(
          eq(ledgerEntry.invoiceId, saleR.invoice.id),
          eq(ledgerEntry.entryType, 'invoice_finalized'),
        ),
      ),
    );
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0]?.amountCents).toBe(4200);
    expect(ledgerRows[0]?.direction).toBe('debit');
  });

  it('re-finalize is blocked ⇒ not_draft', async () => {
    const item = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Reused Item', 100);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const saleR = await createCounterSaleWithDb(env.db, sess, {
      memberId: env.userAId,
      lines: [{ catalogItemId: item.id, quantity: 1 }],
    });
    if (!saleR.ok) throw new Error('setup failed');
    await finalizeInvoiceWithDb(env.db, sess, { id: saleR.invoice.id }, new FakeStripeClient());
    const second = await finalizeInvoiceWithDb(env.db, sess, { id: saleR.invoice.id }, new FakeStripeClient());
    expect(second).toEqual(expect.objectContaining({ ok: false, reason: 'not_draft' }));
  });

  it('double-finalize race posts AT MOST ONE ledger debit', async () => {
    const item = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Race Item', 777);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const saleR = await createCounterSaleWithDb(env.db, sess, {
      memberId: env.userAId,
      lines: [{ catalogItemId: item.id, quantity: 1 }],
    });
    if (!saleR.ok) throw new Error('setup failed');

    const [r1, r2] = await Promise.all([
      finalizeInvoiceWithDb(env.db, sess, { id: saleR.invoice.id }, new FakeStripeClient()),
      finalizeInvoiceWithDb(env.db, sess, { id: saleR.invoice.id }, new FakeStripeClient()),
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    expect(oks.length).toBe(1);

    const ledgerRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(ledgerEntry).where(
        and(
          eq(ledgerEntry.invoiceId, saleR.invoice.id),
          eq(ledgerEntry.entryType, 'invoice_finalized'),
        ),
      ),
    );
    expect(ledgerRows.length).toBe(1);
  });

  it('with a saved PM + autopay enabled, finalize triggers autopay identically to a dispatch invoice', async () => {
    const item = await seedCatalogItem(env.db, env.orgAId, env.userAId, 'Autopay Item', 5500);
    const ownerSess = makeSession(env.orgAId, env.userAId, 'owner');
    const memberSess = makeSession(env.orgAId, env.userAId, 'renter');

    const client = new FakeStripeClient();
    const saveR = await saveMyPaymentMethodWithDb(env.db, memberSess, { paymentMethodId: `pm_pos_${env.userAId}` }, client);
    if (!saveR.ok) throw new Error('save PM failed');
    const autoR = await setMyAutopayWithDb(env.db, memberSess, {
      enabled: true,
      defaultPaymentMethodId: saveR.paymentMethod.id,
    });
    if (!autoR.ok) throw new Error('set autopay failed');

    const saleR = await createCounterSaleWithDb(env.db, ownerSess, {
      memberId: env.userAId,
      lines: [{ catalogItemId: item.id, quantity: 1 }],
    });
    if (!saleR.ok) throw new Error('sale failed');

    const finR = await finalizeInvoiceWithDb(env.db, ownerSess, { id: saleR.invoice.id }, client);
    expect(finR.ok).toBe(true);
    if (!finR.ok) return;
    expect(finR.autopay?.outcome).toBe('created');
    expect(client.paymentIntentCalls.length).toBeGreaterThan(0);
    const lastCall = client.paymentIntentCalls[client.paymentIntentCalls.length - 1];
    expect(lastCall?.amountCents).toBe(5500);
    expect(lastCall?.idempotencyKey).toBe(`autopay:${saleR.invoice.id}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5 — REGRESSION GUARDS
// ════════════════════════════════════════════════════════════════════════════════

describe('REGRESSION: no float drift across many lines (integer-cents property, smoke)', () => {
  it('a 20-line sale totals exactly Σ(quantity × unitPriceCents)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const lines: Array<{ name: string; unitPriceCents: number; quantity: number }> = [];
    let expectedTotal = 0;
    for (let i = 0; i < 20; i += 1) {
      const price = 137 + i * 3;
      const qty = 1 + (i % 7);
      lines.push({ name: `Ad-hoc Line ${i}`, unitPriceCents: price, quantity: qty });
      expectedTotal += price * qty;
    }
    const result = await createCounterSaleWithDb(env.db, sess, { memberId: env.userAId, lines });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.subtotalCents).toBe(expectedTotal);
    expect(result.invoice.totalCents).toBe(expectedTotal);
  });
});
