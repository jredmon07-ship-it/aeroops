/**
 * portal-self-pay.test.ts — Integration tests for Slice P0-REV: the portal
 * self-pay surface (getMyBilling / saveMyPaymentMethod / setMyAutopay /
 * payMyInvoice) + the setup_intent.succeeded webhook backstop + tenant
 * isolation on the new P0-REV tables.
 *
 * Applies migrations 0000–0025. Every test injects a FAKE StripeClient —
 * never a real HTTP call.
 *
 * COVERAGE:
 *   10. Tenant isolation on saved PMs / autopay / dues; portal self-scope:
 *       user X in org A cannot pay or see user Y's invoice.
 *   11. Setup-intent PM recording dedup across paths (confirm-callback THEN
 *       webhook backstop for the SAME pm_id → exactly ONE row). Webhook
 *       resolves org via resolveOrgByStripeCustomerId only, never trusting
 *       payload metadata blindly (mismatched metadata is rejected).
 *   12. Capabilities: portal:access required for all getMyBilling / setMyAutopay /
 *       payMyInvoice / saveMyPaymentMethod (renter passes; cfi fails).
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
  stripePaymentMethod,
  invoice as invoiceTable,
  invoiceLineItem,
  loadMigrationSql,
} from '@aeroops/db';
import { eq } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { getMyBillingWithDb } from '../portal/get-my-billing.js';
import { saveMyPaymentMethodWithDb } from '../portal/save-payment-method.js';
import { setMyAutopayWithDb } from '../portal/set-autopay.js';
import { payMyInvoiceWithDb } from '../portal/pay-invoice.js';
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

// All up migrations through 0025 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0025');

// ── Fake StripeClient — NO real HTTP call, ever ────────────────────────────────

let globalCustomerCounter = 0;
let globalPiCounter = 0;
let globalSetupCounter = 0;

class FakeStripeClient implements StripeClient {
  customerCalls: StripeCreateCustomerInput[] = [];
  paymentIntentCalls: StripeCreatePaymentIntentInput[] = [];
  /** Configurable per-instance so tests control the returned display fields. */
  nextAttach: StripePaymentMethodDisplay | null = null;

  async createCustomer(input: StripeCreateCustomerInput): Promise<StripeCustomerResult> {
    globalCustomerCounter += 1;
    this.customerCalls.push(input);
    return { stripeCustomerId: `cus_fake_${globalCustomerCounter}` };
  }

  async createPaymentIntent(input: StripeCreatePaymentIntentInput): Promise<StripePaymentIntentResult> {
    globalPiCounter += 1;
    this.paymentIntentCalls.push(input);
    return {
      stripePaymentIntentId: `pi_fake_${globalPiCounter}`,
      clientSecret: `pi_fake_${globalPiCounter}_secret_abc`,
      status: 'requires_payment_method',
    };
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<StripeRetrievePaymentIntentResult> {
    return { stripePaymentIntentId: paymentIntentId, status: 'succeeded', amountCents: 0 };
  }

  async constructWebhookEvent(rawBody: string, _signatureHeader: string | null): Promise<StripeWebhookEvent> {
    return JSON.parse(rawBody) as StripeWebhookEvent;
  }

  async createSetupIntent(_input: StripeCreateSetupIntentInput): Promise<StripeSetupIntentResult> {
    globalSetupCounter += 1;
    return {
      stripeSetupIntentId: `seti_fake_${globalSetupCounter}`,
      clientSecret: `seti_fake_${globalSetupCounter}_secret_abc`,
      status: 'requires_payment_method',
    };
  }

  async attachPaymentMethod(input: StripeAttachPaymentMethodInput): Promise<StripePaymentMethodDisplay> {
    if (this.nextAttach) return this.nextAttach;
    return {
      stripePaymentMethodId: input.paymentMethodId,
      type: 'card',
      last4: '4242',
      brand: 'Visa',
    };
  }
}

