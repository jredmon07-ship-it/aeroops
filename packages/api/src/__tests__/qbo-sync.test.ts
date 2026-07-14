/**
 * qbo-sync.test.ts — Integration tests for the QBO SYNC layer (migration 0046):
 * auto-sync toggle + auto-export hook, payment sync (createQboPayment), the
 * unexported-invoice backfill, and the per-invoice export-status read.
 *
 * Two PGlite environments:
 *   env0046 — migrations 0000–0046 applied (the SYNC features are live).
 *   env0045 — migrations 0000–0045 applied (0046 absent → GRACEFUL ABSENCE:
 *             the toggle reads available:false, the setter/payment-sync return
 *             not_available; byte-identical to the manual-export world).
 *
 * A FAKE QboClient is injected everywhere — NO real HTTP anywhere in this file.
 *
 * COVERAGE:
 *   AUTO-SYNC: hook fires (exports) only when ON + connected; OFF ⇒ triggered:false
 *     and ZERO export-log rows (byte-identity); not-connected ⇒ no export written.
 *   SETTING: get/set caps (billing:access / org:manage_settings), no-op no audit,
 *     T-ISO, graceful absence on a 0045 DB.
 *   PAYMENT SYNC: happy path records a 'payment' export-log row + audit; idempotent
 *     (client not called twice); not_a_payment / invoice_not_exported refusals;
 *     provider error → 'error' row, never swallowed; caps; T-ISO; graceful absence.
 *   BACKFILL: bounded to 50 per run; partial-failure resilient (one failure does
 *     not abort the batch); remaining count; not-connected ⇒ zeros; caps; T-ISO.
 *   STATUS READ: not_exported / exported / failed derivation.
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
  qboConnection,
  qboExportLog,
  ledgerEntry,
  loadMigrationSql,
} from '@aeroops/db';
import { and, eq, sql } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { createRateScheduleWithDb } from '../billing/rate-commands.js';
import { generateInvoiceFromDispatchWithDb } from '../billing/generate-invoice.js';
import { finalizeInvoiceWithDb } from '../billing/invoice-status-commands.js';

import { setQboAccountMappingWithDb } from '../integrations/qbo/account-mapping.js';
import { exportInvoiceToQboWithDb } from '../integrations/qbo/export-invoice.js';
import { getQboAutoExportWithDb, setQboAutoExportWithDb } from '../integrations/qbo/auto-export-setting.js';
import { autoExportInvoiceOnFinalizeWithDb } from '../integrations/qbo/auto-export-hook.js';
import { syncPaymentToQboWithDb, autoSyncPaymentToQboOnStripeWebhook } from '../integrations/qbo/sync-payment.js';
import { backfillQboExportsWithDb, QBO_BACKFILL_BATCH_LIMIT } from '../integrations/qbo/backfill.js';
import { getInvoiceQboStatusesWithDb } from '../integrations/qbo/invoice-export-status.js';
import type {
  QboClient,
  QboCreateCustomerInput,
  QboRequestContext,
  QboInvoicePayload,
  QboPaymentPayload,
  QboTokenSet,
} from '../integrations/qbo/client.js';

import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

const MIGRATION_SQL_0046 = loadMigrationSql('0046');
const MIGRATION_SQL_0045 = loadMigrationSql('0045');

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

let tailSuffix = 0;
function nextTail(prefix: string): string {
  tailSuffix += 1;
  return `${prefix}${tailSuffix}`;
}

// ── Fake QboClient — records calls; configurable failures. NO real HTTP. ──────

let payCounter = 0;
let invCounter = 0;
let custCounter = 0;

class FakeQboClient implements QboClient {
  createInvoiceCalls: QboInvoicePayload[] = [];
  createPaymentCalls: QboPaymentPayload[] = [];
  /** Invoice ids (as embedded in PrivateNote) whose createInvoice should throw. */
  failInvoiceIds = new Set<string>();
  failCreatePayment = false;

  async createCustomer(
    _input: QboCreateCustomerInput,
    _ctx: QboRequestContext,
  ): Promise<{ qboCustomerId: string }> {
    custCounter += 1;
    return { qboCustomerId: `qbo-cust-${custCounter}` };
  }

  async createInvoice(payload: QboInvoicePayload, _ctx: QboRequestContext): Promise<{ qboInvoiceId: string }> {
    this.createInvoiceCalls.push(payload);
    for (const id of this.failInvoiceIds) {
      if (payload.PrivateNote.includes(id)) throw new Error(`fake invoice failure for ${id}`);
    }
    invCounter += 1;
    return { qboInvoiceId: `qbo-inv-${invCounter}` };
  }

  async createPayment(payload: QboPaymentPayload, _ctx: QboRequestContext): Promise<{ qboPaymentId: string }> {
    this.createPaymentCalls.push(payload);
    if (this.failCreatePayment) throw new Error('fake payment failure');
    payCounter += 1;
    return { qboPaymentId: `qbo-pay-${payCounter}` };
  }

  async exchangeAuthCode(): Promise<QboTokenSet> {
    return { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 3_600_000) };
  }

  async refreshTokens(): Promise<QboTokenSet> {
    return { accessToken: 'a2', refreshToken: 'r2', expiresAt: new Date(Date.now() + 3_600_000) };
  }
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedFinalizedInvoice(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tailPrefix: string,
): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const tail = nextTail(tailPrefix);
  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `Test ${tail}`,
    tailNumber: `N${tail}`,
  });
  const start = new Date(`2026-09-0${(tailSuffix % 9) + 1}T08:00:00Z`);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const rR = await createReservationWithDb(db, sess, { startAt: start, endAt: end, resourceIds: [aircraft.id] });
  if (!rR.ok) throw new Error(`reservation failed: ${rR.reason}`);
  const openR = await openDispatchWithDb(db, sess, {
    reservationId: rR.reservation.id,
    resourceId: aircraft.id,
    pilotUserId: userId,
    hobbsOut: 100.0,
    tachOut: 50.0,
  });
  if (!openR.ok) throw new Error(`openDispatch failed: ${openR.reason}`);
  const closeR = await closeDispatchWithDb(db, sess, { ticketId: openR.ticket.id, hobbsIn: 101.3, tachIn: 51.3 });
  if (!closeR.ok) throw new Error(`closeDispatch failed: ${closeR.reason}`);
  const rateR = await createRateScheduleWithDb(db, sess, {
    name: `${tail} rate`,
    rateKind: 'wet_hourly',
    amountCents: 12500,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  });
  if (!rateR.ok) throw new Error('rate failed');
  const invR = await generateInvoiceFromDispatchWithDb(db, sess, {
    dispatchTicketId: closeR.ticket.id,
    rateScheduleId: rateR.rate.id,
    memberUserId: userId,
  });
  if (!invR.ok) throw new Error('invoice failed');
  const finR = await finalizeInvoiceWithDb(db, sess, { id: invR.invoice.id });
  if (!finR.ok) throw new Error('finalize failed');
  return invR.invoice.id;
}

