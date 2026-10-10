/**
 * billing-records-schema.test.ts — Schema tests for 0019_billing_records.sql
 *                                  (Slice B1 / Phase-2 billing foundation)
 *
 * Proves that (spec Slice B1 acceptance criteria):
 *
 *   BR1.  All three tables exist after migration 0019.
 *
 *   BR2.  FORCE RLS fail-closed (GUC unset → 0 rows) for all three tables:
 *         BR2a. rate_schedule: GUC unset → 0 rows.
 *         BR2b. invoice: GUC unset → 0 rows.
 *         BR2c. invoice_line_item: GUC unset → 0 rows.
 *
 *   BR3.  RLS isolation — org A cannot see org B rows:
 *         BR3a. rate_schedule: org A context → 0 rows from org B.
 *         BR3b. invoice: org A context → 0 rows from org B.
 *         BR3c. invoice_line_item: org A context → 0 rows from org B.
 *
 *   BR4.  Composite FK cross-org rejection:
 *         BR4a. rate_schedule: resource_id from org B (with org_id of org A) → rejected.
 *         BR4b. rate_schedule: created_by from org B (with org_id of org A) → rejected.
 *         BR4c. invoice: member_user_id from org B (with org_id of org A) → rejected.
 *         BR4d. invoice: dispatch_ticket_id from org B (with org_id of org A) → rejected.
 *         BR4e. invoice: created_by from org B (with org_id of org A) → rejected.
 *         BR4f. invoice_line_item: invoice_id from org B (with org_id of org A) → rejected.
 *         BR4g. invoice_line_item: rate_schedule_id from org B (with org_id of org A) → rejected.
 *
 *   BR5.  RESTRICT FK integrity:
 *         BR5a. Hard-deleting a resource with rate_schedule rows → blocked (RESTRICT).
 *         BR5b. Hard-deleting a user (member_user_id) with invoice rows → blocked (RESTRICT).
 *         BR5c. Hard-deleting a dispatch_ticket with invoice rows → blocked (RESTRICT).
 *         BR5d. Hard-deleting an invoice with invoice_line_item rows → blocked (RESTRICT).
 *         BR5e. Hard-deleting a rate_schedule with invoice_line_item rows → blocked (RESTRICT).
 *
 *   BR6.  CHECKs fire:
 *         BR6a. rate_schedule_name_nonempty_check: empty name → rejected.
 *         BR6b. rate_schedule_name_nonempty_check: whitespace-only name → rejected.
 *         BR6c. rate_schedule_rate_kind_check: invalid rate_kind → rejected.
 *         BR6d. rate_schedule_amount_nonneg_check: negative amount_cents → rejected.
 *         BR6e. rate_schedule_effective_range_check: effective_to <= effective_from → rejected.
 *         BR6f. invoice_status_check: invalid status → rejected.
 *         BR6g. invoice_subtotal_nonneg_check: negative subtotal_cents → rejected.
 *         BR6h. invoice_total_nonneg_check: negative total_cents → rejected.
 *         BR6i. invoice_finalized_shape_check: status='finalized' without issued_at → rejected.
 *         BR6j. invoice_line_item_description_nonempty_check: empty description → rejected.
 *         BR6k. invoice_line_item_quantity_nonneg_check: negative quantity_hours → rejected.
 *         BR6l. invoice_line_item_unit_amount_nonneg_check: negative unit_amount_cents → rejected.
 *         BR6m. invoice_line_item_line_total_nonneg_check: negative line_total_cents → rejected.
 *
 *   BR7.  UNIQUE(id, org_id) composite candidate key indexes exist for all three tables.
 *
 *   BR8.  Happy-path round-trips:
 *         BR8a. rate_schedule: wet_hourly rate for a specific aircraft → inserts and reads back.
 *         BR8b. rate_schedule: org-wide default rate (resource_id NULL) → accepted.
 *         BR8c. rate_schedule: open-ended rate (effective_to NULL) → accepted.
 *         BR8d. invoice: draft invoice linked to a dispatch ticket → inserts and reads back.
 *         BR8e. invoice: finalized invoice (issued_at set) → accepted.
 *         BR8f. invoice_line_item: line item with rate_schedule_id → inserts and reads back.
 *         BR8g. invoice_line_item: manual line item (rate_schedule_id NULL) → accepted.
 *         BR8h. Full billing round-trip: rate_schedule → invoice → line item → verify amounts.
 *
 *   BR9.  Down migration reverses 0019: all three tables + policies + indexes gone.
 *
 * FK chain seeded:
 *   org → app_user → resource → reservation → dispatch_ticket
 *                                            → rate_schedule
 *                            → invoice → invoice_line_item
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies migrations 0000–0019
 * in order so constraint SQL validated here is the exact production artifact.
 * NEVER applied to a real DB.
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
  withPlatformAdminContext,
} from '../index.js';
import {
  org,
  appUser,
  resource,
  reservation,
  rateSchedule,
  invoice,
  invoiceLineItem,
} from '../schema/index.js';
import type { PgliteTestClient } from '../client.js';

// ── Path resolution ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_SQL = [
  readFileSync(resolve(__dirname, '../../migrations/0000_loud_prodigy.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0001_auth_credential.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0002_scheduling.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0003_booking_policies.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0004_recurrence.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0005_dispatch.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0006_squawks_grounding.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0007_fleet.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0008_people.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0009_dispatch_gate.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0010_civil_twilight.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0011_optimizer_run.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0012_training.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0013_work_orders.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0014_availability.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0015_booking_request.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0016_booking_request_convert.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0017_booking_retention.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0018_dispatch_ticket_correction.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0019_billing_records.sql'), 'utf-8'),
  // 0037 required: resource now includes category/aircraft_class (Slice P2-LOG2).
  // Drizzle ORM INSERT on resource emits all columns, so the columns must exist.
  readFileSync(resolve(__dirname, '../../migrations/0037_logbook_annotation.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0041_member_tag_color.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0042_cancellation_reason.sql'), 'utf-8'),
];

const DOWN_0019 = readFileSync(
  resolve(__dirname, '../../migrations/0019_billing_records.down.sql'),
  'utf-8',
);

// ── Test environment ──────────────────────────────────────────────────────────

interface BillingTestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;       // member of org A — primary actor
  userBId: string;       // member of org B — cross-org rejection tests
  aircraftAId: string;   // resource (kind='aircraft') in org A
  aircraftBId: string;   // resource (kind='aircraft') in org B
  reservationAId: string;  // booked reservation in org A
  reservationBId: string;  // booked reservation in org B
  closedTicketAId: string; // closed dispatch_ticket in org A
  closedTicketBId: string; // closed dispatch_ticket in org B
}

/**
 * Insert a closed dispatch_ticket row via raw SQL.
 * Caller must set GUC and role before calling.
 */
