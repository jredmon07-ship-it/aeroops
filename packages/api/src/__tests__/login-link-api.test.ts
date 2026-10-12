/**
 * login-link-api.test.ts — integration tests for login links
 * (createLoginLink / checkLoginLink / acceptLoginLink) against PGlite with the
 * full migration chain and RLS enforced (setTestAppRole).
 *
 * COVERAGE:
 *   L1 — invite happy path: addMember → link → accept → login works through
 *        the existing verifyLoginAndIssueClaims pipeline.
 *   L2 — single use: the same link is refused once used.
 *   L3 — reset path: replaces the password; older reset links die; the
 *        member's mobile refresh sessions are revoked.
 *   L4 — cross-org: org-A link on org-B slug, org-B link on org-A slug, and an
 *        org-A caller targeting an org-B user are all refused.
 *   L5 — privilege rule: manager → owner / manager / self refused; manager →
 *        renter allowed; owner → manager and owner → self allowed.
 *   L6 — capability: every role without people:manage → ForbiddenError;
 *        no session → UnauthenticatedError.
 *   L7 — deactivated member: no link; a link made before deactivation dies.
 *   L8 — audit rows for create + accept (token never stored).
 *   L9 — password policy (signup's) enforced; a weak password doesn't burn
 *        the link. Garbage/tampered tokens → generic invalid_link.
 *   L10 — public demo orgs refuse link creation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  loadMigrationSql,
  seedAuthCredential,
} from '@aeroops/db';
import { appUser, membership, authCredential, auditLog, mobileSession } from '@aeroops/db';
import { and, eq } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';
import { can, MEMBERSHIP_ROLES } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';

import {
  createLoginLinkWithDb,
  checkLoginLinkWithDb,
  acceptLoginLinkWithDb,
  loginLinkPermission,
} from '../people/login-link.js';
import { addMemberWithDb } from '../people/add-member.js';
import { setMemberStatusWithDb } from '../people/set-member-status.js';
import { verifyLoginAndIssueClaimsWithDb } from '../auth/verify-login.js';
import { issueMobileSessionWithDb } from '../auth/mobile-session.js';
import { hashPassword } from '../auth/hash.js';
import { ForbiddenError } from '../auth/require-capability.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ValidationError } from '../scheduling/internal.js';
import type { AppSession } from '../auth/types.js';

const MIGRATION_SQL = loadMigrationSql('0050');
const TEST_SECRET = 'login-link-api-test-secret-32bytes!';

let db: PgliteTestClient;
let pglite: PGlite;
let orgAId: string;
let orgBId: string;
let ownerAId: string;
let ownerBId: string;
let originalSecret: string | undefined;

function session(orgId: string, userId: string, role: MembershipRole, slug = 'alpha'): AppSession {
  return { userId, orgId, slug, role, user: { email: `${role}@test.example` } };
}

let seq = 0;
/** Seed a member directly (any role/status) in the given org. */
async function seedMember(orgId: string, role: MembershipRole, status = 'active'): Promise<{ id: string; email: string }> {
  seq++;
  const email = `m${seq}-${role}@login-link.example`;
  const id = await withOrgContext(db, orgId, async (tx) => {
    const [u] = await tx.insert(appUser).values({ orgId, email, fullName: `Member ${seq}`, status }).returning();
    await tx.insert(membership).values({ orgId, userId: u!.id, role });
    return u!.id;
  });
  return { id, email };
}

/** Token = the last path segment of the link. */
function tokenOf(path: string): string {
  return path.split('/').pop()!;
}

async function createLink(sess: AppSession, userId: string) {
  const r = await createLoginLinkWithDb(db, sess, { userId });
  if (!r.ok) throw new Error(`createLoginLink refused: ${r.reason}`);
  return r;
}