/** Cheap finalized invoice with NO line items (export fails at mapping — used for the bound test). */
async function seedFinalizedInvoiceRaw(db: PgliteTestClient, orgId: string, userId: string): Promise<string> {
  const rows = await withOrgContext(db, orgId, async (tx) => {
    return extractInsertedIds(
      await tx.execute(sql`
        INSERT INTO "invoice" ("org_id","member_user_id","status","subtotal_cents","total_cents","issued_at","created_by")
        VALUES (${orgId}::uuid, ${userId}::uuid, 'finalized', 0, 0, NOW(), ${userId}::uuid)
        RETURNING "id"
      `),
    );
  });
  const id = rows[0];
  if (!id) throw new Error('seedFinalizedInvoiceRaw: no id');
  return id;
}

function extractInsertedIds(result: { rows?: Array<{ id: string }> } | Array<{ id: string }>): string[] {
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  return rows.map((r) => r.id);
}

/** Idempotent: upsert a fully-connected qbo_connection row (unique org_id). */
async function seedConnection(db: PgliteTestClient, orgId: string): Promise<void> {
  await withOrgContext(db, orgId, (tx) =>
    tx
      .insert(qboConnection)
      .values({
        orgId,
        realmId: 'realm-xyz',
        accessToken: 'access-tok',
        refreshToken: 'refresh-tok',
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        status: 'connected',
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: qboConnection.orgId,
        set: {
          realmId: 'realm-xyz',
          accessToken: 'access-tok',
          refreshToken: 'refresh-tok',
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
          status: 'connected',
          updatedAt: new Date(),
        },
      }),
  );
}

async function mapWetHourly(db: PgliteTestClient, orgId: string, userId: string): Promise<void> {
  const sess = makeSession(orgId, userId, 'owner');
  const r = await setQboAccountMappingWithDb(db, sess, {
    lineKind: 'wet_hourly',
    qboItemId: '77',
    qboItemName: 'Aircraft rental',
  });
  if (!r.ok) throw new Error('map failed');
}

