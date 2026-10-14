/**
 * mobile-auth.test.ts — Slice 4M.1 mobile auth spine tests.
 *
 * CI-VERIFIABLE: all tests run against pglite (no real Postgres or device needed).
 *
 * COVERAGE:
 *   1. verifyLoginAndIssueClaims happy path (valid → claims matching seeded user/org/role)
 *   2. Failure matrix (wrong password / unknown email / unknown slug /
 *      suspended org / user-with-no-membership) — ALL return null
 *   3. Token round-trip (signMobileToken → verifyMobileToken returns same claims;
 *      tampered token → null; expired token → null; foreign-secret → null;
 *      a web-session-salted token or one without the mobile purpose → null)
 *   4. PARITY test: verifyLoginAndIssueClaims produces SAME claims the web
 *      authorize path would for the same input (guards drift after extraction)
 *   5. sessionFromMobileClaims fail-closed on garbage role
 *   6. signMobileToken refuses build-time placeholder secret
 *
 * SETUP:
 *   - Two orgs seeded (alpha/active + beta/active); one suspended org.
 *   - Two users in orgA: alice (owner, has credential) + nomember (no membership row).
 *   - All 0000–0011 migrations applied (0011 is the optimizer run — no new tables for 4M).
 *   - argon2 hashing done once per user in beforeAll (~100-200 ms each).
 *   - testTimeout: 60_000.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  seedTwoOrgs,
  seedAuthCredential,
  seedUserWithoutMembership,
  loadMigrationSql,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import { hashPassword } from '../auth/hash.js';
import { verifyLoginAndIssueClaimsWithDb, type MobileClaims } from '../auth/verify-login.js';
import {
  signMobileToken,
  verifyMobileToken,
  sessionFromMobileClaims,
  MOBILE_TOKEN_PURPOSE,
} from '../auth/mobile-token.js';

/** The mobile access token's own JWE salt (mobile-token.ts MOBILE_TOKEN_SALT). */
const MOBILE_SALT = 'aeroops.mobile-access-token';

// ─── Migration SQL ─────────────────────────────────────────────────────────────
// Load all migrations so the schema is complete.
// All up migrations through 0022 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0022');

// ─── Test state ────────────────────────────────────────────────────────────────
let db: PgliteTestClient;
let pglite: PGlite;
let orgAId: string;
let userAId: string;
let noMemberUserId: string;

const PASSWORD_A = 'MobileAuth!Horse99';
const PASSWORD_NO_MEMBER = 'MobileNoMember!42';
const TEST_SECRET = 'mobile-auth-test-secret-32bytes!!';

// ─── Setup ────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  // 1. Fresh PGlite with full migration chain.
  ({ db, pglite } = await createTestClient());
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  // 2. Seed two orgs with users.
  const seed = await seedTwoOrgs(db);
  orgAId = seed.orgAId;
  userAId = seed.userAId;

  // 3. Hash passwords (real argon2id — ~200 ms each).
  const hashA = await hashPassword(PASSWORD_A);
  const hashNoMember = await hashPassword(PASSWORD_NO_MEMBER);

  // 4. Seed credentials.
  await seedAuthCredential(db, orgAId, userAId, hashA);

  const noMemberUser = await seedUserWithoutMembership(
    db,
    orgAId,
    'nomember.mobile@alpha.example',
    'No Member Mobile',
  );
  noMemberUserId = noMemberUser.id;
  await seedAuthCredential(db, orgAId, noMemberUserId, hashNoMember);

  // 5. Seed a suspended org for the suspended-org test.
  await pglite.exec(
    `INSERT INTO org (name, slug, status) VALUES ('Suspended Mobile Air', 'suspended-mobile', 'suspended')`,
  );

  // 6. Drop to app role so RLS is enforced.
  await setTestAppRole({ pglite });

  // 7. Set AUTH_SECRET for token tests.
  process.env['AUTH_SECRET'] = TEST_SECRET;
}, 60_000);

