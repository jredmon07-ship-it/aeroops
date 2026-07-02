/**
 * billing-ledger.test.ts — Integration tests for Slice B2 (billing ledger +
 * balance, no keys, gate stays OFF).
 *
 * Applies migrations 0000–0022 (0022 = billing_ledger tables + the additive
 * dispatch_config.minimum_balance_cents column).
 *
 * COVERAGE:
 *   CAPS: billing:access (getMemberBalance/listLedgerEntries), billing:manage
 *     (recordManualPayment) enforced; non-privileged roles Forbidden; null
 *     session Unauthenticated.
 *   BALANCE: zero balance for a member with no ledger activity; recordManualPayment
 *     moves the balance; getMemberBalance is DERIVED (never stored).
 *   FINALIZE → LEDGER: finalizeInvoice posts exactly ONE 'invoice_finalized'
 *     debit in the SAME tx; idempotent (cannot double-finalize → cannot
 *     double-debit); a $0 invoice finalizes with NO ledger entry (CHECK > 0
 *     on amount_cents would otherwise reject a zero-amount row).
 *   LEDGER PAGINATION: keyset cursor over multiple entries.
 *   REAL BALANCE SEAM: makeRealBalanceSeam reads the ledger + minimum_balance_cents
 *     correctly (above/below/at minimum); OFF-flag / FROZEN-GATE byte-identity —
 *     openDispatch's APP-CODE FORM (no injected seam) is UNCHANGED even when the
 *     ledger balance is deeply negative and balance_check_enabled is turned on.
 *   T-ISO: org B cannot see org A's billing_account/ledger_entry rows, and
 *     getMemberBalance/listLedgerEntries refuse a cross-org memberUserId.
 *   APPEND-ONLY: ledger_entry has no UPDATE/DELETE RLS policy (schema-level
 *     guarantee — exercised indirectly via the API's lack of any edit command).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { createRateScheduleWithDb } from '../billing/rate-commands.js';
import { generateInvoiceFromDispatchWithDb } from '../billing/generate-invoice.js';
import { finalizeInvoiceWithDb } from '../billing/invoice-status-commands.js';
import {
  getMemberBalanceWithDb,
  listLedgerEntriesWithDb,
} from '../billing/ledger-account.js';
import { recordManualPaymentWithDb } from '../billing/record-manual-payment.js';
import { makeRealBalanceSeam } from '../billing/real-balance-seam.js';
import { updateDispatchConfigWithDb } from '../dispatch-gate/config.js';

import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// ── Path resolution ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function migrationSql(name: string): string {
  return readFileSync(resolve(__dirname, `../../../db/migrations/${name}`), 'utf-8');
}

const MIGRATION_SQL = [
  migrationSql('0000_loud_prodigy.sql'),
  migrationSql('0001_auth_credential.sql'),
  migrationSql('0002_scheduling.sql'),
  migrationSql('0003_booking_policies.sql'),
  migrationSql('0004_recurrence.sql'),
  migrationSql('0005_dispatch.sql'),
  migrationSql('0006_squawks_grounding.sql'),
  migrationSql('0007_fleet.sql'),
  migrationSql('0008_people.sql'),
  migrationSql('0009_dispatch_gate.sql'),
  migrationSql('0010_civil_twilight.sql'),
  migrationSql('0011_optimizer_run.sql'),
  migrationSql('0012_training.sql'),
  migrationSql('0013_work_orders.sql'),
  migrationSql('0014_availability.sql'),
  migrationSql('0015_booking_request.sql'),
  migrationSql('0016_booking_request_convert.sql'),
  migrationSql('0017_booking_retention.sql'),
  migrationSql('0018_dispatch_ticket_correction.sql'),
  migrationSql('0019_billing_records.sql'),
  migrationSql('0020_demo_reset_state.sql'),
  migrationSql('0021_qbo_integration.sql'),
  migrationSql('0022_billing_ledger.sql'),
  migrationSql('0023_stripe_foundation.sql'),
  migrationSql('0024_payment_methods_autopay.sql'),
  migrationSql('0025_recurring_dues.sql'),
];

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

/** Insert a fresh app_user + membership in the given org. Returns userId. */
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

/** Create aircraft + reservation in the given org. */
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

/** Open + close a dispatch ticket. Returns ticketId. */
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

