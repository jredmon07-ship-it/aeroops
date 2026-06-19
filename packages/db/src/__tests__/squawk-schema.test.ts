/**
 * squawk-schema.test.ts — Smoke + constraint tests for the squawk table in
 * 0006_squawks_grounding.sql (spec §1.7).
 *
 * Proves that:
 *   1. Migration 0006 applies cleanly on PGlite atop 0000–0005.
 *   2. squawk table exists with correct enum columns (squawk_status, squawk_severity).
 *   3. squawk_id_org_id_unique constraint exists.
 *   4. RLS isolation: org A cannot see org B's squawk rows.
 *   5. FORCE RLS fail-closed: GUC unset → 0 rows from squawk.
 *   6. Cross-org FK rejection: resource_id from a different org → rejected.
 *   7. Cross-org FK rejection: dispatch_ticket_id from a different org → rejected.
 *   8. Cross-org FK rejection: reported_by from a different org → rejected.
 *   9. Non-member reporter rejection (user from a third org) → rejected.
 *  10. squawk_title_nonempty_check: empty title → rejected; blank-only title → rejected.
 *  11. squawk_resolved_shape_check:
 *      (a) status='resolved' with NULL resolved_by → rejected.
 *      (b) status='open' with non-NULL resolved_by → rejected.
 *      (c) status='open' with non-NULL resolution_notes → rejected.
 *      (d) status='deferred' with all resolution fields → accepted.
 *      (e) status='resolved' with all resolution fields → accepted.
 *  12. ON DELETE RESTRICT: deleting a resource with squawk rows is blocked.
 *  13. ON DELETE SET NULL: deleting a dispatch_ticket nullifies dispatch_ticket_id.
 *  14. ON DELETE SET NULL: deleting resolved_by user nullifies resolved_by.
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
import { org, appUser, resource, reservation, dispatchTicket, squawk } from '../schema/index.js';
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
];

// ── Test environment ──────────────────────────────────────────────────────────

interface SquawkTestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  orgCId: string; // third org for non-member rejection
  userAId: string;
  userBId: string;
  userCId: string; // user in third org
  aircraftAId: string; // resource (kind='aircraft') in org A
  aircraftBId: string; // resource (kind='aircraft') in org B
  reservationAId: string;
  ticketAId: string; // dispatch_ticket in org A
  ticketBId: string; // dispatch_ticket in org B
}

async function setupSquawkEnv(): Promise<SquawkTestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  // Seed as superuser (before setTestAppRole) so RLS allows cross-context inserts.
  const [orgA, orgB, orgC] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha School', slug: 'alpha-squawk' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta Club', slug: 'beta-squawk' })
      .returning();
    const c = await tx
      .insert(org)
      .values({ name: 'Gamma FBO', slug: 'gamma-squawk' })
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

  const [userB, aircraftB] = await withOrgContext(db, orgB.id, async (tx) => {
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
    return [u[0]!, r[0]!];
  });

  const [userC] = await withOrgContext(db, orgC.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgC.id, email: 'carol@gamma.example', fullName: 'Carol C' })
      .returning();
    return [u[0]!];
  });

  // Seed dispatch tickets for FK tests (as superuser since tickets need a reservation).
  // Org A ticket
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

  // Org B: needs a reservation too — seed it inline
  const [reservationB] = await withOrgContext(db, orgB.id, async (tx) => {
    return tx
      .insert(reservation)
      .values({
        orgId: orgB.id,
        startAt: new Date('2026-07-01T10:00:00Z'),
        endAt: new Date('2026-07-01T12:00:00Z'),
        status: 'booked',
        createdBy: userB.id,
      })
      .returning();
  });

  const ticketBResult = await withOrgContext(db, orgB.id, async (tx) => {
    return tx
      .insert(dispatchTicket)
      .values({
        orgId: orgB.id,
        reservationId: reservationB!.id,
        resourceId: aircraftB.id,
        pilotUserId: userB.id,
        status: 'open',
        hobbsOut: '200.0',
        tachOut: '190.0',
        openedBy: userB.id,
      })
      .returning();
  });

  // Drop to aeroops_app for RLS enforcement on all subsequent queries.
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
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Inserts a valid squawk row for an org.
 * Returns the squawk id. Caller sets GUC and manages transaction.
 */
