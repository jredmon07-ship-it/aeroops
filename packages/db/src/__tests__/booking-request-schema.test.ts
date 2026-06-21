/**
 * booking-request-schema.test.ts — Schema tests for 0015_booking_request.sql (Slice PB1.1)
 *                                  and 0016_booking_request_convert.sql (Slice PB2.1a).
 *
 * Proves spec §PB1.1 schema acceptance criteria:
 *
 *   BR1.  booking_request table exists after migration 0015.
 *   BR2.  FORCE RLS fail-closed: GUC unset → 0 rows from booking_request.
 *   BR3.  RLS isolation: org A cannot see org B's booking_request rows.
 *   BR4.  INSERT WITH CHECK is the ADR-0013 security backstop:
 *         an INSERT with org_id != current GUC org is REJECTED by the policy.
 *         This is the critical invariant the public (anon) write path relies on.
 *   BR5.  Composite FK cross-org rejection:
 *         BR5a. handled_by from a different org → rejected.
 *   BR6.  ON DELETE SET NULL column-list behavior:
 *         BR6a. Deleting handled_by user → handled_by = NULL, org_id preserved.
 *   BR7.  CHECKs fire:
 *         BR7a. booking_request_requester_name_nonempty_check: empty name → rejected.
 *         BR7b. booking_request_requester_name_nonempty_check: blank name → rejected.
 *         BR7c. booking_request_requester_email_nonempty_check: empty email → rejected.
 *         BR7d. booking_request_requester_email_nonempty_check: blank email → rejected.
 *         BR7e. booking_request_end_after_start_check: end <= start → rejected.
 *         BR7f. booking_request_end_after_start_check: end == start → rejected.
 *         BR7g. booking_request_end_after_start_check: end IS NULL → accepted.
 *         BR7h. booking_request_status_check: invalid status value → rejected.
 *         BR7i. booking_request_handled_shape_check: status='new' with handled_at set → rejected.
 *         BR7j. booking_request_handled_shape_check: status='new' with handled_by set → rejected.
 *         BR7k. booking_request_handled_shape_check: status='contacted' without handled_at → rejected.
 *         BR7l. booking_request_handled_shape_check: status='declined' without handled_at → rejected.
 *   BR8.  UNIQUE(id, org_id): composite candidate key index exists.
 *   BR9.  Happy-path round-trips:
 *         BR9a. New (anon) booking request inserts and reads back correctly.
 *         BR9b. Triaged (contacted) request with handled_at → accepted.
 *         BR9c. Converted request with handled_at → accepted.
 *   BR10. Down migration reverses 0015: booking_request table gone.
 *
 * Proves spec §PB2.1a schema acceptance criteria (migration 0016):
 *
 *   CV1.  converted_reservation_id column exists and is nullable after migration 0016.
 *         CV1a. Column is present on the table.
 *         CV1b. INSERT without converted_reservation_id still succeeds (nullable).
 *   CV2.  Composite FK accepts a valid same-org (reservation_id, org_id) link.
 *   CV3.  Composite FK REJECTS a cross-org pair (reservation_id from org B, org_id
 *         of org A) — the cross-org backstop; no such tuple exists in
 *         reservation_id_org_id_unique.
 *   CV4.  ON DELETE SET NULL (converted_reservation_id):
 *         CV4a. Deleting the linked reservation → converted_reservation_id = NULL.
 *         CV4b. org_id is preserved after the SET NULL action.
 *         CV4c. status = 'converted' is preserved after the SET NULL action.
 *   CV5.  booking_request_handled_shape_check still PASSES for a converted row
 *         whose converted_reservation_id IS NULL (shape-check UNCHANGED).
 *   CV6.  Down migration reverses 0016:
 *         CV6a. converted_reservation_id column is gone after down.
 *         CV6b. booking_request_converted_reservation_org_fk constraint is gone.
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies all 17 real
 * migration artifacts (0000–0016) in order so the constraint SQL validated
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
import { org, appUser, reservation, bookingRequest } from '../schema/index.js';
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
  readFileSync(resolve(__dirname, '../../migrations/0018_dispatch_ticket_correction.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0019_billing_records.sql'),        'utf-8'),
];

const DOWN_0015 = readFileSync(
  resolve(__dirname, '../../migrations/0015_booking_request.down.sql'),
  'utf-8',
);

const DOWN_0016 = readFileSync(
  resolve(__dirname, '../../migrations/0016_booking_request_convert.down.sql'),
  'utf-8',
);

// ── Test environment ──────────────────────────────────────────────────────────

interface BookingRequestTestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;        // member of org A (used as handler)
  userBId: string;        // member of org B (used for cross-org tests)
  reservationAId: string; // reservation in org A (CV2/CV4 FK tests)
  reservationBId: string; // reservation in org B (CV3 cross-org rejection test)
}

async function setupBookingRequestEnv(): Promise<BookingRequestTestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha Flight School', slug: 'alpha-br' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta FBO', slug: 'beta-br' })
      .returning();
    return [a[0]!, b[0]!];
  });

  const [userA] = await withOrgContext(db, orgA.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'alice@alpha-br.example', fullName: 'Alice A' })
      .returning();
    return [u[0]!];
  });

  const [userB] = await withOrgContext(db, orgB.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgB.id, email: 'bob@beta-br.example', fullName: 'Bob B' })
      .returning();
    return [u[0]!];
  });

  // Seed one reservation in each org (CV2 / CV3 / CV4 tests).
  // Reservations are inserted via superuser (platform context) to bypass the
  // reservation_resource EXCLUDE constraint — these are FK-target rows only,
  // not real dispatched flights.
  const [reservationA] = await withOrgContext(db, orgA.id, async (tx) => {
    const rows = await tx
      .insert(reservation)
      .values({
        orgId: orgA.id,
        startAt: new Date('2027-06-01T10:00:00Z'),
        endAt: new Date('2027-06-01T12:00:00Z'),
        createdBy: userA.id,
      })
      .returning();
    return [rows[0]!];
  });

  const [reservationB] = await withOrgContext(db, orgB.id, async (tx) => {
    const rows = await tx
      .insert(reservation)
      .values({
        orgId: orgB.id,
        startAt: new Date('2027-06-01T10:00:00Z'),
        endAt: new Date('2027-06-01T12:00:00Z'),
        createdBy: userB.id,
      })
      .returning();
    return [rows[0]!];
  });

  // Drop to aeroops_app for RLS enforcement on all subsequent queries.
  await setTestAppRole({ pglite });

  return {
    db,
    pglite,
    orgAId: orgA.id,
    orgBId: orgB.id,
    userAId: userA.id,
    userBId: userB.id,
    reservationAId: reservationA.id,
    reservationBId: reservationB.id,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Insert a minimal 'new' booking request (anon submit simulation). */