async function credentialCount(orgId: string, userId: string): Promise<number> {
  return withOrgContext(db, orgId, async (tx) => {
    const rows = await tx
      .select({ id: authCredential.id })
      .from(authCredential)
      .where(eq(authCredential.userId, userId));
    return rows.length;
  });
}

beforeAll(async () => {
  originalSecret = process.env['AUTH_SECRET'];
  process.env['AUTH_SECRET'] = TEST_SECRET;

  ({ db, pglite } = await createTestClient());
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  orgAId = seed.orgAId;
  orgBId = seed.orgBId;
  ownerAId = seed.userAId;
  ownerBId = seed.userBId;
  await setTestAppRole({ pglite });
}, 60_000);

afterAll(() => {
  if (originalSecret === undefined) delete process.env['AUTH_SECRET'];
  else process.env['AUTH_SECRET'] = originalSecret;
});

const ownerA = () => session(orgAId, ownerAId, 'owner', 'alpha');
const ownerB = () => session(orgBId, ownerBId, 'owner', 'beta');

// ═══════════════════════════════════════════════════════════════════════════════

describe('L1 — invite happy path', () => {
  it('a roster member added by hand gets a login through a link', async () => {
    const added = await addMemberWithDb(db, ownerA(), {
      email: 'new.renter@login-link.example',
      fullName: 'New Renter',
      role: 'renter',
    });
    if (!added.ok) throw new Error('addMember failed');
    const userId = added.member.userId;
    expect(added.member.hasLogin).toBe(false);
    expect(await credentialCount(orgAId, userId)).toBe(0);

    const link = await createLink(ownerA(), userId);
    expect(link.mode).toBe('invite');
    expect(link.path).toMatch(/^\/o\/alpha\/login-link\/[A-Za-z0-9_.-]+$/);
    const days = (new Date(link.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);

    const token = tokenOf(link.path);
    const check = await checkLoginLinkWithDb(db, { slug: 'alpha', token });
    expect(check).toEqual({
      ok: true,
      email: 'new.renter@login-link.example',
      displayName: 'New Renter',
      orgName: 'Alpha Flight School',
      mode: 'invite',
    });

    const accepted = await acceptLoginLinkWithDb(db, { slug: 'alpha', token, password: 'first-password-123' });
    expect(accepted).toEqual({ ok: true, email: 'new.renter@login-link.example' });
    expect(await credentialCount(orgAId, userId)).toBe(1);

    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: 'alpha',
      email: 'new.renter@login-link.example',
      password: 'first-password-123',
    });
    expect(claims).toMatchObject({ userId, orgId: orgAId, slug: 'alpha', role: 'renter' });
  });
});

describe('L2 — single use', () => {
  it('the same link is refused (check + accept) after it was used', async () => {
    const m = await seedMember(orgAId, 'student');
    const token = tokenOf((await createLink(ownerA(), m.id)).path);

    expect((await acceptLoginLinkWithDb(db, { slug: 'alpha', token, password: 'student-pass-1' })).ok).toBe(true);
    expect(await checkLoginLinkWithDb(db, { slug: 'alpha', token })).toEqual({ ok: false, reason: 'invalid_link' });
    expect(await acceptLoginLinkWithDb(db, { slug: 'alpha', token, password: 'attacker-pass-2' })).toEqual({
      ok: false,
      reason: 'invalid_link',
    });

    // The first password still works; the replay's didn't take.
    expect(await verifyLoginAndIssueClaimsWithDb(db, { slug: 'alpha', email: m.email, password: 'student-pass-1' })).not.toBeNull();
    expect(await verifyLoginAndIssueClaimsWithDb(db, { slug: 'alpha', email: m.email, password: 'attacker-pass-2' })).toBeNull();
  });

  it('two invite links made before first use: using one kills the other', async () => {
    const m = await seedMember(orgAId, 'renter');
    const t1 = tokenOf((await createLink(ownerA(), m.id)).path);
    const t2 = tokenOf((await createLink(ownerA(), m.id)).path);
    expect((await acceptLoginLinkWithDb(db, { slug: 'alpha', token: t2, password: 'renter-pass-1' })).ok).toBe(true);
    expect((await acceptLoginLinkWithDb(db, { slug: 'alpha', token: t1, password: 'renter-pass-2' })).ok).toBe(false);
  });
});

