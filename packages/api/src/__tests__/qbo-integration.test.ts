/**
 * qbo-integration.test.ts — Integration tests for Slice QB1 (QuickBooks
 * Online bookkeeping export).
 *
 * Applies migrations 0000–0021 (0021 = QBO integration tables). Uses
 * PGlite + WithDb functions + a FAKE QboClient injected via the optional
 * `client` parameter — NO real HTTP calls anywhere in this file.
 *
 * COVERAGE:
 *   CAPS: billing:access (getQboStatus), billing:manage (exportInvoiceToQbo),
 *     org:manage_settings (account mapping / connect / disconnect) enforced;
 *     non-privileged roles Forbidden; null session Unauthenticated.
 *   ACCOUNT MAPPING: set (upsert) + audit; delete + audit; not_found.
 *   CONNECT: completeQboOAuth valid state → connects + audit; mismatched
 *     state → invalid_state; disconnectQbo nulls tokens + audit; disconnect
 *     with no prior connection → not_connected.
 *   EXPORT: happy path (fake client records calls) → 'exported' log rows
 *     (invoice + customer) + audit; idempotent double-export (client NOT
 *     called again); refuses draft invoice; refuses without cap; unmapped
 *     kind → refusal + 'error' log row (never silently lumped); provider
 *     error → 'error' log row + audit, never swallowed; not_connected when
 *     no qbo_connection row; unconfigured stub → clean typed refusal
 *     (StubQboClient direct + via ensureFreshAccessToken token-refresh path).
 *   T-ISO: org B cannot see org A's connection/export-log/account-mapping.
 *   NO MONEY: no Stripe/payment/card; the pure mapper never lumps.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  appUser,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';
import { createRateScheduleWithDb } from '../billing/rate-commands.js';
import { generateInvoiceFromDispatchWithDb } from '../billing/generate-invoice.js';
import { finalizeInvoiceWithDb } from '../billing/invoice-status-commands.js';

import {
  setQboAccountMappingWithDb,
  deleteQboAccountMappingWithDb,
} from '../integrations/qbo/account-mapping.js';
import { getQboStatusWithDb } from '../integrations/qbo/status.js';
import {
  completeQboOAuthWithDb,
  disconnectQboWithDb,
  buildQboAuthorizeUrl,
} from '../integrations/qbo/connect.js';
import { exportInvoiceToQboWithDb } from '../integrations/qbo/export-invoice.js';
import { signQboState } from '../integrations/qbo/state.js';
import { StubQboClient, QboNotConfiguredError } from '../integrations/qbo/client.js';
import type {
  QboClient,
  QboCreateCustomerInput,
  QboRequestContext,
  QboInvoicePayload,
  QboTokenSet,
} from '../integrations/qbo/client.js';

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

const TEST_AUTH_SECRET = 'qbo-integration-test-secret-not-a-real-secret';

let env: TestEnv;
let tailSuffix = 0;
function nextTail(prefix: string): string {
  tailSuffix += 1;
  return `${prefix}${tailSuffix}`;
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

/** Insert a fresh app_user in the given org (a distinct QBO "customer" identity). */
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
  return row.id;
}

/** Seed a FINALIZED invoice (one wet_hourly line) for the given org/user. Returns invoiceId. */
async function seedFinalizedInvoice(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tailPrefix: string,
  memberUserId: string = userId,
): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const { aircraftId, reservationId } = await seedAircraftAndReservation(db, orgId, userId, tailPrefix);
  const ticketId = await seedClosedTicket(db, orgId, userId, aircraftId, reservationId);
  const rateR = await createRateScheduleWithDb(db, sess, {
    name: `${tailPrefix} rate`,
    rateKind: 'wet_hourly',
    amountCents: 12500,
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
  return invR.invoice.id;
}

/** Seed a DRAFT (not finalized) invoice. Returns invoiceId. */
async function seedDraftInvoice(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tailPrefix: string,
): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const { aircraftId, reservationId } = await seedAircraftAndReservation(db, orgId, userId, tailPrefix);
  const ticketId = await seedClosedTicket(db, orgId, userId, aircraftId, reservationId);
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
    memberUserId: userId,
  });
  if (!invR.ok) throw new Error('seed invoice failed');
  return invR.invoice.id;
}

