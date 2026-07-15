/**
 * fee-passing-balance.test.ts — integration tests for the two additive money
 * features (migration 0045):
 *   (1) FEE-PASSING TOGGLE — per-org pass_ach_fee_to_member. When ON, the portal
 *       grosses invoice/balance payments up by min(round(base×1%), $15); the
 *       webhook ledger credit posts the BASE only. OFF ⇒ byte-identical.
 *   (2) PAY FULL BALANCE — payMyBalance creates ONE PaymentIntent for the
 *       magnitude of the member's negative balance; the webhook posts one
 *       'payment' credit for the base, zeroing the balance.
 *
 * Applies migrations 0000–0045. Every test injects a FAKE StripeClient — never
 * a real HTTP call. A separate 0044-only client proves GRACEFUL ABSENCE (0045
 * unapplied ⇒ feature OFF / not_available, never a crash).
 *
 * COVERAGE:
 *   - fee setting get/set: caps (org:manage_settings), T-ISO across orgs.
 *   - pay-invoice grossing ON vs byte-identical OFF (PI amount + metadata).
 *   - webhook credit = BASE not gross (invoice fee + balance fee).
 *   - balance-payment credit path (payMyBalance → webhook → ledger).
 *   - T-ISO on balance_payment + the fee setting.
 *   - graceful absence on a 0044 DB.
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
  invoice as invoiceTable,
  invoiceLineItem,
  ledgerEntry,
  balancePayment,
  paymentIntentRecord,
  loadMigrationSql,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { getFeePassingWithDb, setFeePassingWithDb } from '../billing/fee-passing-setting.js';
import { payMyInvoiceWithDb } from '../portal/pay-invoice.js';
import { payMyBalanceWithDb } from '../portal/pay-balance.js';
import { getMyBillingWithDb } from '../portal/get-my-billing.js';
import { finalizeInvoiceWithDb } from '../billing/invoice-status-commands.js';
import { handleStripeWebhookEvent } from '../integrations/stripe/handle-webhook-event.js';
import { StubStripeClient } from '../integrations/stripe/client.js';
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
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

const MIGRATION_SQL_0045 = loadMigrationSql('0045');
const MIGRATION_SQL_0044 = loadMigrationSql('0044');

// ── Fake StripeClient — captures the created PaymentIntents, NO real HTTP ──────

let piCounter = 0;
let customerCounter = 0;

class FakeStripeClient implements StripeClient {
  paymentIntentCalls: StripeCreatePaymentIntentInput[] = [];

  async createCustomer(_input: StripeCreateCustomerInput): Promise<StripeCustomerResult> {
    customerCounter += 1;
    return { stripeCustomerId: `cus_fake_${customerCounter}` };
  }

  async createPaymentIntent(input: StripeCreatePaymentIntentInput): Promise<StripePaymentIntentResult> {
    piCounter += 1;
    this.paymentIntentCalls.push(input);
    return {
      stripePaymentIntentId: `pi_fake_${piCounter}`,
      clientSecret: `pi_fake_${piCounter}_secret`,
      status: 'requires_payment_method',
    };
  }

  async retrievePaymentIntent(id: string): Promise<StripeRetrievePaymentIntentResult> {
    return { stripePaymentIntentId: id, status: 'succeeded', amountCents: 0 };
  }

  async constructWebhookEvent(rawBody: string): Promise<StripeWebhookEvent> {
    return JSON.parse(rawBody) as StripeWebhookEvent;
  }

  async createSetupIntent(_input: StripeCreateSetupIntentInput): Promise<StripeSetupIntentResult> {
    return { stripeSetupIntentId: 'seti_x', clientSecret: 'seti_x_secret', status: 'requires_payment_method' };
  }

  async attachPaymentMethod(input: StripeAttachPaymentMethodInput): Promise<StripePaymentMethodDisplay> {
    return { stripePaymentMethodId: input.paymentMethodId, type: 'card', last4: '4242', brand: 'Visa' };
  }
}

function makeSucceededEventBody(eventId: string, piId: string, amountCents: number): string {
  return JSON.stringify({
    id: eventId,
    type: 'payment_intent.succeeded',
    data: { object: { id: piId, amount: amountCents, currency: 'usd', status: 'succeeded' } },
  });
}

function makeSession(orgId: string, userId: string, role: AppSession['role'] = 'owner'): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

let env: { db: PgliteTestClient; pglite: PGlite; orgAId: string; orgBId: string; userAId: string; userBId: string };
let tailSuffix = 0;
function nextTail(prefix: string): string {
  tailSuffix += 1;
  return `${prefix}${tailSuffix}`;
}

async function seedMember(db: PgliteTestClient, orgId: string, tag: string): Promise<string> {
  const tail = nextTail(tag);
  const rows = await withOrgContext(db, orgId, (tx) =>
    tx
      .insert(appUser)
      .values({ orgId, email: `${tail.toLowerCase()}@example.test`, fullName: `Member ${tail}` })
      .returning({ id: appUser.id }),
  );
  const id = rows[0]!.id;
  await withOrgContext(db, orgId, (tx) => tx.insert(membership).values({ orgId, userId: id, role: 'renter' }));
  return id;
}

/** Finalize an invoice → posts an 'invoice_finalized' DEBIT (member balance -amount). */
async function seedFinalizedInvoice(
  db: PgliteTestClient,
  orgId: string,
  ownerUserId: string,
  memberUserId: string,
  amountCents: number,
): Promise<string> {
  const invoiceRows = await withOrgContext(db, orgId, (tx) =>
    tx
      .insert(invoiceTable)
      .values({
        orgId,
        memberUserId,
        status: 'draft',
        subtotalCents: amountCents,
        totalCents: amountCents,
        dispatchTicketId: null,
        issuedAt: null,
        createdBy: ownerUserId,
      })
      .returning(),
  );
  const invoiceRow = invoiceRows[0]!;
  await withOrgContext(db, orgId, (tx) =>
    tx.insert(invoiceLineItem).values({
      orgId,
      invoiceId: invoiceRow.id,
      description: 'Test charge',
      quantityHours: '1.0',
      unitAmountCents: amountCents,
      lineTotalCents: amountCents,
      rateScheduleId: null,
    }),
  );
  const finR = await finalizeInvoiceWithDb(db, makeSession(orgId, ownerUserId, 'owner'), { id: invoiceRow.id }, new StubStripeClient());
  if (!finR.ok) throw new Error('seed finalize failed');
  return invoiceRow.id;
}

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL_0045);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });
  env = { db, pglite, orgAId: seed.orgAId, orgBId: seed.orgBId, userAId: seed.userAId, userBId: seed.userBId };
}, 120_000);