function makeSetupIntentSucceededBody(eventId: string, customerId: string, paymentMethodId: string, userId?: string): string {
  return JSON.stringify({
    id: eventId,
    type: 'setup_intent.succeeded',
    data: {
      object: {
        id: 'seti_webhook_test',
        customer: customerId,
        payment_method: paymentMethodId,
        status: 'succeeded',
        metadata: userId ? { userId } : {},
      },
    },
  });
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
  const row = rows[0];
  if (!row) throw new Error('seedMember: INSERT returned no row');
  await withOrgContext(db, orgId, (tx) =>
    tx.insert(membership).values({ orgId, userId: row.id, role: 'renter' }),
  );
  return row.id;
}

async function seedFinalizedInvoiceDirect(
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
  const invoiceRow = invoiceRows[0];
  if (!invoiceRow) throw new Error('seed invoice failed');
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
  const sess = makeSession(orgId, ownerUserId, 'owner');
  const finR = await finalizeInvoiceWithDb(db, sess, { id: invoiceRow.id }, new StubStripeClient());
  if (!finR.ok) throw new Error('seed finalize failed');
  return invoiceRow.id;
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
// 12. CAPS
// ════════════════════════════════════════════════════════════════════════════════

describe('caps — portal:access required for every self-pay command', () => {
  it('getMyBilling: null session ⇒ Unauthenticated', async () => {
    await expect(getMyBillingWithDb(env.db, null)).rejects.toThrow(UnauthenticatedError);
  });

  it('getMyBilling: cfi (no portal:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'cfi');
    await expect(getMyBillingWithDb(env.db, sess)).rejects.toThrow(ForbiddenError);
  });

  it('getMyBilling: renter (portal:access) is allowed', async () => {
    const member = await seedMember(env.db, env.orgAId, 'CapsGetBillingOk');
    const sess = makeSession(env.orgAId, member, 'renter');
    const result = await getMyBillingWithDb(env.db, sess);
    expect(result.balanceCents).toBe(0);
  });

  it('setMyAutopay: dispatcher (no portal:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(setMyAutopayWithDb(env.db, sess, { enabled: false })).rejects.toThrow(ForbiddenError);
  });

  it('payMyInvoice: mechanic (no portal:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'mechanic');
    await expect(
      payMyInvoiceWithDb(env.db, sess, { invoiceId: '00000000-0000-0000-0000-000000000000' }, new FakeStripeClient()),
    ).rejects.toThrow(ForbiddenError);
  });

  it('saveMyPaymentMethod: accountant (no portal:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      saveMyPaymentMethodWithDb(env.db, sess, { paymentMethodId: 'pm_x' }, new FakeStripeClient()),
    ).rejects.toThrow(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// payMyInvoice — self-scope + happy path
// ════════════════════════════════════════════════════════════════════════════════

describe('payMyInvoice', () => {
  it('not_found for a NONEXISTENT invoice', async () => {
    const member = await seedMember(env.db, env.orgAId, 'PayNotFound');
    const sess = makeSession(env.orgAId, member, 'renter');
    const result = await payMyInvoiceWithDb(
      env.db, sess, { invoiceId: '00000000-0000-0000-0000-000000000000' }, new FakeStripeClient(),
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('self-scope: user X cannot pay user Y\'s invoice → not_found (zero-IDOR)', async () => {
    const memberY = await seedMember(env.db, env.orgAId, 'PayIdorY');
    const memberX = await seedMember(env.db, env.orgAId, 'PayIdorX');
    const invoiceId = await seedFinalizedInvoiceDirect(env.db, env.orgAId, env.userAId, memberY, 9900);

    const sessX = makeSession(env.orgAId, memberX, 'renter');
    const result = await payMyInvoiceWithDb(env.db, sessX, { invoiceId }, new FakeStripeClient());
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('happy path: pays own finalized invoice, creates exactly ONE PaymentIntent (NOT off-session)', async () => {
    const member = await seedMember(env.db, env.orgAId, 'PayHappy');
    const invoiceId = await seedFinalizedInvoiceDirect(env.db, env.orgAId, env.userAId, member, 15000);
    const fake = new FakeStripeClient();

    const sess = makeSession(env.orgAId, member, 'renter');
    const result = await payMyInvoiceWithDb(env.db, sess, { invoiceId }, fake);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyExists).toBe(false);
    expect(fake.paymentIntentCalls).toHaveLength(1);
    expect(fake.paymentIntentCalls[0]!.amountCents).toBe(15000);
    expect(fake.paymentIntentCalls[0]!.offSession).toBeFalsy();
  });

  it('not_configured on a StubStripeClient — never a crash', async () => {
    const member = await seedMember(env.db, env.orgAId, 'PayStub');
    const invoiceId = await seedFinalizedInvoiceDirect(env.db, env.orgAId, env.userAId, member, 6600);
    const sess = makeSession(env.orgAId, member, 'renter');
    const result = await payMyInvoiceWithDb(env.db, sess, { invoiceId }, new StubStripeClient());
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 11. Setup-intent PM recording — dedup across paths
// ════════════════════════════════════════════════════════════════════════════════

describe('setup-intent PM recording — dedup across confirm-callback + webhook backstop', () => {
  it('confirm-callback THEN webhook for the SAME pm_id → exactly ONE stripe_payment_method row', async () => {
    const member = await seedMember(env.db, env.orgAId, 'SetupDedup');
    const fake = new FakeStripeClient();
    fake.nextAttach = { stripePaymentMethodId: 'pm_dedup_shared', type: 'card', last4: '1111', brand: 'Visa' };

    const sess = makeSession(env.orgAId, member, 'renter');
    const saveR = await saveMyPaymentMethodWithDb(env.db, sess, { paymentMethodId: 'pm_dedup_shared' }, fake);
    expect(saveR.ok).toBe(true);
    if (!saveR.ok) return;
    const stripeCustomerId = fake.customerCalls.length > 0 ? `cus_fake_${globalCustomerCounter}` : '';
    void stripeCustomerId;

    // Find the stripe_customer_id that was actually persisted for this member.
    const pmRowsBefore = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(stripePaymentMethod).where(eq(stripePaymentMethod.stripePaymentMethodId, 'pm_dedup_shared')),
    );
    expect(pmRowsBefore).toHaveLength(1);
    const custId = pmRowsBefore[0]!.stripeCustomerId;

    // Deliver the webhook for the SAME pm_id — must be a harmless no-op.
    const body = makeSetupIntentSucceededBody('evt_setup_dedup_1', custId, 'pm_dedup_shared', member);
    const whR = await handleStripeWebhookEvent(env.db, body, 'sig', fake);
    expect(whR.ok).toBe(true);

    const pmRowsAfter = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(stripePaymentMethod).where(eq(stripePaymentMethod.stripePaymentMethodId, 'pm_dedup_shared')),
    );
    expect(pmRowsAfter).toHaveLength(1);
    expect(pmRowsAfter[0]!.id).toBe(pmRowsBefore[0]!.id);
  });

  it('webhook alone (no prior confirm-callback) records a stripe_payment_method row, resolving org from OUR stripe_customer only', async () => {
    const member = await seedMember(env.db, env.orgAId, 'SetupWebhookOnly');
    const fake = new FakeStripeClient();
    // Establish a stripe_customer for this member via a setup-intent request first
    // (this always happens before a real SetupIntent is created, ensuring
    // ensureStripeCustomerTx has run) — simulate by calling saveMyPaymentMethod
    // for a DIFFERENT pm, which ensures the customer row exists.
    const sess = makeSession(env.orgAId, member, 'renter');
    const seedSaveR = await saveMyPaymentMethodWithDb(env.db, sess, { paymentMethodId: 'pm_seed_customer_only' }, fake);
    expect(seedSaveR.ok).toBe(true);

    const custRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(stripePaymentMethod).where(eq(stripePaymentMethod.userId, member)),
    );
    const custId = custRows[0]!.stripeCustomerId;

    const body = makeSetupIntentSucceededBody('evt_setup_webhook_only', custId, 'pm_webhook_only_new', member);
    const whR = await handleStripeWebhookEvent(env.db, body, 'sig', fake);
    expect(whR.ok).toBe(true);

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(stripePaymentMethod).where(eq(stripePaymentMethod.stripePaymentMethodId, 'pm_webhook_only_new')),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(member);
  });

  it('a mismatched metadata.userId is rejected (never trusted as the org/user source of truth)', async () => {
    const member = await seedMember(env.db, env.orgAId, 'SetupMismatch');
    const other = await seedMember(env.db, env.orgAId, 'SetupMismatchOther');
    const fake = new FakeStripeClient();
    const sess = makeSession(env.orgAId, member, 'renter');
    const seedSaveR = await saveMyPaymentMethodWithDb(env.db, sess, { paymentMethodId: 'pm_seed_mismatch' }, fake);
    expect(seedSaveR.ok).toBe(true);
    const custRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(stripePaymentMethod).where(eq(stripePaymentMethod.userId, member)),
    );
    const custId = custRows[0]!.stripeCustomerId;

    // metadata.userId claims to be `other`, but the customer really belongs
    // to `member` — the webhook must NOT record this PM.
    const body = makeSetupIntentSucceededBody('evt_setup_mismatch', custId, 'pm_mismatch_should_not_record', other);
    const whR = await handleStripeWebhookEvent(env.db, body, 'sig', fake);
    expect(whR.ok).toBe(true);

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(stripePaymentMethod).where(eq(stripePaymentMethod.stripePaymentMethodId, 'pm_mismatch_should_not_record')),
    );
    expect(rows).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 10. T-ISO — tenant isolation
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO — tenant isolation on P0-REV tables', () => {
  it('org B cannot see org A saved payment methods via getMyBilling / raw RLS', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoPmA');
    const fake = new FakeStripeClient();
    const sessA = makeSession(env.orgAId, memberA, 'renter');
    await saveMyPaymentMethodWithDb(env.db, sessA, { paymentMethodId: 'pm_iso_a' }, fake);

    const rowsFromB = await withOrgContext(env.db, env.orgBId, (tx) =>
      tx.select().from(stripePaymentMethod).where(eq(stripePaymentMethod.stripePaymentMethodId, 'pm_iso_a')),
    );
    expect(rowsFromB).toHaveLength(0);
  });

  it('payMyInvoice for a user in org A never surfaces an org B invoice', async () => {
    const memberB = await seedMember(env.db, env.orgBId, 'IsoInvB');
    const invoiceIdB = await seedFinalizedInvoiceDirect(env.db, env.orgBId, env.userBId, memberB, 12300);

    const memberA = await seedMember(env.db, env.orgAId, 'IsoInvA');
    const sessA = makeSession(env.orgAId, memberA, 'renter');
    const result = await payMyInvoiceWithDb(env.db, sessA, { invoiceId: invoiceIdB }, new FakeStripeClient());
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('getMyBilling for an org A member never includes org B invoices/PMs', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoBillingA');
    await seedFinalizedInvoiceDirect(env.db, env.orgAId, env.userAId, memberA, 4400);

    const memberB = await seedMember(env.db, env.orgBId, 'IsoBillingB');
    await seedFinalizedInvoiceDirect(env.db, env.orgBId, env.userBId, memberB, 8800);

    const sessA = makeSession(env.orgAId, memberA, 'renter');
    const billingA = await getMyBillingWithDb(env.db, sessA);
    expect(billingA.invoices.every((i) => i.memberUserId === memberA)).toBe(true);
    expect(billingA.invoices.some((i) => i.totalCents === 8800)).toBe(false);
  });
});
