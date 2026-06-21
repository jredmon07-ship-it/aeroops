/**
 * optimizer-run-schema.test.ts — Schema tests for 0011_optimizer_run.sql (Slice 4b).
 *
 * Proves spec §4b.1 schema acceptance criteria:
 *   T1.  schedule_optimization_run table exists after migration 0011.
 *   T2.  FORCE RLS fail-closed: GUC unset → 0 rows.
 *   T3.  RLS isolation: org A cannot see org B's run rows.
 *   T4.  Composite FK (requested_by, org_id) cross-org rejection:
 *        requested_by from a different org → rejected.
 *   T5.  org_id ON DELETE CASCADE: deleting an org removes its runs.
 *   T6.  requested_by ON DELETE RESTRICT: deleting a user with run rows → blocked.
 *   T7.  insert with input_jsonb round-trips (JSONB stored and retrieved).
 *   T8.  seed column: bigint round-trips correctly (JS-safe integer).
 *   T9.  UNIQUE (id, org_id) — duplicate (id, org_id) rejected (not testable via
 *        normal INSERT since id is PK; test via confirming the index exists instead).
 *   T10. schedule_optimization_run_counts_check:
 *        (a) negative created_count → rejected.
 *        (b) negative skipped_count → rejected.
 *        (c) zero counts → accepted.
 *   T11. created_count defaults to 0; skipped_count defaults to 0.
 *   T12. No updated_at column (INSERT-once posture).
 *   T13. created_at defaults to now (non-null timestamp on insert).
 *   T14. seed is nullable (NULL seed accepted).
 *   T15. Down migration reverses 0011: table gone, indexes gone.
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies all twelve real
 * migration artifacts (0000–0011) in order so the constraint SQL validated
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
  scheduleOptimizationRun,
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

const DOWN_0011 = readFileSync(
  resolve(__dirname, '../../migrations/0011_optimizer_run.down.sql'),
  'utf-8',
);

// ── Test environment ──────────────────────────────────────────────────────────

interface OptimizerRunTestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;  // member of org A (requester)
  userBId: string;  // member of org B
}

async function setupOptimizerRunEnv(): Promise<OptimizerRunTestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha Optimizer School', slug: 'alpha-optimizer' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta Optimizer Club', slug: 'beta-optimizer' })
      .returning();
    return [a[0]!, b[0]!];
  });

  const userARows = await withOrgContext(db, orgA.id, async (tx) => {
    return tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'alice@optimizer.example', fullName: 'Alice Optimizer' })
      .returning();
  });

  const userBRows = await withOrgContext(db, orgB.id, async (tx) => {
    return tx
      .insert(appUser)
      .values({ orgId: orgB.id, email: 'bob@optimizer.example', fullName: 'Bob Optimizer' })
      .returning();
  });

  // Drop to aeroops_app for RLS enforcement on all subsequent queries.
  await setTestAppRole({ pglite });

  return {
    db,
    pglite,
    orgAId: orgA.id,
    orgBId: orgB.id,
    userAId: userARows[0]!.id,
    userBId: userBRows[0]!.id,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SAMPLE_INPUT = {
  demands: [{ id: 'd1', durationMinutes: 60, requiredResourceIds: [] }],
  objective: 'maximize_utilization',
};

/**
 * Inserts a valid schedule_optimization_run row.
 * Caller is responsible for setting GUC in the surrounding transaction.
 */