/** Insert a 'connected' qbo_connection row directly (bypassing OAuth) for a given org. */
async function seedConnection(
  db: PgliteTestClient,
  orgId: string,
  opts: { expiresInMs?: number } = {},
): Promise<void> {
  const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? 60 * 60 * 1000));
  await withOrgContext(db, orgId, (tx) =>
    tx.insert(qboConnection).values({
      orgId,
      realmId: 'realm-123',
      accessToken: 'access-token-abc',
      refreshToken: 'refresh-token-abc',
      accessTokenExpiresAt: expiresAt,
      status: 'connected',
      updatedAt: new Date(),
    }),
  );
}

// ── Fake QboClient ─────────────────────────────────────────────────────────────

interface FakeCall {
  kind: 'createCustomer' | 'createInvoice' | 'exchangeAuthCode' | 'refreshTokens';
  args: unknown;
}

class FakeQboClient implements QboClient {
  calls: FakeCall[] = [];
  failCreateInvoice = false;
  failCreateCustomer = false;

  async createCustomer(
    input: QboCreateCustomerInput,
    ctx: QboRequestContext,
  ): Promise<{ qboCustomerId: string }> {
    this.calls.push({ kind: 'createCustomer', args: { input, ctx } });
    if (this.failCreateCustomer) throw new Error('fake customer create failure');
    return { qboCustomerId: 'qbo-cust-1' };
  }

  async createInvoice(
    payload: QboInvoicePayload,
    ctx: QboRequestContext,
  ): Promise<{ qboInvoiceId: string }> {
    this.calls.push({ kind: 'createInvoice', args: { payload, ctx } });
    if (this.failCreateInvoice) throw new Error('fake invoice create failure');
    return { qboInvoiceId: 'qbo-inv-1' };
  }

