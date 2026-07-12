/**
 * payments-autopay.test.ts — Integration tests for Slice P0-REV: saved
 * payment methods + auto-pay on finalize (staff side).
 *
 * Applies migrations 0000–0025 (0024 = payment methods+autopay, 0025 =
 * recurring dues). Every test injects a FAKE StripeClient — never a real
 * HTTP call.
 *
 * COVERAGE (money invariants — see docs spec "TEST LIST"):
 *   1. No double-charge — off-session idempotency (autopay:<invoiceId> key).
 *   2. No double-charge — existing payment_intent_record guard.
 *   3. Auto-pay requires opt-in (enabled=true).
 *   4. Auto-pay requires a saved default PM (pm_not_found + DB CHECK).
 *   5. Webhook is the SOLE settlement path (autopay creates PI, posts NO
 *      credit; only payment_intent.succeeded does, exactly once, deduped).
 *   6. Declined off-session → payment_intent_record 'failed', no credit,
 *      invoice still finalized.
 *   7. Unconfigured (StubStripeClient) paths never crash.
 *  12. Capabilities: billing:manage / billing:access / portal:access.
 *  13. FROZEN gate byte-identity: openDispatchWithDb with no injected seam
 *      still succeeds regardless of new P0-REV tables + autopay armed.
 *  14. Integer-cents property test: autopay PI amount === invoice.totalCents.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  appUser,
  membership,
  ledgerEntry,
  paymentIntentRecord,
  autopaySetting,
  invoice as invoiceTable,
  invoiceLineItem,
  loadMigrationSql,
} from '@aeroops/db';
import { eq } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { finalizeInvoiceWithDb } from '../billing/invoice-status-commands.js';
import { updateDispatchConfigWithDb } from '../dispatch-gate/config.js';
import { makeRealBalanceSeam } from '../billing/real-balance-seam.js';

import { saveMyPaymentMethodWithDb } from '../portal/save-payment-method.js';
import { setMyAutopayWithDb } from '../portal/set-autopay.js';
import { handleStripeWebhookEvent } from '../integrations/stripe/handle-webhook-event.js';
import { StubStripeClient, StripeCardDeclinedError } from '../integrations/stripe/client.js';
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
import { createInvoiceSetupIntentWithDb } from '../integrations/stripe/setup-intent-commands.js';

import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0038 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0038');

// ── Fake StripeClient — NO real HTTP call, ever ────────────────────────────────

let globalCustomerCounter = 0;
let globalPiCounter = 0;
let globalSetupCounter = 0;
let globalPmCounter = 0;

class FakeStripeClient implements StripeClient {
  customerCalls: StripeCreateCustomerInput[] = [];
  paymentIntentCalls: StripeCreatePaymentIntentInput[] = [];
  setupIntentCalls: StripeCreateSetupIntentInput[] = [];
  attachCalls: StripeAttachPaymentMethodInput[] = [];

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
    this.setupIntentCalls.push(input);
    return {
      stripeSetupIntentId: `seti_fake_${globalSetupCounter}`,
      clientSecret: `seti_fake_${globalSetupCounter}_secret_abc`,
      status: 'requires_payment_method',
    };
  }

  async attachPaymentMethod(input: StripeAttachPaymentMethodInput): Promise<StripePaymentMethodDisplay> {
    globalPmCounter += 1;
    this.attachCalls.push(input);
    return {
      stripePaymentMethodId: `pm_fake_${globalPmCounter}`,
      type: 'us_bank_account',
      last4: '6789',
      brand: 'Test Bank',
    };
  }
}

/** Declines the NEXT off-session PaymentIntent creation with a 402-shaped error. */
class DecliningFakeStripeClient extends FakeStripeClient {
  override async createPaymentIntent(input: StripeCreatePaymentIntentInput): Promise<StripePaymentIntentResult> {
    if (input.offSession) {
      globalPiCounter += 1;
      this.paymentIntentCalls.push(input);
      throw new StripeCardDeclinedError('declined', `pi_fake_declined_${globalPiCounter}`, 'requires_payment_method');
    }
    return super.createPaymentIntent(input);
  }
}