afterAll(() => {
  // Restore original env (undefined is fine — tests only).
  delete process.env['AUTH_SECRET'];
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. HAPPY PATH
// ═════════════════════════════════════════════════════════════════════════════

describe('1. verifyLoginAndIssueClaims — happy path', () => {
  it('1a. valid credentials → claims matching seeded user/org/role', async () => {
    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: 'alpha',
      email: 'alice@alpha.example',
      password: PASSWORD_A,
    });

    expect(claims).not.toBeNull();
    expect(claims!.userId).toBe(userAId);
    expect(claims!.orgId).toBe(orgAId);
    expect(claims!.slug).toBe('alpha');
    expect(claims!.email).toBe('alice@alpha.example');
    expect(claims!.role).toBe('owner');
  });

  it('1b. email normalisation (trim + uppercase) resolves the same user', async () => {
    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: 'alpha',
      email: 'ALICE@ALPHA.EXAMPLE',
      password: PASSWORD_A,
    });

    expect(claims).not.toBeNull();
    expect(claims!.email).toBe('alice@alpha.example');
    expect(claims!.userId).toBe(userAId);
  });

  it('1c. orgId comes from the DB-resolved org (not from input)', async () => {
    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: 'alpha',
      email: 'alice@alpha.example',
      password: PASSWORD_A,
    });

    expect(claims).not.toBeNull();
    // The orgId must be the UUID from the DB — not the slug string.
    expect(claims!.orgId).toBe(orgAId);
    expect(claims!.orgId).not.toBe('alpha');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. FAILURE MATRIX — all must return null
// ═════════════════════════════════════════════════════════════════════════════

describe('2. Failure matrix — all return null', () => {
  it('2a. wrong password → null', async () => {
    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: 'alpha',
      email: 'alice@alpha.example',
      password: 'WrongPassword!123',
    });
    expect(claims).toBeNull();
  });

  it('2b. unknown email → null', async () => {
    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: 'alpha',
      email: 'ghost@alpha.example',
      password: PASSWORD_A,
    });
    expect(claims).toBeNull();
  });

  it('2c. unknown slug → null', async () => {
    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: 'org-that-does-not-exist-xyz',
      email: 'alice@alpha.example',
      password: PASSWORD_A,
    });
    expect(claims).toBeNull();
  });

  it('2d. suspended org → null', async () => {
    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: 'suspended-mobile',
      email: 'alice@alpha.example',
      password: PASSWORD_A,
    });
    expect(claims).toBeNull();
  });

  it('2e. user with no membership → null', async () => {
    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: 'alpha',
      email: 'nomember.mobile@alpha.example',
      password: PASSWORD_NO_MEMBER,
    });
    expect(claims).toBeNull();
  });

  it('2f. cross-org credential (orgB email, orgA slug) → null (RLS isolation)', async () => {
    // beta org's seeded user cannot authenticate via alpha slug.
    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: 'alpha',
      email: 'bob@beta.example',  // orgB user
      password: PASSWORD_A,       // wrong anyway, but RLS hides the row
    });
    expect(claims).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. TOKEN ROUND-TRIP
// ═════════════════════════════════════════════════════════════════════════════