async function insertClosedTicket(
  pglite: PGlite,
  orgId: string,
  reservationId: string,
  resourceId: string,
  pilotUserId: string,
  openedBy: string,
  closedBy: string,
): Promise<string> {
  const result = await pglite.query<{ id: string }>(
    `INSERT INTO dispatch_ticket (
       org_id, reservation_id, resource_id, pilot_user_id,
       status, hobbs_out, tach_out, hobbs_in, tach_in, flight_time_hours,
       opened_by, closed_by, closed_at
     ) VALUES (
       $1, $2, $3, $4,
       'closed', 100.0, 95.5, 101.1, 96.6, 1.1,
       $5, $6, now()
     ) RETURNING id`,
    [orgId, reservationId, resourceId, pilotUserId, openedBy, closedBy],
  );
  return result.rows[0]!.id;
}

/**
 * Insert a rate_schedule row via raw SQL.
 * Caller must set GUC and role before calling.
 */
async function insertRateSchedule(
  pglite: PGlite,
  orgId: string,
  createdBy: string,
  opts: {
    resourceId?: string | null;
    name?: string;
    rateKind?: string;
    amountCents?: number;
    effectiveFrom?: string;
    effectiveTo?: string | null;
  } = {},
): Promise<string> {
  const name = opts.name ?? 'Standard Wet Hourly';
  const rateKind = opts.rateKind ?? 'wet_hourly';
  const amountCents = opts.amountCents !== undefined ? opts.amountCents : 15000;
  const effectiveFrom = opts.effectiveFrom ?? '2026-01-01T00:00:00Z';
  const effectiveTo = opts.effectiveTo !== undefined ? opts.effectiveTo : null;
  const resourceId = opts.resourceId !== undefined ? opts.resourceId : null;

  const result = await pglite.query<{ id: string }>(
    `INSERT INTO rate_schedule
       (org_id, resource_id, name, rate_kind, amount_cents, effective_from, effective_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [orgId, resourceId, name, rateKind, amountCents, effectiveFrom, effectiveTo, createdBy],
  );
  return result.rows[0]!.id;
}

/**
 * Insert a draft invoice row via raw SQL.
 * Caller must set GUC and role before calling.
 */
async function insertInvoice(
  pglite: PGlite,
  orgId: string,
  memberUserId: string,
  createdBy: string,
  opts: {
    status?: string;
    subtotalCents?: number;
    totalCents?: number;
    dispatchTicketId?: string | null;
    issuedAt?: string | null;
  } = {},
): Promise<string> {
  const status = opts.status ?? 'draft';
  const subtotalCents = opts.subtotalCents !== undefined ? opts.subtotalCents : 0;
  const totalCents = opts.totalCents !== undefined ? opts.totalCents : 0;
  const dispatchTicketId = opts.dispatchTicketId !== undefined ? opts.dispatchTicketId : null;
  const issuedAt = opts.issuedAt !== undefined ? opts.issuedAt : null;

  const result = await pglite.query<{ id: string }>(
    `INSERT INTO invoice
       (org_id, member_user_id, status, subtotal_cents, total_cents,
        dispatch_ticket_id, issued_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [orgId, memberUserId, status, subtotalCents, totalCents, dispatchTicketId, issuedAt, createdBy],
  );
  return result.rows[0]!.id;
}

/**
 * Insert an invoice_line_item row via raw SQL.
 * Caller must set GUC and role before calling.
 */
async function insertLineItem(
  pglite: PGlite,
  orgId: string,
  invoiceId: string,
  opts: {
    description?: string;
    quantityHours?: number;
    unitAmountCents?: number;
    lineTotalCents?: number;
    rateScheduleId?: string | null;
  } = {},
): Promise<string> {
  const description = opts.description ?? 'Aircraft rental - Cessna 172';
  const quantityHours = opts.quantityHours !== undefined ? opts.quantityHours : 1.5;
  const unitAmountCents = opts.unitAmountCents !== undefined ? opts.unitAmountCents : 15000;
  const lineTotalCents = opts.lineTotalCents !== undefined ? opts.lineTotalCents : 22500;
  const rateScheduleId = opts.rateScheduleId !== undefined ? opts.rateScheduleId : null;

  const result = await pglite.query<{ id: string }>(
    `INSERT INTO invoice_line_item
       (org_id, invoice_id, description, quantity_hours, unit_amount_cents,
        line_total_cents, rate_schedule_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [orgId, invoiceId, description, quantityHours, unitAmountCents, lineTotalCents, rateScheduleId],
  );
  return result.rows[0]!.id;
}

async function setupBillingEnv(): Promise<BillingTestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  // Seed orgs (platform admin / superuser context).
  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha Flight School', slug: 'alpha-billing' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta FBO', slug: 'beta-billing' })
      .returning();
    return [a[0]!, b[0]!];
  });

  // Org A: user + aircraft + reservation.
  const [userA, aircraftA, reservationA] = await withOrgContext(db, orgA.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'alice@alpha-billing.example', fullName: 'Alice Billing' })
      .returning();
    const r = await tx
      .insert(resource)
      .values({
        orgId: orgA.id,
        kind: 'aircraft',
        displayName: 'Cessna 172 N11111',
        tailNumber: 'N11111',
      })
      .returning();
    const res = await tx
      .insert(reservation)
      .values({
        orgId: orgA.id,
        startAt: new Date('2026-08-01T10:00:00Z'),
        endAt: new Date('2026-08-01T12:00:00Z'),
        status: 'booked',
        createdBy: u[0]!.id,
      })
      .returning();
    return [u[0]!, r[0]!, res[0]!];
  });

  // Org B: user + aircraft + reservation.
  const [userB, aircraftB, reservationB] = await withOrgContext(db, orgB.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgB.id, email: 'bob@beta-billing.example', fullName: 'Bob Billing' })
      .returning();
    const r = await tx
      .insert(resource)
      .values({
        orgId: orgB.id,
        kind: 'aircraft',
        displayName: 'Piper PA-28 N22222',
        tailNumber: 'N22222',
      })
      .returning();
    const res = await tx
      .insert(reservation)
      .values({
        orgId: orgB.id,
        startAt: new Date('2026-08-01T10:00:00Z'),
        endAt: new Date('2026-08-01T12:00:00Z'),
        status: 'booked',
        createdBy: u[0]!.id,
      })
      .returning();
    return [u[0]!, r[0]!, res[0]!];
  });

  // Seed closed dispatch tickets for both orgs (superuser, GUC set).
  await pglite.exec(`SET ROLE postgres`);
  await pglite.exec(`BEGIN`);
  await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgA.id}'`);
  const closedTicketAId = await insertClosedTicket(
    pglite, orgA.id, reservationA.id, aircraftA.id, userA.id, userA.id, userA.id,
  );
  await pglite.exec(`COMMIT`);

  await pglite.exec(`BEGIN`);
  await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgB.id}'`);
  const closedTicketBId = await insertClosedTicket(
    pglite, orgB.id, reservationB.id, aircraftB.id, userB.id, userB.id, userB.id,
  );
  await pglite.exec(`COMMIT`);

  // Drop to aeroops_app for RLS enforcement on all subsequent queries.
  await setTestAppRole({ pglite });

  return {
    db,
    pglite,
    orgAId: orgA.id,
    orgBId: orgB.id,
    userAId: userA.id,
    userBId: userB.id,
    aircraftAId: aircraftA.id,
    aircraftBId: aircraftB.id,
    reservationAId: reservationA.id,
    reservationBId: reservationB.id,
    closedTicketAId,
    closedTicketBId,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('billing-records-schema: migration 0019 + constraints + RLS', () => {
  let env: BillingTestEnv;

  beforeAll(async () => {
    env = await setupBillingEnv();
  });

  // ── BR1: Tables exist after migration 0019 ────────────────────────────────────

  it('BR1a: rate_schedule table exists after migration 0019', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'rate_schedule'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  it('BR1b: invoice table exists after migration 0019', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'invoice'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  it('BR1c: invoice_line_item table exists after migration 0019', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'invoice_line_item'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  // ── BR2: FORCE RLS fail-closed (GUC unset → 0 rows) ─────────────────────────

  it('BR2a: FORCE RLS fail-closed — GUC unset → 0 rows from rate_schedule', async () => {
    const { pglite, orgAId, userAId } = env;

    // Seed one row (superuser, GUC set).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertRateSchedule(pglite, orgAId, userAId, { name: 'BR2a seed' });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Clear GUC → fail-closed: 0 rows.
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const r = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM rate_schedule`,
    );
    expect(r.rows[0]!.count).toBe('0');
  });

  it('BR2b: FORCE RLS fail-closed — GUC unset → 0 rows from invoice', async () => {
    const { pglite, orgAId, userAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertInvoice(pglite, orgAId, userAId, userAId, {});
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const r = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM invoice`,
    );
    expect(r.rows[0]!.count).toBe('0');
  });

  it('BR2c: FORCE RLS fail-closed — GUC unset → 0 rows from invoice_line_item', async () => {
    const { pglite, orgAId, userAId } = env;

    // Need an invoice to attach a line item to.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const invId = await insertInvoice(pglite, orgAId, userAId, userAId, {});
    await insertLineItem(pglite, orgAId, invId, {});
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const r = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM invoice_line_item`,
    );
    expect(r.rows[0]!.count).toBe('0');
  });

  // ── BR3: RLS isolation (cross-org SELECT → 0) ────────────────────────────────

  it('BR3a: RLS isolation — org A cannot see org B rate_schedule rows', async () => {
    const { pglite, db, orgAId, orgBId, userBId } = env;

    // Seed one rate in org B (superuser).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertRateSchedule(pglite, orgBId, userBId, { name: 'BR3a org B rate' });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Org A context → only org A rates visible.
    const rowsA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(rateSchedule).execute(),
    );
    expect(rowsA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context → only org B rates visible.
    const rowsB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(rateSchedule).execute(),
    );
    expect(rowsB.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  it('BR3b: RLS isolation — org A cannot see org B invoice rows', async () => {
    const { pglite, db, orgAId, orgBId, userBId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertInvoice(pglite, orgBId, userBId, userBId, {});
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    const rowsA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(invoice).execute(),
    );
    expect(rowsA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsA.some((r) => r.orgId === orgBId)).toBe(false);

    const rowsB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(invoice).execute(),
    );
    expect(rowsB.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  it('BR3c: RLS isolation — org A cannot see org B invoice_line_item rows', async () => {
    const { pglite, db, orgAId, orgBId, userBId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    const invBId = await insertInvoice(pglite, orgBId, userBId, userBId, {});
    await insertLineItem(pglite, orgBId, invBId, { description: 'BR3c org B line item' });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    const rowsA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(invoiceLineItem).execute(),
    );
    expect(rowsA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsA.some((r) => r.orgId === orgBId)).toBe(false);

    const rowsB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(invoiceLineItem).execute(),
    );
    expect(rowsB.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  // ── BR4: Composite FK cross-org rejection ────────────────────────────────────

  it('BR4a: rate_schedule: resource_id from org B with org_id of org A → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftBId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRateSchedule(pglite, orgAId, userAId, {
        resourceId: aircraftBId,
        name: 'BR4a cross-org resource',
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR4b: rate_schedule: created_by from org B with org_id of org A → rejected', async () => {
    const { pglite, orgAId, userBId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRateSchedule(pglite, orgAId, userBId, { name: 'BR4b cross-org creator' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR4c: invoice: member_user_id from org B with org_id of org A → rejected', async () => {
    const { pglite, orgAId, userAId, userBId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertInvoice(pglite, orgAId, userBId, userAId, {}),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR4d: invoice: dispatch_ticket_id from org B with org_id of org A → rejected', async () => {
    const { pglite, orgAId, userAId, closedTicketBId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertInvoice(pglite, orgAId, userAId, userAId, {
        dispatchTicketId: closedTicketBId,
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR4e: invoice: created_by from org B with org_id of org A → rejected', async () => {
    const { pglite, orgAId, userAId, userBId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertInvoice(pglite, orgAId, userAId, userBId, {}),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR4f: invoice_line_item: invoice_id from org B with org_id of org A → rejected', async () => {
    const { pglite, orgAId, orgBId, userBId } = env;

    // Create a real invoice in org B first.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    const invBId = await insertInvoice(pglite, orgBId, userBId, userBId, {});
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Try to insert line item in org A referencing org B's invoice.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertLineItem(pglite, orgAId, invBId, { description: 'BR4f cross-org invoice' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR4g: invoice_line_item: rate_schedule_id from org B with org_id of org A → rejected', async () => {
    const { pglite, orgAId, orgBId, userAId, userBId } = env;

    // Create a rate in org B and an invoice in org A.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    const rateBId = await insertRateSchedule(pglite, orgBId, userBId, { name: 'BR4g org B rate' });
    await pglite.exec(`COMMIT`);

    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const invAId = await insertInvoice(pglite, orgAId, userAId, userAId, {});
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Try to insert line item in org A referencing org B's rate.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertLineItem(pglite, orgAId, invAId, {
        description: 'BR4g cross-org rate',
        rateScheduleId: rateBId,
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── BR5: RESTRICT FK integrity ────────────────────────────────────────────────

  it('BR5a: hard-deleting a resource with rate_schedule rows → blocked (RESTRICT)', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;

    // Seed a rate schedule tied to the aircraft.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertRateSchedule(pglite, orgAId, userAId, {
      resourceId: aircraftAId,
      name: 'BR5a aircraft rate',
    });
    await pglite.exec(`COMMIT`);

    // Attempt to hard-delete the aircraft → RESTRICT must block it.
    await expect(
      pglite.query(`DELETE FROM resource WHERE id = $1`, [aircraftAId]),
    ).rejects.toThrow();
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('BR5b: hard-deleting a user (member_user_id) with invoice rows → blocked (RESTRICT)', async () => {
    const { pglite, orgAId } = env;

    // Create a throwaway user and an invoice for them.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const uRow = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name)
       VALUES ($1, 'restrict-member@alpha-billing.example', 'RESTRICT Member')
       RETURNING id`,
      [orgAId],
    );
    const throwUserId = uRow.rows[0]!.id;
    await insertInvoice(pglite, orgAId, throwUserId, throwUserId, {});
    await pglite.exec(`COMMIT`);

    // Attempt to delete the user → RESTRICT must block it.
    await expect(
      pglite.query(`DELETE FROM app_user WHERE id = $1`, [throwUserId]),
    ).rejects.toThrow();
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('BR5c: hard-deleting a dispatch_ticket with invoice rows → blocked (RESTRICT)', async () => {
    const { pglite, orgAId, userAId, closedTicketAId } = env;

    // Seed an invoice linked to the closed ticket.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertInvoice(pglite, orgAId, userAId, userAId, {
      dispatchTicketId: closedTicketAId,
    });
    await pglite.exec(`COMMIT`);

    // Attempt to hard-delete the dispatch ticket → RESTRICT must block it.
    await expect(
      pglite.query(`DELETE FROM dispatch_ticket WHERE id = $1`, [closedTicketAId]),
    ).rejects.toThrow();
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('BR5d: hard-deleting an invoice with invoice_line_item rows → blocked (RESTRICT)', async () => {
    const { pglite, orgAId, userAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const invId = await insertInvoice(pglite, orgAId, userAId, userAId, {});
    await insertLineItem(pglite, orgAId, invId, { description: 'BR5d test line' });
    await pglite.exec(`COMMIT`);

    // Attempt to delete the invoice → RESTRICT must block it.
    await expect(
      pglite.query(`DELETE FROM invoice WHERE id = $1`, [invId]),
    ).rejects.toThrow();
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('BR5e: hard-deleting a rate_schedule with invoice_line_item rows → blocked (RESTRICT)', async () => {
    const { pglite, orgAId, userAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const rateId = await insertRateSchedule(pglite, orgAId, userAId, { name: 'BR5e rate' });
    const invId = await insertInvoice(pglite, orgAId, userAId, userAId, {});
    await insertLineItem(pglite, orgAId, invId, {
      description: 'BR5e line with rate',
      rateScheduleId: rateId,
    });
    await pglite.exec(`COMMIT`);

    // Attempt to delete the rate schedule → RESTRICT must block it.
    await expect(
      pglite.query(`DELETE FROM rate_schedule WHERE id = $1`, [rateId]),
    ).rejects.toThrow();
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── BR6: CHECKs fire ─────────────────────────────────────────────────────────

  it('BR6a: rate_schedule_name_nonempty_check: empty name → rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRateSchedule(pglite, orgAId, userAId, { name: '' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR6b: rate_schedule_name_nonempty_check: whitespace-only name → rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRateSchedule(pglite, orgAId, userAId, { name: '   ' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR6c: rate_schedule_rate_kind_check: invalid rate_kind → rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRateSchedule(pglite, orgAId, userAId, { rateKind: 'invalid_kind' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR6d: rate_schedule_amount_nonneg_check: negative amount_cents → rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRateSchedule(pglite, orgAId, userAId, { amountCents: -1 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR6e: rate_schedule_effective_range_check: effective_to <= effective_from → rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRateSchedule(pglite, orgAId, userAId, {
        effectiveFrom: '2026-06-01T00:00:00Z',
        effectiveTo: '2026-01-01T00:00:00Z',  // before effectiveFrom
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR6f: invoice_status_check: invalid status → rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertInvoice(pglite, orgAId, userAId, userAId, { status: 'invalid_status' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR6g: invoice_subtotal_nonneg_check: negative subtotal_cents → rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertInvoice(pglite, orgAId, userAId, userAId, { subtotalCents: -100 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR6h: invoice_total_nonneg_check: negative total_cents → rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertInvoice(pglite, orgAId, userAId, userAId, { totalCents: -100 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR6i: invoice_finalized_shape_check: status=finalized without issued_at → rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      // issued_at omitted (defaults to null) but status='finalized' → must fail
      insertInvoice(pglite, orgAId, userAId, userAId, {
        status: 'finalized',
        issuedAt: null,
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR6j: invoice_line_item_description_nonempty_check: empty description → rejected', async () => {
    const { pglite, orgAId, userAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const invId = await insertInvoice(pglite, orgAId, userAId, userAId, {});
    await expect(
      insertLineItem(pglite, orgAId, invId, { description: '' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR6k: invoice_line_item_quantity_nonneg_check: negative quantity_hours → rejected', async () => {
    const { pglite, orgAId, userAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const invId = await insertInvoice(pglite, orgAId, userAId, userAId, {});
    await expect(
      insertLineItem(pglite, orgAId, invId, { quantityHours: -0.1 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR6l: invoice_line_item_unit_amount_nonneg_check: negative unit_amount_cents → rejected', async () => {
    const { pglite, orgAId, userAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const invId = await insertInvoice(pglite, orgAId, userAId, userAId, {});
    await expect(
      insertLineItem(pglite, orgAId, invId, { unitAmountCents: -1 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR6m: invoice_line_item_line_total_nonneg_check: negative line_total_cents → rejected', async () => {
    const { pglite, orgAId, userAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const invId = await insertInvoice(pglite, orgAId, userAId, userAId, {});
    await expect(
      insertLineItem(pglite, orgAId, invId, { lineTotalCents: -1 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── BR7: UNIQUE(id, org_id) composite candidate key indexes ──────────────────

  it('BR7a: UNIQUE(id, org_id) composite candidate key index exists on rate_schedule', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_indexes
         WHERE tablename = 'rate_schedule'
           AND indexname = 'rate_schedule_id_org_id_unique'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  it('BR7b: UNIQUE(id, org_id) composite candidate key index exists on invoice', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_indexes
         WHERE tablename = 'invoice'
           AND indexname = 'invoice_id_org_id_unique'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  it('BR7c: UNIQUE(id, org_id) composite candidate key index exists on invoice_line_item', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_indexes
         WHERE tablename = 'invoice_line_item'
           AND indexname = 'invoice_line_item_id_org_id_unique'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  // ── BR8: Happy-path round-trips ───────────────────────────────────────────────

  it('BR8a: rate_schedule: wet_hourly rate for a specific aircraft → inserts and reads back', async () => {
    const { pglite, db, orgAId, userAId, aircraftAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const rateId = await insertRateSchedule(pglite, orgAId, userAId, {
      resourceId: aircraftAId,
      name: 'Cessna 172 Wet Hourly 2026',
      rateKind: 'wet_hourly',
      amountCents: 16500,
      effectiveFrom: '2026-01-01T00:00:00Z',
      effectiveTo: '2026-12-31T23:59:59Z',
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(rateSchedule).execute(),
    );
    const theRate = rows.find((r) => r.id === rateId);
    expect(theRate).toBeDefined();
    expect(theRate!.orgId).toBe(orgAId);
    expect(theRate!.resourceId).toBe(aircraftAId);
    expect(theRate!.name).toBe('Cessna 172 Wet Hourly 2026');
    expect(theRate!.rateKind).toBe('wet_hourly');
    expect(theRate!.amountCents).toBe(16500);
    expect(theRate!.createdBy).toBe(userAId);
    expect(theRate!.createdAt).toBeInstanceOf(Date);
  });

  it('BR8b: rate_schedule: org-wide default rate (resource_id NULL) → accepted', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const rateId = await insertRateSchedule(pglite, orgAId, userAId, {
      resourceId: null,
      name: 'Default Dry Hourly',
      rateKind: 'dry_hourly',
      amountCents: 12000,
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    const r = await pglite.query<{ resource_id: string | null; rate_kind: string }>(
      `SELECT resource_id, rate_kind FROM rate_schedule WHERE id = $1`,
      [rateId],
    );
    expect(r.rows[0]!.resource_id).toBeNull();
    expect(r.rows[0]!.rate_kind).toBe('dry_hourly');
  });

  it('BR8c: rate_schedule: open-ended rate (effective_to NULL) → accepted', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const rateId = await insertRateSchedule(pglite, orgAId, userAId, {
      name: 'Open-ended Instruction Rate',
      rateKind: 'instruction',
      amountCents: 8000,
      effectiveFrom: '2026-01-01T00:00:00Z',
      effectiveTo: null,
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    const r = await pglite.query<{ effective_to: string | null }>(
      `SELECT effective_to FROM rate_schedule WHERE id = $1`,
      [rateId],
    );
    expect(r.rows[0]!.effective_to).toBeNull();
  });

  it('BR8d: invoice: draft invoice linked to a dispatch ticket → inserts and reads back', async () => {
    const { pglite, db, orgAId, userAId, closedTicketAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const invId = await insertInvoice(pglite, orgAId, userAId, userAId, {
      status: 'draft',
      subtotalCents: 24750,
      totalCents: 24750,
      dispatchTicketId: closedTicketAId,
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(invoice).execute(),
    );
    const theInv = rows.find((r) => r.id === invId);
    expect(theInv).toBeDefined();
    expect(theInv!.orgId).toBe(orgAId);
    expect(theInv!.memberUserId).toBe(userAId);
    expect(theInv!.status).toBe('draft');
    expect(theInv!.subtotalCents).toBe(24750);
    expect(theInv!.totalCents).toBe(24750);
    expect(theInv!.dispatchTicketId).toBe(closedTicketAId);
    expect(theInv!.issuedAt).toBeNull();
    expect(theInv!.createdAt).toBeInstanceOf(Date);
  });

  it('BR8e: invoice: finalized invoice (issued_at set) → accepted', async () => {
    const { pglite, orgAId, userAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const invId = await insertInvoice(pglite, orgAId, userAId, userAId, {
      status: 'finalized',
      subtotalCents: 15000,
      totalCents: 15000,
      issuedAt: '2026-08-15T10:00:00Z',
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    const r = await pglite.query<{ status: string; issued_at: string | null }>(
      `SELECT status, issued_at FROM invoice WHERE id = $1`,
      [invId],
    );
    expect(r.rows[0]!.status).toBe('finalized');
    expect(r.rows[0]!.issued_at).not.toBeNull();
  });

  it('BR8f: invoice_line_item: line item with rate_schedule_id → inserts and reads back', async () => {
    const { pglite, db, orgAId, userAId, aircraftAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const rateId = await insertRateSchedule(pglite, orgAId, userAId, {
      resourceId: aircraftAId,
      name: 'BR8f rate',
      rateKind: 'wet_hourly',
      amountCents: 15000,
    });
    const invId = await insertInvoice(pglite, orgAId, userAId, userAId, {
      subtotalCents: 22500,
      totalCents: 22500,
    });
    const lineId = await insertLineItem(pglite, orgAId, invId, {
      description: 'Aircraft rental 1.5 hrs',
      quantityHours: 1.5,
      unitAmountCents: 15000,
      lineTotalCents: 22500,
      rateScheduleId: rateId,
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(invoiceLineItem).execute(),
    );
    const theLine = rows.find((r) => r.id === lineId);
    expect(theLine).toBeDefined();
    expect(theLine!.orgId).toBe(orgAId);
    expect(theLine!.invoiceId).toBe(invId);
    expect(theLine!.description).toBe('Aircraft rental 1.5 hrs');
    expect(theLine!.quantityHours).toBe('1.5');
    expect(theLine!.unitAmountCents).toBe(15000);
    expect(theLine!.lineTotalCents).toBe(22500);
    expect(theLine!.rateScheduleId).toBe(rateId);
    expect(theLine!.createdAt).toBeInstanceOf(Date);
  });

  it('BR8g: invoice_line_item: manual line item (rate_schedule_id NULL) → accepted', async () => {
    const { pglite, orgAId, userAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const invId = await insertInvoice(pglite, orgAId, userAId, userAId, {});
    const lineId = await insertLineItem(pglite, orgAId, invId, {
      description: 'Manual fuel surcharge',
      quantityHours: 0.0,
      unitAmountCents: 3000,
      lineTotalCents: 3000,
      rateScheduleId: null,
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    const r = await pglite.query<{ rate_schedule_id: string | null; description: string }>(
      `SELECT rate_schedule_id, description FROM invoice_line_item WHERE id = $1`,
      [lineId],
    );
    expect(r.rows[0]!.rate_schedule_id).toBeNull();
    expect(r.rows[0]!.description).toBe('Manual fuel surcharge');
  });

  it('BR8h: full billing round-trip — rate_schedule → draft invoice → line item → verify amounts', async () => {
    const { pglite, db, orgAId, userAId, aircraftAId, closedTicketAId } = env;

    // Build a complete billing scenario.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);

    // Create a wet_hourly rate at $165.00/hr (16500 cents).
    const rateId = await insertRateSchedule(pglite, orgAId, userAId, {
      resourceId: aircraftAId,
      name: 'BR8h Cessna 172 Wet Hourly',
      rateKind: 'wet_hourly',
      amountCents: 16500,
    });

    // Create a draft invoice for the member linked to the dispatch ticket.
    // 1.1 hours flown (from the seeded dispatch_ticket) × 16500 cents = 18150 cents.
    const invId = await insertInvoice(pglite, orgAId, userAId, userAId, {
      status: 'draft',
      subtotalCents: 18150,
      totalCents: 18150,
      dispatchTicketId: closedTicketAId,
    });

    // Create the line item: 1.1 hrs × $165.00 = $181.50.
    const lineId = await insertLineItem(pglite, orgAId, invId, {
      description: 'Aircraft rental — N11111 — 1.1 hrs',
      quantityHours: 1.1,
      unitAmountCents: 16500,
      lineTotalCents: 18150,
      rateScheduleId: rateId,
    });

    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Read back the complete set and verify money integrity.
    const invoiceRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(invoice).execute(),
    );
    const theInv = invoiceRows.find((r) => r.id === invId);
    expect(theInv!.subtotalCents).toBe(18150);
    expect(theInv!.totalCents).toBe(18150);

    const lineRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(invoiceLineItem).execute(),
    );
    const theLine = lineRows.find((r) => r.id === lineId);
    expect(theLine!.quantityHours).toBe('1.1');
    expect(theLine!.unitAmountCents).toBe(16500);
    expect(theLine!.lineTotalCents).toBe(18150);
    expect(theLine!.rateScheduleId).toBe(rateId);

    // Verify: 1.1 × 16500 = 18150 (integer cents, no float rounding error).
    // This is a PROPERTY of integer-cents money: exact arithmetic.
    const computed = Math.round(1.1 * 16500);
    expect(theLine!.lineTotalCents).toBe(computed);
  });

  // ── BR9: Down migration reverses 0019 ────────────────────────────────────────

  it('BR9: down migration reverses 0019 — all three tables + policies + indexes gone', async () => {
    // Use a fresh isolated PGlite client to avoid polluting the shared env.
    const { pglite: pg2 } = await createTestClient();
    await applyMigrationSql({ pglite: pg2 }, MIGRATION_SQL);

    // Verify all three tables exist before down.
    for (const tableName of ['rate_schedule', 'invoice', 'invoice_line_item']) {
      const before = await pg2.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1
         ) AS exists`,
        [tableName],
      );
      expect(before.rows[0]!.exists).toBe(true);
    }

    // Verify SELECT policies exist before down.
    for (const policyName of ['rate_schedule_select', 'invoice_select', 'invoice_line_item_select']) {
      const beforePolicy = await pg2.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT FROM pg_policies
           WHERE policyname = $1
         ) AS exists`,
        [policyName],
      );
      expect(beforePolicy.rows[0]!.exists).toBe(true);
    }

    // Apply the down migration.
    await pg2.exec(DOWN_0019);

    // All three tables must be gone.
    for (const tableName of ['rate_schedule', 'invoice', 'invoice_line_item']) {
      const after = await pg2.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1
         ) AS exists`,
        [tableName],
      );
      expect(after.rows[0]!.exists).toBe(false);
    }

    // All policies must be gone (table drop cascades; also explicit DROP POLICY in down).
    for (const policyName of ['rate_schedule_select', 'invoice_select', 'invoice_line_item_select']) {
      const afterPolicy = await pg2.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT FROM pg_policies
           WHERE policyname = $1
         ) AS exists`,
        [policyName],
      );
      expect(afterPolicy.rows[0]!.exists).toBe(false);
    }

    // All indexes must be gone (dropped with their tables).
    for (const idxName of [
      'rate_schedule_org_resource_idx',
      'invoice_org_status_created_idx',
      'invoice_org_member_idx',
      'invoice_line_item_org_invoice_idx',
    ]) {
      const afterIdx = await pg2.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT FROM pg_indexes
           WHERE indexname = $1
         ) AS exists`,
        [idxName],
      );
      expect(afterIdx.rows[0]!.exists).toBe(false);
    }
  });
});
