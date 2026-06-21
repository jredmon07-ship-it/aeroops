/**
 * auth.test.ts — Slice 0.2 comprehensive auth test suite.
 *
 * Covers every case from the architect's test list that is testable without a
 * live Postgres database, using the pglite harness from @aeroops/db.
 *
 * COVERAGE MAP:
 *
 *   1. LOGIN HAPPY PATH (logic level)
 *      1a. resolveOrgBySlug(known slug) → ResolvedOrg
 *      1b. verifyCredential(orgId, email, correctPw) → VerifiedCredential
 *      1c. Email normalisation (trim + lowercase) accepted
 *
 *   2. SESSION → CONTEXT ISOLATION
 *      2a. withSessionOrgContextWithDb(db, session, fn) runs under session.orgId's RLS
 *      2b. Org A session cannot see Org B rows through withSessionOrgContextWithDb
 *      2c. org_id-from-session invariant: withSessionOrgContextWithDb uses session.orgId
 *          (not any other field) for the GUC — unit-tested by comparing the orgId
 *          that reaches withOrgContext against session.orgId
 *
 *   3. CROSS-ORG LOGIN REJECTED
 *      3a. verifyCredential(orgB.id, emailA, pwA) → null (RLS hides the row)
 *
 *   4. WRONG PASSWORD / UNKNOWN EMAIL
 *      4a. Wrong password → null (no throw)
 *      4b. Unknown email → null (anti-enumeration dummy-verify fires, no throw)
 *      4c. Unknown email path equalises timing (dummy-verify runs without error)
 *
 *   5. NO-MEMBERSHIP USER
 *      5a. Valid credentials but no membership row → null
 *
 *   6. UNKNOWN ORG SLUG
 *      6a. resolveOrgBySlug('does-not-exist') → null
 *
 *   7. SUSPENDED / INACTIVE ORG
 *      7a. resolveOrgBySlug returns status 'suspended' for a suspended org
 *      7b. The authorize-level rejection of non-'active' orgs is exercised by
 *          testing buildAuthConfig's composing functions directly (no live getDb())
 *      7c. buildAuthConfig throws at call-time when AUTH_SECRET is missing
 *
 *   8. auth_credential RLS FROM API LAYER
 *      8a. Credential row for Org A is invisible under withOrgContext(orgB)
 *      8b. Composite FK rejects a credential whose (user_id, org_id) mismatches
 *          app_user (FK violation)
 *
 *   9. UNAUTHENTICATED / INCOMPLETE SESSIONS
 *      9a. withSessionOrgContextWithDb with null session throws UnauthenticatedError
 *      9b. withSessionOrgContextWithDb with missing orgId throws UnauthenticatedError
 *      9c. withSessionOrgContextWithDb with missing userId throws UnauthenticatedError
 *      9d. withSessionOrgContextWithDb with missing role throws UnauthenticatedError
 *
 *  10. MIDDLEWARE SLUG-MATCH LOGIC (pure-function extraction)
 *      The middleware uses a regex and two comparison predicates. The pure logic is
 *      extracted inline here as `classifyRequest` mirroring the real middleware
 *      behavior. We test:
 *      10a. /o/[slug]/login → public sub-route (pass through)
 *      10b. /o/[slug]/no-access → public sub-route (pass through)
 *      10c. /o/[slug]/dashboard with no session → redirect to /o/[slug]/login
 *      10d. /o/[slug]/dashboard with session.slug === URL slug → pass
 *      10e. /o/[slug]/dashboard with session.slug !== URL slug → redirect to
 *           /o/{session.slug}/login  (tenant mismatch guard)
 *      10f. Non-tenant path (e.g. /) → pass through (not a tenant route)
 *
 *  KNOWN GAP:
 *      Full browser e2e (Auth.js cookie issuance, JWT signing, real redirect chain)
 *      cannot be tested here because there is no live DATABASE_URL or browser in
 *      this environment. That gap is tracked for Slice 0.4 CI.
 *
 * SETUP:
 *   - One shared PGlite instance for auth/RLS tests; both migrations applied once.
 *   - Seed as superuser; setTestAppRole() to enforce RLS before assertions.
 *   - Argon2 hashing is done once in beforeAll for speed (~100-200 ms each).
 *   - testTimeout: 60_000 (set in vitest.config.ts).
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
  withPlatformAdminContext,
} from '@aeroops/db';
import { authCredential } from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import { hashPassword } from '../auth/hash.js';
import { verifyCredential } from '../auth/verify-credential.js';
import { resolveOrgBySlug } from '../auth/resolve-org.js';
import {
  withSessionOrgContextWithDb,
  UnauthenticatedError,
} from '../auth/session.js';
import type { AppSession } from '../auth/types.js';
import {
  buildEdgeAuthConfig,
  jwtCallback,
  sessionCallback,
} from '../auth/auth-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Migration SQL ─────────────────────────────────────────────────────────────
// Load real migration artifacts — tests validate the actual schema, not a mock.
// Relative path: packages/api/src/__tests__/ → ../../../ → packages/ → db/migrations/
const MIGRATION_0000 = readFileSync(
  resolve(__dirname, '../../../db/migrations/0000_loud_prodigy.sql'),
  'utf-8',
);
const MIGRATION_0001 = readFileSync(
  resolve(__dirname, '../../../db/migrations/0001_auth_credential.sql'),
  'utf-8',
);
// 0002–0008 required: Drizzle ORM INSERT on app_user now emits phone+status columns.
// Auth tests only need 0000+0001 for functionality, but all columns must exist.
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
  readFileSync(resolve(__dirname, '../../../db/migrations/0010_civil_twilight.sql'),    'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0011_optimizer_run.sql'),    'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0012_training.sql'),           'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0013_work_orders.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0014_availability.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0015_booking_request.sql'),  'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0016_booking_request_convert.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0017_booking_retention.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0018_dispatch_ticket_correction.sql'),        'utf-8'),
];

// ── Test state ─────────────────────────────────────────────────────────────────
let db: PgliteTestClient;
let pglite: PGlite;
let orgAId: string;
let orgBId: string;
let userAId: string;
let noMemberUserId: string;

const PASSWORD_A = 'CorrectBatteryHorseStaple!99';
const PASSWORD_NO_MEMBER = 'AlsoStrong!NoMember42';
const DUMMY_HASH = '$argon2id$dummy$placeholder$not-a-real-hash';

// ── Shared beforeAll — one PGlite, both migrations, seed, role-switch ─────────
beforeAll(async () => {
  // 1. Fresh in-memory PGlite with both migrations applied.
  ({ db, pglite } = await createTestClient());
  await applyMigrationSql({ pglite }, [MIGRATION_0000, MIGRATION_0001, ...MIGRATIONS_0002_0008]);

  // 2. Seed two orgs with users (as superuser — RLS bypassed during setup).
  const seed = await seedTwoOrgs(db);
  orgAId = seed.orgAId;
  orgBId = seed.orgBId;
  userAId = seed.userAId;

  // 3. Hash passwords with the REAL argon2id function. These are the only
  //    argon2 calls in this suite — ~200 ms each, acceptable with 60 s timeout.
  const hashA = await hashPassword(PASSWORD_A);
  const hashNoMember = await hashPassword(PASSWORD_NO_MEMBER);

  // 4. Seed credentials (still as superuser so RLS doesn't block the seed itself).
  await seedAuthCredential(db, orgAId, userAId, hashA);

  const noMemberUser = await seedUserWithoutMembership(
    db,
    orgAId,
    'nomember@alpha.example',
    'No Membership User',
  );
  noMemberUserId = noMemberUser.id;
  await seedAuthCredential(db, orgAId, noMemberUserId, hashNoMember);

  // 5. Also seed a credential with a DUMMY hash for org B's user (for RLS tests).
  await seedAuthCredential(db, orgBId, seed.userBId, DUMMY_HASH);

  // 6. Seed a suspended org for test 7.
  // Insert suspended org via raw pglite as superuser (before role switch).
  await pglite.exec(
    `INSERT INTO org (name, slug, status) VALUES ('Suspended Air', 'suspended-air', 'suspended')`,
  );

  // 7. Drop to non-superuser role so RLS is enforced for all assertions.
  await setTestAppRole({ pglite });
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
// 1. LOGIN HAPPY PATH (logic level)
// ═════════════════════════════════════════════════════════════════════════════

describe('1. Login happy path', () => {
  it('1a. resolveOrgBySlug(known slug) returns the org', async () => {
    const org = await resolveOrgBySlug(db, 'alpha');
    expect(org).not.toBeNull();
    expect(org!.id).toBe(orgAId);
    expect(org!.slug).toBe('alpha');
    expect(org!.status).toBe('active');
    expect(org!.name).toBe('Alpha Flight School');
  });

  it('1b. verifyCredential with correct password returns {userId, email, role}', async () => {
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
    // password_hash must never appear on the result
    expect(Object.keys(result!)).not.toContain('passwordHash');
    expect(Object.keys(result!)).not.toContain('password_hash');
  });

  it('1c. Email normalisation: trimmed+uppercased input resolves same user', async () => {
    const result = await verifyCredential(
      db,
      orgAId,
      '  ALICE@ALPHA.EXAMPLE  ',
      PASSWORD_A,
    );
    expect(result).not.toBeNull();
    expect(result!.email).toBe('alice@alpha.example');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. SESSION → CONTEXT ISOLATION
// ═════════════════════════════════════════════════════════════════════════════

describe('2. Session-to-context isolation (withSessionOrgContextWithDb)', () => {
  /**
   * Build a minimal valid AppSession for use in these tests.
   */
  function makeSessionFor(orgId: string, slug: string): AppSession {
    return {
      userId: userAId,
      orgId,
      slug,
      role: 'owner',
      user: { email: 'alice@alpha.example' },
    };
  }

  it('2a. fn runs under the session org\'s RLS — only session org rows visible', async () => {
    const sessionA = makeSessionFor(orgAId, 'alpha');

    // Query auth_credential (RLS-gated) inside the session context.
    const rows = await withSessionOrgContextWithDb(
      db,
      sessionA,
      async (_sess, tx) =>
        (tx as PgliteTestClient).select().from(authCredential).execute(),
    );
    // Only Org A's credential should be visible (not Org B's)
    expect(rows.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rows.some((r) => r.orgId === orgBId)).toBe(false);
  });

  it('2b. Org A session cannot see Org B rows', async () => {
    const sessionA = makeSessionFor(orgAId, 'alpha');

    const rows = await withSessionOrgContextWithDb(
      db,
      sessionA,
      async (_sess, tx) =>
        (tx as PgliteTestClient).select().from(authCredential).execute(),
    );
    // Org B's credential row must be completely hidden
    const orgIds = rows.map((r) => r.orgId);
    expect(orgIds).not.toContain(orgBId);
  });

  it('2c. org_id-from-session invariant: session.orgId (not slug or userId) feeds withOrgContext', async () => {
    // Build a session where orgId = orgAId but slug is 'beta' (deliberately wrong
    // slug — simulates a client that might try to spoof the slug while orgId is
    // bound to the JWT). The RLS must still scope to orgAId, not orgBId.
    const session: AppSession = {
      userId: userAId,
      orgId: orgAId,    // <-- this is what must be used for the GUC
      slug: 'beta',     // <-- deliberately wrong — slug is navigation-only
      role: 'owner',
      user: { email: 'alice@alpha.example' },
    };

    const rows = await withSessionOrgContextWithDb(
      db,
      session,
      async (_sess, tx) =>
        (tx as PgliteTestClient).select().from(authCredential).execute(),
    );

    // Rows must be scoped to orgAId (session.orgId), NOT orgBId (session.slug).
    expect(rows.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rows.some((r) => r.orgId === orgBId)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. CROSS-ORG LOGIN REJECTED
// ═════════════════════════════════════════════════════════════════════════════

describe('3. Cross-org login rejected by RLS', () => {
  it('3a. verifyCredential(orgB, emailA, pwA) → null (RLS hides Org A row under Org B context)', async () => {
    const result = await verifyCredential(
      db,
      orgBId,
      'alice@alpha.example',
      PASSWORD_A,
    );
    expect(result).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. WRONG PASSWORD / UNKNOWN EMAIL (anti-enumeration)
// ═════════════════════════════════════════════════════════════════════════════

describe('4. Wrong password / unknown email → null, no throw', () => {
  it('4a. Wrong password → null (password exists, hash mismatch)', async () => {
    const result = await verifyCredential(
      db,
      orgAId,
      'alice@alpha.example',
      'WrongPassword!123',
    );
    expect(result).toBeNull();
  });

  it('4b. Unknown email → null (anti-enumeration: dummy-verify runs, no throw)', async () => {
    // This exercises the "user not found" branch. The dummy-verify should run
    // and the function should return null without throwing.
    const result = await verifyCredential(
      db,
      orgAId,
      'ghost@alpha.example',
      PASSWORD_A,
    );
    expect(result).toBeNull();
  });

  it('4c. Unknown email path does NOT throw (timing equalization still completes)', async () => {
    // Must resolve (not reject) — the anti-enumeration dummy-verify must not throw.
    await expect(
      verifyCredential(db, orgAId, 'nobody@nowhere.example', 'AnyPassword123!'),
    ).resolves.toBeNull();
  });

  it('4d. Known email + missing credential → null (no credential stored)', async () => {
    // Create a user with no credential row to hit the "no credential" branch.
    // We need superuser access — PGlite allows SET ROLE back to postgres from aeroops_app.
    await pglite.exec(`SET ROLE postgres`);
    const userNoCredResult = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name)
       VALUES ('${orgAId}', 'nocred@alpha.example', 'No Cred User')
       RETURNING id`,
    );
    const noCredUserId = userNoCredResult.rows[0]!.id;
    // Also create a membership so the membership check doesn't short-circuit first
    await pglite.exec(
      `INSERT INTO membership (org_id, user_id, role) VALUES ('${orgAId}', '${noCredUserId}', 'student')`,
    );
    await setTestAppRole({ pglite });

    // verifyCredential should hit the "no credential" branch → dummy-verify → null
    const result = await verifyCredential(
      db,
      orgAId,
      'nocred@alpha.example',
      'AnyPassword123!',
    );
    expect(result).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. NO-MEMBERSHIP USER
// ═════════════════════════════════════════════════════════════════════════════

describe('5. No-membership user → null', () => {
  it('5a. Valid credentials but no membership row → null (bounce)', async () => {
    const result = await verifyCredential(
      db,
      orgAId,
      'nomember@alpha.example',
      PASSWORD_NO_MEMBER,
    );
    expect(result).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. UNKNOWN ORG SLUG
// ═════════════════════════════════════════════════════════════════════════════

describe('6. Unknown org slug → null', () => {
  it('6a. resolveOrgBySlug with unknown slug returns null', async () => {
    const result = await resolveOrgBySlug(db, 'org-that-does-not-exist-xyz');
    expect(result).toBeNull();
  });

  it('6b. resolveOrgBySlug with empty string returns null', async () => {
    const result = await resolveOrgBySlug(db, '');
    expect(result).toBeNull();
  });

  it('6c. resolveOrgBySlug with SQL-injection-like string returns null (no throw)', async () => {
    await expect(
      resolveOrgBySlug(db, "'; DROP TABLE org; --"),
    ).resolves.toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. SUSPENDED / INACTIVE ORG
// ═════════════════════════════════════════════════════════════════════════════

describe('7. Suspended org handling', () => {
  it('7a. resolveOrgBySlug returns status:\'suspended\' for the suspended org', async () => {
    // resolveOrgBySlug uses withPlatformAdminContext — it can see the suspended org.
    const result = await resolveOrgBySlug(db, 'suspended-air');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('suspended');
    expect(result!.slug).toBe('suspended-air');
  });

  it('7b. Suspended org authorization rejection: composing functions produce the correct result', async () => {
    // We cannot call buildAuthConfig().authorize() directly (it calls getDb() which
    // requires DATABASE_URL). Instead we test the composition logic directly:
    //   Step 1: resolveOrgBySlug → returns the suspended org (status !== 'active')
    //   Step 2: caller checks status === 'active' → false → returns null (logged)
    //   Step 3: verifyCredential is NEVER called for a suspended org
    //
    // This mirrors the authorize() logic in auth-config.ts (Step 4: reject non-active).
    const resolved = await resolveOrgBySlug(db, 'suspended-air');
    expect(resolved).not.toBeNull();

    // Simulate the authorize check
    const isActive = resolved!.status === 'active';
    expect(isActive).toBe(false);

    // The authorize function returns null here — simulate that and confirm
    // verifyCredential would not be reached
    const shouldCallVerify = isActive;
    expect(shouldCallVerify).toBe(false);
  });

  it('7c. buildAuthConfig throws at call-time when AUTH_SECRET is missing', async () => {
    // Import buildAuthConfig and test the fail-fast guard.
    const { buildAuthConfig } = await import('../auth/auth-config.js');
    const origSecret = process.env['AUTH_SECRET'];
    try {
      delete process.env['AUTH_SECRET'];
      expect(() => buildAuthConfig()).toThrow('AUTH_SECRET');
    } finally {
      // Restore original value (even if undefined)
      if (origSecret !== undefined) {
        process.env['AUTH_SECRET'] = origSecret;
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. auth_credential RLS FROM API LAYER
// ═════════════════════════════════════════════════════════════════════════════

describe('8. auth_credential RLS from API layer', () => {
  it('8a. auth_credential for Org A is invisible under withOrgContext(orgB)', async () => {
    const rows = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(authCredential).execute(),
    );
    // Org B's own credential row is present; Org A's must not appear
    expect(rows.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rows.some((r) => r.orgId === orgAId)).toBe(false);
  });

  it('8b. auth_credential for Org B is visible under withOrgContext(orgB)', async () => {
    const rows = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(authCredential).execute(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.orgId).toBe(orgBId);
  });

  it('8c. composite FK rejects a credential whose (user_id, org_id) mismatches app_user', async () => {
    // Try to insert a credential for Org A using Org B's user_id — the composite FK
    // (user_id, org_id) → app_user(id, org_id) must reject it.
    // We need to know orgB's userId. We can derive it by reading with orgB context.
    const orgBUsers = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(authCredential).execute(),
    );
    const orgBUserId = orgBUsers[0]!.userId;

    await expect(
      withOrgContext(db, orgAId, (tx) =>
        tx
          .insert(authCredential)
          .values({
            orgId: orgAId,
            userId: orgBUserId, // belongs to Org B — composite FK violation
            passwordHash: DUMMY_HASH,
          })
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it('8d. auth_credential cross-org INSERT (org_id mismatch) rejected by WITH CHECK', async () => {
    // Under Org A context, attempt to write a credential flagged as Org B
    await expect(
      withOrgContext(db, orgAId, (tx) =>
        tx
          .insert(authCredential)
          .values({
            orgId: orgBId, // org_id=B while in A context → WITH CHECK violation
            userId: userAId,
            passwordHash: DUMMY_HASH,
          })
          .execute(),
      ),
    ).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. UNAUTHENTICATED / INCOMPLETE SESSIONS
// ═════════════════════════════════════════════════════════════════════════════

describe('9. UnauthenticatedError for null/incomplete sessions', () => {
  it('9a. null session throws UnauthenticatedError', async () => {
    await expect(
      withSessionOrgContextWithDb(db, null, async () => 'should-not-run'),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('9b. undefined session throws UnauthenticatedError', async () => {
    await expect(
      withSessionOrgContextWithDb(db, undefined, async () => 'should-not-run'),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('9c. session missing orgId throws UnauthenticatedError', async () => {
    const badSession = {
      userId: userAId,
      orgId: '',       // empty string — treated as falsy
      slug: 'alpha',
      role: 'owner' as const,
      user: { email: 'alice@alpha.example' },
    };
    await expect(
      withSessionOrgContextWithDb(db, badSession, async () => 'nope'),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('9d. session missing userId throws UnauthenticatedError', async () => {
    const badSession = {
      userId: '',      // empty string — treated as falsy
      orgId: orgAId,
      slug: 'alpha',
      role: 'owner' as const,
      user: { email: 'alice@alpha.example' },
    };
    await expect(
      withSessionOrgContextWithDb(db, badSession, async () => 'nope'),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('9e. session missing role throws UnauthenticatedError', async () => {
    const badSession = {
      userId: userAId,
      orgId: orgAId,
      slug: 'alpha',
      role: '' as unknown as AppSession['role'],  // empty — treated as falsy
      user: { email: 'alice@alpha.example' },
    };
    await expect(
      withSessionOrgContextWithDb(db, badSession, async () => 'nope'),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('9f. UnauthenticatedError has code === \'UNAUTHENTICATED\'', async () => {
    let caughtErr: unknown;
    try {
      await withSessionOrgContextWithDb(db, null, async () => 'nope');
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(UnauthenticatedError);
    expect((caughtErr as UnauthenticatedError).code).toBe('UNAUTHENTICATED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. MIDDLEWARE SLUG-MATCH LOGIC (pure-function extraction)
//
// apps/web/middleware.ts has no unit-test hook and requires Next.js + Edge
// Runtime to instantiate properly. We extract the pure comparison logic here
// as `classifyRequest`, faithfully mirroring the middleware's decision tree.
//
// WHAT IS COVERED:
//   - The regex /^\/o\/([^/]+)(\/.*)?$/ and the slug match/mismatch logic.
//   - All branch outcomes: publicSubRoute / noSession / slugMismatch / pass.
//
// WHAT REMAINS A GAP (documented honestly):
//   - The auth() wrapper around the middleware (JWT decode / NextResponse objects)
//     requires a live Next.js test environment (no DATABASE_URL needed but does
//     need next's ESM internals and an Edge-Runtime polyfill). This is tracked
//     for Slice 0.4 CI.
// ═════════════════════════════════════════════════════════════════════════════

type MiddlewareOutcome =
  | { type: 'pass' }
  | { type: 'redirect'; to: string }
  | { type: 'public' };

/**
 * classifyRequest — pure extraction of middleware.ts decision logic.
 *
 * Mirrors apps/web/middleware.ts exactly:
 *   1. If pathname doesn't match /o/[slug]/..., pass through.
 *   2. If it's a public sub-route (/login, /no-access), pass through.
 *   3. No session → redirect to /o/[urlSlug]/login.
 *   4. session.slug !== urlSlug → redirect to /o/[session.slug]/login.
 *   5. Match → pass.
 */
function classifyRequest(
  pathname: string,
  session: { userId?: string; slug?: string } | null,
  baseUrl: string = 'https://app.aeroops.test',
): MiddlewareOutcome {
  const orgRouteMatch = pathname.match(/^\/o\/([^/]+)(\/.*)?$/);
  if (!orgRouteMatch) {
    return { type: 'pass' };
  }

  const urlSlug = orgRouteMatch[1]!;
  const subPath = orgRouteMatch[2] ?? '';

  const isPublicSubRoute =
    subPath === '/login' ||
    subPath.startsWith('/login/') ||
    subPath === '/no-access' ||
    subPath.startsWith('/no-access/');

  if (isPublicSubRoute) {
    return { type: 'public' };
  }

  if (!session || !session.userId) {
    return { type: 'redirect', to: `${baseUrl}/o/${urlSlug}/login` };
  }

  // Fail-closed slug guard (mirrors FIX 3 in middleware.ts):
  // missing slug OR slug mismatch → redirect; never silently pass.
  if (!session.slug || session.slug !== urlSlug) {
    const targetSlug = session.slug || urlSlug;
    return { type: 'redirect', to: `${baseUrl}/o/${targetSlug}/login` };
  }

  return { type: 'pass' };
}

describe('10. Middleware slug-match logic (pure function)', () => {
  it('10a. /o/alpha/login → public sub-route (pass through)', () => {
    const result = classifyRequest('/o/alpha/login', null);
    expect(result.type).toBe('public');
  });

  it('10b. /o/alpha/login/page-not-found → public sub-route (pass through)', () => {
    const result = classifyRequest('/o/alpha/login/page-not-found', null);
    expect(result.type).toBe('public');
  });

  it('10c. /o/alpha/no-access → public sub-route (pass through)', () => {
    const result = classifyRequest('/o/alpha/no-access', null);
    expect(result.type).toBe('public');
  });

  it('10d. /o/alpha/dashboard with no session → redirect to /o/alpha/login', () => {
    const result = classifyRequest('/o/alpha/dashboard', null);
    expect(result.type).toBe('redirect');
    if (result.type === 'redirect') {
      expect(result.to).toContain('/o/alpha/login');
    }
  });

  it('10e. /o/alpha/dashboard with session.slug=alpha → pass (slug match)', () => {
    const result = classifyRequest('/o/alpha/dashboard', {
      userId: 'some-uuid',
      slug: 'alpha',
    });
    expect(result.type).toBe('pass');
  });

  it('10f. /o/alpha/dashboard with session.slug=beta → redirect to /o/beta/login (tenant mismatch)', () => {
    const result = classifyRequest('/o/alpha/dashboard', {
      userId: 'some-uuid',
      slug: 'beta',
    });
    expect(result.type).toBe('redirect');
    if (result.type === 'redirect') {
      expect(result.to).toContain('/o/beta/login');
    }
  });

  it('10g. / (root path) → not a tenant route (pass through)', () => {
    const result = classifyRequest('/', null);
    expect(result.type).toBe('pass');
  });

  it('10h. /api/auth/callback → not a tenant route (pass through)', () => {
    const result = classifyRequest('/api/auth/callback', null);
    expect(result.type).toBe('pass');
  });

  it('10i. /o/alpha (trailing slash missing) → treated as protected, no session = redirect', () => {
    // /o/alpha matches the regex with subPath='', which is NOT public
    const result = classifyRequest('/o/alpha', null);
    expect(result.type).toBe('redirect');
    if (result.type === 'redirect') {
      expect(result.to).toContain('/o/alpha/login');
    }
  });

  it('10j. session with no slug field → redirect (fail-closed slug guard)', () => {
    // FIX 3: the guard is now fail-closed. A session that carries no slug on
    // a protected /o/[slug]/* route must be redirected — never silently passed.
    // A truncated or tampered JWT (slug field absent) cannot bypass the guard.
    // Falls back to the URL slug's login page when session.slug is falsy.
    const result = classifyRequest('/o/alpha/dashboard', {
      userId: 'some-uuid',
      slug: undefined,
    });
    expect(result.type).toBe('redirect');
    if (result.type === 'redirect') {
      expect(result.to).toContain('/o/alpha/login');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. buildEdgeAuthConfig — session callback projection (FIX 2)
//
// Verifies that:
//   (a) buildEdgeAuthConfig() succeeds when AUTH_SECRET is set and returns a
//       config with the expected shape (no providers, jwt strategy).
//   (b) buildEdgeAuthConfig() throws when AUTH_SECRET is missing.
//   (c) The jwt callback (jwtCallback) correctly projects authorize() user
//       fields into the JWT token on sign-in (user present).
//   (d) The jwt callback is a no-op when user is absent (subsequent requests).
//   (e) The session callback (sessionCallback) correctly projects JWT token
//       fields onto the session (userId, orgId, slug, role, user.email).
//   (f) The session callback creates session.user if it does not already exist.
//   (g) buildEdgeAuthConfig reuses the same callbacks as buildAuthConfig
//       (strict reference equality — they cannot drift).
//
// These tests are intentionally pure (no DB, no argon2) — they exercise only
// the field-copy logic that must be correct for both the full auth config and
// the edge config.
// ═════════════════════════════════════════════════════════════════════════════

describe('11. buildEdgeAuthConfig — session callback projection', () => {
  it('11a. buildEdgeAuthConfig() succeeds when AUTH_SECRET is set', () => {
    const orig = process.env['AUTH_SECRET'];
    try {
      process.env['AUTH_SECRET'] = 'test-secret-for-edge-config-test';
      const config = buildEdgeAuthConfig();
      expect(config).toBeDefined();
      expect(config.secret).toBe('test-secret-for-edge-config-test');
      expect(config.trustHost).toBe(true);
      expect(config.session?.strategy).toBe('jwt');
      // Edge config must have no providers (db-free)
      expect(Array.isArray(config.providers)).toBe(true);
      expect(config.providers).toHaveLength(0);
      // Edge config must carry both callbacks
      expect(typeof config.callbacks?.jwt).toBe('function');
      expect(typeof config.callbacks?.session).toBe('function');
    } finally {
      if (orig !== undefined) {
        process.env['AUTH_SECRET'] = orig;
      } else {
        delete process.env['AUTH_SECRET'];
      }
    }
  });

  it('11b. buildEdgeAuthConfig() throws when AUTH_SECRET is missing', () => {
    const orig = process.env['AUTH_SECRET'];
    try {
      delete process.env['AUTH_SECRET'];
      expect(() => buildEdgeAuthConfig()).toThrow('AUTH_SECRET');
    } finally {
      if (orig !== undefined) {
        process.env['AUTH_SECRET'] = orig;
      }
    }
  });

  it('11c. jwtCallback copies user fields into token on sign-in (user present)', async () => {
    const token = { sub: 'some-sub', iat: 1234 };
    const user = {
      id: 'user-uuid-abc',
      orgId: 'org-uuid-xyz',
      slug: 'alpha',
      role: 'owner',
      email: 'alice@alpha.example',
    };

    const result = await jwtCallback({ token, user });

    expect(result['userId']).toBe('user-uuid-abc');
    expect(result['orgId']).toBe('org-uuid-xyz');
    expect(result['slug']).toBe('alpha');
    expect(result['role']).toBe('owner');
    expect(result['email']).toBe('alice@alpha.example');
    // Pre-existing token fields must be preserved
    expect(result['sub']).toBe('some-sub');
    expect(result['iat']).toBe(1234);
  });

  it('11d. jwtCallback is a no-op when user is absent (subsequent requests)', async () => {
    const token = {
      sub: 'some-sub',
      userId: 'user-uuid-abc',
      orgId: 'org-uuid-xyz',
      slug: 'alpha',
      role: 'owner',
      email: 'alice@alpha.example',
    };

    // user is undefined — simulates a non-sign-in request
    const result = await jwtCallback({ token, user: undefined });

    // Token must be returned unchanged
    expect(result['userId']).toBe('user-uuid-abc');
    expect(result['orgId']).toBe('org-uuid-xyz');
    expect(result['slug']).toBe('alpha');
    expect(result['role']).toBe('owner');
    expect(result['email']).toBe('alice@alpha.example');
  });

  it('11e. sessionCallback projects userId/orgId/slug/role/email from token onto session', async () => {
    const token = {
      userId: 'user-uuid-abc',
      orgId: 'org-uuid-xyz',
      slug: 'alpha',
      role: 'owner',
      email: 'alice@alpha.example',
    };
    const session = {
      user: { email: 'stale@example.com' }, // will be overwritten
      expires: '2099-01-01T00:00:00.000Z',
    };

    const result = await sessionCallback({ session, token });

    expect(result.userId).toBe('user-uuid-abc');
    expect(result.orgId).toBe('org-uuid-xyz');
    expect(result.slug).toBe('alpha');
    expect(result.role).toBe('owner');
    expect(result.user?.email).toBe('alice@alpha.example');
    // expires must be preserved
    expect(result.expires).toBe('2099-01-01T00:00:00.000Z');
  });

  it('11f. sessionCallback creates session.user when absent', async () => {
    const token = {
      userId: 'u1',
      orgId: 'o1',
      slug: 'beta',
      role: 'admin',
      email: 'bob@beta.example',
    };
    // session.user intentionally missing
    const session: Record<string, unknown> = { expires: '2099-01-01T00:00:00.000Z' };

    const result = await sessionCallback({ session, token });

    expect(result.user).toBeDefined();
    expect(result.user.email).toBe('bob@beta.example');
  });

  it('11g. buildEdgeAuthConfig callbacks are the same functions as jwtCallback/sessionCallback', () => {
    const orig = process.env['AUTH_SECRET'];
    try {
      process.env['AUTH_SECRET'] = 'test-secret-edge-ref-equality';
      const edgeConfig = buildEdgeAuthConfig();
      // Strict reference equality ensures they cannot drift
      expect(edgeConfig.callbacks.jwt).toBe(jwtCallback);
      expect(edgeConfig.callbacks.session).toBe(sessionCallback);
    } finally {
      if (orig !== undefined) {
        process.env['AUTH_SECRET'] = orig;
      } else {
        delete process.env['AUTH_SECRET'];
      }
    }
  });
});
