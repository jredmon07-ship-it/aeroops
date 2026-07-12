/**
 * mobile-session.test.ts — Slice 4M-REVOKE tests ([VERIFY-4M-SEC-1] predecessor).
 *
 * CI-VERIFIABLE: all tests run against pglite (no real Postgres or device needed).
 *
 * COVERAGE:
 *   1. issueMobileSession stores a HASH, never the raw refresh token.
 *   2. The issued access token verifies via verifyMobileToken (same claim shape).
 *   3. refreshMobileSession rotates: a successful refresh invalidates the
 *      presented (old) refresh token immediately.
 *   4. REUSE DETECTION: presenting an already-rotated refresh token revokes
 *      the ENTIRE forward chain (fail-closed) — even the newest, otherwise-
 *      still-valid token stops working.
 *   5. A plainly revoked (logout) or expired refresh token → null.
 *   6. revokeMobileSession is idempotent.
 *   7. revokeAllMobileSessionsForUser: self-service works with baseline
 *      app:access; revoking ANOTHER user's sessions requires people:manage
 *      (ForbiddenError otherwise); cross-org isolation (an org-B session can
 *      never revoke an org-A user's sessions).
 *   8. Defensive refresh checks: org suspended / membership removed after
 *      login → refresh fails closed.
 *   9. Tenant isolation (T-ISO): mobile_session rows are invisible across
 *      orgs under normal (non-platform-admin) org context.
 *
 * SETUP: two orgs seeded (alpha/beta) via seedTwoOrgs; migrations 0000–0022
 * + 0033 (mobile_session) applied — mirrors mobile-auth.test.ts's migration
 * list (mobile_session's FKs only touch org/app_user, both from 0000).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  seedTwoOrgs,
  withOrgContext,
  withPlatformAdminContext,
  mobileSession,
  org,
  membership,
  loadMigrationSql,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import {
  issueMobileSessionWithDb,
  refreshMobileSessionWithDb,
  revokeMobileSessionWithDb,
  revokeAllMobileSessionsForUserWithDb,
  generateRefreshToken,
  hashRefreshToken,
  verifyMobileToken,
  ForbiddenError,
} from '../index.js';
import type { MobileClaims } from '../auth/verify-login.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0033 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0033');

let db: PgliteTestClient;
let pglite: PGlite;
let orgAId: string;
let orgBId: string;
let userAId: string;
let userBId: string;

const TEST_SECRET = 'mobile-session-test-secret-32bytes!!';

let claimsA: MobileClaims;
let claimsB: MobileClaims;

beforeAll(async () => {
  ({ db, pglite } = await createTestClient());
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const seed = await seedTwoOrgs(db);
  orgAId = seed.orgAId;
  orgBId = seed.orgBId;
  userAId = seed.userAId;
  userBId = seed.userBId;

  await setTestAppRole({ pglite });

  process.env['AUTH_SECRET'] = TEST_SECRET;

  claimsA = {
    userId: userAId,
    orgId: orgAId,
    slug: 'alpha',
    role: 'owner',
    email: 'alice@alpha.example',
  };
  claimsB = {
    userId: userBId,
    orgId: orgBId,
    slug: 'beta',
    role: 'owner',
    email: 'bob@beta.example',
  };
}, 60_000);

afterAll(() => {
  delete process.env['AUTH_SECRET'];
});

// Helper: read a mobile_session row directly (bypasses the command layer;
// used only to assert on internal DB state, e.g. the stored hash).
async function readSessionRow(orgId: string, id: string) {
  return withOrgContext(db, orgId, async (tx) => {
    const rows = await tx.select().from(mobileSession).where(eq(mobileSession.id, id)).limit(1);
    return rows[0] ?? null;
  });
}

async function findSessionByHash(hash: string) {
  return withPlatformAdminContext(db, async (tx) => {
    const rows = await tx.select().from(mobileSession).where(eq(mobileSession.refreshTokenHash, hash)).limit(1);
    return rows[0] ?? null;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. issueMobileSession — never stores the raw refresh token
// ═════════════════════════════════════════════════════════════════════════════

describe('1. issueMobileSession', () => {
  it('1a. stores a HASH, not the raw refresh token', async () => {
    const issued = await issueMobileSessionWithDb(db, claimsA);
    const hash = hashRefreshToken(issued.refreshToken);
    const row = await findSessionByHash(hash);

    expect(row).not.toBeNull();
    expect(row!.refreshTokenHash).toBe(hash);
    // The raw token must NEVER appear as the stored hash value.
    expect(row!.refreshTokenHash).not.toBe(issued.refreshToken);
    // And the raw token must not be trivially recoverable/stored verbatim
    // anywhere in the row's own hash field.
    expect(row!.refreshTokenHash.includes(issued.refreshToken)).toBe(false);
  });

  it('1b. the access token verifies via verifyMobileToken with the same claims', async () => {
    const issued = await issueMobileSessionWithDb(db, claimsA);
    const decoded = await verifyMobileToken(issued.accessToken);

    expect(decoded).not.toBeNull();
    expect(decoded!.userId).toBe(claimsA.userId);
    expect(decoded!.orgId).toBe(claimsA.orgId);
    expect(decoded!.slug).toBe(claimsA.slug);
    expect(decoded!.role).toBe(claimsA.role);
    expect(decoded!.email).toBe(claimsA.email);
  });

  it('1c. generateRefreshToken produces a long, URL-safe random string', () => {
    const t1 = generateRefreshToken();
    const t2 = generateRefreshToken();
    expect(t1).not.toBe(t2);
    expect(t1.length).toBeGreaterThan(30);
    expect(/^[A-Za-z0-9_-]+$/.test(t1)).toBe(true);
  });

  it('1d. hashRefreshToken is deterministic (same input → same hash)', () => {
    const raw = generateRefreshToken();
    expect(hashRefreshToken(raw)).toBe(hashRefreshToken(raw));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. refreshMobileSession — rotation
// ═════════════════════════════════════════════════════════════════════════════

describe('2. refreshMobileSession — rotation', () => {
  it('2a. a valid refresh returns a NEW pair and rotates the old row', async () => {
    const issued = await issueMobileSessionWithDb(db, claimsA);
    const oldHash = hashRefreshToken(issued.refreshToken);
    const oldRowBefore = await findSessionByHash(oldHash);

    const refreshed = await refreshMobileSessionWithDb(db, issued.refreshToken);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.refreshToken).not.toBe(issued.refreshToken);
    expect(refreshed!.accessToken).not.toBe(issued.accessToken);

    const oldRowAfter = await readSessionRow(orgAId, oldRowBefore!.id);
    expect(oldRowAfter!.revokedAt).not.toBeNull();
    expect(oldRowAfter!.rotatedToId).not.toBeNull();

    const decoded = await verifyMobileToken(refreshed!.accessToken);
    expect(decoded!.userId).toBe(claimsA.userId);
    expect(decoded!.role).toBe(claimsA.role);
  });

  it('2b. the OLD refresh token is rejected after rotation (single-use)', async () => {
    const issued = await issueMobileSessionWithDb(db, claimsA);
    const first = await refreshMobileSessionWithDb(db, issued.refreshToken);
    expect(first).not.toBeNull();

    // Presenting the ORIGINAL (now-rotated) token again must fail.
    const second = await refreshMobileSessionWithDb(db, issued.refreshToken);
    expect(second).toBeNull();
  });

  it('2c. an unknown refresh token → null', async () => {
    const result = await refreshMobileSessionWithDb(db, 'totally-unknown-token-xyz');
    expect(result).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. REUSE DETECTION — fail-closed chain revoke
// ═════════════════════════════════════════════════════════════════════════════

describe('3. Reuse detection revokes the entire forward chain', () => {
  it('3a. reusing an already-rotated token ALSO revokes the newest (legitimate) token', async () => {
    const issued = await issueMobileSessionWithDb(db, claimsA);

    // Legitimate rotation: old -> new1.
    const new1 = await refreshMobileSessionWithDb(db, issued.refreshToken);
    expect(new1).not.toBeNull();

    // THEFT SIGNAL: the original (already-rotated) token is presented again.
    const reuseAttempt = await refreshMobileSessionWithDb(db, issued.refreshToken);
    expect(reuseAttempt).toBeNull();

    // The fail-closed response must also kill new1 — the entire chain.
    const afterReuse = await refreshMobileSessionWithDb(db, new1!.refreshToken);
    expect(afterReuse).toBeNull();
  });

  it('3b. a multi-hop chain is fully revoked on reuse of an early link', async () => {
    const issued = await issueMobileSessionWithDb(db, claimsA);
    const gen1 = await refreshMobileSessionWithDb(db, issued.refreshToken);
    const gen2 = await refreshMobileSessionWithDb(db, gen1!.refreshToken);
    const gen3 = await refreshMobileSessionWithDb(db, gen2!.refreshToken);
    expect(gen3).not.toBeNull();

    // Replay the FIRST (oldest) token in the chain.
    const reuse = await refreshMobileSessionWithDb(db, issued.refreshToken);
    expect(reuse).toBeNull();

    // Every descendant, including the newest (gen3), must now be dead.
    expect(await refreshMobileSessionWithDb(db, gen1!.refreshToken)).toBeNull();
    expect(await refreshMobileSessionWithDb(db, gen2!.refreshToken)).toBeNull();
    expect(await refreshMobileSessionWithDb(db, gen3!.refreshToken)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Plainly revoked / expired → null
// ═════════════════════════════════════════════════════════════════════════════

describe('4. Revoked / expired refresh tokens fail closed', () => {
  it('4a. a logged-out (revoked) refresh token → null on refresh', async () => {
    const issued = await issueMobileSessionWithDb(db, claimsA);
    await revokeMobileSessionWithDb(db, issued.refreshToken);

    const result = await refreshMobileSessionWithDb(db, issued.refreshToken);
    expect(result).toBeNull();
  });

  it('4b. an expired (but not revoked) refresh token → null on refresh', async () => {
    const issued = await issueMobileSessionWithDb(db, claimsA);
    const hash = hashRefreshToken(issued.refreshToken);
    const row = await findSessionByHash(hash);

    // Force expiry directly (simulates 30 days passing).
    await withOrgContext(db, orgAId, async (tx) => {
      await tx
        .update(mobileSession)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(mobileSession.id, row!.id));
    });

    const result = await refreshMobileSessionWithDb(db, issued.refreshToken);
    expect(result).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. revokeMobileSession — idempotent (logout)
// ═════════════════════════════════════════════════════════════════════════════

describe('5. revokeMobileSession (logout)', () => {
  it('5a. revoking twice is a no-op the second time (no throw)', async () => {
    const issued = await issueMobileSessionWithDb(db, claimsA);
    await expect(revokeMobileSessionWithDb(db, issued.refreshToken)).resolves.toBeUndefined();
    await expect(revokeMobileSessionWithDb(db, issued.refreshToken)).resolves.toBeUndefined();

    const hash = hashRefreshToken(issued.refreshToken);
    const row = await findSessionByHash(hash);
    expect(row!.revokedAt).not.toBeNull();
  });

  it('5b. revoking an unknown token is a silent no-op (no throw)', async () => {
    await expect(revokeMobileSessionWithDb(db, 'never-issued-token')).resolves.toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. revokeAllMobileSessionsForUser — self / admin / cross-org isolation
// ═════════════════════════════════════════════════════════════════════════════

describe('6. revokeAllMobileSessionsForUser', () => {
  it('6a. self-service: a user can revoke all of their OWN sessions', async () => {
    const s1 = await issueMobileSessionWithDb(db, claimsA);
    const s2 = await issueMobileSessionWithDb(db, claimsA);

    const selfSession: AppSession = {
      userId: userAId,
      orgId: orgAId,
      slug: 'alpha',
      role: 'owner',
      user: { email: 'alice@alpha.example' },
    };

    const result = await revokeAllMobileSessionsForUserWithDb(db, selfSession, userAId);
    expect(result.revokedCount).toBeGreaterThanOrEqual(2);

    expect(await refreshMobileSessionWithDb(db, s1.refreshToken)).toBeNull();
    expect(await refreshMobileSessionWithDb(db, s2.refreshToken)).toBeNull();
  });

  it('6b. a non-owner role WITHOUT people:manage cannot revoke another user\'s sessions', async () => {
    const dispatcherSession: AppSession = {
      userId: userAId,
      orgId: orgAId,
      slug: 'alpha',
      role: 'dispatcher',
      user: { email: 'alice@alpha.example' },
    };

    await expect(
      revokeAllMobileSessionsForUserWithDb(db, dispatcherSession, 'some-other-user-id'),
    ).rejects.toThrow(ForbiddenError);
  });

  it('6c. an owner (people:manage) CAN revoke another member\'s sessions in the same org', async () => {
    // Seed a second org-A member session to revoke on their behalf.
    const otherClaims: MobileClaims = { ...claimsA, userId: userAId };
    const issued = await issueMobileSessionWithDb(db, otherClaims);

    const ownerSession: AppSession = {
      userId: userAId,
      orgId: orgAId,
      slug: 'alpha',
      role: 'owner',
      user: { email: 'alice@alpha.example' },
    };

    const result = await revokeAllMobileSessionsForUserWithDb(db, ownerSession, userAId);
    expect(result.revokedCount).toBeGreaterThanOrEqual(1);
    expect(await refreshMobileSessionWithDb(db, issued.refreshToken)).toBeNull();
  });

  it('6d. CROSS-ORG ISOLATION: an org-B session can never revoke an org-A user\'s sessions', async () => {
    const issued = await issueMobileSessionWithDb(db, claimsA);

    const orgBOwnerSession: AppSession = {
      userId: userBId,
      orgId: orgBId,
      slug: 'beta',
      role: 'owner',
      user: { email: 'bob@beta.example' },
    };

    // people:manage lets an owner revoke members WITHIN their own org — but
    // the where-clause scopes strictly to sess.orgId, so targeting an
    // org-A userId from an org-B session must revoke NOTHING.
    const result = await revokeAllMobileSessionsForUserWithDb(db, orgBOwnerSession, userAId);
    expect(result.revokedCount).toBe(0);

    // The org-A session must still be perfectly usable.
    const refreshed = await refreshMobileSessionWithDb(db, issued.refreshToken);
    expect(refreshed).not.toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Defensive refresh checks — org suspended / membership removed since login
// ═════════════════════════════════════════════════════════════════════════════

describe('7. Defensive checks re-evaluated on every refresh', () => {
  it('7a. a suspended org cannot mint a refreshed access token', async () => {
    const issued = await issueMobileSessionWithDb(db, claimsA);

    // org_update's RLS policy scopes to the tenant's OWN org_id (id =
    // current_org_id) — it does NOT admit platform-admin context (unlike
    // org_select). Use withOrgContext, mirroring how an org would update its
    // own settings in production.
    await withOrgContext(db, orgAId, async (tx) => {
      await tx.update(org).set({ status: 'suspended' }).where(eq(org.id, orgAId));
    });

    try {
      const result = await refreshMobileSessionWithDb(db, issued.refreshToken);
      expect(result).toBeNull();
    } finally {
      // Restore for subsequent tests.
      await withOrgContext(db, orgAId, async (tx) => {
        await tx.update(org).set({ status: 'active' }).where(eq(org.id, orgAId));
      });
    }
  });

  it('7b. a removed membership cannot mint a refreshed access token', async () => {
    const issued = await issueMobileSessionWithDb(db, claimsA);

    const removed = await withOrgContext(db, orgAId, async (tx) => {
      const rows = await tx.select().from(membership).where(eq(membership.userId, userAId)).limit(1);
      const row = rows[0]!;
      await tx.delete(membership).where(eq(membership.id, row.id));
      return row;
    });

    try {
      const result = await refreshMobileSessionWithDb(db, issued.refreshToken);
      expect(result).toBeNull();
    } finally {
      // Restore for subsequent tests.
      await withOrgContext(db, orgAId, async (tx) => {
        await tx.insert(membership).values({
          orgId: removed.orgId,
          userId: removed.userId,
          role: removed.role,
        });
      });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. TENANT ISOLATION (T-ISO) — mobile_session invisible cross-org
// ═════════════════════════════════════════════════════════════════════════════

describe('8. T-ISO — mobile_session rows are invisible cross-org under normal context', () => {
  it('8a. an org-B context cannot SELECT an org-A mobile_session row', async () => {
    const issued = await issueMobileSessionWithDb(db, claimsA);
    const hash = hashRefreshToken(issued.refreshToken);

    const rowFromOrgB = await withOrgContext(db, orgBId, async (tx) => {
      const rows = await tx.select().from(mobileSession).where(eq(mobileSession.refreshTokenHash, hash));
      return rows;
    });
    expect(rowFromOrgB).toHaveLength(0);

    // But the SAME row IS visible from org A's own context.
    const rowFromOrgA = await withOrgContext(db, orgAId, async (tx) => {
      const rows = await tx.select().from(mobileSession).where(eq(mobileSession.refreshTokenHash, hash));
      return rows;
    });
    expect(rowFromOrgA).toHaveLength(1);
  });

  it('8b. issuing sessions for both orgs keeps each org\'s claims isolated on refresh', async () => {
    const issuedA = await issueMobileSessionWithDb(db, claimsA);
    const issuedB = await issueMobileSessionWithDb(db, claimsB);

    const refreshedA = await refreshMobileSessionWithDb(db, issuedA.refreshToken);
    const refreshedB = await refreshMobileSessionWithDb(db, issuedB.refreshToken);

    const decodedA = await verifyMobileToken(refreshedA!.accessToken);
    const decodedB = await verifyMobileToken(refreshedB!.accessToken);

    expect(decodedA!.orgId).toBe(orgAId);
    expect(decodedA!.slug).toBe('alpha');
    expect(decodedB!.orgId).toBe(orgBId);
    expect(decodedB!.slug).toBe('beta');
  });
});
