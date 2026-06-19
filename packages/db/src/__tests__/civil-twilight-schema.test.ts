/**
 * civil-twilight-schema.test.ts — Schema tests for 0010_civil_twilight.sql (Slice 4a).
 *
 * Proves spec §4a.1 / additive-guarantee acceptance criteria:
 *
 *   T1.  latitude + longitude columns exist on location after migration 0010.
 *   T2.  twilight columns exist on dispatch_config after migration 0010.
 *   T3.  location inserts that OMIT latitude/longitude still succeed (additive).
 *   T4.  dispatch_config inserts that OMIT twilight columns still succeed (additive).
 *   T5.  twilight_constraint_enabled defaults to false.
 *   T6.  twilight_mode defaults to 'warn'.
 *   T7.  twilight_mode CHECK — rejects a value not in {block, warn}.
 *   T8.  twilight_exempt_tag nonempty CHECK:
 *        (a) empty string → rejected.
 *        (b) blank-only (spaces) → rejected.
 *        (c) valid non-empty string → accepted.
 *        (d) NULL → accepted.
 *   T9.  latitude range CHECK:
 *        (a) -91 → rejected.
 *        (b) 91  → rejected.
 *        (c) -90 (boundary) → accepted.
 *        (d) 90  (boundary) → accepted.
 *   T10. longitude range CHECK:
 *        (a) -181 → rejected.
 *        (b) 181  → rejected.
 *        (c) -180 (boundary) → accepted.
 *        (d) 180  (boundary) → accepted.
 *   T11. paired-presence CHECK:
 *        (a) latitude set, longitude NULL → rejected.
 *        (b) latitude NULL, longitude set → rejected.
 *        (c) both NULL → accepted.
 *        (d) both set → accepted.
 *   T12. Down migration reverses 0010: columns and constraints gone.
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies all eleven real
 * migration artifacts (0000–0010) in order so the constraint SQL validated
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
  withPlatformAdminContext,
  withOrgContext,
} from '../index.js';
import {
  org,
  location,
  dispatchConfig,
} from '../schema/index.js';

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

const DOWN_0010 = readFileSync(
  resolve(__dirname, '../../migrations/0010_civil_twilight.down.sql'),
  'utf-8',
);

// ── Test environment ──────────────────────────────────────────────────────────

interface TwilightSchemaEnv {
  pglite: PGlite;
  orgId: string;
}

async function setupTwilightEnv(): Promise<TwilightSchemaEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const [orgRow] = await withPlatformAdminContext(db, async (tx) => {
    return tx
      .insert(org)
      .values({ name: 'Twilight Flight School', slug: 'twilight-school' })
      .returning();
  });

  return { pglite, orgId: orgRow!.id };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('civil-twilight-schema: migration 0010 + constraints', () => {
  let env: TwilightSchemaEnv;

  beforeAll(async () => {
    env = await setupTwilightEnv();
  });

  // ── T1: latitude + longitude columns exist on location ───────────────────

  it('T1a: location.latitude column exists after migration 0010', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'location'
           AND column_name = 'latitude'
       ) AS exists`,
    );
    expect(result.rows[0]!.exists).toBe(true);
  });

  it('T1b: location.longitude column exists after migration 0010', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'location'
           AND column_name = 'longitude'
       ) AS exists`,
    );
    expect(result.rows[0]!.exists).toBe(true);
  });

  it('T1c: latitude column is nullable', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'location' AND column_name = 'latitude'`,
    );
    expect(result.rows[0]!.is_nullable).toBe('YES');
  });

  it('T1d: longitude column is nullable', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'location' AND column_name = 'longitude'`,
    );
    expect(result.rows[0]!.is_nullable).toBe('YES');
  });

  // ── T2: twilight columns exist on dispatch_config ─────────────────────────

  it('T2a: dispatch_config.twilight_constraint_enabled column exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'twilight_constraint_enabled'
       ) AS exists`,
    );
    expect(result.rows[0]!.exists).toBe(true);
  });

  it('T2b: dispatch_config.twilight_mode column exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'twilight_mode'
       ) AS exists`,
    );
    expect(result.rows[0]!.exists).toBe(true);
  });

  it('T2c: dispatch_config.twilight_exempt_tag column exists and is nullable', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'dispatch_config'
         AND column_name = 'twilight_exempt_tag'`,
    );
    expect(result.rows[0]!.is_nullable).toBe('YES');
  });

  // ── T3: location inserts omitting lat/lon still succeed (additive) ─────────

  it('T3: additive — location insert without latitude/longitude succeeds', async () => {
    const { pglite, orgId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    const result = await pglite.query<{ id: string }>(
      `INSERT INTO location (org_id, name)
       VALUES ($1, 'Alpha Airport — no coords')
       RETURNING id`,
      [orgId],
    );
    await pglite.exec(`COMMIT`);
    expect(result.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── T4: dispatch_config inserts omitting twilight columns succeed ──────────

  it('T4: additive — dispatch_config insert without twilight columns succeeds', async () => {
    const { pglite, orgId } = env;
    // Use a fresh org to avoid dispatch_config_org_id_unique collision.
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Additive Test Org', 'additive-twilight-org') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    const result = await pglite.query<{ id: string }>(
      `INSERT INTO dispatch_config (org_id, eligibility_mode, balance_check_enabled)
       VALUES ($1, 'block', false)
       RETURNING id`,
      [freshOrgId],
    );
    await pglite.exec(`COMMIT`);
    expect(result.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── T5: twilight_constraint_enabled defaults to false ─────────────────────

  it('T5: twilight_constraint_enabled defaults to false', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Default Enabled Org', 'default-enabled-org') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    const result = await pglite.query<{ twilight_constraint_enabled: boolean }>(
      `INSERT INTO dispatch_config (org_id, eligibility_mode, balance_check_enabled)
       VALUES ($1, 'block', false)
       RETURNING twilight_constraint_enabled`,
      [freshOrgId],
    );
    await pglite.exec(`COMMIT`);
    expect(result.rows[0]!.twilight_constraint_enabled).toBe(false);
  });

  // ── T6: twilight_mode defaults to 'warn' ──────────────────────────────────

  it('T6: twilight_mode defaults to warn', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Default Mode Org', 'default-mode-org') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    const result = await pglite.query<{ twilight_mode: string }>(
      `INSERT INTO dispatch_config (org_id, eligibility_mode, balance_check_enabled)
       VALUES ($1, 'block', false)
       RETURNING twilight_mode`,
      [freshOrgId],
    );
    await pglite.exec(`COMMIT`);
    expect(result.rows[0]!.twilight_mode).toBe('warn');
  });

  // ── T7: twilight_mode CHECK — rejects unknown mode ────────────────────────

  it('T7: dispatch_config_twilight_mode_check rejects unknown mode', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Bad Mode Org', 'bad-mode-org') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    await expect(
      pglite.query(
        `INSERT INTO dispatch_config (org_id, eligibility_mode, balance_check_enabled, twilight_mode)
         VALUES ($1, 'block', false, 'nighttime')`,
        [freshOrgId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── T8: twilight_exempt_tag nonempty CHECK ────────────────────────────────

  it('T8a: twilight_exempt_tag nonempty CHECK — empty string is rejected', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Empty Tag Org A', 'empty-tag-org-a') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    await expect(
      pglite.query(
        `INSERT INTO dispatch_config (org_id, eligibility_mode, balance_check_enabled, twilight_exempt_tag)
         VALUES ($1, 'block', false, '')`,
        [freshOrgId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T8b: twilight_exempt_tag nonempty CHECK — blank-only (spaces) is rejected', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Blank Tag Org B', 'blank-tag-org-b') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    await expect(
      pglite.query(
        `INSERT INTO dispatch_config (org_id, eligibility_mode, balance_check_enabled, twilight_exempt_tag)
         VALUES ($1, 'block', false, '   ')`,
        [freshOrgId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T8c: twilight_exempt_tag nonempty CHECK — valid non-empty string is accepted', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Valid Tag Org C', 'valid-tag-org-c') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    const result = await pglite.query<{ id: string }>(
      `INSERT INTO dispatch_config (org_id, eligibility_mode, balance_check_enabled, twilight_exempt_tag)
       VALUES ($1, 'block', false, 'night-qualified')
       RETURNING id`,
      [freshOrgId],
    );
    await pglite.exec(`COMMIT`);
    expect(result.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('T8d: twilight_exempt_tag nonempty CHECK — NULL is accepted', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Null Tag Org D', 'null-tag-org-d') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    const result = await pglite.query<{ twilight_exempt_tag: string | null }>(
      `INSERT INTO dispatch_config (org_id, eligibility_mode, balance_check_enabled, twilight_exempt_tag)
       VALUES ($1, 'block', false, NULL)
       RETURNING twilight_exempt_tag`,
      [freshOrgId],
    );
    await pglite.exec(`COMMIT`);
    expect(result.rows[0]!.twilight_exempt_tag).toBeNull();
  });

  // ── T9: latitude range CHECK ──────────────────────────────────────────────

  it('T9a: civil_twilight_lat_range_check — latitude -91 is rejected', async () => {
    const { pglite, orgId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    await expect(
      pglite.query(
        `INSERT INTO location (org_id, name, latitude, longitude)
         VALUES ($1, 'Out of Range Lat Low', -91, 0)`,
        [orgId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T9b: civil_twilight_lat_range_check — latitude 91 is rejected', async () => {
    const { pglite, orgId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    await expect(
      pglite.query(
        `INSERT INTO location (org_id, name, latitude, longitude)
         VALUES ($1, 'Out of Range Lat High', 91, 0)`,
        [orgId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T9c: civil_twilight_lat_range_check — latitude -90 (boundary) is accepted', async () => {
    const { pglite, orgId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    const result = await pglite.query<{ id: string }>(
      `INSERT INTO location (org_id, name, latitude, longitude)
       VALUES ($1, 'South Pole Lat', -90, 0)
       RETURNING id`,
      [orgId],
    );
    await pglite.exec(`COMMIT`);
    expect(result.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('T9d: civil_twilight_lat_range_check — latitude 90 (boundary) is accepted', async () => {
    const { pglite, orgId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    const result = await pglite.query<{ id: string }>(
      `INSERT INTO location (org_id, name, latitude, longitude)
       VALUES ($1, 'North Pole Lat', 90, 0)
       RETURNING id`,
      [orgId],
    );
    await pglite.exec(`COMMIT`);
    expect(result.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── T10: longitude range CHECK ────────────────────────────────────────────

  it('T10a: civil_twilight_lon_range_check — longitude -181 is rejected', async () => {
    const { pglite, orgId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    await expect(
      pglite.query(
        `INSERT INTO location (org_id, name, latitude, longitude)
         VALUES ($1, 'Out of Range Lon Low', 0, -181)`,
        [orgId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T10b: civil_twilight_lon_range_check — longitude 181 is rejected', async () => {
    const { pglite, orgId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    await expect(
      pglite.query(
        `INSERT INTO location (org_id, name, latitude, longitude)
         VALUES ($1, 'Out of Range Lon High', 0, 181)`,
        [orgId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T10c: civil_twilight_lon_range_check — longitude -180 (boundary) is accepted', async () => {
    const { pglite, orgId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    const result = await pglite.query<{ id: string }>(
      `INSERT INTO location (org_id, name, latitude, longitude)
       VALUES ($1, 'Dateline West Lon', 0, -180)
       RETURNING id`,
      [orgId],
    );
    await pglite.exec(`COMMIT`);
    expect(result.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('T10d: civil_twilight_lon_range_check — longitude 180 (boundary) is accepted', async () => {
    const { pglite, orgId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    const result = await pglite.query<{ id: string }>(
      `INSERT INTO location (org_id, name, latitude, longitude)
       VALUES ($1, 'Dateline East Lon', 0, 180)
       RETURNING id`,
      [orgId],
    );
    await pglite.exec(`COMMIT`);
    expect(result.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── T11: paired-presence CHECK (both-null or both-set) ────────────────────

  it('T11a: civil_twilight_latlon_paired_check — latitude set, longitude NULL is rejected', async () => {
    const { pglite, orgId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    await expect(
      pglite.query(
        `INSERT INTO location (org_id, name, latitude, longitude)
         VALUES ($1, 'Half Set Lat Only', 37.77490, NULL)`,
        [orgId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T11b: civil_twilight_latlon_paired_check — latitude NULL, longitude set is rejected', async () => {
    const { pglite, orgId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    await expect(
      pglite.query(
        `INSERT INTO location (org_id, name, latitude, longitude)
         VALUES ($1, 'Half Set Lon Only', NULL, -122.41940)`,
        [orgId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T11c: civil_twilight_latlon_paired_check — both NULL is accepted', async () => {
    const { pglite, orgId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    const result = await pglite.query<{ id: string }>(
      `INSERT INTO location (org_id, name, latitude, longitude)
       VALUES ($1, 'Both Null OK', NULL, NULL)
       RETURNING id`,
      [orgId],
    );
    await pglite.exec(`COMMIT`);
    expect(result.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('T11d: civil_twilight_latlon_paired_check — both set is accepted', async () => {
    const { pglite, orgId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    // San Francisco International Airport
    const result = await pglite.query<{ id: string }>(
      `INSERT INTO location (org_id, name, latitude, longitude)
       VALUES ($1, 'KSFO', 37.61900, -122.37490)
       RETURNING id`,
      [orgId],
    );
    await pglite.exec(`COMMIT`);
    expect(result.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── T12: Down migration reverses 0010 ────────────────────────────────────

  it('T12: down migration cleanly reverses 0010 — columns and constraints gone', async () => {
    const { pglite: pg2 } = await createTestClient();
    await applyMigrationSql({ pglite: pg2 }, MIGRATION_SQL);
    await applyMigrationSql({ pglite: pg2 }, [DOWN_0010]);

    // latitude column should be gone.
    const latCheck = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'location'
           AND column_name = 'latitude'
       ) AS exists`,
    );
    expect(latCheck.rows[0]!.exists).toBe(false);

    // longitude column should be gone.
    const lonCheck = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'location'
           AND column_name = 'longitude'
       ) AS exists`,
    );
    expect(lonCheck.rows[0]!.exists).toBe(false);

    // twilight_constraint_enabled should be gone.
    const enabledCheck = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'twilight_constraint_enabled'
       ) AS exists`,
    );
    expect(enabledCheck.rows[0]!.exists).toBe(false);

    // twilight_mode should be gone.
    const modeCheck = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'twilight_mode'
       ) AS exists`,
    );
    expect(modeCheck.rows[0]!.exists).toBe(false);

    // twilight_exempt_tag should be gone.
    const tagCheck = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'twilight_exempt_tag'
       ) AS exists`,
    );
    expect(tagCheck.rows[0]!.exists).toBe(false);

    // paired-presence constraint should be gone.
    const pairedCheck = await pg2.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_constraint
       WHERE conname = 'civil_twilight_latlon_paired_check'`,
    );
    expect(pairedCheck.rows[0]!.count).toBe('0');

    // twilight_mode check should be gone.
    const modeConstraintCheck = await pg2.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_constraint
       WHERE conname = 'dispatch_config_twilight_mode_check'`,
    );
    expect(modeConstraintCheck.rows[0]!.count).toBe('0');
  });
});