async function insertRun(
  pglite: PGlite,
  orgId: string,
  requestedBy: string,
  opts: {
    input?: unknown;
    seed?: number | null;
    createdCount?: number;
    skippedCount?: number;
  } = {},
): Promise<string> {
  const {
    input = SAMPLE_INPUT,
    seed = 12345,
    createdCount = 0,
    skippedCount = 0,
  } = opts;
  const result = await pglite.query<{ id: string }>(
    `INSERT INTO schedule_optimization_run
       (org_id, requested_by, input_jsonb, seed, created_count, skipped_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [orgId, requestedBy, JSON.stringify(input), seed, createdCount, skippedCount],
  );
  return result.rows[0]!.id;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('optimizer-run-schema: migration 0011 + constraints + RLS', () => {
  let env: OptimizerRunTestEnv;

  beforeAll(async () => {
    env = await setupOptimizerRunEnv();
  });

  // ── T1: Table exists after migration 0011 ────────────────────────────────

  it('T1: schedule_optimization_run table exists after migration 0011', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'schedule_optimization_run'
       ) AS exists`,
    );
    expect(result.rows[0]!.exists).toBe(true);
  });

  // ── T2: FORCE RLS fail-closed ────────────────────────────────────────────

  it('T2: FORCE RLS fail-closed — GUC unset → 0 rows', async () => {
    const { pglite } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schedule_optimization_run`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  // ── T3: RLS isolation ────────────────────────────────────────────────────

  it('T3: RLS isolation — org A cannot see org B run rows', async () => {
    const { pglite, db, orgAId, orgBId, userAId, userBId } = env;

    // Seed one run for each org as superuser.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertRun(pglite, orgAId, userAId);
    await pglite.exec(`COMMIT`);

    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertRun(pglite, orgBId, userBId);
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Org A context — must not see org B rows.
    const rowsUnderA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(scheduleOptimizationRun).execute(),
    );
    expect(rowsUnderA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsUnderA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context — must see org B rows, not org A rows.
    const rowsUnderB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(scheduleOptimizationRun).execute(),
    );
    expect(rowsUnderB.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsUnderB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  // ── T4: Composite FK (requested_by, org_id) cross-org rejection ──────────

  it('T4: composite FK (requested_by, org_id) rejects a requester from a different org', async () => {
    const { pglite, orgAId, userBId } = env;
    // requested_by belongs to org B but org_id is org A — must fail FK check.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRun(pglite, orgAId, userBId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── T5: org_id ON DELETE CASCADE ─────────────────────────────────────────

  it('T5: CASCADE — deleting an org removes its schedule_optimization_run rows', async () => {
    const { pglite } = env;

    // Create a disposable org + user + run as superuser.
    await pglite.exec(`SET ROLE postgres`);
    const orgResult = await pglite.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ('Cascade Test Org', 'cascade-opt-org') RETURNING id`,
    );
    const tempOrgId = orgResult.rows[0]!.id;
    const userResult = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name)
       VALUES ($1, 'cascade@cascade-opt-org.example', 'Cascade User')
       RETURNING id`,
      [tempOrgId],
    );
    const tempUserId = userResult.rows[0]!.id;

    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${tempOrgId}'`);
    const runResult = await pglite.query<{ id: string }>(
      `INSERT INTO schedule_optimization_run (org_id, requested_by, input_jsonb)
       VALUES ($1, $2, '{}')
       RETURNING id`,
      [tempOrgId, tempUserId],
    );
    const runId = runResult.rows[0]!.id;
    await pglite.exec(`COMMIT`);

    // Delete the org — run should cascade-delete.
    await pglite.query(`DELETE FROM org WHERE id = $1`, [tempOrgId]);

    // Verify the run is gone (context: no org, query as superuser).
    const check = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schedule_optimization_run WHERE id = $1`,
      [runId],
    );
    expect(check.rows[0]!.count).toBe('0');

    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── T6: requested_by ON DELETE RESTRICT ──────────────────────────────────

  it('T6: RESTRICT — deleting a user who requested a run is blocked', async () => {
    const { pglite, orgAId } = env;

    // Create a disposable user with a run — as superuser.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const requesterResult = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name)
       VALUES ($1, 'restrict-requester@alpha.example', 'Restrict Requester')
       RETURNING id`,
      [orgAId],
    );
    const requesterId = requesterResult.rows[0]!.id;
    await pglite.query(
      `INSERT INTO schedule_optimization_run (org_id, requested_by, input_jsonb)
       VALUES ($1, $2, '{"test":true}')`,
      [orgAId, requesterId],
    );
    await pglite.exec(`COMMIT`);

    // Attempt to delete the requester — must fail (RESTRICT).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(`DELETE FROM app_user WHERE id = $1`, [requesterId]),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── T7: input_jsonb round-trips ───────────────────────────────────────────

  it('T7: input_jsonb round-trips — stored and retrieved correctly', async () => {
    const { pglite, db, orgAId, userAId } = env;

    const payload = {
      demands: [
        { id: 'demand-1', durationMinutes: 90, requiredResourceIds: ['abc', 'def'], priority: 1 },
      ],
      objective: 'maximize_sessions_scheduled',
      seed: 99999,
    };

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const runId = await insertRun(pglite, orgAId, userAId, { input: payload, seed: 99999 });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(scheduleOptimizationRun).execute(),
    );
    const run = rows.find((r) => r.id === runId);
    expect(run).toBeDefined();
    // JSONB round-trips to equivalent object (key order may differ).
    expect(run!.inputJsonb).toEqual(payload);
  });

  // ── T8: seed bigint round-trips ───────────────────────────────────────────

  it('T8: seed (bigint, mode:number) round-trips JS-safe integer', async () => {
    const { pglite, db, orgAId, userAId } = env;

    // Use Number.MAX_SAFE_INTEGER to prove 53-bit fidelity.
    const jsSafeMax = Number.MAX_SAFE_INTEGER; // 9007199254740991

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const runId = await insertRun(pglite, orgAId, userAId, { seed: jsSafeMax });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(scheduleOptimizationRun).execute(),
    );
    const run = rows.find((r) => r.id === runId);
    expect(run).toBeDefined();
    expect(run!.seed).toBe(jsSafeMax);
  });

  // ── T9: UNIQUE (id, org_id) index exists ─────────────────────────────────

  it('T9: UNIQUE index schedule_optimization_run_id_org_id_unique exists', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'schedule_optimization_run'
         AND indexname = 'schedule_optimization_run_id_org_id_unique'`,
    );
    expect(result.rows[0]!.count).toBe('1');
  });

  // ── T10: schedule_optimization_run_counts_check ───────────────────────────

  it('T10a: counts_check — negative created_count is rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRun(pglite, orgAId, userAId, { createdCount: -1 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T10b: counts_check — negative skipped_count is rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertRun(pglite, orgAId, userAId, { skippedCount: -1 }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T10c: counts_check — zero counts are accepted', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const id = await insertRun(pglite, orgAId, userAId, { createdCount: 0, skippedCount: 0 });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── T11: Default counts ───────────────────────────────────────────────────

  it('T11: created_count and skipped_count default to 0', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const result = await pglite.query<{ created_count: number; skipped_count: number }>(
      `INSERT INTO schedule_optimization_run (org_id, requested_by, input_jsonb)
       VALUES ($1, $2, '{}')
       RETURNING created_count, skipped_count`,
      [orgAId, userAId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);
    expect(result.rows[0]!.created_count).toBe(0);
    expect(result.rows[0]!.skipped_count).toBe(0);
  });

  // ── T12: No updated_at column (INSERT-once posture) ──────────────────────

  it('T12: schedule_optimization_run has no updated_at column (INSERT-once)', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'schedule_optimization_run'
           AND column_name = 'updated_at'
       ) AS exists`,
    );
    expect(result.rows[0]!.exists).toBe(false);
  });

  // ── T13: created_at defaults to now ──────────────────────────────────────

  it('T13: created_at is non-null and recent on insert (defaults to now())', async () => {
    const { pglite, orgAId, userAId } = env;
    const before = Date.now();
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const result = await pglite.query<{ created_at: string }>(
      `INSERT INTO schedule_optimization_run (org_id, requested_by, input_jsonb)
       VALUES ($1, $2, '{}')
       RETURNING created_at`,
      [orgAId, userAId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);
    const after = Date.now();
    const createdAtMs = new Date(result.rows[0]!.created_at).getTime();
    expect(createdAtMs).toBeGreaterThanOrEqual(before - 2000);
    expect(createdAtMs).toBeLessThanOrEqual(after + 2000);
  });

  // ── T14: seed is nullable ────────────────────────────────────────────────

  it('T14: NULL seed is accepted (unseeded run)', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const result = await pglite.query<{ seed: number | null }>(
      `INSERT INTO schedule_optimization_run (org_id, requested_by, input_jsonb, seed)
       VALUES ($1, $2, '{}', NULL)
       RETURNING seed`,
      [orgAId, userAId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);
    expect(result.rows[0]!.seed).toBeNull();
  });

  // ── T15: Down migration reverses 0011 ────────────────────────────────────

  it('T15: down migration cleanly reverses 0011 — table and indexes gone', async () => {
    // Spin up a fresh DB, apply all migrations, then run down.
    const { pglite: pg2 } = await createTestClient();
    await applyMigrationSql({ pglite: pg2 }, MIGRATION_SQL);
    await applyMigrationSql({ pglite: pg2 }, [DOWN_0011]);

    // schedule_optimization_run table should be gone.
    const tableCheck = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'schedule_optimization_run'
       ) AS exists`,
    );
    expect(tableCheck.rows[0]!.exists).toBe(false);

    // Listing index should be gone.
    const listIdxCheck = await pg2.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'schedule_optimization_run_org_created_idx'`,
    );
    expect(listIdxCheck.rows[0]!.count).toBe('0');

    // Composite candidate key index should be gone.
    const uniqueIdxCheck = await pg2.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'schedule_optimization_run_id_org_id_unique'`,
    );
    expect(uniqueIdxCheck.rows[0]!.count).toBe('0');
  });
});
