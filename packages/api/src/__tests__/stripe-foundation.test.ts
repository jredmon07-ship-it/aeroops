/**
 * stripe-foundation.test.ts — Integration tests for Slice B3-foundation
 * (Stripe seam to the key boundary — NO real Stripe call anywhere).
 *
 * Applies migrations 0000–0023 (0023 = stripe_foundation tables).
 * Every test injects a FAKE StripeClient — never a real HTTP call.
 *
 * COVERAGE:
 *   CAPS: billing:manage (createInvoicePaymentIntent), billing:access
 *     (getPaymentStatus) enforced.
 *   createInvoicePaymentIntent: not_found, not_finalized, not_configured
 *     (StubStripeClient), happy path (fake client records exactly one
 *     createPaymentIntent call), idempotent (second call ⇒ alreadyExists,
 *     fake client NOT called again).
 *   getPaymentStatus: null before any PaymentIntent; the record after one is
 *     created; not_found for an unknown invoice.
 *   WEBHOOK: not_configured (Stub client), invalid_signature (fake throws),
 *     succeeded → posts ONE 'payment' credit ledger_entry + payment_intent_record
 *     flips to 'succeeded'; DEDUP — the SAME event delivered twice posts
 *     exactly ONE ledger_entry (second delivery ⇒ alreadyProcessed:true);
 *     an unresolvable PaymentIntent id (no matching record) ⇒ ok, no ledger
 *     entry, but the event is still deduped (2nd delivery ⇒ alreadyProcessed).
 *   T-ISO: org B cannot getPaymentStatus for an org A invoice.
 *   STUB (not_configured) PATHS: StubStripeClient throws on every call;
 *     commands convert it to a typed refusal, never a crash.
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
  ledgerEntry,
  paymentIntentRecord,
  loadMigrationSql,
} from '@aeroops/db';
import { eq } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { createRateScheduleWithDb } from '../billing/rate-commands.js';
import { generateInvoiceFromDispatchWithDb } from '../billing/generate-invoice.js';
import { finalizeInvoiceWithDb } from '../billing/invoice-status-commands.js';
import { getMemberBalanceWithDb } from '../billing/ledger-account.js';

import {
  createInvoicePaymentIntentWithDb,
} from '../integrations/stripe/create-payment-intent.js';
import { getPaymentStatusWithDb } from '../integrations/stripe/get-payment-status.js';
import { handleStripeWebhookEvent } from '../integrations/stripe/handle-webhook-event.js';
import { StubStripeClient, StripeSignatureVerificationError } from '../integrations/stripe/client.js';
import type {
  StripeClient,
  StripeCreateCustomerInput,
  StripeCreatePaymentIntentInput,
  StripeCustomerResult,
  StripePaymentIntentResult,
  StripeRetrievePaymentIntentResult,
  StripeWebhookEvent,
} from '../integrations/stripe/client.js';

import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0038 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0042');

// ── Fake StripeClient — NO real HTTP call, ever ────────────────────────────────

// Module-level counters (NOT per-instance): stripe_customer_id and
// stripe_payment_intent_id both have GLOBAL unique constraints (mirroring
// Stripe's real global id namespace, migration 0023). Multiple tests in this
// file share the same PGlite db across `new FakeStripeClient()` instances —
// a per-instance counter would regenerate "cus_fake_1"/"pi_fake_1" in every
// test and collide with a prior test's persisted row.
let globalCustomerCounter = 0;
let globalPiCounter = 0;

class FakeStripeClient implements StripeClient {
  customerCalls: StripeCreateCustomerInput[] = [];
  paymentIntentCalls: StripeCreatePaymentIntentInput[] = [];

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
    // Signature verification is separately unit/property-tested
    // (stripe-webhook-verify.test.ts) — this fake trusts rawBody directly so
    // these integration tests focus on the DB-level dedup/ledger logic.
    return JSON.parse(rawBody) as StripeWebhookEvent;
  }

  // Slice P0-REV — not exercised by this file's tests (see
  // payments-autopay.test.ts / portal-self-pay.test.ts), stubbed only to
  // satisfy the StripeClient interface.
  async createSetupIntent(): Promise<{ stripeSetupIntentId: string; clientSecret: string; status: string }> {
    throw new Error('FakeStripeClient.createSetupIntent not exercised in this file');
  }
  async attachPaymentMethod(): Promise<{
    stripePaymentMethodId: string;
    type: 'card' | 'us_bank_account';
    last4: string | null;
    brand: string | null;
  }> {
    throw new Error('FakeStripeClient.attachPaymentMethod not exercised in this file');
  }
}

class SignatureFailingFakeClient extends FakeStripeClient {
  override async constructWebhookEvent(): Promise<StripeWebhookEvent> {
    throw new StripeSignatureVerificationError('signature_mismatch');
  }
}

function makeSucceededEventBody(eventId: string, piId: string, amountCents: number): string {
  return JSON.stringify({
    id: eventId,
    type: 'payment_intent.succeeded',
    data: { object: { id: piId, amount: amountCents, currency: 'usd', status: 'succeeded' } },
  });
}

function makeUnhandledEventBody(eventId: string): string {
  return JSON.stringify({
    id: eventId,
    type: 'payment_intent.created',
    data: { object: { id: 'pi_irrelevant', amount: 100, currency: 'usd', status: 'requires_payment_method' } },
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

async function seedClosedTicket(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  aircraftId: string,
  reservationId: string,
): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const openR = await openDispatchWithDb(db, sess, {
    reservationId,
    resourceId: aircraftId,
    pilotUserId: userId,
    hobbsOut: 100.0,
    tachOut: 50.0,
  });
  if (!openR.ok) throw new Error(`openDispatch failed: ${openR.reason}`);
  const closeR = await closeDispatchWithDb(db, sess, {
    ticketId: openR.ticket.id,
    hobbsIn: 101.3,
    tachIn: 51.3,
  });
  if (!closeR.ok) throw new Error(`closeDispatch failed: ${closeR.reason}`);
  return closeR.ticket.id;
}

async function seedFinalizedInvoice(
  db: PgliteTestClient,
  orgId: string,
  ownerUserId: string,
  memberUserId: string,
  tailPrefix: string,
  rateAmountCents: number,
): Promise<{ invoiceId: string; totalCents: number }> {
  const sess = makeSession(orgId, ownerUserId, 'owner');
  const { aircraftId, reservationId } = await seedAircraftAndReservation(db, orgId, ownerUserId, tailPrefix);
  const ticketId = await seedClosedTicket(db, orgId, ownerUserId, aircraftId, reservationId);
  const rateR = await createRateScheduleWithDb(db, sess, {
    name: `${tailPrefix} rate`,
    rateKind: 'wet_hourly',
    amountCents: rateAmountCents,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  });
  if (!rateR.ok) throw new Error('seed rate failed');

  const invR = await generateInvoiceFromDispatchWithDb(db, sess, {
    dispatchTicketId: ticketId,
    rateScheduleId: rateR.rate.id,
    memberUserId,
  });
  if (!invR.ok) throw new Error('seed invoice failed');

  const finR = await finalizeInvoiceWithDb(db, sess, { id: invR.invoice.id });
  if (!finR.ok) throw new Error('seed finalize failed');
  return { invoiceId: invR.invoice.id, totalCents: finR.invoice.totalCents };
}

async function seedDraftInvoice(
  db: PgliteTestClient,
  orgId: string,
  ownerUserId: string,
  memberUserId: string,
  tailPrefix: string,
): Promise<string> {
  const sess = makeSession(orgId, ownerUserId, 'owner');
  const { aircraftId, reservationId } = await seedAircraftAndReservation(db, orgId, ownerUserId, tailPrefix);
  const ticketId = await seedClosedTicket(db, orgId, ownerUserId, aircraftId, reservationId);
  const rateR = await createRateScheduleWithDb(db, sess, {
    name: `${tailPrefix} rate`,
    rateKind: 'wet_hourly',
    amountCents: 9900,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  });
  if (!rateR.ok) throw new Error('seed rate failed');
  const invR = await generateInvoiceFromDispatchWithDb(db, sess, {
    dispatchTicketId: ticketId,
    rateScheduleId: rateR.rate.id,
    memberUserId,
  });
  if (!invR.ok) throw new Error('seed invoice failed');
  return invR.invoice.id;
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
  it('createInvoicePaymentIntent: null session ⇒ Unauthenticated', async () => {
    await expect(
      createInvoicePaymentIntentWithDb(env.db, null, { invoiceId: env.userAId }, new FakeStripeClient()),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('createInvoicePaymentIntent: role without billing:manage ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      createInvoicePaymentIntentWithDb(
        env.db, sess, { invoiceId: '00000000-0000-0000-0000-000000000000' }, new FakeStripeClient(),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it('getPaymentStatus: role without billing:access ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(
      getPaymentStatusWithDb(env.db, sess, { invoiceId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// createInvoicePaymentIntent
// ════════════════════════════════════════════════════════════════════════════════

describe('createInvoicePaymentIntent', () => {
  it('not_found for an unknown invoice', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createInvoicePaymentIntentWithDb(
      env.db, sess, { invoiceId: '00000000-0000-0000-0000-000000000000' }, new FakeStripeClient(),
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('not_finalized for a draft invoice', async () => {
    const member = await seedMember(env.db, env.orgAId, 'PiDraft');
    const invoiceId = await seedDraftInvoice(env.db, env.orgAId, env.userAId, member, 'PiDraft');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createInvoicePaymentIntentWithDb(env.db, sess, { invoiceId }, new FakeStripeClient());
    expect(result).toEqual({ ok: false, reason: 'not_finalized' });
  });

  it('not_configured when using StubStripeClient (unconfigured)', async () => {
    const member = await seedMember(env.db, env.orgAId, 'PiStub');
    const { invoiceId } = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, member, 'PiStub', 10000);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createInvoicePaymentIntentWithDb(env.db, sess, { invoiceId }, new StubStripeClient());
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('happy path: creates ONE Stripe customer + ONE PaymentIntent, persists a record', async () => {
    const member = await seedMember(env.db, env.orgAId, 'PiHappy');
    const { invoiceId, totalCents } = await seedFinalizedInvoice(
      env.db, env.orgAId, env.userAId, member, 'PiHappy', 15000,
    );
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const fake = new FakeStripeClient();

    const result = await createInvoicePaymentIntentWithDb(env.db, sess, { invoiceId }, fake);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyExists).toBe(false);
    expect(result.paymentIntentId).toMatch(/^pi_fake_/);
    expect(fake.customerCalls).toHaveLength(1);
    expect(fake.paymentIntentCalls).toHaveLength(1);
    expect(fake.paymentIntentCalls[0]!.amountCents).toBe(totalCents);
    // ACH-first.
    expect(fake.paymentIntentCalls[0]!.paymentMethodTypes).toEqual(['us_bank_account', 'card']);

    const statusR = await getPaymentStatusWithDb(env.db, sess, { invoiceId });
    expect(statusR.ok).toBe(true);
    if (!statusR.ok) return;
    expect(statusR.record?.status).toBe('pending');
    expect(statusR.record?.amountCents).toBe(totalCents);
  });

  it('idempotent: a second call for the SAME invoice does NOT create a second PaymentIntent', async () => {
    const member = await seedMember(env.db, env.orgAId, 'PiIdem');
    const { invoiceId } = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, member, 'PiIdem', 8000);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const fake = new FakeStripeClient();

    const r1 = await createInvoicePaymentIntentWithDb(env.db, sess, { invoiceId }, fake);
    expect(r1.ok).toBe(true);
    const r2 = await createInvoicePaymentIntentWithDb(env.db, sess, { invoiceId }, fake);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.alreadyExists).toBe(true);
    expect(r2.paymentIntentId).toBe(r1.paymentIntentId);
    expect(fake.paymentIntentCalls).toHaveLength(1);
  });

  it('reuses the SAME stripe_customer on a second invoice for the same member', async () => {
    const member = await seedMember(env.db, env.orgAId, 'PiReuseCust');
    const { invoiceId: inv1 } = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, member, 'PiReuseA', 5000);
    const { invoiceId: inv2 } = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, member, 'PiReuseB', 6000);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const fake = new FakeStripeClient();

    await createInvoicePaymentIntentWithDb(env.db, sess, { invoiceId: inv1 }, fake);
    await createInvoicePaymentIntentWithDb(env.db, sess, { invoiceId: inv2 }, fake);

    expect(fake.customerCalls).toHaveLength(1); // reused, not re-created
    expect(fake.paymentIntentCalls).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// getPaymentStatus
// ════════════════════════════════════════════════════════════════════════════════

describe('getPaymentStatus', () => {
  it('returns record:null before any PaymentIntent has been created', async () => {
    const member = await seedMember(env.db, env.orgAId, 'StatusNull');
    const { invoiceId } = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, member, 'StatusNull', 4000);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await getPaymentStatusWithDb(env.db, sess, { invoiceId });
    expect(result).toEqual({ ok: true, record: null });
  });

  it('not_found for an unknown invoice', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await getPaymentStatusWithDb(env.db, sess, { invoiceId: '00000000-0000-0000-0000-000000000000' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// WEBHOOK
// ════════════════════════════════════════════════════════════════════════════════

describe('handleStripeWebhookEvent', () => {
  it('not_configured when using StubStripeClient', async () => {
    const result = await handleStripeWebhookEvent(env.db, '{}', 'sig', new StubStripeClient());
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('invalid_signature when the client throws StripeSignatureVerificationError', async () => {
    const result = await handleStripeWebhookEvent(env.db, '{}', 'sig', new SignatureFailingFakeClient());
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('payment_intent.succeeded: posts ONE payment credit, flips status, updates balance', async () => {
    const member = await seedMember(env.db, env.orgAId, 'WhSucceed');
    const { invoiceId, totalCents } = await seedFinalizedInvoice(
      env.db, env.orgAId, env.userAId, member, 'WhSucceed', 20000,
    );
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const fake = new FakeStripeClient();
    const piResult = await createInvoicePaymentIntentWithDb(env.db, sess, { invoiceId }, fake);
    expect(piResult.ok).toBe(true);
    if (!piResult.ok) return;

    const body = makeSucceededEventBody('evt_succeed_1', piResult.paymentIntentId, totalCents);
    const whResult = await handleStripeWebhookEvent(env.db, body, 'sig', fake);
    expect(whResult).toEqual({ ok: true, alreadyProcessed: false });

    const statusR = await getPaymentStatusWithDb(env.db, sess, { invoiceId });
    expect(statusR.ok).toBe(true);
    if (!statusR.ok) return;
    expect(statusR.record?.status).toBe('succeeded');

    // Invoice finalize posted a debit (totalCents); the webhook posted a
    // credit (totalCents) — they cancel to a zero balance.
    const balR = await getMemberBalanceWithDb(env.db, sess, { memberUserId: member });
    expect(balR).toEqual({ ok: true, balanceCents: 0, minimumBalanceCents: 0 });

    // Exactly one 'payment' ledger_entry for this invoice's PaymentIntent.
    const entries = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(ledgerEntry).where(eq(ledgerEntry.paymentId, piResult.paymentIntentId)),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entryType).toBe('payment');
    expect(entries[0]!.direction).toBe('credit');
    expect(entries[0]!.amountCents).toBe(totalCents);
    expect(entries[0]!.createdBy).toBeNull(); // SYSTEM/webhook-generated
  });

  it('DEDUP: the SAME event delivered twice posts exactly ONE ledger_entry', async () => {
    const member = await seedMember(env.db, env.orgAId, 'WhDedup');
    const { invoiceId, totalCents } = await seedFinalizedInvoice(
      env.db, env.orgAId, env.userAId, member, 'WhDedup', 12000,
    );
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const fake = new FakeStripeClient();
    const piResult = await createInvoicePaymentIntentWithDb(env.db, sess, { invoiceId }, fake);
    if (!piResult.ok) throw new Error('setup failed');

    const body = makeSucceededEventBody('evt_dedup_1', piResult.paymentIntentId, totalCents);
    const first = await handleStripeWebhookEvent(env.db, body, 'sig', fake);
    expect(first).toEqual({ ok: true, alreadyProcessed: false });

    const second = await handleStripeWebhookEvent(env.db, body, 'sig', fake);
    expect(second).toEqual({ ok: true, alreadyProcessed: true });

    const entries = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(ledgerEntry).where(eq(ledgerEntry.paymentId, piResult.paymentIntentId)),
    );
    expect(entries).toHaveLength(1);
  });

  it('an unresolvable PaymentIntent id (no matching record) ⇒ ok, no ledger entry, still deduped', async () => {
    const body = makeSucceededEventBody('evt_unknown_pi', 'pi_never_created', 5000);
    const first = await handleStripeWebhookEvent(env.db, body, 'sig', new FakeStripeClient());
    expect(first).toEqual({ ok: true, alreadyProcessed: false });

    const second = await handleStripeWebhookEvent(env.db, body, 'sig', new FakeStripeClient());
    expect(second).toEqual({ ok: true, alreadyProcessed: true });

    const entries = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(ledgerEntry).where(eq(ledgerEntry.paymentId, 'pi_never_created')),
    );
    expect(entries).toHaveLength(0);
  });

  it('a recognized-but-unhandled event type is deduped without side effects', async () => {
    const body = makeUnhandledEventBody('evt_unhandled_1');
    const first = await handleStripeWebhookEvent(env.db, body, 'sig', new FakeStripeClient());
    expect(first).toEqual({ ok: true, alreadyProcessed: false });
    const second = await handleStripeWebhookEvent(env.db, body, 'sig', new FakeStripeClient());
    expect(second).toEqual({ ok: true, alreadyProcessed: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T-ISO — tenant isolation
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO — tenant isolation', () => {
  it('org B cannot getPaymentStatus for an org A invoice', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoStatusA');
    const { invoiceId } = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, memberA, 'IsoStatusA', 7000);
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await getPaymentStatusWithDb(env.db, sessB, { invoiceId });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('org B cannot createInvoicePaymentIntent for an org A invoice', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoPiA');
    const { invoiceId } = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, memberA, 'IsoPiA', 9000);
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await createInvoicePaymentIntentWithDb(env.db, sessB, { invoiceId }, new FakeStripeClient());
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('a webhook payment for an org A PaymentIntent credits ONLY org A (not org B)', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoWhA');
    const { invoiceId, totalCents } = await seedFinalizedInvoice(
      env.db, env.orgAId, env.userAId, memberA, 'IsoWhA', 30000,
    );
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const fake = new FakeStripeClient();
    const piResult = await createInvoicePaymentIntentWithDb(env.db, sessA, { invoiceId }, fake);
    if (!piResult.ok) throw new Error('setup failed');

    const body = makeSucceededEventBody('evt_iso_wh_1', piResult.paymentIntentId, totalCents);
    await handleStripeWebhookEvent(env.db, body, 'sig', fake);

    // org B never sees a payment_intent_record for org A's PaymentIntent.
    const orgBRows = await withOrgContext(env.db, env.orgBId, (tx) =>
      tx
        .select()
        .from(paymentIntentRecord)
        .where(eq(paymentIntentRecord.stripePaymentIntentId, piResult.paymentIntentId)),
    );
    expect(orgBRows).toHaveLength(0);

    // org A DOES see it, succeeded.
    const orgARows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(paymentIntentRecord)
        .where(eq(paymentIntentRecord.stripePaymentIntentId, piResult.paymentIntentId)),
    );
    expect(orgARows).toHaveLength(1);
    expect(orgARows[0]!.status).toBe('succeeded');
  });
});
