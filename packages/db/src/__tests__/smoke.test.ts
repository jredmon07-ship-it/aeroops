/**
 * smoke.test.ts — Slice 0.1 RLS smoke test.
 *
 * Proves the migration artifact works end-to-end in PGlite:
 *
 * (a) In Org A context, SELECT location/app_user returns only A rows.
 * (b) Unset context → 0 rows (fail-closed).
 * (c) Cross-org INSERT (org_id=B while in A context) is rejected.
 * (d) FORCE guard: even with no GUC, non-superuser sees 0 tenant rows.
 * (e) plan/subscription are visible regardless of tenant context.
 *
 * PGlite-specific note: PGlite connects as postgres (superuser). Superusers
 * bypass RLS unconditionally in Postgres — FORCE ROW LEVEL SECURITY only
 * overrides the table-owner exemption for non-superuser owners, NOT the
 * superuser exemption. The test calls setTestAppRole() after seeding to drop
 * to the 'aeroops_app' non-superuser role, after which all RLS policies are
 * enforced. This mirrors the production requirement.
 *
 * This is the schema-engineer's smoke test. The full T1-T14 suite is
 * the test-writer's responsibility in /qa.
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
  seedTwoOrgs,
  withOrgContext,
} from '../index.js';
// FIX 6: bare session-scope primitives are not on the public index — import
// directly from the module for test/internal use only.
import { clearOrgContext } from '../org-context.js';
import { location, appUser, plan, subscription } from '../schema/index.js';
import type { PgliteTestClient } from '../client.js';

// Resolve migration file paths relative to THIS test file.
// Both migrations are applied in order so the test env matches the full
// real schema — applyMigrationSql accepts an array and applies them in sequence.
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

// ── Test state ─────────────────────────────────────────────────────────────────
let db: PgliteTestClient;
let pglite: PGlite;
let orgAId: string;
let orgBId: string;
let planId: string;

beforeAll(async () => {
  // 1. Spin up a fresh in-memory PGlite and apply the REAL migration (as superuser)
  ({ db, pglite } = await createTestClient());
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  // 2. Seed two orgs (as superuser — RLS is bypassed during setup)
  const seed = await seedTwoOrgs(db);
  ({ orgAId, orgBId, planId } = seed);

  // 3. Drop to non-superuser role so RLS is enforced for all test assertions.
  //    This is the key step: PGlite's postgres user bypasses RLS unconditionally.
  //    All assertions below run as aeroops_app (non-superuser) where RLS applies.
  await setTestAppRole({ pglite });
});

// ── (a) In Org A context: only Org A rows visible ────────────────────────────
describe('(a) Org A context — isolation', () => {
  it('SELECT location returns only Org A rows', async () => {
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(location).execute(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.orgId).toBe(orgAId);
  });

  it('SELECT app_user returns only Org A rows', async () => {
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(appUser).execute(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.orgId).toBe(orgAId);
  });

  it('Org B rows NOT visible in Org A context', async () => {
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(location).execute(),
    );
    const orgIds = rows.map((r) => r.orgId);
    expect(orgIds).not.toContain(orgBId);
  });
});

// ── (b) Unset context → 0 rows (fail-closed) ─────────────────────────────────
describe('(b) No context → fail-closed', () => {
  it('SELECT location with no org context returns 0 rows', async () => {
    // clearOrgContext sets GUC to '' → NULLIF → NULL → predicate false → no rows
    await clearOrgContext(db, { local: false });
    const rows = await db.select().from(location).execute();
    expect(rows.length).toBe(0);
  });

  it('SELECT app_user with no org context returns 0 rows', async () => {
    const rows = await db.select().from(appUser).execute();
    expect(rows.length).toBe(0);
  });
});

// ── (c) Cross-org INSERT is rejected ─────────────────────────────────────────
describe('(c) Cross-org INSERT rejected by RLS', () => {
  it('INSERT location with org_id=B while in Org A context is rejected', async () => {
    await expect(
      withOrgContext(db, orgAId, (tx) =>
        tx
          .insert(location)
          .values({ orgId: orgBId, name: 'Illegal Cross-Org Location' })
          .execute(),
      ),
    ).rejects.toThrow();
  });
});

// ── (d) Non-superuser with no GUC sees 0 tenant rows ─────────────────────────
describe('(d) Non-superuser + no GUC = 0 rows (RLS enforced)', () => {
  it('COUNT(*) from location returns 0 rows with no context', async () => {
    // We are aeroops_app (non-superuser) with no GUC set
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM location`,
    );
    expect(result.rows[0]!['count']).toBe('0');
  });

  it('COUNT(*) from app_user returns 0 rows with no context', async () => {
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM app_user`,
    );
    expect(result.rows[0]!['count']).toBe('0');
  });

  it('COUNT(*) from membership returns 0 rows with no context', async () => {
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM membership`,
    );
    expect(result.rows[0]!['count']).toBe('0');
  });
});

// ── (e) Platform tables visible regardless of org context ────────────────────
describe('(e) Platform tables — no RLS, always visible', () => {
  it('plan is visible without any org context', async () => {
    await clearOrgContext(db, { local: false });
    const rows = await db.select().from(plan).execute();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.id === planId)).toBe(true);
  });

  it('subscription is visible without any org context', async () => {
    const rows = await db.select().from(subscription).execute();
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('plan is visible even while in Org A context', async () => {
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(plan).execute(),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