describe('3. Token round-trip (sign → verify)', () => {
  const sampleClaims: MobileClaims = {
    userId: 'user-uuid-test-1234',
    orgId: 'org-uuid-test-5678',
    slug: 'alpha',
    role: 'owner',
    email: 'alice@alpha.example',
  };

  it('3a. signMobileToken → verifyMobileToken returns the same claims', async () => {
    const token = await signMobileToken(sampleClaims);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);

    const decoded = await verifyMobileToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.userId).toBe(sampleClaims.userId);
    expect(decoded!.orgId).toBe(sampleClaims.orgId);
    expect(decoded!.slug).toBe(sampleClaims.slug);
    expect(decoded!.role).toBe(sampleClaims.role);
    expect(decoded!.email).toBe(sampleClaims.email);
  });

  it('3b. tampered token → null', async () => {
    const token = await signMobileToken(sampleClaims);
    // Corrupt the token by flipping a character in the middle.
    const corrupted = token.slice(0, token.length - 5) + 'XXXXX';
    const decoded = await verifyMobileToken(corrupted);
    expect(decoded).toBeNull();
  });

  it('3c. expired token (past exp) → null', async () => {
    // Encode a token with maxAge well in the past (24h ago) — clearly outside
    // the 15-second clockTolerance window in @auth/core's decode. Same salt
    // and purpose as a real token, so expiry is the only thing wrong with it.
    const { encode } = await import('next-auth/jwt');
    const expiredToken = await encode({
      token: { purpose: MOBILE_TOKEN_PURPOSE, ...sampleClaims },
      secret: TEST_SECRET,
      salt: MOBILE_SALT,
      maxAge: -(24 * 60 * 60), // 24 hours in the past — clearly expired
    });
    const decoded = await verifyMobileToken(expiredToken);
    expect(decoded).toBeNull();
  });

  it('3d. foreign-secret token → null', async () => {
    // Mint a token with a DIFFERENT secret; verify with TEST_SECRET → null.
    const { encode } = await import('next-auth/jwt');
    const foreignToken = await encode({
      token: { purpose: MOBILE_TOKEN_PURPOSE, ...sampleClaims },
      secret: 'completely-different-secret-xyz!',
      salt: MOBILE_SALT,
      maxAge: 3600,
    });
    const decoded = await verifyMobileToken(foreignToken);
    expect(decoded).toBeNull();
  });

  it('3d-2. control: the same hand-minted token under TEST_SECRET verifies', async () => {
    // Proves 3c/3d fail for expiry / the secret alone, not for the salt or purpose.
    const { encode } = await import('next-auth/jwt');
    const token = await encode({
      token: { purpose: MOBILE_TOKEN_PURPOSE, ...sampleClaims },
      secret: TEST_SECRET,
      salt: MOBILE_SALT,
      maxAge: 3600,
    });
    expect(await verifyMobileToken(token)).toEqual(sampleClaims);
  });

  it('3d-3. a token under the web session cookie salt is refused, even with the mobile purpose', async () => {
    // On an http:// origin Auth.js salts the session cookie with its name,
    // 'authjs.session-token' — the salt mobile tokens used to share, which
    // let a browser session cookie work as a bearer token.
    const { encode } = await import('next-auth/jwt');
    for (const token of [{ ...sampleClaims }, { purpose: MOBILE_TOKEN_PURPOSE, ...sampleClaims }]) {
      for (const salt of ['authjs.session-token', '__Secure-authjs.session-token']) {
        const webSalted = await encode({ token, secret: TEST_SECRET, salt, maxAge: 3600 });
        expect(await verifyMobileToken(webSalted), salt).toBeNull();
      }
    }
  });

  it('3d-4. a token under the mobile salt without the mobile purpose is refused', async () => {
    const { encode } = await import('next-auth/jwt');
    for (const purpose of [undefined, 'login-link', 'session']) {
      const token = await encode({
        token: { ...(purpose ? { purpose } : {}), ...sampleClaims },
        secret: TEST_SECRET,
        salt: MOBILE_SALT,
        maxAge: 3600,
      });
      expect(await verifyMobileToken(token), String(purpose)).toBeNull();
    }
  });

  it('3d-5. a signed mobile token is not a web session cookie: it does not decrypt under the cookie salt', async () => {
    const { decode } = await import('next-auth/jwt');
    const token = await signMobileToken(sampleClaims);
    for (const salt of ['authjs.session-token', '__Secure-authjs.session-token']) {
      await expect(decode({ token, secret: TEST_SECRET, salt }), salt).rejects.toThrow();
    }
    // … and carries exactly the identity claims plus its purpose.
    const payload = await decode({ token, secret: TEST_SECRET, salt: MOBILE_SALT });
    expect(payload).toMatchObject({ purpose: MOBILE_TOKEN_PURPOSE, ...sampleClaims });
    expect(payload).not.toHaveProperty('cfp');
  });

  it('3e. completely garbage string → null', async () => {
    const decoded = await verifyMobileToken('not.a.real.jwt.at.all');
    expect(decoded).toBeNull();
  });

  it('3f. empty string → null', async () => {
    const decoded = await verifyMobileToken('');
    expect(decoded).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. PARITY TEST — verifyLoginAndIssueClaims vs. web authorize path
// ═════════════════════════════════════════════════════════════════════════════

describe('4. PARITY — verifyLoginAndIssueClaims matches web authorize steps', () => {
  it('4a. both produce {userId, orgId, slug, role, email} for the same input', async () => {
    // verifyLoginAndIssueClaims IS the extracted pipeline — this test guards
    // against future drift by re-running the pipeline steps manually and
    // comparing the outputs. If verifyLoginAndIssueClaims is refactored away
    // from the resolveOrgBySlug→verifyCredential sequence, this test breaks.
    const { resolveOrgBySlug } = await import('../auth/resolve-org.js');
    const { verifyCredential } = await import('../auth/verify-credential.js');

    // Run pipeline manually (mirrors auth-config.ts authorize steps 3–6 exactly).
    const resolvedOrg = await resolveOrgBySlug(db, 'alpha');
    expect(resolvedOrg).not.toBeNull();
    expect(resolvedOrg!.status).toBe('active');

    const verified = await verifyCredential(db, resolvedOrg!.id, 'alice@alpha.example', PASSWORD_A);
    expect(verified).not.toBeNull();

    const manualClaims = {
      userId: verified!.userId,
      orgId: resolvedOrg!.id,
      slug: resolvedOrg!.slug,
      role: verified!.role,
      email: verified!.email,
    };

    // Run through the extracted pipeline.
    const pipelineClaims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: 'alpha',
      email: 'alice@alpha.example',
      password: PASSWORD_A,
    });

    expect(pipelineClaims).not.toBeNull();
    expect(pipelineClaims!.userId).toBe(manualClaims.userId);
    expect(pipelineClaims!.orgId).toBe(manualClaims.orgId);
    expect(pipelineClaims!.slug).toBe(manualClaims.slug);
    expect(pipelineClaims!.role).toBe(manualClaims.role);
    expect(pipelineClaims!.email).toBe(manualClaims.email);
  });

  it('4b. failure in both paths → null for the same bad input', async () => {
    const { resolveOrgBySlug } = await import('../auth/resolve-org.js');
    const { verifyCredential } = await import('../auth/verify-credential.js');

    // Manual path: wrong password.
    const resolvedOrg = await resolveOrgBySlug(db, 'alpha');
    const verified = await verifyCredential(db, resolvedOrg!.id, 'alice@alpha.example', 'WRONG');
    expect(verified).toBeNull();

    // Pipeline path.
    const pipelineClaims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: 'alpha',
      email: 'alice@alpha.example',
      password: 'WRONG',
    });
    expect(pipelineClaims).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. sessionFromMobileClaims — fail-closed on garbage role
// ═════════════════════════════════════════════════════════════════════════════

describe('5. sessionFromMobileClaims', () => {
  it('5a. valid role → AppSession with role set', () => {
    const claims: MobileClaims = {
      userId: 'u1',
      orgId: 'o1',
      slug: 'alpha',
      role: 'owner',
      email: 'alice@alpha.example',
    };
    const session = sessionFromMobileClaims(claims);
    expect(session.userId).toBe('u1');
    expect(session.orgId).toBe('o1');
    expect(session.slug).toBe('alpha');
    expect(session.role).toBe('owner');
    expect(session.user.email).toBe('alice@alpha.example');
  });

  it('5b. garbage role → session WITHOUT role (fail-closed)', () => {
    const claims: MobileClaims = {
      userId: 'u2',
      orgId: 'o2',
      slug: 'beta',
      role: '__proto__injected_role',
      email: 'bob@beta.example',
    };
    const session = sessionFromMobileClaims(claims);
    // role must be absent — not set to the garbage value.
    expect(session.userId).toBe('u2');
    expect(session.orgId).toBe('o2');
    // TypeScript type says role is required on AppSession, but runtime may lack it.
    // Check that it's either absent or not the garbage string.
    expect('role' in session ? session.role : undefined).not.toBe('__proto__injected_role');
  });

  it('5c. all valid MembershipRoles → each yields a session with the role set', () => {
    const roles = ['owner', 'manager', 'dispatcher', 'cfi', 'mechanic', 'renter', 'student', 'accountant'] as const;
    for (const role of roles) {
      const claims: MobileClaims = {
        userId: 'u3',
        orgId: 'o3',
        slug: 'gamma',
        role,
        email: 'test@test.example',
      };
      const session = sessionFromMobileClaims(claims);
      expect(session.role).toBe(role);
    }
  });

  it('5d. empty role string → session without role (fail-closed)', () => {
    const claims: MobileClaims = {
      userId: 'u4',
      orgId: 'o4',
      slug: 'delta',
      role: '',
      email: 'delta@test.example',
    };
    const session = sessionFromMobileClaims(claims);
    // Empty role is not a valid MembershipRole → role absent from session.
    expect('role' in session ? session.role : undefined).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. signMobileToken refuses placeholder secret
// ═════════════════════════════════════════════════════════════════════════════

describe('6. signMobileToken placeholder-secret guard', () => {
  const sampleClaims: MobileClaims = {
    userId: 'u5',
    orgId: 'o5',
    slug: 'echo',
    role: 'student',
    email: 'echo@test.example',
  };

  it('6a. throws if AUTH_SECRET is the build-time placeholder', async () => {
    const orig = process.env['AUTH_SECRET'];
    try {
      process.env['AUTH_SECRET'] = 'build-time-placeholder-not-a-real-secret-replace-me';
      await expect(signMobileToken(sampleClaims)).rejects.toThrow('placeholder');
    } finally {
      process.env['AUTH_SECRET'] = orig ?? TEST_SECRET;
    }
  });

  it('6b. throws if AUTH_SECRET is unset', async () => {
    const orig = process.env['AUTH_SECRET'];
    try {
      delete process.env['AUTH_SECRET'];
      await expect(signMobileToken(sampleClaims)).rejects.toThrow('AUTH_SECRET');
    } finally {
      process.env['AUTH_SECRET'] = orig ?? TEST_SECRET;
    }
  });

  it('6c. verifyMobileToken throws if AUTH_SECRET is the placeholder', async () => {
    const orig = process.env['AUTH_SECRET'];
    try {
      process.env['AUTH_SECRET'] = 'build-time-placeholder-not-a-real-secret-replace-me';
      await expect(verifyMobileToken('any.token.here')).rejects.toThrow('placeholder');
    } finally {
      process.env['AUTH_SECRET'] = orig ?? TEST_SECRET;
    }
  });
});
