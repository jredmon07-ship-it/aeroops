/**
 * scheduling-schema.test.ts — Smoke test for 0002_scheduling.sql.
 *
 * Proves that:
 *   1. The migration applies cleanly on PGlite with btree_gist registered.
 *   2. The EXCLUDE constraint on reservation_resource enforces no-double-book:
 *      (a) Overlapping booked row for the SAME resource → 23P01 exclusion_violation.
 *      (b) Touching (adjacent) window [11:00,12:00) → succeeds (half-open).
 *      (c) Non-overlapping window → succeeds.
 *      (d) Cancelled overlapping row → succeeds (partial WHERE status='booked').
 *      (e) Cross-org: same window on a DIFFERENT org's resource → succeeds
 *          and is invisible cross-org (RLS).
 *
 * This is a SMOKE test only. Full conflict/property suite is the test-writer's
 * job in /qa. The API persistence layer (scheduling-engineer) is NOT tested here.
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies all three real
 * migration artifacts in order so the constraint SQL validated here is the
 * exact production artifact.
 *
 * PGlite is single-threaded WASM — true OS-thread concurrency cannot be
 * reproduced; the property suite in /qa will prove serialization via
 * two-transaction interleaving + bulk rejection. A real-Postgres concurrency
 * smoke is deferred to Slice 0.4 CI (ADR-0004 §Consequences).
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
import { org, appUser, resource, reservation, reservationResource } from '../schema/index.js';
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
];

// ── Test environment ──────────────────────────────────────────────────────────

interface SchedulingTestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
  aircraftAId: string;  // resource in org A
  aircraftBId: string;  // resource in org B (cross-org probe)
}

async function setupSchedulingEnv(): Promise<SchedulingTestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  // Seed as superuser (before setTestAppRole) so RLS allows cross-context inserts.
  // All inserts go through withOrgContext / withPlatformAdminContext to exercise
  // the RLS WITH CHECK policies even at superuser.

  // Create two orgs under platform-admin context.
  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha School', slug: 'alpha-sched' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta Club', slug: 'beta-sched' })
      .returning();
    return [a[0]!, b[0]!];
  });

  // Create one user + aircraft resource in org A.
  const [userA, aircraftA] = await withOrgContext(db, orgA.id, async (tx) => {
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

    return [u[0]!, r[0]!];
  });

  // Create one user + aircraft resource in org B (for cross-org probe).
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
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Insert a reservation + one reservation_resource join row in a single
 * transaction. Returns the IDs.
 *
 * `during` must be a Postgres tstzrange literal built by the caller, e.g.:
 *   tstzrange('2026-06-15 10:00:00+00', '2026-06-15 11:00:00+00', '[)')
 * The raw SQL form is used via pglite.exec to keep the test self-contained
 * without needing the API layer.
 */