describe('L3 — reset path', () => {
  it('replaces an existing password; older reset links die; mobile sessions are revoked', async () => {
    const m = await seedMember(orgAId, 'cfi');
    await seedAuthCredential(db, orgAId, m.id, await hashPassword('old-password-99'));

    // A signed-in phone.
    const claims = await verifyLoginAndIssueClaimsWithDb(db, { slug: 'alpha', email: m.email, password: 'old-password-99' });
    expect(claims).not.toBeNull();
    await issueMobileSessionWithDb(db, claims!);

    const older = await createLink(ownerA(), m.id);
    const newer = await createLink(ownerA(), m.id);
    expect(newer.mode).toBe('reset');
    expect((await checkLoginLinkWithDb(db, { slug: 'alpha', token: tokenOf(newer.path) })).ok).toBe(true);

    const res = await acceptLoginLinkWithDb(db, { slug: 'alpha', token: tokenOf(newer.path), password: 'new-password-99' });
    expect(res.ok).toBe(true);
    expect(await credentialCount(orgAId, m.id)).toBe(1); // replaced, not duplicated

    expect(await verifyLoginAndIssueClaimsWithDb(db, { slug: 'alpha', email: m.email, password: 'old-password-99' })).toBeNull();
    expect(await verifyLoginAndIssueClaimsWithDb(db, { slug: 'alpha', email: m.email, password: 'new-password-99' })).not.toBeNull();

    // The older reset link (same old credential fingerprint) is now dead too.
    expect(await acceptLoginLinkWithDb(db, { slug: 'alpha', token: tokenOf(older.path), password: 'sneaky-password-1' })).toEqual({
      ok: false,
      reason: 'invalid_link',
    });

    const sessions = await withOrgContext(db, orgAId, (tx) =>
      tx.select({ revokedAt: mobileSession.revokedAt }).from(mobileSession).where(eq(mobileSession.userId, m.id)),
    );
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.revokedAt).not.toBeNull();
  });
});

