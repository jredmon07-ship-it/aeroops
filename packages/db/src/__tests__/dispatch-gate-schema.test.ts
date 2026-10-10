/**
 * dispatch-gate-schema.test.ts — Schema tests for 0009_dispatch_gate.sql (Slice 3c).
 *
 * Proves spec §1 / §5 schema acceptance criteria:
 *   T1.  Both tables (dispatch_config, dispatch_requirement) exist after migration 0009.
 *   T2.  dispatch_config FORCE RLS fail-closed: GUC unset → 0 rows.
 *   T3.  dispatch_requirement FORCE RLS fail-closed: GUC unset → 0 rows.
 *   T4.  RLS isolation: org A cannot see org B's dispatch_config rows.
 *   T5.  RLS isolation: org A cannot see org B's dispatch_requirement rows.
 *   T6.  dispatch_requirement composite-FK cross-org rejection:
 *        (a) resource_id from a different org → rejected.
 *        (b) created_by from a different org → rejected.
 *   T7.  dispatch_requirement_tag_nonempty_check:
 *        (a) empty string → rejected.
 *        (b) blank-only (spaces) → rejected.
 *   T8.  dispatch_requirement_resource_tag_unique UNIQUE (resource_id, required_tag):
 *        (a) duplicate (resource_id, required_tag) → rejected (23505).
 *        (b) same required_tag on a different aircraft → accepted.
 *   T9.  dispatch_config_eligibility_mode_check:
 *        (a) 'block' → accepted.
 *        (b) 'warn'  → accepted.
 *        (c) 'invalid_value' → rejected.
 *   T10. dispatch_config_org_id_unique: duplicate (org_id) config row → rejected.
 *   T11. CASCADE: deleting an aircraft (resource) removes its dispatch requirements.
 *   T12. RESTRICT: deleting the created_by user while they author a requirement → blocked.
 *   T13. Additive: resource and dispatch_ticket insert with no config/requirement still succeeds.
 *   T14. Down migration reverses 0009: both tables gone, index gone.
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies all ten real
 * migration artifacts (0000–0009) in order so the constraint SQL validated
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
  dispatchRequirement,
  dispatchConfig,
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
  readFileSync(resolve(__dirname, '../../migrations/0018_dispatch_ticket_correction.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0019_billing_records.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0020_demo_reset_state.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0021_qbo_integration.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0022_billing_ledger.sql'), 'utf-8'),
  // 0037 required: resource now includes category/aircraft_class (Slice P2-LOG2).
  // Drizzle ORM INSERT on resource emits all columns, so the columns must exist.
  readFileSync(resolve(__dirname, '../../migrations/0037_logbook_annotation.sql'), 'utf-8'),
];

const DOWN_0009 = readFileSync(
  resolve(__dirname, '../../migrations/0009_dispatch_gate.down.sql'),
  'utf-8',
);

// ── Test environment ──────────────────────────────────────────────────────────

interface DispatchGateTestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;   // member of org A (used as creator)
  userA2Id: string;  // second member of org A
  userBId: string;   // member of org B
  aircraftAId: string; // resource (aircraft) in org A
  aircraftBId: string; // resource (aircraft) in org B
}

async function setupDispatchGateEnv(): Promise<DispatchGateTestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha Flight School', slug: 'alpha-gate' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta Club', slug: 'beta-gate' })
      .returning();
    return [a[0]!, b[0]!];
  });

  const [userA, userA2, aircraftA] = await withOrgContext(db, orgA.id, async (tx) => {
    const u1 = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'alice@alpha.example', fullName: 'Alice A' })
      .returning();
    const u2 = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'admin@alpha.example', fullName: 'Admin A' })
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
    return [u1[0]!, u2[0]!, r[0]!];
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

  // Drop to aeroops_app for RLS enforcement on all subsequent queries.
  await setTestAppRole({ pglite });

  return {
    db,
    pglite,
    orgAId: orgA.id,
    orgBId: orgB.id,
    userAId: userA.id,
    userA2Id: userA2.id,
    userBId: userB.id,
    aircraftAId: aircraftA.id,
    aircraftBId: aircraftB.id,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Inserts a valid dispatch_requirement row.
 * Caller is responsible for setting GUC in the surrounding transaction.
 */
