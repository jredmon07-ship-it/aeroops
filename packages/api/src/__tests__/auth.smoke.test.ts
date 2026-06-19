/**
 * auth.smoke.test.ts — Slice 0.2 backend auth smoke tests.
 *
 * Uses the pglite harness from @aeroops/db (createTestClient → apply both
 * migrations → seed → setTestAppRole).
 *
 * COVERAGE:
 *   (a) verifyCredential returns {userId, email, role} for a seeded user
 *       with a REAL hash made by hashPassword.
 *   (b) Cross-org: verifyCredential(orgB, emailA, pwA) → null (RLS hides row).
 *   (c) Wrong password → null.
 *   (d) No-membership user → null.
 *   (e) resolveOrgBySlug returns the org for a known slug and null for unknown.
 *
 * The FULL Auth.js authorize callback + route/middleware tests are the
 * test-writer's job in /qa. This file proves module logic only.
 *
 * SETUP:
 *   - One shared PGlite instance; both migrations applied once in beforeAll.
 *   - Seed as superuser; then setTestAppRole to enforce RLS.
 *
 * PERFORMANCE NOTE:
 *   argon2id with OWASP params (19 MiB, 2 iterations) takes ~100-200 ms per
 *   hash on a typical dev machine. The test suite hashes two passwords (one
 *   real user, one no-membership user). testTimeout is 60 s; this is fine.
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
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import { hashPassword } from '../auth/hash.js';
import { verifyCredential } from '../auth/verify-credential.js';
import { resolveOrgBySlug } from '../auth/resolve-org.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load the real migration SQL artifacts (validates the real schema, not a mock).
// Path: packages/api/src/__tests__/ → ../../.. → packages/ → db/migrations/
const MIGRATION_0000 = readFileSync(
  resolve(__dirname, '../../../db/migrations/0000_loud_prodigy.sql'),
  'utf-8',
);
const MIGRATION_0001 = readFileSync(
  resolve(__dirname, '../../../db/migrations/0001_auth_credential.sql'),
  'utf-8',
);
// 0002–0008 required: Drizzle ORM INSERT on app_user now emits phone+status columns.
const MIGRATIONS_0002_0008 = [
  readFileSync(resolve(__dirname, '../../../db/migrations/0002_scheduling.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0003_booking_policies.sql'),  'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0004_recurrence.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0005_dispatch.sql'),          'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0006_squawks_grounding.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0007_fleet.sql'),             'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0008_people.sql'),            'utf-8'),
  // 0009 required: dispatch_requirement + dispatch_config tables (Slice 3c / ADR-0009).
  // openDispatch now queries dispatch_requirement; tables must exist in test DB.
  readFileSync(resolve(__dirname, '../../../db/migrations/0009_dispatch_gate.sql'),    'utf-8'),
];

// ─── Test state ───────────────────────────────────────────────────────────────
let db: PgliteTestClient;
let pglite: PGlite;
let orgAId: string;
let orgBId: string;
let userAId: string;
let noMemberUserId: string;

const PASSWORD_A = 'CorrectBatteryHorseStaple!99';
const PASSWORD_NO_MEMBER = 'AlsoStrong!NoMember42';

beforeAll(async () => {
  // 1. Fresh in-memory PGlite with both migrations applied.
  ({ db, pglite } = await createTestClient());
  await applyMigrationSql({ pglite }, [MIGRATION_0000, MIGRATION_0001, ...MIGRATIONS_0002_0008]);

  // 2. Seed two orgs with users (as superuser — RLS bypassed during setup).
  const seed = await seedTwoOrgs(db);
  orgAId = seed.orgAId;
  orgBId = seed.orgBId;
  userAId = seed.userAId;

  // 3. Hash the passwords with the REAL argon2id function.
  const hashA = await hashPassword(PASSWORD_A);

  // 4. Seed the auth_credential for Org A's user with the real hash.
  await seedAuthCredential(db, orgAId, userAId, hashA);

  // 5. Create a user with no membership in Org A (for test d).
  const noMemberUser = await seedUserWithoutMembership(
    db,
    orgAId,
    'nomember@alpha.example',
    'No Membership User',
  );
  noMemberUserId = noMemberUser.id;
  const hashNoMember = await hashPassword(PASSWORD_NO_MEMBER);
  await seedAuthCredential(db, orgAId, noMemberUserId, hashNoMember);

  // 6. Drop to non-superuser role so RLS is enforced for all assertions.
  await setTestAppRole({ pglite });
}, 60_000);

// ─── (a) Happy path — correct credentials → VerifiedCredential ───────────────
describe('(a) verifyCredential — happy path', () => {
  it('returns {userId, email, role} for a valid user with a real hash', async () => {
    const result = await verifyCredential(
      db,
      orgAId,
      'alice@alpha.example',
      PASSWORD_A,
    );

    expect(result).not.toBeNull();
    expect(result!.userId).toBe(userAId);
    expect(result!.email).toBe('alice@alpha.example');
    expect(result!.role).toBe('owner');
  });

  it('normalizes email (trims + lowercases) before lookup', async () => {
    const result = await verifyCredential(
      db,
      orgAId,
      '  ALICE@ALPHA.EXAMPLE  ', // untrimmed, uppercase
      PASSWORD_A,
    );

    expect(result).not.toBeNull();
    expect(result!.email).toBe('alice@alpha.example');
  });
});

// ─── (b) Cross-org: Org B cannot authenticate Org A's user ───────────────────
describe('(b) cross-org — verifyCredential with orgB cannot see orgA credentials', () => {
  it('returns null when called with orgB but supplying orgA credentials', async () => {
    // RLS hides app_user and auth_credential rows from Org A when the context is Org B.
    const result = await verifyCredential(
      db,
      orgBId,
      'alice@alpha.example',
      PASSWORD_A,
    );

    expect(result).toBeNull();
  });
});

// ─── (c) Wrong password → null ────────────────────────────────────────────────
describe('(c) wrong password → null', () => {
  it('returns null when the password does not match the stored hash', async () => {
    const result = await verifyCredential(
      db,
      orgAId,
      'alice@alpha.example',
      'WrongPassword!999',
    );

    expect(result).toBeNull();
  });
});

// ─── (d) No-membership user → null ───────────────────────────────────────────
describe('(d) no-membership user — verifyCredential bounces the user', () => {
  it('returns null for a user with valid credentials but no membership row', async () => {
    const result = await verifyCredential(
      db,
      orgAId,
      'nomember@alpha.example',
      PASSWORD_NO_MEMBER,
    );

    expect(result).toBeNull();
  });
});

// ─── (e) resolveOrgBySlug ─────────────────────────────────────────────────────
describe('(e) resolveOrgBySlug', () => {
  it('returns the org for a known slug', async () => {
    const resolved = await resolveOrgBySlug(db, 'alpha');

    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(orgAId);
    expect(resolved!.slug).toBe('alpha');
    expect(resolved!.status).toBe('active');
  });

  it('returns null for an unknown slug', async () => {
    const resolved = await resolveOrgBySlug(db, 'does-not-exist-xyz');

    expect(resolved).toBeNull();
  });

  it('returns org B for its slug', async () => {
    const resolved = await resolveOrgBySlug(db, 'beta');

    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(orgBId);
    expect(resolved!.slug).toBe('beta');
  });
});
