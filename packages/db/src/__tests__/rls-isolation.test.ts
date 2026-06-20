/**
 * rls-isolation.test.ts — Full Slice 0.1 RLS/tenant-isolation test suite.
 *
 * Covers every T1-T14 case from the architect spec plus two property-based
 * tests (PBT-1 and PBT-2) using fast-check.
 *
 * PERFORMANCE DESIGN:
 *   - Each describe-block shares ONE PGlite instance via beforeAll/beforeEach.
 *     Cold-starting PGlite (WASM + migration) is expensive; we do it once per
 *     group, not once per it().
 *   - Groups that mutate shared state (T2, T5) use beforeEach to get a fresh
 *     env per test; groups whose mutations are self-contained (T14, T3, T4 etc.)
 *     or read-only share a single beforeAll env.
 *   - T6 / T7 / T9 modify session-level GUCs; they share a beforeAll env but
 *     reset the GUC cheaply via beforeEach (no cold-start).
 *   - T12 batches all 8 role inserts into a single withOrgContext transaction.
 *   - PBT-1 / PBT-2: one shared beforeAll env; each fast-check iteration
 *     creates a FRESH ORG PAIR via withPlatformAdminContext instead of
 *     re-bootstrapping PGlite. The isolation invariant is identical: queries
 *     under org X return only org X's rows. numRuns >= 10.
 *
 * Key rule: PGlite runs as postgres (superuser). Superusers bypass RLS
 * unconditionally in Postgres — FORCE ROW LEVEL SECURITY only overrides
 * the table-owner exemption for non-superuser owners, NOT the superuser
 * exemption. After setTestAppRole() we are aeroops_app (non-superuser)
 * and all policies are enforced.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as fc from 'fast-check';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  seedTwoOrgs,
  withOrgContext,
  withPlatformAdminContext,
  execRaw,
} from '../index.js';
// FIX 6: bare session-scope primitives are not on the public index — import
// directly from the module for test/internal use only.
import { setOrgContext, clearOrgContext } from '../org-context.js';
import {
  org,
  location,
  appUser,
  membership,
  auditLog,
  plan,
  subscription,
  membershipRole,
} from '../schema/index.js';
import { MEMBERSHIP_ROLES } from '@aeroops/core';
import type { PgliteTestClient } from '../client.js';

// ── Path resolution ───────────────────────────────────────────────────────────
// Both migrations are applied in order to every fresh env so the pglite schema
// always matches the full real artifact. applyMigrationSql accepts an array.
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

// ── Helper: set up a fresh isolated DB (one cold-start per call) ──────────────
interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  locationAId: string;
  locationBId: string;
  userAId: string;
  userBId: string;
  membershipAId: string;
  membershipBId: string;
  planId: string;
  subscriptionAId: string;
  subscriptionBId: string;
}

async function setupFreshEnv(): Promise<TestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });
  return { db, pglite, ...seed };
}

// ─────────────────────────────────────────────────────────────────────────────
// T1 — Cross-org SELECT → 0 rows (per tenant table)
// One shared env for the whole describe; the audit_log test inserts rows but
// they are scoped to specific tables that the other tests don't read.
// ─────────────────────────────────────────────────────────────────────────────
describe('T1: cross-org SELECT returns 0 rows', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });

  it('location: Org A context cannot see Org B rows', async () => {
    const { db, orgAId, orgBId } = env;
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(location).execute(),
    );
    expect(rows.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rows.some((r) => r.orgId === orgBId)).toBe(false);
  });

  it('app_user: Org A context cannot see Org B rows', async () => {
    const { db, orgAId, orgBId } = env;
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(appUser).execute(),
    );
    expect(rows.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rows.some((r) => r.orgId === orgBId)).toBe(false);
  });

  it('membership: Org A context cannot see Org B rows', async () => {
    const { db, orgAId, orgBId } = env;
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(membership).execute(),
    );
    expect(rows.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rows.some((r) => r.orgId === orgBId)).toBe(false);
  });

  it('audit_log: Org A context cannot see Org B rows', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = env;

    // Insert audit_log rows for both orgs. Since audit_log starts empty in
    // the seeded env, these inserts are safe to do once at this point.
    await withOrgContext(db, orgAId, (tx) =>
      tx.insert(auditLog).values({
        orgId: orgAId,
        actorUserId: userAId,
        action: 'test.event',
        entityType: 'location',
        entityId: null,
        metadata: {},
      }).execute(),
    );
    await withOrgContext(db, orgBId, (tx) =>
      tx.insert(auditLog).values({
        orgId: orgBId,
        actorUserId: userBId,
        action: 'test.event',
        entityType: 'location',
        entityId: null,
        metadata: {},
      }).execute(),
    );

    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).execute(),
    );
    expect(rows.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rows.some((r) => r.orgId === orgBId)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — Same-org CRUD works
// These tests mutate the env (INSERT, UPDATE, DELETE), so each gets its own
// fresh env via beforeEach to keep them independent.
// ─────────────────────────────────────────────────────────────────────────────
describe('T2: same-org CRUD succeeds within Org A context', () => {
  let env: TestEnv;
  beforeEach(async () => { env = await setupFreshEnv(); });

  it('INSERT + SELECT works for location within Org A', async () => {
    const { db, orgAId } = env;
    await withOrgContext(db, orgAId, (tx) =>
      tx.insert(location).values({ orgId: orgAId, name: 'New Base', icao: 'KNEW' }).execute(),
    );
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(location).execute(),
    );
    expect(rows.length).toBe(2); // seeded 1 + the one we just inserted
    expect(rows.some((r) => r.name === 'New Base')).toBe(true);
  });

  it('UPDATE works for location within Org A', async () => {
    const { db, orgAId, locationAId } = env;
    await withOrgContext(db, orgAId, (tx) =>
      tx.update(location).set({ name: 'Updated Name' }).where(eq(location.id, locationAId)).execute(),
    );
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(location).where(eq(location.id, locationAId)).execute(),
    );
    expect(rows[0]!.name).toBe('Updated Name');
  });

  it('DELETE works for location within Org A', async () => {
    const { db, orgAId, locationAId } = env;
    await withOrgContext(db, orgAId, (tx) =>
      tx.delete(location).where(eq(location.id, locationAId)).execute(),
    );
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(location).where(eq(location.id, locationAId)).execute(),
    );
    expect(rows.length).toBe(0);
  });

  it('INSERT + SELECT works for app_user within Org A', async () => {
    const { db, orgAId } = env;
    await withOrgContext(db, orgAId, (tx) =>
      tx.insert(appUser).values({ orgId: orgAId, email: 'charlie@alpha.example', fullName: 'Charlie A' }).execute(),
    );
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(appUser).execute(),
    );
    expect(rows.length).toBe(2); // seeded 1 + new
    expect(rows.some((r) => r.email === 'charlie@alpha.example')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — Cross-org INSERT rejected by WITH CHECK
// Rejections don't alter committed state; one env suffices.
// ─────────────────────────────────────────────────────────────────────────────
describe('T3: cross-org INSERT rejected by WITH CHECK', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });

  it('location: INSERT with org_id=B while in Org A context is rejected', async () => {
    const { db, orgAId, orgBId } = env;
    await expect(
      withOrgContext(db, orgAId, (tx) =>
        tx.insert(location).values({ orgId: orgBId, name: 'Cross-Org Loc' }).execute(),
      ),
    ).rejects.toThrow();
  });

  it('app_user: INSERT with org_id=B while in Org A context is rejected', async () => {
    const { db, orgAId, orgBId } = env;
    await expect(
      withOrgContext(db, orgAId, (tx) =>
        tx.insert(appUser).values({ orgId: orgBId, email: 'evil@alpha.example' }).execute(),
      ),
    ).rejects.toThrow();
  });

  it('membership: INSERT with org_id=B while in Org A context is rejected', async () => {
    const { db, orgAId, orgBId, userBId } = env;
    // Attempt to insert a membership row for Org B while in Org A context
    await expect(
      withOrgContext(db, orgAId, (tx) =>
        tx.insert(membership).values({ orgId: orgBId, userId: userBId, role: 'student' }).execute(),
      ),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — Cross-org UPDATE blocked
// Rejections + silent 0-row updates don't alter committed cross-org state.
// One env suffices; the spurious extra createTestClient() from the original
// is removed.
// ─────────────────────────────────────────────────────────────────────────────
describe('T4: cross-org UPDATE blocked', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });

  it('UPDATE Org B location by ID while in Org A context → 0 affected rows', async () => {
    const { db, orgAId, locationBId } = env;
    // USING predicate filters out Org B rows entirely — the UPDATE simply
    // sees no matching rows (0 affected, no error).
    await withOrgContext(db, orgAId, (tx) =>
      tx.update(location).set({ name: 'Hijacked' }).where(eq(location.id, locationBId)).execute(),
    );
    // Under Org A context Org B row is invisible (proves the UPDATE hit 0 rows)
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(location).where(eq(location.id, locationBId)).execute(),
    );
    expect(rows.length).toBe(0);
  });

  it('UPDATE Org A location setting org_id=B rejected by WITH CHECK', async () => {
    const { db, orgAId, orgBId, locationAId } = env;
    await expect(
      withOrgContext(db, orgAId, (tx) =>
        tx.update(location).set({ orgId: orgBId }).where(eq(location.id, locationAId)).execute(),
      ),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T5 — Cross-org DELETE → 0 rows; B's data intact
// Each test deletes from the seeded env so they each need a fresh env.
// ─────────────────────────────────────────────────────────────────────────────
describe('T5: cross-org DELETE → 0 rows; target org data intact', () => {
  let env: TestEnv;
  beforeEach(async () => { env = await setupFreshEnv(); });

  it('DELETE on Org B location while in Org A context → 0 affected (USING predicate)', async () => {
    const { db, orgAId, orgBId, locationBId } = env;
    // Issue delete targeting B's location id under A's context
    // RLS USING predicate filters it out silently → 0 rows affected
    await withOrgContext(db, orgAId, (tx) =>
      tx.delete(location).where(eq(location.id, locationBId)).execute(),
    );

    // Prove Org B location still exists by reading it under Org B context
    const rows = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(location).where(eq(location.id, locationBId)).execute(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(locationBId);
  });

  it('DELETE on Org B app_user while in Org A context → Org B user intact', async () => {
    const { db, orgAId, orgBId, userBId } = env;
    await withOrgContext(db, orgAId, (tx) =>
      tx.delete(appUser).where(eq(appUser.id, userBId)).execute(),
    );
    const rows = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(appUser).where(eq(appUser.id, userBId)).execute(),
    );
    expect(rows.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T6 — Unset context fails closed (no GUC → 0 rows; INSERT denied)
// One cold-start; GUC is reset cheaply (no PGlite restart) before each test.
// ─────────────────────────────────────────────────────────────────────────────
describe('T6: unset GUC context fails closed', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });
  // Reset session GUC before each test so no test inherits a set context.
  beforeEach(async () => {
    await env.pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
  });

  it('SELECT location with completely unset GUC returns 0 rows', async () => {
    const { db } = env;
    // GUC already cleared by beforeEach
    const rows = await db.select().from(location).execute();
    expect(rows.length).toBe(0);
  });

  it('SELECT app_user with no GUC returns 0 rows', async () => {
    const { db } = env;
    const rows = await db.select().from(appUser).execute();
    expect(rows.length).toBe(0);
  });

  it('SELECT membership with no GUC returns 0 rows', async () => {
    const { db } = env;
    const rows = await db.select().from(membership).execute();
    expect(rows.length).toBe(0);
  });

  it('SELECT audit_log with no GUC returns 0 rows', async () => {
    const { db, orgAId, userAId } = env;
    // Insert an audit log entry first (within context)
    await withOrgContext(db, orgAId, (tx) =>
      tx.insert(auditLog).values({
        orgId: orgAId,
        actorUserId: userAId,
        action: 'test',
        entityType: 'org',
        metadata: {},
      }).execute(),
    );
    // GUC was reset by beforeEach at the start of this test, and withOrgContext
    // uses LOCAL so it doesn't leak. Now query without context.
    const rows = await db.select().from(auditLog).execute();
    expect(rows.length).toBe(0);
  });

  it('INSERT location with no GUC is denied', async () => {
    const { db, orgAId } = env;
    // GUC cleared by beforeEach
    await expect(
      db.insert(location).values({ orgId: orgAId, name: 'No-Context Insert' }).execute(),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T7 — Empty-string GUC fails closed (NULLIF path)
// One cold-start; GUC reset cheaply before each test.
// ─────────────────────────────────────────────────────────────────────────────
describe('T7: empty-string GUC fails closed (NULLIF path)', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });
  beforeEach(async () => {
    // Restore an arbitrary org context so clearOrgContext has something to clear,
    // then let the test call clearOrgContext itself — or just ensure GUC is empty.
    await env.pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
  });

  it('clearOrgContext (empty string) → 0 rows from location', async () => {
    const { db } = env;
    await clearOrgContext(db, { local: false });
    const rows = await db.select().from(location).execute();
    expect(rows.length).toBe(0);
  });

  it('clearOrgContext (empty string) → 0 rows from app_user', async () => {
    const { db } = env;
    await clearOrgContext(db, { local: false });
    const rows = await db.select().from(appUser).execute();
    expect(rows.length).toBe(0);
  });

  it('clearOrgContext (empty string) → 0 rows from membership', async () => {
    const { db } = env;
    await clearOrgContext(db, { local: false });
    const rows = await db.select().from(membership).execute();
    expect(rows.length).toBe(0);
  });

  it('empty string does not throw a cast error (NULLIF protects the cast)', async () => {
    const { pglite } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    // This should NOT throw a UUID cast error
    await expect(
      pglite.query(`SELECT COUNT(*) FROM location`),
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T8 — Cross-org membership rejected (composite FK + WITH CHECK)
// ─────────────────────────────────────────────────────────────────────────────
describe('T8: cross-org membership structurally blocked', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });

  it('membership INSERT with user from Org B while in Org A context is rejected by WITH CHECK', async () => {
    const { db, orgAId, userBId } = env;
    // RLS WITH CHECK (org_id=current_org_id) blocks before the FK even fires
    await expect(
      withOrgContext(db, orgAId, (tx) =>
        tx.insert(membership).values({ orgId: orgAId, userId: userBId, role: 'student' }).execute(),
      ),
    ).rejects.toThrow();
  });

  it('membership INSERT with user from Org B pointing at Org B while in Org A → rejected', async () => {
    const { db, orgAId, orgBId, userBId } = env;
    // Both org_id and user_id from Org B — double violation: WITH CHECK rejects first
    await expect(
      withOrgContext(db, orgAId, (tx) =>
        tx.insert(membership).values({ orgId: orgBId, userId: userBId, role: 'manager' }).execute(),
      ),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T9 — GUC leak prevention
// One cold-start. Each test either uses LOCAL (withOrgContext) or cleans up
// session GUC itself. GUC is reset before each test for safety.
// ─────────────────────────────────────────────────────────────────────────────
describe('T9: GUC leak prevention', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });
  beforeEach(async () => {
    await env.pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
  });

  it('set Org A context then clearOrgContext → bare SELECT returns 0 rows', async () => {
    const { db, orgAId } = env;
    // Set session-level context to A
    await setOrgContext(db, orgAId, { local: false });
    const rowsBefore = await db.select().from(location).execute();
    expect(rowsBefore.length).toBe(1);

    // Clear and verify 0 rows
    await clearOrgContext(db, { local: false });
    const rowsAfter = await db.select().from(location).execute();
    expect(rowsAfter.length).toBe(0);
  });

  it('withOrgContext(A) GUC does not leak outside the transaction', async () => {
    const { db, orgAId } = env;
    // Run within the transaction
    await withOrgContext(db, orgAId, async (tx) => {
      const rows = await tx.select().from(location).execute();
      expect(rows.length).toBe(1);
    });
    // Outside the transaction: GUC was set LOCAL so it's gone
    // Session-level GUC is '' from the beforeEach clear, so 0 rows expected
    const rows = await db.select().from(location).execute();
    expect(rows.length).toBe(0);
  });

  it('context does not bleed between sequential withOrgContext calls', async () => {
    const { db, orgAId, orgBId } = env;
    // Query under A
    const rowsA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(location).execute(),
    );
    expect(rowsA.every((r) => r.orgId === orgAId)).toBe(true);

    // Query under B — should only see B's rows
    const rowsB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(location).execute(),
    );
    expect(rowsB.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsB.some((r) => r.orgId === orgAId)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T10 — org self-scoping
// ─────────────────────────────────────────────────────────────────────────────
describe('T10: org self-scoping (SELECT org under A → exactly Org A)', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });

  it('SELECT org under Org A context returns exactly 1 row (Org A)', async () => {
    const { db, orgAId, orgBId } = env;
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(org).execute(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(orgAId);
  });

  it('Org B is invisible under Org A context', async () => {
    const { db, orgAId, orgBId } = env;
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(org).execute(),
    );
    expect(rows.some((r) => r.id === orgBId)).toBe(false);
  });

  it('SELECT org under Org B context returns exactly 1 row (Org B)', async () => {
    const { db, orgBId } = env;
    const rows = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(org).execute(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(orgBId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T11 — Platform tables NOT org-filtered
// ─────────────────────────────────────────────────────────────────────────────
describe('T11: platform tables are NOT org-filtered', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });

  it('plan is visible with no org context set', async () => {
    const { db, pglite, planId } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const rows = await db.select().from(plan).execute();
    expect(rows.some((r) => r.id === planId)).toBe(true);
  });

  it('subscription for Org B is visible under Org A context', async () => {
    const { db, orgAId, subscriptionBId } = env;
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(subscription).execute(),
    );
    // Both org subscriptions should be visible (no RLS on subscription)
    expect(rows.some((r) => r.id === subscriptionBId)).toBe(true);
  });

  it('plan is visible within any org context', async () => {
    const { db, orgAId, orgBId, planId } = env;
    const rowsA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(plan).execute(),
    );
    const rowsB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(plan).execute(),
    );
    expect(rowsA.some((r) => r.id === planId)).toBe(true);
    expect(rowsB.some((r) => r.id === planId)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T12 — Role enum exactness
// PERF: all 8 role inserts are batched in one withOrgContext transaction,
// eliminating 7 separate transaction round-trips.
// ─────────────────────────────────────────────────────────────────────────────
describe('T12: membership_role enum exactness', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });

  it('DB enum values match @aeroops/core MEMBERSHIP_ROLES exactly', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
       WHERE pg_type.typname = 'membership_role'
       ORDER BY pg_enum.enumsortorder`,
    );
    const dbValues = result.rows.map((r) => r.enumlabel);
    expect(dbValues).toEqual([...MEMBERSHIP_ROLES]);
  });

  it('all 8 MEMBERSHIP_ROLES are insertable as membership rows', async () => {
    const { db, orgAId } = env;
    // Batch: create all non-owner users + memberships in one transaction.
    // 'owner' is already seeded (userA has it); skip it here and just verify
    // the insert of the remaining 7 roles in a single round-trip.
    const rolesToTest = MEMBERSHIP_ROLES.filter((r) => r !== 'owner');

    await expect(
      withOrgContext(db, orgAId, async (tx) => {
        for (const role of rolesToTest) {
          const [newUser] = await tx
            .insert(appUser)
            .values({
              orgId: orgAId,
              email: `role-test-${role}@alpha.example`,
              fullName: `Test ${role}`,
            })
            .returning();

          await tx
            .insert(membership)
            .values({
              orgId: orgAId,
              userId: newUser!.id,
              role: role as typeof MEMBERSHIP_ROLES[number],
            })
            .execute();
        }
        return rolesToTest;
      }),
    ).resolves.toEqual(rolesToTest);
  });
});

// T12b — Role enum rejects unknown value
describe('T12b: membership_role rejects unknown values', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });

  it('inserting role "pilot" (not in enum) is rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await expect(
      pglite.exec(
        `INSERT INTO membership (org_id, user_id, role) VALUES ('${orgAId}', '${userAId}', 'pilot')`,
      ),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T13 — FORCE guard / anti-false-green
// One shared env; each test independently clears the GUC before its assertion.
// ─────────────────────────────────────────────────────────────────────────────
describe('T13: FORCE RLS guard — no context = 0 rows as aeroops_app', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });
  beforeEach(async () => {
    await env.pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
  });

  it('location: aeroops_app with no GUC returns 0 rows', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM location`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  it('app_user: aeroops_app with no GUC returns 0 rows', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM app_user`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  it('membership: aeroops_app with no GUC returns 0 rows', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM membership`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  it('audit_log: aeroops_app with no GUC returns 0 rows', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_log`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  it('org: aeroops_app with no GUC returns 0 rows', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM org`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T14 — audit_log append-only
// Inserts are additive; no test removes a row. One shared env is safe.
// ─────────────────────────────────────────────────────────────────────────────
describe('T14: audit_log is append-only (no UPDATE, no DELETE)', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });

  it('INSERT audit_log in-context succeeds', async () => {
    const { db, orgAId, userAId } = env;
    await expect(
      withOrgContext(db, orgAId, (tx) =>
        tx.insert(auditLog).values({
          orgId: orgAId,
          actorUserId: userAId,
          action: 'user.login',
          entityType: 'app_user',
          entityId: userAId,
          metadata: { ip: '127.0.0.1' },
        }).execute(),
      ),
    ).resolves.toBeDefined();
  });

  it('UPDATE audit_log row is denied (REVOKE + no UPDATE policy under FORCE RLS)', async () => {
    const { db, pglite, orgAId, userAId } = env;
    // Insert a row first
    const [row] = await withOrgContext(db, orgAId, (tx) =>
      tx.insert(auditLog).values({
        orgId: orgAId,
        actorUserId: userAId,
        action: 'test.create',
        entityType: 'app_user',
        metadata: {},
      }).returning(),
    );

    // FIX 5: REVOKE UPDATE ON audit_log FROM aeroops_app means the role now gets
    // a hard "permission denied" error rather than the previous "0 rows affected"
    // (no-UPDATE-policy) behavior. Both are correct immutability enforcement;
    // the REVOKE is a belt-and-suspenders structural guarantee that does not
    // depend solely on the absence of a permissive policy.
    const rowId = row!.id;
    await expect(
      pglite.query(`UPDATE audit_log SET action = 'tampered' WHERE id = '${rowId}' RETURNING id`),
    ).rejects.toThrow();

    // Verify the row is untouched
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.id, rowId)).execute(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe('test.create');
  });

  it('DELETE audit_log row is denied (REVOKE + no DELETE policy under FORCE RLS)', async () => {
    const { db, pglite, orgAId, userAId } = env;
    const [row] = await withOrgContext(db, orgAId, (tx) =>
      tx.insert(auditLog).values({
        orgId: orgAId,
        actorUserId: userAId,
        action: 'test.delete',
        entityType: 'app_user',
        metadata: {},
      }).returning(),
    );

    // FIX 5: REVOKE DELETE ON audit_log FROM aeroops_app means the role now gets
    // a hard "permission denied" error (belt-and-suspenders over the FORCE RLS
    // no-DELETE-policy mechanism).
    const rowId = row!.id;
    await expect(
      pglite.query(`DELETE FROM audit_log WHERE id = '${rowId}' RETURNING id`),
    ).rejects.toThrow();

    // Verify the row still exists
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.id, rowId)).execute(),
    );
    expect(rows.length).toBe(1);
  });

  it('audit_log has no updated_at column (immutability signal)', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'audit_log' AND column_name = 'updated_at'`,
    );
    expect(result.rows.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PBT-1 — Property: arbitrary orgs, arbitrary locations/users — exact isolation
//
// PERF REDESIGN: one shared PGlite instance (set up in beforeAll). Each
// fast-check iteration creates a FRESH ORG PAIR via withPlatformAdminContext
// rather than re-bootstrapping PGlite. The isolation invariant is identical:
//   - Query under orgX returns only orgX rows (verified by orgId on every row)
//   - Query under orgY returns only orgY rows (verified by orgId on every row)
//   - Count matches exactly the number of locations inserted for that org
// No cleanup between iterations is needed: each iteration's orgs are unique
// (new UUIDs from gen_random_uuid()) so they are naturally isolated from each
// other as well as from the seed orgs.
// ─────────────────────────────────────────────────────────────────────────────
describe('PBT-1: property — any two orgs with N rows each are perfectly isolated', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });

  it('for any 1..5 locations per org, queries return exactly own-org rows', async () => {
    const { db } = env;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),  // locationsForA
        fc.integer({ min: 1, max: 5 }),  // locationsForB
        async (locCountA, locCountB) => {
          // Create a fresh org pair for this iteration (cheap: no PGlite restart)
          const [iterOrgA, iterOrgB] = await withPlatformAdminContext(db, async (tx) => {
            const a = await tx.insert(org).values({ name: `PBT1-A-${Math.random()}`, slug: `pbt1a-${Date.now()}-${Math.random()}` }).returning();
            const b = await tx.insert(org).values({ name: `PBT1-B-${Math.random()}`, slug: `pbt1b-${Date.now()}-${Math.random()}` }).returning();
            return [a[0]!, b[0]!] as const;
          });

          const orgAId = iterOrgA.id;
          const orgBId = iterOrgB.id;

          // Insert exactly locCountA locations for orgA
          await withOrgContext(db, orgAId, async (tx) => {
            for (let i = 0; i < locCountA; i++) {
              await tx.insert(location).values({ orgId: orgAId, name: `A-Loc-${i}`, icao: `KA${i}X` }).execute();
            }
          });

          // Insert exactly locCountB locations for orgB
          await withOrgContext(db, orgBId, async (tx) => {
            for (let i = 0; i < locCountB; i++) {
              await tx.insert(location).values({ orgId: orgBId, name: `B-Loc-${i}`, icao: `KB${i}X` }).execute();
            }
          });

          // Query under A — should see exactly locCountA rows, all orgAId
          const rowsA = await withOrgContext(db, orgAId, (tx) =>
            tx.select().from(location).execute(),
          );
          if (rowsA.length !== locCountA) return false;
          if (!rowsA.every((r) => r.orgId === orgAId)) return false;
          if (rowsA.some((r) => r.orgId === orgBId)) return false;

          // Query under B — should see exactly locCountB rows, all orgBId
          const rowsB = await withOrgContext(db, orgBId, (tx) =>
            tx.select().from(location).execute(),
          );
          if (rowsB.length !== locCountB) return false;
          if (!rowsB.every((r) => r.orgId === orgBId)) return false;
          if (rowsB.some((r) => r.orgId === orgAId)) return false;

          return true;
        },
      ),
      { numRuns: 10 },
    );
  });

  it('cross-org UPDATE/DELETE under property test → 0 affected', async () => {
    const { db } = env;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        async (extraLocs) => {
          // Fresh org pair per iteration
          const [iterOrgA, iterOrgB] = await withPlatformAdminContext(db, async (tx) => {
            const a = await tx.insert(org).values({ name: `PBT1-DEL-A-${Math.random()}`, slug: `pbt1da-${Date.now()}-${Math.random()}` }).returning();
            const b = await tx.insert(org).values({ name: `PBT1-DEL-B-${Math.random()}`, slug: `pbt1db-${Date.now()}-${Math.random()}` }).returning();
            return [a[0]!, b[0]!] as const;
          });

          const orgAId = iterOrgA.id;
          const orgBId = iterOrgB.id;

          // Seed 1 location for B; extra locations for A
          const [locB] = await withOrgContext(db, orgBId, (tx) =>
            tx.insert(location).values({ orgId: orgBId, name: 'B-Seed' }).returning(),
          );
          const locationBId = locB!.id;

          await withOrgContext(db, orgAId, async (tx) => {
            for (let i = 0; i < extraLocs; i++) {
              await tx.insert(location).values({ orgId: orgAId, name: `A-Loc-${i}` }).execute();
            }
          });

          // Attempt to DELETE Org B's location while in Org A context
          await withOrgContext(db, orgAId, (tx) =>
            tx.delete(location).where(eq(location.id, locationBId)).execute(),
          );

          // Org B location must still exist
          const rowsB = await withOrgContext(db, orgBId, (tx) =>
            tx.select().from(location).where(eq(location.id, locationBId)).execute(),
          );
          return rowsB.length === 1;
        },
      ),
      { numRuns: 10 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PBT-2 — Property: random set/clear sequences always leave consistent state
//
// PERF REDESIGN: one shared PGlite instance. PBT-2 test 1 (clearOrgContext →
// 0 rows) uses the shared seed orgs — clearing GUC always returns 0 regardless
// of how many orgs exist. PBT-2 test 2 (setOrgContext(X) → only X rows) creates
// fresh org pairs per iteration with exactly 1 location each so the
// `rows.length === 1` assertion remains valid.
// ─────────────────────────────────────────────────────────────────────────────
describe('PBT-2: property — random set/clear GUC sequence leaves consistent state', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await setupFreshEnv(); });
  // Reset GUC between tests so session state is clean
  beforeEach(async () => {
    await env.pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
  });

  it('after clearOrgContext, SELECT always returns 0 rows regardless of prior sets', async () => {
    const { db, orgAId, orgBId } = env;
    const orgIds = [orgAId, orgBId];

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        async (setOrClearSeq) => {
          // Execute random set/clear operations on the shared env's seed orgs
          for (let i = 0; i < setOrClearSeq.length; i++) {
            const doSet = setOrClearSeq[i];
            if (doSet) {
              const targetOrg = orgIds[i % 2]!;
              await setOrgContext(db, targetOrg, { local: false });
            } else {
              await clearOrgContext(db, { local: false });
            }
          }

          // Always clear at the end
          await clearOrgContext(db, { local: false });

          // After clear, must always see 0 rows
          const rows = await db.select().from(location).execute();
          return rows.length === 0;
        },
      ),
      { numRuns: 15 },
    );
  });

  it('after setOrgContext(X), SELECT returns only X rows', async () => {
    const { db } = env;

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('A' as const, 'B' as const),
        async (whichOrg) => {
          // Fresh org pair per iteration with exactly 1 location each
          const [iterOrgA, iterOrgB] = await withPlatformAdminContext(db, async (tx) => {
            const a = await tx.insert(org).values({ name: `PBT2-A-${Math.random()}`, slug: `pbt2a-${Date.now()}-${Math.random()}` }).returning();
            const b = await tx.insert(org).values({ name: `PBT2-B-${Math.random()}`, slug: `pbt2b-${Date.now()}-${Math.random()}` }).returning();
            return [a[0]!, b[0]!] as const;
          });

          const iterOrgAId = iterOrgA.id;
          const iterOrgBId = iterOrgB.id;

          // Insert exactly 1 location per org
          await withOrgContext(db, iterOrgAId, (tx) =>
            tx.insert(location).values({ orgId: iterOrgAId, name: 'A-Loc' }).execute(),
          );
          await withOrgContext(db, iterOrgBId, (tx) =>
            tx.insert(location).values({ orgId: iterOrgBId, name: 'B-Loc' }).execute(),
          );

          const targetId = whichOrg === 'A' ? iterOrgAId : iterOrgBId;
          const otherId = whichOrg === 'A' ? iterOrgBId : iterOrgAId;

          // Do a few random operations then settle on target
          await setOrgContext(db, otherId, { local: false });
          await clearOrgContext(db, { local: false });
          await setOrgContext(db, targetId, { local: false });

          const rows = await db.select().from(location).execute();
          return (
            rows.every((r) => r.orgId === targetId) &&
            !rows.some((r) => r.orgId === otherId) &&
            rows.length === 1
          );
        },
      ),
      { numRuns: 10 },
    );
  });
});