// ════════════════════════════════════════════════════════════════════════════════
// Fee-passing setting — caps + T-ISO
// ════════════════════════════════════════════════════════════════════════════════

describe('fee-passing setting — caps', () => {
  it('getFeePassing: null session ⇒ Unauthenticated', async () => {
    await expect(getFeePassingWithDb(env.db, null)).rejects.toThrow(UnauthenticatedError);
  });

  it('setFeePassing: renter (no org:manage_settings) ⇒ Forbidden', async () => {
    const member = await seedMember(env.db, env.orgAId, 'FeeCapRenter');
    await expect(
      setFeePassingWithDb(env.db, makeSession(env.orgAId, member, 'renter'), { passAchFeeToMember: true }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('owner can read + toggle; default is OFF/available', async () => {
    const before = await getFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'));
    expect(before).toEqual({ passAchFeeToMember: false, available: true });
    const set = await setFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), { passAchFeeToMember: true });
    expect(set).toEqual({ ok: true, passAchFeeToMember: true });
    const after = await getFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'));
    expect(after.passAchFeeToMember).toBe(true);
    // Reset for later tests that depend on OFF.
    await setFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), { passAchFeeToMember: false });
  });

  it('T-ISO: toggling org A does NOT affect org B', async () => {
    await setFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), { passAchFeeToMember: true });
    const bView = await getFeePassingWithDb(env.db, makeSession(env.orgBId, env.userBId, 'owner'));
    expect(bView.passAchFeeToMember).toBe(false);
    await setFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), { passAchFeeToMember: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// pay-invoice grossing — ON vs byte-identical OFF
// ════════════════════════════════════════════════════════════════════════════════

describe('payMyInvoice — fee-passing grossing', () => {
  it('OFF (default): PI amount = base, metadata = {invoiceId,orgId}, feeCents=0', async () => {
    const member = await seedMember(env.db, env.orgAId, 'InvOff');
    const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, member, 50_000);
    const fake = new FakeStripeClient();
    const result = await payMyInvoiceWithDb(env.db, makeSession(env.orgAId, member, 'renter'), { invoiceId }, fake);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feeCents).toBe(0);
    expect(result.baseCents).toBe(50_000);
    expect(result.chargedCents).toBe(50_000);
    const call = fake.paymentIntentCalls[0]!;
    expect(call.amountCents).toBe(50_000);
    expect(call.metadata).toEqual({ invoiceId, orgId: env.orgAId });
  });

  it('ON: PI grossed to base+fee, metadata carries {baseCents,feeCents}, record.amount stays BASE', async () => {
    const member = await seedMember(env.db, env.orgAId, 'InvOn');
    const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, member, 50_000);
    await setFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), { passAchFeeToMember: true });
    const fake = new FakeStripeClient();
    const result = await payMyInvoiceWithDb(env.db, makeSession(env.orgAId, member, 'renter'), { invoiceId }, fake);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1% of $500 = $5 = 500¢ (under the $15 cap).
    expect(result.feeCents).toBe(500);
    expect(result.baseCents).toBe(50_000);
    expect(result.chargedCents).toBe(50_500);
    const call = fake.paymentIntentCalls[0]!;
    expect(call.amountCents).toBe(50_500);
    expect(call.metadata).toEqual({ invoiceId, orgId: env.orgAId, baseCents: '50000', feeCents: '500' });

    // The payment_intent_record stores the BASE (what the webhook will credit).
    const recRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(paymentIntentRecord).where(eq(paymentIntentRecord.invoiceId, invoiceId)),
    );
    expect(recRows[0]!.amountCents).toBe(50_000);
    await setFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), { passAchFeeToMember: false });
  });

  it('webhook credit = BASE not gross (fee ON)', async () => {
    const member = await seedMember(env.db, env.orgAId, 'InvWebhook');
    const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, member, 80_000);
    await setFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), { passAchFeeToMember: true });
    const fake = new FakeStripeClient();
    const pay = await payMyInvoiceWithDb(env.db, makeSession(env.orgAId, member, 'renter'), { invoiceId }, fake);
    expect(pay.ok).toBe(true);
    if (!pay.ok) return;
    expect(pay.chargedCents).toBe(80_000 + 800); // $8 fee

    await handleStripeWebhookEvent(
      env.db,
      makeSucceededEventBody('evt_inv_fee', pay.paymentIntentId, pay.chargedCents),
      'sig',
      fake,
    );

    const credits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(ledgerEntry).where(and(eq(ledgerEntry.paymentId, pay.paymentIntentId), eq(ledgerEntry.entryType, 'payment'))),
    );
    expect(credits).toHaveLength(1);
    expect(credits[0]!.amountCents).toBe(80_000); // BASE, not 80_800.
    expect(credits[0]!.direction).toBe('credit');
    await setFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), { passAchFeeToMember: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Pay full balance
// ════════════════════════════════════════════════════════════════════════════════

describe('payMyBalance', () => {
  it('caps: cfi (no portal:access) ⇒ Forbidden', async () => {
    await expect(payMyBalanceWithDb(env.db, makeSession(env.orgAId, env.userAId, 'cfi'), new FakeStripeClient())).rejects.toThrow(ForbiddenError);
  });

  it('no_balance_due when the member owes nothing', async () => {
    const member = await seedMember(env.db, env.orgAId, 'BalNone');
    const result = await payMyBalanceWithDb(env.db, makeSession(env.orgAId, member, 'renter'), new FakeStripeClient());
    expect(result).toEqual({ ok: false, reason: 'no_balance_due' });
  });

  it('OFF: charges the balance magnitude; webhook credit zeroes the balance', async () => {
    const member = await seedMember(env.db, env.orgAId, 'BalOff');
    await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, member, 30_000);
    expect(await memberBalanceFor(env.db, env.orgAId, member)).toBe(-30_000);

    const fake = new FakeStripeClient();
    const pay = await payMyBalanceWithDb(env.db, makeSession(env.orgAId, member, 'renter'), fake);
    expect(pay.ok).toBe(true);
    if (!pay.ok) return;
    expect(pay.baseCents).toBe(30_000);
    expect(pay.feeCents).toBe(0);
    expect(pay.chargedCents).toBe(30_000);
    const call = fake.paymentIntentCalls[0]!;
    expect(call.amountCents).toBe(30_000);
    expect(call.metadata).toMatchObject({ kind: 'balance_payment', baseCents: '30000' });

    await handleStripeWebhookEvent(env.db, makeSucceededEventBody('evt_bal_off', pay.paymentIntentId, 30_000), 'sig', fake);
    expect(await memberBalanceFor(env.db, env.orgAId, member)).toBe(0);

    // The credit is a 'payment' with NO invoice link.
    const credit = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(ledgerEntry).where(eq(ledgerEntry.paymentId, pay.paymentIntentId)),
    );
    expect(credit).toHaveLength(1);
    expect(credit[0]!.amountCents).toBe(30_000);
    expect(credit[0]!.invoiceId).toBeNull();
  });

  it('ON: grosses the charge but webhook credits BASE only', async () => {
    const member = await seedMember(env.db, env.orgAId, 'BalOn');
    await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, member, 200_000); // $2000
    await setFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), { passAchFeeToMember: true });

    const fake = new FakeStripeClient();
    const pay = await payMyBalanceWithDb(env.db, makeSession(env.orgAId, member, 'renter'), fake);
    expect(pay.ok).toBe(true);
    if (!pay.ok) return;
    expect(pay.baseCents).toBe(200_000);
    expect(pay.feeCents).toBe(1000); // 1% of $2000 = $20 → capped at $10.
    expect(pay.chargedCents).toBe(201_000);
    expect(fake.paymentIntentCalls[0]!.amountCents).toBe(201_000);

    await handleStripeWebhookEvent(env.db, makeSucceededEventBody('evt_bal_on', pay.paymentIntentId, 201_000), 'sig', fake);
    expect(await memberBalanceFor(env.db, env.orgAId, member)).toBe(0); // credited BASE 200_000.
    await setFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), { passAchFeeToMember: false });
  });

  it('soft idempotency: a second call returns the in-flight PI, no second charge', async () => {
    const member = await seedMember(env.db, env.orgAId, 'BalIdem');
    await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, member, 12_000);
    const fake = new FakeStripeClient();
    const first = await payMyBalanceWithDb(env.db, makeSession(env.orgAId, member, 'renter'), fake);
    const second = await payMyBalanceWithDb(env.db, makeSession(env.orgAId, member, 'renter'), fake);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.alreadyExists).toBe(true);
    expect(second.paymentIntentId).toBe(first.paymentIntentId);
    expect(fake.paymentIntentCalls).toHaveLength(1);
  });

  it('T-ISO: a balance_payment in org A is invisible under org B context', async () => {
    const member = await seedMember(env.db, env.orgAId, 'BalIso');
    await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, member, 9_000);
    const pay = await payMyBalanceWithDb(env.db, makeSession(env.orgAId, member, 'renter'), new FakeStripeClient());
    expect(pay.ok).toBe(true);
    const bRows = await withOrgContext(env.db, env.orgBId, (tx) => tx.select().from(balancePayment));
    expect(bRows).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// getMyBilling exposes feePassingEnabled
// ════════════════════════════════════════════════════════════════════════════════

describe('getMyBilling.feePassingEnabled', () => {
  it('reflects the org toggle', async () => {
    const member = await seedMember(env.db, env.orgAId, 'BillFlag');
    const off = await getMyBillingWithDb(env.db, makeSession(env.orgAId, member, 'renter'));
    expect(off.feePassingEnabled).toBe(false);
    await setFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), { passAchFeeToMember: true });
    const on = await getMyBillingWithDb(env.db, makeSession(env.orgAId, member, 'renter'));
    expect(on.feePassingEnabled).toBe(true);
    await setFeePassingWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), { passAchFeeToMember: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Graceful absence — 0044 DB (0045 unapplied)
// ════════════════════════════════════════════════════════════════════════════════

describe('graceful absence (migration 0045 unapplied)', () => {
  let env44: { db: PgliteTestClient; pglite: PGlite; orgId: string; ownerId: string };

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL_0044);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    env44 = { db, pglite, orgId: seed.orgAId, ownerId: seed.userAId };
  }, 120_000);

  it('getFeePassing ⇒ available:false, OFF', async () => {
    const view = await getFeePassingWithDb(env44.db, makeSession(env44.orgId, env44.ownerId, 'owner'));
    expect(view).toEqual({ passAchFeeToMember: false, available: false });
  });

  it('setFeePassing ⇒ not_available', async () => {
    const result = await setFeePassingWithDb(env44.db, makeSession(env44.orgId, env44.ownerId, 'owner'), { passAchFeeToMember: true });
    expect(result).toEqual({ ok: false, reason: 'not_available' });
  });

  it('payMyBalance ⇒ not_available', async () => {
    const rows = await withOrgContext(env44.db, env44.orgId, (tx) =>
      tx.insert(appUser).values({ orgId: env44.orgId, email: 'ga@x.test', fullName: 'GA' }).returning({ id: appUser.id }),
    );
    const member = rows[0]!.id;
    await withOrgContext(env44.db, env44.orgId, (tx) => tx.insert(membership).values({ orgId: env44.orgId, userId: member, role: 'renter' }));
    const result = await payMyBalanceWithDb(env44.db, makeSession(env44.orgId, member, 'renter'), new FakeStripeClient());
    expect(result).toEqual({ ok: false, reason: 'not_available' });
  });

  it('payMyInvoice OFF path is byte-identical (no fee column ⇒ base charge)', async () => {
    const rows = await withOrgContext(env44.db, env44.orgId, (tx) =>
      tx.insert(appUser).values({ orgId: env44.orgId, email: 'ga2@x.test', fullName: 'GA2' }).returning({ id: appUser.id }),
    );
    const member = rows[0]!.id;
    await withOrgContext(env44.db, env44.orgId, (tx) => tx.insert(membership).values({ orgId: env44.orgId, userId: member, role: 'renter' }));
    const invoiceId = await seedFinalizedInvoice(env44.db, env44.orgId, env44.ownerId, member, 40_000);
    const fake = new FakeStripeClient();
    const result = await payMyInvoiceWithDb(env44.db, makeSession(env44.orgId, member, 'renter'), { invoiceId }, fake);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feeCents).toBe(0);
    expect(fake.paymentIntentCalls[0]!.amountCents).toBe(40_000);
    expect(fake.paymentIntentCalls[0]!.metadata).toEqual({ invoiceId, orgId: env44.orgId });
  });
});

// ── helper: member balance via billing_account join ──────────────────────────
async function memberBalanceFor(db: PgliteTestClient, orgId: string, userId: string): Promise<number> {
  // The member's ledger entries live under their billing_account; getMyBilling
  // computes exactly this, so reuse it for a faithful balance.
  const billing = await getMyBillingWithDb(db, makeSession(orgId, userId, 'renter'));
  return billing.balanceCents;
}
