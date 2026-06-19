/**
 * booking-policies-schema.test.ts — Smoke + constraint tests for 0003_booking_policies.sql.
 *
 * Proves that:
 *   1. Migration 0003 applies cleanly on PGlite atop 0000+0001+0002.
 *   2. booking_policy UNIQUE(resource_id) rejects a second policy for the same resource.
 *   3. Int CHECK constraints reject 0 / -1 for max_duration_minutes;
 *      reject -1 for max_advance_days and min_advance_minutes (0 is valid there).
 *   4. Composite FK on booking_policy rejects a resource_id belonging to a different org.
 *   5. resource_blackout CHECK (during_nonempty) rejects empty and inverted ranges.
 *   6. Composite FK (resource_id,org_id) on resource_blackout rejects cross-org resource.
 *   7. Composite FK (created_by,org_id) on resource_blackout rejects cross-org user.
 *   8. RLS fail-closed: both tables return 0 rows when the GUC is unset.
 *   9. RLS isolation: org A cannot see org B rows in either new table.
 *
 * This is a SMOKE + CONSTRAINT test only. Property-based policy-evaluation
 * tests live in @aeroops/core (policy.test.ts). The API persistence layer
 * (scheduling-engineer) is NOT tested here.
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies all four real
 * migration artifacts in order so the constraint SQL validated here is the
 * exact production artifact.
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
import { org, appUser, resource, bookingPolicy, resourceBlackout } from '../schema/index.js';
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
];

// ── Test environment ──────────────────────────────────────────────────────────

interface BookingPoliciesTestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
  resourceAId: string;  // aircraft in org A
  resourceBId: string;  // aircraft in org B (cross-org probe)
}

async function setupBookingPoliciesEnv(): Promise<BookingPoliciesTestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  // Seed as superuser (before setTestAppRole) so RLS allows cross-context inserts.
  // All inserts go through withOrgContext / withPlatformAdminContext to exercise
  // the RLS WITH CHECK policies even at superuser.

  // Create two orgs under platform-admin context.
  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha School', slug: 'alpha-bp' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta Club', slug: 'beta-bp' })
      .returning();
    return [a[0]!, b[0]!];
  });

  // Create one user + aircraft resource in org A.
  const [userA, resourceA] = await withOrgContext(db, orgA.id, async (tx) => {
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

  // Create one user + aircraft resource in org B (for cross-org probes).
  const [userB, resourceB] = await withOrgContext(db, orgB.id, async (tx) => {
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
    resourceAId: resourceA.id,
    resourceBId: resourceB.id,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('booking-policies-schema smoke: migration 0003 + constraints + RLS', () => {
  let env: BookingPoliciesTestEnv;

  beforeAll(async () => {
    env = await setupBookingPoliciesEnv();
  });

  // ── Migration baseline ─────────────────────────────────────────────────────

  it('0003 applied: booking_policy table exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'booking_policy'
       ) AS exists`,
    );
    expect(result.rows[0]!.exists).toBe(true);
  });

  it('0003 applied: resource_blackout table exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'resource_blackout'
       ) AS exists`,
    );
    expect(result.rows[0]!.exists).toBe(true);
  });

  it('0003 applied: booking_policy_resource_id_unique constraint exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'booking_policy'::regclass
         AND contype = 'u'
         AND conname = 'booking_policy_resource_id_unique'`,
    );
    expect(result.rows.length).toBe(1);
  });

  it('0003 applied: resource_blackout_during_nonempty check constraint exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'resource_blackout'::regclass
         AND contype = 'c'
         AND conname = 'resource_blackout_during_nonempty'`,
    );
    expect(result.rows.length).toBe(1);
  });

  // ── booking_policy: UNIQUE(resource_id) ───────────────────────────────────

  it('booking_policy: inserting one policy for a resource succeeds', async () => {
    const { pglite, orgAId, resourceAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO booking_policy (org_id, resource_id, max_duration_minutes)
         VALUES ($1, $2, 60)`,
        [orgAId, resourceAId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);
  });

  it('booking_policy: UNIQUE(resource_id) rejects a second policy for the same resource', async () => {
    const { pglite, orgAId, resourceAId } = env;
    // A policy for resourceAId was already inserted in the previous test.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO booking_policy (org_id, resource_id, max_duration_minutes)
         VALUES ($1, $2, 120)`,
        [orgAId, resourceAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── booking_policy: int CHECK constraints ─────────────────────────────────

  it('booking_policy: max_duration_minutes = 0 is rejected (CHECK > 0)', async () => {
    const { pglite, orgAId } = env;
    // Insert a fresh resource for this test to avoid UNIQUE conflict.
    // Run as superuser (before setTestAppRole on this specific resource insert)
    // — but we are already aeroops_app. Use pglite raw SQL with SET LOCAL.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    // Create a fresh aircraft resource to use in constraint tests.
    const r = await pglite.query<{ id: string }>(
      `INSERT INTO resource (org_id, kind, display_name, tail_number)
       VALUES ($1, 'aircraft', 'Piper Archer N00001', 'N00001')
       RETURNING id`,
      [orgAId],
    );
    const freshResourceId = r.rows[0]!.id;
    await expect(
      pglite.query(
        `INSERT INTO booking_policy (org_id, resource_id, max_duration_minutes)
         VALUES ($1, $2, 0)`,
        [orgAId, freshResourceId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('booking_policy: max_duration_minutes = -1 is rejected (CHECK > 0)', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const r = await pglite.query<{ id: string }>(
      `INSERT INTO resource (org_id, kind, display_name, tail_number)
       VALUES ($1, 'aircraft', 'Piper Archer N00002', 'N00002')
       RETURNING id`,
      [orgAId],
    );
    const freshResourceId = r.rows[0]!.id;
    await expect(
      pglite.query(
        `INSERT INTO booking_policy (org_id, resource_id, max_duration_minutes)
         VALUES ($1, $2, -1)`,
        [orgAId, freshResourceId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('booking_policy: max_advance_days = -1 is rejected (CHECK >= 0)', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const r = await pglite.query<{ id: string }>(
      `INSERT INTO resource (org_id, kind, display_name, tail_number)
       VALUES ($1, 'aircraft', 'Piper Archer N00003', 'N00003')
       RETURNING id`,
      [orgAId],
    );
    const freshResourceId = r.rows[0]!.id;
    await expect(
      pglite.query(
        `INSERT INTO booking_policy (org_id, resource_id, max_advance_days)
         VALUES ($1, $2, -1)`,
        [orgAId, freshResourceId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('booking_policy: max_advance_days = 0 is accepted (CHECK >= 0; 0 = same-day only)', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const r = await pglite.query<{ id: string }>(
      `INSERT INTO resource (org_id, kind, display_name, tail_number)
       VALUES ($1, 'aircraft', 'Piper Archer N00004', 'N00004')
       RETURNING id`,
      [orgAId],
    );
    const freshResourceId = r.rows[0]!.id;
    await expect(
      pglite.query(
        `INSERT INTO booking_policy (org_id, resource_id, max_advance_days)
         VALUES ($1, $2, 0)`,
        [orgAId, freshResourceId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);
  });

  it('booking_policy: min_advance_minutes = -1 is rejected (CHECK >= 0)', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const r = await pglite.query<{ id: string }>(
      `INSERT INTO resource (org_id, kind, display_name, tail_number)
       VALUES ($1, 'aircraft', 'Piper Archer N00005', 'N00005')
       RETURNING id`,
      [orgAId],
    );
    const freshResourceId = r.rows[0]!.id;
    await expect(
      pglite.query(
        `INSERT INTO booking_policy (org_id, resource_id, min_advance_minutes)
         VALUES ($1, $2, -1)`,
        [orgAId, freshResourceId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('booking_policy: min_advance_minutes = 0 is accepted (CHECK >= 0; 0 = instant booking)', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const r = await pglite.query<{ id: string }>(
      `INSERT INTO resource (org_id, kind, display_name, tail_number)
       VALUES ($1, 'aircraft', 'Piper Archer N00006', 'N00006')
       RETURNING id`,
      [orgAId],
    );
    const freshResourceId = r.rows[0]!.id;
    await expect(
      pglite.query(
        `INSERT INTO booking_policy (org_id, resource_id, min_advance_minutes)
         VALUES ($1, $2, 0)`,
        [orgAId, freshResourceId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);
  });

  // ── booking_policy: composite FK rejects cross-org resource_id ────────────

  it('booking_policy: composite FK rejects resource_id from a different org', async () => {
    const { pglite, orgAId, resourceBId } = env;
    // Attempt to insert a booking_policy for org A but using org B's resource_id.
    // The composite FK (resource_id, org_id) → resource(id, org_id) must reject this.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO booking_policy (org_id, resource_id, max_duration_minutes)
         VALUES ($1, $2, 90)`,
        [orgAId, resourceBId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── resource_blackout: CHECK rejects empty/inverted ranges ────────────────

  it('resource_blackout: during_nonempty check rejects equal start=end (empty range)', async () => {
    const { pglite, orgAId, resourceAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource_blackout (org_id, resource_id, during, created_by)
         VALUES ($1, $2,
                 tstzrange('2026-07-01 10:00:00+00'::timestamptz,
                           '2026-07-01 10:00:00+00'::timestamptz, '[)'),
                 $3)`,
        [orgAId, resourceAId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('resource_blackout: during_nonempty check rejects inverted range (end < start)', async () => {
    const { pglite, orgAId, resourceAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource_blackout (org_id, resource_id, during, created_by)
         VALUES ($1, $2,
                 tstzrange('2026-07-01 12:00:00+00'::timestamptz,
                           '2026-07-01 10:00:00+00'::timestamptz, '[)'),
                 $3)`,
        [orgAId, resourceAId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('resource_blackout: valid range inserts successfully', async () => {
    const { pglite, orgAId, resourceAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource_blackout (org_id, resource_id, during, created_by, reason)
         VALUES ($1, $2,
                 tstzrange('2026-07-04 00:00:00+00'::timestamptz,
                           '2026-07-05 00:00:00+00'::timestamptz, '[)'),
                 $3, 'Independence Day closure')`,
        [orgAId, resourceAId, userAId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);
  });

  // ── resource_blackout: composite FK rejects cross-org resource_id ─────────

  it('resource_blackout: composite FK (resource_id,org_id) rejects cross-org resource', async () => {
    const { pglite, orgAId, resourceBId, userAId } = env;
    // org A tries to blackout org B's resource — composite FK must reject.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource_blackout (org_id, resource_id, during, created_by)
         VALUES ($1, $2,
                 tstzrange('2026-07-04 00:00:00+00'::timestamptz,
                           '2026-07-05 00:00:00+00'::timestamptz, '[)'),
                 $3)`,
        [orgAId, resourceBId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── resource_blackout: composite FK rejects cross-org created_by ──────────

  it('resource_blackout: composite FK (created_by,org_id) rejects cross-org user', async () => {
    const { pglite, orgAId, resourceAId, userBId } = env;
    // org A resource, but org B's user as created_by — composite FK must reject.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource_blackout (org_id, resource_id, during, created_by)
         VALUES ($1, $2,
                 tstzrange('2026-07-10 00:00:00+00'::timestamptz,
                           '2026-07-11 00:00:00+00'::timestamptz, '[)'),
                 $3)`,
        [orgAId, resourceAId, userBId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── RLS: fail-closed (GUC unset → 0 rows on both tables) ─────────────────

  it('RLS: booking_policy returns 0 rows when GUC is unset (FORCE RLS fail-closed)', async () => {
    const { pglite } = env;
    // We already have at least one booking_policy row seeded above.
    // Clear GUC — must see 0 rows (fail-closed).
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM booking_policy`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  it('RLS: resource_blackout returns 0 rows when GUC is unset (FORCE RLS fail-closed)', async () => {
    const { pglite } = env;
    // We already have at least one resource_blackout row seeded above.
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM resource_blackout`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  // ── RLS: isolation (org A cannot see org B rows) ──────────────────────────

  it('RLS isolation: org A cannot see org B booking_policy rows', async () => {
    const { db, pglite, orgAId, orgBId, resourceBId } = env;

    // First, seed a policy for org B's resource (as superuser-equivalent via raw SQL).
    // We need to temporarily be able to INSERT for org B; use SET LOCAL in a transaction.
    await pglite.exec(`SET ROLE postgres`); // escalate back to seed
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await pglite.query(
      `INSERT INTO booking_policy (org_id, resource_id, max_duration_minutes)
       VALUES ($1, $2, 120)`,
      [orgBId, resourceBId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`); // drop back to app role

    // Org A context — should see org A's own policy but NOT org B's.
    const rowsA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(bookingPolicy).execute(),
    );
    expect(rowsA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context — should see org B's policy.
    const rowsB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(bookingPolicy).execute(),
    );
    expect(rowsB.some((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  it('RLS isolation: org A cannot see org B resource_blackout rows', async () => {
    const { db, pglite, orgAId, orgBId, resourceBId, userBId } = env;

    // Seed a blackout for org B's resource.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await pglite.query(
      `INSERT INTO resource_blackout (org_id, resource_id, during, created_by)
       VALUES ($1, $2,
               tstzrange('2026-08-01 00:00:00+00'::timestamptz,
                         '2026-08-02 00:00:00+00'::timestamptz, '[)'),
               $3)`,
      [orgBId, resourceBId, userBId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Org A context — should see only org A's blackouts.
    const rowsA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(resourceBlackout).execute(),
    );
    expect(rowsA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context — should see org B's blackout.
    const rowsB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(resourceBlackout).execute(),
    );
    expect(rowsB.some((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsB.some((r) => r.orgId === orgAId)).toBe(false);
  });
});
