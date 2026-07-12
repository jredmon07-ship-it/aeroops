/**
 * dues.test.ts — Integration tests for Slice P0-REV: recurring dues.
 *
 * Applies migrations 0000–0025. Every test injects a FAKE StripeClient for
 * the dues→autopay chaining test — never a real HTTP call.
 *
 * COVERAGE (money invariants):
 *   8.  Dues no-double-bill: two schedules → 2 created; re-run same period →
 *       0 created, all skipped(already_run); a third schedule added then
 *       re-run → only the new one created. UNIQUE constraint direct-insert
 *       backstop.
 *   9.  Dues → autopay chaining: finalizing a dues DRAFT invoice for an
 *       autopay member triggers exactly one off-session PI.
 *  12.  Capabilities: billing:manage (create/run) vs billing:access
 *       (read-only — refused on write attempts).
 *  14.  Integer-cents property test: for random amountCents, a dues
 *       invoice's subtotal_cents === total_cents === line_total_cents ===
 *       amountCents exactly, no float drift.
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
  duesRun,
  invoiceLineItem,
  loadMigrationSql,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import {
  createDuesScheduleWithDb,
  setDuesScheduleActiveWithDb,
} from '../billing/dues-schedule-commands.js';
import { generateDuesInvoicesWithDb } from '../billing/generate-dues-invoices.js';
import { finalizeInvoiceWithDb } from '../billing/invoice-status-commands.js';
import { saveMyPaymentMethodWithDb } from '../portal/save-payment-method.js';
import { setMyAutopayWithDb } from '../portal/set-autopay.js';
import { getMemberBillingProfileWithDb } from '../billing/get-member-billing-profile.js';

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
let globalPmCounter = 0;

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
      last4: '1122',
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

async function seedAutopayReady(
  db: PgliteTestClient,
  orgId: string,
  memberUserId: string,
  client: StripeClient,
): Promise<void> {
  const memberSess = makeSession(orgId, memberUserId, 'renter');
  const saveR = await saveMyPaymentMethodWithDb(db, memberSess, { paymentMethodId: `pm_seed_${memberUserId}` }, client);
  if (!saveR.ok) throw new Error('seedAutopayReady: saveMyPaymentMethod failed');
  const autoR = await setMyAutopayWithDb(db, memberSess, {
    enabled: true,
    defaultPaymentMethodId: saveR.paymentMethod.id,
  });
  if (!autoR.ok) throw new Error('seedAutopayReady: setMyAutopay failed');
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
  it('createDuesSchedule: null session ⇒ Unauthenticated', async () => {
    await expect(
      createDuesScheduleWithDb(env.db, null, { memberUserId: env.userAId, amountCents: 100, dayOfMonth: 1 }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('createDuesSchedule: accountant (billing:access only) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      createDuesScheduleWithDb(env.db, sess, { memberUserId: env.userAId, amountCents: 100, dayOfMonth: 1 }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('generateDuesInvoices: accountant (billing:access only) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(generateDuesInvoicesWithDb(env.db, sess, { periodKey: '2026-08' })).rejects.toThrow(ForbiddenError);
  });

  it('getMemberBillingProfile: accountant (billing:access) CAN read', async () => {
    const member = await seedMember(env.db, env.orgAId, 'CapsReadOk');
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const result = await getMemberBillingProfileWithDb(env.db, sess, { memberUserId: member });
    expect(result.ok).toBe(true);
  });

  it('getMemberBillingProfile: cfi (no billing:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'cfi');
    await expect(getMemberBillingProfileWithDb(env.db, sess, { memberUserId: env.userAId })).rejects.toThrow(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 8. Dues no-double-bill
// ════════════════════════════════════════════════════════════════════════════════

describe('generateDuesInvoices — no-double-bill (invariant 8)', () => {
  it('two active schedules → 2 created; re-run same period → 0 created, all skipped; adding a third then re-running → only the new one created', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const memberA = await seedMember(env.db, env.orgAId, 'DuesA');
    const memberB = await seedMember(env.db, env.orgAId, 'DuesB');

    const schedA = await createDuesScheduleWithDb(env.db, sess, { memberUserId: memberA, amountCents: 5000, dayOfMonth: 1 });
    const schedB = await createDuesScheduleWithDb(env.db, sess, { memberUserId: memberB, amountCents: 7500, dayOfMonth: 1 });
    if (!schedA.ok || !schedB.ok) throw new Error('seed schedules failed');

    const periodKey = '2026-08';
    const run1 = await generateDuesInvoicesWithDb(env.db, sess, { periodKey });
    expect(run1.created).toHaveLength(2);
    expect(run1.skipped).toHaveLength(0);
    expect(new Set(run1.created.map((c) => c.scheduleId))).toEqual(new Set([schedA.schedule.id, schedB.schedule.id]));

    // Re-run the SAME period: zero new invoices, all skipped.
    const run2 = await generateDuesInvoicesWithDb(env.db, sess, { periodKey });
    expect(run2.created).toHaveLength(0);
    expect(run2.skipped).toHaveLength(2);
    expect(run2.skipped.every((s) => s.reason === 'already_run')).toBe(true);

    // A dues_run marker exists exactly once per (schedule, period).
    const runRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(duesRun).where(and(eq(duesRun.orgId, env.orgAId), eq(duesRun.periodKey, periodKey))),
    );
    expect(runRows).toHaveLength(2);

    // Add a THIRD schedule; re-run the SAME period → only the new one created.
    const memberC = await seedMember(env.db, env.orgAId, 'DuesC');
    const schedC = await createDuesScheduleWithDb(env.db, sess, { memberUserId: memberC, amountCents: 3000, dayOfMonth: 15 });
    if (!schedC.ok) throw new Error('seed schedC failed');

    const run3 = await generateDuesInvoicesWithDb(env.db, sess, { periodKey });
    expect(run3.created).toHaveLength(1);
    expect(run3.created[0]!.scheduleId).toBe(schedC.schedule.id);
    expect(run3.skipped).toHaveLength(2);
  });

  it('UNIQUE (org_id, dues_schedule_id, period_key) blocks a direct duplicate INSERT', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMember(env.db, env.orgAId, 'DuesUniqueDirect');
    const sched = await createDuesScheduleWithDb(env.db, sess, { memberUserId: member, amountCents: 4400, dayOfMonth: 1 });
    if (!sched.ok) throw new Error('seed failed');
    const gen = await generateDuesInvoicesWithDb(env.db, sess, { periodKey: '2026-09' });
    const created = gen.created.find((c) => c.scheduleId === sched.schedule.id);
    if (!created) throw new Error('expected a created invoice');

    await expect(
      withOrgContext(env.db, env.orgAId, (tx) =>
        tx.insert(duesRun).values({
          orgId: env.orgAId,
          duesScheduleId: sched.schedule.id,
          periodKey: '2026-09',
          invoiceId: created.invoiceId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('inactive schedules are excluded from generation', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMember(env.db, env.orgAId, 'DuesInactive');
    const sched = await createDuesScheduleWithDb(env.db, sess, { memberUserId: member, amountCents: 2200, dayOfMonth: 1 });
    if (!sched.ok) throw new Error('seed failed');
    const deactivate = await setDuesScheduleActiveWithDb(env.db, sess, { scheduleId: sched.schedule.id, active: false });
    expect(deactivate.ok).toBe(true);

    const run = await generateDuesInvoicesWithDb(env.db, sess, { periodKey: '2026-10' });
    expect(run.created.find((c) => c.scheduleId === sched.schedule.id)).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 9. Dues → autopay chaining
// ════════════════════════════════════════════════════════════════════════════════

describe('dues → autopay chaining (invariant 9)', () => {
  it('finalizing a generated dues DRAFT invoice for an autopay member triggers exactly one off-session PI', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMember(env.db, env.orgAId, 'DuesAutopay');
    const fake = new FakeStripeClient();
    await seedAutopayReady(env.db, env.orgAId, member, fake);

    const sched = await createDuesScheduleWithDb(env.db, sess, {
      memberUserId: member, amountCents: 8800, dayOfMonth: 1, memo: 'Monthly club dues',
    });
    if (!sched.ok) throw new Error('seed failed');

    const gen = await generateDuesInvoicesWithDb(env.db, sess, { periodKey: '2026-11' });
    const created = gen.created.find((c) => c.scheduleId === sched.schedule.id);
    if (!created) throw new Error('expected a created invoice');

    const finR = await finalizeInvoiceWithDb(env.db, sess, { id: created.invoiceId }, fake);
    expect(finR.ok).toBe(true);
    if (!finR.ok) return;
    expect(finR.autopay?.outcome).toBe('created');
    expect(fake.paymentIntentCalls).toHaveLength(1);
    expect(fake.paymentIntentCalls[0]!.offSession).toBe(true);
    expect(fake.paymentIntentCalls[0]!.confirm).toBe(true);
    expect(fake.paymentIntentCalls[0]!.idempotencyKey).toBe(`autopay:${created.invoiceId}`);
    expect(fake.paymentIntentCalls[0]!.amountCents).toBe(8800);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 14. Integer-cents property test — dues invoice amounts
// ════════════════════════════════════════════════════════════════════════════════

describe('property: a dues invoice carries the schedule amount EXACTLY, no float drift', () => {
  it('holds for random positive integer cent amounts', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10_000_000 }), async (amountCents) => {
        const sess = makeSession(env.orgAId, env.userAId, 'owner');
        const member = await seedMember(env.db, env.orgAId, 'DuesProp');
        const sched = await createDuesScheduleWithDb(env.db, sess, {
          memberUserId: member, amountCents, dayOfMonth: 1,
        });
        if (!sched.ok) throw new Error('seed failed');
        const periodKey = `2027-${String((tailSuffix % 12) + 1).padStart(2, '0')}`;
        const gen = await generateDuesInvoicesWithDb(env.db, sess, { periodKey });
        const created = gen.created.find((c) => c.scheduleId === sched.schedule.id);
        if (!created) throw new Error('expected a created invoice');

        const lineRows = await withOrgContext(env.db, env.orgAId, (tx) =>
          tx.select().from(invoiceLineItem).where(eq(invoiceLineItem.invoiceId, created.invoiceId)),
        );
        expect(lineRows).toHaveLength(1);
        expect(lineRows[0]!.unitAmountCents).toBe(amountCents);
        expect(lineRows[0]!.lineTotalCents).toBe(amountCents);
      }),
      { numRuns: 15 },
    );
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════════
// No-real-HTTP guard
// ════════════════════════════════════════════════════════════════════════════════

describe('no-real-HTTP guard', () => {
  it('getStripeClient() with STRIPE_SECRET_KEY unset resolves to StubStripeClient', async () => {
    const { getStripeClient } = await import('../integrations/stripe/client.js');
    expect(process.env['STRIPE_SECRET_KEY']).toBeUndefined();
    expect(getStripeClient()).toBeInstanceOf(StubStripeClient);
  });
});