async function insertRequirement(
  pglite: PGlite,
  orgId: string,
  resourceId: string,
  createdBy: string,
  requiredTag: string,
): Promise<string> {
  const result = await pglite.query<{ id: string }>(
    `INSERT INTO dispatch_requirement (org_id, resource_id, required_tag, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [orgId, resourceId, requiredTag, createdBy],
  );
  return result.rows[0]!.id;
}

/**
 * Inserts a valid dispatch_config row.
 * Caller is responsible for setting GUC in the surrounding transaction.
 */
async function insertConfig(
  pglite: PGlite,
  orgId: string,
  eligibilityMode = 'block',
  balanceCheckEnabled = false,
): Promise<string> {
  const result = await pglite.query<{ id: string }>(
    `INSERT INTO dispatch_config (org_id, eligibility_mode, balance_check_enabled)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [orgId, eligibilityMode, balanceCheckEnabled],
  );
  return result.rows[0]!.id;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('dispatch-gate-schema: migration 0009 + constraints + RLS', () => {
  let env: DispatchGateTestEnv;

  beforeAll(async () => {
    env = await setupDispatchGateEnv();
  });

  // ── T1: Tables exist after migration 0009 ────────────────────────────────

  it('T1a: dispatch_config table exists after migration 0009', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'dispatch_config'
       ) AS exists`,
    );
    expect(result.rows[0]!.exists).toBe(true);
  });

  it('T1b: dispatch_requirement table exists after migration 0009', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'dispatch_requirement'
       ) AS exists`,
    );
    expect(result.rows[0]!.exists).toBe(true);
  });

  // ── T2: dispatch_config FORCE RLS fail-closed ─────────────────────────────

  it('T2: FORCE RLS fail-closed — GUC unset → 0 rows from dispatch_config', async () => {
    const { pglite } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM dispatch_config`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  // ── T3: dispatch_requirement FORCE RLS fail-closed ───────────────────────

  it('T3: FORCE RLS fail-closed — GUC unset → 0 rows from dispatch_requirement', async () => {
    const { pglite } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM dispatch_requirement`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  // ── T4: dispatch_config RLS isolation ────────────────────────────────────

  it('T4: RLS isolation — org A cannot see org B dispatch_config rows', async () => {
    const { pglite, db, orgAId, orgBId } = env;

    // Seed a config row for each org as superuser.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertConfig(pglite, orgAId, 'block', false);
    await pglite.exec(`COMMIT`);

    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertConfig(pglite, orgBId, 'warn', false);
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Org A context — must not see org B rows.
    const rowsUnderA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(dispatchConfig).execute(),
    );
    expect(rowsUnderA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsUnderA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context — must see org B rows, not org A rows.
    const rowsUnderB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(dispatchConfig).execute(),
    );
    expect(rowsUnderB.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsUnderB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  // ── T5: dispatch_requirement RLS isolation ────────────────────────────────

  it('T5: RLS isolation — org A cannot see org B dispatch_requirement rows', async () => {
    const { pglite, db, orgAId, orgBId, userAId, userBId, aircraftAId, aircraftBId } = env;

    // Seed a requirement for each org as superuser.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertRequirement(pglite, orgAId, aircraftAId, userAId, 'student-pilot');
    await pglite.exec(`COMMIT`);

    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertRequirement(pglite, orgBId, aircraftBId, userBId, 'renter');
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Org A context — must not see org B rows.
    const rowsUnderA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(dispatchRequirement).execute(),
    );
    expect(rowsUnderA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsUnderA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context — must see org B rows, not org A rows.
    const rowsUnderB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(dispatchRequirement).execute(),
    );
    expect(rowsUnderB.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsUnderB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  // ── T6: dispatch_requirement composite-FK cross-org rejection ────────────

  it('T6a: composite FK (resource_id, org_id) rejects a resource from a different org', async () => {
    const { pglite, orgAId, userAId, aircraftBId } = env;
    // resource_id belongs to org B but org_id is org A — must fail FK check.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRequirement(pglite, orgAId, aircraftBId, userAId, 'cross-org-resource'),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T6b: composite FK (created_by, org_id) rejects a creator from a different org', async () => {
    const { pglite, orgAId, userBId, aircraftAId } = env;
    // created_by belongs to org B but org_id is org A — must fail FK check.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRequirement(pglite, orgAId, aircraftAId, userBId, 'cross-org-creator'),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── T7: dispatch_requirement_tag_nonempty_check ───────────────────────────

  it('T7a: dispatch_requirement_tag_nonempty_check — empty string tag is rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRequirement(pglite, orgAId, aircraftAId, userAId, ''),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T7b: dispatch_requirement_tag_nonempty_check — blank-only tag (spaces) is rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRequirement(pglite, orgAId, aircraftAId, userAId, '   '),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── T8: dispatch_requirement_resource_tag_unique ──────────────────────────

  it('T8a: UNIQUE (resource_id, required_tag) — duplicate rejected (23505)', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    // First insert succeeds.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertRequirement(pglite, orgAId, aircraftAId, userAId, 'cfi-endorsement');
    await pglite.exec(`COMMIT`);

    // Second insert with same (resource_id, required_tag) must fail.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRequirement(pglite, orgAId, aircraftAId, userAId, 'cfi-endorsement'),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T8b: UNIQUE (resource_id, required_tag) — same tag on a different aircraft is accepted', async () => {
    const { pglite, orgBId, userBId, aircraftBId } = env;
    // Same tag 'cfi-endorsement' but different resource_id → must succeed.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    const id = await insertRequirement(pglite, orgBId, aircraftBId, userBId, 'cfi-endorsement');
    await pglite.exec(`COMMIT`);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── T9: dispatch_config_eligibility_mode_check ────────────────────────────

  it('T9a: eligibility_mode="block" is accepted', async () => {
    const { pglite } = env;
    // Use a fresh org to avoid dispatch_config_org_id_unique collision.
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Block Test Org', 'block-test-org') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    const id = await insertConfig(pglite, freshOrgId, 'block');
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('T9b: eligibility_mode="warn" is accepted', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Warn Test Org', 'warn-test-org') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    const id = await insertConfig(pglite, freshOrgId, 'warn');
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('T9c: dispatch_config_eligibility_mode_check — invalid mode is rejected', async () => {
    const { pglite } = env;
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Invalid Mode Org', 'invalid-mode-org') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    await expect(
      insertConfig(pglite, freshOrgId, 'invalid_value'),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── T10: dispatch_config_org_id_unique ────────────────────────────────────

  it('T10: dispatch_config_org_id_unique — duplicate org_id config row is rejected', async () => {
    const { pglite } = env;
    // Use a fresh org to control uniqueness.
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Dup Config Org', 'dup-config-org') RETURNING id`,
    );
    const freshOrgId = orgResult.rows[0]!.id;

    // First config row succeeds.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    await insertConfig(pglite, freshOrgId, 'block');
    await pglite.exec(`COMMIT`);

    // Second config row for same org must fail (UNIQUE org_id).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${freshOrgId}'`);
    await expect(
      insertConfig(pglite, freshOrgId, 'warn'),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── T11: CASCADE from resource ────────────────────────────────────────────

  it('T11: CASCADE — deleting an aircraft removes its dispatch_requirement rows', async () => {
    const { pglite, orgAId, userAId } = env;

    // Create a disposable aircraft and attach a requirement — as superuser.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const acResult = await pglite.query<{ id: string }>(
      `INSERT INTO resource (org_id, kind, display_name, tail_number)
       VALUES ($1, 'aircraft', 'Disposable Aircraft N55555', 'N55555')
       RETURNING id`,
      [orgAId],
    );
    const disposableAircraftId = acResult.rows[0]!.id;
    const reqResult = await pglite.query<{ id: string }>(
      `INSERT INTO dispatch_requirement (org_id, resource_id, required_tag, created_by)
       VALUES ($1, $2, 'cascade-test-tag', $3)
       RETURNING id`,
      [orgAId, disposableAircraftId, userAId],
    );
    const reqId = reqResult.rows[0]!.id;
    await pglite.exec(`COMMIT`);

    // Delete the aircraft — its requirements must cascade-delete.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await pglite.query(`DELETE FROM resource WHERE id = $1`, [disposableAircraftId]);
    await pglite.exec(`COMMIT`);

    // Verify the requirement is gone.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const check = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM dispatch_requirement WHERE id = $1`,
      [reqId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(check.rows[0]!.count).toBe('0');
  });

  // ── T12: RESTRICT on created_by ───────────────────────────────────────────

  it('T12: RESTRICT — deleting a user who authored a requirement is blocked', async () => {
    const { pglite, orgAId, aircraftAId } = env;

    // Create a disposable creator and attach a requirement — as superuser.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const creatorResult = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name)
       VALUES ($1, 'creator-restrict@alpha.example', 'Creator Restrict')
       RETURNING id`,
      [orgAId],
    );
    const creatorId = creatorResult.rows[0]!.id;
    await pglite.query(
      `INSERT INTO dispatch_requirement (org_id, resource_id, required_tag, created_by)
       VALUES ($1, $2, 'restrict-test-tag', $3)`,
      [orgAId, aircraftAId, creatorId],
    );
    await pglite.exec(`COMMIT`);

    // Attempt to delete the creator — must fail (RESTRICT).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(`DELETE FROM app_user WHERE id = $1`, [creatorId]),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── T13: Additive — existing inserts still succeed without config/requirement ──

  it('T13: additive — resource/dispatch_ticket insert with no config or requirement succeeds', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;

    // Create a reservation for the dispatch ticket.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const resResult = await pglite.query<{ id: string }>(
      `INSERT INTO reservation (org_id, start_at, end_at, status, created_by)
       VALUES ($1, '2026-08-01T10:00:00Z', '2026-08-01T12:00:00Z', 'booked', $2)
       RETURNING id`,
      [orgAId, userAId],
    );
    const reservationId = resResult.rows[0]!.id;

    // Insert a dispatch ticket — no dispatch_config row, no dispatch_requirement row.
    const ticketResult = await pglite.query<{ id: string }>(
      `INSERT INTO dispatch_ticket
         (org_id, reservation_id, resource_id, pilot_user_id, opened_by, hobbs_out, tach_out, status)
       VALUES ($1, $2, $3, $4, $4, 100.0, 200.0, 'open')
       RETURNING id`,
      [orgAId, reservationId, aircraftAId, userAId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(ticketResult.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── T14: Down migration reverses 0009 ────────────────────────────────────

  it('T14: down migration cleanly reverses 0009 — both tables and index gone', async () => {
    // Spin up a fresh DB, apply all migrations, then run down.
    const { pglite: pg2 } = await createTestClient();
    await applyMigrationSql({ pglite: pg2 }, MIGRATION_SQL);
    await applyMigrationSql({ pglite: pg2 }, [DOWN_0009]);

    // dispatch_config table should be gone.
    const configCheck = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'dispatch_config'
       ) AS exists`,
    );
    expect(configCheck.rows[0]!.exists).toBe(false);

    // dispatch_requirement table should be gone.
    const reqCheck = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'dispatch_requirement'
       ) AS exists`,
    );
    expect(reqCheck.rows[0]!.exists).toBe(false);

    // Index should also be gone.
    const idxCheck = await pg2.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'dispatch_requirement_org_resource_idx'`,
    );
    expect(idxCheck.rows[0]!.count).toBe('0');
  });
});