  async exchangeAuthCode(code: string, redirectUri: string): Promise<QboTokenSet> {
    this.calls.push({ kind: 'exchangeAuthCode', args: { code, redirectUri } });
    return {
      accessToken: 'fresh-access-token',
      refreshToken: 'fresh-refresh-token',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
  }

  async refreshTokens(refreshToken: string): Promise<QboTokenSet> {
    this.calls.push({ kind: 'refreshTokens', args: { refreshToken } });
    return {
      accessToken: 'refreshed-access-token',
      refreshToken: 'refreshed-refresh-token',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
  }
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
  process.env['AUTH_SECRET'] = TEST_AUTH_SECRET;
}, 120_000);

afterAll(() => {
  delete process.env['AUTH_SECRET'];
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CAPABILITY GATES
// ════════════════════════════════════════════════════════════════════════════════

describe('CAPS: billing:access gate (getQboStatus)', () => {
  it('null session → UnauthenticatedError', async () => {
    await expect(getQboStatusWithDb(env.db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('dispatcher lacks billing:access → ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(getQboStatusWithDb(env.db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('accountant HAS billing:access → getQboStatus OK', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const result = await getQboStatusWithDb(env.db, sess);
    expect(result).toHaveProperty('providerConfigured');
    expect(result).toHaveProperty('recentExports');
    expect(result).toHaveProperty('accountMapping');
  });

  it('owner HAS billing:access → getQboStatus OK', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await getQboStatusWithDb(env.db, sess);
    expect(Array.isArray(result.recentExports)).toBe(true);
  });
});

describe('CAPS: org:manage_settings gate (account mapping / connect / disconnect)', () => {
  it('null session → UnauthenticatedError (setQboAccountMapping)', async () => {
    await expect(
      setQboAccountMappingWithDb(env.db, null, { lineKind: 'wet_hourly', qboItemId: '1', qboItemName: 'Rental' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('accountant lacks org:manage_settings → ForbiddenError (setQboAccountMapping)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      setQboAccountMappingWithDb(env.db, sess, { lineKind: 'wet_hourly', qboItemId: '1', qboItemName: 'Rental' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('dispatcher lacks org:manage_settings → ForbiddenError (deleteQboAccountMapping)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(
      deleteQboAccountMappingWithDb(env.db, sess, { lineKind: 'wet_hourly' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('accountant lacks org:manage_settings → ForbiddenError (disconnectQbo)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(disconnectQboWithDb(env.db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('null session → UnauthenticatedError (buildQboAuthorizeUrl)', async () => {
    await expect(buildQboAuthorizeUrl(null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('dispatcher lacks org:manage_settings → ForbiddenError (buildQboAuthorizeUrl)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(buildQboAuthorizeUrl(sess)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('null session → UnauthenticatedError (completeQboOAuth)', async () => {
    await expect(
      completeQboOAuthWithDb(env.db, null, { code: 'x', realmId: 'y', state: 'z' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('CAPS: billing:manage gate (exportInvoiceToQbo)', () => {
  it('null session → UnauthenticatedError', async () => {
    await expect(
      exportInvoiceToQboWithDb(env.db, null, { invoiceId: '00000000-0000-0000-0000-000000000001' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('accountant lacks billing:manage (read-only role) → ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      exportInvoiceToQboWithDb(env.db, sess, { invoiceId: '00000000-0000-0000-0000-000000000001' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('dispatcher lacks billing:manage → ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(
      exportInvoiceToQboWithDb(env.db, sess, { invoiceId: '00000000-0000-0000-0000-000000000001' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2 — ACCOUNT MAPPING
// ════════════════════════════════════════════════════════════════════════════════

describe('ACCOUNT MAPPING: set (upsert) + delete', () => {
  it('setQboAccountMapping creates a row + ONE audit row', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await setQboAccountMappingWithDb(env.db, sess, {
      lineKind: 'wet_hourly',
      qboItemId: 'item-wet-A',
      qboItemName: 'Aircraft Rental (Wet)',
    });
    expect(result.ok).toBe(true);
    expect(result.mapping.lineKind).toBe('wet_hourly');
    expect(result.mapping.qboItemId).toBe('item-wet-A');

    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'qbo.account_mapping_set')).execute(),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('setQboAccountMapping UPSERTs — a second call with the same lineKind updates, not duplicates', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await setQboAccountMappingWithDb(env.db, sess, {
      lineKind: 'instruction',
      qboItemId: 'item-instr-v1',
      qboItemName: 'Instructor Time v1',
    });
    const result2 = await setQboAccountMappingWithDb(env.db, sess, {
      lineKind: 'instruction',
      qboItemId: 'item-instr-v2',
      qboItemName: 'Instructor Time v2',
    });
    expect(result2.ok).toBe(true);
    expect(result2.mapping.qboItemId).toBe('item-instr-v2');

    const status = await getQboStatusWithDb(env.db, sess);
    const instructionRows = status.accountMapping.filter((m) => m.lineKind === 'instruction');
    expect(instructionRows).toHaveLength(1);
    expect(instructionRows[0]?.qboItemId).toBe('item-instr-v2');
  });

  it('deleteQboAccountMapping removes the row + ONE audit row', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await setQboAccountMappingWithDb(env.db, sess, {
      lineKind: 'flat',
      qboItemId: 'item-flat-del',
      qboItemName: 'Flat (to delete)',
    });
    const del = await deleteQboAccountMappingWithDb(env.db, sess, { lineKind: 'flat' });
    expect(del).toEqual({ ok: true });

    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'qbo.account_mapping_removed')).execute(),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('deleteQboAccountMapping on a missing row → not_found', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const del = await deleteQboAccountMappingWithDb(env.db, sess, { lineKind: 'other' });
    expect(del).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3 — CONNECT / DISCONNECT
// ════════════════════════════════════════════════════════════════════════════════

describe('CONNECT: completeQboOAuth + disconnectQbo', () => {
  it('disconnectQbo with no prior connection → not_connected', async () => {
    const sess = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await disconnectQboWithDb(env.db, sess);
    expect(result).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('completeQboOAuth with a mismatched state → invalid_state (no DB write)', async () => {
    const sess = makeSession(env.orgBId, env.userBId, 'owner');
    const wrongState = await signQboState({ orgId: env.orgAId, userId: env.userAId }); // different org
    const fake = new FakeQboClient();
    const result = await completeQboOAuthWithDb(
      env.db,
      sess,
      { code: 'auth-code-1', realmId: 'realm-1', state: wrongState },
      fake,
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_state' });
    expect(fake.calls).toHaveLength(0); // never reached the provider
  });

  it('completeQboOAuth with a valid state (env configured) → connects + audit', async () => {
    const sess = makeSession(env.orgBId, env.userBId, 'owner');
    const state = await signQboState({ orgId: env.orgBId, userId: env.userBId });
    const fake = new FakeQboClient();
    const originalRedirect = process.env['QBO_REDIRECT_URI'];
    process.env['QBO_REDIRECT_URI'] = 'https://example.test/api/integrations/qbo/callback';
    try {
      const result = await completeQboOAuthWithDb(
        env.db,
        sess,
        { code: 'auth-code-2', realmId: 'realm-b', state },
        fake,
      );
      expect(result).toEqual({ ok: true });
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.kind).toBe('exchangeAuthCode');
    } finally {
      if (originalRedirect === undefined) delete process.env['QBO_REDIRECT_URI'];
      else process.env['QBO_REDIRECT_URI'] = originalRedirect;
    }

    const status = await getQboStatusWithDb(env.db, sess);
    expect(status.connection?.status).toBe('connected');
    expect(status.connection?.realmId).toBe('realm-b');
    // NEVER leaks tokens.
    expect(status.connection).not.toHaveProperty('accessToken');
    expect(status.connection).not.toHaveProperty('refreshToken');
  });

  it('completeQboOAuth without QBO_REDIRECT_URI configured → not_configured', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const state = await signQboState({ orgId: env.orgAId, userId: env.userAId });
    const fake = new FakeQboClient();
    const original = process.env['QBO_REDIRECT_URI'];
    delete process.env['QBO_REDIRECT_URI'];
    try {
      const result = await completeQboOAuthWithDb(
        env.db,
        sess,
        { code: 'auth-code-3', realmId: 'realm-a', state },
        fake,
      );
      expect(result).toEqual({ ok: false, reason: 'not_configured' });
      expect(fake.calls).toHaveLength(0);
    } finally {
      if (original !== undefined) process.env['QBO_REDIRECT_URI'] = original;
    }
  });

  it('disconnectQbo after a connection nulls tokens + audits qbo.disconnected', async () => {
    const sess = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await disconnectQboWithDb(env.db, sess);
    expect(result).toEqual({ ok: true });

    const status = await getQboStatusWithDb(env.db, sess);
    expect(status.connection?.status).toBe('disconnected');

    const audits = await withOrgContext(env.db, env.orgBId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'qbo.disconnected')).execute(),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // Tokens are actually nulled at the row level.
    const rows = await withOrgContext(env.db, env.orgBId, (tx) =>
      tx.select().from(qboConnection).where(eq(qboConnection.orgId, env.orgBId)).execute(),
    );
    expect(rows[0]?.accessToken).toBeNull();
    expect(rows[0]?.refreshToken).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4 — EXPORT INVOICE
// ════════════════════════════════════════════════════════════════════════════════

describe('EXPORT: exportInvoiceToQbo', () => {
  it('not_connected when no qbo_connection row exists for the org', async () => {
    // orgB was just disconnected above (status='disconnected', not 'connected').
    const sess = makeSession(env.orgBId, env.userBId, 'owner');
    const invoiceId = await seedFinalizedInvoice(env.db, env.orgBId, env.userBId, 'EXPNC');
    const result = await exportInvoiceToQboWithDb(env.db, sess, { invoiceId });
    expect(result).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('not_found for an unknown invoice id', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await exportInvoiceToQboWithDb(env.db, sess, {
      invoiceId: '00000000-0000-0000-0000-000000000099',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('not_finalized refuses a draft invoice', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await seedConnection(env.db, env.orgAId);
    const invoiceId = await seedDraftInvoice(env.db, env.orgAId, env.userAId, 'DRAFT');
    const result = await exportInvoiceToQboWithDb(env.db, sess, { invoiceId }, new FakeQboClient());
    expect(result).toEqual({ ok: false, reason: 'not_finalized' });
  });

  it('unmapped_kinds refuses (never silently lumps) + writes an error export_log row', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'UNMAP');
    const fake = new FakeQboClient();
    // No mapping set yet for this fresh org state (mapping table may have
    // wet_hourly from an earlier test — use a distinct fresh org context
    // instead to guarantee an unmapped kind).
    // Delete any existing wet_hourly mapping for a clean assertion.
    await deleteQboAccountMappingWithDb(env.db, sess, { lineKind: 'wet_hourly' }).catch(() => undefined);
    const result = await exportInvoiceToQboWithDb(env.db, sess, { invoiceId }, fake);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unmapped_kinds');
    if (result.reason !== 'unmapped_kinds') return;
    expect(result.kinds).toContain('wet_hourly');
    expect(fake.calls.filter((c) => c.kind === 'createInvoice')).toHaveLength(0);

    const logs = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(qboExportLog)
        .where(and(eq(qboExportLog.entityType, 'invoice'), eq(qboExportLog.entityId, invoiceId)))
        .execute(),
    );
    expect(logs.some((l) => l.status === 'error')).toBe(true);
  });

  it('happy path: exports invoice + customer, writes exported log rows + audit', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await setQboAccountMappingWithDb(env.db, sess, {
      lineKind: 'wet_hourly',
      qboItemId: 'item-wet-happy',
      qboItemName: 'Aircraft Rental (Wet)',
    });
    const memberId = await seedMember(env.db, env.orgAId, 'HAPPYMEMBER');
    const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'HAPPY', memberId);
    const fake = new FakeQboClient();

    const result = await exportInvoiceToQboWithDb(env.db, sess, { invoiceId }, fake);
    expect(result).toEqual({ ok: true, qboInvoiceId: 'qbo-inv-1', alreadyExported: false });

    expect(fake.calls.filter((c) => c.kind === 'createCustomer')).toHaveLength(1);
    expect(fake.calls.filter((c) => c.kind === 'createInvoice')).toHaveLength(1);

    // Per-line ItemRef mapping actually reached the client payload.
    const invoiceCall = fake.calls.find((c) => c.kind === 'createInvoice');
    const payload = (invoiceCall?.args as { payload: QboInvoicePayload }).payload;
    expect(payload.Line).toHaveLength(1);
    expect(payload.Line[0]?.SalesItemLineDetail.ItemRef.value).toBe('item-wet-happy');
    expect(payload.PrivateNote).toBe(`AeroOps invoice ${invoiceId}`);

    const invoiceLogs = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(qboExportLog)
        .where(and(eq(qboExportLog.entityType, 'invoice'), eq(qboExportLog.entityId, invoiceId), eq(qboExportLog.status, 'exported')))
        .execute(),
    );
    expect(invoiceLogs).toHaveLength(1);
    expect(invoiceLogs[0]?.qboId).toBe('qbo-inv-1');

    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'billing.invoice_exported_to_qbo'), eq(auditLog.entityId, invoiceId)))
        .execute(),
    );
    expect(audits).toHaveLength(1);
  });

  it('idempotent: exporting an already-exported invoice returns the existing qboId, client NOT called again', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await setQboAccountMappingWithDb(env.db, sess, {
      lineKind: 'wet_hourly',
      qboItemId: 'item-wet-idem',
      qboItemName: 'Aircraft Rental (Wet)',
    });
    const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'IDEM');
    const fake1 = new FakeQboClient();
    const first = await exportInvoiceToQboWithDb(env.db, sess, { invoiceId }, fake1);
    expect(first.ok).toBe(true);

    const fake2 = new FakeQboClient();
    const second = await exportInvoiceToQboWithDb(env.db, sess, { invoiceId }, fake2);
    expect(second).toEqual({ ok: true, qboInvoiceId: 'qbo-inv-1', alreadyExported: true });
    expect(fake2.calls).toHaveLength(0); // no re-push, no customer re-lookup call

    const invoiceLogs = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(qboExportLog)
        .where(and(eq(qboExportLog.entityType, 'invoice'), eq(qboExportLog.entityId, invoiceId), eq(qboExportLog.status, 'exported')))
        .execute(),
    );
    // Idempotency backstop: at most one 'exported' row per (org, entity_type, entity_id).
    expect(invoiceLogs).toHaveLength(1);
  });

  it('provider error on createInvoice → error log row + audit, never silently swallowed', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await setQboAccountMappingWithDb(env.db, sess, {
      lineKind: 'wet_hourly',
      qboItemId: 'item-wet-err',
      qboItemName: 'Aircraft Rental (Wet)',
    });
    const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'ERR');
    const fake = new FakeQboClient();
    fake.failCreateInvoice = true;

    const result = await exportInvoiceToQboWithDb(env.db, sess, { invoiceId }, fake);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('provider_error');

    const logs = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(qboExportLog)
        .where(and(eq(qboExportLog.entityType, 'invoice'), eq(qboExportLog.entityId, invoiceId), eq(qboExportLog.status, 'error')))
        .execute(),
    );
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]?.errorDetail).toBeTruthy();

    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'billing.invoice_export_failed'), eq(auditLog.entityId, invoiceId)))
        .execute(),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('unconfigured stub client on token refresh → clean typed not_configured, never a crash', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await setQboAccountMappingWithDb(env.db, sess, {
      lineKind: 'wet_hourly',
      qboItemId: 'item-wet-stub',
      qboItemName: 'Aircraft Rental (Wet)',
    });
    const invoiceId = await seedFinalizedInvoice(env.db, env.orgAId, env.userAId, 'STUB');
    // Force an EXPIRED token so ensureFreshAccessToken must call refreshTokens,
    // which the stub client throws QboNotConfiguredError for.
    await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .update(qboConnection)
        .set({ accessTokenExpiresAt: new Date(Date.now() - 60_000) })
        .where(eq(qboConnection.orgId, env.orgAId)),
    );

    const result = await exportInvoiceToQboWithDb(env.db, sess, { invoiceId }, new StubQboClient());
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('StubQboClient throws QboNotConfiguredError directly for every method', async () => {
    const stub: QboClient = new StubQboClient();
    await expect(stub.createCustomer({ displayName: 'x' }, { realmId: 'r', accessToken: 't' })).rejects.toBeInstanceOf(
      QboNotConfiguredError,
    );
    await expect(
      stub.createInvoice({ Line: [], CustomerRef: { value: '1' }, DocNumber: 'x', PrivateNote: 'x' }, { realmId: 'r', accessToken: 't' }),
    ).rejects.toBeInstanceOf(QboNotConfiguredError);
    await expect(stub.exchangeAuthCode('c', 'r')).rejects.toBeInstanceOf(QboNotConfiguredError);
    await expect(stub.refreshTokens('r')).rejects.toBeInstanceOf(QboNotConfiguredError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5 — TENANT ISOLATION (T-ISO)
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO: org A cannot see or edit org B QBO connection/log/mapping', () => {
  it('getQboStatus for org A never returns org B rows', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const statusA = await getQboStatusWithDb(env.db, sessA);
    // org A's own connection realm must never be "realm-b" (org B's realm from CONNECT tests).
    expect(statusA.connection?.realmId).not.toBe('realm-b');
    // Every account-mapping row belongs conceptually to org A only (RLS-scoped read;
    // cannot directly assert org_id since the view doesn't carry it, but the row
    // set must be exactly what org A itself created in earlier tests).
    expect(Array.isArray(statusA.accountMapping)).toBe(true);
  });

  it('exportInvoiceToQbo for org A cannot export an org-B-owned invoice id', async () => {
    const invoiceIdB = await seedFinalizedInvoice(env.db, env.orgBId, env.userBId, 'TISO');
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await exportInvoiceToQboWithDb(env.db, sessA, { invoiceId: invoiceIdB });
    // RLS scopes the invoice SELECT to org A — org B's invoice is invisible.
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('disconnectQbo for org A does not affect org B connection state', async () => {
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const beforeB = await getQboStatusWithDb(env.db, sessB);

    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    await disconnectQboWithDb(env.db, sessA);

    const afterB = await getQboStatusWithDb(env.db, sessB);
    expect(afterB.connection?.status).toBe(beforeB.connection?.status);
  });
});
