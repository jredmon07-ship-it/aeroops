/**
 * aircraft-grounding-schema.test.ts — Smoke + constraint tests for the
 * aircraft_grounding table in 0006_squawks_grounding.sql (spec §1.7).
 *
 * Proves that:
 *   1. Migration 0006 applies cleanly on PGlite atop 0000–0005.
 *   2. aircraft_grounding table exists with grounding_state enum (2 values).
 *   3. aircraft_grounding_id_org_id_unique constraint exists.
 *   4. aircraft_grounding has NO updated_at column (append-only; immutable rows).
 *   5. RLS isolation: org A cannot see org B's aircraft_grounding rows.
 *   6. FORCE RLS fail-closed: GUC unset → 0 rows from aircraft_grounding.
 *   7. Cross-org FK rejection: resource_id from a different org → rejected.
 *   8. Cross-org FK rejection: created_by from a different org → rejected.
 *   9. Non-member creator rejection (user from a third org) → rejected.
 *  10. Cross-org FK rejection: squawk_id from a different org → rejected.
 *  11. Cross-org FK rejection: dispatch_ticket_id from a different org → rejected.
 *  12. aircraft_grounding_reason_check:
 *      (a) state='grounded' with empty reason → rejected.
 *      (b) state='grounded' with blank-only reason → rejected.
 *      (c) state='grounded' with non-empty reason → accepted.
 *      (d) state='released' with empty reason → accepted ([VERIFY-3b-C]).
 *  13. ON DELETE RESTRICT: deleting a resource with grounding rows is blocked.
 *  14. ON DELETE SET NULL: deleting a squawk nullifies aircraft_grounding.squawk_id.
 *  15. ON DELETE SET NULL: deleting a dispatch_ticket nullifies aircraft_grounding.dispatch_ticket_id.
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies all seven real
 * migration artifacts (0000–0006) in order so the constraint SQL validated
 * here is the exact production artifact. NEVER applied to a real DB.
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
  dispatchTicket,
  squawk,
  aircraftGrounding,
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
  readFileSync(resolve(__dirname, '../../migrations/0017_booking_retention.sql'),        'utf-8'),
];

// ── Test environment ──────────────────────────────────────────────────────────

interface GroundingTestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  orgCId: string; // third org for non-member rejection
  userAId: string;
  userBId: string;
  userCId: string; // user in third org
  aircraftAId: string;
  aircraftBId: string;
  reservationAId: string; // reservation in org A (needed for disposable ticket seeding)
  ticketAId: string;
  ticketBId: string;
  squawkAId: string; // squawk in org A
  squawkBId: string; // squawk in org B
}

async function setupGroundingEnv(): Promise<GroundingTestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const [orgA, orgB, orgC] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha School', slug: 'alpha-grounding' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta Club', slug: 'beta-grounding' })
      .returning();
    const c = await tx
      .insert(org)
      .values({ name: 'Gamma FBO', slug: 'gamma-grounding' })
      .returning();
    return [a[0]!, b[0]!, c[0]!];
  });

  const [userA, aircraftA, reservationA] = await withOrgContext(db, orgA.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'alice@alpha.example', fullName: 'Alice A' })
      .returning();
    const r = await tx
      .insert(resource)
      .values({
        orgId: orgA.id,
        kind: 'aircraft',
        displayName: 'Cessna 172 N12345',
        tailNumber: 'N12345',
      })
      .returning();
    const res = await tx
      .insert(reservation)
      .values({
        orgId: orgA.id,
        startAt: new Date('2026-07-01T10:00:00Z'),
        endAt: new Date('2026-07-01T12:00:00Z'),
        status: 'booked',
        createdBy: u[0]!.id,
      })
      .returning();
    return [u[0]!, r[0]!, res[0]!];
  });

  const [userB, aircraftB, reservationB] = await withOrgContext(db, orgB.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgB.id, email: 'bob@beta.example', fullName: 'Bob B' })
      .returning();
    const r = await tx
      .insert(resource)
      .values({
        orgId: orgB.id,
        kind: 'aircraft',
        displayName: 'Piper PA-28 N99999',
        tailNumber: 'N99999',
      })
      .returning();
    const res = await tx
      .insert(reservation)
      .values({
        orgId: orgB.id,
        startAt: new Date('2026-07-01T10:00:00Z'),
        endAt: new Date('2026-07-01T12:00:00Z'),
        status: 'booked',
        createdBy: u[0]!.id,
      })
      .returning();
    return [u[0]!, r[0]!, res[0]!];
  });

  const [userC] = await withOrgContext(db, orgC.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgC.id, email: 'carol@gamma.example', fullName: 'Carol C' })
      .returning();
    return [u[0]!];
  });

  // Seed dispatch tickets.
  const ticketAResult = await withOrgContext(db, orgA.id, async (tx) => {
    return tx
      .insert(dispatchTicket)
      .values({
        orgId: orgA.id,
        reservationId: reservationA.id,
        resourceId: aircraftA.id,
        pilotUserId: userA.id,
        status: 'open',
        hobbsOut: '100.0',
        tachOut: '95.5',
        openedBy: userA.id,
      })
      .returning();
  });

  const ticketBResult = await withOrgContext(db, orgB.id, async (tx) => {
    return tx
      .insert(dispatchTicket)
      .values({
        orgId: orgB.id,
        reservationId: reservationB.id,
        resourceId: aircraftB.id,
        pilotUserId: userB.id,
        status: 'open',
        hobbsOut: '200.0',
        tachOut: '190.0',
        openedBy: userB.id,
      })
      .returning();
  });

  // Seed squawks (needed for squawk_id FK tests).
  const squawkAResult = await withOrgContext(db, orgA.id, async (tx) => {
    return tx
      .insert(squawk)
      .values({
        orgId: orgA.id,
        resourceId: aircraftA.id,
        title: 'Oil leak',
        severity: 'high',
        status: 'open',
        reportedBy: userA.id,
      })
      .returning();
  });

  const squawkBResult = await withOrgContext(db, orgB.id, async (tx) => {
    return tx
      .insert(squawk)
      .values({
        orgId: orgB.id,
        resourceId: aircraftB.id,
        title: 'Brake fade',
        severity: 'medium',
        status: 'open',
        reportedBy: userB.id,
      })
      .returning();
  });

  // Drop to aeroops_app for RLS enforcement.
  await setTestAppRole({ pglite });

  return {
    db,
    pglite,
    orgAId: orgA.id,
    orgBId: orgB.id,
    orgCId: orgC.id,
    userAId: userA.id,
    userBId: userB.id,
    userCId: userC.id,
    aircraftAId: aircraftA.id,
    aircraftBId: aircraftB.id,
    reservationAId: reservationA.id,
    ticketAId: ticketAResult[0]!.id,
    ticketBId: ticketBResult[0]!.id,
    squawkAId: squawkAResult[0]!.id,
    squawkBId: squawkBResult[0]!.id,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Inserts a valid aircraft_grounding row.
 * Returns the event id. Caller sets GUC and manages transaction.
 */