/** Insert a 'payment' credit ledger entry linked to `invoiceId`; returns entry id. */
async function seedInvoicePayment(
  db: PgliteTestClient,
  orgId: string,
  invoiceId: string,
  amountCents: number,
): Promise<string> {
  return withOrgContext(db, orgId, async (tx) => {
    const acctRows = await tx
      .select({ accountId: ledgerEntry.accountId })
      .from(ledgerEntry)
      .where(and(eq(ledgerEntry.invoiceId, invoiceId), eq(ledgerEntry.entryType, 'invoice_finalized')))
      .limit(1);
    const accountId = acctRows[0]?.accountId;
    if (!accountId) throw new Error('seedInvoicePayment: no finalized ledger entry to derive account');
    const inserted = await tx
      .insert(ledgerEntry)
      .values({
        orgId,
        accountId,
        entryType: 'payment',
        direction: 'credit',
        amountCents,
        invoiceId,
        paymentId: 'check-1042',
        memo: 'test payment',
        createdBy: null,
      })
      .returning({ id: ledgerEntry.id });
    const id = inserted[0]?.id;
    if (!id) throw new Error('seedInvoicePayment: no id');
    return id;
  });
}

async function countExportLog(
  db: PgliteTestClient,
  orgId: string,
  entityType: string,
  entityId: string,
): Promise<{ exported: number; error: number }> {
  return withOrgContext(db, orgId, async (tx) => {
    const rows = await tx
      .select({ status: qboExportLog.status })
      .from(qboExportLog)
      .where(
        and(
          eq(qboExportLog.orgId, orgId),
          eq(qboExportLog.entityType, entityType),
          eq(qboExportLog.entityId, entityId),
        ),
      );
    return {
      exported: rows.filter((r) => r.status === 'exported').length,
      error: rows.filter((r) => r.status === 'error').length,
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// env0046 — full SYNC layer
// ════════════════════════════════════════════════════════════════════════════

describe('QBO SYNC (migration 0046 applied)', () => {
  let env: TestEnv;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL_0046);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    env = { db, pglite, orgAId: seed.orgAId, orgBId: seed.orgBId, userAId: seed.userAId, userBId: seed.userBId };
    process.env['AUTH_SECRET'] = 'qbo-sync-test-secret';
  }, 120_000);

  // ── AUTO-SYNC TOGGLE + HOOK ──────────────────────────────────────────────

  describe('auto-export setting', () => {
    it('billing:access required to read; org:manage_settings to write', async () => {
      await expect(getQboAutoExportWithDb(env.db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
      await expect(
        getQboAutoExportWithDb(env.db, makeSession(env.orgAId, env.userAId, 'dispatcher')),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        setQboAutoExportWithDb(env.db, makeSession(env.orgAId, env.userAId, 'accountant'), { autoExportInvoices: true }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('available:true on a 0046 DB; set → get round-trips; no-op writes no audit', async () => {
      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      const before = await getQboAutoExportWithDb(env.db, sess);
      expect(before.available).toBe(true);
      expect(before.autoExportInvoices).toBe(false);

      const set1 = await setQboAutoExportWithDb(env.db, sess, { autoExportInvoices: true });
      expect(set1).toEqual({ ok: true, autoExportInvoices: true });
      expect((await getQboAutoExportWithDb(env.db, sess)).autoExportInvoices).toBe(true);

      const auditBefore = await withOrgContext(env.db, env.orgAId, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, 'qbo.auto_export_config_changed')),
      );
      // No-op (already true) writes nothing.
      await setQboAutoExportWithDb(env.db, sess, { autoExportInvoices: true });
      const auditAfter = await withOrgContext(env.db, env.orgAId, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, 'qbo.auto_export_config_changed')),
      );
      expect(auditAfter.length).toBe(auditBefore.length);

      // reset
      await setQboAutoExportWithDb(env.db, sess, { autoExportInvoices: false });
    });

    it('T-ISO: org A toggle does not leak into org B', async () => {
      await setQboAutoExportWithDb(env.db, makeSession(env.orgAId, env.userAId), { autoExportInvoices: true });
      const bView = await getQboAutoExportWithDb(env.db, makeSession(env.orgBId, env.userBId));
      expect(bView.autoExportInvoices).toBe(false);
      await setQboAutoExportWithDb(env.db, makeSession(env.orgAId, env.userAId), { autoExportInvoices: false });
    });
  });

  describe('auto-export hook', () => {
    it('OFF ⇒ triggered:false and ZERO export-log rows (byte-identity)', async () => {
      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      await seedConnection(env.db, env.orgAId);
      await mapWetHourly(env.db, env.orgAId, env.userAId);
      const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'OFF');

      const client = new FakeQboClient();
      const result = await autoExportInvoiceOnFinalizeWithDb(env.db, sess, { invoiceId }, client);
      expect(result).toEqual({ triggered: false });
      expect(client.createInvoiceCalls.length).toBe(0);
      const counts = await countExportLog(env.db, env.orgAId, 'invoice', invoiceId);
      expect(counts.exported).toBe(0);
      expect(counts.error).toBe(0);
    });

    it('ON + connected ⇒ exports the invoice (one export-log row + client called)', async () => {
      const sess = makeSession(env.orgBId, env.userBId, 'owner');
      await seedConnection(env.db, env.orgBId);
      await mapWetHourly(env.db, env.orgBId, env.userBId);
      await setQboAutoExportWithDb(env.db, sess, { autoExportInvoices: true });
      const invoiceId = await seedFinalizedInvoice(env.db, env.orgBId, env.userBId, 'ON');

      const client = new FakeQboClient();
      const result = await autoExportInvoiceOnFinalizeWithDb(env.db, sess, { invoiceId }, client);
      expect(result.triggered).toBe(true);
      if (result.triggered) expect(result.result.ok).toBe(true);
      expect(client.createInvoiceCalls.length).toBe(1);
      const counts = await countExportLog(env.db, env.orgBId, 'invoice', invoiceId);
      expect(counts.exported).toBe(1);
    });

    it('ON but NOT connected ⇒ triggered:true, refusal not_connected, no export row', async () => {
      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      // org A has a connection seeded above; use a fresh member-only invoice but
      // disconnect first to prove the not-connected path.
      await withOrgContext(env.db, env.orgAId, (tx) =>
        tx.update(qboConnection).set({ status: 'disconnected' }).where(eq(qboConnection.orgId, env.orgAId)),
      );
      await setQboAutoExportWithDb(env.db, sess, { autoExportInvoices: true });
      const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'NC');

      const client = new FakeQboClient();
      const result = await autoExportInvoiceOnFinalizeWithDb(env.db, sess, { invoiceId }, client);
      expect(result.triggered).toBe(true);
      if (result.triggered && !result.result.ok) expect(result.result.reason).toBe('not_connected');
      expect(client.createInvoiceCalls.length).toBe(0);
      const counts = await countExportLog(env.db, env.orgAId, 'invoice', invoiceId);
      expect(counts.exported).toBe(0);

      // restore for later tests
      await withOrgContext(env.db, env.orgAId, (tx) =>
        tx.update(qboConnection).set({ status: 'connected' }).where(eq(qboConnection.orgId, env.orgAId)),
      );
      await setQboAutoExportWithDb(env.db, sess, { autoExportInvoices: false });
    });
  });

  // ── PAYMENT SYNC ─────────────────────────────────────────────────────────

  describe('payment sync', () => {
    it('billing:manage required', async () => {
      await expect(syncPaymentToQboWithDb(env.db, null, { ledgerEntryId: crypto.randomUUID() })).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
      await expect(
        syncPaymentToQboWithDb(env.db, makeSession(env.orgAId, env.userAId, 'accountant'), {
          ledgerEntryId: crypto.randomUUID(),
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('happy path: exported invoice + payment ⇒ ReceivePayment pushed, recorded, idempotent', async () => {
      const sess = makeSession(env.orgBId, env.userBId, 'owner');
      await seedConnection(env.db, env.orgBId);
      await mapWetHourly(env.db, env.orgBId, env.userBId);
      const invoiceId = await seedFinalizedInvoice(env.db, env.orgBId, env.userBId, 'PAY');
      const client = new FakeQboClient();
      const exp = await exportInvoiceToQboWithDb(env.db, sess, { invoiceId }, client);
      expect(exp.ok).toBe(true);

      const entryId = await seedInvoicePayment(env.db, env.orgBId, invoiceId, 5000);
      const r1 = await syncPaymentToQboWithDb(env.db, sess, { ledgerEntryId: entryId }, client);
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.alreadySynced).toBe(false);
      expect(client.createPaymentCalls.length).toBe(1);
      expect(client.createPaymentCalls[0]?.Line[0]?.LinkedTxn[0]?.TxnType).toBe('Invoice');
      const c1 = await countExportLog(env.db, env.orgBId, 'payment', entryId);
      expect(c1.exported).toBe(1);
      const audit = await withOrgContext(env.db, env.orgBId, (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.action, 'billing.payment_synced_to_qbo'), eq(auditLog.entityId, entryId))),
      );
      expect(audit.length).toBe(1);

      // Idempotent — second call returns alreadySynced, client NOT called again.
      const r2 = await syncPaymentToQboWithDb(env.db, sess, { ledgerEntryId: entryId }, client);
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.alreadySynced).toBe(true);
      expect(client.createPaymentCalls.length).toBe(1);
    });

    it('refuses a payment whose invoice was never exported (invoice_not_exported)', async () => {
      const sess = makeSession(env.orgBId, env.userBId, 'owner');
      const invoiceId = await seedFinalizedInvoice(env.db, env.orgBId, env.userBId, 'NOEXP');
      const entryId = await seedInvoicePayment(env.db, env.orgBId, invoiceId, 3000);
      const client = new FakeQboClient();
      const r = await syncPaymentToQboWithDb(env.db, sess, { ledgerEntryId: entryId }, client);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('invoice_not_exported');
      expect(client.createPaymentCalls.length).toBe(0);
    });

    it('refuses a non-payment / invoice-unlinked ledger entry (not_a_payment)', async () => {
      const sess = makeSession(env.orgBId, env.userBId, 'owner');
      // the invoice_finalized debit is not a 'payment' entry.
      const invoiceId = await seedFinalizedInvoice(env.db, env.orgBId, env.userBId, 'DEBIT');
      const debit = await withOrgContext(env.db, env.orgBId, (tx) =>
        tx
          .select({ id: ledgerEntry.id })
          .from(ledgerEntry)
          .where(and(eq(ledgerEntry.invoiceId, invoiceId), eq(ledgerEntry.entryType, 'invoice_finalized')))
          .limit(1),
      );
      const r = await syncPaymentToQboWithDb(env.db, sess, { ledgerEntryId: debit[0]!.id }, new FakeQboClient());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('not_a_payment');
    });

    it('provider error ⇒ recorded as an error row, never swallowed', async () => {
      const sess = makeSession(env.orgBId, env.userBId, 'owner');
      await mapWetHourly(env.db, env.orgBId, env.userBId);
      const invoiceId = await seedFinalizedInvoice(env.db, env.orgBId, env.userBId, 'PERR');
      const client = new FakeQboClient();
      await exportInvoiceToQboWithDb(env.db, sess, { invoiceId }, client);
      const entryId = await seedInvoicePayment(env.db, env.orgBId, invoiceId, 4200);
      client.failCreatePayment = true;
      const r = await syncPaymentToQboWithDb(env.db, sess, { ledgerEntryId: entryId }, client);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('provider_error');
      const c = await countExportLog(env.db, env.orgBId, 'payment', entryId);
      expect(c.exported).toBe(0);
      expect(c.error).toBe(1);
    });

    it('T-ISO: org B cannot sync org A payment entry id', async () => {
      const sessA = makeSession(env.orgAId, env.userAId, 'owner');
      await seedConnection(env.db, env.orgAId);
      await mapWetHourly(env.db, env.orgAId, env.userAId);
      const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'ISO');
      await exportInvoiceToQboWithDb(env.db, sessA, { invoiceId }, new FakeQboClient());
      const entryId = await seedInvoicePayment(env.db, env.orgAId, invoiceId, 1000);

      const sessB = makeSession(env.orgBId, env.userBId, 'owner');
      const r = await syncPaymentToQboWithDb(env.db, sessB, { ledgerEntryId: entryId }, new FakeQboClient());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('entry_not_found');
    });
  });

  // ── BACKFILL ─────────────────────────────────────────────────────────────

  describe('backfill', () => {
    it('billing:manage required', async () => {
      await expect(backfillQboExportsWithDb(env.db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
      await expect(
        backfillQboExportsWithDb(env.db, makeSession(env.orgAId, env.userAId, 'accountant')),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('not connected ⇒ zeros with the whole backlog remaining', async () => {
      // Fresh org context with an unexported finalized invoice but no connection.
      const sess = makeSession(env.orgBId, env.userBId, 'owner');
      await withOrgContext(env.db, env.orgBId, (tx) =>
        tx.update(qboConnection).set({ status: 'disconnected' }).where(eq(qboConnection.orgId, env.orgBId)),
      );
      const r = await backfillQboExportsWithDb(env.db, sess, new FakeQboClient());
      expect(r.exported).toBe(0);
      expect(r.failed).toBe(0);
      expect(r.remaining).toBeGreaterThan(0);
      await withOrgContext(env.db, env.orgBId, (tx) =>
        tx.update(qboConnection).set({ status: 'connected' }).where(eq(qboConnection.orgId, env.orgBId)),
      );
    });

    it('partial-failure resilient: one failure does not abort the batch', async () => {
      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      // Pin org A connected + wet_hourly mapped, then three fresh invoices.
      await seedConnection(env.db, env.orgAId);
      await mapWetHourly(env.db, env.orgAId, env.userAId);
      const i1 = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'BF');
      const i2 = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'BF');
      const i3 = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'BF');
      const client = new FakeQboClient();
      client.failInvoiceIds.add(i2); // middle one fails

      const r = await backfillQboExportsWithDb(env.db, sess, client);
      expect(r.exported).toBeGreaterThanOrEqual(2);
      expect(r.failed).toBeGreaterThanOrEqual(1);
      // i1 + i3 exported; i2 has an error row.
      expect((await countExportLog(env.db, env.orgAId, 'invoice', i1)).exported).toBe(1);
      expect((await countExportLog(env.db, env.orgAId, 'invoice', i3)).exported).toBe(1);
      expect((await countExportLog(env.db, env.orgAId, 'invoice', i2)).exported).toBe(0);
    });

    it(`bounded to ${QBO_BACKFILL_BATCH_LIMIT} per run`, async () => {
      // A dedicated org: many cheap unexported finalized invoices.
      const { db } = env;
      const bulk = await createTestClient();
      await applyMigrationSql({ pglite: bulk.pglite }, MIGRATION_SQL_0046);
      const seed = await seedTwoOrgs(bulk.db);
      await setTestAppRole({ pglite: bulk.pglite });
      const sess = makeSession(seed.orgAId, seed.userAId, 'owner');
      await seedConnection(bulk.db, seed.orgAId);
      const total = QBO_BACKFILL_BATCH_LIMIT + 2;
      for (let i = 0; i < total; i++) {
        await seedFinalizedInvoiceRaw(bulk.db, seed.orgAId, seed.userAId);
      }
      const r = await backfillQboExportsWithDb(bulk.db, sess, new FakeQboClient());
      // No line items ⇒ every export fails at mapping; processed count is capped.
      expect(r.exported + r.failed).toBe(QBO_BACKFILL_BATCH_LIMIT);
      expect(r.remaining).toBe(total);
      void db;
    }, 120_000);
  });

  // ── WEBHOOK AUTO PAYMENT SYNC (system path) ──────────────────────────────

  describe('webhook auto payment sync (system path)', () => {
    it('toggle OFF ⇒ triggered:false and ZERO payment export rows', async () => {
      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      await seedConnection(env.db, env.orgAId);
      await mapWetHourly(env.db, env.orgAId, env.userAId);
      await setQboAutoExportWithDb(env.db, sess, { autoExportInvoices: false });
      const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'WS');
      await exportInvoiceToQboWithDb(env.db, sess, { invoiceId }, new FakeQboClient());
      const entryId = await seedInvoicePayment(env.db, env.orgAId, invoiceId, 5000);

      const client = new FakeQboClient();
      const r = await autoSyncPaymentToQboOnStripeWebhook(env.db, env.orgAId, entryId, client);
      expect(r).toEqual({ triggered: false });
      expect(client.createPaymentCalls).toHaveLength(0);
      expect((await countExportLog(env.db, env.orgAId, 'payment', entryId)).exported).toBe(0);
    });

    it('toggle ON ⇒ ReceivePayment pushed against the exported invoice; audit actor is NULL (system)', async () => {
      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      await seedConnection(env.db, env.orgAId);
      await mapWetHourly(env.db, env.orgAId, env.userAId);
      await setQboAutoExportWithDb(env.db, sess, { autoExportInvoices: true });
      try {
        const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'WS');
        const client = new FakeQboClient();
        const expR = await exportInvoiceToQboWithDb(env.db, sess, { invoiceId }, client);
        if (!expR.ok) throw new Error('export failed');
        const entryId = await seedInvoicePayment(env.db, env.orgAId, invoiceId, 12500);

        const r = await autoSyncPaymentToQboOnStripeWebhook(env.db, env.orgAId, entryId, client);
        expect(r.triggered).toBe(true);
        if (r.triggered) expect(r.result).toMatchObject({ ok: true, alreadySynced: false });

        // The ReceivePayment is linked to the invoice's own QBO id.
        expect(client.createPaymentCalls).toHaveLength(1);
        const linked = client.createPaymentCalls[0]?.Line[0]?.LinkedTxn[0];
        expect(linked?.TxnType).toBe('Invoice');
        expect(linked?.TxnId).toBe(expR.qboInvoiceId);

        expect((await countExportLog(env.db, env.orgAId, 'payment', entryId)).exported).toBe(1);

        // System write: the audit actor is null, exactly like
        // billing.stripe_payment_succeeded.
        const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
          tx
            .select()
            .from(auditLog)
            .where(
              and(
                eq(auditLog.orgId, env.orgAId),
                eq(auditLog.action, 'billing.payment_synced_to_qbo'),
                eq(auditLog.entityId, entryId),
              ),
            ),
        );
        expect(audits).toHaveLength(1);
        expect(audits[0]?.actorUserId).toBeNull();

        // Idempotent: a webhook redelivery re-running the hook does NOT push twice.
        const r2 = await autoSyncPaymentToQboOnStripeWebhook(env.db, env.orgAId, entryId, client);
        if (r2.triggered) expect(r2.result).toMatchObject({ ok: true, alreadySynced: true });
        expect(client.createPaymentCalls).toHaveLength(1);
      } finally {
        await setQboAutoExportWithDb(env.db, sess, { autoExportInvoices: false });
      }
    });

    it('NEVER throws: malformed ids and provider failures degrade to typed values', async () => {
      const r1 = await autoSyncPaymentToQboOnStripeWebhook(env.db, 'not-a-uuid', crypto.randomUUID(), new FakeQboClient());
      expect(r1).toEqual({ triggered: false });

      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      await setQboAutoExportWithDb(env.db, sess, { autoExportInvoices: true });
      try {
        const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'WS');
        const client = new FakeQboClient();
        const expR = await exportInvoiceToQboWithDb(env.db, sess, { invoiceId }, client);
        if (!expR.ok) throw new Error('export failed');
        const entryId = await seedInvoicePayment(env.db, env.orgAId, invoiceId, 900);
        client.failCreatePayment = true;

        const r2 = await autoSyncPaymentToQboOnStripeWebhook(env.db, env.orgAId, entryId, client);
        expect(r2.triggered).toBe(true);
        if (r2.triggered) expect(r2.result).toMatchObject({ ok: false, reason: 'provider_error' });
        // The failure is RECORDED, never swallowed.
        expect((await countExportLog(env.db, env.orgAId, 'payment', entryId)).error).toBe(1);
      } finally {
        await setQboAutoExportWithDb(env.db, sess, { autoExportInvoices: false });
      }
    });
  });

  // ── BACKFILL — payment arm ───────────────────────────────────────────────

  describe('backfill — payments', () => {
    it('one press exports an invoice AND its payment; the second press is a no-op', async () => {
      const bulk = await createTestClient();
      await applyMigrationSql({ pglite: bulk.pglite }, MIGRATION_SQL_0046);
      const seed = await seedTwoOrgs(bulk.db);
      await setTestAppRole({ pglite: bulk.pglite });
      const sess = makeSession(seed.orgAId, seed.userAId, 'owner');
      await seedConnection(bulk.db, seed.orgAId);
      await mapWetHourly(bulk.db, seed.orgAId, seed.userAId);

      const invoiceId = await seedFinalizedInvoice(bulk.db, seed.orgAId, seed.userAId, 'PB');
      const entryId = await seedInvoicePayment(bulk.db, seed.orgAId, invoiceId, 12500);

      const client = new FakeQboClient();
      const r1 = await backfillQboExportsWithDb(bulk.db, sess, client);
      expect(r1.exported).toBe(1);
      expect(r1.remaining).toBe(0);
      // The payment became eligible DURING this press (its invoice was just
      // exported) and was synced in the same run.
      expect(r1.paymentsExported).toBe(1);
      expect(r1.paymentsFailed).toBe(0);
      expect(r1.paymentsRemaining).toBe(0);
      expect((await countExportLog(bulk.db, seed.orgAId, 'payment', entryId)).exported).toBe(1);

      const r2 = await backfillQboExportsWithDb(bulk.db, sess, client);
      expect(r2.exported).toBe(0);
      expect(r2.paymentsExported).toBe(0);
      expect(client.createPaymentCalls).toHaveLength(1);
    }, 60_000);

    it('a payment provider failure is tallied and retryable on the next run', async () => {
      const bulk = await createTestClient();
      await applyMigrationSql({ pglite: bulk.pglite }, MIGRATION_SQL_0046);
      const seed = await seedTwoOrgs(bulk.db);
      await setTestAppRole({ pglite: bulk.pglite });
      const sess = makeSession(seed.orgAId, seed.userAId, 'owner');
      await seedConnection(bulk.db, seed.orgAId);
      await mapWetHourly(bulk.db, seed.orgAId, seed.userAId);

      const invoiceId = await seedFinalizedInvoice(bulk.db, seed.orgAId, seed.userAId, 'PF');
      const entryId = await seedInvoicePayment(bulk.db, seed.orgAId, invoiceId, 4400);

      const failing = new FakeQboClient();
      failing.failCreatePayment = true;
      const r1 = await backfillQboExportsWithDb(bulk.db, sess, failing);
      expect(r1.paymentsExported).toBe(0);
      expect(r1.paymentsFailed).toBe(1);
      expect(r1.paymentsRemaining).toBe(1);

      const healthy = new FakeQboClient();
      const r2 = await backfillQboExportsWithDb(bulk.db, sess, healthy);
      expect(r2.paymentsExported).toBe(1);
      expect(r2.paymentsRemaining).toBe(0);
      expect((await countExportLog(bulk.db, seed.orgAId, 'payment', entryId)).exported).toBe(1);
    }, 60_000);
  });

  // ── STATUS READ ──────────────────────────────────────────────────────────

  describe('invoice export status read', () => {
    it('derives not_exported / exported / failed', async () => {
      const sess = makeSession(env.orgBId, env.userBId, 'owner');
      await seedConnection(env.db, env.orgBId);
      await mapWetHourly(env.db, env.orgBId, env.userBId);

      const notExported = await seedFinalizedInvoice(env.db, env.orgBId, env.userBId, 'ST');
      const exported = await seedFinalizedInvoice(env.db, env.orgBId, env.userBId, 'ST');
      await exportInvoiceToQboWithDb(env.db, sess, { invoiceId: exported }, new FakeQboClient());
      const failed = await seedFinalizedInvoice(env.db, env.orgBId, env.userBId, 'ST');
      const failClient = new FakeQboClient();
      failClient.failInvoiceIds.add(failed);
      await exportInvoiceToQboWithDb(env.db, sess, { invoiceId: failed }, failClient);

      const res = await getInvoiceQboStatusesWithDb(env.db, sess, {
        invoiceIds: [notExported, exported, failed],
      });
      const byId = new Map(res.statuses.map((s) => [s.invoiceId, s]));
      expect(byId.get(notExported)?.status).toBe('not_exported');
      expect(byId.get(exported)?.status).toBe('exported');
      expect(byId.get(exported)?.qboId).toBeTruthy();
      expect(byId.get(failed)?.status).toBe('failed');
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// env0045 — GRACEFUL ABSENCE (0046 unapplied)
// ════════════════════════════════════════════════════════════════════════════

describe('QBO SYNC — graceful absence (migration 0046 NOT applied)', () => {
  let env: TestEnv;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL_0045);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    env = { db, pglite, orgAId: seed.orgAId, orgBId: seed.orgBId, userAId: seed.userAId, userBId: seed.userBId };
    process.env['AUTH_SECRET'] = 'qbo-sync-absence-secret';
  }, 120_000);

  it('getQboAutoExport ⇒ available:false, OFF', async () => {
    const view = await getQboAutoExportWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'));
    expect(view).toEqual({ autoExportInvoices: false, available: false });
  });

  it('setQboAutoExport ⇒ not_available', async () => {
    const r = await setQboAutoExportWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), {
      autoExportInvoices: true,
    });
    expect(r).toEqual({ ok: false, reason: 'not_available' });
  });

  it('auto-export hook ⇒ triggered:false (byte-identical no-op)', async () => {
    const r = await autoExportInvoiceOnFinalizeWithDb(
      env.db,
      makeSession(env.orgAId, env.userAId, 'owner'),
      { invoiceId: crypto.randomUUID() },
      new FakeQboClient(),
    );
    expect(r).toEqual({ triggered: false });
  });

  it('syncPaymentToQbo ⇒ not_available', async () => {
    const r = await syncPaymentToQboWithDb(
      env.db,
      makeSession(env.orgAId, env.userAId, 'owner'),
      { ledgerEntryId: crypto.randomUUID() },
      new FakeQboClient(),
    );
    expect(r).toEqual({ ok: false, reason: 'not_available' });
  });

  it('webhook auto payment sync ⇒ triggered:false (byte-identical no-op)', async () => {
    const client = new FakeQboClient();
    const r = await autoSyncPaymentToQboOnStripeWebhook(env.db, env.orgAId, crypto.randomUUID(), client);
    expect(r).toEqual({ triggered: false });
    expect(client.createPaymentCalls).toHaveLength(0);
  });

  it('backfill ⇒ payment arm reports zeros and never touches 0046 objects', async () => {
    const r = await backfillQboExportsWithDb(
      env.db,
      makeSession(env.orgAId, env.userAId, 'owner'),
      new FakeQboClient(),
    );
    expect(r.paymentsExported).toBe(0);
    expect(r.paymentsFailed).toBe(0);
    expect(r.paymentsRemaining).toBe(0);
  });
});
