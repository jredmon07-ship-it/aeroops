/**
 * fleet-schema.test.ts — Schema tests for 0007_fleet.sql (Slice 5.1).
 *
 * Proves spec §5 T1–T7:
 *   T1. Additive columns exist with correct types/defaults after 0007:
 *       make (text), model (text), year (integer), serial_number (text),
 *       home_base_location_id (uuid), has_hobbs (boolean), has_tach (boolean).
 *   T2. Existing-style aircraft INSERT that omits all new columns succeeds
 *       (has_hobbs / has_tach default true; others null) — additive guarantee.
 *   T3. All existing resource_kind_shape_check cases still pass unchanged:
 *       aircraft/instructor/sim/room/vehicle.
 *   T4. resource_year_sane_check rejects 1899 and 2201; accepts null and 2025.
 *   T5. home_base_location_id composite FK:
 *       (a) Same-org location links OK.
 *       (b) Different-org location id is rejected.
 *       (c) Deleting the linked location SET-NULLs home_base_location_id
 *           and does NOT null org_id.
 *   T6. location_id_org_id_unique constraint exists on location table.
 *   T7. Down migration cleanly reverses: columns gone, location unique gone.
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies all eight real
 * migration artifacts (0000–0007) in order so constraint SQL validated here
 * is the exact production artifact. NEVER applied to a real DB.
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
import { org, appUser, resource, location } from '../schema/index.js';
import type { PgliteTestClient } from '../client.js';

// ── Path resolution ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_SQL_THROUGH_0007 = [
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
];

const DOWN_0007 = readFileSync(
  resolve(__dirname, '../../migrations/0007_fleet.down.sql'),
  'utf-8',
);

// ── Test environment ──────────────────────────────────────────────────────────

interface FleetTestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
  aircraftAId: string;
  locationAId: string;
  locationBId: string;
}

async function setupFleetEnv(): Promise<FleetTestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL_THROUGH_0007);

  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha School', slug: 'alpha-fleet' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta Club', slug: 'beta-fleet' })
      .returning();
    return [a[0]!, b[0]!];
  });

  const [userA, aircraftA, locationA] = await withOrgContext(db, orgA.id, async (tx) => {
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
    const loc = await tx
      .insert(location)
      .values({ orgId: orgA.id, name: 'Alpha Base', icao: 'KABC' })
      .returning();
    return [u[0]!, r[0]!, loc[0]!];
  });

  const [userB, locationB] = await withOrgContext(db, orgB.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgB.id, email: 'bob@beta.example', fullName: 'Bob B' })
      .returning();
    const loc = await tx
      .insert(location)
      .values({ orgId: orgB.id, name: 'Beta Base', icao: 'KXYZ' })
      .returning();
    return [u[0]!, loc[0]!];
  });

  await setTestAppRole({ pglite });

  return {
    db,
    pglite,
    orgAId: orgA.id,
    orgBId: orgB.id,
    userAId: userA.id,
    userBId: userB.id,
    aircraftAId: aircraftA.id,
    locationAId: locationA.id,
    locationBId: locationB.id,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('fleet-schema: migration 0007 + constraints + additive guarantee', () => {
  let env: FleetTestEnv;

  beforeAll(async () => {
    env = await setupFleetEnv();
  });

  // ── T1: additive columns exist with correct types/defaults ─────────────────

  it('T1: make column exists as text, nullable', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'resource' AND column_name = 'make'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.data_type).toBe('text');
    expect(result.rows[0]!.is_nullable).toBe('YES');
  });

  it('T1: model column exists as text, nullable', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'resource' AND column_name = 'model'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.data_type).toBe('text');
    expect(result.rows[0]!.is_nullable).toBe('YES');
  });

  it('T1: year column exists as integer, nullable', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'resource' AND column_name = 'year'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.data_type).toBe('integer');
    expect(result.rows[0]!.is_nullable).toBe('YES');
  });

  it('T1: serial_number column exists as text, nullable', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'resource' AND column_name = 'serial_number'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.data_type).toBe('text');
    expect(result.rows[0]!.is_nullable).toBe('YES');
  });

  it('T1: home_base_location_id column exists as uuid, nullable', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'resource' AND column_name = 'home_base_location_id'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.data_type).toBe('uuid');
    expect(result.rows[0]!.is_nullable).toBe('YES');
  });

  it('T1: has_hobbs column exists as boolean, NOT NULL, default true', async () => {
    const { pglite } = env;
    const result = await pglite.query<{
      data_type: string;
      is_nullable: string;
      column_default: string;
    }>(
      `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'resource' AND column_name = 'has_hobbs'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.data_type).toBe('boolean');
    expect(result.rows[0]!.is_nullable).toBe('NO');
    expect(result.rows[0]!.column_default).toBe('true');
  });

  it('T1: has_tach column exists as boolean, NOT NULL, default true', async () => {
    const { pglite } = env;
    const result = await pglite.query<{
      data_type: string;
      is_nullable: string;
      column_default: string;
    }>(
      `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'resource' AND column_name = 'has_tach'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.data_type).toBe('boolean');
    expect(result.rows[0]!.is_nullable).toBe('NO');
    expect(result.rows[0]!.column_default).toBe('true');
  });

  // ── T2: existing-style INSERT that omits all new columns succeeds ──────────

  it('T2: aircraft INSERT omitting all new columns succeeds; has_hobbs=true, has_tach=true, others null', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const result = await pglite.query<{
      id: string;
      has_hobbs: boolean;
      has_tach: boolean;
      make: string | null;
      model: string | null;
      year: number | null;
      serial_number: string | null;
      home_base_location_id: string | null;
    }>(
      `INSERT INTO resource (org_id, kind, display_name, tail_number)
       VALUES ($1, 'aircraft', 'Legacy Cessna N11111', 'N11111')
       RETURNING id, has_hobbs, has_tach, make, model, year, serial_number, home_base_location_id`,
      [orgAId],
    );
    await pglite.exec(`COMMIT`);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.has_hobbs).toBe(true);
    expect(row.has_tach).toBe(true);
    expect(row.make).toBeNull();
    expect(row.model).toBeNull();
    expect(row.year).toBeNull();
    expect(row.serial_number).toBeNull();
    expect(row.home_base_location_id).toBeNull();
  });

  // ── T3: all existing resource_kind_shape_check cases unchanged ─────────────

  it('T3: resource_kind_shape_check — aircraft without tail_number still rejected', async () => {
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

  it('T3: resource_kind_shape_check — aircraft with tail_number still accepted', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource (org_id, kind, display_name, tail_number)
         VALUES ($1, 'aircraft', 'Valid Aircraft', 'N77777')
         RETURNING id`,
        [orgAId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);
  });

  it('T3: resource_kind_shape_check — instructor without instructor_user_id still rejected', async () => {
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

  it('T3: resource_kind_shape_check — sim without tail_number or instructor_user_id still accepted', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource (org_id, kind, display_name)
         VALUES ($1, 'sim', 'Redbird TD2')
         RETURNING id`,
        [orgAId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);
  });

  it('T3: resource_kind_shape_check — room without tail_number or instructor_user_id still accepted', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource (org_id, kind, display_name)
         VALUES ($1, 'room', 'Briefing Room 1')
         RETURNING id`,
        [orgAId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);
  });

  it('T3: resource_kind_shape_check — vehicle without tail_number or instructor_user_id still accepted', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource (org_id, kind, display_name)
         VALUES ($1, 'vehicle', 'Fuel Truck')
         RETURNING id`,
        [orgAId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);
  });

  // ── T4: resource_year_sane_check ──────────────────────────────────────────

  it('T4: resource_year_sane_check rejects year=1899 (below 1900)', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource (org_id, kind, display_name, tail_number, year)
         VALUES ($1, 'aircraft', 'Too Old', 'N00001', 1899)`,
        [orgAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T4: resource_year_sane_check rejects year=2201 (above 2200)', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource (org_id, kind, display_name, tail_number, year)
         VALUES ($1, 'aircraft', 'Too Future', 'N00002', 2201)`,
        [orgAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T4: resource_year_sane_check accepts year=null', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource (org_id, kind, display_name, tail_number, year)
         VALUES ($1, 'aircraft', 'No Year', 'N00003', NULL)
         RETURNING id`,
        [orgAId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);
  });

  it('T4: resource_year_sane_check accepts year=2025', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource (org_id, kind, display_name, tail_number, year)
         VALUES ($1, 'aircraft', 'Modern Aircraft', 'N00004', 2025)
         RETURNING id`,
        [orgAId],
      ),
    ).resolves.toBeDefined();
    await pglite.exec(`COMMIT`);
  });

  // ── T5(a): same-org home_base_location_id links OK ────────────────────────

  it('T5a: home_base_location_id with same-org location links successfully', async () => {
    const { pglite, orgAId, locationAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const result = await pglite.query<{ id: string; home_base_location_id: string }>(
      `INSERT INTO resource (org_id, kind, display_name, tail_number, home_base_location_id)
       VALUES ($1, 'aircraft', 'Based Aircraft', 'N55555', $2)
       RETURNING id, home_base_location_id`,
      [orgAId, locationAId],
    );
    await pglite.exec(`COMMIT`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.home_base_location_id).toBe(locationAId);
  });

  // ── T5(b): different-org location id is rejected ──────────────────────────

  it('T5b: home_base_location_id from a different org is rejected by composite FK', async () => {
    const { pglite, orgAId, locationBId } = env;
    // locationBId belongs to orgB, not orgA — the composite FK
    // (home_base_location_id, org_id) → location(id, org_id) fires and rejects.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO resource (org_id, kind, display_name, tail_number, home_base_location_id)
         VALUES ($1, 'aircraft', 'Cross Org Aircraft', 'N66666', $2)`,
        [orgAId, locationBId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── T5(c): deleting linked location SET-NULLs home_base_location_id ───────

  it('T5c: deleting the linked location SET-NULLs home_base_location_id but NOT org_id', async () => {
    const { db, pglite, orgAId } = env;

    // We need superuser context to create a location + resource, then delete the location.
    // After setTestAppRole the session is aeroops_app.
    // We need to temporarily escalate — do it via a raw superuser exec.
    // PGlite test sessions don't have a second connection, so we use execRaw
    // pattern from the existing test helpers: switch role, operate, switch back.
    // Simplest approach: open a fresh PGlite db instance so we can seed as owner,
    // but that would require a new migration run. Instead we use the raw pglite
    // exec to set role to the table owner (superuser) for the setup queries,
    // then validate as aeroops_app.
    //
    // Since PGlite is single-connection, we use SET ROLE to step back to superuser
    // for the ephemeral location insert and aircraft update.
    // (In the test harness, "superuser" context is the PGlite owner/postgres role
    //  before setTestAppRole was called. We cannot re-escalate after FORCE RLS
    //  without a second connection — so we INSERT via raw SQL after setting the GUC,
    //  which works because aeroops_app has INSERT/UPDATE/DELETE on resource+location.)

    // Step 1: insert a temporary location in org A (aeroops_app has INSERT on location).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const locResult = await pglite.query<{ id: string }>(
      `INSERT INTO location (org_id, name) VALUES ($1, 'Temp Base') RETURNING id`,
      [orgAId],
    );
    const tempLocId = locResult.rows[0]!.id;

    // Step 2: insert an aircraft pointing at the temp location.
    const acResult = await pglite.query<{ id: string }>(
      `INSERT INTO resource (org_id, kind, display_name, tail_number, home_base_location_id)
       VALUES ($1, 'aircraft', 'Temp Based', 'N77888', $2)
       RETURNING id`,
      [orgAId, tempLocId],
    );
    const tempAcId = acResult.rows[0]!.id;
    await pglite.exec(`COMMIT`);

    // Step 3: verify the link is set.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const before = await pglite.query<{ home_base_location_id: string | null; org_id: string }>(
      `SELECT home_base_location_id, org_id FROM resource WHERE id = $1`,
      [tempAcId],
    );
    expect(before.rows[0]!.home_base_location_id).toBe(tempLocId);
    expect(before.rows[0]!.org_id).toBe(orgAId);
    await pglite.exec(`COMMIT`);

    // Step 4: delete the location row — triggers ON DELETE SET NULL (home_base_location_id).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await pglite.query(`DELETE FROM location WHERE id = $1`, [tempLocId]);
    await pglite.exec(`COMMIT`);

    // Step 5: verify home_base_location_id is now NULL, but org_id is UNCHANGED.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const after = await pglite.query<{ home_base_location_id: string | null; org_id: string }>(
      `SELECT home_base_location_id, org_id FROM resource WHERE id = $1`,
      [tempAcId],
    );
    await pglite.exec(`COMMIT`);

    expect(after.rows[0]!.home_base_location_id).toBeNull();
    // CRITICAL: org_id must not be nulled by the column-list SET NULL.
    expect(after.rows[0]!.org_id).toBe(orgAId);
  });

  // ── T6: location_id_org_id_unique constraint exists ───────────────────────

  it('T6: location_id_org_id_unique constraint exists on location table', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'location'::regclass
         AND contype = 'u'
         AND conname = 'location_id_org_id_unique'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.conname).toBe('location_id_org_id_unique');
  });

  // ── T7: down migration cleanly reverses ───────────────────────────────────

  it('T7: down migration 0007 removes all Slice 5 additions and resource still functional', async () => {
    // Use a fresh PGlite instance to apply forward + down without disturbing
    // the shared env used by T1–T6.
    const { db: db2, pglite: pg2 } = await createTestClient();
    await applyMigrationSql({ pglite: pg2 }, MIGRATION_SQL_THROUGH_0007);

    // Apply the down migration.
    await applyMigrationSql({ pglite: pg2 }, [DOWN_0007]);

    // Verify: the seven new resource columns are gone.
    for (const col of [
      'make', 'model', 'year', 'serial_number',
      'home_base_location_id', 'has_hobbs', 'has_tach',
    ]) {
      const colResult = await pg2.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'resource' AND column_name = $1`,
        [col],
      );
      expect(colResult.rows, `column ${col} should not exist after down migration`).toHaveLength(0);
    }

    // Verify: the location unique constraint is gone.
    const uqResult = await pg2.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'location'::regclass
         AND contype = 'u'
         AND conname = 'location_id_org_id_unique'`,
    );
    expect(uqResult.rows, 'location_id_org_id_unique should not exist after down migration').toHaveLength(0);

    // Verify: year sane check is gone.
    const yearCheckResult = await pg2.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'resource'::regclass
         AND contype = 'c'
         AND conname = 'resource_year_sane_check'`,
    );
    expect(yearCheckResult.rows, 'resource_year_sane_check should not exist after down migration').toHaveLength(0);

    // Verify: home base FK is gone.
    const fkResult = await pg2.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'resource'::regclass
         AND contype = 'f'
         AND conname = 'resource_home_base_org_fk'`,
    );
    expect(fkResult.rows, 'resource_home_base_org_fk should not exist after down migration').toHaveLength(0);

    // Verify: resource table still exists and an aircraft INSERT (old-style) still works.
    // Seed the minimum required tables to exercise an insert.
    await pg2.exec(`SET app.current_org_id = ''`);
    // Insert as superuser (no RLS applied until setTestAppRole) — just verify table accepts aircraft.
    const orgResult = await pg2.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Down Test Org', 'down-test') RETURNING id`,
      [],
    );
    const orgId = orgResult.rows[0]!.id;
    await pg2.exec(`SET LOCAL app.current_org_id = '${orgId}'`);
    const insertResult = await pg2.query<{ id: string }>(
      `INSERT INTO resource (org_id, kind, display_name, tail_number)
       VALUES ($1, 'aircraft', 'Post-down Aircraft', 'NDOWN1')
       RETURNING id`,
      [orgId],
    );
    expect(insertResult.rows).toHaveLength(1);
  });
});