describe('L4 — cross-org', () => {
  it('an org-A link presented on the org-B slug is invalid (and does nothing)', async () => {
    const m = await seedMember(orgAId, 'renter');
    const token = tokenOf((await createLink(ownerA(), m.id)).path);
    expect(await checkLoginLinkWithDb(db, { slug: 'beta', token })).toEqual({ ok: false, reason: 'invalid_link' });
    expect(await acceptLoginLinkWithDb(db, { slug: 'beta', token, password: 'cross-org-pass-1' })).toEqual({
      ok: false,
      reason: 'invalid_link',
    });
    expect(await credentialCount(orgAId, m.id)).toBe(0);
    // Still usable on its own org.
    expect((await checkLoginLinkWithDb(db, { slug: 'alpha', token })).ok).toBe(true);
  });

  it('an org-B link (for an org-B user) presented on the org-A slug is invalid', async () => {
    const mB = await seedMember(orgBId, 'renter');
    const link = await createLink(ownerB(), mB.id);
    expect(link.path.startsWith('/o/beta/login-link/')).toBe(true);
    const token = tokenOf(link.path);
    expect(await acceptLoginLinkWithDb(db, { slug: 'alpha', token, password: 'cross-org-pass-2' })).toEqual({
      ok: false,
      reason: 'invalid_link',
    });
    expect(await credentialCount(orgBId, mB.id)).toBe(0);
  });

  it('an org-A owner cannot create a link for an org-B user (not_found)', async () => {
    const mB = await seedMember(orgBId, 'renter');
    expect(await createLoginLinkWithDb(db, ownerA(), { userId: mB.id })).toEqual({ ok: false, reason: 'not_found' });
    expect(await createLoginLinkWithDb(db, ownerA(), { userId: ownerBId })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('unknown slug → invalid', async () => {
    const m = await seedMember(orgAId, 'renter');
    const token = tokenOf((await createLink(ownerA(), m.id)).path);
    expect(await checkLoginLinkWithDb(db, { slug: 'no-such-org', token })).toEqual({ ok: false, reason: 'invalid_link' });
  });
});

describe('L5 — privilege rule', () => {
  it('manager cannot create a link for an owner (no account takeover)', async () => {
    const mgr = await seedMember(orgAId, 'manager');
    const mgrSess = session(orgAId, mgr.id, 'manager');
    expect(await createLoginLinkWithDb(db, mgrSess, { userId: ownerAId })).toEqual({ ok: false, reason: 'target_outranks' });
  });

  it('manager cannot create a link for another manager, nor for themselves', async () => {
    const mgr = await seedMember(orgAId, 'manager');
    const peer = await seedMember(orgAId, 'manager');
    const mgrSess = session(orgAId, mgr.id, 'manager');
    expect(await createLoginLinkWithDb(db, mgrSess, { userId: peer.id })).toEqual({ ok: false, reason: 'target_outranks' });
    expect(await createLoginLinkWithDb(db, mgrSess, { userId: mgr.id })).toEqual({ ok: false, reason: 'self_not_allowed' });
  });

  it('manager can create a link for a non-managing role', async () => {
    const mgr = await seedMember(orgAId, 'manager');
    const r = await seedMember(orgAId, 'dispatcher');
    const res = await createLoginLinkWithDb(db, session(orgAId, mgr.id, 'manager'), { userId: r.id });
    expect(res.ok).toBe(true);
  });

  it('owner can create a link for a manager and for themselves', async () => {
    const mgr = await seedMember(orgAId, 'manager');
    expect((await createLoginLinkWithDb(db, ownerA(), { userId: mgr.id })).ok).toBe(true);
    expect((await createLoginLinkWithDb(db, ownerA(), { userId: ownerAId })).ok).toBe(true);
  });

  it('loginLinkPermission: exhaustive over role pairs', () => {
    for (const actorRole of MEMBERSHIP_ROLES) {
      if (!can(actorRole, 'people:manage')) continue;
      for (const targetRole of MEMBERSHIP_ROLES) {
        const other = loginLinkPermission({ userId: 'a', role: actorRole }, { userId: 'b', role: targetRole });
        const expected = actorRole === 'owner' || !can(targetRole, 'people:manage');
        expect(other.ok, `${actorRole} → ${targetRole}`).toBe(expected);
      }
      const self = loginLinkPermission({ userId: 'a', role: actorRole }, { userId: 'a', role: actorRole });
      expect(self.ok, `${actorRole} → self`).toBe(actorRole === 'owner');
    }
  });
});

describe('L6 — capability', () => {
  it('every role without people:manage is Forbidden; no session is Unauthenticated', async () => {
    const target = await seedMember(orgAId, 'renter');
    const denied = MEMBERSHIP_ROLES.filter((r) => !can(r, 'people:manage'));
    expect(denied.length).toBeGreaterThan(0);
    for (const role of denied) {
      const actor = await seedMember(orgAId, role);
      await expect(
        createLoginLinkWithDb(db, session(orgAId, actor.id, role), { userId: target.id }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(createLoginLinkWithDb(db, null, { userId: target.id })).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('a non-UUID userId is a ValidationError', async () => {
    await expect(createLoginLinkWithDb(db, ownerA(), { userId: 'nope' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('L7 — deactivated member', () => {
  it('cannot get a link', async () => {
    const m = await seedMember(orgAId, 'renter', 'inactive');
    expect(await createLoginLinkWithDb(db, ownerA(), { userId: m.id })).toEqual({ ok: false, reason: 'inactive' });
  });

  it('a link created before deactivation stops working', async () => {
    const m = await seedMember(orgAId, 'renter');
    const token = tokenOf((await createLink(ownerA(), m.id)).path);
    const deact = await setMemberStatusWithDb(db, ownerA(), { userId: m.id, status: 'inactive' });
    expect(deact.ok).toBe(true);
    expect(await acceptLoginLinkWithDb(db, { slug: 'alpha', token, password: 'inactive-pass-1' })).toEqual({
      ok: false,
      reason: 'invalid_link',
    });
    expect(await credentialCount(orgAId, m.id)).toBe(0);
  });
});

describe('L8 — audit', () => {
  it('writes member.login_link_created and member.login_link_accepted, never the token', async () => {
    const m = await seedMember(orgAId, 'mechanic');
    const link = await createLink(ownerA(), m.id);
    const token = tokenOf(link.path);
    expect((await acceptLoginLinkWithDb(db, { slug: 'alpha', token, password: 'mechanic-pass-1' })).ok).toBe(true);

    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'app_user'), eq(auditLog.entityId, m.id))),
    );
    const created = rows.find((r) => r.action === 'member.login_link_created');
    const accepted = rows.find((r) => r.action === 'member.login_link_accepted');
    expect(created).toBeDefined();
    expect(created!.actorUserId).toBe(ownerAId);
    expect(created!.metadata).toMatchObject({ mode: 'invite', expiresAt: link.expiresAt });
    expect(accepted).toBeDefined();
    expect(accepted!.actorUserId).toBe(m.id);
    expect(accepted!.metadata).toMatchObject({ mode: 'invite', mobileSessionsRevoked: 0 });
    for (const r of rows) {
      expect(JSON.stringify(r.metadata)).not.toContain(token);
      expect(JSON.stringify(r.metadata)).not.toContain('argon2');
    }
  });
});

describe('L9 — password policy + bad tokens', () => {
  it('a too-short password is a ValidationError and does not burn the link', async () => {
    const m = await seedMember(orgAId, 'renter');
    const token = tokenOf((await createLink(ownerA(), m.id)).path);
    await expect(acceptLoginLinkWithDb(db, { slug: 'alpha', token, password: 'short' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      acceptLoginLinkWithDb(db, { slug: 'alpha', token, password: 'x'.repeat(201) }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await credentialCount(orgAId, m.id)).toBe(0);
    expect((await acceptLoginLinkWithDb(db, { slug: 'alpha', token, password: 'long-enough-1' })).ok).toBe(true);
  });

  it('garbage / tampered / empty tokens → the one generic invalid_link', async () => {
    const m = await seedMember(orgAId, 'renter');
    const token = tokenOf((await createLink(ownerA(), m.id)).path);
    const tampered = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    for (const t of ['garbage', tampered, '']) {
      expect(await checkLoginLinkWithDb(db, { slug: 'alpha', token: t })).toEqual({ ok: false, reason: 'invalid_link' });
      expect(await acceptLoginLinkWithDb(db, { slug: 'alpha', token: t, password: 'long-enough-2' })).toEqual({
        ok: false,
        reason: 'invalid_link',
      });
    }
  });
});

describe('L10 — public demo orgs', () => {
  it('refuses to create links while the demo reset is live for the slug', async () => {
    const prev = process.env['AEROOPS_DEMO_RESET_ENABLED'];
    process.env['AEROOPS_DEMO_RESET_ENABLED'] = 'true';
    try {
      const m = await seedMember(orgAId, 'renter');
      expect(await createLoginLinkWithDb(db, ownerA(), { userId: m.id })).toEqual({ ok: false, reason: 'demo_org' });
    } finally {
      if (prev === undefined) delete process.env['AEROOPS_DEMO_RESET_ENABLED'];
      else process.env['AEROOPS_DEMO_RESET_ENABLED'] = prev;
    }
  });
});