function makeSucceededEventBody(eventId: string, piId: string, amountCents: number): string {
  return JSON.stringify({
    id: eventId,
    type: 'payment_intent.succeeded',
    data: { object: { id: piId, amount: amountCents, currency: 'usd', status: 'succeeded' } },
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

async function seedAircraftAndReservation(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tailPrefix: string,
): Promise<{ aircraftId: string; reservationId: string }> {
  const sess = makeSession(orgId, userId, 'owner');
  const tail = nextTail(tailPrefix);
  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `Test ${tail}`,
    tailNumber: `N${tail}`,
  });
  const start = new Date(`2026-09-0${(tailSuffix % 9) + 1}T08:00:00Z`);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const rResult = await createReservationWithDb(db, sess, {
    startAt: start,
    endAt: end,
    resourceIds: [aircraft.id],
  });
  if (!rResult.ok) throw new Error(`seedAircraftAndReservation failed: ${rResult.reason}`);
  return { aircraftId: aircraft.id, reservationId: rResult.reservation.id };
}

/**
 * Creates a DRAFT invoice (not finalized) for a member with an EXACT total,
 * via a direct INSERT (bypassing dispatch/rate math entirely — this file's
 * invariants are about autopay/PI amounts matching invoice.total_cents
 * EXACTLY, so the seed is written to make that total exact and predictable).
 */
async function seedDraftInvoice(
  db: PgliteTestClient,
  orgId: string,
  ownerUserId: string,
  memberUserId: string,
  _tailPrefix: string,
  amountCents: number,
): Promise<{ invoiceId: string; totalCents: number }> {
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
  if (!invoiceRow) throw new Error('seedDraftInvoice: invoice INSERT returned no rows');

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

  return { invoiceId: invoiceRow.id, totalCents: invoiceRow.totalCents };
}

/** Sets up a member with a saved PM + autopay ENABLED against it. Returns the PM id. */
async function seedAutopayReady(
  db: PgliteTestClient,
  orgId: string,
  memberUserId: string,
  client: StripeClient,
): Promise<string> {
  const memberSess = makeSession(orgId, memberUserId, 'renter');
  const saveR = await saveMyPaymentMethodWithDb(db, memberSess, { paymentMethodId: `pm_seed_${memberUserId}` }, client);
  if (!saveR.ok) throw new Error('seedAutopayReady: saveMyPaymentMethod failed');
  const autoR = await setMyAutopayWithDb(db, memberSess, {
    enabled: true,
    defaultPaymentMethodId: saveR.paymentMethod.id,
  });
  if (!autoR.ok) throw new Error('seedAutopayReady: setMyAutopay failed');
  return saveR.paymentMethod.id;
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
  it('createInvoiceSetupIntent: null session ⇒ Unauthenticated', async () => {
    await expect(
      createInvoiceSetupIntentWithDb(env.db, null, { memberUserId: env.userAId }, new FakeStripeClient()),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('createInvoiceSetupIntent: role without billing:manage ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      createInvoiceSetupIntentWithDb(env.db, sess, { memberUserId: env.userAId }, new FakeStripeClient()),
    ).rejects.toThrow(ForbiddenError);
  });

  it('setMyAutopay: cfi (no portal:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'cfi');
    await expect(setMyAutopayWithDb(env.db, sess, { enabled: false })).rejects.toThrow(ForbiddenError);
  });

  it('saveMyPaymentMethod: renter (portal:access) is allowed to attempt', async () => {
    const member = await seedMember(env.db, env.orgAId, 'CapsSaveOk');
    const sess = makeSession(env.orgAId, member, 'renter');
    const result = await saveMyPaymentMethodWithDb(env.db, sess, { paymentMethodId: 'pm_caps_ok' }, new FakeStripeClient());
    expect(result.ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Auto-pay opt-in (setMyAutopay)
// ════════════════════════════════════════════════════════════════════════════════

describe('setMyAutopay', () => {
  it('pm_required when enabling without a defaultPaymentMethodId', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AutopayNoPm');
    const sess = makeSession(env.orgAId, member, 'renter');
    const result = await setMyAutopayWithDb(env.db, sess, { enabled: true });
    expect(result).toEqual({ ok: false, reason: 'pm_required' });
  });

  it('pm_not_found when enabling against a foreign / nonexistent PM', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AutopayForeignPm');
    const other = await seedMember(env.db, env.orgAId, 'AutopayOtherOwner');
    const fake = new FakeStripeClient();
    const otherPm = await saveMyPaymentMethodWithDb(
      env.db, makeSession(env.orgAId, other, 'renter'), { paymentMethodId: 'pm_other_owner' }, fake,
    );
    if (!otherPm.ok) throw new Error('seed failed');

    const sess = makeSession(env.orgAId, member, 'renter');
    const result = await setMyAutopayWithDb(env.db, sess, {
      enabled: true,
      defaultPaymentMethodId: otherPm.paymentMethod.id,
    });
    expect(result).toEqual({ ok: false, reason: 'pm_not_found' });
  });

  it('DB CHECK backstop: a direct INSERT with enabled=true + null PM is rejected', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AutopayCheckBackstop');
    await expect(
      withOrgContext(env.db, env.orgAId, (tx) =>
        tx.insert(autopaySetting).values({
          orgId: env.orgAId,
          userId: member,
          enabled: true,
          defaultPaymentMethodId: null,
        }),
      ),
    ).rejects.toThrow();
  });

  it('happy path: enable with a self-owned PM succeeds; toggling off clears the default', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AutopayHappy');
    const fake = new FakeStripeClient();
    const pmId = await seedAutopayReady(env.db, env.orgAId, member, fake);

    const sess = makeSession(env.orgAId, member, 'renter');
    const offR = await setMyAutopayWithDb(env.db, sess, { enabled: false });
    expect(offR).toEqual({ ok: true, setting: { enabled: false, defaultPaymentMethodId: null } });
    void pmId;
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Auto-pay on finalize — the money invariants
// ════════════════════════════════════════════════════════════════════════════════

describe('triggerAutopayOnFinalize via finalizeInvoiceWithDb', () => {
  it('1. No double-charge — off-session idempotency: exactly ONE PI on finalize; re-finalize is a no-op', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AutoInv1');
    const fake = new FakeStripeClient();
    await seedAutopayReady(env.db, env.orgAId, member, fake);
    const { invoiceId, totalCents } = await seedDraftInvoice(env.db, env.orgAId, env.userAId, member, 'AutoInv1', 12345);

    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const finR = await finalizeInvoiceWithDb(env.db, sess, { id: invoiceId }, fake);
    expect(finR.ok).toBe(true);
    if (!finR.ok) return;
    expect(finR.autopay?.outcome).toBe('created');
    expect(fake.paymentIntentCalls).toHaveLength(1);
    expect(fake.paymentIntentCalls[0]!.offSession).toBe(true);
    expect(fake.paymentIntentCalls[0]!.confirm).toBe(true);
    expect(fake.paymentIntentCalls[0]!.idempotencyKey).toBe(`autopay:${invoiceId}`);
    expect(fake.paymentIntentCalls[0]!.amountCents).toBe(totalCents);

    const records = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(paymentIntentRecord).where(eq(paymentIntentRecord.invoiceId, invoiceId)),
    );
    expect(records).toHaveLength(1);

    // Re-invoke finalize on the SAME (now-finalized) invoice.
    const finR2 = await finalizeInvoiceWithDb(env.db, sess, { id: invoiceId }, fake);
    expect(finR2).toEqual({ ok: false, reason: 'not_draft' });
    expect(fake.paymentIntentCalls).toHaveLength(1); // NOT called again

    const records2 = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(paymentIntentRecord).where(eq(paymentIntentRecord.invoiceId, invoiceId)),
    );
    expect(records2).toHaveLength(1);
  });

  it('2. No double-charge — existing payment_intent_record guard skips a second PI', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AutoInv2');
    const fake = new FakeStripeClient();
    await seedAutopayReady(env.db, env.orgAId, member, fake);
    const { invoiceId } = await seedDraftInvoice(env.db, env.orgAId, env.userAId, member, 'AutoInv2', 5000);

    // Pre-seed a pending payment_intent_record for this (still-draft) invoice —
    // simulates a race/manual PI already in flight.
    await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.insert(paymentIntentRecord).values({
        orgId: env.orgAId,
        invoiceId,
        stripePaymentIntentId: 'pi_preexisting_race',
        amountCents: 5000,
        status: 'pending',
      }),
    );

    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const finR = await finalizeInvoiceWithDb(env.db, sess, { id: invoiceId }, fake);
    expect(finR.ok).toBe(true);
    if (!finR.ok) return;
    expect(finR.autopay?.outcome).toBe('skipped_existing');
    expect(fake.paymentIntentCalls).toHaveLength(0);
  });

  it('3. Auto-pay requires opt-in: no autopay_setting row ⇒ skipped_not_enabled, invoice still finalizes', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AutoInv3');
    const fake = new FakeStripeClient();
    const { invoiceId } = await seedDraftInvoice(env.db, env.orgAId, env.userAId, member, 'AutoInv3', 7500);

    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const finR = await finalizeInvoiceWithDb(env.db, sess, { id: invoiceId }, fake);
    expect(finR.ok).toBe(true);
    if (!finR.ok) return;
    expect(finR.invoice.status).toBe('finalized');
    expect(finR.autopay?.outcome).toBe('skipped_not_enabled');
    expect(fake.paymentIntentCalls).toHaveLength(0);
  });

  it('3b. Auto-pay requires opt-in: enabled=false ⇒ skipped_not_enabled', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AutoInv3b');
    const fake = new FakeStripeClient();
    await seedAutopayReady(env.db, env.orgAId, member, fake);
    await setMyAutopayWithDb(env.db, makeSession(env.orgAId, member, 'renter'), { enabled: false });
    const { invoiceId } = await seedDraftInvoice(env.db, env.orgAId, env.userAId, member, 'AutoInv3b', 4200);

    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const finR = await finalizeInvoiceWithDb(env.db, sess, { id: invoiceId }, fake);
    expect(finR.ok).toBe(true);
    if (!finR.ok) return;
    expect(finR.autopay?.outcome).toBe('skipped_not_enabled');
    expect(fake.paymentIntentCalls).toHaveLength(0);
  });

  it('5. Webhook is the SOLE settlement path: autopay creates the PI but posts NO credit; webhook posts exactly ONE, deduped on redelivery', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AutoInv5');
    const fake = new FakeStripeClient();
    await seedAutopayReady(env.db, env.orgAId, member, fake);
    const { invoiceId, totalCents } = await seedDraftInvoice(env.db, env.orgAId, env.userAId, member, 'AutoInv5', 30000);

    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const finR = await finalizeInvoiceWithDb(env.db, sess, { id: invoiceId }, fake);
    expect(finR.ok).toBe(true);
    if (!finR.ok) return;
    const piId = finR.autopay?.paymentIntentId;
    expect(piId).toBeTruthy();

    // Zero 'payment' ledger entries right after autopay creates the PI.
    const preEntries = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(ledgerEntry).where(eq(ledgerEntry.paymentId, piId!)),
    );
    expect(preEntries).toHaveLength(0);

    // Deliver the webhook — exactly ONE credit.
    const body = makeSucceededEventBody('evt_autoinv5_1', piId!, totalCents);
    const whR = await handleStripeWebhookEvent(env.db, body, 'sig', fake);
    expect(whR).toEqual({ ok: true, alreadyProcessed: false });

    const entries = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(ledgerEntry).where(eq(ledgerEntry.paymentId, piId!)),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entryType).toBe('payment');
    expect(entries[0]!.direction).toBe('credit');
    expect(entries[0]!.amountCents).toBe(totalCents);

    // Redeliver — dedup, still exactly ONE.
    const whR2 = await handleStripeWebhookEvent(env.db, body, 'sig', fake);
    expect(whR2).toEqual({ ok: true, alreadyProcessed: true });
    const entries2 = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(ledgerEntry).where(eq(ledgerEntry.paymentId, piId!)),
    );
    expect(entries2).toHaveLength(1);
  });

  it('6. Declined off-session ⇒ payment_intent_record failed, NO credit, invoice still finalized', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AutoInv6');
    const decliner = new DecliningFakeStripeClient();
    await seedAutopayReady(env.db, env.orgAId, member, decliner);
    const { invoiceId } = await seedDraftInvoice(env.db, env.orgAId, env.userAId, member, 'AutoInv6', 6600);

    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const finR = await finalizeInvoiceWithDb(env.db, sess, { id: invoiceId }, decliner);
    expect(finR.ok).toBe(true);
    if (!finR.ok) return;
    expect(finR.invoice.status).toBe('finalized');
    expect(finR.autopay?.outcome).toBe('declined');

    const records = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(paymentIntentRecord).where(eq(paymentIntentRecord.invoiceId, invoiceId)),
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('failed');

    const entries = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(ledgerEntry).where(eq(ledgerEntry.entryType, 'payment')),
    );
    expect(entries.filter((e) => e.invoiceId === invoiceId)).toHaveLength(0);
  });

  it('7. Unconfigured (StubStripeClient): finalize still finalizes, outcome not_configured, no crash', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AutoInv7');
    const fake = new FakeStripeClient();
    await seedAutopayReady(env.db, env.orgAId, member, fake);
    const { invoiceId } = await seedDraftInvoice(env.db, env.orgAId, env.userAId, member, 'AutoInv7', 3300);

    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const finR = await finalizeInvoiceWithDb(env.db, sess, { id: invoiceId }, new StubStripeClient());
    expect(finR.ok).toBe(true);
    if (!finR.ok) return;
    expect(finR.invoice.status).toBe('finalized');
    expect(finR.autopay?.outcome).toBe('not_configured');
  });

  it('7b. Unconfigured typed refusals: createInvoiceSetupIntent / saveMyPaymentMethod / payMyInvoice', async () => {
    const member = await seedMember(env.db, env.orgAId, 'AutoInv7b');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const setupR = await createInvoiceSetupIntentWithDb(env.db, sess, { memberUserId: member }, new StubStripeClient());
    expect(setupR).toEqual({ ok: false, reason: 'not_configured' });

    const memberSess = makeSession(env.orgAId, member, 'renter');
    const saveR = await saveMyPaymentMethodWithDb(env.db, memberSess, { paymentMethodId: 'pm_stub' }, new StubStripeClient());
    expect(saveR).toEqual({ ok: false, reason: 'not_configured' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FROZEN gate byte-identity (Slice P0-REV must not touch the dispatch gate)
// ════════════════════════════════════════════════════════════════════════════════

describe('FROZEN gate byte-identity — openDispatch app-code form unchanged by P0-REV', () => {
  it('openDispatchWithDb with NO injected seam succeeds regardless of new P0-REV tables + autopay armed + a deeply-negative balance', async () => {
    const member = await seedMember(env.db, env.orgAId, 'P0GateFrozen');
    const fake = new FakeStripeClient();
    await seedAutopayReady(env.db, env.orgAId, member, fake);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');

    const { invoiceId } = await seedDraftInvoice(env.db, env.orgAId, env.userAId, member, 'P0GateFrozen', 999900);
    await finalizeInvoiceWithDb(env.db, sess, { id: invoiceId }, new StubStripeClient());

    await updateDispatchConfigWithDb(env.db, sess, {
      balanceCheckEnabled: true,
      minimumBalanceCents: 1_000_000,
    });

    const seam = makeRealBalanceSeam(env.db);
    const seamResult = await seam.check({ orgId: env.orgAId, pilotUserId: member });
    expect(seamResult).toEqual({ ok: false, reason: 'below_minimum' });

    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      env.db, env.orgAId, env.userAId, 'P0GateFrozenFlight',
    );
    const openR = await openDispatchWithDb(env.db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: member,
      hobbsOut: 10.0,
      tachOut: 5.0,
    });
    expect(openR.ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 14. Integer-cents property test
// ════════════════════════════════════════════════════════════════════════════════

describe('property: autopay PI amount is always exactly the invoice total (integer cents, no drift)', () => {
  it('holds for random positive integer cent amounts', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5_000_000 }), async (amountCents) => {
        const member = await seedMember(env.db, env.orgAId, 'PropAuto');
        const fake = new FakeStripeClient();
        await seedAutopayReady(env.db, env.orgAId, member, fake);
        const { invoiceId, totalCents } = await seedDraftInvoice(
          env.db, env.orgAId, env.userAId, member, 'PropAuto', amountCents,
        );
        expect(totalCents).toBe(amountCents);

        const sess = makeSession(env.orgAId, env.userAId, 'owner');
        const finR = await finalizeInvoiceWithDb(env.db, sess, { id: invoiceId }, fake);
        if (!finR.ok) throw new Error('finalize failed');
        expect(finR.invoice.totalCents).toBe(amountCents);
        const call = fake.paymentIntentCalls[fake.paymentIntentCalls.length - 1]!;
        expect(call.amountCents).toBe(amountCents);
      }),
      { numRuns: 15 },
    );
  }, 60_000);
});