async function insertSquawk(
  pglite: PGlite,
  orgId: string,
  resourceId: string,
  reportedBy: string,
  opts: {
    title?: string;
    severity?: string;
    status?: string;
    dispatchTicketId?: string | null;
    resolvedBy?: string | null;
    resolvedAt?: string | null;
    resolutionNotes?: string | null;
  } = {},
): Promise<string> {
  const title = opts.title ?? 'Oil pressure fluctuation';
  const severity = opts.severity ?? 'medium';
  const status = opts.status ?? 'open';
  const dispatchTicketId = opts.dispatchTicketId ?? null;
  const resolvedBy = opts.resolvedBy ?? null;
  const resolvedAt = opts.resolvedAt ?? null;
  const resolutionNotes = opts.resolutionNotes ?? null;

  const result = await pglite.query<{ id: string }>(
    `INSERT INTO squawk (
       org_id, resource_id, title, severity, status,
       reported_by, dispatch_ticket_id, resolved_by, resolved_at, resolution_notes
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10
     ) RETURNING id`,
    [orgId, resourceId, title, severity, status, reportedBy, dispatchTicketId, resolvedBy, resolvedAt, resolutionNotes],
  );
  return result.rows[0]!.id;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('squawk-schema: migration 0006 + constraints + RLS', () => {
  let env: SquawkTestEnv;

  beforeAll(async () => {
    env = await setupSquawkEnv();
  });

  // ── Migration baseline ─────────────────────────────────────────────────────

  it('0006 applied: squawk table exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'squawk'
       ) AS exists`,
    );
    expect(result.rows[0]!.exists).toBe(true);
  });

  it('0006 applied: squawk_status enum has 3 values (open, deferred, resolved)', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
       WHERE pg_type.typname = 'squawk_status'
       ORDER BY pg_enum.enumsortorder`,
    );
    expect(result.rows.map((r) => r.enumlabel)).toEqual(['open', 'deferred', 'resolved']);
  });

  it('0006 applied: squawk_severity enum has 4 values (low, medium, high, grounding)', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
       WHERE pg_type.typname = 'squawk_severity'
       ORDER BY pg_enum.enumsortorder`,
    );
    expect(result.rows.map((r) => r.enumlabel)).toEqual(['low', 'medium', 'high', 'grounding']);
  });

  it('0006 applied: squawk_id_org_id_unique constraint exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'squawk'::regclass
         AND contype = 'u'
         AND conname = 'squawk_id_org_id_unique'`,
    );
    expect(result.rows.length).toBe(1);
  });

  it('0006 applied: squawk_title_nonempty_check constraint exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'squawk'::regclass
         AND contype = 'c'
         AND conname = 'squawk_title_nonempty_check'`,
    );
    expect(result.rows.length).toBe(1);
  });

  it('0006 applied: squawk_resolved_shape_check constraint exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'squawk'::regclass
         AND contype = 'c'
         AND conname = 'squawk_resolved_shape_check'`,
    );
    expect(result.rows.length).toBe(1);
  });

  it('0006 applied: squawk_resource_org_fk is RESTRICT', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'squawk'::regclass
         AND contype = 'f'
         AND conname = 'squawk_resource_org_fk'`,
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.confdeltype).toBe('r'); // RESTRICT
  });

  it('0006 applied: squawk_resolved_by_org_fk is SET NULL', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'squawk'::regclass
         AND contype = 'f'
         AND conname = 'squawk_resolved_by_org_fk'`,
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.confdeltype).toBe('n'); // SET NULL
  });

  it('0006 applied: squawk_dispatch_ticket_org_fk is SET NULL', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'squawk'::regclass
         AND contype = 'f'
         AND conname = 'squawk_dispatch_ticket_org_fk'`,
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.confdeltype).toBe('n'); // SET NULL
  });

  // ── Baseline: valid squawk inserts ────────────────────────────────────────

  it('baseline: valid open squawk inserts successfully', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const id = await insertSquawk(pglite, orgAId, aircraftAId, userAId);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await pglite.exec(`COMMIT`);
  });

  // ── RLS: fail-closed (GUC unset → 0 rows) ────────────────────────────────

  it('RLS: squawk returns 0 rows when GUC is unset (FORCE RLS fail-closed)', async () => {
    const { pglite } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM squawk`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  // ── RLS: isolation ────────────────────────────────────────────────────────

  it('RLS isolation: org A cannot see org B squawk rows', async () => {
    const { pglite, db, orgAId, orgBId, aircraftBId, userBId } = env;

    // Seed a squawk for org B as superuser.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertSquawk(pglite, orgBId, aircraftBId, userBId);
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Org A context — must not see org B rows.
    const rowsUnderA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(squawk).execute(),
    );
    expect(rowsUnderA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsUnderA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context — must see org B rows.
    const rowsUnderB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(squawk).execute(),
    );
    expect(rowsUnderB.some((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsUnderB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  // ── Cross-org FK rejection — resource_id ─────────────────────────────────

  it('composite FK: cross-org resource_id is rejected', async () => {
    const { pglite, orgAId, aircraftBId, userAId } = env;
    // org A squawk referencing org B's aircraft — must fail.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertSquawk(pglite, orgAId, aircraftBId, userAId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── Cross-org FK rejection — dispatch_ticket_id ──────────────────────────

  it('composite FK: cross-org dispatch_ticket_id is rejected', async () => {
    const { pglite, orgAId, aircraftAId, userAId, ticketBId } = env;
    // org A squawk referencing org B's ticket — must fail.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertSquawk(pglite, orgAId, aircraftAId, userAId, { dispatchTicketId: ticketBId }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── Cross-org FK rejection — reported_by ─────────────────────────────────

  it('composite FK: cross-org reported_by is rejected', async () => {
    const { pglite, orgAId, aircraftAId, userBId } = env;
    // org A squawk with org B's user as reporter — must fail.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertSquawk(pglite, orgAId, aircraftAId, userBId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── Non-member reporter rejection ─────────────────────────────────────────

  it('composite FK: non-member reporter (user from a third org) is rejected', async () => {
    const { pglite, orgAId, aircraftAId, userCId } = env;
    // org A squawk with org C's user as reporter — must fail.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertSquawk(pglite, orgAId, aircraftAId, userCId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── squawk_title_nonempty_check ───────────────────────────────────────────

  it('squawk_title_nonempty_check: empty string title is rejected', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertSquawk(pglite, orgAId, aircraftAId, userAId, { title: '' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('squawk_title_nonempty_check: blank-only (spaces) title is rejected', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertSquawk(pglite, orgAId, aircraftAId, userAId, { title: '   ' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── squawk_resolved_shape_check ───────────────────────────────────────────

  it('squawk_resolved_shape_check: status=resolved with NULL resolved_at is rejected', async () => {
    // resolved_at IS NOT NULL is required for resolved/deferred.
    // resolved_by MAY be NULL (e.g. resolver user was deleted via ON DELETE SET NULL).
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO squawk (org_id, resource_id, title, severity, status, reported_by,
                             resolved_by, resolved_at, resolution_notes)
         VALUES ($1, $2, 'No resolved_at', 'low', 'resolved', $3, $3, NULL, 'Fixed')`,
        [orgAId, aircraftAId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('squawk_resolved_shape_check: status=resolved with NULL resolved_by is accepted (user may be deleted)', async () => {
    // resolved_by MAY be NULL if the resolver was later deleted via ON DELETE SET NULL.
    // Only resolved_at is required NOT NULL.
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const result = await pglite.query<{ id: string }>(
      `INSERT INTO squawk (org_id, resource_id, title, severity, status, reported_by,
                           resolved_by, resolved_at, resolution_notes)
       VALUES ($1, $2, 'Null resolver ok', 'low', 'resolved', $3, NULL, now(), 'Fixed')
       RETURNING id`,
      [orgAId, aircraftAId, userAId],
    );
    expect(result.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    await pglite.exec(`COMMIT`);
  });

  it('squawk_resolved_shape_check: status=open with non-NULL resolved_by is rejected', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    // Insert directly with SQL since our helper doesn't support this shape easily.
    await expect(
      pglite.query(
        `INSERT INTO squawk (org_id, resource_id, title, severity, status, reported_by, resolved_by)
         VALUES ($1, $2, 'Test squawk', 'low', 'open', $3, $3)`,
        [orgAId, aircraftAId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('squawk_resolved_shape_check: status=open with non-NULL resolution_notes is rejected', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO squawk (org_id, resource_id, title, severity, status, reported_by, resolution_notes)
         VALUES ($1, $2, 'Test squawk', 'low', 'open', $3, 'some notes')`,
        [orgAId, aircraftAId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('squawk_resolved_shape_check: status=deferred with resolved_by + resolved_at is accepted', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const result = await pglite.query<{ id: string }>(
      `INSERT INTO squawk (org_id, resource_id, title, severity, status, reported_by,
                           resolved_by, resolved_at, resolution_notes)
       VALUES ($1, $2, 'Deferred squawk', 'low', 'deferred', $3, $3, now(), 'deferred reason')
       RETURNING id`,
      [orgAId, aircraftAId, userAId],
    );
    expect(result.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    await pglite.exec(`COMMIT`);
  });

  it('squawk_resolved_shape_check: status=resolved with all resolution fields is accepted', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const result = await pglite.query<{ id: string }>(
      `INSERT INTO squawk (org_id, resource_id, title, severity, status, reported_by,
                           resolved_by, resolved_at, resolution_notes)
       VALUES ($1, $2, 'Resolved squawk', 'high', 'resolved', $3, $3, now(), 'Fixed oil seal')
       RETURNING id`,
      [orgAId, aircraftAId, userAId],
    );
    expect(result.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    await pglite.exec(`COMMIT`);
  });

  // ── ON DELETE RESTRICT — resource ─────────────────────────────────────────

  it('ON DELETE RESTRICT: deleting a resource with squawk rows is blocked', async () => {
    const { pglite, orgAId, userAId } = env;

    // Create a fresh resource as superuser with GUC set, then attach a squawk.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const newResourceResult = await pglite.query<{ id: string }>(
      `INSERT INTO resource (org_id, kind, display_name, tail_number)
       VALUES ($1, 'aircraft', 'Cessna 182 N77777', 'N77777')
       RETURNING id`,
      [orgAId],
    );
    const newResourceId = newResourceResult.rows[0]!.id;
    await pglite.query(
      `INSERT INTO squawk (org_id, resource_id, title, severity, status, reported_by)
       VALUES ($1, $2, 'Cannot delete me', 'low', 'open', $3)`,
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

  // ── ON DELETE SET NULL — dispatch_ticket_id ───────────────────────────────

  it('ON DELETE SET NULL: deleting a dispatch_ticket nullifies squawk.dispatch_ticket_id', async () => {
    const { pglite, orgAId, aircraftAId, userAId, reservationAId } = env;

    // Seed a disposable dispatch ticket + attach a squawk — all as superuser with GUC.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const ticketResult = await pglite.query<{ id: string }>(
      `INSERT INTO dispatch_ticket (
         org_id, reservation_id, resource_id, pilot_user_id,
         status, hobbs_out, tach_out, opened_by
       ) VALUES ($1, $2, $3, $4, 'voided', 150.0, 140.0, $4)
       RETURNING id`,
      [orgAId, reservationAId, aircraftAId, userAId],
    );
    const disposableTicketId = ticketResult.rows[0]!.id;
    const squawkResult = await pglite.query<{ id: string }>(
      `INSERT INTO squawk (org_id, resource_id, title, severity, status, reported_by, dispatch_ticket_id)
       VALUES ($1, $2, 'Ticket FK test', 'low', 'open', $3, $4)
       RETURNING id`,
      [orgAId, aircraftAId, userAId, disposableTicketId],
    );
    const squawkId = squawkResult.rows[0]!.id;
    await pglite.exec(`COMMIT`);

    // Delete the ticket — squawk.dispatch_ticket_id should become NULL.
    // The composite FK uses ON DELETE SET NULL ("dispatch_ticket_id") which
    // only nulls dispatch_ticket_id, not org_id (Postgres 15+ column-list syntax).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await pglite.query(`DELETE FROM dispatch_ticket WHERE id = $1`, [disposableTicketId]);
    await pglite.exec(`COMMIT`);

    // Verify SET NULL took effect.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const check = await pglite.query<{ dispatch_ticket_id: string | null }>(
      `SELECT dispatch_ticket_id FROM squawk WHERE id = $1`,
      [squawkId],
    );
    expect(check.rows[0]!.dispatch_ticket_id).toBeNull();
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── ON DELETE SET NULL — resolved_by ──────────────────────────────────────

  it('ON DELETE SET NULL: deleting resolved_by user nullifies squawk.resolved_by', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;

    // Create a disposable resolver user + resolved squawk — all as superuser with GUC.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const resolverResult = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name)
       VALUES ($1, 'resolver_disposable@alpha.example', 'Resolver')
       RETURNING id`,
      [orgAId],
    );
    const resolverId = resolverResult.rows[0]!.id;
    const squawkResult = await pglite.query<{ id: string }>(
      `INSERT INTO squawk (org_id, resource_id, title, severity, status, reported_by,
                           resolved_by, resolved_at, resolution_notes)
       VALUES ($1, $2, 'Resolver FK test', 'low', 'resolved', $3, $4, now(), 'Done')
       RETURNING id`,
      [orgAId, aircraftAId, userAId, resolverId],
    );
    const squawkId = squawkResult.rows[0]!.id;
    await pglite.exec(`COMMIT`);

    // Delete the resolver user — squawk.resolved_by should become NULL.
    // The composite FK uses ON DELETE SET NULL ("resolved_by") which only nulls
    // resolved_by, not org_id (Postgres 15+ column-list syntax).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await pglite.query(`DELETE FROM app_user WHERE id = $1`, [resolverId]);
    await pglite.exec(`COMMIT`);

    // Verify SET NULL took effect.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const check = await pglite.query<{ resolved_by: string | null; status: string }>(
      `SELECT resolved_by, status FROM squawk WHERE id = $1`,
      [squawkId],
    );
    expect(check.rows[0]!.resolved_by).toBeNull();
    // status and resolved_at should remain unchanged (only resolved_by goes NULL).
    expect(check.rows[0]!.status).toBe('resolved');
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── Squawk rows visible under correct org context ─────────────────────────

  it('squawk rows are visible under their org context', async () => {
    const { db, orgAId } = env;
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(squawk).execute(),
    );
    expect(rows.every((r) => r.orgId === orgAId)).toBe(true);
  });
});