async function insertNewRequest(
  pglite: PGlite,
  orgId: string,
  opts: {
    name?: string;
    email?: string;
    phone?: string;
    requestedStart?: string;
    requestedEnd?: string;
    aircraftTypePref?: string;
    message?: string;
  } = {},
): Promise<string> {
  const r = await pglite.query<{ id: string }>(
    `INSERT INTO booking_request
       (org_id, requester_name, requester_email, requester_phone,
        requested_start, requested_end, aircraft_type_pref, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      orgId,
      opts.name ?? 'Jane Doe',
      opts.email ?? 'jane@example.com',
      opts.phone ?? null,
      opts.requestedStart ?? '2027-01-15 10:00:00+00',
      opts.requestedEnd ?? null,
      opts.aircraftTypePref ?? null,
      opts.message ?? null,
    ],
  );
  return r.rows[0]!.id;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('booking-request-schema: migration 0015 + constraints + RLS', () => {
  let env: BookingRequestTestEnv;

  beforeAll(async () => {
    env = await setupBookingRequestEnv();
  });

  // ── BR1: Table exists after migration 0015 ───────────────────────────────────

  it('BR1: booking_request table exists after migration 0015', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'booking_request'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  // ── BR2: FORCE RLS fail-closed (GUC unset → 0 rows) ─────────────────────────

  it('BR2: FORCE RLS fail-closed — GUC unset → 0 rows from booking_request', async () => {
    const { pglite, orgAId } = env;

    // Seed one row first (superuser, GUC set).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertNewRequest(pglite, orgAId, { name: 'BR2 seed' });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Unset GUC → 0 rows (fail-closed).
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const r = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM booking_request`,
    );
    expect(r.rows[0]!.count).toBe('0');
  });

  // ── BR3: RLS isolation (org A cannot see org B rows) ─────────────────────────

  it('BR3: RLS isolation — org A cannot see org B booking_request rows', async () => {
    const { pglite, db, orgAId, orgBId } = env;

    // Seed a request in org B (superuser).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertNewRequest(pglite, orgBId, { name: 'Org B Requester' });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Org A context → only org A rows.
    const rowsA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(bookingRequest).execute(),
    );
    expect(rowsA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context → only org B rows.
    const rowsB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(bookingRequest).execute(),
    );
    expect(rowsB.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  // ── BR4: INSERT WITH CHECK is the ADR-0013 backstop ─────────────────────────
  //
  // This is the critical invariant: even when operating as aeroops_app with the
  // GUC set to org A, attempting to INSERT a row with org_id = org B must be
  // REJECTED by the booking_request_insert WITH CHECK policy.
  //
  // This is what prevents a bug in the anon submit path from smuggling a
  // different org_id than the one resolved by resolveOrgBySlug.

  it('BR4: INSERT WITH CHECK rejects row org_id != GUC org (ADR-0013 backstop)', async () => {
    const { pglite, orgAId, orgBId } = env;

    // Set GUC to org A, but attempt to insert a row with org_id = org B.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO booking_request
           (org_id, requester_name, requester_email, requested_start)
         VALUES ($1, 'Smuggler', 'evil@example.com', '2027-01-15 10:00:00+00')`,
        [orgBId], // org_id != GUC org → WITH CHECK must fire
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── BR5: Composite FK cross-org rejection ────────────────────────────────────

  it('BR5a: handled_by from a different org → rejected', async () => {
    const { pglite, orgAId, userBId } = env;

    // Seed a request so we can try to update it with a cross-org handled_by.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const reqId = await insertNewRequest(pglite, orgAId, { name: 'BR5a seed' });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Attempt to triage with a handler from org B — composite FK must reject.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `UPDATE booking_request
         SET status = 'contacted', handled_by = $1, handled_at = now()
         WHERE id = $2`,
        [userBId, reqId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── BR6: ON DELETE SET NULL column-list (org_id preserved) ──────────────────

  it('BR6a: deleting handled_by user → handled_by = NULL, org_id preserved', async () => {
    const { pglite, orgAId } = env;

    // Create a throwaway handler user and a contacted request linked to them.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);

    const uResult = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name)
       VALUES ($1, 'throwaway-handler@alpha-br.example', 'Throwaway Handler')
       RETURNING id`,
      [orgAId],
    );
    const throwUserId = uResult.rows[0]!.id;

    const reqResult = await pglite.query<{ id: string }>(
      `INSERT INTO booking_request
         (org_id, requester_name, requester_email, requested_start,
          status, handled_by, handled_at)
       VALUES ($1, 'BR6a Requester', 'br6a@example.com', '2027-02-01 09:00:00+00',
               'contacted', $2, now())
       RETURNING id`,
      [orgAId, throwUserId],
    );
    const reqId = reqResult.rows[0]!.id;
    await pglite.exec(`COMMIT`);

    // Hard-delete the throwaway user → handled_by must become NULL.
    await pglite.query(`DELETE FROM app_user WHERE id = $1`, [throwUserId]);

    // Verify handled_by is NULL but org_id is preserved.
    const r = await pglite.query<{ handled_by: string | null; org_id: string }>(
      `SELECT handled_by, org_id FROM booking_request WHERE id = $1`,
      [reqId],
    );
    expect(r.rows[0]!.handled_by).toBeNull();
    expect(r.rows[0]!.org_id).toBe(orgAId);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── BR7: CHECKs fire ─────────────────────────────────────────────────────────

  it('BR7a: requester_name_nonempty_check: empty name → rejected', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertNewRequest(pglite, orgAId, { name: '' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR7b: requester_name_nonempty_check: blank-only name → rejected', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertNewRequest(pglite, orgAId, { name: '   ' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR7c: requester_email_nonempty_check: empty email → rejected', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertNewRequest(pglite, orgAId, { email: '' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR7d: requester_email_nonempty_check: blank-only email → rejected', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertNewRequest(pglite, orgAId, { email: '   ' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR7e: end_after_start_check: end < start → rejected', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertNewRequest(pglite, orgAId, {
        requestedStart: '2027-01-15 14:00:00+00',
        requestedEnd: '2027-01-15 10:00:00+00', // before start
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR7f: end_after_start_check: end == start → rejected', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertNewRequest(pglite, orgAId, {
        requestedStart: '2027-01-15 10:00:00+00',
        requestedEnd: '2027-01-15 10:00:00+00', // equal to start
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR7g: end_after_start_check: end IS NULL → accepted (nullable end)', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    // Should not throw — NULL end is explicitly allowed.
    const id = await insertNewRequest(pglite, orgAId, {
      name: 'BR7g no end',
      requestedEnd: undefined, // NULL
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);
    expect(id).toBeTruthy();
  });

  it('BR7h: status_check: invalid status value → rejected', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO booking_request
           (org_id, requester_name, requester_email, requested_start, status)
         VALUES ($1, 'Bad Status', 'bad@example.com', '2027-01-15 10:00:00+00', 'pending')`,
        [orgAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR7i: handled_shape_check: status=new with handled_at set → rejected', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO booking_request
           (org_id, requester_name, requester_email, requested_start,
            status, handled_at)
         VALUES ($1, 'Shape Fail', 'shape@example.com', '2027-01-15 10:00:00+00',
                 'new', now())`,
        [orgAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR7j: handled_shape_check: status=new with handled_by set → rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO booking_request
           (org_id, requester_name, requester_email, requested_start,
            status, handled_by)
         VALUES ($1, 'Shape Fail 2', 'shape2@example.com', '2027-01-15 10:00:00+00',
                 'new', $2)`,
        [orgAId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR7k: handled_shape_check: status=contacted without handled_at → rejected', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO booking_request
           (org_id, requester_name, requester_email, requested_start, status)
         VALUES ($1, 'No Handle Time', 'notime@example.com',
                 '2027-01-15 10:00:00+00', 'contacted')`,
        [orgAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('BR7l: handled_shape_check: status=declined without handled_at → rejected', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO booking_request
           (org_id, requester_name, requester_email, requested_start, status)
         VALUES ($1, 'No Decline Time', 'nodecline@example.com',
                 '2027-01-15 10:00:00+00', 'declined')`,
        [orgAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── BR8: UNIQUE(id, org_id) index exists ─────────────────────────────────────

  it('BR8: UNIQUE(id, org_id) index exists on booking_request', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_indexes
         WHERE tablename = 'booking_request'
           AND indexname = 'booking_request_id_org_id_unique'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  // ── BR9: Happy-path round-trips ───────────────────────────────────────────────

  it('BR9a: new (anon) booking request inserts and reads back correctly', async () => {
    const { pglite, db, orgAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const reqId = await insertNewRequest(pglite, orgAId, {
      name: 'BR9a Requester',
      email: 'br9a@example.com',
      phone: '+1-555-0100',
      requestedStart: '2027-03-10 14:00:00+00',
      requestedEnd: '2027-03-10 16:00:00+00',
      aircraftTypePref: 'Cessna 172',
      message: 'Looking for a discovery flight.',
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    const row = await pglite.query<{
      id: string;
      org_id: string;
      status: string;
      requester_name: string;
      requester_email: string;
      requester_phone: string | null;
      aircraft_type_pref: string | null;
      handled_by: string | null;
      handled_at: string | null;
    }>(
      `SELECT id, org_id, status, requester_name, requester_email,
              requester_phone, aircraft_type_pref, handled_by, handled_at
       FROM booking_request WHERE id = $1`,
      [reqId],
    );
    const r = row.rows[0]!;
    expect(r.id).toBe(reqId);
    expect(r.org_id).toBe(orgAId);
    expect(r.status).toBe('new');
    expect(r.requester_name).toBe('BR9a Requester');
    expect(r.requester_email).toBe('br9a@example.com');
    expect(r.requester_phone).toBe('+1-555-0100');
    expect(r.aircraft_type_pref).toBe('Cessna 172');
    expect(r.handled_by).toBeNull();
    expect(r.handled_at).toBeNull();
  });

  it('BR9b: triaged (contacted) request with handled_at → accepted', async () => {
    const { pglite, orgAId, userAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const r = await pglite.query<{ id: string; status: string; handled_at: string | null }>(
      `INSERT INTO booking_request
         (org_id, requester_name, requester_email, requested_start,
          status, handled_by, handled_at, triage_notes)
       VALUES ($1, 'BR9b Requester', 'br9b@example.com', '2027-04-01 09:00:00+00',
               'contacted', $2, now(), 'Left voicemail.')
       RETURNING id, status, handled_at`,
      [orgAId, userAId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(r.rows[0]!.status).toBe('contacted');
    expect(r.rows[0]!.handled_at).not.toBeNull();
  });

  it('BR9c: converted request with handled_at → accepted', async () => {
    const { pglite, orgAId, userAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const r = await pglite.query<{ id: string; status: string }>(
      `INSERT INTO booking_request
         (org_id, requester_name, requester_email, requested_start,
          status, handled_by, handled_at)
       VALUES ($1, 'BR9c Requester', 'br9c@example.com', '2027-05-01 11:00:00+00',
               'converted', $2, now())
       RETURNING id, status`,
      [orgAId, userAId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(r.rows[0]!.status).toBe('converted');
  });

  // ── BR10: Down migration reverses 0015 ───────────────────────────────────────
  // Note: MIGRATION_SQL now includes 0016; the down test applies 0015 down on a
  // fresh client that has had 0016 up applied. 0015 down drops the whole table
  // (CASCADE), which also removes the 0016 column + FK.

  it('BR10: down migration reverses 0015 — booking_request table gone', async () => {
    // Spin up a separate isolated client for down-migration test.
    const { pglite: pg2 } = await createTestClient();
    await applyMigrationSql({ pglite: pg2 }, MIGRATION_SQL);

    // Verify table exists before down.
    const before = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'booking_request'
       ) AS exists`,
    );
    expect(before.rows[0]!.exists).toBe(true);

    // Apply the down migration (0015 drops the table; CASCADE removes 0016 constraint too).
    await pg2.exec(DOWN_0015);

    // Table must be gone.
    const after = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'booking_request'
       ) AS exists`,
    );
    expect(after.rows[0]!.exists).toBe(false);
  });

  // ── CV1: converted_reservation_id column exists + is nullable (migration 0016) ──

  it('CV1a: converted_reservation_id column exists on booking_request after migration 0016', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'booking_request'
           AND column_name = 'converted_reservation_id'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  it('CV1b: INSERT without converted_reservation_id succeeds (nullable column)', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    // Should not throw — column is nullable and has no default.
    const id = await insertNewRequest(pglite, orgAId, { name: 'CV1b no link' });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);
    expect(id).toBeTruthy();

    // Verify converted_reservation_id is NULL.
    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    const row = await pglite.query<{ converted_reservation_id: string | null }>(
      `SELECT converted_reservation_id FROM booking_request WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]!.converted_reservation_id).toBeNull();
  });

  // ── CV2: Composite FK accepts a valid same-org (reservation_id, org_id) link ──

  it('CV2: composite FK accepts a same-org (converted_reservation_id, org_id) link', async () => {
    const { pglite, orgAId, userAId, reservationAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);

    // Insert a converted request linking to the org-A reservation.
    const r = await pglite.query<{ id: string; converted_reservation_id: string }>(
      `INSERT INTO booking_request
         (org_id, requester_name, requester_email, requested_start,
          status, handled_by, handled_at, converted_reservation_id)
       VALUES ($1, 'CV2 Requester', 'cv2@example.com', '2027-06-01 10:00:00+00',
               'converted', $2, now(), $3)
       RETURNING id, converted_reservation_id`,
      [orgAId, userAId, reservationAId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(r.rows[0]!.converted_reservation_id).toBe(reservationAId);
  });

  // ── CV3: Composite FK REJECTS a cross-org (reservation_id from B, org_id of A) ─
  //
  // This is the structural cross-org backstop: (reservationBId, orgAId) is not in
  // reservation_id_org_id_unique, so the FK must reject the pair.

  it('CV3: composite FK rejects cross-org pair (reservation_id from org B with org A org_id)', async () => {
    const { pglite, orgAId, userAId, reservationBId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);

    // Attempt to link org A's booking_request to org B's reservation — must reject.
    await expect(
      pglite.query(
        `INSERT INTO booking_request
           (org_id, requester_name, requester_email, requested_start,
            status, handled_by, handled_at, converted_reservation_id)
         VALUES ($1, 'CV3 Attacker', 'cv3@example.com', '2027-06-01 10:00:00+00',
                 'converted', $2, now(), $3)`,
        [orgAId, userAId, reservationBId], // reservationBId belongs to org B — FK must fire
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── CV4: ON DELETE SET NULL (converted_reservation_id) — org_id + status preserved ─

  it('CV4a/b/c: deleting the linked reservation → converted_reservation_id = NULL, org_id + status preserved', async () => {
    const { pglite, orgAId, orgBId } = env;

    // Use a fresh throwaway reservation to avoid clobbering the shared reservationA.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);

    // We need a throwaway user (created_by for the throwaway reservation).
    const uRow = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name)
       VALUES ($1, 'cv4-handler@alpha-br.example', 'CV4 Handler')
       RETURNING id`,
      [orgAId],
    );
    const cv4UserId = uRow.rows[0]!.id;

    // Throwaway reservation in org A.
    const rsvRow = await pglite.query<{ id: string }>(
      `INSERT INTO reservation (org_id, start_at, end_at, created_by)
       VALUES ($1, '2027-07-01 10:00:00+00', '2027-07-01 12:00:00+00', $2)
       RETURNING id`,
      [orgAId, cv4UserId],
    );
    const throwResvId = rsvRow.rows[0]!.id;

    // Booking request pointing at the throwaway reservation.
    const brRow = await pglite.query<{ id: string }>(
      `INSERT INTO booking_request
         (org_id, requester_name, requester_email, requested_start,
          status, handled_by, handled_at, converted_reservation_id)
       VALUES ($1, 'CV4 Requester', 'cv4@example.com', '2027-07-01 10:00:00+00',
               'converted', $2, now(), $3)
       RETURNING id`,
      [orgAId, cv4UserId, throwResvId],
    );
    const brId = brRow.rows[0]!.id;
    await pglite.exec(`COMMIT`);

    // Hard-delete the throwaway reservation (superuser; no tx needed for the delete itself).
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await pglite.query(`DELETE FROM reservation WHERE id = $1`, [throwResvId]);

    // Verify the FK SET NULL fired: converted_reservation_id = NULL.
    const check = await pglite.query<{
      converted_reservation_id: string | null;
      org_id: string;
      status: string;
    }>(
      `SELECT converted_reservation_id, org_id, status FROM booking_request WHERE id = $1`,
      [brId],
    );
    const row = check.rows[0]!;

    // CV4a: converted_reservation_id is NULL.
    expect(row.converted_reservation_id).toBeNull();
    // CV4b: org_id is preserved (not nulled).
    expect(row.org_id).toBe(orgAId);
    // CV4c: status = 'converted' is preserved.
    expect(row.status).toBe('converted');

    await pglite.exec(`SET ROLE aeroops_app`);
    // Suppress unused variable warning.
    void orgBId;
  });

  // ── CV5: booking_request_handled_shape_check passes for converted row with NULL link ─
  //
  // The shape-check is UNCHANGED by migration 0016. A converted row with a NULL
  // converted_reservation_id is valid (SET NULL action, or PB1 flag-only converted rows).

  it('CV5: handled_shape_check passes for converted row with NULL converted_reservation_id', async () => {
    const { pglite, orgAId, userAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);

    // Insert a converted row with converted_reservation_id = NULL (the PB1 pattern).
    // Should NOT throw (shape-check must pass).
    const r = await pglite.query<{ id: string; status: string; converted_reservation_id: string | null }>(
      `INSERT INTO booking_request
         (org_id, requester_name, requester_email, requested_start,
          status, handled_by, handled_at, converted_reservation_id)
       VALUES ($1, 'CV5 Requester', 'cv5@example.com', '2027-08-01 09:00:00+00',
               'converted', $2, now(), NULL)
       RETURNING id, status, converted_reservation_id`,
      [orgAId, userAId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(r.rows[0]!.status).toBe('converted');
    expect(r.rows[0]!.converted_reservation_id).toBeNull();
  });

  // ── CV6: Down migration reverses 0016 ────────────────────────────────────────

  it('CV6: down migration reverses 0016 — column + constraint gone, table remains', async () => {
    // Spin up a separate isolated client for down-migration test.
    const { pglite: pg3 } = await createTestClient();
    await applyMigrationSql({ pglite: pg3 }, MIGRATION_SQL);

    // Verify column exists before down.
    const beforeCol = await pg3.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'booking_request'
           AND column_name = 'converted_reservation_id'
       ) AS exists`,
    );
    expect(beforeCol.rows[0]!.exists).toBe(true);

    // Verify constraint exists before down.
    const beforeCon = await pg3.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.table_constraints
         WHERE table_schema = 'public'
           AND table_name = 'booking_request'
           AND constraint_name = 'booking_request_converted_reservation_org_fk'
       ) AS exists`,
    );
    expect(beforeCon.rows[0]!.exists).toBe(true);

    // Apply the 0016 down migration.
    await pg3.exec(DOWN_0016);

    // CV6a: column is gone.
    const afterCol = await pg3.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'booking_request'
           AND column_name = 'converted_reservation_id'
       ) AS exists`,
    );
    expect(afterCol.rows[0]!.exists).toBe(false);

    // CV6b: constraint is gone.
    const afterCon = await pg3.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.table_constraints
         WHERE table_schema = 'public'
           AND table_name = 'booking_request'
           AND constraint_name = 'booking_request_converted_reservation_org_fk'
       ) AS exists`,
    );
    expect(afterCon.rows[0]!.exists).toBe(false);

    // Table itself still exists (only 0016 was reversed, not 0015).
    const tableStillExists = await pg3.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'booking_request'
       ) AS exists`,
    );
    expect(tableStillExists.rows[0]!.exists).toBe(true);
  });
});
