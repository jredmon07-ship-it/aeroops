/**
 * auth-credential.test.ts — Slice 0.2 RLS smoke test for auth_credential.
 *
 * Proves the 0001_auth_credential.sql migration works end-to-end in PGlite:
 *
 * (a) Credential inserted under Org A context is visible under Org A, 0 rows under Org B.
 * (b) Cross-org INSERT (org_id=B while in A context) rejected by WITH CHECK.
 * (c) Composite FK rejects a credential whose (user_id, org_id) doesn't match an app_user.
 * (d) Unset context → 0 rows (fail-closed).
 * (e) No-membership user: app_user with no membership row can still have a credential.
 *
 * Full auth-flow tests (JWT minting, session management, etc.) are the
 * test-writer's job in /qa. This file proves only the table + RLS.
 *
 * PERFORMANCE: one shared PGlite instance (both migrations applied once in
 * beforeAll) then seeded and role-switched. Follows the shared-env pattern
 * from rls-isolation.test.ts to keep setup fast.
 *
 * MIGRATION ORDER: BOTH 0000_loud_prodigy.sql and 0001_auth_credential.sql
 * are applied in sequence via applyMigrationSql([sql0, sql1]) to validate
 * the real migration artifacts work together.
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
  seedAuthCredential,
  seedUserWithoutMembership,
  withOrgContext,
} from '../index.js';
import { authCredential } from '../schema/index.js';
import type { PgliteTestClient } from '../client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_0000 = readFileSync(
  resolve(__dirname, '../../migrations/0000_loud_prodigy.sql'),
  'utf-8',
);
const MIGRATION_0001 = readFileSync(
  resolve(__dirname, '../../migrations/0001_auth_credential.sql'),
  'utf-8',
);
// 0002–0008 must follow because the Drizzle schema now includes columns
// (phone, status on app_user) that were added in migration 0008.
// Applying the full chain ensures the ORM-generated INSERT statements
// match the actual table definition in the test DB.
const MIGRATION_0002 = readFileSync(
  resolve(__dirname, '../../migrations/0002_scheduling.sql'),
  'utf-8',
);
const MIGRATION_0003 = readFileSync(
  resolve(__dirname, '../../migrations/0003_booking_policies.sql'),
  'utf-8',
);
const MIGRATION_0004 = readFileSync(
  resolve(__dirname, '../../migrations/0004_recurrence.sql'),
  'utf-8',
);
const MIGRATION_0005 = readFileSync(
  resolve(__dirname, '../../migrations/0005_dispatch.sql'),
  'utf-8',
);
const MIGRATION_0006 = readFileSync(
  resolve(__dirname, '../../migrations/0006_squawks_grounding.sql'),
  'utf-8',
);
const MIGRATION_0007 = readFileSync(
  resolve(__dirname, '../../migrations/0007_fleet.sql'),
  'utf-8',
);
const MIGRATION_0008 = readFileSync(
  resolve(__dirname, '../../migrations/0008_people.sql'),
  'utf-8',
);
const MIGRATION_0009 = readFileSync(
  resolve(__dirname, '../../migrations/0009_dispatch_gate.sql'),
  'utf-8',
);
const MIGRATION_0010 = readFileSync(
  resolve(__dirname, '../../migrations/0010_civil_twilight.sql'),
  'utf-8',
);
const MIGRATION_0011 = readFileSync(
  resolve(__dirname, '../../migrations/0011_optimizer_run.sql'),
  'utf-8',
);

// Dummy hash — clearly not a real password, visibly a placeholder.
const DUMMY_HASH = '$argon2id$dummy$placeholder$not-a-real-hash';

// ── Test state ─────────────────────────────────────────────────────────────────
let db: PgliteTestClient;
let pglite: PGlite;
let orgAId: string;
let orgBId: string;
let userAId: string;
let userBId: string;
let credAId: string;

beforeAll(async () => {
  // 1. Spin up a fresh in-memory PGlite and apply BOTH migrations in order.
  //    This validates the real migration artifacts work together in sequence.
  ({ db, pglite } = await createTestClient());
  await applyMigrationSql({ pglite }, [
    MIGRATION_0000,
    MIGRATION_0001,
    MIGRATION_0002,
    MIGRATION_0003,
    MIGRATION_0004,
    MIGRATION_0005,
    MIGRATION_0006,
    MIGRATION_0007,
    MIGRATION_0008,
    MIGRATION_0009,
    MIGRATION_0010,
    MIGRATION_0011,
  ]);

  // 2. Seed two orgs with users (runs as superuser — RLS bypassed during setup).
  const seed = await seedTwoOrgs(db);
  orgAId = seed.orgAId;
  orgBId = seed.orgBId;
  userAId = seed.userAId;
  userBId = seed.userBId;

  // 3. Insert a credential for Org A's user (still as superuser).
  const credA = await seedAuthCredential(db, orgAId, userAId, DUMMY_HASH);
  credAId = credA.id;

  // 4. Drop to non-superuser role so RLS is enforced for all test assertions.
  await setTestAppRole({ pglite });
});

// ── (a) Credential visible under Org A, invisible under Org B ─────────────────
describe('(a) auth_credential isolation — Org A vs Org B', () => {
  it('SELECT auth_credential under Org A context returns the seeded row', async () => {
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(authCredential).execute(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(credAId);
    expect(rows[0]!.orgId).toBe(orgAId);
    expect(rows[0]!.userId).toBe(userAId);
  });

  it('SELECT auth_credential under Org B context returns 0 rows', async () => {
    const rows = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(authCredential).execute(),
    );
    expect(rows.length).toBe(0);
  });

  it('Org B cannot see the credential by id', async () => {
    const rows = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(authCredential).execute(),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(credAId);
  });
});

// ── (b) Cross-org INSERT rejected by WITH CHECK ───────────────────────────────
describe('(b) cross-org INSERT rejected by RLS WITH CHECK', () => {
  it('INSERT auth_credential with org_id=B while in Org A context is rejected', async () => {
    await expect(
      withOrgContext(db, orgAId, (tx) =>
        tx
          .insert(authCredential)
          .values({
            orgId: orgBId,          // cross-org: B's org_id while in A context
            userId: userBId,
            passwordHash: DUMMY_HASH,
          })
          .execute(),
      ),
    ).rejects.toThrow();
  });
});

// ── (c) Composite FK rejects mismatched (user_id, org_id) ────────────────────
describe('(c) composite FK rejects cross-org (user_id, org_id) pair', () => {
  it('INSERT with user_id from Org B but org_id=A is rejected by composite FK', async () => {
    // userBId belongs to org B; pairing it with org A violates the composite FK
    // FOREIGN KEY (user_id, org_id) REFERENCES app_user(id, org_id).
    // The RLS WITH CHECK fires first (org_id=A matches context), but the FK
    // rejects because (userBId, orgAId) has no matching row in app_user.
    await expect(
      withOrgContext(db, orgAId, (tx) =>
        tx
          .insert(authCredential)
          .values({
            orgId: orgAId,
            userId: userBId,         // user belongs to Org B — composite FK violation
            passwordHash: DUMMY_HASH,
          })
          .execute(),
      ),
    ).rejects.toThrow();
  });
});

// ── (d) Unset context → 0 rows (fail-closed) ─────────────────────────────────
describe('(d) unset context → 0 rows from auth_credential', () => {
  it('SELECT auth_credential with no org context returns 0 rows', async () => {
    // Clear session GUC to simulate an unset context.
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM auth_credential`,
    );
    expect(result.rows[0]!['count']).toBe('0');
  });

  it('INSERT auth_credential with no org context is rejected', async () => {
    // GUC already cleared by the previous test (session-scoped clear).
    await expect(
      pglite.exec(
        `INSERT INTO auth_credential (org_id, user_id, password_hash) ` +
        `VALUES ('${orgAId}', '${userAId}', '${DUMMY_HASH}')`,
      ),
    ).rejects.toThrow();
  });
});

// ── (e) User with no membership can hold a credential ─────────────────────────
describe('(e) user without membership can have a credential (no-membership bounce test setup)', () => {
  it('seedUserWithoutMembership creates an app_user with no membership row', async () => {
    // We need superuser access for seeding — re-set role to postgres.
    // PGlite allows SET ROLE back to postgres even after SET ROLE aeroops_app.
    await pglite.exec(`SET ROLE postgres`);

    // Re-set GUC to org A context for the insert (withOrgContext uses LOCAL,
    // so the SET ROLE back to aeroops_app happens only after this block).
    const noMemberUser = await seedUserWithoutMembership(
      db,
      orgAId,
      'nomember@alpha.example',
      'No Member User',
    );
    expect(noMemberUser.id).toBeTruthy();
    expect(noMemberUser.orgId).toBe(orgAId);

    // Give the no-member user a credential (still as postgres/superuser).
    const cred = await seedAuthCredential(
      db,
      orgAId,
      noMemberUser.id,
      '$argon2id$dummy$nomember',
    );
    expect(cred.userId).toBe(noMemberUser.id);

    // Verify no membership row exists for this user by querying the raw table
    // as superuser (bypasses RLS — intentional: we need to assert absence).
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM membership WHERE user_id = '${noMemberUser.id}'`,
    );
    expect(result.rows[0]!['count']).toBe('0');

    // Drop back to aeroops_app for any further assertions.
    await setTestAppRole({ pglite });
  });
});
