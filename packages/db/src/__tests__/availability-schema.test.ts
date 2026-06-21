/**
 * availability-schema.test.ts — Schema tests for 0014_availability.sql (Slice AV1.1).
 *
 * Proves spec §AV1.1 schema acceptance criteria:
 *
 *   AV1.  resource_availability_window table exists after migration 0014.
 *   AV2.  dispatch_config has the two new availability columns after migration 0014.
 *   AV3.  FORCE RLS fail-closed: GUC unset → 0 rows from resource_availability_window.
 *   AV4.  RLS isolation: org A cannot see org B's resource_availability_window rows.
 *   AV5.  Composite FK cross-org rejection:
 *         AV5a. resource_id from a different org → rejected.
 *         AV5b. created_by from a different org → rejected.
 *   AV6.  ON DELETE RESTRICT: deleting a resource with window rows is blocked.
 *         ON DELETE RESTRICT: deleting created_by user with window rows is blocked.
 *   AV7.  CHECKs fire:
 *         AV7a. day_of_week = 0 (below range) → rejected.
 *         AV7b. day_of_week = 8 (above range) → rejected.
 *         AV7c. day_of_week boundary: 1 → accepted; 7 → accepted.
 *         AV7d. start_minute = -1 (below range) → rejected.
 *         AV7e. start_minute = 1440 (above max 1439) → rejected.
 *         AV7f. start_minute boundaries: 0 → accepted; 1439 → accepted.
 *         AV7g. end_minute = 0 (below min 1) → rejected.
 *         AV7h. end_minute = 1441 (above max 1440) → rejected.
 *         AV7i. end_minute <= start_minute (no-wrap guard: equal) → rejected.
 *         AV7j. end_minute < start_minute (no-wrap guard: below) → rejected.
 *         AV7k. end_minute = 1440 (midnight next day) with start_minute=0 → accepted.
 *   AV8.  UNIQUE(id, org_id): composite candidate key index exists.
 *   AV9.  Natural-key UNIQUE(resource_id, day_of_week, start_minute, end_minute):
 *         AV9a. duplicate row → rejected (23505).
 *         AV9b. same window on a different resource → accepted.
 *   AV10. dispatch_config new columns:
 *         AV10a. availability_constraint_enabled defaults to false.
 *         AV10b. availability_mode defaults to 'warn'.
 *         AV10c. availability_mode CHECK rejects unknown value.
 *         AV10d. availability_mode 'block' accepted.
 *         AV10e. dispatch_config insert omitting new columns still succeeds (additive).
 *   AV11. Happy-path round-trip: window inserts and reads back correctly.
 *   AV12. Down migration reverses 0014:
 *         AV12a. resource_availability_window table gone.
 *         AV12b. dispatch_config.availability_constraint_enabled column gone.
 *         AV12c. dispatch_config.availability_mode column gone.
 *         AV12d. availability_mode CHECK constraint gone.
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies all 15 real
 * migration artifacts (0000–0014) in order so the constraint SQL validated
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
import { org, appUser, resource, dispatchConfig, resourceAvailabilityWindow } from '../schema/index.js';
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

const DOWN_0014 = readFileSync(
  resolve(__dirname, '../../migrations/0014_availability.down.sql'),
  'utf-8',
);

// ── Test environment ──────────────────────────────────────────────────────────

interface AvailabilitySchemaEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;    // member of org A
  userBId: string;    // member of org B
  aircraftAId: string; // resource (kind='aircraft') in org A
  aircraftA2Id: string; // second resource in org A
  aircraftBId: string; // resource (kind='aircraft') in org B
}

async function setupAvailabilityEnv(): Promise<AvailabilitySchemaEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha Flight School', slug: 'alpha-av' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta Aero Club', slug: 'beta-av' })
      .returning();
    return [a[0]!, b[0]!];
  });

  const [userA, aircraftA, aircraftA2] = await withOrgContext(db, orgA.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'alice@alpha-av.example', fullName: 'Alice AV' })
      .returning();
    const r1 = await tx
      .insert(resource)
      .values({
        orgId: orgA.id,
        kind: 'aircraft',
        displayName: 'Cessna 172 N11111',
        tailNumber: 'N11111',
      })
      .returning();
    const r2 = await tx
      .insert(resource)
      .values({
        orgId: orgA.id,
        kind: 'aircraft',
        displayName: 'Piper PA-28 N33333',
        tailNumber: 'N33333',
      })
      .returning();
    return [u[0]!, r1[0]!, r2[0]!];
  });

  const [userB, aircraftB] = await withOrgContext(db, orgB.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgB.id, email: 'bob@beta-av.example', fullName: 'Bob AV' })
      .returning();
    const r = await tx
      .insert(resource)
      .values({
        orgId: orgB.id,
        kind: 'aircraft',
        displayName: 'Diamond DA20 N22222',
        tailNumber: 'N22222',
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
    aircraftA2Id: aircraftA2.id,
    aircraftBId: aircraftB.id,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function insertWindow(
  pglite: PGlite,
  orgId: string,
  resourceId: string,
  createdBy: string,
  opts: {
    dayOfWeek?: number;
    startMinute?: number;
    endMinute?: number;
    tz?: string;
  } = {},
): Promise<string> {
  const r = await pglite.query<{ id: string }>(
    `INSERT INTO resource_availability_window
       (org_id, resource_id, created_by, day_of_week, start_minute, end_minute, tz)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      orgId,
      resourceId,
      createdBy,
      opts.dayOfWeek ?? 1,       // Monday
      opts.startMinute ?? 480,   // 08:00
      opts.endMinute ?? 1020,    // 17:00
      opts.tz ?? 'America/New_York',
    ],
  );
  return r.rows[0]!.id;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('availability-schema: migration 0014 + constraints + RLS', () => {
  let env: AvailabilitySchemaEnv;

  beforeAll(async () => {
    env = await setupAvailabilityEnv();
  });

  // ── AV1: Table exists after migration 0014 ───────────────────────────────────

  it('AV1: resource_availability_window table exists after migration 0014', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'resource_availability_window'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  // ── AV2: dispatch_config has new columns ─────────────────────────────────────

  it('AV2a: dispatch_config.availability_constraint_enabled column exists', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'availability_constraint_enabled'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  it('AV2b: dispatch_config.availability_mode column exists', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'availability_mode'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  // ── AV3: FORCE RLS fail-closed (GUC unset → 0 rows) ─────────────────────────

  it('AV3: FORCE RLS fail-closed — GUC unset → 0 rows from resource_availability_window', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;

    // Seed one row first (superuser).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertWindow(pglite, orgAId, aircraftAId, userAId, { dayOfWeek: 2 });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Unset GUC → 0 rows (fail-closed).
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const r = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM resource_availability_window`,
    );
    expect(r.rows[0]!.count).toBe('0');
  });

  // ── AV4: RLS isolation (org A cannot see org B rows) ─────────────────────────

  it('AV4: RLS isolation — org A cannot see org B resource_availability_window rows', async () => {
    const { pglite, db, orgAId, orgBId, userAId, userBId, aircraftAId, aircraftBId } = env;

    // Seed one window in each org (superuser).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertWindow(pglite, orgBId, aircraftBId, userBId, { dayOfWeek: 3 });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Org A context → only org A rows.
    const rowsA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(resourceAvailabilityWindow).execute(),
    );
    expect(rowsA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context → only org B rows.
    const rowsB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(resourceAvailabilityWindow).execute(),
    );
    expect(rowsB.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  // ── AV5: Composite FK cross-org rejection ────────────────────────────────────

  it('AV5a: resource_id from a different org → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftBId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertWindow(pglite, orgAId, aircraftBId, userAId, { dayOfWeek: 4 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('AV5b: created_by from a different org → rejected', async () => {
    const { pglite, orgAId, aircraftAId, userBId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertWindow(pglite, orgAId, aircraftAId, userBId, { dayOfWeek: 4 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── AV6: ON DELETE RESTRICT ───────────────────────────────────────────────────

  it('AV6a: deleting a resource with window rows is blocked (RESTRICT)', async () => {
    const { pglite, orgBId, userBId, aircraftBId } = env;

    // Seed a window on aircraftB in orgB (already seeded in AV4; create fresh one).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertWindow(pglite, orgBId, aircraftBId, userBId, { dayOfWeek: 5 });
    await pglite.exec(`COMMIT`);

    // Attempt to hard-delete the aircraft → must fail (RESTRICT).
    await expect(
      pglite.query(`DELETE FROM resource WHERE id = $1`, [aircraftBId]),
    ).rejects.toThrow();
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('AV6b: deleting created_by user with window rows is blocked (RESTRICT)', async () => {
    const { pglite, orgAId, aircraftAId } = env;

    // Create a throwaway user and window.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const uResult = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`,
      [orgAId, 'throwaway-av@alpha-av.example', 'Throwaway AV'],
    );
    const throwUserId = uResult.rows[0]!.id;
    await insertWindow(pglite, orgAId, aircraftAId, throwUserId, { dayOfWeek: 6 });
    await pglite.exec(`COMMIT`);

    // Attempt to hard-delete the user → must fail (RESTRICT; they authored a window).
    await expect(
      pglite.query(`DELETE FROM app_user WHERE id = $1`, [throwUserId]),
    ).rejects.toThrow();
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── AV7: CHECKs fire ─────────────────────────────────────────────────────────

  it('AV7a: day_of_week = 0 (below range) → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertWindow(pglite, orgAId, aircraftAId, userAId, { dayOfWeek: 0 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('AV7b: day_of_week = 8 (above range) → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertWindow(pglite, orgAId, aircraftAId, userAId, { dayOfWeek: 8 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('AV7c: day_of_week boundaries: 1 → accepted; 7 → accepted', async () => {
    const { pglite, orgAId, userAId, aircraftA2Id } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    // day=1 (Mon)
    const r1 = await pglite.query<{ id: string }>(
      `INSERT INTO resource_availability_window
         (org_id, resource_id, created_by, day_of_week, start_minute, end_minute, tz)
       VALUES ($1, $2, $3, 1, 0, 60, 'UTC') RETURNING id`,
      [orgAId, aircraftA2Id, userAId],
    );
    // day=7 (Sun) — different start/end to avoid natural-key collision
    const r2 = await pglite.query<{ id: string }>(
      `INSERT INTO resource_availability_window
         (org_id, resource_id, created_by, day_of_week, start_minute, end_minute, tz)
       VALUES ($1, $2, $3, 7, 60, 120, 'UTC') RETURNING id`,
      [orgAId, aircraftA2Id, userAId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(r1.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r2.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('AV7d: start_minute = -1 (below range) → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertWindow(pglite, orgAId, aircraftAId, userAId, { dayOfWeek: 1, startMinute: -1, endMinute: 60 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('AV7e: start_minute = 1440 (above max 1439) → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      // end_minute=1441 to satisfy end>start, but start itself is out of range
      insertWindow(pglite, orgAId, aircraftAId, userAId, { dayOfWeek: 1, startMinute: 1440, endMinute: 1441 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('AV7f: start_minute boundaries: 0 → accepted; 1439 → accepted', async () => {
    const { pglite, orgAId, userAId, aircraftA2Id } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    // start=0, end=1 (both at boundary; different day from AV7c rows)
    const r1 = await pglite.query<{ id: string }>(
      `INSERT INTO resource_availability_window
         (org_id, resource_id, created_by, day_of_week, start_minute, end_minute, tz)
       VALUES ($1, $2, $3, 2, 0, 1, 'UTC') RETURNING id`,
      [orgAId, aircraftA2Id, userAId],
    );
    // start=1439, end=1440
    const r2 = await pglite.query<{ id: string }>(
      `INSERT INTO resource_availability_window
         (org_id, resource_id, created_by, day_of_week, start_minute, end_minute, tz)
       VALUES ($1, $2, $3, 2, 1439, 1440, 'UTC') RETURNING id`,
      [orgAId, aircraftA2Id, userAId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(r1.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r2.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('AV7g: end_minute = 0 (below min 1) → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    // start=0, end=0 — violates end>=1 AND end>start
    await expect(
      pglite.query(
        `INSERT INTO resource_availability_window
           (org_id, resource_id, created_by, day_of_week, start_minute, end_minute, tz)
         VALUES ($1, $2, $3, 3, 0, 0, 'UTC')`,
        [orgAId, aircraftAId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('AV7h: end_minute = 1441 (above max 1440) → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource_availability_window
           (org_id, resource_id, created_by, day_of_week, start_minute, end_minute, tz)
         VALUES ($1, $2, $3, 3, 0, 1441, 'UTC')`,
        [orgAId, aircraftAId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('AV7i: end_minute = start_minute (no-wrap guard: equal) → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource_availability_window
           (org_id, resource_id, created_by, day_of_week, start_minute, end_minute, tz)
         VALUES ($1, $2, $3, 3, 480, 480, 'UTC')`,
        [orgAId, aircraftAId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('AV7j: end_minute < start_minute (no-wrap guard: below) → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    // start=600 (10:00), end=480 (08:00) — would be overnight if allowed
    await expect(
      pglite.query(
        `INSERT INTO resource_availability_window
           (org_id, resource_id, created_by, day_of_week, start_minute, end_minute, tz)
         VALUES ($1, $2, $3, 3, 600, 480, 'UTC')`,
        [orgAId, aircraftAId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('AV7k: end_minute = 1440 with start_minute = 0 → accepted (full-day window)', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const r = await pglite.query<{ id: string }>(
      `INSERT INTO resource_availability_window
         (org_id, resource_id, created_by, day_of_week, start_minute, end_minute, tz)
       VALUES ($1, $2, $3, 7, 0, 1440, 'America/Chicago') RETURNING id`,
      [orgAId, aircraftAId, userAId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(r.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── AV8: UNIQUE(id, org_id) composite candidate key index ────────────────────

  it('AV8: UNIQUE(id, org_id) index exists on resource_availability_window', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_indexes
         WHERE tablename = 'resource_availability_window'
           AND indexname = 'resource_availability_window_id_org_id_unique'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  // ── AV9: Natural-key UNIQUE ───────────────────────────────────────────────────

  it('AV9a: duplicate (resource_id, day_of_week, start_minute, end_minute) → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;

    // Insert once (superuser).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await pglite.query(
      `INSERT INTO resource_availability_window
         (org_id, resource_id, created_by, day_of_week, start_minute, end_minute, tz)
       VALUES ($1, $2, $3, 4, 300, 600, 'UTC')`,
      [orgAId, aircraftAId, userAId],
    );
    // Second insert with identical natural key → must fail (23505).
    await expect(
      pglite.query(
        `INSERT INTO resource_availability_window
           (org_id, resource_id, created_by, day_of_week, start_minute, end_minute, tz)
         VALUES ($1, $2, $3, 4, 300, 600, 'America/Denver')`,
        [orgAId, aircraftAId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('AV9b: same window on a different resource → accepted', async () => {
    const { pglite, orgAId, userAId, aircraftAId, aircraftA2Id } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    // Same (dow, start, end) but different resource_id → natural key is different → OK.
    const r = await pglite.query<{ id: string }>(
      `INSERT INTO resource_availability_window
         (org_id, resource_id, created_by, day_of_week, start_minute, end_minute, tz)
       VALUES ($1, $2, $3, 5, 540, 1020, 'UTC') RETURNING id`,
      [orgAId, aircraftA2Id, userAId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(r.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── AV10: dispatch_config new columns ────────────────────────────────────────

  it('AV10a: availability_constraint_enabled defaults to false', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('AV Default Enabled', 'av-default-enabled') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    const r = await pglite.query<{ availability_constraint_enabled: boolean }>(
      `INSERT INTO dispatch_config (org_id, eligibility_mode, balance_check_enabled)
       VALUES ($1, 'block', false)
       RETURNING availability_constraint_enabled`,
      [freshOrgId],
    );
    await pglite.exec(`COMMIT`);
    expect(r.rows[0]!.availability_constraint_enabled).toBe(false);
  });

  it('AV10b: availability_mode defaults to warn', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('AV Default Mode', 'av-default-mode') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    const r = await pglite.query<{ availability_mode: string }>(
      `INSERT INTO dispatch_config (org_id, eligibility_mode, balance_check_enabled)
       VALUES ($1, 'block', false)
       RETURNING availability_mode`,
      [freshOrgId],
    );
    await pglite.exec(`COMMIT`);
    expect(r.rows[0]!.availability_mode).toBe('warn');
  });

  it('AV10c: dispatch_config_availability_mode_check rejects unknown mode', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('AV Bad Mode', 'av-bad-mode') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    await expect(
      pglite.query(
        `INSERT INTO dispatch_config
           (org_id, eligibility_mode, balance_check_enabled, availability_mode)
         VALUES ($1, 'block', false, 'advisory')`,
        [freshOrgId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('AV10d: availability_mode block → accepted', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('AV Block Mode', 'av-block-mode') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    const r = await pglite.query<{ availability_mode: string }>(
      `INSERT INTO dispatch_config
         (org_id, eligibility_mode, balance_check_enabled, availability_mode)
       VALUES ($1, 'block', false, 'block')
       RETURNING availability_mode`,
      [freshOrgId],
    );
    await pglite.exec(`COMMIT`);
    expect(r.rows[0]!.availability_mode).toBe('block');
  });

  it('AV10e: dispatch_config insert omitting availability columns succeeds (additive)', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('AV Additive Org', 'av-additive-org') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    // Deliberately omit both availability columns — defaults must apply.
    const r = await pglite.query<{
      id: string;
      availability_constraint_enabled: boolean;
      availability_mode: string;
    }>(
      `INSERT INTO dispatch_config (org_id, eligibility_mode, balance_check_enabled)
       VALUES ($1, 'warn', false)
       RETURNING id, availability_constraint_enabled, availability_mode`,
      [freshOrgId],
    );
    await pglite.exec(`COMMIT`);
    expect(r.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.rows[0]!.availability_constraint_enabled).toBe(false);
    expect(r.rows[0]!.availability_mode).toBe('warn');
  });

  // ── AV11: Happy-path round-trip ───────────────────────────────────────────────

  it('AV11: window inserts and reads back correctly', async () => {
    const { pglite, db, orgAId, userAId, aircraftAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const winId = await insertWindow(pglite, orgAId, aircraftAId, userAId, {
      dayOfWeek: 1,
      startMinute: 480,  // 08:00
      endMinute: 1020,   // 17:00
      tz: 'America/Chicago',
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    const row = await pglite.query<{
      id: string;
      org_id: string;
      resource_id: string;
      day_of_week: number;
      start_minute: number;
      end_minute: number;
      tz: string;
      created_by: string;
    }>(
      `SELECT id, org_id, resource_id, day_of_week, start_minute, end_minute, tz, created_by
       FROM resource_availability_window WHERE id = $1`,
      [winId],
    );
    const r = row.rows[0]!;
    expect(r.id).toBe(winId);
    expect(r.org_id).toBe(orgAId);
    expect(r.resource_id).toBe(aircraftAId);
    expect(r.day_of_week).toBe(1);
    expect(r.start_minute).toBe(480);
    expect(r.end_minute).toBe(1020);
    expect(r.tz).toBe('America/Chicago');
    expect(r.created_by).toBe(userAId);
  });

  // ── AV12: Down migration reverses 0014 ───────────────────────────────────────

  it('AV12: down migration reverses 0014 — table and columns gone', async () => {
    // Spin up a separate isolated client for down-migration test.
    const { pglite: pg2 } = await createTestClient();
    await applyMigrationSql({ pglite: pg2 }, MIGRATION_SQL);

    // Verify table exists before down.
    const before = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'resource_availability_window'
       ) AS exists`,
    );
    expect(before.rows[0]!.exists).toBe(true);

    // Apply the down migration.
    await pg2.exec(DOWN_0014);

    // AV12a: table must be gone.
    const afterTable = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'resource_availability_window'
       ) AS exists`,
    );
    expect(afterTable.rows[0]!.exists).toBe(false);

    // AV12b: availability_constraint_enabled column must be gone.
    const afterEnabled = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'availability_constraint_enabled'
       ) AS exists`,
    );
    expect(afterEnabled.rows[0]!.exists).toBe(false);

    // AV12c: availability_mode column must be gone.
    const afterMode = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'availability_mode'
       ) AS exists`,
    );
    expect(afterMode.rows[0]!.exists).toBe(false);

    // AV12d: availability_mode CHECK constraint must be gone.
    const afterCheck = await pg2.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_constraint
       WHERE conname = 'dispatch_config_availability_mode_check'`,
    );
    expect(afterCheck.rows[0]!.count).toBe('0');
  });
});