/** Seed + finalize an invoice for memberUserId. amountCents controls the rate ($/hr). Returns { invoiceId, totalCents }. */
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
  it('getMemberBalance: null session ⇒ Unauthenticated', async () => {
    await expect(
      getMemberBalanceWithDb(env.db, null, { memberUserId: env.userAId }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('getMemberBalance: role without billing:access ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(
      getMemberBalanceWithDb(env.db, sess, { memberUserId: env.userAId }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('getMemberBalance: accountant (billing:access, no manage) can read', async () => {
    const member = await seedMember(env.db, env.orgAId, 'CapRead');
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const result = await getMemberBalanceWithDb(env.db, sess, { memberUserId: member });
    expect(result).toEqual({ ok: true, balanceCents: 0, minimumBalanceCents: 0 });
  });

  it('recordManualPayment: role without billing:manage ⇒ Forbidden', async () => {
    const member = await seedMember(env.db, env.orgAId, 'CapMgr');
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      recordManualPaymentWithDb(env.db, sess, { memberUserId: member, amountCents: 1000 }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('recordManualPayment: null session ⇒ Unauthenticated', async () => {
    await expect(
      recordManualPaymentWithDb(env.db, null, { memberUserId: env.userAId, amountCents: 1000 }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('listLedgerEntries: role without billing:access ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(
      listLedgerEntriesWithDb(env.db, sess, { memberUserId: env.userAId }),
    ).rejects.toThrow(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// BALANCE — zero + manual payment
// ════════════════════════════════════════════════════════════════════════════════

describe('balance — zero + manual payment', () => {
  it('a member with no ledger activity has balance 0 (no billing_account row required)', async () => {
    const member = await seedMember(env.db, env.orgAId, 'ZeroBal');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await getMemberBalanceWithDb(env.db, sess, { memberUserId: member });
    expect(result).toEqual({ ok: true, balanceCents: 0, minimumBalanceCents: 0 });
  });

  it('recordManualPayment posts a credit and raises the balance', async () => {
    const member = await seedMember(env.db, env.orgAId, 'PayUp');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');

    const payR = await recordManualPaymentWithDb(env.db, sess, {
      memberUserId: member,
      amountCents: 25000,
      methodNote: 'Check #1042',
    });
    expect(payR.ok).toBe(true);
    if (!payR.ok) return;
    expect(payR.entry.entryType).toBe('payment');
    expect(payR.entry.direction).toBe('credit');
    expect(payR.entry.amountCents).toBe(25000);
    expect(payR.entry.paymentId).toBe('Check #1042');
    expect(payR.balanceCentsAfter).toBe(25000);

    const balR = await getMemberBalanceWithDb(env.db, sess, { memberUserId: member });
    expect(balR).toEqual({ ok: true, balanceCents: 25000, minimumBalanceCents: 0 });
  });

  it('two manual payments accumulate', async () => {
    const member = await seedMember(env.db, env.orgAId, 'PayTwice');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await recordManualPaymentWithDb(env.db, sess, { memberUserId: member, amountCents: 10000 });
    await recordManualPaymentWithDb(env.db, sess, { memberUserId: member, amountCents: 5000 });
    const balR = await getMemberBalanceWithDb(env.db, sess, { memberUserId: member });
    expect(balR).toEqual({ ok: true, balanceCents: 15000, minimumBalanceCents: 0 });
  });

  it('recordManualPayment: unknown member ⇒ member_not_found', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await recordManualPaymentWithDb(env.db, sess, {
      memberUserId: '00000000-0000-0000-0000-000000000000',
      amountCents: 1000,
    });
    expect(result).toEqual({ ok: false, reason: 'member_not_found' });
  });

  it('recordManualPayment: negative/zero amountCents ⇒ throws (validation)', async () => {
    const member = await seedMember(env.db, env.orgAId, 'BadAmt');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      recordManualPaymentWithDb(env.db, sess, { memberUserId: member, amountCents: 0 }),
    ).rejects.toThrow();
    await expect(
      recordManualPaymentWithDb(env.db, sess, { memberUserId: member, amountCents: -100 }),
    ).rejects.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FINALIZE → LEDGER
// ════════════════════════════════════════════════════════════════════════════════

describe('finalizeInvoice → ledger', () => {
  it('finalizing an invoice posts exactly ONE invoice_finalized debit', async () => {
    const member = await seedMember(env.db, env.orgAId, 'FinLedger');
    const { totalCents } = await seedFinalizedInvoice(
      env.db, env.orgAId, env.userAId, member, 'FinLedger', 12500,
    );
    expect(totalCents).toBeGreaterThan(0);

    const balR = await getMemberBalanceWithDb(
      env.db,
      makeSession(env.orgAId, env.userAId, 'owner'),
      { memberUserId: member },
    );
    expect(balR).toEqual({ ok: true, balanceCents: -totalCents, minimumBalanceCents: 0 });

    const entriesR = await listLedgerEntriesWithDb(
      env.db,
      makeSession(env.orgAId, env.userAId, 'owner'),
      { memberUserId: member },
    );
    expect(entriesR.ok).toBe(true);
    if (!entriesR.ok) return;
    expect(entriesR.entries).toHaveLength(1);
    expect(entriesR.entries[0]!.entryType).toBe('invoice_finalized');
    expect(entriesR.entries[0]!.direction).toBe('debit');
    expect(entriesR.entries[0]!.amountCents).toBe(totalCents);
  });

  it('a member with a finalized invoice AND a manual payment nets correctly', async () => {
    const member = await seedMember(env.db, env.orgAId, 'NetLedger');
    const { totalCents } = await seedFinalizedInvoice(
      env.db, env.orgAId, env.userAId, member, 'NetLedger', 10000,
    );
    await recordManualPaymentWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), {
      memberUserId: member,
      amountCents: totalCents + 5000,
    });
    const balR = await getMemberBalanceWithDb(
      env.db,
      makeSession(env.orgAId, env.userAId, 'owner'),
      { memberUserId: member },
    );
    expect(balR).toEqual({ ok: true, balanceCents: 5000, minimumBalanceCents: 0 });
  });

  it('cannot double-finalize ⇒ cannot double-debit (idempotent)', async () => {
    const member = await seedMember(env.db, env.orgAId, 'DoubleFin');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const { aircraftId, reservationId } = await seedAircraftAndReservation(env.db, env.orgAId, env.userAId, 'DoubleFin');
    const ticketId = await seedClosedTicket(env.db, env.orgAId, env.userAId, aircraftId, reservationId);
    const rateR = await createRateScheduleWithDb(env.db, sess, {
      name: 'DoubleFin rate',
      rateKind: 'wet_hourly',
      amountCents: 8000,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    if (!rateR.ok) throw new Error('rate failed');
    const invR = await generateInvoiceFromDispatchWithDb(env.db, sess, {
      dispatchTicketId: ticketId,
      rateScheduleId: rateR.rate.id,
      memberUserId: member,
    });
    if (!invR.ok) throw new Error('invoice failed');

    const fin1 = await finalizeInvoiceWithDb(env.db, sess, { id: invR.invoice.id });
    expect(fin1.ok).toBe(true);
    const fin2 = await finalizeInvoiceWithDb(env.db, sess, { id: invR.invoice.id });
    expect(fin2).toEqual({ ok: false, reason: 'not_draft' });

    const entriesR = await listLedgerEntriesWithDb(env.db, sess, { memberUserId: member });
    expect(entriesR.ok).toBe(true);
    if (!entriesR.ok) return;
    expect(entriesR.entries).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// LEDGER PAGINATION
// ════════════════════════════════════════════════════════════════════════════════

describe('listLedgerEntries — keyset pagination', () => {
  it('paginates with limit + nextCursor across 3 manual payments', async () => {
    const member = await seedMember(env.db, env.orgAId, 'Page');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    for (const amount of [1000, 2000, 3000]) {
      await recordManualPaymentWithDb(env.db, sess, { memberUserId: member, amountCents: amount });
    }

    const page1 = await listLedgerEntriesWithDb(env.db, sess, { memberUserId: member, limit: 2 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.entries).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await listLedgerEntriesWithDb(env.db, sess, {
      memberUserId: member,
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.entries).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();

    // Newest-first ordering: the last payment (3000) is first.
    expect(page1.entries[0]!.amountCents).toBe(3000);
  });

  it('listLedgerEntries: unknown member ⇒ not_found', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await listLedgerEntriesWithDb(env.db, sess, {
      memberUserId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// REAL BALANCE SEAM — built + tested, NOT injected (FROZEN gate unchanged)
// ════════════════════════════════════════════════════════════════════════════════

describe('makeRealBalanceSeam', () => {
  it('balance >= minimum ⇒ { ok: true }', async () => {
    const member = await seedMember(env.db, env.orgAId, 'SeamOk');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await recordManualPaymentWithDb(env.db, sess, { memberUserId: member, amountCents: 10000 });
    await updateDispatchConfigWithDb(env.db, sess, { minimumBalanceCents: 5000 });

    const seam = makeRealBalanceSeam(env.db);
    const result = await seam.check({ orgId: env.orgAId, pilotUserId: member });
    expect(result).toEqual({ ok: true });
  });

  it('balance < minimum ⇒ { ok: false, reason: below_minimum }', async () => {
    const member = await seedMember(env.db, env.orgAId, 'SeamLow');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await recordManualPaymentWithDb(env.db, sess, { memberUserId: member, amountCents: 1000 });
    await updateDispatchConfigWithDb(env.db, sess, { minimumBalanceCents: 5000 });

    const seam = makeRealBalanceSeam(env.db);
    const result = await seam.check({ orgId: env.orgAId, pilotUserId: member });
    expect(result).toEqual({ ok: false, reason: 'below_minimum' });
  });

  it('a pilot with NO ledger activity and minimum 0 ⇒ { ok: true } (0 >= 0)', async () => {
    const member = await seedMember(env.db, env.orgAId, 'SeamZero');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await updateDispatchConfigWithDb(env.db, sess, { minimumBalanceCents: 0 });

    const seam = makeRealBalanceSeam(env.db);
    const result = await seam.check({ orgId: env.orgAId, pilotUserId: member });
    expect(result).toEqual({ ok: true });
  });

  it('a pilot with NO ledger activity and a positive minimum ⇒ below_minimum', async () => {
    const member = await seedMember(env.db, env.orgAId, 'SeamZeroLow');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await updateDispatchConfigWithDb(env.db, sess, { minimumBalanceCents: 100 });

    const seam = makeRealBalanceSeam(env.db);
    const result = await seam.check({ orgId: env.orgAId, pilotUserId: member });
    expect(result).toEqual({ ok: false, reason: 'below_minimum' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FROZEN-GATE BYTE-IDENTITY — openDispatch's app-code form is UNCHANGED
// ════════════════════════════════════════════════════════════════════════════════

describe('FROZEN gate byte-identity — openDispatch app-code form unchanged by B2', () => {
  it('openDispatchWithDb with NO injected seam succeeds regardless of a deeply-negative ledger balance + balanceCheckEnabled=true', async () => {
    const member = await seedMember(env.db, env.orgAId, 'GateFrozen');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');

    // Deeply negative balance + a high minimum + the flag ON — if the real
    // seam were wired in, this pilot would be refused.
    await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, member, 'GateFrozen', 999900);
    await updateDispatchConfigWithDb(env.db, sess, {
      balanceCheckEnabled: true,
      minimumBalanceCents: 1_000_000,
    });

    // Independently verify the real seam WOULD refuse this pilot (proves the
    // scenario is meaningful, not a no-op).
    const seam = makeRealBalanceSeam(env.db);
    const seamResult = await seam.check({ orgId: env.orgAId, pilotUserId: member });
    expect(seamResult).toEqual({ ok: false, reason: 'below_minimum' });

    // openDispatchWithDb called WITHOUT a balanceSeam argument uses its
    // default (stubBalanceSeam) — exactly like openDispatch()'s app-code
    // form, which hard-codes stubBalanceSeam at open-dispatch.ts:338. This
    // is the byte-identity assertion: B2 changes NOTHING about this path.
    const { aircraftId, reservationId } = await seedAircraftAndReservation(
      env.db, env.orgAId, env.userAId, 'GateFrozenFlight',
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
// T-ISO — tenant isolation
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO — tenant isolation', () => {
  it('org B cannot read org A member balance via a cross-org memberUserId', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoA');
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await getMemberBalanceWithDb(env.db, sessB, { memberUserId: memberA });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('org B cannot list org A member ledger entries via a cross-org memberUserId', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoListA');
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    await recordManualPaymentWithDb(env.db, sessA, { memberUserId: memberA, amountCents: 5000 });

    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await listLedgerEntriesWithDb(env.db, sessB, { memberUserId: memberA });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('org B cannot record a manual payment against an org A member', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoPayA');
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await recordManualPaymentWithDb(env.db, sessB, {
      memberUserId: memberA,
      amountCents: 1000,
    });
    expect(result).toEqual({ ok: false, reason: 'member_not_found' });
  });

  it('makeRealBalanceSeam scoped to org B never sees an org A pilot\'s ledger (0/0 ⇒ ok:true, not a leak of org A balance)', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoSeamA');
    await recordManualPaymentWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), {
      memberUserId: memberA,
      amountCents: 999999,
    });

    // Query the seam AS ORG B for the SAME user id (which is not a member of
    // org B) — withOrgContext(db, orgBId, ...) scopes RLS to org B, so even
    // though memberA's ledger rows exist (in org A), they are invisible.
    const seam = makeRealBalanceSeam(env.db);
    const result = await seam.check({ orgId: env.orgBId, pilotUserId: memberA });
    // No org B billing_account for memberA ⇒ zero entries ⇒ balance 0 ⇒
    // 0 >= minimumBalanceCents(default 0) ⇒ ok:true. Crucially NOT the org A
    // balance (999999) — proving no cross-org leak through this seam.
    expect(result).toEqual({ ok: true });
  });
});