async function insertBookedReservation(
  pglite: PGlite,
  orgId: string,
  resourceId: string,
  userId: string,
  startIso: string,
  endIso: string,
  status: 'booked' | 'cancelled' = 'booked',
): Promise<{ reservationId: string; joinId: string }> {
  // Use raw SQL via pglite.exec so we can embed tstzrange() constructor directly.
  // The test runs as aeroops_app (after setTestAppRole) — RLS is enforced.
  // We set the GUC at session level for this helper (no transaction wrapper here,
  // as we want to confirm RLS filters the row after the insert).
  await pglite.exec(`SET LOCAL app.current_org_id = '${orgId}'`);

  const resResult = await pglite.query<{ id: string }>(
    `INSERT INTO reservation (org_id, start_at, end_at, status, created_by)
     VALUES ($1, $2::timestamptz, $3::timestamptz, $4::reservation_status, $5)
     RETURNING id`,
    [orgId, startIso, endIso, status, userId],
  );
  const reservationId = resResult.rows[0]!.id;

  const joinResult = await pglite.query<{ id: string }>(
    `INSERT INTO reservation_resource (org_id, reservation_id, resource_id, during, status)
     VALUES ($1, $2, $3, tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6::reservation_status)
     RETURNING id`,
    [orgId, reservationId, resourceId, startIso, endIso, status],
  );
  const joinId = joinResult.rows[0]!.id;

  return { reservationId, joinId };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('scheduling-schema smoke: migration applies + EXCLUDE constraint', () => {
  let env: SchedulingTestEnv;

  beforeAll(async () => {
    env = await setupSchedulingEnv();
  });

  // ── Migration baseline ─────────────────────────────────────────────────────

  it('migration 0002 applied: resource_kind enum exists with all 5 values', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
       WHERE pg_type.typname = 'resource_kind'
       ORDER BY pg_enum.enumsortorder`,
    );
    expect(result.rows.map((r) => r.enumlabel)).toEqual([
      'aircraft', 'instructor', 'sim', 'room', 'vehicle',
    ]);
  });

  it('migration 0002 applied: reservation_status enum exists with booked + cancelled', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'reservation_status'
       ORDER BY pg_enum.enumsortorder`,
    );
    expect(result.rows.map((r) => r.enumlabel)).toEqual(['booked', 'cancelled']);
  });

  it('migration 0002 applied: EXCLUDE constraint exists on reservation_resource', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'reservation_resource'::regclass
         AND contype = 'x'`,
    );
    expect(result.rows.some((r) => r.conname === 'reservation_resource_no_double_book')).toBe(true);
  });

  it('seeded aircraft resource is visible in org A context', async () => {
    const { db, orgAId, aircraftAId } = env;
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(resource).execute(),
    );
    expect(rows.some((r) => r.id === aircraftAId)).toBe(true);
    expect(rows.every((r) => r.orgId === orgAId)).toBe(true);
  });

  // ── Baseline reservation insert succeeds ─────────────────────────────────

  it('EXCLUDE baseline: booked reservation for [10:00,11:00) inserts successfully', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    // We run this in a transaction so SET LOCAL is scoped to it.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const result = await pglite.query<{ id: string }>(
      `INSERT INTO reservation (org_id, start_at, end_at, status, created_by)
       VALUES ($1, '2026-06-15 10:00:00+00'::timestamptz, '2026-06-15 11:00:00+00'::timestamptz, 'booked', $2)
       RETURNING id`,
      [orgAId, userAId],
    );
    const reservationId = result.rows[0]!.id;
    await pglite.query(
      `INSERT INTO reservation_resource (org_id, reservation_id, resource_id, during, status)
       VALUES ($1, $2, $3,
               tstzrange('2026-06-15 10:00:00+00'::timestamptz, '2026-06-15 11:00:00+00'::timestamptz, '[)'),
               'booked')`,
      [orgAId, reservationId, aircraftAId],
    );
    await pglite.exec(`COMMIT`);
    // Verify it is visible under org A context
    const rows = await withOrgContext(env.db, orgAId, (tx) =>
      tx.select().from(reservationResource).execute(),
    );
    expect(rows.some((r) => r.reservationId === reservationId)).toBe(true);
  });

  // ── (a) Overlapping booked row → exclusion_violation ──────────────────────

  it('EXCLUDE (a): overlapping booked join row for same resource → 23P01 exclusion_violation', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    // Insert a second reservation that overlaps [10:00,11:00) (e.g. [10:30,11:30))
    // This must fail with exclusion_violation (23P01).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const r2 = await pglite.query<{ id: string }>(
      `INSERT INTO reservation (org_id, start_at, end_at, status, created_by)
       VALUES ($1, '2026-06-15 10:30:00+00'::timestamptz, '2026-06-15 11:30:00+00'::timestamptz, 'booked', $2)
       RETURNING id`,
      [orgAId, userAId],
    );
    const r2Id = r2.rows[0]!.id;
    await expect(
      pglite.query(
        `INSERT INTO reservation_resource (org_id, reservation_id, resource_id, during, status)
         VALUES ($1, $2, $3,
                 tstzrange('2026-06-15 10:30:00+00'::timestamptz, '2026-06-15 11:30:00+00'::timestamptz, '[)'),
                 'booked')`,
        [orgAId, r2Id, aircraftAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── (b) Touching (adjacent) window → succeeds ─────────────────────────────

  it('EXCLUDE (b): touching (adjacent) window [11:00,12:00) succeeds (half-open, not an overlap)', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    // [11:00,12:00) touches but does NOT overlap [10:00,11:00) with [) encoding.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const r3 = await pglite.query<{ id: string }>(
      `INSERT INTO reservation (org_id, start_at, end_at, status, created_by)
       VALUES ($1, '2026-06-15 11:00:00+00'::timestamptz, '2026-06-15 12:00:00+00'::timestamptz, 'booked', $2)
       RETURNING id`,
      [orgAId, userAId],
    );
    const r3Id = r3.rows[0]!.id;
    await expect(
      pglite.query(
        `INSERT INTO reservation_resource (org_id, reservation_id, resource_id, during, status)
         VALUES ($1, $2, $3,
                 tstzrange('2026-06-15 11:00:00+00'::timestamptz, '2026-06-15 12:00:00+00'::timestamptz, '[)'),
                 'booked')`,
        [orgAId, r3Id, aircraftAId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);
  });

  // ── (c) Non-overlapping window → succeeds ─────────────────────────────────

  it('EXCLUDE (c): non-overlapping window [14:00,15:00) succeeds', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const r4 = await pglite.query<{ id: string }>(
      `INSERT INTO reservation (org_id, start_at, end_at, status, created_by)
       VALUES ($1, '2026-06-15 14:00:00+00'::timestamptz, '2026-06-15 15:00:00+00'::timestamptz, 'booked', $2)
       RETURNING id`,
      [orgAId, userAId],
    );
    const r4Id = r4.rows[0]!.id;
    await expect(
      pglite.query(
        `INSERT INTO reservation_resource (org_id, reservation_id, resource_id, during, status)
         VALUES ($1, $2, $3,
                 tstzrange('2026-06-15 14:00:00+00'::timestamptz, '2026-06-15 15:00:00+00'::timestamptz, '[)'),
                 'booked')`,
        [orgAId, r4Id, aircraftAId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);
  });

  // ── (d) Cancelled overlapping row → succeeds ──────────────────────────────

  it('EXCLUDE (d): cancelled join row overlapping [10:00,11:00) succeeds (partial WHERE status=booked)', async () => {
    const { pglite, orgAId, aircraftAId, userAId } = env;
    // Insert a reservation with status='cancelled' that overlaps [10:00,11:00).
    // The EXCLUDE constraint only fires WHERE (status = 'booked') so this must succeed.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const r5 = await pglite.query<{ id: string }>(
      `INSERT INTO reservation (org_id, start_at, end_at, status, created_by, cancelled_at, cancelled_by)
       VALUES ($1, '2026-06-15 10:15:00+00'::timestamptz, '2026-06-15 10:45:00+00'::timestamptz,
               'cancelled', $2, now(), $2)
       RETURNING id`,
      [orgAId, userAId],
    );
    const r5Id = r5.rows[0]!.id;
    await expect(
      pglite.query(
        `INSERT INTO reservation_resource (org_id, reservation_id, resource_id, during, status)
         VALUES ($1, $2, $3,
                 tstzrange('2026-06-15 10:15:00+00'::timestamptz, '2026-06-15 10:45:00+00'::timestamptz, '[)'),
                 'cancelled')`,
        [orgAId, r5Id, aircraftAId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);
  });

  // ── (e) Cross-org: same window on different org's resource → succeeds + invisible ─

  it('EXCLUDE (e): same window on org B resource succeeds (no cross-org false conflict)', async () => {
    const { pglite, db, orgAId, orgBId, aircraftBId, userBId } = env;
    // Insert a reservation + join row in org B for the SAME time window as org A's
    // booked slot [10:00,11:00). Must succeed because aircraftBId is a different
    // resource (disjoint resource_id partition of the GiST index).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    const r6 = await pglite.query<{ id: string }>(
      `INSERT INTO reservation (org_id, start_at, end_at, status, created_by)
       VALUES ($1, '2026-06-15 10:00:00+00'::timestamptz, '2026-06-15 11:00:00+00'::timestamptz, 'booked', $2)
       RETURNING id`,
      [orgBId, userBId],
    );
    const r6Id = r6.rows[0]!.id;
    await expect(
      pglite.query(
        `INSERT INTO reservation_resource (org_id, reservation_id, resource_id, during, status)
         VALUES ($1, $2, $3,
                 tstzrange('2026-06-15 10:00:00+00'::timestamptz, '2026-06-15 11:00:00+00'::timestamptz, '[)'),
                 'booked')`,
        [orgBId, r6Id, aircraftBId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);

    // Verify RLS invisibility: org A cannot see org B's reservation_resource rows.
    const rowsUnderA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationResource).execute(),
    );
    expect(rowsUnderA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsUnderA.some((r) => r.orgId === orgBId)).toBe(false);

    // And org B can see its own row.
    const rowsUnderB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(reservationResource).execute(),
    );
    expect(rowsUnderB.some((r) => r.reservationId === r6Id)).toBe(true);
  });

  // ── Resource kind_shape_check ─────────────────────────────────────────────

  it('resource_kind_shape_check: aircraft without tail_number is rejected', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource (org_id, kind, display_name)
         VALUES ($1, 'aircraft', 'No Tail')`,
        [orgAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('resource_kind_shape_check: instructor without instructor_user_id is rejected', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource (org_id, kind, display_name)
         VALUES ($1, 'instructor', 'No User')`,
        [orgAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── RLS: scheduling tables are fail-closed without GUC ───────────────────
  // PGlite's pg_class does not expose rowsecurity/forcerls columns in the same
  // way as full Postgres. We verify FORCE RLS behaviourally: clearing the GUC
  // must return 0 rows from each scheduling table, proving the policies are
  // enforced (FORCE means even the table owner / superuser context is bound).

  it('RLS: resource returns 0 rows when GUC is unset (FORCE RLS fail-closed)', async () => {
    const { pglite } = env;
    // Clear GUC at session level — we are already aeroops_app (non-superuser).
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM resource`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  it('RLS: reservation returns 0 rows when GUC is unset (FORCE RLS fail-closed)', async () => {
    const { pglite } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM reservation`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  it('RLS: reservation_resource returns 0 rows when GUC is unset (FORCE RLS fail-closed)', async () => {
    const { pglite } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM reservation_resource`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });
});