async function insertGrounding(
  pglite: PGlite,
  orgId: string,
  resourceId: string,
  createdBy: string,
  opts: {
    state?: string;
    reason?: string;
    squawkId?: string | null;
    dispatchTicketId?: string | null;
  } = {},
): Promise<string> {
  const state = opts.state ?? 'grounded';
  const reason = opts.reason ?? 'Oil leak detected by mechanic';
  const squawkId = opts.squawkId ?? null;
  const dispatchTicketId = opts.dispatchTicketId ?? null;

  const result = await pglite.query<{ id: string }>(
    `INSERT INTO aircraft_grounding (
       org_id, resource_id, state, reason, squawk_id, dispatch_ticket_id, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [orgId, resourceId, state, reason, squawkId, dispatchTicketId, createdBy],
  );
  return result.rows[0]!.id;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('aircraft-grounding-schema: migration 0006 + constraints + RLS', () => {
  let env: GroundingTestEnv;

  beforeAll(async () => {
    env = await setupGroundingEnv();
  });

  // ── Migration baseline ─────────────────────────────────────────────────────

  it('0006 applied: aircraft_grounding table exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'aircraft_grounding'
       ) AS exists`,
    );
    expect(result.rows[0]!.exists).toBe(true);
  });

  it('0006 applied: grounding_state enum has 2 values (grounded, released)', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
       WHERE pg_type.typname = 'grounding_state'
       ORDER BY pg_enum.enumsortorder`,
    );
    expect(result.rows.map((r) => r.enumlabel)).toEqual(['grounded', 'released']);
  });

  it('0006 applied: aircraft_grounding_id_org_id_unique constraint exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'aircraft_grounding'::regclass
         AND contype = 'u'
         AND conname = 'aircraft_grounding_id_org_id_unique'`,
    );
    expect(result.rows.length).toBe(1);
  });

  it('0006 applied: aircraft_grounding has NO updated_at column (append-only)', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'aircraft_grounding'
         AND column_name = 'updated_at'`,
    );
    expect(result.rows.length).toBe(0);
  });

  it('0006 applied: aircraft_grounding_reason_check constraint exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'aircraft_grounding'::regclass
         AND contype = 'c'
         AND conname = 'aircraft_grounding_reason_check'`,
    );
    expect(result.rows.length).toBe(1);
  });

  it('0006 applied: aircraft_grounding_resource_org_fk is RESTRICT', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'aircraft_grounding'::regclass
         AND contype = 'f'
         AND conname = 'aircraft_grounding_resource_org_fk'`,
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.confdeltype).toBe('r'); // RESTRICT
  });

  it('0006 applied: aircraft_grounding_squawk_org_fk is SET NULL', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'aircraft_grounding'::regclass
         AND contype = 'f'
         AND conname = 'aircraft_grounding_squawk_org_fk'`,
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.confdeltype).toBe('n'); // SET NULL
  });

  it('0006 applied: aircraft_grounding_dispatch_ticket_org_fk is SET NULL', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'aircraft_grounding'::regclass
         AND contype = 'f'
         AND conname = 'aircraft_grounding_dispatch_ticket_org_fk'`,
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.confdeltype).toBe('n'); // SET NULL
  });

  it('0006 applied: aircraft_grounding_created_by_org_fk is RESTRICT', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'aircraft_grounding'::regclass
         AND contype = 'f'
         AND conname = 'aircraft_grounding_created_by_org_fk'`,
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.confdeltype).toBe('r'); // RESTRICT
  });

  // ── Baseline: valid grounding event inserts ───────────────────────────────

  it('baseline: valid grounded event inserts successfully', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const id = await insertGrounding(pglite, orgAId, aircraftAId, userAId);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await pglite.exec(`COMMIT`);
  });

  it('baseline: valid released event inserts successfully', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const id = await insertGrounding(pglite, orgAId, aircraftAId, userAId, {
      state: 'released',
      reason: 'Inspection complete',
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await pglite.exec(`COMMIT`);
  });

  it('baseline: valid grounding with squawk_id + dispatch_ticket_id inserts', async () => {
    const { pglite, orgAId, aircraftAId, userAId, squawkAId, ticketAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const id = await insertGrounding(pglite, orgAId, aircraftAId, userAId, {
      squawkId: squawkAId,
      dispatchTicketId: ticketAId,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await pglite.exec(`COMMIT`);
  });

  // ── RLS: fail-closed (GUC unset → 0 rows) ────────────────────────────────

  it('RLS: aircraft_grounding returns 0 rows when GUC is unset (FORCE RLS fail-closed)', async () => {
    const { pglite } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM aircraft_grounding`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  // ── RLS: isolation ────────────────────────────────────────────────────────

  it('RLS isolation: org A cannot see org B aircraft_grounding rows', async () => {
    const { pglite, db, orgAId, orgBId, aircraftBId, userBId } = env;

    // Seed an event for org B as superuser.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertGrounding(pglite, orgBId, aircraftBId, userBId);
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Org A context — must not see org B rows.
    const rowsUnderA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(aircraftGrounding).execute(),
    );
    expect(rowsUnderA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsUnderA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context — must see org B rows.
    const rowsUnderB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(aircraftGrounding).execute(),
    );
    expect(rowsUnderB.some((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsUnderB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  // ── Cross-org FK rejection — resource_id ─────────────────────────────────

  it('composite FK: cross-org resource_id is rejected', async () => {
    const { pglite, orgAId, aircraftBId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertGrounding(pglite, orgAId, aircraftBId, userAId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── Cross-org FK rejection — created_by ──────────────────────────────────

  it('composite FK: cross-org created_by is rejected', async () => {
    const { pglite, orgAId, aircraftAId, userBId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertGrounding(pglite, orgAId, aircraftAId, userBId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── Non-member creator rejection ──────────────────────────────────────────

  it('composite FK: non-member creator (user from a third org) is rejected', async () => {
    const { pglite, orgAId, aircraftAId, userCId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertGrounding(pglite, orgAId, aircraftAId, userCId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── Cross-org FK rejection — squawk_id ───────────────────────────────────

  it('composite FK: cross-org squawk_id is rejected', async () => {
    const { pglite, orgAId, aircraftAId, userAId, squawkBId } = env;
    // org A grounding event referencing org B's squawk — must fail.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertGrounding(pglite, orgAId, aircraftAId, userAId, { squawkId: squawkBId }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── Cross-org FK rejection — dispatch_ticket_id ──────────────────────────

  it('composite FK: cross-org dispatch_ticket_id is rejected', async () => {
    const { pglite, orgAId, aircraftAId, userAId, ticketBId } = env;
    // org A grounding event referencing org B's ticket — must fail.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertGrounding(pglite, orgAId, aircraftAId, userAId, { dispatchTicketId: ticketBId }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── aircraft_grounding_reason_check ──────────────────────────────────────

  it('aircraft_grounding_reason_check: state=grounded with empty reason is rejected', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertGrounding(pglite, orgAId, aircraftAId, userAId, { state: 'grounded', reason: '' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('aircraft_grounding_reason_check: state=grounded with blank-only reason is rejected', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertGrounding(pglite, orgAId, aircraftAId, userAId, { state: 'grounded', reason: '   ' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('aircraft_grounding_reason_check: state=grounded with non-empty reason is accepted', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const id = await insertGrounding(pglite, orgAId, aircraftAId, userAId, {
      state: 'grounded',
      reason: 'Annual inspection overdue',
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await pglite.exec(`COMMIT`);
  });

  it('aircraft_grounding_reason_check: state=released with empty reason is accepted [VERIFY-3b-C]', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const id = await insertGrounding(pglite, orgAId, aircraftAId, userAId, {
      state: 'released',
      reason: '',
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await pglite.exec(`COMMIT`);
  });

  // ── ON DELETE RESTRICT — resource ─────────────────────────────────────────

  it('ON DELETE RESTRICT: deleting a resource with grounding rows is blocked', async () => {
    const { pglite, orgAId, userAId } = env;

    // Create a fresh resource + grounding event as superuser with GUC set.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const newResourceResult = await pglite.query<{ id: string }>(
      `INSERT INTO resource (org_id, kind, display_name, tail_number)
       VALUES ($1, 'aircraft', 'Cessna 182 N88888', 'N88888')
       RETURNING id`,
      [orgAId],
    );
    const newResourceId = newResourceResult.rows[0]!.id;
    await pglite.query(
      `INSERT INTO aircraft_grounding (org_id, resource_id, state, reason, created_by)
       VALUES ($1, $2, 'grounded', 'Cannot delete resource', $3)`,
      [orgAId, newResourceId, userAId],
    );
    await pglite.exec(`COMMIT`);

    // Attempt to hard-delete the resource — must fail (RESTRICT).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(`DELETE FROM resource WHERE id = $1`, [newResourceId]),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── ON DELETE SET NULL — squawk_id ────────────────────────────────────────

  it('ON DELETE SET NULL: deleting a squawk nullifies aircraft_grounding.squawk_id', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;

    // Seed disposable squawk + grounding event as superuser with GUC set.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const disposableSquawkResult = await pglite.query<{ id: string }>(
      `INSERT INTO squawk (org_id, resource_id, title, severity, status, reported_by)
       VALUES ($1, $2, 'Disposable squawk', 'low', 'open', $3)
       RETURNING id`,
      [orgAId, aircraftAId, userAId],
    );
    const disposableSquawkId = disposableSquawkResult.rows[0]!.id;
    const groundingResult = await pglite.query<{ id: string }>(
      `INSERT INTO aircraft_grounding (org_id, resource_id, state, reason, squawk_id, created_by)
       VALUES ($1, $2, 'grounded', 'Related to disposable squawk', $3, $4)
       RETURNING id`,
      [orgAId, aircraftAId, disposableSquawkId, userAId],
    );
    const groundingId = groundingResult.rows[0]!.id;
    await pglite.exec(`COMMIT`);

    // Delete the squawk — aircraft_grounding.squawk_id should become NULL.
    // The composite FK uses ON DELETE SET NULL ("squawk_id") which only nulls
    // squawk_id, not org_id (Postgres 15+ column-list syntax).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await pglite.query(`DELETE FROM squawk WHERE id = $1`, [disposableSquawkId]);
    await pglite.exec(`COMMIT`);

    // Verify SET NULL took effect.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const check = await pglite.query<{ squawk_id: string | null }>(
      `SELECT squawk_id FROM aircraft_grounding WHERE id = $1`,
      [groundingId],
    );
    expect(check.rows[0]!.squawk_id).toBeNull();
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── ON DELETE SET NULL — dispatch_ticket_id ───────────────────────────────

  it('ON DELETE SET NULL: deleting a dispatch_ticket nullifies aircraft_grounding.dispatch_ticket_id', async () => {
    const { pglite, orgAId, aircraftAId, userAId, reservationAId } = env;

    // Seed disposable dispatch ticket + grounding event as superuser with GUC set.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const disposableTicketResult = await pglite.query<{ id: string }>(
      `INSERT INTO dispatch_ticket (
         org_id, reservation_id, resource_id, pilot_user_id,
         status, hobbs_out, tach_out, opened_by
       ) VALUES ($1, $2, $3, $4, 'voided', 300.0, 290.0, $4)
       RETURNING id`,
      [orgAId, reservationAId, aircraftAId, userAId],
    );
    const disposableTicketId = disposableTicketResult.rows[0]!.id;
    const groundingResult = await pglite.query<{ id: string }>(
      `INSERT INTO aircraft_grounding (org_id, resource_id, state, reason, dispatch_ticket_id, created_by)
       VALUES ($1, $2, 'grounded', 'Discovered during check-in', $3, $4)
       RETURNING id`,
      [orgAId, aircraftAId, disposableTicketId, userAId],
    );
    const groundingId = groundingResult.rows[0]!.id;
    await pglite.exec(`COMMIT`);

    // Delete the ticket — aircraft_grounding.dispatch_ticket_id should become NULL.
    // The composite FK uses ON DELETE SET NULL ("dispatch_ticket_id") which only
    // nulls dispatch_ticket_id, not org_id (Postgres 15+ column-list syntax).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await pglite.query(`DELETE FROM dispatch_ticket WHERE id = $1`, [disposableTicketId]);
    await pglite.exec(`COMMIT`);

    // Verify SET NULL took effect.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const check = await pglite.query<{ dispatch_ticket_id: string | null }>(
      `SELECT dispatch_ticket_id FROM aircraft_grounding WHERE id = $1`,
      [groundingId],
    );
    expect(check.rows[0]!.dispatch_ticket_id).toBeNull();
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── Event-sourced pattern (multiple events per aircraft) ──────────────────

  it('event-sourced: multiple events on the same aircraft are allowed (no UNIQUE constraint on resource)', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    // First event: ground
    const e1 = await insertGrounding(pglite, orgAId, aircraftAId, userAId, {
      reason: 'Multiple events test - ground',
    });
    // Second event: release — must also succeed (append-only, no uniqueness on resource_id)
    const e2 = await insertGrounding(pglite, orgAId, aircraftAId, userAId, {
      state: 'released',
      reason: 'Multiple events test - release',
    });
    expect(e1).toMatch(/^[0-9a-f-]{36}$/);
    expect(e2).toMatch(/^[0-9a-f-]{36}$/);
    expect(e1).not.toBe(e2);
    await pglite.exec(`COMMIT`);
  });

  // ── Grounding events visible under correct org context ────────────────────

  it('aircraft_grounding rows are visible under their org context', async () => {
    const { db, orgAId } = env;
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(aircraftGrounding).execute(),
    );
    expect(rows.every((r) => r.orgId === orgAId)).toBe(true);
  });
});
