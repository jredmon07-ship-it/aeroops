/**
 * work-order-schema.test.ts — Schema tests for 0013_work_orders.sql (Slice M1.1).
 *
 * Proves spec §M1.1 schema acceptance criteria:
 *
 *   W1.  work_order table exists after migration 0013.
 *   W2.  FORCE RLS fail-closed: GUC unset → 0 rows from work_order.
 *   W3.  RLS isolation: org A cannot see org B's work_order rows.
 *   W4.  Composite FK cross-org rejection:
 *        W4a. resource_id from a different org → rejected.
 *        W4b. squawk_id from a different org → rejected.
 *        W4c. opened_by from a different org → rejected.
 *        W4d. signed_off_by from a different org → rejected (during UPDATE).
 *   W5.  ON DELETE RESTRICT: deleting a resource with WO rows is blocked.
 *        ON DELETE RESTRICT: deleting opened_by user with WO rows is blocked.
 *   W6.  ON DELETE SET NULL column-list behavior:
 *        W6a. Deleting the linked squawk → squawk_id = NULL, org_id preserved.
 *        W6b. Deleting signed_off_by user → signed_off_by = NULL, org_id preserved.
 *   W7.  CHECKs fire:
 *        W7a. work_order_title_nonempty_check: empty title → rejected.
 *        W7b. work_order_title_nonempty_check: blank-only title → rejected.
 *        W7c. work_order_completed_shape_check: status='completed' without signed_off_at → rejected.
 *        W7d. work_order_completed_shape_check: status='cancelled' without cancelled_at → rejected.
 *        W7e. work_order_completed_shape_check: status='open' with sign_off field set → rejected.
 *        W7f. work_order_completed_shape_check: status='open' with cancelled_at set → rejected.
 *        W7g. work_order_completed_shape_check: status='in_progress' with signed_off_by set → rejected.
 *   W8.  UNIQUE(id, org_id): index exists.
 *   W9.  Enum domain: invalid work_order_status value → rejected.
 *        Default status 'open' applies.
 *   W10. Happy-path round-trip:
 *        W10a. Open WO inserts and reads back correctly.
 *        W10b. Completed WO (with signed_off_at, no signed_off_by) → accepted.
 *        W10c. Cancelled WO (with cancelled_at) → accepted.
 *   W11. Down migration reverses 0013: work_order table gone, enum gone.
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies all 14 real
 * migration artifacts (0000–0013) in order so the constraint SQL validated
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
import { org, appUser, resource, squawk, workOrder } from '../schema/index.js';
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
];

const DOWN_0013 = readFileSync(
  resolve(__dirname, '../../migrations/0013_work_orders.down.sql'),
  'utf-8',
);

// ── Test environment ──────────────────────────────────────────────────────────

interface WorkOrderTestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;   // member of org A
  userA2Id: string;  // second member of org A (for sign-off tests)
  userBId: string;   // member of org B
  aircraftAId: string; // resource (kind='aircraft') in org A
  aircraftBId: string; // resource (kind='aircraft') in org B
  squawkAId: string;   // squawk linked to aircraftA in org A
  squawkBId: string;   // squawk linked to aircraftB in org B
}

async function setupWorkOrderEnv(): Promise<WorkOrderTestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha MRO', slug: 'alpha-wo' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta Flight Club', slug: 'beta-wo' })
      .returning();
    return [a[0]!, b[0]!];
  });

  const [userA, userA2, aircraftA, squawkA] = await withOrgContext(db, orgA.id, async (tx) => {
    const u1 = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'alice@alpha-wo.example', fullName: 'Alice A' })
      .returning();
    const u2 = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'mech@alpha-wo.example', fullName: 'Mech A' })
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
    const s = await tx
      .insert(squawk)
      .values({
        orgId: orgA.id,
        resourceId: r[0]!.id,
        title: 'Left nav light inop',
        severity: 'low',
        reportedBy: u1[0]!.id,
      })
      .returning();
    return [u1[0]!, u2[0]!, r[0]!, s[0]!];
  });

  const [userB, aircraftB, squawkB] = await withOrgContext(db, orgB.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgB.id, email: 'bob@beta-wo.example', fullName: 'Bob B' })
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
    const s = await tx
      .insert(squawk)
      .values({
        orgId: orgB.id,
        resourceId: r[0]!.id,
        title: 'Right brake spongy',
        severity: 'medium',
        reportedBy: u[0]!.id,
      })
      .returning();
    return [u[0]!, r[0]!, s[0]!];
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
    squawkAId: squawkA.id,
    squawkBId: squawkB.id,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function insertWorkOrder(
  pglite: PGlite,
  orgId: string,
  resourceId: string,
  openedBy: string,
  opts: {
    squawkId?: string;
    title?: string;
    description?: string;
    workPerformed?: string;
  } = {},
): Promise<string> {
  const r = await pglite.query<{ id: string }>(
    `INSERT INTO work_order (org_id, resource_id, opened_by, title, description, squawk_id, work_performed)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      orgId,
      resourceId,
      openedBy,
      opts.title ?? 'Replace oil filter',
      opts.description ?? null,
      opts.squawkId ?? null,
      opts.workPerformed ?? null,
    ],
  );
  return r.rows[0]!.id;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('work-order-schema: migration 0013 + constraints + RLS', () => {
  let env: WorkOrderTestEnv;

  beforeAll(async () => {
    env = await setupWorkOrderEnv();
  });

  // ── W1: Table exists after migration 0013 ────────────────────────────────────

  it('W1: work_order table exists after migration 0013', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'work_order'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  // ── W2: FORCE RLS fail-closed (GUC unset → 0 rows) ───────────────────────────

  it('W2: FORCE RLS fail-closed — GUC unset → 0 rows from work_order', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;

    // Seed one row first (superuser).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertWorkOrder(pglite, orgAId, aircraftAId, userAId, { title: 'W2 seed' });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Unset GUC → 0 rows (fail-closed).
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const r = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM work_order`,
    );
    expect(r.rows[0]!.count).toBe('0');
  });

  // ── W3: RLS isolation (org A cannot see org B rows) ──────────────────────────

  it('W3: RLS isolation — org A cannot see org B work_order rows', async () => {
    const { pglite, db, orgAId, orgBId, userAId, userBId, aircraftAId, aircraftBId } = env;

    // Seed one WO in each org (superuser).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertWorkOrder(pglite, orgBId, aircraftBId, userBId, { title: 'Org B WO' });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Org A context → only org A rows.
    const rowsA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(workOrder).execute(),
    );
    expect(rowsA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context → only org B rows.
    const rowsB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(workOrder).execute(),
    );
    expect(rowsB.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  // ── W4: Composite FK cross-org rejection ─────────────────────────────────────

  it('W4a: resource_id from a different org → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftBId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertWorkOrder(pglite, orgAId, aircraftBId, userAId, { title: 'Cross-org resource' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('W4b: squawk_id from a different org → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId, squawkBId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertWorkOrder(pglite, orgAId, aircraftAId, userAId, {
        title: 'Cross-org squawk',
        squawkId: squawkBId,
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('W4c: opened_by from a different org → rejected', async () => {
    const { pglite, orgAId, aircraftAId, userBId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertWorkOrder(pglite, orgAId, aircraftAId, userBId, { title: 'Cross-org opener' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('W4d: signed_off_by from a different org → rejected on UPDATE', async () => {
    const { pglite, orgAId, userAId, aircraftAId, userBId } = env;

    // Insert a valid open WO as superuser.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const woId = await insertWorkOrder(pglite, orgAId, aircraftAId, userAId, {
      title: 'W4d cross-org signer',
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Try to update with signed_off_by from org B — composite FK must reject.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `UPDATE work_order
         SET status = 'completed', signed_off_at = now(), signed_off_by = $1
         WHERE id = $2`,
        [userBId, woId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── W5: ON DELETE RESTRICT ────────────────────────────────────────────────────

  it('W5a: deleting a resource with WO rows is blocked (RESTRICT)', async () => {
    const { pglite, orgAId, orgBId, userBId, aircraftBId } = env;

    // Seed a WO on aircraftB in orgB.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertWorkOrder(pglite, orgBId, aircraftBId, userBId, { title: 'W5a restrict test' });
    await pglite.exec(`COMMIT`);

    // Attempt to hard-delete the aircraft → must fail (RESTRICT).
    await expect(
      pglite.query(`DELETE FROM resource WHERE id = $1`, [aircraftBId]),
    ).rejects.toThrow();
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('W5b: deleting opened_by user with WO rows is blocked (RESTRICT)', async () => {
    const { pglite, orgAId, orgBId, userBId, aircraftBId } = env;

    // The user B already has a WO from W5a; try to delete user B → must fail.
    await pglite.exec(`SET ROLE postgres`);
    await expect(
      pglite.query(`DELETE FROM app_user WHERE id = $1`, [userBId]),
    ).rejects.toThrow();
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── W6: ON DELETE SET NULL column-list (org_id preserved) ────────────────────

  it('W6a: deleting linked squawk → squawk_id = NULL, org_id preserved', async () => {
    const { pglite, orgAId, userAId, userA2Id, aircraftAId } = env;

    // Create a fresh squawk and a WO linked to it.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const sqResult = await pglite.query<{ id: string }>(
      `INSERT INTO squawk (org_id, resource_id, title, severity, reported_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgAId, aircraftAId, 'W6a nav light', 'low', userAId],
    );
    const tempSquawkId = sqResult.rows[0]!.id;
    const woResult = await pglite.query<{ id: string }>(
      `INSERT INTO work_order (org_id, resource_id, opened_by, title, squawk_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgAId, aircraftAId, userAId, 'W6a fix nav light', tempSquawkId],
    );
    const woId = woResult.rows[0]!.id;
    await pglite.exec(`COMMIT`);

    // Hard-delete the squawk → WO.squawk_id becomes NULL.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    // Squawk needs resolved status first? No — no RESTRICT on squawk hard-delete.
    await pglite.exec(`DELETE FROM squawk WHERE id = '${tempSquawkId}'`);
    await pglite.exec(`COMMIT`);

    // Verify squawk_id is NULL but org_id is preserved.
    const r = await pglite.query<{ squawk_id: string | null; org_id: string }>(
      `SELECT squawk_id, org_id FROM work_order WHERE id = $1`,
      [woId],
    );
    expect(r.rows[0]!.squawk_id).toBeNull();
    expect(r.rows[0]!.org_id).toBe(orgAId);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('W6b: deleting signed_off_by user → signed_off_by = NULL, org_id preserved', async () => {
    const { pglite, orgAId, userAId } = env;

    // Create a throwaway user (superuser — before aeroops_app drop).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const uResult = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`,
      [orgAId, 'throwaway@alpha-wo.example', 'Throwaway Mech'],
    );
    const throwUserId = uResult.rows[0]!.id;

    // Create a completed WO signed off by the throwaway user.
    const woResult = await pglite.query<{ id: string }>(
      `INSERT INTO work_order
         (org_id, resource_id, opened_by, title, status, signed_off_by, signed_off_at)
       VALUES ($1, $2, $3, $4, 'completed', $5, now()) RETURNING id`,
      [orgAId, env.aircraftAId, userAId, 'W6b sign-off test', throwUserId],
    );
    const woId = woResult.rows[0]!.id;
    await pglite.exec(`COMMIT`);

    // Hard-delete the throwaway user → signed_off_by becomes NULL.
    await pglite.query(`DELETE FROM app_user WHERE id = $1`, [throwUserId]);

    // Verify signed_off_by is NULL but org_id is preserved.
    const r = await pglite.query<{ signed_off_by: string | null; org_id: string }>(
      `SELECT signed_off_by, org_id FROM work_order WHERE id = $1`,
      [woId],
    );
    expect(r.rows[0]!.signed_off_by).toBeNull();
    expect(r.rows[0]!.org_id).toBe(orgAId);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── W7: CHECKs fire ──────────────────────────────────────────────────────────

  it('W7a: work_order_title_nonempty_check: empty title → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertWorkOrder(pglite, orgAId, aircraftAId, userAId, { title: '' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('W7b: work_order_title_nonempty_check: blank-only title → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertWorkOrder(pglite, orgAId, aircraftAId, userAId, { title: '   ' }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('W7c: completed without signed_off_at → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO work_order (org_id, resource_id, opened_by, title, status)
         VALUES ($1, $2, $3, $4, 'completed')`,
        [orgAId, aircraftAId, userAId, 'W7c bad completed'],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('W7d: cancelled without cancelled_at → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO work_order (org_id, resource_id, opened_by, title, status)
         VALUES ($1, $2, $3, $4, 'cancelled')`,
        [orgAId, aircraftAId, userAId, 'W7d bad cancelled'],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('W7e: status=open with sign_off_notes set → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO work_order
           (org_id, resource_id, opened_by, title, status, sign_off_notes)
         VALUES ($1, $2, $3, $4, 'open', 'some notes')`,
        [orgAId, aircraftAId, userAId, 'W7e open+signoff'],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('W7f: status=open with cancelled_at set → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO work_order
           (org_id, resource_id, opened_by, title, status, cancelled_at)
         VALUES ($1, $2, $3, $4, 'open', now())`,
        [orgAId, aircraftAId, userAId, 'W7f open+cancelled_at'],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('W7g: status=in_progress with signed_off_by set → rejected', async () => {
    const { pglite, orgAId, userAId, userA2Id, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO work_order
           (org_id, resource_id, opened_by, title, status, signed_off_by)
         VALUES ($1, $2, $3, $4, 'in_progress', $5)`,
        [orgAId, aircraftAId, userAId, 'W7g in_progress+signed_off_by', userA2Id],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── W8: UNIQUE(id, org_id) index exists ──────────────────────────────────────

  it('W8: UNIQUE(id, org_id) index exists on work_order', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_indexes
         WHERE tablename = 'work_order'
           AND indexname = 'work_order_id_org_id_unique'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  // ── W9: Enum domain ───────────────────────────────────────────────────────────

  it('W9a: invalid work_order_status value → rejected', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO work_order (org_id, resource_id, opened_by, title, status)
         VALUES ($1, $2, $3, $4, 'invalid_status'::work_order_status)`,
        [orgAId, aircraftAId, userAId, 'W9a bad enum'],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('W9b: default status is open', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const woId = await insertWorkOrder(pglite, orgAId, aircraftAId, userAId, {
      title: 'W9b default status',
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Use session-level set_config (not SET LOCAL which requires a transaction).
    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    const r = await pglite.query<{ status: string }>(
      `SELECT status FROM work_order WHERE id = $1`,
      [woId],
    );
    expect(r.rows[0]!.status).toBe('open');
  });

  // ── W10: Happy-path round-trips ───────────────────────────────────────────────

  it('W10a: open WO inserts and reads back correctly', async () => {
    const { pglite, db, orgAId, userAId, aircraftAId, squawkAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const woId = await insertWorkOrder(pglite, orgAId, aircraftAId, userAId, {
      title: 'W10a oil change',
      description: 'Replace oil and filter',
      squawkId: squawkAId,
      workPerformed: 'Drained old oil',
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Direct pglite query to verify (RLS in effect — aeroops_app role + GUC set below).
    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    const row = await pglite.query<{
      id: string;
      org_id: string;
      resource_id: string;
      squawk_id: string;
      title: string;
      status: string;
      opened_by: string;
    }>(
      `SELECT id, org_id, resource_id, squawk_id, title, status, opened_by
       FROM work_order WHERE id = $1`,
      [woId],
    );
    const r = row.rows[0]!;
    expect(r.id).toBe(woId);
    expect(r.org_id).toBe(orgAId);
    expect(r.resource_id).toBe(aircraftAId);
    expect(r.squawk_id).toBe(squawkAId);
    expect(r.title).toBe('W10a oil change');
    expect(r.status).toBe('open');
    expect(r.opened_by).toBe(userAId);
  });

  it('W10b: completed WO (with signed_off_at, no signed_off_by) → accepted', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    // Completed with signed_off_at present, signed_off_by NULL (permitted per spec).
    const r = await pglite.query<{ id: string; status: string; signed_off_by: string | null }>(
      `INSERT INTO work_order
         (org_id, resource_id, opened_by, title, status, signed_off_at, work_performed)
       VALUES ($1, $2, $3, $4, 'completed', now(), $5)
       RETURNING id, status, signed_off_by`,
      [orgAId, aircraftAId, userAId, 'W10b completed WO', 'Replaced oil filter'],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(r.rows[0]!.status).toBe('completed');
    expect(r.rows[0]!.signed_off_by).toBeNull();
  });

  it('W10c: cancelled WO (with cancelled_at) → accepted', async () => {
    const { pglite, orgAId, userAId, aircraftAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const r = await pglite.query<{ id: string; status: string }>(
      `INSERT INTO work_order
         (org_id, resource_id, opened_by, title, status, cancelled_at, cancelled_reason)
       VALUES ($1, $2, $3, $4, 'cancelled', now(), 'Duplicate WO')
       RETURNING id, status`,
      [orgAId, aircraftAId, userAId, 'W10c cancelled WO'],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(r.rows[0]!.status).toBe('cancelled');
  });

  // ── W11: Down migration reverses 0013 ────────────────────────────────────────

  it('W11: down migration reverses 0013 — table and enum gone', async () => {
    // Spin up a separate isolated client for down-migration test.
    const { db: db2, pglite: pg2 } = await createTestClient();
    await applyMigrationSql({ pglite: pg2 }, MIGRATION_SQL);

    // Verify table exists before down.
    const before = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'work_order'
       ) AS exists`,
    );
    expect(before.rows[0]!.exists).toBe(true);

    // Apply the down migration.
    await pg2.exec(DOWN_0013);

    // Table must be gone.
    const afterTable = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'work_order'
       ) AS exists`,
    );
    expect(afterTable.rows[0]!.exists).toBe(false);

    // Enum type must be gone.
    const afterEnum = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_type WHERE typname = 'work_order_status'
       ) AS exists`,
    );
    expect(afterEnum.rows[0]!.exists).toBe(false);
  });
});
