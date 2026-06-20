/**
 * security-fixes.test.ts — Regression tests for Slice 0.1 QA fixes.
 *
 * FIX 1 regression: setOrgContext / withOrgContext with a malicious string
 *   containing '; ...' is rejected by validateUuid (injection is structurally
 *   impossible via parameterization, but validateUuid is defense-in-depth).
 *   Happy-path: a valid UUID still sets context correctly.
 *
 *   Note: PGlite uses the extended (parameterized) query protocol internally,
 *   so it cannot itself exercise the stacked-statement attack path that
 *   postgres-js's simple-query protocol would allow with sql.raw. A real-
 *   Postgres CI smoke is tracked for Slice 0.4 to verify the extended-protocol
 *   path on the wire.
 *
 * FIX 4 regression: under withPlatformAdminContext, INSERT INTO org RETURNING
 *   returns the row (org_select policy now also permits platform_admin='on'),
 *   and SELECT org sees all orgs; while under a normal tenant context SELECT org
 *   still returns only that org (T10 invariant preserved).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  seedTwoOrgs,
  withOrgContext,
  withPlatformAdminContext,
} from '../index.js';
import { setOrgContext } from '../org-context.js';
import { org } from '../schema/index.js';
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteTestClient } from '../client.js';

// Both migrations applied in order so pglite schema matches the full artifact.
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
];

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
}

async function setupFreshEnv(): Promise<TestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });
  return { db, pglite, orgAId: seed.orgAId, orgBId: seed.orgBId };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1 — Parameterized set_config / injection regression
// These tests never mutate committed state (rejections roll back); one shared
// env is safe.
// ─────────────────────────────────────────────────────────────────────────────
describe('FIX 1: validateUuid rejects malicious/non-UUID strings', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });

  it('setOrgContext with a stacked-statement injection string is rejected', async () => {
    const { db } = env;
    // A string that looks like a UUID but contains injection payload.
    // validateUuid must reject this before it ever reaches the DB.
    await expect(
      setOrgContext(db, "'; SELECT set_config('app.platform_admin','on',false); --", {
        local: false,
      }),
    ).rejects.toThrow('[org-context]');
  });

  it('setOrgContext with an empty string is rejected', async () => {
    const { db } = env;
    await expect(
      setOrgContext(db, '', { local: false }),
    ).rejects.toThrow('[org-context]');
  });

  it('setOrgContext with a non-UUID string is rejected', async () => {
    const { db } = env;
    await expect(
      setOrgContext(db, 'not-a-uuid', { local: false }),
    ).rejects.toThrow('[org-context]');
  });

  it('withOrgContext with a malicious string is rejected by validateUuid', async () => {
    const { db } = env;
    await expect(
      withOrgContext(
        db,
        "00000000-0000-0000-0000-000000000000'; SELECT set_config('app.platform_admin','on',false);--",
        async () => [],
      ),
    ).rejects.toThrow('[org-context]');
  });

  it('happy path: valid UUID sets context and returns correct rows', async () => {
    const { db, orgAId } = env;
    // setOrgContext with a real UUID must work
    await setOrgContext(db, orgAId, { local: false });
    const rows = await db.select().from(org).execute();
    // Under orgAId context, only Org A is visible
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(orgAId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 4 — Platform-admin org read (INSERT RETURNING + SELECT all orgs)
// The INSERT test adds a new org; this is additive and doesn't affect the
// SELECT-all test (it will see one more org, which is fine — we only check
// that orgA and orgB are present). One shared env.
// ─────────────────────────────────────────────────────────────────────────────
describe('FIX 4: withPlatformAdminContext can INSERT org RETURNING and SELECT all orgs', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });

  it('INSERT INTO org RETURNING returns the inserted row under platform-admin context', async () => {
    const { db } = env;
    // Run as aeroops_app (non-superuser) under platform-admin context
    const rows = await withPlatformAdminContext(db, async (tx) => {
      return tx
        .insert(org)
        .values({ name: 'Gamma Charter', slug: 'gamma' })
        .returning();
    });
    // FIX 4: org_select now permits platform_admin='on', so RETURNING works
    expect(rows.length).toBe(1);
    expect(rows[0]!.name).toBe('Gamma Charter');
    expect(rows[0]!.slug).toBe('gamma');
  });

  it('SELECT org under platform-admin context returns all orgs', async () => {
    const { db, orgAId, orgBId } = env;
    const rows = await withPlatformAdminContext(db, async (tx) => {
      return tx.select().from(org).execute();
    });
    // Both seeded orgs should be visible (no org_id filter under platform-admin)
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(orgAId);
    expect(ids).toContain(orgBId);
  });

  it('SELECT org under normal tenant context still returns only that org (T10 preserved)', async () => {
    const { db, orgAId, orgBId } = env;
    const rowsA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(org).execute(),
    );
    expect(rowsA.length).toBe(1);
    expect(rowsA[0]!.id).toBe(orgAId);
    expect(rowsA.some((r) => r.id === orgBId)).toBe(false);

    const rowsB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(org).execute(),
    );
    expect(rowsB.length).toBe(1);
    expect(rowsB[0]!.id).toBe(orgBId);
    expect(rowsB.some((r) => r.id === orgAId)).toBe(false);
  });
});
